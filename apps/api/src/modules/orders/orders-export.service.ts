/**
 * Export de commandes au format Excel.
 *
 * POURQUOI UN EXPORT PAR SELECTION, ET NON « exporter tout »
 *   L'export sert a emporter un travail en cours — la tournee du jour, les
 *   commandes d'une wilaya, celles qu'on vient de preparer — vers un tiers qui
 *   n'a pas acces au produit : un livreur, un comptable, un associe. « Tout
 *   exporter » repondrait a une autre question, et produirait un fichier que
 *   personne ne relit.
 *
 *   La selection est donc explicite. Elle est plafonnee comme les autres lots :
 *   au-dela, l'export releve d'un traitement de fond, pas d'un clic.
 *
 * LES MONTANTS SORTENT EN DINARS, PAS EN CENTIMES
 *   Le produit stocke des centimes entiers (D-002) parce que c'est la seule
 *   representation exacte. Mais un classeur ouvert dans Excel est lu par un
 *   humain, et « 450000 » pour quatre mille cinq cents dinars se lit mal et se
 *   recopie encore plus mal. La conversion a lieu ICI, au dernier moment, et
 *   nulle part ailleurs.
 *
 * CE N'EST PAS LE GABARIT D'IMPORT
 *   `OrderTemplateService` produit un classeur VIDE a remplir, avec ses listes
 *   de validation. Celui-ci produit des donnees existantes, avec des colonnes
 *   differentes — reference, statut, dates. Les fondre obligerait a inventer un
 *   format qui ne servirait bien ni a l'un ni a l'autre.
 */

import { Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { centimesToDinars, getWilayaByCode } from '@ecomflow/shared';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';

const COLUMNS: readonly { header: string; key: string; width: number }[] = [
  { header: 'Référence', key: 'reference', width: 20 },
  { header: 'Statut', key: 'status', width: 18 },
  { header: 'Client', key: 'customer', width: 24 },
  { header: 'Téléphone', key: 'phone', width: 16 },
  { header: 'Wilaya', key: 'wilaya', width: 20 },
  { header: 'Commune', key: 'commune', width: 20 },
  { header: 'Adresse', key: 'address', width: 34 },
  { header: 'Articles', key: 'items', width: 40 },
  { header: 'Total (DA)', key: 'total', width: 14 },
  { header: 'Livraison (DA)', key: 'delivery', width: 14 },
  { header: 'Mode', key: 'deliveryType', width: 12 },
  { header: 'Commandée le', key: 'orderedAt', width: 18 },
  { header: 'Confirmée le', key: 'confirmedAt', width: 18 },
];

@Injectable()
export class OrdersExportService {
  constructor(@InjectPrisma() private readonly prisma: PrismaClientExtended) {}

  async buildXlsx(tenantId: string, orderIds: readonly string[]): Promise<Buffer> {
    const orders = await this.prisma.order.findMany({
      where: { tenantId, id: { in: [...orderIds] } },
      orderBy: { orderedAt: 'asc' },
      select: {
        reference: true,
        status: true,
        customerNameSnapshot: true,
        phoneSnapshot: true,
        wilayaCodeSnapshot: true,
        communeSnapshot: true,
        addressSnapshot: true,
        totalCentimes: true,
        deliveryFeeCentimes: true,
        deliveryType: true,
        orderedAt: true,
        confirmedAt: true,
        items: { select: { skuSnapshot: true, quantity: true } },
      },
    });

    const workbook = new Workbook();
    workbook.creator = 'EcomFlow';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Commandes', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    sheet.columns = COLUMNS.map((column) => ({ ...column }));
    sheet.getRow(1).font = { bold: true };

    for (const order of orders) {
      const wilaya = order.wilayaCodeSnapshot
        ? getWilayaByCode(order.wilayaCodeSnapshot)
        : undefined;

      sheet.addRow({
        reference: order.reference,
        status: order.status,
        customer: order.customerNameSnapshot,
        // Le telephone est ecrit en TEXTE : « 0555123456 » saisi comme nombre
        // perd son zero initial a l'ouverture, et un numero ampute ne se
        // rattrape pas — c'est la seule donnee du fichier qui sert a joindre
        // quelqu'un.
        phone: order.phoneSnapshot,
        wilaya: wilaya ? `${wilaya.code2} ${wilaya.name}` : '',
        commune: order.communeSnapshot ?? '',
        address: order.addressSnapshot ?? '',
        items: order.items.map((item) => `${item.quantity}x ${item.skuSnapshot}`).join(', '),
        total: centimesToDinars(order.totalCentimes),
        delivery: centimesToDinars(order.deliveryFeeCentimes),
        deliveryType: order.deliveryType === 'PICKUP_POINT' ? 'Bureau' : 'Domicile',
        orderedAt: order.orderedAt,
        confirmedAt: order.confirmedAt ?? '',
      });
    }

    const phoneColumn = COLUMNS.findIndex((column) => column.key === 'phone') + 1;
    sheet.getColumn(phoneColumn).numFmt = '@';

    for (const key of ['orderedAt', 'confirmedAt']) {
      const index = COLUMNS.findIndex((column) => column.key === key) + 1;
      sheet.getColumn(index).numFmt = 'dd/mm/yyyy hh:mm';
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
}
