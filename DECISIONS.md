# DECISIONS.md — Journal des décisions structurantes

Ce document consigne les décisions d'architecture et de produit prises en
autonomie pendant la construction d'EcomFlow, lorsque les cahiers des charges
laissaient un choix ouvert ou qu'une exigence méritait une interprétation
explicite.

**Ne sont consignées que les décisions structurantes** : celles qui seraient
coûteuses à revenir sur, ou qui surprendraient un développeur rejoignant le
projet. Les choix triviaux n'y figurent pas.

**Hiérarchie des sources appliquée** : Addendum > V2 > V1.

Format de chaque entrée : contexte → problème → décision → justification → impact.

---

## D-001 — Monorepo npm workspaces, sans outil de build supplémentaire

**Date** : 29/08/2026 · **Statut** : appliquée

**Contexte** — Le produit comporte un backend NestJS, un frontend Next.js et des
règles métier communes aux deux (statuts de commande, permissions, normalisation
téléphone, calculs monétaires).

**Problème** — Dupliquer ces règles des deux côtés garantit qu'elles divergeront.
Mais introduire Nx ou Turborepo ajoute une couche d'outillage à maîtriser.

**Décision** — Monorepo en `npm workspaces` natif, avec un paquet
`packages/shared` sans aucune dépendance runtime, compilé en CommonJS + `.d.ts`.

**Justification** — Les workspaces npm suffisent pour trois paquets. `shared`
étant dépourvu de dépendances, il est importable par le backend comme par le
navigateur sans risque de fuite de secret ni d'effet de bord. La règle métier
n'existe qu'à un seul endroit et est testée unitairement une seule fois.

**Impact** — Toute règle partagée doit rester une **fonction pure**. Aucun accès
base, réseau ou `process.env` dans `packages/shared`.

---

## D-002 — Versions majeures stables plutôt que dernières versions publiées

**Date** : 29/08/2026 · **Statut** : appliquée

**Contexte** — Au moment de la construction, les registres publiaient NestJS 12,
Next.js 16, TypeScript 7, Prisma 8-rc et Tailwind 4.

**Problème** — Ces versions sont trop récentes pour disposer d'un écosystème
stabilisé (plugins, adaptateurs, documentation, retours de production).

**Décision** — Épingler NestJS 11, Next.js 15, React 19, TypeScript 5.9,
Prisma 6.19, Tailwind 3.4, Jest 29, Zod 3.

**Justification** — L'ordre de priorité imposé (§60 du cahier de mission) place
la **fiabilité** avant l'innovation. Un socle éprouvé réduit le risque de blocage
sur un bug d'outillage sans rapport avec le métier.

**Impact** — Une montée de version est un chantier à part entière, à planifier
hors du chemin critique. Les versions sont épinglées à l'exact (pas de `^`) dans
`apps/api/package.json`.

---

## D-003 — Montants monétaires en entiers de centimes

**Date** : 29/08/2026 · **Statut** : appliquée

**Contexte** — Le dashboard Pertes & Rentabilité (Addendum §33) impose des
calculs de marge exacts et auditables par le commerçant.

**Problème** — Les flottants accumulent des erreurs d'arrondi ; le type `Decimal`
de PostgreSQL se sérialise mal en JSON et impose une bibliothèque côté client.

**Décision** — Tous les montants sont des **entiers de centimes de dinar**
(`Int` en base, `number` en TypeScript). Les colonnes portent le suffixe
`_centimes`. Aucun `Float` n'existe dans le schéma.

**Justification** — Un entier se sérialise sans ambiguïté, se somme sans perte et
se compare exactement. La ventilation des frais de livraison sur les lignes
(`allocateCentimes`) garantit que la somme des parts égale exactement le total.

**Impact** — Toute saisie utilisateur passe par `dinarsToCentimes`. Tout
affichage passe par `formatCentimes`. Un champ monétaire sans suffixe
`_centimes` est un bug.

---

## D-004 — Isolation multi-tenant à trois niveaux, dont un au niveau base

**Date** : 29/08/2026 · **Statut** : appliquée

**Contexte** — « Les données d'une boutique ne doivent jamais être accessibles à
une autre boutique » (V1 §29, V2 §5) est le critère d'acceptation le plus
critique du produit.

**Problème** — Un filtrage applicatif seul repose sur la discipline du
développeur : un `where` oublié dans un service suffit à faire fuiter des
données clients entre commerçants concurrents.

**Décision** — Trois barrières indépendantes :

1. **Contexte de requête implicite** (`AsyncLocalStorage`) portant le tenant
   courant, alimenté uniquement par le jeton vérifié — jamais par le corps de
   requête ni par un paramètre d'URL.
2. **Extension Prisma `tenantGuard`** qui injecte le filtre `tenantId` sur
   toute opération d'un modèle scopé, et **refuse** (fail-closed) toute requête
   scopée hors contexte de tenant. Une divergence entre le `tenantId` fourni et
   le tenant actif est traitée comme un **incident de sécurité** journalisé, pas
   comme une valeur à écraser silencieusement.
3. **Clés étrangères composites en base** : chaque relation inter-entités porte
   sur `(tenant_id, id)` et non sur `id` seul. PostgreSQL refuse physiquement
   qu'une commande de la boutique A référence un client de la boutique B, quelle
   que soit la faille applicative.

**Justification** — Les trois barrières ont des modes de défaillance
indépendants. La troisième tient même si les deux premières sont contournées.
Elle est vérifiée par des tests d'intégration dédiés
(`test/integration/schema-constraints.spec.ts`).

**Impact** — Toute nouvelle table portant des données de boutique doit être
classée dans `tenant-scoped-models.ts` (un test échoue sinon) et recevoir ses
clés étrangères composites dans une migration. Les requêtes SQL brutes ne sont
pas interceptées : elles doivent filtrer `tenant_id` explicitement, et le
commentaire l'indique à chaque occurrence.

---

## D-005 — Sortie de périmètre tenant explicite et motivée

**Date** : 29/08/2026 · **Statut** : appliquée

**Contexte** — Certaines opérations légitimes n'ont pas de tenant :
authentification, administration plateforme, jobs balayant toutes les boutiques.

**Problème** — Une échappatoire non tracée deviendrait le chemin de moindre
résistance : « ça ne marche pas, je mets un runUnscoped ».

**Décision** — `RequestContextStore.runUnscoped(raison, fn)` exige une **raison
typée** (`AUTHENTICATION`, `PLATFORM_ADMIN`, `BACKGROUND_JOB`,
`WEBHOOK_DISPATCH`, `BOOTSTRAP`, `HEALTHCHECK`, `TEST`).

**Justification** — Un `grep runUnscoped` liste en quelques secondes tous les
points où l'isolation est volontairement suspendue, avec leur motif. La revue de
code devient possible ; l'ajout d'une nouvelle raison est un acte conscient.

**Impact** — Aucun service métier ne doit appeler `runUnscoped`. C'est un outil
d'infrastructure.

---

## D-006 — Permissions relues à chaque requête, jamais figées dans le jeton

**Date** : 29/08/2026 · **Statut** : appliquée

**Problème** — Embarquer les permissions dans le jeton d'accès (durée 15 min)
signifie qu'un retrait de droits reste sans effet pendant ce délai.

**Décision** — Le jeton ne porte que l'identité et le tenant. Les permissions
sont résolues en base à chaque requête, avec un cache mémoire de **5 secondes**,
invalidé explicitement à chaque changement de rôle ou d'adhésion.

**Justification** — Sur une plateforme où un agent de confirmation manipule des
données personnelles de clients, un délai de 15 minutes après une révocation est
inacceptable. Le coût est d'une jointure indexée, amortie par le cache.

**Impact** — Tout code modifiant un rôle, une permission ou une adhésion **doit**
appeler `AccessContextService.invalidateUser` ou `invalidateTenant`.

---

## D-007 — Jetons de rafraîchissement à rotation avec détection de rejeu

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — Chaque usage d'un jeton de rafraîchissement en émet un nouveau et
révoque l'ancien. La présentation d'un jeton déjà révoqué révoque **toute la
famille** de sessions. Seule l'empreinte HMAC poivrée est stockée.

**Justification** — Un jeton volé est indiscernable d'un jeton légitime. La
rotation rend le vol *détectable* : deux porteurs finissent par présenter le
même jeton. C'est la recommandation OAuth 2.0 pour clients publics (RFC 9700).

**Impact** — Un client qui perd la réponse d'un `/auth/refresh` (coupure réseau
au mauvais moment) devra se reconnecter. Compromis assumé au profit de la
sécurité.

---

## D-008 — Argon2id pour les mots de passe, HMAC-SHA-256 pour les jetons

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — Deux mécanismes distincts. Mots de passe : Argon2id (19 Mio,
2 itérations, parallélisme 1 — paramètres OWASP). Jetons et OTP : HMAC-SHA-256
avec un poivre serveur.

**Justification** — Un mot de passe est un secret à **faible entropie** choisi
par un humain : le hachage doit être lent et coûteux en mémoire. Un jeton est un
secret à **forte entropie** généré par le serveur : un hachage lent serait un
handicap à chaque appel authentifié, sans gain — la recherche exhaustive est de
toute façon impossible. Le poivre protège contre l'exploitation d'une base volée.

**Impact** — `HASH_PEPPER` doit être sauvegardé comme un secret critique : le
perdre invalide toutes les sessions et tous les OTP en cours.

---

## D-009 — Le numéro de téléphone vérifié par OTP est obligatoire à l'inscription

**Date** : 29/08/2026 · **Statut** : appliquée · **Source** : Addendum §38

**Contexte** — Sans garde-fou, un vendeur crée une boutique tous les 7 jours et
reste indéfiniment en essai gratuit.

**Décision** — L'inscription exige un numéro algérien vérifié par code OTP.
Un numéro vérifié ne peut ouvrir **qu'un seul** essai (index unique partiel en
base).

**Justification** — L'Addendum le désigne comme « identifiant vérifié et
difficile à dupliquer ». C'est le seul signal assez fort pour bloquer seul. Les
signaux techniques (IP, empreinte d'appareil) sont trop faibles en Algérie, où le
partage d'IP est la norme (NAT opérateur mobile, connexions partagées).

**Impact** — Un fournisseur d'envoi (WhatsApp Business ou agrégateur SMS) est
**requis en production**. En développement, `OTP_DRIVER=console` affiche le code
dans les journaux. Le pilote `sms` échoue explicitement tant qu'aucun agrégateur
n'est intégré : conformément à la règle de véracité, aucune intégration n'est
simulée.

---

## D-010 — Score d'abus de l'essai : faisceau de signaux, jamais un signal isolé

**Date** : 29/08/2026 · **Statut** : appliquée · **Source** : Addendum §38

**Décision** — Chaque signal porte un poids. Seuil de blocage : 100 points.
Seuil de revue manuelle : 50 points. Le numéro vérifié réutilisé vaut 100 (bloque
seul) ; une IP partagée vaut 25 (ne déclenche rien seule). IP et empreinte
d'appareil ne sont stockées **que hachées**.

**Justification** — Le cahier de mission (§35) l'exige explicitement. Bloquer un
vrai commerçant à tort coûte plus cher qu'un abus laissé passer : en cas de
doute, la décision est `MANUAL_REVIEW` — l'essai démarre, un humain tranche.

**Impact** — Une file de revue Super Admin est nécessaire. Le hachage des signaux
techniques répond au principe de minimisation des données (loi 18-07).

---

## D-011 — La commande référence toujours une **variante**, jamais un produit

**Date** : 29/08/2026 · **Statut** : appliquée

**Problème** — Autoriser une ligne de commande à pointer soit un produit, soit
une variante créerait deux chemins de calcul de stock.

**Décision** — Tout produit possède au moins une variante, marquée `isDefault`.
`order_items.variant_id` est obligatoire.

**Justification** — V2 §14 exige que « les règles de décrémentation soient
centralisées afin d'éviter des écarts entre modules ». Un seul chemin de stock
est la seule façon de le garantir.

**Impact** — La création d'un produit crée systématiquement sa variante par
défaut. L'interface masque cette variante quand elle est unique.

---

## D-012 — Trois compteurs de stock distincts

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — `onHand` (détenu physiquement), `reserved` (engagé sur commandes
confirmées), `quarantine` (retours en attente de contrôle). Le stock vendable
vaut `onHand - reserved`.

**Justification** — Décrémenter `onHand` à la confirmation fausse l'inventaire
physique (la marchandise est encore là) ; ne rien décrémenter conduit à
survendre. La distinction résout les deux. La quarantaine évite de remettre en
vente un colis revenu après une semaine de transport sans contrôle.

**Impact** — Une contrainte `CHECK` interdit tout compteur négatif. Les
réservations utilisent un `UPDATE` conditionnel atomique
(`WHERE on_hand - reserved >= :quantité`) : deux confirmations simultanées sur le
dernier article ne peuvent pas réussir toutes les deux.

---

## D-013 — Le workflow de commande est le seul écrivain de `orders.status`

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — `OrderWorkflowService` est le point de passage obligé de tout
changement de statut, quelle qu'en soit l'origine (interface, webhook
transporteur, filtre WhatsApp, import, job).

**Justification** — Un changement de statut n'est jamais une simple écriture de
colonne : il entraîne réservation ou libération de stock, dates métier, ligne
d'historique, compteurs client et événement de notification. Disperser cette
logique produirait des états incohérents — stock réservé pour une commande
annulée, historique troué.

**Impact** — Aucun `prisma.order.update({ data: { status } })` hors de ce service.
Le workflow expose `transitionWithin(tx, …)` pour les cas où la transition doit
partager la transaction d'une autre écriture.

---

## D-014 — La fenêtre temporelle est une **condition d'entrée** de la détection de doublons

**Date** : 29/08/2026 · **Statut** : appliquée

**Problème** — Un client fidèle qui recommande le même produit trois semaines
plus tard déclenchait une alerte de doublon (même téléphone, même produit, même
adresse, même montant).

**Décision** — Au-delà de la fenêtre configurée (48 h par défaut), le score est
nul : aucune alerte. La fenêtre n'est plus un simple poids.

**Justification** — Signaler des clients fidèles comme doublons ruinerait la
confiance dans l'alerte : les agents finiraient par toutes les ignorer, y compris
les vraies. Défaut découvert par un test unitaire, corrigé à la source.

**Impact** — Le seuil « très probable » ne peut jamais être plus permissif que le
seuil d'alerte : relever `alertThreshold` produit **moins** d'alertes, jamais des
alertes requalifiées à la hausse.

---

## D-015 — Référence de commande unique **par boutique**

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — `ORD-AAAA-XXXXXX` est unique par `(tenant_id, référence)`. Deux
boutiques ont chacune leur `ORD-2026-000001`. La séquence est allouée en base par
un `UPDATE … RETURNING` atomique.

**Justification** — C'est ce qu'attend un commerçant : ses commandes commencent à
1. Une numérotation globale divulguerait le volume d'affaires de la plateforme à
chacun de ses clients.

**Impact** — La référence n'est **jamais** une clé primaire : l'identité technique
reste un UUID v7. Elle peut donc être régénérée sans casser aucune relation.

---

## D-016 — Boîte d'envoi transactionnelle pour les événements métier

**Date** : 29/08/2026 · **Statut** : appliquée

**Problème** — Une notification envoyée juste après un changement de statut peut
partir alors que la transaction est finalement annulée. Placée après le commit,
elle est perdue si le processus tombe entre les deux.

**Décision** — L'événement est écrit dans `outbox_events` **dans la même
transaction** que le changement d'état. Un consommateur asynchrone le dépile avec
`FOR UPDATE SKIP LOCKED`, reprise à délai croissant, et abandon après 5 tentatives
vers le centre d'incidents.

**Justification** — Garantit qu'un événement existe si et seulement si le
changement d'état a été validé. `SKIP LOCKED` permet à plusieurs instances de
l'API de dépiler en parallèle sans blocage mutuel.

**Impact** — Garantie « au moins une fois » : tout consommateur doit être
idempotent — ce qu'exige de toute façon la V2 §30.

---

## D-017 — Le chiffre d'affaires n'est reconnu qu'à la **livraison**

**Date** : 29/08/2026 · **Statut** : appliquée · **Source** : Addendum §33

**Décision** — En modèle COD, aucun encaissement n'a lieu tant que le colis n'est
pas remis. Le CA n'est donc reconnu qu'au statut `LIVRÉE`. Le coût produit n'est
constaté que si la marchandise est définitivement perdue : un retour remis en
stock ne coûte que le transport.

**Justification** — C'est la réalité économique du COD algérien, et la seule
façon de rendre le dashboard Pertes & Rentabilité honnête. Une commande annulée
avant expédition ne génère **aucune perte réelle** ; elle est comptabilisée
séparément en « manque à gagner », clairement distingué.

**Impact** — Les KPI financiers distinguent trois notions : **perte réelle**
(trésorerie sortie sans contrepartie), **manque à gagner** (CA non réalisé) et
**marge nette**. La table de correspondance est documentée dans
`packages/shared/src/profitability.ts`.

---

## D-018 — Référentiel des wilayas embarqué, communes en texte libre normalisé

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — Les 58 wilayas (découpage 2019) sont embarquées et font autorité,
avec résolution des variantes de translittération courantes (« Algiers », « BBA »,
« Béjaïa »/« Bejaia », noms arabes). Les **communes** ne sont pas embarquées.

**Justification** — Le référentiel des wilayas est stable et vérifiable.
Celui des communes compte plus de 1500 entrées avec des translittérations très
variables selon les transporteurs : embarquer une liste approximative produirait
des rejets d'import injustifiés sur des commandes parfaitement valides.

**Impact** — La commune est validée contre les communes déjà utilisées par la
boutique (apprentissage) et contre le référentiel du transporteur quand il en
publie un. Une contrainte `CHECK` en base impose `wilaya_code BETWEEN 1 AND 58`.

---

## D-019 — Tests d'intégration sur un vrai PostgreSQL, sans Docker

**Date** : 29/08/2026 · **Statut** : appliquée

**Problème** — L'essentiel des garanties d'EcomFlow vit dans PostgreSQL : clés
étrangères composites, contraintes `CHECK`, index uniques partiels. Un double en
mémoire ne les exécuterait pas — les tests seraient verts alors que la production
casserait.

**Décision** — Le harnais de test démarre une instance **PostgreSQL 17 réelle**
via `embedded-postgres`, applique les vraies migrations avec `prisma migrate
deploy`, puis amorce les référentiels. Si `TEST_DATABASE_URL` est fournie (CI,
docker-compose), elle est utilisée à la place.

**Justification** — Aucune installation préalable ni conteneur n'est nécessaire :
les tests tournent sur un poste nu. Passer par `migrate deploy` valide les
migrations elles-mêmes, contrairement à `db push`.

**Impact** — `maxWorkers: 1` est imposé : les suites partagent une base unique et
la vident entre chaque test.

---

## D-020 — Une variable d'environnement vide vaut « non définie »

**Date** : 29/08/2026 · **Statut** : appliquée

**Problème** — Un fichier `.env` ne sait pas exprimer « non défini » :
`S3_ENDPOINT=` produit une chaîne vide, que la validation d'URL rejetait,
empêchant le démarrage alors que l'intégration n'était simplement pas utilisée.

**Décision** — Les variables vides sont retirées avant validation. Les champs
pourvus d'une valeur par défaut la retrouvent naturellement.

**Justification** — C'est la sémantique attendue d'un `.env`. Défaut découvert
par un test d'intégration.

**Impact** — Pour forcer une chaîne vide comme valeur métier, il faudrait un
marqueur explicite. Aucun cas ne le requiert aujourd'hui.

---

## D-021 — Un seul fichier `.env`, à la racine du dépôt

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — Un unique `.env` racine, partagé par l'API et le front. Les scripts
de l'API le chargent via `dotenv-cli`.

**Justification** — Dupliquer les secrets par application multiplie les risques de
fuite et de désynchronisation. Les variables destinées au navigateur sont
préfixées `NEXT_PUBLIC_` : la frontière est explicite dans le fichier lui-même.

**Impact** — En conteneur, les variables sont injectées par l'orchestrateur et
priment sur le fichier.

---

## D-022 — Statut d'abonnement recalculé à la volée, jamais lu tel quel

**Date** : 29/08/2026 · **Statut** : appliquée · **Source** : V2 §7

**Décision** — `SubscriptionStateService` dérive l'état depuis les **dates**
persistées à chaque consultation (cache 10 s), et aligne le statut stocké de
façon opportuniste. Le statut en base sert au reporting et aux filtres, jamais à
la décision d'accès.

**Justification** — Même si le job d'expiration n'a pas encore tourné, une
boutique dont l'essai est terminé est bloquée à la milliseconde près. C'est
l'exigence « source de vérité côté serveur » prise au sérieux.

**Impact** — L'échec d'alignement du statut persisté est journalisé sans bloquer
la requête : l'état calculé fait autorité.

---

## D-023 — Ce qui reste accessible après expiration de l'essai

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — Le blocage porte sur les fonctionnalités **opérationnelles**
(création et confirmation de commandes, expédition, synchronisation). Restent
accessibles : la consultation des données, **l'export**, la gestion de
l'abonnement et le paiement.

**Justification** — Bloquer l'export transformerait une fin d'essai en prise en
otage des données du commerçant, ce qu'excluent la loi 18-07 et le simple bon
sens commercial. Le cahier des charges parle de suspendre « les fonctionnalités
opérationnelles payantes », pas l'accès aux données.

**Impact** — Le décorateur `@RequiresOperationalSubscription()` est posé
route par route, jamais globalement.

---

## D-024 — Aucune intégration externe n'est simulée

**Date** : 29/08/2026 · **Statut** : appliquée · **Source** : cahier de mission §5

**Décision** — Chaque connecteur externe déclare son état réel :
- `WhatsappGateway.isConfigured()` retourne `false` tant que les identifiants
  Meta manquent ; tout envoi échoue alors explicitement et le filtre de
  confirmation se replie **intégralement** sur la file d'appel humaine ;
- le catalogue des transporteurs porte un champ `implementationStatus`
  (`AVAILABLE` / `PLANNED`) : un transporteur non implémenté ne peut pas être
  activé, et l'interface l'indique ;
- le pilote OTP `sms` échoue explicitement tant qu'aucun agrégateur n'est
  intégré, plutôt que de faire croire à un envoi.

**Justification** — Présenter comme fonctionnelle une intégration qui ne l'est
pas est la façon la plus sûre de perdre la confiance d'un commerçant le jour du
lancement.

**Impact** — Les tests utilisent des adaptateurs **explicitement nommés**
(`MOCK_CARRIER`), jamais un vrai connecteur détourné.

---

## D-025 — L'audit ne casse jamais l'action métier

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — `AuditService.record()` n'échoue jamais : une erreur d'écriture est
journalisée en `error` sans interrompre l'appelant. `recordInTransaction()`
propage au contraire l'erreur, pour les cas où la trace doit être atomique avec
l'action.

**Justification** — Une commande confirmée doit le rester même si le journal
d'audit est momentanément indisponible. Mais un changement de statut et sa trace
doivent être écrits ensemble ou pas du tout : les deux besoins coexistent, d'où
deux méthodes distinctes.

**Impact** — Les métadonnées passent par une liste noire de clés
(`password`, `token`, `secret`, `credentials`…) et une troncature : un
développeur qui journaliserait par mégarde un corps de requête complet ne peut
pas faire fuiter de secret.

---

## D-026 — Authentification fermée par défaut

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — `JwtAuthGuard` est enregistré **globalement**. Ouvrir une route
exige un `@Public()` explicite.

**Justification** — Une route ajoutée sans y penser est protégée, jamais exposée.
C'est l'inverse du réglage par défaut le plus dangereux.

**Impact** — Les routes réellement publiques (login, plans tarifaires, webhooks)
sont listées et revues. Les webhooks compensent par une vérification de
signature.

---

## D-027 — `forbidNonWhitelisted` sur la validation globale

**Date** : 29/08/2026 · **Statut** : appliquée

**Décision** — Le `ValidationPipe` global refuse toute requête contenant un champ
non déclaré dans le DTO, au lieu de l'ignorer silencieusement.

**Justification** — Un client qui envoie `tenantId`, `role` ou `status` dans le
corps reçoit une erreur explicite plutôt qu'une élévation de privilège
silencieuse par assignation de masse.

**Impact** — Tout champ accepté doit être déclaré dans un DTO. Le contrat
d'API est donc exhaustif par construction.

---

## D-028 — L'empreinte d'une ligne Google Sheets ignore sa position

**Date** : 30/08/2026 · **Statut** : appliquée · **Source** : V2 §12, §37

**Contexte** — L'idempotence de l'import repose sur une empreinte stable de
chaque ligne source.

**Problème** — Une première implémentation incluait le numéro de ligne dans
l'empreinte, afin de distinguer deux lignes rigoureusement identiques. Un test
d'intégration a montré la conséquence : insérer une ligne au milieu de la
feuille — geste banal — décalait toutes les suivantes et recréait des dizaines
de commandes déjà importées.

**Décision** — L'empreinte se calcule ainsi, dans l'ordre :
1. l'**identifiant externe** de la ligne, si le commerçant a une colonne d'ID ;
2. à défaut, un hash SHA-256 des **valeurs métier** : client, téléphone,
   produit, quantité, date. **La position n'y entre jamais.**

**Justification** — « Une resynchronisation ne crée aucun doublon » est un
critère d'acceptation répété trois fois dans les cahiers des charges (V1 §29,
V2 §12, V2 §37). Le cas inverse — deux lignes strictement identiques, même
date comprise — n'y est mentionné nulle part et reste marginal.

**Limite assumée et sa parade** — Deux lignes rigoureusement identiques (même
client, même téléphone, même produit, même quantité, **même date**) produisent
la même empreinte : la seconde est enregistrée `SKIPPED_DUPLICATE` et reste
**visible dans le journal d'import**. Le commerçant concerné doit ajouter une
colonne d'identifiant, ce que `externalIdColumn` prend en charge et que
l'assistant de configuration recommande.

**Impact** — Perdre silencieusement une commande est grave ; créer des dizaines
de doublons à chaque insertion de ligne l'est davantage, et se produirait tous
les jours. La détection de doublons (D-014) constitue le filet de sécurité pour
le cas résiduel.

---

## D-029 — L'export OpenAPI diffère la connexion à la base plutôt que d'exiger PostgreSQL

**Date** — 30/08/2026

**Contexte** — La CI doit vérifier que la spécification OpenAPI publiée décrit
bien l'API réellement servie. L'export instancie donc le contexte NestJS complet
pour lire les métadonnées des décorateurs.

**Problème** — `PrismaService.onModuleInit()` appelle `$connect()`. L'export
échouait donc sans PostgreSQL, alors qu'il n'émet **aucune requête**. Exiger une
base pour générer un document statique aurait alourdi la CI et rendu l'export
impossible en local sans Docker.

**Alternatives écartées** —
- *Démarrer PostgreSQL dans le job d'export* : coût inutile pour une opération
  qui ne lit rien.
- *Un module allégé dédié à l'export* : il aurait fallu maintenir en parallèle
  la liste des contrôleurs. Toute divergence produirait une spécification
  incomplète — exactement ce que ce job doit empêcher.
- *Un client Prisma factice* : cela reviendrait à simuler une infrastructure,
  contraire à la règle de véracité (§5).

**Décision** — Un drapeau `ECOMFLOW_SKIP_DB_CONNECT=true`, posé par le script
lui-même, **diffère la connexion initiale**. Prisma reste parfaitement
fonctionnel : toute requête réelle tenterait de se connecter et échouerait
normalement.

**Justification** — Rien n'est simulé, seul le moment de la connexion change.
Le comportement observable est vérifiable : l'image Docker démarrée avec ce
drapeau répond `200` sur `/health/live` et `503` sur `/api/v1/plans`. La sonde
de disponibilité continue donc de dire la vérité.

**Impact** — La CI exporte la spécification et vérifie le démarrage de l'image
sans infrastructure. Le drapeau est journalisé en `warn` à chaque usage, pour
qu'il ne puisse pas passer inaperçu en production.

---

## D-030 — `NEXT_PUBLIC_API_URL` est un argument de build, pas une variable d'exécution

**Date** — 30/08/2026

**Contexte** — L'image de production du frontend doit pouvoir viser des
environnements différents (recette, production).

**Problème** — Next.js **inline** les variables `NEXT_PUBLIC_*` dans le bundle
JavaScript envoyé au navigateur, au moment de la compilation. Les fournir à
l'exécution donne une image qui ignore silencieusement la valeur passée : le
navigateur continue d'appeler l'ancienne URL.

**Alternatives écartées** —
- *Injecter la configuration au démarrage via un fichier servi* : ajoute un
  aller-retour réseau avant le premier appel utile et une source de vérité
  supplémentaire, pour un besoin qui change deux fois par an.
- *Laisser la variable à l'exécution* : produit une panne silencieuse, le pire
  des cas — l'interface semble fonctionner et interroge le mauvais serveur.

**Décision** — `NEXT_PUBLIC_API_URL` est déclaré en `ARG` dans le Dockerfile du
frontend et documenté comme tel dans le README et le `docker-compose.prod.yml`,
où il est **obligatoire** (`:?`).

**Impact** — Une image construite pour la recette **ne peut pas** être promue
telle quelle en production : il faut la reconstruire. C'est une contrainte
assumée, qui évite qu'une interface de production interroge une API de test.

---

## D-031 — La CI accepte des marqueurs dans `.env.example`, jamais de valeur exploitable

**Date** — 30/08/2026

**Contexte** — La règle §47 impose « aucun secret dans Git » et un
`.env.example` sans vraies valeurs sensibles.

**Problème** — Une vérification automatique naïve (« aucune variable sensible ne
doit avoir de valeur ») aurait rejeté
`JWT_ACCESS_SECRET=CHANGE_ME_openssl_rand_hex_32`. Or ce marqueur est utile : il
documente le format attendu et la commande de génération. Le supprimer aurait
dégradé le fichier sans rien sécuriser.

**Décision** — Le contrôle de CI signale toute variable sensible portant une
valeur qui **n'est pas** un marqueur explicite (`CHANGE_ME`, `REPLACE_ME`,
`TODO`, `<…>`, `your-`). Un second contrôle vérifie qu'aucun fichier
d'environnement n'est suivi par Git — ce que le seul `.gitignore` ne garantit
pas, `git add -f` le contournant sans bruit.

**Impact** — Le modèle reste pédagogique tout en rendant impossible la fuite
d'un secret réel par ce fichier. Le point de contrôle est explicite plutôt que
laissé à la vigilance des relecteurs.

---

## D-032 — Le point d'entrée de production était erroné : correction et vérification

> **Remplacée par [D-042](#d-042--lapi-se-compile-contre-les-artefacts-du-paquet-partagé-pas-contre-ses-sources).**
> Cette entrée alignait les chemins sur une sortie de compilation elle-même
> incorrecte. La production démarrait, mais `nest start --watch` restait
> cassé : D-042 traite la cause plutôt que le symptôme.

**Date** — 30/08/2026

**Contexte** — Préparation des images Docker de production.

**Problème** — `apps/api/package.json` déclarait `main: "dist/main.js"` et
`start:prod: "node dist/main.js"`. Or `nest build` compile un monorepo : la
sortie réelle est `dist/apps/api/src/main.js`, puisque le paquet partagé est
résolu vers ses sources. **Aucun démarrage en production n'aurait fonctionné**,
et rien ne le signalait : les scripts de développement passent par `nest start`,
qui n'utilise pas ce chemin.

**Décision** — Les chemins sont corrigés, `start:prod` n'utilise plus
`dotenv-cli` (en production les variables viennent de l'environnement, pas d'un
fichier), et la CI **démarre réellement l'image** puis interroge `/health/live`.

**Justification** — Un chemin d'entrée faux est le genre de défaut qui ne se
découvre qu'au premier déploiement. Une vérification statique n'aurait rien vu :
seule une exécution réelle le révèle. C'est l'application directe du critère
« vérifié, pas supposé » (§49).

**Impact** — Le démarrage de l'image est désormais un test de la CI. Une
régression sur le chemin d'entrée, la copie des artefacts ou les dépendances
d'exécution échoue au commit, pas au déploiement.

---

## D-033 — Les alertes de stock portent le nom du produit, pas seulement le SKU

**Date** — 30/08/2026

**Contexte** — Écriture de l'écran `/stock`, alimenté par
`GET /inventory/low-stock`.

**Problème** — L'endpoint ne renvoyait que le SKU de la variante. Un commerçant
reconnaît « Robe longue brodée — Rouge / M », pas « ROB-001-M-RGE ». L'alerte
était donc techniquement juste et pratiquement inutilisable.

**Alternative écartée** — *Résoudre les noms côté frontend* : aurait exigé un
second appel et une jointure côté client, avec un écran incomplet le temps du
chargement, pour une donnée que la requête SQL fournit d'une seule jointure.

**Décision** — La requête ajoute une jointure sur `products` et renvoie
`productId`, `productName` et `variantLabel`. Le type `LowStockEntry` étend
`StockSnapshot` et documente pourquoi.

**Impact** — Un appel au lieu de deux, et une alerte lisible sans traduction
mentale. Même raisonnement appliqué au détail d'un retour, où le magasinier
inspecte des produits, pas des identifiants.

---

## D-034 — Ajout de `GET /shipments` et `GET /integrations/google/status`

**Date** — 30/08/2026

**Contexte** — L'écran `/expeditions` exigé par la navigation (§41) et l'écran
`/integrations` n'avaient pas d'endpoint correspondant.

**Problème** — L'API n'exposait les colis que **par commande**
(`GET /orders/:id/shipments`). Or le suivi quotidien se fait par colis : « ce
qui est parti et n'est pas encore arrivé ». De même, rien ne permettait de
savoir si Google était connecté — ni pour la boutique, ni pour l'installation.

**Décision** — Deux endpoints ajoutés :
- `GET /shipments` — liste paginée, filtrable par statut, transporteur et
  recherche, avec le dernier événement connu et la date de dernière
  synchronisation ;
- `GET /integrations/google/status` — distingue explicitement
  `installationConfigured` (l'installation a-t-elle des identifiants OAuth ?) de
  `connected` (cette boutique a-t-elle autorisé l'accès ?). **Aucun jeton n'est
  renvoyé.**

**Justification** — Sans cette distinction, l'interface afficherait un bouton
« Connecter Google » qui échouerait systématiquement sur une installation sans
identifiants OAuth, sans que le commerçant puisse comprendre pourquoi. Il faut
lui dire que le problème n'est pas chez lui (§5).

**Impact** — L'écran des expéditions met en avant les **colis silencieux** —
plus de 48 h sans nouvelle du transporteur — qui sont le vrai signal
d'exploitation. L'écran des intégrations reflète l'état réel de la connexion.

---

## D-035 — Le linter typé a révélé de vrais défauts, corrigés à la source

**Date** — 30/08/2026

**Contexte** — Les scripts `lint` étaient déclarés dans les trois paquets et
référencés dans la CI, mais ESLint n'était pas installé : la commande échouait.
Le pipeline aurait donc été rouge dès le premier déclenchement.

**Décision** — ESLint 9 est installé avec `typescript-eslint` en mode
**typé** (`recommendedTypeChecked`), configuré à la racine en format « flat ».
La sélection des règles suit un principe unique : **ne signaler que ce qui a une
conséquence identifiable**. Une règle bruyante finit désactivée ligne par ligne,
et le linter cesse alors d'être lu — c'est pire que pas de linter du tout.

Sont traités en erreur : `no-floating-promises`, `no-misused-promises`,
`await-thenable`, `no-explicit-any`, `no-base-to-string`,
`no-unsafe-enum-comparison`, `no-unnecessary-type-assertion`. Sont désactivées
les règles `no-unsafe-*` sur les frontières faiblement typées (Prisma, corps de
requête) : les traiter en erreur imposerait des assertions partout, ce qui
donnerait **moins** de sûreté, pas plus.

**Ce que le passage a réellement trouvé** — 91 signalements, dont trois classes
de défauts authentiques :

1. **`[object Object]` dans des textes destinés aux utilisateurs** (27 sites).
   Les gabarits de notification, les messages d'erreur transporteur et l'aperçu
   Google Sheets interpolaient des valeurs `unknown`. Un `p.reason` porté par
   une charge utile JSON structurée se serait affiché « [object Object] » dans
   une notification de suspension de boutique.
   *Correction* — un module `common/utils/text.ts` qui ne convertit que les
   **primitives** et n'aplatit jamais un objet ; l'appelant fournit un repli
   lisible (« motif non communiqué » plutôt qu'une chaîne vide).

2. **Unions qui s'effondrent en `string`** (11 sites). `ErrorCode | string` vaut
   exactement `string` : l'intention (« un code connu, ou un code inconnu d'une
   version future ») disparaissait, avec l'autocomplétion.
   *Correction* — `ErrorCode | (string & {})`, qui préserve les deux.

3. **Gestionnaires `async` passés à `onSubmit`** (5 sites). React attend un
   retour `void` ; un rejet n'aurait été rattaché à rien. Ces fonctions gèrent
   déjà leurs erreurs, mais le contrat de type était faux.
   *Correction* — `onSubmit={(event) => void submit(event)}`, qui rend
   l'intention explicite.

**Impact** — Aucune règle n'a été désactivée pour faire passer le lint : chaque
signalement a été corrigé à la source ou explicitement justifié dans la
configuration. Les 336 tests restent verts après ces corrections.

---

## D-036 — Le CLI Prisma est une dépendance d'exécution, pas de développement

**Date** — 30/08/2026

**Contexte** — L'image de production applique les migrations via un service
dédié (`prisma migrate deploy`) avant que l'API ne démarre.

**Problème** — `prisma` était déclaré en `devDependencies`. L'image de
production, construite avec `npm ci --omit=dev`, ne l'aurait donc pas contenu :
ni `prisma generate` pendant le build, ni `migrate deploy` au déploiement
n'auraient fonctionné. `npx` aurait tenté un téléchargement à la volée —
non déterministe, et impossible dans un réseau fermé.

**Alternative écartée** — *Copier le client généré depuis l'étage de
compilation* : résout `generate`, mais pas `migrate deploy`, qui a besoin du CLI
au moment du déploiement.

**Décision** — `prisma` passe en `dependencies` de `@ecomflow/api`, avec un
commentaire dans le Dockerfile expliquant pourquoi il survit à `--omit=dev`.

**Impact** — Quelques mégaoctets de plus dans l'image, contre la capacité de
migrer sans dépôt source ni accès réseau au registre npm.

---

## D-037 — next-intl en mode NON ROUTÉ pour l'internationalisation

**Date** — 31/08/2026

**Contexte** — Aucun des trois documents sources ne traitait la langue de
l'interface. L'exigence est arrivée en cours de projet : français par défaut,
arabe comme **seconde langue complète**, RTL réel, préférence stockée par
utilisateur.

**Problème** — Deux décisions distinctes se cachaient derrière « quelle
bibliothèque i18n ».

*1. Faut-il une bibliothèque ?* Oui, et pour une raison précise : **l'arabe
possède six formes plurielles** (`zero`, `one`, `two`, `few`, `many`, `other`)
là où le français en a deux. Une implémentation maison produirait
inévitablement du « 3 commande(s) » — acceptable en français, faux en arabe.
Le produit affiche des compteurs partout (files, alertes, lignes en erreur) :
l'accord n'est pas un détail cosmétique.

*2. Faut-il router par la langue ?* **Non.** next-intl s'utilise
habituellement avec un segment d'URL (`/fr/commandes`, `/ar/commandes`). Ce
schéma a été écarté :
- la préférence est portée par l'**utilisateur**, pas par l'adresse ;
- un agent qui envoie le lien d'une commande à un collègue ne doit pas lui
  imposer sa langue au passage ;
- l'URL d'une commande doit rester **identique pour tout le monde**, c'est ce
  qui la rend citable dans un ticket ou un message.

**Alternatives écartées** —
- *`react-i18next`* : équivalent fonctionnellement, mais ICU y est un greffon
  optionnel là où next-intl le fournit nativement, avec le formatage des dates
  et des nombres en `ar-DZ`.
- *Routage par segment d'URL* : casse le partage de liens, pour un bénéfice —
  le référencement multilingue — qui n'a aucun sens dans une application
  interne explicitement désindexée.
- *Traduction maison par dictionnaire plat* : échoue sur les pluriels arabes.

**Décision** — `next-intl` 3.26, utilisé via `NextIntlClientProvider` sans
routage. Catalogues `src/i18n/messages/{fr,ar}.json`, chargés tous les deux
dans le bundle. Étiquette `ar-DZ` et non `ar` : l'arabe algérien s'écrit avec
les **chiffres latins**, là où `ar-EG` afficherait ٠١٢٣, illisibles pour un
commerçant algérien.

**Impact** — Une clé manquante en arabe est un défaut invisible à la
compilation : elle n'apparaîtrait qu'à l'écran d'un utilisateur arabophone,
sous forme de clé brute. Un test (`messages.spec.ts`) verrouille donc la
symétrie des deux catalogues, l'égalité des variables ICU, la présence des six
formes plurielles arabes, et l'absence de français résiduel côté arabe.

---

## D-038 — Trois préférences de langue distinctes, jamais confondues

**Date** — 31/08/2026

**Contexte** — Mise en place de l'i18n et localisation des messages WhatsApp
adressés au client final (Addendum §31).

**Problème** — Il aurait été plus simple de n'avoir qu'un réglage « langue de
la boutique ». Ce raccourci est faux dans le contexte algérien : **un agent
travaille couramment en français tout en écrivant à ses clients en arabe.**
Confondre les deux revient à imposer la langue de l'employé au client — sur un
message dont la langue a un effet direct et mesurable sur le taux de
confirmation.

**Décision** — Trois colonnes distinctes, avec un ordre de priorité explicite :

| Colonne | Ce qu'elle gouverne |
|---|---|
| `users.locale` | La langue de l'**interface** d'un agent. Suit la personne d'un poste à l'autre. |
| `tenant_settings.default_locale` | La langue proposée aux **nouveaux membres**. Ne modifie jamais celle de quelqu'un qui a déjà choisi. |
| `customers.locale` | La langue dans laquelle un **client final** reçoit ses messages. |

`tenant_settings.customer_message_locale` permet en plus à une boutique
d'**imposer** une langue unique à toute sa clientèle. Laissé vide — le défaut —
chaque client est écrit dans sa propre langue.

Résolution pour un message WhatsApp, dans cet ordre : langue imposée par la
boutique → langue connue du client → langue par défaut de la boutique. Le
réglage de la boutique passe **avant** celui du client parce qu'il traduit une
décision commerciale explicite, là où la langue du client peut n'être qu'une
observation.

**Impact** — Une contrainte `CHECK` en base limite les valeurs à `fr` et `ar`.
Sans elle, une valeur comme `en` entrerait silencieusement et l'interface
retomberait sur le français, laissant croire à un bug d'affichage plutôt qu'à
une donnée invalide. Ajouter une langue devient une migration explicite, jamais
un effet de bord d'un formulaire.

---

## D-039 — RTL par propriétés logiques, pas par feuille de style miroir

**Date** — 31/08/2026

**Contexte** — L'arabe doit bénéficier d'un « support RTL réel — pas seulement
la traduction du texte ».

**Problème** — Une interface écrite avec `ml-4` (marge à gauche) et
`text-right` reste visuellement française même traduite : le texte arabe
s'affiche à droite, mais la mise en page continue de pointer à gauche. Les
marges, les puces, les colonnes et la barre latérale tombent du mauvais côté.

**Alternatives écartées** —
- *`rtlcss` ou une feuille miroir générée* : produit deux CSS à maintenir, et
  chaque nouveau composant risque d'être oublié dans la version miroir.
- *Un `dir="rtl"` sur un conteneur interne* : ne retourne ni les barres de
  défilement, ni les menus natifs du navigateur.

**Décision** — Conversion complète vers les **propriétés logiques** de
Tailwind : `ms-`/`me-` au lieu de `ml-`/`mr-`, `ps-`/`pe-`, `text-start`/
`text-end`, `start-`/`end-`, `border-s`/`border-e`. 107 occurrences converties
dans 18 fichiers. `dir` et `lang` sont posés sur `<html>`, seul endroit qui
retourne réellement la page.

Une seule exception subsiste : `translate-x`, qui n'a pas d'équivalent logique.
Le tiroir de navigation mobile utilise donc `-translate-x-full
rtl:translate-x-full` — le signe est inversé explicitement, avec un commentaire
qui dit pourquoi.

**Impact** — Un seul jeu de classes pour les deux langues. Un composant écrit
avec des propriétés logiques est correct en RTL **sans effort supplémentaire**,
ce qui est la seule façon que le support arabe ne se dégrade pas au fil des
évolutions.

---

## D-040 — La langue est mise en cache dans un cookie, la base reste l'autorité

**Date** — 31/08/2026

**Contexte** — La préférence vit dans `users.locale`, côté serveur, et n'est
connue qu'après l'appel à `/tenants/current`.

**Problème** — Sans anticipation, un utilisateur arabophone verrait la page
s'afficher en français aligné à gauche, puis **basculer entièrement** une fois
la session chargée. En RTL, ce n'est pas un simple changement de texte : c'est
toute la mise en page qui se retourne, plusieurs centaines de millisecondes
après le premier rendu.

**Décision** — Un cookie `ecomflow_locale` (non `HttpOnly`, un an, `SameSite=Lax`)
mémorise la langue. La disposition racine le lit **côté serveur** et rend
directement `<html lang="ar" dir="rtl">`. Le cookie ne contient qu'un code de
langue sur deux caractères : aucune donnée sensible.

Le cookie est un **cache**, jamais une autorité. Dès que la session est chargée,
la valeur du serveur s'impose — mais **une seule fois par session**, sinon un
rechargement écraserait le choix que l'utilisateur vient de faire.

**Impact** — Aucun clignotement. Le sélecteur de langue est également
disponible **avant** toute connexion : sans session, seul le cookie est écrit,
ce qui permet à un arabophone de lire l'écran de connexion dans sa langue.

---

## D-041 — Le jeu de données de démonstration est refusé en production par le code

**Date** — 31/08/2026

**Contexte** — La base est vide après installation. Un jeu de données réaliste
est nécessaire pour que le tableau de bord, la file de confirmation et le score
de fiabilité aient quelque chose à afficher.

**Problème** — Les comptes de démonstration ont un **mot de passe publié dans
ce dépôt et dans le README**. Les créer sur une installation de production
ouvrirait un accès connu de tous à une boutique réelle, aux côtés de vraies
données clients. Le drapeau `--with-demo` est explicite, mais une erreur de
manipulation ne doit pas suffire à provoquer cela.

**Décision** — `runSeed` refuse d'installer la démonstration lorsque
`NODE_ENV=production`, avec un message qui explique pourquoi. **Aucune variable
d'échappement n'existe** : il n'y a aucun cas légitime, une démonstration se
fait sur un environnement dédié.

Le garde-fou vise la démonstration, **pas** l'amorçage : une production a besoin
de ses permissions, de ses plans et de ses transporteurs. `npm run seed` reste
donc parfaitement utilisable en production.

**Ce que le jeu couvre** — 10 clients répartis sur 10 wilayas, avec des langues
mêlées (français, arabe, et sans préférence, pour exercer les trois branches de
résolution) ; 3 produits dont un à plusieurs déclinaisons, tous avec un prix
d'achat ; 19 commandes couvrant **les 15 statuts du workflow** ; 3 rôles
réellement occupés.

**Impact** — Un test d'intégration exécute le seed contre un vrai PostgreSQL et
vérifie la couverture des statuts, la cohérence des compteurs client,
l'idempotence du rejeu et le refus en production. Un seed cassé échoue en CI,
pas sur le poste d'un nouvel arrivant.

---

## D-042 — L'API se compile contre les *artefacts* du paquet partagé, pas contre ses sources

**Date** — 31/08/2026
**Remplace D-032**, qui contournait le symptôme au lieu de traiter la cause.

**Contexte** — `npm run start:dev` échouait dès le premier lancement avec
`Cannot find module '…/apps/api/dist/main'`.

**Diagnostic — deux causes distinctes, empilées.**

*1. La sortie ne se trouvait pas là où le CLI Nest la cherche.*
`apps/api/tsconfig.json` fait pointer `@ecomflow/shared` vers ses **sources**
TypeScript. Excellent pour l'outillage — Jest, ts-node et l'éditeur voient les
modifications du paquet partagé sans étape de compilation — mais à la
compilation cela fait entrer des fichiers situés **hors de `apps/api`** dans
l'unité de compilation. TypeScript calcule alors la racine commune à tous les
fichiers d'entrée — la racine du monorepo — et reproduit cette arborescence :

```
dist/apps/api/src/main.js       au lieu de       dist/main.js
dist/packages/shared/src/...
```

Or le CLI Nest lance `dist/<entryFile>.js`, soit `dist/main.js`.

*2. Le cache incrémental survivait à la suppression de `dist`.*
`tsconfig.build.tsbuildinfo` était écrit **à la racine de `apps/api`**, hors du
dossier de sortie. Supprimer `dist` — ce que fait `deleteOutDir: true` à chaque
`nest start` — n'invalidait donc pas ce cache. TypeScript concluait « rien n'a
changé », **n'émettait aucun fichier**, et affichait sereinement
`Found 0 errors`. Une compilation qui réussit sans rien produire : le symptôme
est particulièrement trompeur, et ce défaut aurait frappé n'importe qui
supprimant `dist` à la main, indépendamment du premier problème.

**Décision** —

1. `apps/api/tsconfig.build.json` redéfinit `paths` **sans** le mapping vers les
   sources du paquet partagé. `@ecomflow/shared` est alors résolu par
   node_modules, c'est-à-dire vers `packages/shared/dist` via le lien des
   workspaces npm. Tous les fichiers d'entrée vivent sous `apps/api/src`,
   `rootDir` vaut `src`, et la sortie est `dist/main.js`.
2. `include` est restreint à `src/**/*` : `prisma/` et `scripts/` sont de
   l'outillage et n'ont rien à faire dans l'artefact de production.
3. `tsBuildInfoFile` pointe explicitement **dans `dist`**, dans les deux
   configurations. Le cache disparaît désormais en même temps que les fichiers
   qu'il décrit.
4. `build` et `start:dev` de l'API compilent d'abord `@ecomflow/shared`, dont
   elles dépendent maintenant sous forme compilée.

**Ce que D-032 avait fait, et pourquoi c'était insuffisant** — D-032 avait
constaté la sortie en `dist/apps/api/src/main.js` et **aligné les chemins
dessus** (`main`, `start`, `start:prod`, `CMD` du Dockerfile). La production
démarrait, ce que la CI vérifiait. Mais `nest start` et `nest start --watch` —
qui déduisent l'entrée de `nest-cli.json` et non de `package.json` — restaient
cassés. Le développement local était donc inutilisable alors que la production
fonctionnait : exactement le genre d'écart qu'un test de démarrage d'image ne
révèle pas.

**Compromis assumé** — Le paquet partagé doit être compilé avant l'API. Les
scripts s'en chargent, au prix de quelques secondes au premier lancement. Pour
travailler simultanément sur les deux, `npm run dev:shared` (mode veille) dans
un second terminal recompile à la volée.

**Impact** — `npm run dev:api` fonctionne du premier coup sur une copie fraîche,
vérifié : `dist/main.js` produit, Nest démarré, `/health/live` répond `200`. Le
build est désormais **reproductible** — deux `nest build` successifs après
`rm -rf dist` produisent le même artefact, ce qui n'était plus le cas.

---

---

*Ce journal est mis à jour à chaque décision structurante. Les entrées ne sont
jamais supprimées : une décision revenue sur est marquée « remplacée par D-XXX »
avec sa justification, afin que l'historique du raisonnement reste lisible.*
