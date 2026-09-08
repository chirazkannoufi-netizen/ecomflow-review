/**
 * Detection des commandes potentiellement dupliquees — V1 §15, V2 §19.
 *
 * REGLE ABSOLUE : ce module SIGNALE, il ne supprime jamais. La decision finale
 * (conserver / fusionner / annuler) appartient a un utilisateur disposant de la
 * permission `orders.merge_duplicates`.
 *
 * A ne pas confondre avec l'IDEMPOTENCE (reference.ts) :
 *  - l'idempotence empeche techniquement la RECREATION de la meme ligne source ;
 *  - la detection de doublons signale deux commandes DIFFERENTES au sens
 *    technique mais probablement identiques au sens metier (le client a passe
 *    deux fois la meme commande, ou le commercant a ressaisi la ligne).
 */

export interface DuplicateCandidateInput {
  readonly orderId: string;
  readonly phoneNormalized: string | null;
  readonly customerNameNormalized: string | null;
  readonly wilayaCode: number | null;
  readonly addressNormalized: string | null;
  /** SKUs des lignes, tries, pour comparaison ensembliste. */
  readonly skus: readonly string[];
  readonly totalCentimes: number;
  readonly createdAt: Date;
}

export interface DuplicateRule {
  readonly code: DuplicateRuleCode;
  readonly label: string;
  readonly weight: number;
}

export const DUPLICATE_RULE_CODES = [
  'SAME_PHONE',
  'SAME_PRODUCTS',
  'SAME_TOTAL',
  'SAME_ADDRESS',
  'SAME_WILAYA',
  'SAME_CUSTOMER_NAME',
  'WITHIN_TIME_WINDOW',
] as const;
export type DuplicateRuleCode = (typeof DUPLICATE_RULE_CODES)[number];

export const DUPLICATE_RULES: Record<DuplicateRuleCode, DuplicateRule> = {
  SAME_PHONE: { code: 'SAME_PHONE', label: 'Meme numero de telephone', weight: 40 },
  SAME_PRODUCTS: { code: 'SAME_PRODUCTS', label: 'Memes produits', weight: 25 },
  SAME_TOTAL: { code: 'SAME_TOTAL', label: 'Meme montant total', weight: 10 },
  SAME_ADDRESS: { code: 'SAME_ADDRESS', label: 'Meme adresse', weight: 15 },
  SAME_WILAYA: { code: 'SAME_WILAYA', label: 'Meme wilaya', weight: 5 },
  SAME_CUSTOMER_NAME: { code: 'SAME_CUSTOMER_NAME', label: 'Meme nom client', weight: 10 },
  WITHIN_TIME_WINDOW: { code: 'WITHIN_TIME_WINDOW', label: 'Ecart de temps court', weight: 15 },
};

export interface DuplicateDetectionPolicy {
  /** Fenetre temporelle de comparaison, en heures. */
  readonly windowHours: number;
  /** Score a partir duquel une alerte est levee. */
  readonly alertThreshold: number;
  /** Score a partir duquel la commande est marquee « tres probable ». */
  readonly highConfidenceThreshold: number;
}

export const DEFAULT_DUPLICATE_POLICY: DuplicateDetectionPolicy = {
  windowHours: 48,
  alertThreshold: 65,
  highConfidenceThreshold: 85,
};

export type DuplicateConfidence = 'NONE' | 'POSSIBLE' | 'LIKELY';

export interface DuplicateMatch {
  readonly candidateOrderId: string;
  readonly score: number;
  readonly confidence: DuplicateConfidence;
  readonly matchedRules: readonly DuplicateRuleCode[];
  readonly explanation: readonly string[];
}

function sameSkuSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((sku, index) => sku === sortedB[index]);
}

/**
 * Compare une commande a un candidat et retourne un score de similarite.
 *
 * Le telephone est le signal dominant : sans telephone identique, le score ne
 * peut pas atteindre le seuil d'alerte par defaut. C'est volontaire — deux
 * clients distincts d'une meme wilaya commandant le meme produit ne doivent
 * jamais etre signales comme doublon.
 */
export function scoreDuplicate(
  subject: DuplicateCandidateInput,
  candidate: DuplicateCandidateInput,
  policy: DuplicateDetectionPolicy = DEFAULT_DUPLICATE_POLICY,
): DuplicateMatch {
  const matched: DuplicateRuleCode[] = [];
  const explanation: string[] = [];

  const addRule = (code: DuplicateRuleCode, detail: string): void => {
    matched.push(code);
    explanation.push(`${DUPLICATE_RULES[code].label} : ${detail}`);
  };

  const hoursApart =
    Math.abs(subject.createdAt.getTime() - candidate.createdAt.getTime()) / 3_600_000;

  // La fenetre temporelle est une CONDITION D'ENTREE, pas un simple poids.
  // Un client fidele qui recommande le meme produit trois semaines plus tard
  // n'est pas un doublon : c'est un bon client. Signaler ces cas ruinerait la
  // confiance dans l'alerte et pousserait les agents a l'ignorer.
  if (hoursApart > policy.windowHours) {
    return {
      candidateOrderId: candidate.orderId,
      score: 0,
      confidence: 'NONE',
      matchedRules: [],
      explanation: [
        `Hors fenetre de comparaison : ${hoursApart.toFixed(1)} h d ecart (limite ${policy.windowHours} h).`,
      ],
    };
  }

  if (
    subject.phoneNormalized &&
    candidate.phoneNormalized &&
    subject.phoneNormalized === candidate.phoneNormalized
  ) {
    addRule('SAME_PHONE', subject.phoneNormalized);
  }

  if (sameSkuSet(subject.skus, candidate.skus)) {
    addRule('SAME_PRODUCTS', subject.skus.join(', '));
  }

  if (subject.totalCentimes === candidate.totalCentimes && subject.totalCentimes > 0) {
    addRule('SAME_TOTAL', String(subject.totalCentimes));
  }

  if (
    subject.addressNormalized &&
    candidate.addressNormalized &&
    subject.addressNormalized === candidate.addressNormalized
  ) {
    addRule('SAME_ADDRESS', subject.addressNormalized);
  }

  if (
    subject.wilayaCode !== null &&
    candidate.wilayaCode !== null &&
    subject.wilayaCode === candidate.wilayaCode
  ) {
    addRule('SAME_WILAYA', String(subject.wilayaCode));
  }

  if (
    subject.customerNameNormalized &&
    candidate.customerNameNormalized &&
    subject.customerNameNormalized === candidate.customerNameNormalized
  ) {
    addRule('SAME_CUSTOMER_NAME', subject.customerNameNormalized);
  }

  addRule('WITHIN_TIME_WINDOW', `${hoursApart.toFixed(1)} h d ecart`);

  const score = matched.reduce((total, code) => total + DUPLICATE_RULES[code].weight, 0);

  // Le seuil « tres probable » ne peut jamais etre plus permissif que le seuil
  // d'alerte : une boutique qui releve `alertThreshold` doit voir MOINS
  // d'alertes, jamais des alertes requalifiees a la hausse.
  const likelyThreshold = Math.max(policy.alertThreshold, policy.highConfidenceThreshold);

  let confidence: DuplicateConfidence = 'NONE';
  if (score >= likelyThreshold) confidence = 'LIKELY';
  else if (score >= policy.alertThreshold) confidence = 'POSSIBLE';

  return {
    candidateOrderId: candidate.orderId,
    score,
    confidence,
    matchedRules: matched,
    explanation,
  };
}

/** Retourne les correspondances qui atteignent le seuil d'alerte, triees. */
export function findDuplicates(
  subject: DuplicateCandidateInput,
  candidates: readonly DuplicateCandidateInput[],
  policy: DuplicateDetectionPolicy = DEFAULT_DUPLICATE_POLICY,
): readonly DuplicateMatch[] {
  return candidates
    .filter((candidate) => candidate.orderId !== subject.orderId)
    .map((candidate) => scoreDuplicate(subject, candidate, policy))
    .filter((match) => match.confidence !== 'NONE')
    .sort((a, b) => b.score - a.score);
}

/** Normalisation d'un texte libre pour comparaison (adresse, nom). */
export function normalizeForComparison(input: string | null | undefined): string | null {
  if (!input) return null;
  const normalized = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return normalized.length === 0 ? null : normalized;
}
