-- =============================================================================
-- « Non verifie » : le troisieme etat d'integration, et la raison qui va avec
--
-- CE QUE DEUX ETATS NE SAVAIENT PAS DIRE
--   `implementation_status` connaissait AVAILABLE et PLANNED. Le premier
--   autorise a expedier ET fait afficher les capacites comme acquises ; le
--   second refuse tout. Entre les deux, rien.
--
--   Or un adaptateur ecrit d'apres un SDK communautaire — et non d'apres la
--   documentation du transporteur — est exactement entre les deux : il existe,
--   il peut tourner, mais aucune de ses lignes n'a ete confrontee a un vrai
--   compte marchand. Le declarer AVAILABLE promettrait une parite jamais
--   verifiee (D-066) ; le laisser PLANNED le rendrait inutilisable.
--
--   ET LE PIEGE EST CIRCULAIRE : verifier un adaptateur exige de le faire
--   tourner contre un compte reel, ce que PLANNED interdit. Sans etat
--   intermediaire, aucun transporteur ajoute apres Yalidine ne pourrait jamais
--   devenir verifie. C'est la meme impasse que D-068 avait trouvee sur
--   `PENDING_SETUP`, et elle se referme de la meme facon : l'etat « on ne sait
--   pas encore » doit etre TRAVERSABLE.
--
--   UNVERIFIED est donc selectionnable, et ses capacites restent DECLAREES.
--
-- POURQUOI UN CODE, ET NON UNE PHRASE
--   « Pourquoi ce transporteur n'est-il pas disponible ? » n'a pas une seule
--   reponse : pour Maystro la documentation reste a demander, pour ZR Express
--   v3 c'est l'adressage par UUID qui manque. Deux situations, deux gestes
--   suivants differents, que le meme statut PLANNED confondait.
--
--   La colonne porte un CODE et non le texte : une phrase ecrite ici serait
--   francaise pour toujours, alors que l'arabe est une seconde langue complete
--   de ce produit et non une traduction partielle. La traduction vit donc dans
--   les catalogues de messages, comme tout le reste.
--
-- AUCUNE CONTRAINTE CHECK
--   `implementation_status` n'en a jamais eu — c'est une colonne texte dont les
--   valeurs sont tenues par le seed et par le type partage. En ajouter une
--   maintenant ferait echouer la migration sur toute base portant une valeur
--   plus recente que le code deploye, ce qui est exactement l'inverse du
--   service rendu.
-- =============================================================================

ALTER TABLE "carriers"
  ADD COLUMN "source_note" TEXT;

-- Les transporteurs deja en base gardent leur etat : Yalidine reste verifie,
-- et les entrees PLANNED existantes recoivent leur raison au prochain seed.
COMMENT ON COLUMN "carriers"."source_note" IS
  'Code stable traduit a l''ecran : THIRD_PARTY_SOURCES, DOCUMENTATION_REQUESTED, ADDRESSING_REWORK.';
