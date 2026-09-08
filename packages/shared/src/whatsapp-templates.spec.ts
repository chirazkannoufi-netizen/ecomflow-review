/**
 * Ces tests protegent deux choses qu'aucun test d'integration ne verrait :
 *
 *   - qu'un message arabe est REELLEMENT en arabe, sans residu francais laisse
 *     par un copier-coller ;
 *   - qu'un libelle de bouton respecte la limite de 20 caracteres de l'API
 *     WhatsApp. Un libelle trop long fait rejeter le message ENTIER par Meta :
 *     le client ne recoit alors rien du tout, et la commande dort dans la file.
 */

import { LOCALES } from './locale';
import {
  WHATSAPP_BUTTON_TITLE_MAX_LENGTH,
  notificationBody,
  orderConfirmationBody,
  verificationCodeBody,
  whatsappButtonLabels,
  type OrderConfirmationContent,
} from './whatsapp-templates';

const CONTENT: OrderConfirmationContent = {
  customerName: 'Sara Benali',
  orderReference: 'CMD-2026-000123',
  storeName: 'Boutique Sara',
  productSummary: 'Robe longue brodee',
  quantity: 2,
  totalLabel: '9 500,00 DA',
  addressLabel: 'Bab Ezzouar, Alger',
};

/** Plage Unicode de l'ecriture arabe. */
const ARABIC_SCRIPT = /[؀-ۿ]/;
/** Mots francais qui trahiraient une traduction incomplete. */
const FRENCH_WORDS = /\b(Bonjour|Votre|commande|Total|Livraison|Merci|confirmer|code)\b/i;

describe('modeles de messages WhatsApp', () => {
  describe('demande de confirmation', () => {
    it('reprend toutes les informations de la commande, dans les deux langues', () => {
      for (const locale of LOCALES) {
        const body = orderConfirmationBody(locale, CONTENT);

        expect(body).toContain(CONTENT.customerName);
        expect(body).toContain(CONTENT.orderReference);
        expect(body).toContain(CONTENT.storeName);
        expect(body).toContain(CONTENT.productSummary);
        expect(body).toContain(CONTENT.totalLabel);
        expect(body).toContain(CONTENT.addressLabel);
        expect(body).toContain(String(CONTENT.quantity));
      }
    });

    it('produit un message reellement arabe, sans residu francais', () => {
      const body = orderConfirmationBody('ar', CONTENT);

      expect(body).toMatch(ARABIC_SCRIPT);
      // Le nom du client et la reference restent tels quels : ce sont des
      // donnees, pas du texte a traduire. On teste donc le reste.
      const withoutData = body
        .replace(CONTENT.customerName, '')
        .replace(CONTENT.orderReference, '')
        .replace(CONTENT.storeName, '')
        .replace(CONTENT.productSummary, '')
        .replace(CONTENT.totalLabel, '')
        .replace(CONTENT.addressLabel, '');
      expect(withoutData).not.toMatch(FRENCH_WORDS);
    });

    it('produit un message francais sans caractere arabe', () => {
      expect(orderConfirmationBody('fr', CONTENT)).not.toMatch(ARABIC_SCRIPT);
    });

    it('retombe sur le francais pour une langue absente', () => {
      // Un client dont la langue n'a jamais ete renseignee doit tout de meme
      // recevoir son message.
      expect(orderConfirmationBody(null, CONTENT)).toBe(orderConfirmationBody('fr', CONTENT));
      expect(orderConfirmationBody(undefined, CONTENT)).toBe(
        orderConfirmationBody('fr', CONTENT),
      );
    });

    it('donne deux messages differents selon la langue', () => {
      expect(orderConfirmationBody('ar', CONTENT)).not.toBe(
        orderConfirmationBody('fr', CONTENT),
      );
    });
  });

  describe('boutons interactifs', () => {
    it('respecte la limite de 20 caracteres imposee par Meta', () => {
      for (const locale of LOCALES) {
        const labels = whatsappButtonLabels(locale);
        for (const label of Object.values(labels)) {
          expect(label.length).toBeGreaterThan(0);
          expect(label.length).toBeLessThanOrEqual(WHATSAPP_BUTTON_TITLE_MAX_LENGTH);
        }
      }
    });

    it('propose trois libelles distincts par langue', () => {
      for (const locale of LOCALES) {
        const { confirm, modify, cancel } = whatsappButtonLabels(locale);
        expect(new Set([confirm, modify, cancel]).size).toBe(3);
      }
    });

    it('traduit reellement les boutons en arabe', () => {
      const labels = whatsappButtonLabels('ar');

      expect(labels.confirm).toMatch(ARABIC_SCRIPT);
      expect(labels.modify).toMatch(ARABIC_SCRIPT);
      expect(labels.cancel).toMatch(ARABIC_SCRIPT);
    });
  });

  describe('code de verification', () => {
    it('contient le code dans les deux langues', () => {
      for (const locale of LOCALES) {
        expect(verificationCodeBody(locale, '123456')).toContain('123456');
      }
    });

    it('est traduit en arabe', () => {
      const body = verificationCodeBody('ar', '123456');

      expect(body).toMatch(ARABIC_SCRIPT);
      expect(body.replace('123456', '')).not.toMatch(FRENCH_WORDS);
    });

    it('rappelle de ne pas partager le code, dans les deux langues', () => {
      // Consigne de securite : elle perd tout effet si elle n'est pas comprise.
      expect(verificationCodeBody('fr', '000000')).toMatch(/communiquez/i);
      expect(verificationCodeBody('ar', '000000')).toMatch(/تشاركوه/);
    });
  });

  describe('notification relayee', () => {
    it('conserve le titre et le corps fournis', () => {
      const body = notificationBody('ar', 'Titre', 'Corps du message');

      expect(body).toContain('Titre');
      expect(body).toContain('Corps du message');
    });
  });
});
