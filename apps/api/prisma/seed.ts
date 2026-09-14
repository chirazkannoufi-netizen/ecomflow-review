/**
 * Amorcage de la base EcomFlow.
 *
 * IDEMPOTENT : ce script peut etre rejoue autant de fois que necessaire, en
 * developpement comme en production, apres chaque deploiement qui ajoute une
 * permission ou un transporteur. Il n'ecrase jamais une donnee metier et ne
 * supprime jamais une permission deja rattachee a un role personnalise.
 *
 * Ce qu'il installe :
 *  1. le catalogue des permissions (source : packages/shared) ;
 *  2. le role de plateforme SUPER_ADMIN et ses droits ;
 *  3. le compte Super Admin, si SUPER_ADMIN_EMAIL est configure ;
 *  4. le catalogue des transporteurs supportes ;
 *  5. les plans tarifaires par defaut — PRIX CONFIGURABLES, jamais codes en
 *     dur cote frontend (V2 §38).
 *
 * Utilisation :
 *   npm run seed                    # amorcage seul
 *   npm run seed -- --with-demo     # ajoute une boutique de demonstration
 */

import { PrismaClient } from '@prisma/client';
import { hash as argonHash, Algorithm } from '@node-rs/argon2';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  SYSTEM_ROLE_DESCRIPTIONS,
  SYSTEM_ROLE_LABELS,
  isPlatformPermission,
} from '@ecomflow/shared';
import { seedDemoTenant } from './seed-demo';
import { COMMUNES } from './data/communes';

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface SeedOptions {
  /** Compte Super Admin a creer. `null` pour n'en creer aucun. */
  readonly superAdmin?: { email: string; password: string } | null;
  /** Ajoute la boutique de demonstration. */
  readonly withDemo?: boolean;
  /** Supprime les traces sur la sortie standard (tests). */
  readonly silent?: boolean;
}

/**
 * Colonnes que le seed ECRIT et qui proviennent des migrations les plus
 * recentes. La liste n'a pas vocation a decrire tout le schema : elle cible
 * ce qui casserait le seed si une migration manquait.
 */
const REQUIRED_COLUMNS: readonly { table: string; column: string; migration: string }[] = [
  { table: 'tenant_settings', column: 'default_locale', migration: '20260830120000_i18n_locales' },
  { table: 'tenant_settings', column: 'customer_message_locale', migration: '20260830120000_i18n_locales' },
  { table: 'customers', column: 'locale', migration: '20260830120000_i18n_locales' },
];

/**
 * Verifie que la base porte bien les colonnes que le seed va ecrire.
 *
 * POURQUOI CE CONTROLE EXISTE
 *   Lance sur une base dont les migrations n'ont pas ete appliquees, le seed
 *   echouait au milieu de sa transaction avec une erreur Prisma brute :
 *
 *     PrismaClientKnownRequestError P2022
 *     The column `default_locale` does not exist in the current database.
 *
 *   Ce message dit CE QUI a echoue, jamais QUOI FAIRE. Le lecteur en conclut
 *   naturellement qu'une migration manque du depot — alors qu'elle est
 *   simplement en attente d'application. Le diagnostic part dans la mauvaise
 *   direction, et c'est exactement ce qui s'est produit.
 *
 *   Le controle a lieu AVANT toute ecriture : mieux vaut ne rien faire et le
 *   dire, que s'arreter a mi-chemin en laissant une base a moitie amorcee.
 */
async function assertSchemaIsCurrent(prisma: PrismaClient): Promise<void> {
  const present = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `;

  const known = new Set(present.map((row) => `${row.table_name}.${row.column_name}`));
  const missing = REQUIRED_COLUMNS.filter(
    (entry) => !known.has(`${entry.table}.${entry.column}`),
  );

  if (missing.length === 0) return;

  // Message construit ligne par ligne : il est destine a etre LU dans un
  // terminal par quelqu'un que le seed vient d'arreter. Il doit dire ce qui
  // manque, d'ou cela vient, et quoi taper — dans cet ordre.
  const lines = [
    'Base de donnees non a jour : le seed ecrirait dans des colonnes absentes.',
    '',
    ...missing.map(
      (entry) => `  - ${entry.table}.${entry.column}  (migration ${entry.migration})`,
    ),
    '',
    'Ces colonnes viennent de migrations presentes dans le depot mais pas encore',
    'appliquees sur cette base. Appliquez-les puis relancez :',
    '',
    '    npm run prisma:deploy',
    '    npm run seed:demo',
    '',
  ];

  throw new Error(lines.join('\n'));
}

/**
 * Refuse categoriquement d'installer la boutique de demonstration en production.
 *
 * POURQUOI CE GARDE-FOU EXISTE
 *   Les donnees de demonstration contiennent des comptes dont le MOT DE PASSE
 *   EST PUBLIC (il figure dans ce depot et dans le README). Les creer sur une
 *   installation de production ouvrirait un acces connu de tous a une boutique
 *   reelle, aux cotes de vraies donnees clients.
 *
 *   Le drapeau `--with-demo` est explicite, mais une erreur de manipulation ne
 *   doit pas suffire : le refus est fait par le code, pas par la vigilance de
 *   celui qui tape la commande.
 *
 *   `ALLOW_DEMO_SEED_IN_PRODUCTION` n'existe volontairement PAS. Il n'y a aucun
 *   cas legitime : une demonstration se fait sur un environnement dedie.
 */
function assertNotProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refus d installer la boutique de demonstration : NODE_ENV=production.\n' +
        'Ces donnees incluent des comptes dont le mot de passe est publie dans ' +
        'le depot. Utilisez un environnement de developpement ou de recette.',
    );
  }
}

export interface SeedReport {
  readonly permissions: number;
  readonly carriers: number;
  readonly plans: number;
  readonly superAdminEmail: string | null;
  readonly demoSlug: string | null;
}

/**
 * Amorce la base. Fonction pure d'effets de bord maitrises : elle recoit son
 * client Prisma, ce qui la rend appelable depuis le harnais de tests sans
 * lancer de sous-processus.
 */
export async function runSeed(
  prisma: PrismaClient,
  options: SeedOptions = {},
): Promise<SeedReport> {
  const log = options.silent ? () => undefined : (message: string) => console.log(message);

  await assertSchemaIsCurrent(prisma);

  log('Amorcage EcomFlow');
  log('-----------------');

  const permissions = await seedPermissions(prisma, options.silent ?? false);
  log(`  Permissions           : ${permissions} synchronisees`);

  const platformRoleId = await seedPlatformRole(prisma);
  log('  Role plateforme       : SUPER_ADMIN');

  const superAdminEmail = await seedSuperAdmin(prisma, platformRoleId, options.superAdmin);
  log(
    `  Compte Super Admin    : ${superAdminEmail ?? 'non configure (SUPER_ADMIN_EMAIL absent)'}`,
  );

  const carriers = await seedCarriers(prisma);
  log(`  Transporteurs         : ${carriers} references`);

  const plans = await seedPlans(prisma);
  log(`  Plans tarifaires      : ${plans} disponibles`);

  const communes = await seedCommunes(prisma);
  log(`  Communes              : ${communes} rattachees a leur wilaya`);

  let demoSlug: string | null = null;
  if (options.withDemo) {
    assertNotProduction();
    const demo = await seedDemoTenant(prisma);
    demoSlug = demo.slug;
    log(`  Boutique de demo      : ${demo.slug} (${demo.orderCount} commandes)`);
    log(`    Connexion           : ${demo.ownerEmail} / ${demo.ownerPassword}`);
  }

  if (!options.withDemo) {
    log('');
    log('  Base de developpement vide ? Ajoutez un jeu de donnees realiste :');
    log('    npm run seed:demo -w @ecomflow/api');
  }

  log('-----------------');
  log('Amorcage termine.');

  return { permissions, carriers, plans, superAdminEmail, demoSlug };
}

// ---------------------------------------------------------------------------
// 1. Permissions
// ---------------------------------------------------------------------------

/**
 * Synchronise le catalogue des permissions.
 *
 * Les permissions ABSENTES du code mais presentes en base ne sont PAS
 * supprimees : elles pourraient etre rattachees a un role personnalise cree
 * par un commercant. Elles sont signalees pour un nettoyage manuel eclaire.
 */
async function seedPermissions(prisma: PrismaClient, silent: boolean): Promise<number> {
  const descriptorByKey = new Map(PERMISSION_CATALOG.map((entry) => [entry.key, entry]));

  for (const key of ALL_PERMISSIONS) {
    const descriptor = descriptorByKey.get(key);
    if (!descriptor) {
      // Le catalogue de metadonnees et la liste des permissions doivent rester
      // alignes ; un ecart est une erreur de developpement, pas de donnees.
      throw new Error(
        `Permission « ${key} » declaree sans metadonnee dans PERMISSION_CATALOG.`,
      );
    }

    await prisma.permission.upsert({
      where: { key },
      create: {
        key,
        group: descriptor.group,
        label: descriptor.label,
        description: descriptor.description,
        sensitive: descriptor.sensitive,
        isPlatform: isPlatformPermission(key),
      },
      update: {
        group: descriptor.group,
        label: descriptor.label,
        description: descriptor.description,
        sensitive: descriptor.sensitive,
        isPlatform: isPlatformPermission(key),
      },
    });
  }

  const orphans = await prisma.permission.findMany({
    where: { key: { notIn: [...ALL_PERMISSIONS] } },
    select: { key: true },
  });
  if (orphans.length > 0 && !silent) {
    console.warn(
      `  ! Permissions obsoletes conservees (rattachees a d eventuels roles ` +
        `personnalises) : ${orphans.map((o) => o.key).join(', ')}`,
    );
  }

  return ALL_PERMISSIONS.length;
}

// ---------------------------------------------------------------------------
// 2. Role de plateforme
// ---------------------------------------------------------------------------

async function seedPlatformRole(prisma: PrismaClient): Promise<string> {
  const role = await prisma.role.upsert({
    where: { tenantId_code: { tenantId: null as unknown as string, code: 'SUPER_ADMIN' } },
    create: {
      tenantId: null,
      scope: 'PLATFORM',
      code: 'SUPER_ADMIN',
      name: SYSTEM_ROLE_LABELS.SUPER_ADMIN,
      description: SYSTEM_ROLE_DESCRIPTIONS.SUPER_ADMIN,
      isSystem: true,
    },
    update: {
      name: SYSTEM_ROLE_LABELS.SUPER_ADMIN,
      description: SYSTEM_ROLE_DESCRIPTIONS.SUPER_ADMIN,
    },
    select: { id: true },
  }).catch(async () => {
    // `upsert` sur une cle composite dont un membre est NULL ne fonctionne pas
    // en SQL (NULL n'est jamais egal a NULL). On retombe donc sur une
    // recherche explicite, qui est le comportement correct pour ce cas.
    const existing = await prisma.role.findFirst({
      where: { code: 'SUPER_ADMIN', scope: 'PLATFORM', tenantId: null },
      select: { id: true },
    });
    if (existing) return existing;
    return prisma.role.create({
      data: {
        tenantId: null,
        scope: 'PLATFORM',
        code: 'SUPER_ADMIN',
        name: SYSTEM_ROLE_LABELS.SUPER_ADMIN,
        description: SYSTEM_ROLE_DESCRIPTIONS.SUPER_ADMIN,
        isSystem: true,
      },
      select: { id: true },
    });
  });

  const permissions = await prisma.permission.findMany({
    where: { key: { in: [...DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN] } },
    select: { id: true },
  });

  await prisma.rolePermission.createMany({
    data: permissions.map((permission) => ({
      roleId: role.id,
      permissionId: permission.id,
    })),
    skipDuplicates: true,
  });

  return role.id;
}

// ---------------------------------------------------------------------------
// 3. Compte Super Admin
// ---------------------------------------------------------------------------

async function seedSuperAdmin(
  prisma: PrismaClient,
  platformRoleId: string,
  override?: { email: string; password: string } | null,
): Promise<string | null> {
  // `override === null` demande explicitement de ne creer aucun compte ;
  // `undefined` retombe sur la configuration d'environnement.
  const email =
    override === null
      ? undefined
      : (override?.email ?? process.env.SUPER_ADMIN_EMAIL)?.trim().toLowerCase();
  const password = override === null ? undefined : (override?.password ?? process.env.SUPER_ADMIN_PASSWORD);

  if (!email || !password) return null;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });

  // Le mot de passe n'est POSE QU'A LA CREATION : rejouer le seed ne doit pas
  // reinitialiser le mot de passe d'un administrateur qui l'aurait change.
  const user = existing
    ? existing
    : await prisma.user.create({
        data: {
          email,
          passwordHash: await argonHash(password, ARGON2_OPTIONS),
          fullName: 'Administrateur EcomFlow',
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });

  await prisma.platformRoleAssignment.upsert({
    where: { userId_roleId: { userId: user.id, roleId: platformRoleId } },
    create: { userId: user.id, roleId: platformRoleId },
    update: {},
  });

  return email;
}

// ---------------------------------------------------------------------------
// 4. Transporteurs
// ---------------------------------------------------------------------------

/**
 * Catalogue des connecteurs transporteurs.
 *
 * `implementationStatus` dit la VERITE sur l'etat reel de chaque connecteur
 * (prompt produit §5) :
 *   - `AVAILABLE`      : adaptateur implemente et utilisable ;
 *   - `PLANNED`        : cible d'integration, adaptateur non implemente. La
 *                        boutique ne peut pas l'activer et l'interface
 *                        l'indique clairement.
 * Aucun transporteur n'est presente comme fonctionnel sans l'etre.
 */
/**
 * Capacites de chaque connecteur — matrice de l'audit fonctionnel Ecomanager.
 *
 * UNE SEULE SOURCE ECRITE A LA MAIN
 *   `supportsWebhooks` et `supportsCancellation` existaient deja sur `Carrier`
 *   et sont lus par plusieurs services. Plutot que de les saisir une seconde
 *   fois, ils en sont DERIVES ci-dessous : la capacite est ecrite ici, la
 *   colonne historique la recopie. Il n'y a donc jamais deux verites a
 *   maintenir d'accord.
 *
 * CE QUI EST DECLARE ICI DOIT EXISTER DANS L'ADAPTATEUR
 *   Ces booleens pilotent l'affichage des actions : une capacite declaree que
 *   le code ne sait pas honorer produit exactement le bouton-qui-echoue que la
 *   matrice doit supprimer. Pour les connecteurs `PLANNED`, la ligne decrit la
 *   CIBLE d'integration ; ils sont de toute facon refuses a l'expedition par
 *   `implementationStatus`.
 *
 *   `MOCK_CARRIER` declare tout : c'est un connecteur de test, dont l'interet
 *   est justement de laisser toutes les actions accessibles en developpement.
 */
const YALIDINE_FAMILY_CAPABILITIES = {
  addOrder: true,
  addOrderBulk: true,
  deleteOrder: true,
  printableLabel: true,
  syncAttempted: true,
  syncDelivered: true,
  syncFailed: true,
  // Pas de push : l'adaptateur declare `supportsWebhooks = false`, et tout
  // le suivi passe par le sondage.
  realtimeUndeliverableWilayas: false,
  realtimeAttempted: false,
  realtimeDelivered: false,
  realtimeFailed: false,
  realtimeCollectionVouchers: false,
  realtimeAddressChange: false,
  realtimePriceChange: false,
  stopDesk: true,
  afterSalesExchange: false,
  afterSalesPickup: false,
  stockAtCarrier: false,
} as const;

/**
 * Famille Ecotrack — quatre societes, une plateforme, une matrice.
 *
 * DEUX LIGNES QUI CORRIGENT CE QUE LA SYNTHESE ANNONCAIT
 *   `deleteOrder: true` — la fiche de synthese affirmait qu'aucun point
 *   d'annulation n'existait ; l'integration Vargo appelle pourtant
 *   `DELETE api/v1/delete/order`. On declare donc la capacite, en sachant que
 *   « supprimer » pourrait ne valoir qu'avant enlevement : c'est exactement ce
 *   qu'un premier compte reel dira.
 *
 *   `printableLabel: false` — et la, la fiche avait raison. Le bordereau existe
 *   mais l'API le rend en OCTETS PDF, pas en URL. `Shipment.labelUrl` commande
 *   un lien dans deux ecrans ; sans route qui serve ces octets, il n'y a aucun
 *   lien a promettre. Declarer la capacite afficherait un bouton mort — ce que
 *   D-049 existe pour empecher.
 */
const ECOTRACK_FAMILY_CAPABILITIES = {
  addOrder: true,
  addOrderBulk: true,
  deleteOrder: true,
  printableLabel: false,
  syncAttempted: true,
  syncDelivered: true,
  syncFailed: true,
  realtimeUndeliverableWilayas: false,
  realtimeAttempted: false,
  realtimeDelivered: false,
  realtimeFailed: false,
  realtimeCollectionVouchers: false,
  realtimeAddressChange: false,
  realtimePriceChange: false,
  stopDesk: true,
  // `type` distingue livraison, echange et pick-up a la creation meme.
  afterSalesExchange: true,
  afterSalesPickup: true,
  // `stock` et `quantite` a la creation : la plateforme suit la marchandise
  // deposee chez le transporteur.
  stockAtCarrier: true,
} as const;

const CARRIER_CAPABILITIES = {
  MOCK_CARRIER: {
    addOrder: true,
    addOrderBulk: true,
    deleteOrder: true,
    printableLabel: true,
    syncAttempted: true,
    syncDelivered: true,
    syncFailed: true,
    realtimeUndeliverableWilayas: true,
    realtimeAttempted: true,
    realtimeDelivered: true,
    realtimeFailed: true,
    realtimeCollectionVouchers: true,
    realtimeAddressChange: true,
    realtimePriceChange: true,
    stopDesk: true,
    afterSalesExchange: true,
    afterSalesPickup: true,
    stockAtCarrier: true,
  },

  // --- Famille Yalidine : meme API, quatre domaines -------------------------
  YALIDINE: YALIDINE_FAMILY_CAPABILITIES,
  GUEPEX: YALIDINE_FAMILY_CAPABILITIES,
  YALITEC: YALIDINE_FAMILY_CAPABILITIES,
  WECAN: YALIDINE_FAMILY_CAPABILITIES,

  // --- Famille Ecotrack : plateforme partagee -------------------------------
  ECOTRACK: ECOTRACK_FAMILY_CAPABILITIES,
  DHD: ECOTRACK_FAMILY_CAPABILITIES,
  UPS_CONEXLOG: ECOTRACK_FAMILY_CAPABILITIES,
  SPEEDMAIL: ECOTRACK_FAMILY_CAPABILITIES,

  /**
   * ZR Express v2 (Procolis) — corrigee vers le BAS.
   *
   * La ligne precedente declarait suppression et etiquette : elle decrivait une
   * CIBLE, ecrite avant qu'aucune source ne soit lue. Les deux integrations
   * open-source consultees declarent les trois explicitement non supportees, et
   * `lire` ne rend que l'etat courant — donc aucune tentative historisee.
   */
  ZR_EXPRESS: {
    addOrder: true,
    addOrderBulk: false,
    deleteOrder: false,
    printableLabel: false,
    syncAttempted: false,
    syncDelivered: true,
    syncFailed: true,
    realtimeUndeliverableWilayas: false,
    realtimeAttempted: false,
    realtimeDelivered: false,
    realtimeFailed: false,
    realtimeCollectionVouchers: false,
    realtimeAddressChange: false,
    realtimePriceChange: false,
    stopDesk: true,
    afterSalesExchange: true,
    afterSalesPickup: false,
    stockAtCarrier: false,
  },

  /**
   * ZR Express v3 — la plus riche du catalogue, et pas une ligne verifiee.
   *
   * Aucun adaptateur : son adressage par UUID de territoire ne parle pas le
   * langage de notre referentiel. Cette matrice reprend ce que la fiche annonce
   * — webhooks, echange, tresorerie — et l'ecran la rend en pastilles creuses,
   * parce qu'une capacite annoncee n'est pas une capacite constatee (D-066).
   */
  ZR_EXPRESS_V3: {
    addOrder: true,
    addOrderBulk: true,
    deleteOrder: true,
    printableLabel: true,
    syncAttempted: true,
    syncDelivered: true,
    syncFailed: true,
    realtimeUndeliverableWilayas: false,
    realtimeAttempted: true,
    realtimeDelivered: true,
    realtimeFailed: true,
    realtimeCollectionVouchers: true,
    realtimeAddressChange: true,
    realtimePriceChange: true,
    stopDesk: true,
    afterSalesExchange: true,
    afterSalesPickup: true,
    stockAtCarrier: true,
  },

  MAYSTRO: {
    addOrder: true,
    addOrderBulk: true,
    deleteOrder: true,
    printableLabel: true,
    syncAttempted: true,
    syncDelivered: true,
    syncFailed: true,
    realtimeUndeliverableWilayas: false,
    realtimeAttempted: true,
    realtimeDelivered: true,
    realtimeFailed: true,
    realtimeCollectionVouchers: false,
    realtimeAddressChange: false,
    realtimePriceChange: false,
    stopDesk: false,
    afterSalesExchange: false,
    afterSalesPickup: false,
    // Maystro fait aussi du stockage : son API porte un catalogue produits.
    stockAtCarrier: true,
  },

  ECOM_DELIVERY: {
    addOrder: true,
    addOrderBulk: true,
    deleteOrder: true,
    printableLabel: true,
    syncAttempted: true,
    syncDelivered: true,
    syncFailed: true,
    realtimeUndeliverableWilayas: false,
    realtimeAttempted: false,
    realtimeDelivered: false,
    realtimeFailed: false,
    realtimeCollectionVouchers: false,
    realtimeAddressChange: false,
    realtimePriceChange: false,
    // `getOffices` figure parmi les fonctions observees.
    stopDesk: true,
    afterSalesExchange: false,
    afterSalesPickup: false,
    stockAtCarrier: false,
  },

  /**
   * Colivraison — la seule ligne SANS matrice, et c'est volontaire.
   *
   * Aucune implementation communautaire n'existe, et la fiche ne liste aucune
   * fonction : la seule chose connue est une authentification a deux champs et
   * une API « orientee lot ». Ecrire dix-huit `false` affirmerait dix-huit
   * incapacites constatees ; ecrire dix-huit `true` promettrait tout. `null`
   * dit ce qui est vrai — « non renseignees » — et l'ecran l'affiche ainsi.
   */
  COLIVRAISON: null,
} as const;

type CarrierCode = keyof typeof CARRIER_CAPABILITIES;

/**
 * Le catalogue.
 *
 * TROIS ETATS, ET CE QU'ILS AUTORISENT (D-066, D-070)
 *   AVAILABLE  — adaptateur verifie contre un compte marchand reel. Seul
 *                `MOCK_CARRIER` y figure : c'est notre propre code, et il n'a
 *                aucune API distante a decevoir.
 *   UNVERIFIED — adaptateur ecrit d'apres des sources tierces concordantes,
 *                jamais confronte. Selectionnable, capacites declarees.
 *   PLANNED    — aucun adaptateur, donc non selectionnable.
 *
 * `sourceNote` dit POURQUOI, parce que deux transporteurs PLANNED peuvent
 * l'etre pour des raisons qui n'appellent pas le meme geste suivant : demander
 * une documentation n'est pas reprendre un adressage.
 *
 * CE QUI N'Y FIGURE PAS
 *   « Nord & Ouest » n'apparait dans aucune des six fiches, et aucune source
 *   meme partielle n'a ete trouvee. Une ligne de catalogue sans source serait
 *   une promesse sans rien derriere : elle attendra.
 */
const CARRIERS = [
  {
    code: 'MOCK_CARRIER',
    name: 'Transporteur de test',
    implementationStatus: 'AVAILABLE',
    sourceNote: null,
    isActive: true,
  },

  // --- Famille Yalidine -----------------------------------------------------
  {
    // AUCUN transporteur reel n'est verifie, Yalidine compris.
    //
    //   Son adaptateur a ete ecrit d'apres la documentation publique de
    //   Yalidine, et son propre en-tete le dit depuis le premier jour : il n'a
    //   jamais ete confronte a l'API de production, faute d'un compte marchand.
    //   C'etait la seule ligne du catalogue qui promettait plus qu'elle ne
    //   tenait — `AVAILABLE` affirmait une verification que personne n'avait
    //   faite, et la matrice s'affichait en capacites ACQUISES.
    //
    //   Le troisieme etat existe exactement pour ce cas (D-070). Yalidine le
    //   prend, et `AVAILABLE` ne decrit plus qu'une chose : un connecteur qui a
    //   reellement tourne. Aucun n'y est encore, hors le transporteur de test.
    code: 'YALIDINE',
    name: 'Yalidine Express',
    implementationStatus: 'UNVERIFIED',
    sourceNote: 'NEVER_CONFRONTED',
    isActive: true,
  },
  {
    code: 'GUEPEX',
    name: 'Guepex',
    implementationStatus: 'UNVERIFIED',
    sourceNote: 'THIRD_PARTY_SOURCES',
    isActive: true,
  },
  {
    code: 'YALITEC',
    name: 'Yalitec',
    implementationStatus: 'UNVERIFIED',
    sourceNote: 'THIRD_PARTY_SOURCES',
    isActive: true,
  },
  {
    code: 'WECAN',
    name: 'We Can Services',
    implementationStatus: 'UNVERIFIED',
    sourceNote: 'THIRD_PARTY_SOURCES',
    isActive: true,
  },

  // --- Famille Ecotrack -----------------------------------------------------
  {
    code: 'ECOTRACK',
    name: 'Ecotrack',
    implementationStatus: 'UNVERIFIED',
    sourceNote: 'THIRD_PARTY_SOURCES',
    isActive: true,
  },
  {
    code: 'DHD',
    name: 'DHD',
    implementationStatus: 'UNVERIFIED',
    sourceNote: 'THIRD_PARTY_SOURCES',
    isActive: true,
  },
  {
    // « UPS » designe ici CONEXLOG EURL, licencie algerien de la marque, qui
    // livre sur Ecotrack. Ce n'est PAS l'API mondiale de United Parcel Service,
    // et le nom du catalogue doit l'empecher d'etre lu ainsi.
    code: 'UPS_CONEXLOG',
    name: 'UPS (Conexlog)',
    implementationStatus: 'UNVERIFIED',
    sourceNote: 'THIRD_PARTY_SOURCES',
    isActive: true,
  },
  {
    code: 'SPEEDMAIL',
    name: 'SpeedMail',
    implementationStatus: 'UNVERIFIED',
    sourceNote: 'THIRD_PARTY_SOURCES',
    isActive: true,
  },

  // --- ZR Express : deux generations, pas une famille ------------------------
  {
    code: 'ZR_EXPRESS',
    name: 'ZR Express (v2 · Procolis)',
    implementationStatus: 'UNVERIFIED',
    sourceNote: 'THIRD_PARTY_SOURCES',
    isActive: true,
  },
  {
    code: 'ZR_EXPRESS_V3',
    name: 'ZR Express (v3)',
    implementationStatus: 'PLANNED',
    sourceNote: 'ADDRESSING_REWORK',
    isActive: false,
  },

  // --- Declares, sans adaptateur : la documentation reste a obtenir ---------
  {
    code: 'MAYSTRO',
    name: 'Maystro Delivery',
    implementationStatus: 'PLANNED',
    sourceNote: 'DOCUMENTATION_REQUESTED',
    isActive: false,
  },
  {
    code: 'ECOM_DELIVERY',
    name: 'E-COM Delivery',
    implementationStatus: 'PLANNED',
    sourceNote: 'DOCUMENTATION_REQUESTED',
    isActive: false,
  },
  {
    code: 'COLIVRAISON',
    name: 'Colivraison Express',
    implementationStatus: 'PLANNED',
    sourceNote: 'DOCUMENTATION_REQUESTED',
    isActive: false,
  },
] as const satisfies readonly { code: CarrierCode; [key: string]: unknown }[];

async function seedCarriers(prisma: PrismaClient): Promise<number> {
  for (const carrier of CARRIERS) {
    const capabilities = CARRIER_CAPABILITIES[carrier.code];

    // Une matrice ABSENTE n'est pas une matrice vide : elle signifie « on ne
    // sait pas », et l'ecran le dit ainsi. La ligne est donc retiree plutot
    // qu'ecrite a faux — sans quoi un re-seed laisserait dix-huit
    // « non supporte » la ou il n'y a qu'une ignorance.
    if (capabilities === null) {
      const row = await prisma.carrier.upsert({
        where: { code: carrier.code },
        create: { ...carrier, supportsWebhooks: false, supportsCancellation: false },
        update: {
          name: carrier.name,
          implementationStatus: carrier.implementationStatus,
          sourceNote: carrier.sourceNote,
          isActive: carrier.isActive,
          supportsWebhooks: false,
          supportsCancellation: false,
        },
        select: { id: true },
      });
      await prisma.carrierCapability.deleteMany({ where: { carrierId: row.id } });
      continue;
    }

    // Les deux colonnes historiques de `Carrier` sont DERIVEES de la matrice :
    // une seule ligne a maintenir, deux projections.
    //
    // `supportsWebhooks` repond a « ce connecteur pousse-t-il quoi que ce
    // soit ? » : n'importe laquelle des capacites temps reel suffit a rendre un
    // point d'entree webhook necessaire.
    const legacyFlags = {
      supportsWebhooks:
        capabilities.realtimeUndeliverableWilayas ||
        capabilities.realtimeAttempted ||
        capabilities.realtimeDelivered ||
        capabilities.realtimeFailed ||
        capabilities.realtimeCollectionVouchers ||
        capabilities.realtimeAddressChange ||
        capabilities.realtimePriceChange,
      supportsCancellation: capabilities.deleteOrder,
    };

    const row = await prisma.carrier.upsert({
      where: { code: carrier.code },
      create: { ...carrier, ...legacyFlags },
      update: {
        name: carrier.name,
        implementationStatus: carrier.implementationStatus,
        sourceNote: carrier.sourceNote,
        isActive: carrier.isActive,
        ...legacyFlags,
      },
      select: { id: true },
    });

    await prisma.carrierCapability.upsert({
      where: { carrierId: row.id },
      create: { carrierId: row.id, ...capabilities },
      update: { ...capabilities },
    });
  }
  return CARRIERS.length;
}

// ---------------------------------------------------------------------------
// 5. Plans tarifaires
// ---------------------------------------------------------------------------

/**
 * Plans par defaut. Les montants sont en CENTIMES de dinar.
 *
 * Ces valeurs sont un point de depart modifiable depuis l'administration :
 * la V2 §38 interdit de figer les prix dans le code applicatif, et notamment
 * dans le frontend. Le seed ne fait que garantir qu'une installation neuve
 * dispose d'une grille coherente.
 */
const PLANS = [
  {
    code: 'STARTER',
    name: 'Starter',
    description: 'Pour demarrer : une boutique, un transporteur, l essentiel des operations.',
    priceCentimes: 250_000, // 2 500 DA / mois
    billingPeriod: 'MONTHLY' as const,
    limits: { ordersPerMonth: 500, users: 3, integrations: 1, carriers: 1 },
    features: {
      googleSheets: true,
      confirmationCenter: true,
      whatsappFilter: false,
      profitabilityDashboard: false,
      customRoles: false,
      apiAccess: false,
    },
    sortOrder: 1,
  },
  {
    code: 'PRO',
    name: 'Pro',
    description: 'Pour une equipe : filtre WhatsApp, rentabilite, plusieurs transporteurs.',
    priceCentimes: 600_000, // 6 000 DA / mois
    billingPeriod: 'MONTHLY' as const,
    limits: { ordersPerMonth: 3_000, users: 10, integrations: 3, carriers: 3 },
    features: {
      googleSheets: true,
      confirmationCenter: true,
      whatsappFilter: true,
      profitabilityDashboard: true,
      customRoles: true,
      apiAccess: false,
    },
    sortOrder: 2,
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    description: 'Pour un volume eleve : sans limite pratique, acces API, support prioritaire.',
    priceCentimes: 1_500_000, // 15 000 DA / mois
    billingPeriod: 'MONTHLY' as const,
    limits: { ordersPerMonth: null, users: null, integrations: null, carriers: null },
    features: {
      googleSheets: true,
      confirmationCenter: true,
      whatsappFilter: true,
      profitabilityDashboard: true,
      customRoles: true,
      apiAccess: true,
    },
    sortOrder: 3,
  },
] as const;

/**
 * Referentiel des communes.
 *
 * ECRITURE EN LOT, ET IDEMPOTENTE
 *   Mille cinq cent quarante et un `upsert` successifs prendraient plusieurs
 *   dizaines de secondes a chaque amorcage — donc a chaque suite de tests
 *   d'integration. On procede en une lecture + un `createMany` du complement :
 *   le seed reste rejouable, et ne coute plus rien des la seconde fois.
 *
 *   `skipDuplicates` protege la course entre deux amorcages concurrents ; la
 *   contrainte unique `(wilaya_code, search_name)` reste l'autorite.
 */
async function seedCommunes(prisma: PrismaClient): Promise<number> {
  const existing = await prisma.commune.findMany({
    select: { wilayaCode: true, searchName: true },
  });

  const known = new Set(existing.map((row) => `${row.wilayaCode}:${row.searchName}`));
  const missing = COMMUNES.filter(
    (commune) => !known.has(`${commune.wilayaCode}:${commune.searchName}`),
  );

  if (missing.length > 0) {
    await prisma.commune.createMany({ data: [...missing], skipDuplicates: true });
  }

  return COMMUNES.length;
}

async function seedPlans(prisma: PrismaClient): Promise<number> {
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      create: {
        code: plan.code,
        name: plan.name,
        description: plan.description,
        priceCentimes: plan.priceCentimes,
        billingPeriod: plan.billingPeriod,
        limits: plan.limits,
        features: plan.features,
        sortOrder: plan.sortOrder,
        isPublic: true,
        isActive: true,
      },
      // Le PRIX n'est pas ecrase lors d'un rejeu : l'exploitant a pu l'ajuster
      // depuis l'administration, et le seed ne doit pas defaire ce choix.
      update: {
        name: plan.name,
        description: plan.description,
        limits: plan.limits,
        features: plan.features,
        sortOrder: plan.sortOrder,
      },
    });
  }
  return PLANS.length;
}

// ---------------------------------------------------------------------------
// Entree en ligne de commande
//
// Ne s'execute QUE si le fichier est lance directement (`npm run seed`).
// Importe depuis le harnais de tests, il n'a aucun effet de bord.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const prisma = new PrismaClient();
  runSeed(prisma, { withDemo: process.argv.includes('--with-demo') })
    .catch((error: unknown) => {
      console.error('Echec de l amorcage :', error);
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
