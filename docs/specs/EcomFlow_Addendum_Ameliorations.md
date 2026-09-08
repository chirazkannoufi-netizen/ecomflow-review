# EcomFlow — Addendum : propositions d'amélioration

**Complément au Cahier des charges v1.0 (29 août 2026)**

Ce document propose des ajouts fonctionnels destinés à renforcer le positionnement d'EcomFlow face à Ecomanager et aux autres acteurs du marché algérien (Shipper, DropDz). La numérotation reprend celle du document principal à partir de la section 31.

**Statut de synchronisation avec la V2** : la V2 du cahier des charges (29 août 2026) est une extension technique et architecturale de la V1 — schéma de base de données, endpoints API, connecteurs, tests, déploiement. Aucune des propositions ci-dessous (31 à 39) n'y est encore intégrée à ce jour ; ce document reste à fusionner avec la V2 avant le début de l'implémentation.

---

## 31. Confirmation semi-automatisée via WhatsApp

**Principe** : réduire la charge du centre d'appel en filtrant automatiquement les commandes faciles à confirmer, avant toute intervention humaine.

- Dès qu'une commande passe au statut **À CONFIRMER**, EcomFlow envoie automatiquement un message WhatsApp (WhatsApp Business Cloud API) au client : récapitulatif de la commande (produit, quantité, prix, adresse) accompagné de boutons interactifs **Confirmer / Modifier / Annuler**.
- **Confirmer** → passage direct au statut **CONFIRMÉE**, sans passage par la file d'appel manuelle.
- **Modifier** → échange court pour ajuster l'adresse ou la quantité, ou bascule vers un agent si la demande est complexe.
- **Annuler** → passage au statut **ANNULÉE**, motif « refus client ».
- **Absence de réponse** après un délai configurable (2 à 4h par défaut) → retour automatique dans la file d'appel classique. Le canal WhatsApp est un premier filtre, jamais un point de perte de commande.
- Nouveau champ sur la commande : **canal de confirmation** (`whatsapp_auto` / `agent_humain`), exploitable dans le dashboard pour mesurer le taux d'adoption et l'impact réel sur la charge du centre d'appel.

## 32. Score de fiabilité client et priorisation intelligente

**Objectif** : s'attaquer directement au problème central du COD en Algérie — les commandes non livrées et les refus, qui pèsent lourdement sur le chiffre d'affaires de la plupart des e-commerçants.

- Historiser par numéro de téléphone : nombre de commandes, taux de confirmation, taux de livraison réussie, nombre de refus consécutifs.
- Calculer un indicateur simple par client : fiable / à surveiller / à risque.
- Utiliser ce score pour prioriser la file de confirmation (traiter les clients fiables en premier) et pour déclencher, en option, une règle métier plus stricte sur les clients à risque (confirmation WhatsApp obligatoire, acompte demandé, validation manager avant expédition).
- Seuils configurables par boutique, le niveau de risque acceptable variant selon le secteur et la marge produit.

## 33. Tableau de bord Pertes & Rentabilité

**Objectif** : rendre visible, en un coup d'œil, l'argent perdu sur les livraisons échouées et les retours — aujourd'hui dilué dans les KPIs généraux de la section 16.

- Vue dédiée : montant estimé perdu (commandes annulées et retournées, valorisées au prix de vente), comparé au chiffre d'affaires confirmé sur la période.
- Répartition par wilaya, transporteur, agent et source, pour isoler les points de fuite.
- Alertes automatiques configurables lorsqu'un taux (retour, refus, échec de livraison) dépasse un seuil défini.

## 34. Assistant d'onboarding sans développeur

**Objectif** : aligner EcomFlow sur l'attente du marché, où l'intégration sans intervention technique côté commerçant est un standard.

- Parcours guidé en 4 étapes à la création d'une boutique : connexion Google Sheets → mapping des colonnes → choix du ou des transporteurs → activation optionnelle de la confirmation WhatsApp.
- À l'issue du parcours, la boutique doit être en mesure de recevoir sa première commande réelle sans support technique externe.

## 35. Paiement d'abonnement — options adaptées au contexte algérien

Le document v1.0 définit le mécanisme d'expiration et de réactivation de l'abonnement (section 21) sans fixer le moyen de paiement réel — un point bloquant pour la mise en production, l'essai gratuit de 7 jours devant déboucher sur un paiement fonctionnel.

Deux options complémentaires :

- **Paiement automatisé** : intégration de Chargily Pay, passerelle algérienne proposant une API développeur gratuite acceptant les cartes CIB et Edahabia, sans passage par un contrat bancaire direct avec la SATIM.
- **Paiement manuel (fallback MVP)** : virement ou BaridiMob, avec upload d'un justificatif par le commerçant et file de validation pour le Super Admin — formalise en statut explicite (« paiement en attente de vérification ») la remarque déjà présente dans le document sur les captures d'écran non probantes.

## 36. Notifications critiques multicanales

- Réutiliser la connexion WhatsApp Business mise en place pour la confirmation (section 31) pour les alertes à fort enjeu : essai qui expire (J-3, J-1), échec de paiement, panne d'intégration transporteur.
- Vient en complément des canaux email et in-app déjà prévus en section 18, sans les remplacer.

## 37. Conformité — protection des données personnelles

EcomFlow centralise des données clients (nom, téléphone, adresse) pour de nombreuses boutiques : la plateforme entre dans le champ de la loi n° 18-07 du 10 juin 2018, modifiée par la loi n° 25-11 du 24 juillet 2025, relative à la protection des personnes physiques dans le traitement des données à caractère personnel, sous supervision de l'ANPDP.

- Prévoir une base légale claire pour la collecte de données (traitement de la commande) et une politique de confidentialité accessible aux clients finaux.
- Les mesures déjà prévues en section 23 (chiffrement, isolation multi-tenant, journalisation) couvrent une large part des exigences techniques.
- Une déclaration auprès de l'ANPDP peut être nécessaire selon le volume et la nature des données traitées, à confirmer avant le lancement commercial.

## 38. Prévention de l'abus du Trial

**Problème identifié** : ni la V1 (section 21) ni la V2 (section 7) n'empêchent un vendeur de créer une nouvelle boutique tous les 7 jours pour rester indéfiniment en essai gratuit sans jamais payer.

- Lier chaque Trial à un identifiant vérifié et difficile à dupliquer : numéro de téléphone confirmé par OTP (SMS ou WhatsApp), unique par tenant.
- Détecter la création de plusieurs boutiques par le même numéro, la même adresse email ou un signal technique commun (IP, empreinte appareil) sur une fenêtre de temps courte.
- Bloquer automatiquement un nouveau Trial pour un identifiant déjà utilisé, ou le basculer vers une file de revue manuelle du Super Admin plutôt qu'une activation directe.
- Journaliser ces tentatives dans l'audit log (V2 section 23) pour affiner les règles dans le temps.

## 39. Anticipation des quotas Google Sheets API

**Problème identifié** : l'API Google Sheets applique des quotas stricts par projet (lectures/écritures par minute). Le modèle actuel (V2 sections 12 et 29) prévoit une synchronisation périodique par boutique sans stratégie de montée en charge.

- Répartir (stagger) les jobs de synchronisation dans le temps plutôt que de déclencher toutes les boutiques au même instant.
- Traiter les synchronisations par lots via une file d'attente plutôt que des appels directs et bloquants.
- Implémenter un backoff exponentiel et une reprise automatique en cas d'erreur de quota (HTTP 429).
- Anticiper, au-delà d'un certain nombre de boutiques actives, une demande d'augmentation de quota auprès de Google ou une architecture à plusieurs projets Google Cloud.

---

## Priorisation suggérée

| Ajout | Phase | Statut V2 |
|---|---|---|
| Confirmation WhatsApp (31) | MVP — principal levier de différenciation face à Ecomanager | Non intégré |
| Paiement d'abonnement (35) | MVP — bloquant pour que l'essai de 7 jours ait un débouché réel | Non intégré |
| Prévention de l'abus du Trial (38) | MVP — sans cela, le modèle d'abonnement est contournable dès le lancement | Nouveau — absent de V1 et V2 |
| Assistant d'onboarding (34) | MVP, version simplifiée | Non intégré |
| Score de fiabilité (32) | Post-MVP proche — une version simple (compteur de refus) est exploitable dès le départ | Non intégré |
| Dashboard Pertes & Rentabilité (33) | Post-MVP proche | Non intégré |
| Quotas Google Sheets API (39) | Post-MVP proche — à traiter avant la montée en charge | Nouveau — absent de V1 et V2 |
| Notifications multicanales (36) | Phase 2 | Non intégré |
| Conformité loi 18-07 (37) | En parallèle, dès la collecte des premières données réelles | Non intégré |
