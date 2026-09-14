# EcomFlow

**Plateforme SaaS multi-tenant d'opérations e-commerce pour le marché algérien.**

EcomFlow prend en charge la chaîne complète d'une commande en paiement à la
livraison : import depuis Google Sheets, confirmation téléphonique, préparation,
expédition, suivi transporteur, retours, stock et rentabilité réelle — avec une
isolation stricte entre boutiques.

---

## Table des matières

1. [Le problème traité](#1-le-problème-traité)
2. [Architecture](#2-architecture)
3. [Stack technique](#3-stack-technique)
4. [Prérequis](#4-prérequis)
5. [Installation](#5-installation)
6. [Variables d'environnement](#6-variables-denvironnement)
7. [Lancer en local](#7-lancer-en-local)
8. [Base de données et migrations](#8-base-de-données-et-migrations)
9. [Langues — français et arabe](#9-langues--français-et-arabe)
10. [Tests](#10-tests)
11. [Docker](#11-docker)
12. [Intégrations externes — état réel](#12-intégrations-externes--état-réel)
13. [Sécurité](#13-sécurité)
14. [Déploiement](#14-déploiement)
15. [Sauvegarde et restauration](#15-sauvegarde-et-restauration)
16. [Dépannage](#16-dépannage)
17. [Documentation du projet](#17-documentation-du-projet)

---

## 1. Le problème traité

Un commerçant algérien qui vend en ligne travaille en **paiement à la livraison**.
Cela change tout : une commande confirmée n'est pas une vente, et une commande
expédiée peut revenir. La conséquence pratique est qu'un commerçant gère ses
commandes dans un tableur, appelle chaque client, note les statuts à la main,
recopie les adresses chez le transporteur, et découvre ses pertes trop tard.

EcomFlow répond à cinq besoins précis :

| Besoin | Réponse |
|---|---|
| Les commandes arrivent dans un Google Sheet | Import automatique, avec aperçu avant le premier import et journal des lignes rejetées |
| Chaque commande demande un appel | Centre de confirmation avec file priorisée, raccourcis clavier et historique client |
| Le stock se vend deux fois | Réservation atomique à la confirmation, avec distinction physique / réservé / disponible |
| Le suivi transporteur est éclaté | Statut brut du transporteur **et** statut normalisé, dans un seul écran |
| La marge réelle est inconnue | Chiffre d'affaires reconnu à la livraison seulement, perte réelle distinguée du manque à gagner |

---

## 2. Architecture

### Vue d'ensemble

```
                    ┌──────────────────────────────┐
   Navigateur ─────▶│  apps/web — Next.js 15       │
                    │  App Router, TanStack Query  │
                    └──────────────┬───────────────┘
                                   │ REST /api/v1 (JWT)
                    ┌──────────────▼───────────────┐
                    │  apps/api — NestJS 11        │
                    │  ┌────────────────────────┐  │
                    │  │ Garde Throttler        │  │
                    │  │ Garde JwtAuth          │  │
                    │  │ Garde Permissions      │  │
                    │  │ Garde Subscription     │  │
                    │  └────────────────────────┘  │
                    │  Modules métier              │
                    │  Contexte de requête (ALS)   │
                    └───┬───────────────┬──────────┘
                        │               │
             ┌──────────▼──────┐  ┌─────▼────────┐
             │  PostgreSQL 16  │  │  Redis 7     │
             │  Prisma 6       │  │  BullMQ      │
             └─────────────────┘  └──────────────┘
                        ▲
                        │  packages/shared — règles métier pures,
                        │  partagées API ↔ front (sans dépendance)
```

### Isolation multi-tenant — trois niveaux indépendants

C'est la propriété la plus critique du produit : une boutique ne doit **jamais**
voir les données d'une autre. Trois mécanismes se recouvrent, de sorte qu'une
défaillance de l'un ne suffit pas à provoquer une fuite.

| Niveau | Mécanisme | Ce qu'il attrape |
|---|---|---|
| 1. Requête | `AsyncLocalStorage` porte le `tenantId`, issu du jeton vérifié — jamais du corps de la requête | Un client qui tenterait d'imposer son tenant |
| 2. Accès aux données | Extension Prisma **fail-closed** : toute requête sans tenant actif est **refusée**, tout `tenantId` divergent lève une erreur journalisée | Un service métier qui aurait « oublié » de filtrer |
| 3. Base de données | Clés étrangères **composites** `(tenant_id, id)` | Une jointure qui relierait deux boutiques, même via du SQL brut |

Sortir du périmètre d'un tenant est possible, mais exige une **raison explicite
et typée** (`runUnscoped('AUTHENTICATION')`, `'PLATFORM_ADMIN'`,
`'BACKGROUND_JOB'`…). Un `null` silencieux ne suffit jamais.

### Principes structurants

- **L'argent est un entier de centimes.** Aucun flottant nulle part ; les champs
  portent le suffixe `_centimes`. `0,1 + 0,2 ≠ 0,3` n'a pas sa place dans une
  facturation.
- **Le chiffre d'affaires n'est reconnu qu'à la livraison.** En paiement à la
  livraison, rien n'est encaissé avant la remise du colis.
- **Le workflow de commande est une table de transitions**, pas une suite de
  `if`. Chaque transition déclare ses acteurs, sa permission, ses gardes et si
  un motif est obligatoire.
- **Les événements métier passent par un outbox transactionnel**
  (`FOR UPDATE SKIP LOCKED`) : un événement ne peut pas être publié sans que la
  transaction métier ait été validée.
- **n8n n'est jamais source de vérité.** Ni pour les commandes, ni pour les
  paiements, abonnements, stock ou utilisateurs. Il ne sert qu'à l'automatisation
  externe, en aval de l'API.
- **La langue de l'agent et celle du client sont deux choses différentes.** En
  Algérie, un agent travaille couramment en français tout en écrivant à ses
  clients en arabe. Les confondre reviendrait à imposer la langue de l'employé
  au client, sur un message dont la langue a un effet direct sur le taux de
  confirmation (§9).

### Organisation du dépôt

```
EcomFlow/
├── packages/shared/       Règles métier pures, sans dépendance
│   └── src/               statuts de commande, fiabilité, rentabilité,
│                          wilayas, téléphone, monnaie, doublons, permissions,
│                          langues, modèles de messages WhatsApp (FR + AR)
├── apps/api/              API NestJS
│   ├── prisma/            schéma (51 modèles), migrations, seed
│   ├── src/
│   │   ├── common/        décorateurs, filtres, DTO transverses
│   │   ├── config/        validation stricte de l'environnement
│   │   ├── infra/         Prisma, contexte de requête, crypto, horloge
│   │   └── modules/       auth, orders, confirmation, catalog, inventory,
│   │                      shipments, returns, customers, integrations,
│   │                      billing, users, tenants, dashboard, webhooks, jobs
│   ├── scripts/           export de la spécification OpenAPI
│   └── test/              tests d'intégration et de bout en bout
├── apps/web/              Interface Next.js
│   ├── src/app/           22 écrans (voir §7)
│   └── src/i18n/          catalogues fr/ar, fournisseur de langue, RTL
├── infra/                 Docker, initialisation PostgreSQL
├── docs/specs/            Cahiers des charges V1, V2 et Addendum
└── DECISIONS.md           Journal des décisions structurantes
```

---

## 3. Stack technique

| Domaine | Choix | Version |
|---|---|---|
| Frontend | Next.js (App Router), React, TypeScript | 15.1 / 19 / 5.9 |
| État serveur | TanStack Query | 5.62 |
| Styles | Tailwind CSS (propriétés logiques, RTL) | 3.4 |
| Internationalisation | next-intl (ICU, sans routage) | 3.26 |
| Backend | NestJS, REST, OpenAPI/Swagger | 11.2 |
| ORM | Prisma | 6.19 |
| Base de données | PostgreSQL | 16 |
| Files d'attente | Redis + BullMQ | 7 / 5.81 |
| Mots de passe | Argon2id (`@node-rs/argon2`) | 2.2 |
| Tests | Jest, Supertest, `embedded-postgres` | 29.7 |
| Qualité | ESLint (config « flat », règles typées) + Prettier | 9 / 3.4 |
| Monorepo | npm workspaces | npm ≥ 10 |

---

## 4. Prérequis

| Outil | Version | Obligatoire |
|---|---|---|
| Node.js | ≥ 20.11 (voir `.nvmrc`) | oui |
| npm | ≥ 10 | oui |
| PostgreSQL | 16 | oui (ou via Docker) |
| Redis | 7 | recommandé — **requis en production** |
| Docker + Compose | récent | facultatif en développement |

> **Sans Docker ?** C'est possible. Les tests d'intégration et de bout en bout
> lancent une instance PostgreSQL réelle et éphémère via `embedded-postgres` :
> ils ne dépendent d'aucun conteneur. Pour l'exécution de l'application, il faut
> en revanche un PostgreSQL accessible.

---

## 5. Installation

```bash
git clone <url-du-depot> EcomFlow
cd EcomFlow
npm install
```

Puis créez votre fichier d'environnement à partir du modèle :

```bash
cp .env.example .env
```

Générez les trois secrets obligatoires et reportez-les dans `.env` :

```bash
node -e "const c=require('crypto');console.log('JWT_ACCESS_SECRET='+c.randomBytes(32).toString('hex'));console.log('JWT_REFRESH_SECRET='+c.randomBytes(32).toString('hex'));console.log('ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'));console.log('HASH_PEPPER='+c.randomBytes(32).toString('hex'));"
```

Générez le client Prisma et compilez le paquet partagé :

```bash
npm run prisma:generate
npm run build:shared
```

> **`.env` n'est jamais versionné.** Le fichier est ignoré par Git, et la CI
> vérifie explicitement qu'aucun fichier d'environnement n'a été ajouté de force.

---

## 6. Variables d'environnement

L'application **refuse de démarrer** si une variable requise manque ou est
malformée, et affiche d'un coup **toutes** les variables fautives. Un secret
absent doit se manifester par un échec immédiat, jamais par un service dégradé
en silence.

### Obligatoires

| Variable | Rôle | Contrainte |
|---|---|---|
| `DATABASE_URL` | Connexion PostgreSQL | URL valide |
| `JWT_ACCESS_SECRET` | Signature des jetons d'accès | ≥ 32 caractères |
| `JWT_REFRESH_SECRET` | Signature des jetons de rafraîchissement | ≥ 32 caractères, **différent** du précédent en production |
| `ENCRYPTION_KEY` | Chiffrement AES-256-GCM des secrets d'intégration | 32 octets en base64 |
| `HASH_PEPPER` | Poivre HMAC des jetons et codes OTP | ≥ 32 caractères |

### Principales variables optionnelles

| Variable | Défaut | Effet |
|---|---|---|
| `PORT` | `3001` | Port d'écoute de l'API |
| `APP_URL` / `API_URL` | `localhost` | Utilisées dans les liens e-mail et les callbacks OAuth |
| `REDIS_URL` | — | Files d'attente. **Requis en production** |
| `SWAGGER_ENABLED` | `true` | **Doit valoir `false` en production** |
| `THROTTLE_ENABLED` | `true` | Limitation de débit |
| `MAIL_DRIVER` | `console` | `console` \| `smtp`. **`smtp` obligatoire en production** |
| `OTP_DRIVER` | `console` | `console` \| `sms` |
| `GOOGLE_CLIENT_ID/SECRET` | vide | Sans eux, aucune boutique ne peut connecter de feuille |
| `WHATSAPP_ENABLED` | `false` | Active le filtre WhatsApp (exige 4 variables de plus) |
| `CHARGILY_ENABLED` | `false` | Active le paiement par carte (exige la clé et le secret de webhook) |
| `NEXT_PUBLIC_API_URL` | `localhost:3001/api/v1` | **Inlinée dans le bundle navigateur** — jamais de secret ici |

### Garde-fous spécifiques à la production

Lorsque `NODE_ENV=production`, le démarrage est refusé si :

- `SWAGGER_ENABLED` vaut `true` — publier toute la surface de l'API facilite la reconnaissance ;
- `API_URL` commence par `http://` — HTTPS est obligatoire (V2 §31) ;
- `REDIS_URL` est absent — les files d'attente ne sont pas optionnelles ;
- les deux secrets JWT sont identiques — un jeton de rafraîchissement pourrait alors passer pour un jeton d'accès ;
- `MAIL_DRIVER` n'est pas `smtp` — les e-mails partiraient dans la console.

La liste complète, commentée, est dans [`.env.example`](.env.example).

---

## 7. Lancer en local

### Démarrer les dépendances

```bash
npm run docker:up
```

Cela lance PostgreSQL (5432), Redis (6379) et MailHog (interface web sur
[localhost:8025](http://localhost:8025), qui capture tous les e-mails sortants).

### Préparer la base

```bash
npm run prisma:migrate
npm run seed
```

Le seed crée les référentiels de la plateforme — catalogue des permissions,
rôle système d'administration, transporteurs, plans tarifaires — et, si
`SUPER_ADMIN_EMAIL` et `SUPER_ADMIN_PASSWORD` sont renseignés, le compte
d'administration.

Les 58 wilayas ne sont pas en base : elles vivent dans `packages/shared`, en
code. Elles ne changent jamais au fil de l'exploitation, et la reconnaissance
d'un nom de wilaya écrit à la main dans un tableur (« Alger », « alger »,
« الجزائر », « 16 ») doit fonctionner à l'identique côté API et côté navigateur.

### Jeu de données de développement

À ce stade la base est **fonctionnelle mais vide** : aucune commande, aucun
client, aucun produit. Le tableau de bord affiche des zéros et la file de
confirmation est vide, ce qui rend le produit difficile à découvrir.

```bash
npm run seed:demo
```

Cette commande ajoute une boutique de démonstration complète :

| Contenu | Détail |
|---|---|
| Boutique | `boutique-demo`, active, essai en cours |
| Utilisateurs | 3 comptes couvrant **OWNER**, **CONFIRMATION_AGENT** et **PREPARER** |
| Clients | 10 clients répartis sur 10 wilayas, avec des langues mêlées (français, arabe, et sans préférence) |
| Catalogue | 3 produits, dont un à plusieurs déclinaisons, tous avec un prix d'achat |
| Commandes | 19 commandes couvrant **les 15 statuts du workflow**, y compris `RETURNED`, `REFUSED` et `CANCELLED` |

**Comptes de démonstration** — mot de passe commun `DemoEcomFlow2026` :

| Adresse | Rôle |
|---|---|
| `demo@ecomflow.local` | Propriétaire |
| `agent@ecomflow.local` | Agent de confirmation |
| `preparateur@ecomflow.local` | Préparateur |

> ### ⚠️ Outil de développement exclusivement
>
> Ces comptes ont un **mot de passe publié dans ce dépôt**. Les créer sur une
> installation de production ouvrirait un accès connu de tous à une boutique
> réelle.
>
> `npm run seed:demo` **refuse de s'exécuter** lorsque `NODE_ENV=production`, et
> aucune variable d'échappement n'existe : une démonstration se fait sur un
> environnement dédié.
>
> Le garde-fou vise la démonstration, **pas** l'amorçage. `npm run seed` — qui
> installe permissions, rôles, transporteurs et plans — reste parfaitement
> utilisable en production.

Le jeu est **idempotent** : le rejouer ne duplique rien et n'écrase pas les
modifications faites pendant une session de découverte. Un test d'intégration
l'exécute contre un vrai PostgreSQL et vérifie la couverture des statuts, la
cohérence des compteurs client et le refus en production.

### Lancer les deux applications

```bash
npm run dev:api    # terminal 1 — http://localhost:3001
npm run dev:web    # terminal 2 — http://localhost:3000
```

| Adresse | Contenu |
|---|---|
| http://localhost:3000 | Interface |
| http://localhost:3001/api/v1 | API |
| http://localhost:3001/api/docs | Swagger UI |
| http://localhost:3001/health/live | Sonde de vivacité (hors préfixe de version) |
| http://localhost:3001/health/ready | Sonde de disponibilité (vérifie la base) |

### Écrans disponibles

| Route | Écran |
|---|---|
| `/` | Tableau de bord — indicateurs, alertes actionnables, résultat de la période |
| `/confirmation` | Centre d'appel — file, fiche client, raccourcis clavier |
| `/commandes`, `/commandes/[id]`, `/commandes/nouvelle` | Liste, fiche complète, saisie manuelle |
| `/preparation` | Trois colonnes de picking pour le dépôt |
| `/expeditions` | Colis, statut brut + normalisé, colis silencieux signalés |
| `/retours` | Cycle complet, inspection ligne par ligne |
| `/produits`, `/stock` | Catalogue et stock (physique / réservé / disponible) |
| `/clients`, `/clients/[id]` | Fiabilité expliquée facteur par facteur |
| `/rentabilite` | Perte réelle vs manque à gagner, ventilation par axe |
| `/integrations` | Assistant Google Sheets, journal d'import, historique |
| `/abonnement` | Formules, paiement carte ou manuel, historique |
| `/utilisateurs` | Membres, rôles, permissions décrites en langage métier |
| `/parametres` | Tous les seuils du produit |
| `/onboarding` | Mise en route vérifiée contre la base |
| `/connexion`, `/inscription`, `/mot-de-passe-oublie`, `/reinitialiser-mot-de-passe` | Authentification — avec sélecteur de langue avant connexion |

Tous les écrans existent en français et en arabe, en RTL réel pour l'arabe. Le
sélecteur de langue est dans l'en-tête ; voir §9.

---

## 8. Base de données et migrations

Le schéma compte **51 modèles** et quatre migrations :

| Migration | Contenu |
|---|---|
| `20260828235900_extensions` | `pg_trgm`, `unaccent`, `pgcrypto` |
| `20260829000000_init` | Tables, index et énumérations |
| `20260829000100_integrity_constraints` | Clés étrangères composites, contraintes `CHECK`, index uniques partiels |
| `20260830120000_i18n_locales` | Langue par défaut de la boutique, langue des messages clients, langue du client — avec contraintes `CHECK` limitant les valeurs à `fr`/`ar` |

La troisième migration est **écrite à la main**, car Prisma ne sait pas exprimer
ce qu'elle contient et qui protège l'intégrité des données :

- des clés étrangères **composites** `(tenant_id, id)` — le moteur refuse
  physiquement de relier deux boutiques ;
- des contraintes `CHECK` — stock jamais négatif, quantités positives, wilaya
  entre 1 et 58, score de fiabilité entre 0 et 100, cohérence des dates
  d'abonnement ;
- des index **uniques partiels** — un seul retour ouvert par commande, un seul
  colis actif par commande, un seul compte transporteur par défaut.

### Commandes

```bash
npm run prisma:migrate       # créer et appliquer une migration (développement)
npm run prisma:deploy        # appliquer les migrations existantes (production)
npm run prisma:generate      # régénérer le client après modification du schéma
npm run prisma:studio        # explorateur de données
npm run seed                 # référentiels + compte d'administration
npm run seed:demo            # + boutique de démonstration (développement seulement)
```

---

## 9. Langues — français et arabe

L'interface existe en **français** (par défaut) et en **arabe**, seconde langue
complète et non partielle. L'arabe s'affiche en **RTL réel** : ce n'est pas
seulement le texte qui change de langue, c'est toute la mise en page qui se
retourne.

> **L'anglais n'est pas une langue de l'interface, et ne l'a jamais été.**
> La page de garde de la *UI/UX Design Suite v1.0* porte la mention
> « Interface language: English ». Elle décrit **la langue dans laquelle les
> maquettes ont été dessinées**, pas celle du produit : les écrans anglais de
> ce document sont un support de conception. Le produit livré est
> français + arabe, et rien d'autre. Voir **D-043**.

### Chiffres : toujours 0-9, y compris en arabe

L'arabe algérien s'écrit avec les **chiffres latins**. Un commerçant algérien
lit ses factures, ses relevés bancaires et ses bordereaux transporteur en
`0-9` ; `٠١٢٣` lui serait illisible. Deux garde-fous le verrouillent, parce que
les deux moitiés du problème se cassent séparément :

| Garde-fou | Ce qu'il empêche |
|---|---|
| `packages/shared/src/locale.spec.ts` | Qu'on « corrige » l'étiquette `ar-DZ` en `ar-EG` — ou qu'on lui ajoute `-u-nu-arab`. Tout nombre **calculé** (montants, dates, quantités) basculerait en `٠١٢٣` sans qu'aucun type ne bronche |
| `apps/web/src/i18n/messages.spec.ts` | Qu'un chiffre `٧` soit **écrit en dur** dans le catalogue arabe. `Intl` ne voit pas ces chiffres-là : ils cohabitaient avec des `7` formatés sur le même écran |

### Ce qui est traduit

| Périmètre | État |
|---|---|
| Les 22 écrans de l'application | Intégralement — aucune chaîne codée en dur dans un composant |
| Libellés métier (statuts de commande, de colis, de retour, motifs, paliers de fiabilité) | Intégralement |
| Messages d'erreur affichés à l'utilisateur | Intégralement |
| Exemples de saisie (noms, adresses) | Traduits aussi — un exemple doit parler la langue de qui le lit |
| **Messages WhatsApp au client final** | Version arabe complète, boutons interactifs compris |

### Comment un utilisateur change de langue

Le sélecteur est visible **dans l'en-tête** de l'application, et aussi sur les
écrans de connexion et d'inscription — un arabophone doit pouvoir lire l'écran
de connexion dans sa langue avant même d'avoir un compte.

Le changement est **immédiat** : l'interface bascule dès le clic, la persistance
suit en arrière-plan. Si l'enregistrement échoue, l'application le dit sans
revenir en arrière : la langue affichée reste celle demandée, seule sa
propagation aux autres postes a échoué.

### Trois préférences distinctes

Elles ne se confondent jamais, et c'est délibéré. En Algérie, un agent travaille
couramment **en français** tout en écrivant à ses clients **en arabe**.

| Réglage | Où | Ce qu'il gouverne |
|---|---|---|
| `users.locale` | Sélecteur d'en-tête | La langue de **l'interface** d'un agent. Suit la personne d'un poste à l'autre |
| `tenant_settings.default_locale` | Paramètres → Langues | La langue proposée aux **nouveaux membres**. Ne modifie jamais celle de quelqu'un qui a déjà choisi |
| `customers.locale` | Fiche client | La langue dans laquelle un **client final** reçoit ses messages WhatsApp |

Une boutique peut en plus **imposer** une langue unique à toute sa clientèle
(Paramètres → Langues → « Langue des messages aux clients »). Laissé sur
« automatique » — le défaut — chaque client reçoit ses messages dans sa propre
langue, ce qui donne le meilleur taux de confirmation.

Résolution d'un message WhatsApp, dans cet ordre : langue imposée par la
boutique → langue connue du client → langue par défaut de la boutique.

### Architecture

```
apps/web/src/i18n/
├── messages/fr.json        catalogue français (source)
├── messages/ar.json        catalogue arabe (mêmes clés, vérifiées par test)
├── provider.tsx            NextIntlClientProvider, sans routage par URL
├── locale-cookie.ts        cache navigateur, pour éviter un flash LTR→RTL
├── session-locale-sync.tsx applique la préférence du compte à l'ouverture
└── messages.spec.ts        garde-fou de symétrie des deux catalogues

packages/shared/src/
├── locale.ts               langues, directions, résolution de priorité
└── whatsapp-templates.ts   messages au client final, FR + AR
```

**Bibliothèque : `next-intl`, en mode non routé.** Le choix tient à une raison
précise : **l'arabe possède six formes plurielles** (`zero`, `one`, `two`,
`few`, `many`, `other`) là où le français en a deux. Une implémentation maison
produirait du « 3 commande(s) » — acceptable en français, faux en arabe. Le
produit affiche des compteurs partout ; l'accord n'est pas cosmétique.

Le routage par segment d'URL (`/ar/commandes`) a été **écarté** : la préférence
appartient à l'utilisateur, pas à l'adresse. L'URL d'une commande doit rester
identique pour tout le monde, sinon la partager imposerait sa langue au
destinataire. Voir D-037 dans [`DECISIONS.md`](DECISIONS.md).

**RTL par propriétés logiques.** Le code n'utilise plus `ml-`/`mr-`/`text-left`
mais `ms-`/`me-`/`text-start` : ces classes suivent le sens de lecture
automatiquement. Un composant écrit ainsi est correct en arabe **sans effort
supplémentaire**, ce qui est la seule façon que le support RTL ne se dégrade pas
au fil des évolutions (D-039).

### Ajouter ou corriger une traduction

1. Modifier `apps/web/src/i18n/messages/fr.json` **et** `ar.json`.
2. `npm run test -w @ecomflow/web`.

Le test vérifie que les deux catalogues ont exactement les mêmes clés, que les
variables ICU concordent, que chaque message pluriel arabe couvre bien ses six
formes, et qu'aucun texte français ne subsiste côté arabe. **Une clé oubliée en
arabe fait échouer la CI** — sans cela, elle n'apparaîtrait qu'à l'écran d'un
utilisateur arabophone, sous forme de clé brute.

### Ajouter une troisième langue

1. `packages/shared/src/locale.ts` — ajouter le code, son libellé écrit dans sa
   propre écriture, sa direction et son étiquette BCP 47.
2. Une migration pour étendre les contraintes `CHECK` sur `users.locale`,
   `tenant_settings.default_locale` et `customers.locale`.
3. `apps/web/src/i18n/messages/<code>.json`, complet.
4. `packages/shared/src/whatsapp-templates.ts` — le pack de messages client.

Les contraintes en base sont volontaires : ajouter une langue est une décision
produit qui exige une migration explicite, jamais un effet de bord d'un
formulaire.

---

## 10. Tests

**388 tests**, répartis en quatre niveaux qui répondent à quatre questions
différentes.

| Suite | Volume | Ce qu'elle vérifie | Commande |
|---|---|---|---|
| Unitaires — règles partagées | 191 | Transitions de statut, score de fiabilité, rentabilité, wilayas, téléphone, monnaie, doublons, langues, modèles WhatsApp | `npm run test -w @ecomflow/shared` |
| Unitaires — API | 82 | Chiffrement, hachage, contexte de tenant, validation d'environnement | `npm run test:unit -w @ecomflow/api` |
| Unitaires — front | 8 | Symétrie des deux catalogues de traduction, pluriels arabes | `npm run test -w @ecomflow/web` |
| Intégration | 95 | Contraintes SQL, transactions, workflow, synchronisation Google Sheets, jeu de données | `npm run test:integration -w @ecomflow/api` |
| Bout en bout | 12 | Parcours réels via HTTP : inscription, confirmation, expédition, retour, isolation | `npm run test:e2e -w @ecomflow/api` |

```bash
npm test                     # unitaires (rapide)
npm run test:integration     # ~4 min — lance un vrai PostgreSQL
npm run test:e2e             # ~1 min
npm run typecheck            # vérification des types sur les trois paquets
npm run lint                 # ESLint typé, mêmes règles que la CI
```

### Ce que les tests d'intégration font réellement

Ils démarrent une **instance PostgreSQL 17 réelle et éphémère**
(`embedded-postgres`), appliquent les migrations, amorcent les référentiels puis
exécutent chaque suite contre cette base. Aucun conteneur n'est requis.

Ce choix est délibéré : une doublure de base ne vérifierait ni les contraintes
d'intégrité, ni les index uniques partiels, ni le comportement transactionnel,
ni l'isolation multi-tenant — c'est-à-dire précisément ce qui protège les
données d'un commerçant.

Entre deux tests, seules les tables métier sont vidées (`TRUNCATE … CASCADE`) ;
les référentiels sont conservés. Le temps est injecté via une horloge fixe, pour
que les tests de délais soient déterministes.

---

## 11. Docker

### Développement

```bash
npm run docker:up            # PostgreSQL + Redis + MailHog
npm run docker:logs
npm run docker:down
```

Pour conteneuriser aussi l'API et le front :

```bash
docker compose -f infra/docker/docker-compose.dev.yml --profile full up -d
```

### Images de production

Les deux Dockerfiles sont **multi-étages**, et attendent la **racine du
monorepo** comme contexte de build.

```bash
docker build -f apps/api/Dockerfile --target production -t ecomflow-api .
docker build -f apps/web/Dockerfile --target production \
  --build-arg NEXT_PUBLIC_API_URL=https://api.votre-domaine.dz/api/v1 \
  -t ecomflow-web .
```

Points d'attention :

- **Les images tournent sous un utilisateur non privilégié** (`ecomflow`, uid 1001).
- **Aucun secret n'est intégré à l'image.** Ils sont injectés au démarrage.
- **`NEXT_PUBLIC_API_URL` est un argument de build**, pas une variable
  d'exécution : Next.js l'inline dans le bundle envoyé au navigateur. Une image
  construite pour la recette ne peut donc pas être promue telle quelle en
  production — c'est voulu.
- `dumb-init` sert de PID 1 et propage `SIGTERM`, ce qui permet un arrêt propre
  (drainage des requêtes, fermeture des connexions PostgreSQL).

---

## 12. Intégrations externes — état réel

Cette section dit ce qui fonctionne, ce qui est prêt mais non branché, et ce qui
ne l'est pas. Elle est volontairement explicite : un tableau de bord qui affiche
« connecté » alors que rien ne l'est détruit la confiance au premier incident.

| Intégration | État | Détail |
|---|---|---|
| **Google Sheets** | Implémentée | OAuth 2.0 (lecture seule par défaut), aperçu avant import, mapping vérifié, quota 429 géré par token bucket + repli exponentiel avec `Retry-After` et reprise au curseur. **Inactive tant que `GOOGLE_CLIENT_ID/SECRET` ne sont pas fournis** — l'interface le dit explicitement. |
| **Transporteur de test** (`MOCK_CARRIER`) | Implémenté | Connecteur de développement, **nommé « Transporteur de test » dans l'interface**. Il ne prétend à aucun moment être un vrai transporteur. |
| **Yalidine** | Adaptateur écrit, **non vérifié contre l'API réelle** | Le code de l'adaptateur existe et suit le contrat commun. Il n'a pas pu être confronté à l'API de production faute d'un compte marchand. À valider avant toute mise en service. |
| **Guepex, Yalitec, We Can** | Adaptateurs écrits, **non vérifiés** | Revendeurs du réseau Yalidine : même API, mêmes champs, même authentification. Une seule implémentation les sert tous, instanciée une fois par société avec son domaine — que le marchand saisit, les revendeurs ne le publiant pas (D-070). |
| **Ecotrack, DHD, UPS (Conexlog), SpeedMail** | Adaptateur écrit, **non vérifié** | Ecotrack est une plateforme partagée par plus de 80 sociétés : une implémentation, un jeton Bearer, un domaine par société. « UPS » désigne ici **Conexlog EURL**, licencié algérien de la marque — pas l'API mondiale de United Parcel Service. Points d'entrée tirés d'intégrations open-source concordantes, jamais d'une documentation officielle. |
| **ZR Express (v2 · Procolis)** | Adaptateur écrit, **non vérifié** | L'idempotence passe par notre propre référence, placée dans le champ `Tracking` : un rejeu est refusé par « Double Tracking ». Ni annulation ni bordereau par l'API — la matrice de capacités le dit, et le produit n'affiche donc pas ces actions. |
| **ZR Express (v3)**, **Maystro**, **E-COM Delivery**, **Colivraison** | Au catalogue, **sans adaptateur** | v3 : adressage par UUID de territoire, chantier séparé. Les trois autres : sources publiques trop minces ou contradictoires — la documentation réelle est à demander à chaque société. Le catalogue dit laquelle des deux raisons s'applique. |
| **WhatsApp Cloud API** | Passerelle écrite, désactivée par défaut | `isConfigured()` retourne `false` sans les quatre variables requises, et tout envoi échoue alors **explicitement** plutôt que de faire semblant. |
| **Chargily Pay** | Passerelle écrite, désactivée par défaut | Le paiement par carte n'apparaît dans l'interface que si les clés sont présentes. L'abonnement n'est **jamais** activé par le retour du navigateur : seul le webhook signé l'active. |
| **E-mail** | `console` par défaut, SMTP disponible | En développement, les e-mails s'affichent dans les journaux ou sont capturés par MailHog. |
| **OTP par SMS** | Pilote `console` uniquement | Le pilote `sms` **échoue explicitement** au lieu de prétendre avoir envoyé un message. |

Les connecteurs transporteurs exposent un champ `implementationStatus` à **trois**
valeurs (D-070) :

- `AVAILABLE` — un adaptateur existe **et** a tourné contre un compte marchand
  réel. Seul cet état autorise à lire une capacité comme acquise ;
- `UNVERIFIED` — un adaptateur existe, écrit d'après des sources tierces, jamais
  confronté. Le transporteur est **sélectionnable** — c'est la seule façon de le
  vérifier un jour — mais ses capacités restent affichées comme **déclarées** ;
- `PLANNED` — aucun adaptateur. L'API refuse la création d'un compte, et
  l'interface dit pourquoi.

L'API ne liste jamais un transporteur planifié comme s'il était utilisable, et
n'affiche jamais une capacité non vérifiée comme si elle l'était.

---

## 13. Sécurité

| Sujet | Mise en œuvre |
|---|---|
| Mots de passe | Argon2id, paramètres de coût vérifiés à chaque connexion (`needsRehash`) |
| Jetons de session | Rotation avec **détection de rejeu** (RFC 9700) ; stockés en HMAC-SHA-256 poivré, jamais en clair |
| Secrets d'intégration | AES-256-GCM au repos, avec le `tenantId` en donnée authentifiée — un blob copié d'une boutique à une autre devient indéchiffrable |
| Validation | Serveur systématique, `whitelist` + `forbidNonWhitelisted` : un champ non déclaré fait échouer la requête au lieu d'être ignoré |
| Autorisation | Permissions vérifiées **côté serveur** à chaque appel. Ce que l'interface affiche ou masque n'est qu'un confort |
| Limitation de débit | Globale, plus des limites resserrées sur l'authentification et l'envoi d'OTP |
| Brute force | Verrouillage temporaire après N échecs (`AUTH_MAX_FAILED_LOGINS`) |
| Webhooks | Signature vérifiée sur le **corps brut** ; rejeu neutralisé par une table de webhooks traités |
| En-têtes HTTP | Helmet côté API, en-têtes de sécurité côté Next.js |
| Journaux | Pino, avec identifiant de corrélation ; les valeurs sensibles sont tronquées |
| Audit | Journal des actions sensibles, conservé indépendamment des données métier |
| Données personnelles | Anonymisation d'un client sur demande (loi 18-07) ; les commandes sont conservées sans identité rattachée |
| Données de démonstration | Le seed de démonstration **refuse de s'exécuter** en production : ses comptes ont un mot de passe publié dans ce dépôt |
| Secrets et Git | Aucun secret versionné. `.env.example` documente les clés avec des marqueurs `CHANGE_ME`, jamais de valeur exploitable. La CI le vérifie |

---

## 14. Déploiement

### Avec Docker Compose

1. Copiez `.env.example` vers `infra/docker/.env.production` et renseignez les
   valeurs réelles. **Ce fichier ne doit jamais être versionné.**
2. Vérifiez impérativement :
   - `NODE_ENV=production`
   - `SWAGGER_ENABLED=false`
   - `API_URL` et `APP_URL` en `https://`
   - `MAIL_DRIVER=smtp` avec un serveur réel
   - deux secrets JWT **différents**
3. Lancez :

```bash
docker compose -f infra/docker/docker-compose.prod.yml up -d
```

La stack applique les migrations dans un service dédié **avant** de démarrer
l'API : plusieurs instances ne peuvent donc pas migrer en parallèle.

### Ce que la stack ne fait pas, volontairement

- **Pas de terminaison TLS.** HTTPS est obligatoire, mais il est assuré en amont
  par le reverse proxy de l'hébergeur (Nginx, Traefik, Caddy). Embarquer un
  certificat auto-signé donnerait l'illusion du chiffrement.
- **Aucun port de base de données publié.** PostgreSQL et Redis ne sont
  joignables que par le réseau interne. L'API et le front sont publiés sur la
  boucle locale, à charge pour le proxy de les exposer.

### Reverse proxy — points à respecter

- Transmettre `X-Forwarded-For` et `X-Forwarded-Proto` : l'API fait confiance à
  un proxy (`trust proxy = 1`) et en dépend pour la limitation de débit.
- Ne pas mettre en cache les réponses de `/api/v1/*`.
- Autoriser les en-têtes `Authorization`, `X-Tenant-Id`, `Idempotency-Key`,
  `X-Correlation-Id`.

### Sondes

| Sonde | Chemin | Usage |
|---|---|---|
| Vivacité | `/health/live` | Le processus répond. **Ne vérifie pas la base** — sinon une coupure passagère provoquerait un redémarrage en boucle |
| Disponibilité | `/health/ready` | Base et dépendances joignables. C'est cette sonde qui doit conditionner l'envoi de trafic |

### Spécification OpenAPI

```bash
npm run openapi:export -w @ecomflow/api
```

Produit `apps/api/openapi.json` (111 chemins, 120 opérations). L'export ne
nécessite ni base ni Redis : il ne lit que les métadonnées des décorateurs. La
CI vérifie que le fichier versionné correspond toujours au code.

---

## 15. Sauvegarde et restauration

Une sauvegarde qui n'a jamais été restaurée n'est pas une sauvegarde.

```bash
# Sauvegarde
docker compose -f infra/docker/docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > ecomflow-$(date +%F).dump

# Restauration (base vide)
docker compose -f infra/docker/docker-compose.prod.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < ecomflow-2026-08-30.dump
```

Recommandations : sauvegarde quotidienne, conservation 30 jours, **chiffrement
des archives**, stockage hors du serveur applicatif, et **restauration testée au
moins une fois par trimestre**. Un hébergement géré doit utiliser les sauvegardes
de son fournisseur, qui couvrent aussi la restauration à un instant donné.

---

## 16. Dépannage

**« Configuration d'environnement invalide » au démarrage**
Le message liste toutes les variables fautives. Vérifiez que `.env` existe et que
les quatre secrets sont générés. Une variable laissée vide est traitée comme
absente : c'est voulu, `REDIS_URL=` signifie « non utilisé ».

**`Can't reach database server at localhost:5432`**
PostgreSQL n'est pas lancé. `npm run docker:up`, puis
`docker compose -f infra/docker/docker-compose.dev.yml ps` pour vérifier l'état
de santé du conteneur.

**`Requête refusée : <Modèle>.<opération> nécessite un tenant actif`**
Ce n'est pas un bug mais le garde d'isolation qui fait son travail : du code
s'exécute hors du périmètre d'une boutique. Encadrez l'appel avec
`RequestContextStore.runWithTenant()`, ou déclarez une sortie de périmètre
explicite avec `runUnscoped(raison)`.

**`Acces inter-tenant bloque`**
Un `tenantId` explicite diverge du tenant actif. La valeur n'est jamais écrasée
en silence : une telle divergence révèle soit un bug, soit une tentative d'accès
croisé, et mérite une enquête.

**429 pendant les tests de bout en bout**
La limitation de débit est active. Les suites de test posent
`THROTTLE_ENABLED=false` ; vérifiez que la variable est bien transmise.

**Erreurs de types sur `@ecomflow/shared`**
Le paquet partagé n'est pas compilé : `npm run build:shared`. L'API se compile
**contre les artefacts** du paquet partagé, pas contre ses sources — c'est ce
qui garantit une sortie à plat en `dist/main.js` (D-042). Les scripts `build`
et `start:dev` de l'API le construisent automatiquement ; pour travailler sur
les deux à la fois, lancez `npm run dev:shared` dans un second terminal.

**`Cannot find module '…/dist/main'` au démarrage**
Symptôme d'un cache incrémental TypeScript périmé : `dist` a été supprimé mais
`tsconfig.build.tsbuildinfo` a survécu, et TypeScript conclut « rien n'a
changé » sans rien émettre — tout en affichant `Found 0 errors`. Le fichier de
cache vit désormais **dans `dist`**, ce qui rend le cas impossible. Si vous le
rencontrez sur une ancienne copie : `rm -rf apps/api/dist apps/api/*.tsbuildinfo`.

**La resynchronisation Google Sheets crée des doublons**
Ce cas est traité : l'empreinte d'une ligne n'inclut **pas** son numéro, donc
insérer une ligne au milieu de la feuille ne décale rien. Reste un cas limite
assumé — deux lignes rigoureusement identiques, date comprise — pour lequel il
faut ajouter une colonne d'identifiant (`externalIdColumn`). Voir D-028 dans
[`DECISIONS.md`](DECISIONS.md).

**`spawnSync npx.cmd EINVAL` sous Windows**
Node ≥ 20 refuse d'exécuter des `.cmd` via `spawn` sans shell. Les scripts du
projet résolvent le CLI Prisma en JavaScript et l'exécutent avec `node`.

**Une clé de traduction s'affiche à l'écran (`orders.title`)**
La clé manque dans le catalogue de la langue active. C'est le comportement
voulu : afficher la clé brute plutôt que de faire tomber l'écran. Ajoutez-la
dans `fr.json` **et** `ar.json`, puis `npm run test -w @ecomflow/web` — le test
liste toutes les clés manquantes d'un coup.

**L'interface arabe s'affiche alignée à gauche**
Le `dir` n'a pas été appliqué. Vérifiez que la page est bien servie par la
disposition racine (`apps/web/src/app/layout.tsx`) et que le cookie
`ecomflow_locale` vaut `ar`. Si une zone précise reste mal alignée, elle utilise
sans doute encore une classe directionnelle (`ml-`, `text-left`) au lieu de sa
version logique (`ms-`, `text-start`).

**`npm run seed:demo` échoue avec « NODE_ENV=production »**
C'est volontaire. Les comptes de démonstration ont un mot de passe publié dans
ce dépôt ; les créer en production ouvrirait un accès connu de tous. Utilisez un
environnement de développement ou de recette. `npm run seed` (sans `:demo`)
reste utilisable en production.

**Le front affiche « Session expirée » en boucle**
Le jeton de rafraîchissement a été rejeté. La détection de rejeu révoque toute
la famille de jetons dès qu'un jeton déjà utilisé est présenté : reconnectez-vous.
Si cela se reproduit, vérifiez que `JWT_REFRESH_SECRET` est identique entre les
instances d'API.

---

## 17. Documentation du projet

| Fichier | Contenu |
|---|---|
| [`DECISIONS.md`](DECISIONS.md) | Journal des décisions structurantes : contexte, problème, décision, justification, impact. Les entrées ne sont jamais supprimées |
| [`.env.example`](.env.example) | Toutes les variables, commentées, sans aucune valeur sensible |
| `apps/api/openapi.json` | Spécification OpenAPI générée |
| `docs/specs/` | Cahiers des charges V1, V2 et Addendum |

En cas de contradiction entre les spécifications, l'ordre de priorité retenu est
**Addendum > V2 > V1**.

---

## Licence

Propriétaire — tous droits réservés.
