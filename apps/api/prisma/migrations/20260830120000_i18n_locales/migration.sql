-- =============================================================================
-- Internationalisation francais / arabe
--
-- Trois preferences de langue DISTINCTES, et c'est volontaire :
--
--   users.locale                      langue de l'INTERFACE pour un agent.
--                                     Existait deja.
--   tenant_settings.default_locale    langue proposee aux NOUVEAUX membres de
--                                     la boutique. Un utilisateur garde
--                                     toujours la main sur la sienne.
--   customers.locale                  langue dans laquelle un CLIENT FINAL
--                                     recoit ses messages WhatsApp.
--
-- Confondre la deuxieme et la troisieme reviendrait a imposer la langue de
-- l'employe au client. En Algerie, un agent travaille couramment en francais
-- tout en ecrivant a ses clients en arabe : la langue du message a un effet
-- direct sur le taux de confirmation (Addendum §31).
--
-- `tenant_settings.customer_message_locale` permet a une boutique de FORCER une
-- langue unique pour tous ses clients. Laisse a NULL — le defaut — chaque
-- client est ecrit dans SA langue, ce qui est le meilleur comportement.
-- =============================================================================

-- --- Boutique ---------------------------------------------------------------
ALTER TABLE "tenant_settings"
  ADD COLUMN "default_locale" TEXT NOT NULL DEFAULT 'fr',
  ADD COLUMN "customer_message_locale" TEXT;

-- --- Client final -----------------------------------------------------------
ALTER TABLE "customers"
  ADD COLUMN "locale" TEXT;

-- =============================================================================
-- Integrite : seules les langues reellement prises en charge sont acceptees.
--
-- Sans ces contraintes, une valeur comme 'en' entrerait en base et l'interface
-- retomberait silencieusement sur le francais, laissant croire a un bug
-- d'affichage plutot qu'a une donnee invalide. Le refus au niveau du moteur
-- rend l'erreur immediate et localisable.
--
-- La liste est volontairement figee dans la contrainte : ajouter une langue est
-- une decision produit qui exige une migration explicite, jamais un effet de
-- bord d'un formulaire.
-- =============================================================================
ALTER TABLE "users"
  ADD CONSTRAINT "users_locale_supported_chk"
  CHECK ("locale" IN ('fr', 'ar'));

ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_default_locale_supported_chk"
  CHECK ("default_locale" IN ('fr', 'ar'));

ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_customer_locale_supported_chk"
  CHECK ("customer_message_locale" IS NULL OR "customer_message_locale" IN ('fr', 'ar'));

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_locale_supported_chk"
  CHECK ("locale" IS NULL OR "locale" IN ('fr', 'ar'));
