/**
 * Messages WhatsApp adresses au CLIENT FINAL — Addendum §31.
 *
 * POURQUOI CES TEXTES SONT ICI, ET NON DANS LA PASSERELLE
 *
 *   1. CE SONT DES REGLES METIER, PAS DE LA PLOMBERIE. La formulation d'une
 *      demande de confirmation a un effet direct et mesurable sur le taux de
 *      reponse. Elle merite d'etre versionnee, relue et TESTEE comme une regle
 *      metier, pas enfouie dans un client HTTP.
 *
 *   2. ELLES SE TESTENT SANS INFRASTRUCTURE. Verifier qu'un message arabe ne
 *      contient aucun mot francais residuel ne doit demander ni reseau, ni base
 *      de donnees, ni jeton Meta.
 *
 * LA LANGUE EST CELLE DU CLIENT, PAS CELLE DE L'AGENT
 *   Un agent peut travailler en francais et ecrire a un client en arabe : c'est
 *   le cas courant en Algerie. Imposer la langue de l'employe au client serait
 *   un contresens commercial.
 *
 * TRADUCTION, PAS TRANSLITTERATION
 *   La version arabe est ecrite en arabe standard moderne, comprehensible dans
 *   toute l'Algerie. Elle n'est pas une transposition mot a mot du francais :
 *   la formule de politesse et l'ordre de l'information suivent l'usage
 *   arabophone.
 *
 * LES BOUTONS SONT COURTS PAR CONTRAINTE
 *   WhatsApp limite le libelle d'un bouton interactif a 20 caracteres. Les
 *   libelles ci-dessous respectent cette limite dans les deux langues, ce qu'un
 *   test verifie explicitement : un libelle trop long fait rejeter le message
 *   entier par l'API Meta, et le client ne recoit alors RIEN.
 */

import { DEFAULT_LOCALE, type Locale } from './locale';

/** Limite imposee par l'API WhatsApp Cloud sur un libelle de bouton. */
export const WHATSAPP_BUTTON_TITLE_MAX_LENGTH = 20;

export interface OrderConfirmationContent {
  /** Nom du client, tel qu'il figure sur la commande. */
  readonly customerName: string;
  readonly orderReference: string;
  readonly storeName: string;
  readonly productSummary: string;
  readonly quantity: number;
  /** Montant deja formate dans la langue cible. */
  readonly totalLabel: string;
  readonly addressLabel: string;
}

export interface WhatsappButtonLabels {
  readonly confirm: string;
  readonly modify: string;
  readonly cancel: string;
}

interface LocalePack {
  readonly orderConfirmation: (content: OrderConfirmationContent) => string;
  readonly buttons: WhatsappButtonLabels;
  readonly verificationCode: (code: string) => string;
  /** Enveloppe d'une notification interne relayee au commercant. */
  readonly notification: (title: string, body: string) => string;
}

const FRENCH: LocalePack = {
  orderConfirmation: (c) =>
    [
      `Bonjour ${c.customerName},`,
      '',
      `Votre commande ${c.orderReference} chez ${c.storeName} :`,
      `• ${c.productSummary} (x${c.quantity})`,
      `• Total : ${c.totalLabel}`,
      `• Livraison : ${c.addressLabel}`,
      '',
      'Merci de confirmer pour que nous puissions preparer votre colis.',
    ].join('\n'),
  buttons: {
    confirm: 'Confirmer',
    modify: 'Modifier',
    cancel: 'Annuler',
  },
  verificationCode: (code) =>
    `Votre code de verification EcomFlow est : ${code}\n` +
    'Il expire dans quelques minutes. Ne le communiquez a personne.',
  notification: (title, body) => `${title}\n\n${body}`,
};

const ARABIC: LocalePack = {
  orderConfirmation: (c) =>
    [
      `مرحبا ${c.customerName}،`,
      '',
      `طلبكم رقم ${c.orderReference} لدى ${c.storeName}:`,
      `• ${c.productSummary} (×${c.quantity})`,
      `• المجموع: ${c.totalLabel}`,
      `• التوصيل: ${c.addressLabel}`,
      '',
      'يرجى التأكيد حتى نتمكن من تحضير طلبكم.',
    ].join('\n'),
  buttons: {
    confirm: 'تأكيد',
    modify: 'تعديل',
    cancel: 'إلغاء',
  },
  verificationCode: (code) =>
    `رمز التحقق الخاص بكم في EcomFlow هو: ${code}\n` +
    'ينتهي خلال دقائق. لا تشاركوه مع أي شخص.',
  notification: (title, body) => `${title}\n\n${body}`,
};

const PACKS: Record<Locale, LocalePack> = {
  fr: FRENCH,
  ar: ARABIC,
};

function pack(locale: Locale | null | undefined): LocalePack {
  return PACKS[locale ?? DEFAULT_LOCALE] ?? PACKS[DEFAULT_LOCALE];
}

/** Corps de la demande de confirmation de commande. */
export function orderConfirmationBody(
  locale: Locale | null | undefined,
  content: OrderConfirmationContent,
): string {
  return pack(locale).orderConfirmation(content);
}

/** Libelles des trois boutons interactifs, dans la langue du client. */
export function whatsappButtonLabels(locale: Locale | null | undefined): WhatsappButtonLabels {
  return pack(locale).buttons;
}

/** Message portant un code de verification a usage unique. */
export function verificationCodeBody(
  locale: Locale | null | undefined,
  code: string,
): string {
  return pack(locale).verificationCode(code);
}

/** Notification interne relayee sur WhatsApp au commercant. */
export function notificationBody(
  locale: Locale | null | undefined,
  title: string,
  body: string,
): string {
  return pack(locale).notification(title, body);
}
