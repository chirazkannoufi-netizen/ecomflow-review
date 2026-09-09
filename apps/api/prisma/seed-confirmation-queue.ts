/**
 * Remet a zero les commandes de la boutique de demonstration et recree une
 * file de confirmation de TRENTE commandes a confirmer.
 *
 * POURQUOI UN SCRIPT DEDIE, ET NON LE SEED DE DEMONSTRATION
 *   `seed-demo` est IDEMPOTENT : il refuse de retoucher une boutique existante,
 *   precisement pour ne pas ecraser une session de decouverte. Il ne peut donc
 *   pas servir a repartir d'une file propre. Celui-ci fait l'inverse, et
 *   l'assume : il SUPPRIME les commandes avant d'en recreer.
 *
 * CE QU'IL SUPPRIME
 *   Toutes les commandes de la boutique et ce qui en depend — lignes,
 *   tentatives d'appel, historique de statut, signalements de doublon,
 *   expeditions, retours. Les CLIENTS, les PRODUITS et le STOCK sont
 *   conserves : ce sont eux qui rendent les commandes credibles, et les
 *   recreer ferait perdre l'historique de fiabilite.
 *
 *   Les compteurs clients sont en revanche remis a zero : ils resument des
 *   commandes qui n'existent plus, et les laisser afficherait « 5 livrees »
 *   pour un client sans aucune commande.
 *
 * REFUS EN PRODUCTION
 *   Le script s'arrete si `NODE_ENV=production`. Supprimer les commandes d'une
 *   vraie boutique n'est pas une operation qu'on lance par megarde.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_SLUG = 'boutique-demo';
const QUEUE_SIZE = 30;
const HOUR = 3_600_000;

/** Frais de livraison par defaut, en centimes (500,00 DA). */
const DELIVERY_FEE_CENTIMES = 50_000;

/**
 * Clients de la file.
 *
 * Prenoms, noms, communes et wilayas correspondent : un « Yacine Belkacem a
 * Bir El Djir, Oran » est plausible, « a Bir El Djir, Adrar » ne l'est pas.
 * Les numeros respectent les prefixes reels des trois operateurs algeriens —
 * 05 Ooredoo, 06 Mobilis, 07 Djezzy.
 */
const PEOPLE: readonly {
  name: string;
  phone: string;
  wilayaCode: number;
  wilayaName: string;
  commune: string;
  address: string;
}[] = [
  { name: 'Yacine Belkacem', phone: '0661248709', wilayaCode: 31, wilayaName: 'Oran', commune: 'Bir El Djir', address: 'Cite 1200 Logements, Bt C4' },
  { name: 'Amine Berkane', phone: '0557621984', wilayaCode: 31, wilayaName: 'Oran', commune: 'Es Senia', address: 'Rue Larbi Ben Mhidi, 14' },
  { name: 'Fatima Zohra Meddah', phone: '0770084531', wilayaCode: 31, wilayaName: 'Oran', commune: 'Ain El Turck', address: 'Lotissement El Bahia, 22' },
  { name: 'Sofiane Merabet', phone: '0661902715', wilayaCode: 31, wilayaName: 'Oran', commune: 'Arzew', address: 'Cite des Freres Bouhadjar' },
  { name: 'Nadia Belhadj', phone: '0555417360', wilayaCode: 16, wilayaName: 'Alger', commune: 'Bab Ezzouar', address: 'Cite AADL, Bt 7, appt 31' },
  { name: 'Walid Kaddour', phone: '0699125807', wilayaCode: 16, wilayaName: 'Alger', commune: 'El Harrach', address: 'Rue Hassiba Ben Bouali, 8' },
  { name: 'Ryad Benali', phone: '0771359244', wilayaCode: 16, wilayaName: 'Alger', commune: 'Kouba', address: 'Cite Garidi 2, Bt B' },
  { name: 'Samira Ould Ali', phone: '0553276109', wilayaCode: 16, wilayaName: 'Alger', commune: 'Hussein Dey', address: 'Rue des Fusilles, 45' },
  { name: 'Hakim Zerouali', phone: '0662743018', wilayaCode: 19, wilayaName: 'Setif', commune: 'El Eulma', address: 'Cite 500 Logements, Bt 12' },
  { name: 'Lynda Cherif', phone: '0553764012', wilayaCode: 19, wilayaName: 'Setif', commune: 'Ain Arnat', address: 'Route de Bejaia, km 4' },
  { name: 'Mohamed Saidi', phone: '0771129568', wilayaCode: 19, wilayaName: 'Setif', commune: 'Setif centre', address: 'Avenue du 8 Mai 1945, 61' },
  { name: 'Imane Boudiaf', phone: '0699331805', wilayaCode: 6, wilayaName: 'Bejaia', commune: 'Akbou', address: 'Quartier Ihaddaden, Bt 3' },
  { name: 'Karim Lounis', phone: '0662872491', wilayaCode: 25, wilayaName: 'Constantine', commune: 'El Khroub', address: 'Cite Massinissa, Villa 8' },
  { name: 'Sarah Meziane', phone: '0770416322', wilayaCode: 25, wilayaName: 'Constantine', commune: 'Constantine centre', address: 'Rue Abane Ramdane, 27' },
  { name: 'Nabil Ait Kaci', phone: '0555097140', wilayaCode: 15, wilayaName: 'Tizi Ouzou', commune: 'Azazga', address: 'Village Ait Aissa Mimoun' },
  { name: 'Meriem Slimani', phone: '0664183052', wilayaCode: 15, wilayaName: 'Tizi Ouzou', commune: 'Draa Ben Khedda', address: 'Cite des Oliviers, Bt 5' },
  { name: 'Bilal Ouali', phone: '0779276315', wilayaCode: 9, wilayaName: 'Blida', commune: 'Boufarik', address: 'Rue Emir Abdelkader, 3' },
  { name: 'Rania Belhadj', phone: '0556489087', wilayaCode: 9, wilayaName: 'Blida', commune: 'Blida centre', address: 'Boulevard Larbi Tebessi, 19' },
  { name: 'Toufik Amrani', phone: '0662712549', wilayaCode: 23, wilayaName: 'Annaba', commune: 'El Bouni', address: 'Cite Oued Forcha, Bt 2' },
  { name: 'Assia Haddadi', phone: '0553901764', wilayaCode: 23, wilayaName: 'Annaba', commune: 'Annaba centre', address: 'Rue Bouzered Hocine, 11' },
  { name: 'Redouane Ferhat', phone: '0771640238', wilayaCode: 5, wilayaName: 'Batna', commune: 'Barika', address: 'Cite El Moudjahidine, Bt 9' },
  { name: 'Khadija Benmoussa', phone: '0668374190', wilayaCode: 5, wilayaName: 'Batna', commune: 'Batna centre', address: 'Avenue de la Republique, 34' },
  { name: 'Anis Belkhodja', phone: '0559026748', wilayaCode: 13, wilayaName: 'Tlemcen', commune: 'Maghnia', address: 'Rue des Martyrs, 7' },
  { name: 'Soumia Chibane', phone: '0770483951', wilayaCode: 13, wilayaName: 'Tlemcen', commune: 'Tlemcen centre', address: 'Cite Kiffane, Bt 14' },
  { name: 'Djamel Boukhalfa', phone: '0663159402', wilayaCode: 35, wilayaName: 'Boumerdes', commune: 'Boudouaou', address: 'Lotissement El Feth, 21' },
  { name: 'Hayat Mansouri', phone: '0554728136', wilayaCode: 35, wilayaName: 'Boumerdes', commune: 'Bordj Menaiel', address: 'Rue Colonel Amirouche, 6' },
  { name: 'Farid Cheikh', phone: '0776304182', wilayaCode: 2, wilayaName: 'Chlef', commune: 'Chlef centre', address: 'Cite Bensouna, Bt 4' },
  { name: 'Nesrine Bouzid', phone: '0665218347', wilayaCode: 2, wilayaName: 'Chlef', commune: 'Tenes', address: 'Route du Port, 15' },
  { name: 'Mourad Talbi', phone: '0558763029', wilayaCode: 21, wilayaName: 'Skikda', commune: 'Skikda centre', address: 'Avenue Didouche Mourad, 52' },
  { name: 'Wassila Gharbi', phone: '0772940516', wilayaCode: 21, wilayaName: 'Skikda', commune: 'Collo', address: 'Cite des Freres Saker, Bt 1' },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refus : ce script supprime des commandes, il ne tourne pas en production.');
  }

  const tenant = await prisma.tenant.findUnique({
    where: { slug: DEMO_SLUG },
    select: { id: true, name: true },
  });
  if (!tenant) throw new Error(`Boutique « ${DEMO_SLUG} » introuvable. Lancez d abord npm run seed:demo.`);

  const agent = await prisma.membership.findFirst({
    where: { tenantId: tenant.id },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  // --- 1. Purge -------------------------------------------------------------
  // L'ordre suit les dependances : ce qui pointe vers une commande part avant
  // elle. `deleteMany` sur la commande ne suffirait pas pour les relations en
  // `Restrict`, et masquerait l'erreur derriere un echec de contrainte.
  const before = await prisma.order.count({ where: { tenantId: tenant.id } });

  await prisma.$transaction([
    prisma.orderDuplicateFlag.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.returnItem.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.return.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.shipmentEvent.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.shipment.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.orderCallAttempt.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.orderStatusHistory.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.sheetRowImport.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.orderItem.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.order.deleteMany({ where: { tenantId: tenant.id } }),
    // Les compteurs resumaient des commandes qui n'existent plus.
    prisma.customer.updateMany({
      where: { tenantId: tenant.id },
      data: {
        ordersCount: 0,
        deliveredCount: 0,
        cancelledCount: 0,
        refusedCount: 0,
        returnedCount: 0,
        unreachableCount: 0,
        consecutiveFailures: 0,
        reliabilityScore: null,
        reliabilityTier: 'UNKNOWN',
        lastOrderAt: null,
      },
    }),
  ]);

  // --- 2. Catalogue ---------------------------------------------------------
  const variants = await prisma.productVariant.findMany({
    where: { tenantId: tenant.id, isActive: true },
    select: {
      id: true,
      sku: true,
      label: true,
      salePriceCentimes: true,
      purchasePriceCentimes: true,
      product: { select: { name: true, salePriceCentimes: true, purchasePriceCentimes: true } },
    },
  });
  if (variants.length === 0) throw new Error('Aucune declinaison active : le catalogue est vide.');

  // --- 3. Trente commandes a confirmer -------------------------------------
  const now = Date.now();
  const created: string[] = [];

  for (let index = 0; index < QUEUE_SIZE; index += 1) {
    const person = PEOPLE[index % PEOPLE.length]!;
    const variant = variants[index % variants.length]!;
    // Une commande sur cinq porte deux articles : la file doit montrer aussi
    // bien la ligne simple que la ligne multiple.
    const quantity = index % 5 === 0 ? 2 : 1;

    const unitPrice = variant.salePriceCentimes ?? variant.product.salePriceCentimes;
    const unitPurchase = variant.purchasePriceCentimes ?? variant.product.purchasePriceCentimes;
    const itemsTotal = unitPrice * quantity;

    const customer = await prisma.customer.upsert({
      where: { tenantId_phoneE164: { tenantId: tenant.id, phoneE164: toE164(person.phone) } },
      create: {
        tenantId: tenant.id,
        fullName: person.name,
        phoneE164: toE164(person.phone),
        phoneRaw: person.phone,
      },
      update: { fullName: person.name },
      select: { id: true },
    });

    const address = await prisma.address.findFirst({
      where: { tenantId: tenant.id, customerId: customer.id },
      select: { id: true },
    });
    const addressId =
      address?.id ??
      (
        await prisma.address.create({
          data: {
            tenantId: tenant.id,
            customerId: customer.id,
            wilayaCode: person.wilayaCode,
            wilayaName: person.wilayaName,
            commune: person.commune,
            addressText: person.address,
            isDefault: true,
          },
          select: { id: true },
        })
      ).id;

    // Etalees sur trois jours : la file doit avoir une anciennete credible,
    // et le tri par date quelque chose a trier.
    const orderedAt = new Date(now - (index * 2 + 1) * HOUR);
    const year = orderedAt.getUTCFullYear();
    const sequence = await prisma.orderSequence.upsert({
      where: { tenantId_year: { tenantId: tenant.id, year } },
      create: { tenantId: tenant.id, year, lastValue: 1 },
      update: { lastValue: { increment: 1 } },
      select: { lastValue: true },
    });

    const order = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        reference: `ORD-${year}-${String(sequence.lastValue).padStart(6, '0')}`,
        source: index % 3 === 0 ? 'MANUAL' : 'GOOGLE_SHEETS',
        // TOUTES a confirmer : c'est l'etat d'entree dans la file, celui qui
        // se prete au test demande — ouvrir, decider, voir partir.
        status: 'TO_CONFIRM',
        customerId: customer.id,
        addressId,
        customerNameSnapshot: person.name,
        phoneSnapshot: toE164(person.phone),
        wilayaCodeSnapshot: person.wilayaCode,
        communeSnapshot: person.commune,
        addressSnapshot: person.address,
        itemsTotalCentimes: itemsTotal,
        deliveryFeeCentimes: DELIVERY_FEE_CENTIMES,
        totalCentimes: itemsTotal + DELIVERY_FEE_CENTIMES,
        callAttemptsCount: 0,
        nextCallbackAt: null,
        assignedMembershipId: agent?.id ?? null,
        confirmationChannel: 'HUMAN_AGENT',
        deliveryType: index % 6 === 0 ? 'PICKUP_POINT' : 'HOME',
        stockReserved: false,
        orderedAt,
        createdAt: orderedAt,
        items: {
          create: {
            tenantId: tenant.id,
            variantId: variant.id,
            productNameSnapshot: variant.product.name,
            skuSnapshot: variant.sku,
            variantLabelSnapshot: variant.label,
            quantity,
            unitPriceCentimes: unitPrice,
            unitPurchasePriceCentimes: unitPurchase,
            discountCentimes: 0,
            lineTotalCentimes: itemsTotal,
          },
        },
      },
      select: { reference: true },
    });

    await prisma.customer.update({
      where: { id: customer.id },
      data: { ordersCount: { increment: 1 }, lastOrderAt: orderedAt },
    });

    created.push(order.reference);
  }

  console.log('File de confirmation reinitialisee');
  console.log('---------------------------------');
  console.log(`  Boutique          : ${tenant.name}`);
  console.log(`  Commandes purgees : ${before}`);
  console.log(`  Commandes creees  : ${created.length} (toutes A CONFIRMER)`);
  console.log(`  References        : ${created[0]} -> ${created[created.length - 1]}`);
}

/** Forme E.164 attendue en base : +213 suivi du numero sans son 0 initial. */
function toE164(national: string): string {
  return `+213${national.replace(/\D/g, '').replace(/^0/, '')}`;
}

main()
  .catch((error: unknown) => {
    console.error('ECHEC :', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
