/**
 * Gabarit d'import de commandes au format Excel.
 *
 * POURQUOI LE PRODUIRE PLUTOT QUE DE SERVIR UN FICHIER FIGE
 *   Un gabarit statique se desynchronise du referentiel des le premier
 *   decoupage administratif. Celui-ci embarque les wilayas et les communes
 *   REELLEMENT en base au moment du telechargement, et les listes de validation
 *   d'Excel pointent dessus : le commercant ne peut pas saisir une wilaya qui
 *   n'existe pas, et n'a pas a deviner l'orthographe d'une commune.
 *
 * LA VALIDATION EXCEL EST UNE AIDE, PAS UNE BARRIERE
 *   Elle porte sur la colonne Wilaya, ou le referentiel fait autorite (D-018).
 *   Elle ne porte PAS sur la commune : la liste des communes d'une wilaya
 *   dependrait de la ligne, ce qu'Excel ne sait exprimer que par des formules
 *   fragiles — et surtout, D-018 refuse de rejeter une commune inconnue. Les
 *   communes sont donc fournies en FEUILLE DE REFERENCE, consultable, sans
 *   contrainte sur la saisie.
 */

import { Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { WILAYAS } from '@ecomflow/shared';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';

/**
 * Colonnes du gabarit, dans l'ordre.
 *
 * Les intitules portent l'asterisque des champs OBLIGATOIRES — c'est la
 * convention du classeur de reference du metier, et la seule indication que le
 * commercant voit en ouvrant le fichier.
 */
const COLUMNS: readonly { header: string; width: number; hint?: string }[] = [
  { header: 'Client*', width: 24 },
  { header: 'Téléphone*', width: 16, hint: '0555 12 34 56' },
  { header: 'Téléphone 2', width: 16 },
  { header: 'Wilaya*', width: 20 },
  { header: 'Commune', width: 20 },
  { header: 'Adresse', width: 34 },
  { header: 'Remarque', width: 28 },
  { header: 'Produit (SKU)*', width: 18 },
  { header: 'Quantité*', width: 10 },
  { header: 'Prix unitaire', width: 14, hint: 'En dinars' },
  { header: 'Frais de livraison', width: 16, hint: 'En dinars' },
  { header: 'Réduction', width: 12, hint: 'En dinars' },
  { header: 'Référent', width: 16 },
  { header: 'Stop desk', width: 12, hint: 'Oui / Non' },
];

@Injectable()
export class OrderTemplateService {
  constructor(@InjectPrisma() private readonly prisma: PrismaClientExtended) {}

  async build(): Promise<Buffer> {
    const workbook = new Workbook();
    workbook.creator = 'EcomFlow';
    workbook.created = new Date();

    // --- Feuille de saisie ---------------------------------------------------
    const orders = workbook.addWorksheet('Commandes', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    orders.columns = COLUMNS.map((column) => ({
      header: column.header,
      key: column.header,
      width: column.width,
    }));

    const header = orders.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: 'middle' };

    // L'indication d'unite vit dans le commentaire de l'en-tete, pas dans une
    // ligne d'exemple : une ligne d'exemple finit toujours par etre importee.
    COLUMNS.forEach((column, index) => {
      if (!column.hint) return;
      header.getCell(index + 1).note = column.hint;
    });

    // --- Feuilles de reference ----------------------------------------------
    const wilayaSheet = workbook.addWorksheet('Wilayas');
    wilayaSheet.columns = [
      { header: 'Code', key: 'code', width: 8 },
      { header: 'Nom', key: 'name', width: 24 },
    ];
    wilayaSheet.getRow(1).font = { bold: true };
    for (const wilaya of WILAYAS) {
      wilayaSheet.addRow({ code: wilaya.code2, name: wilaya.name });
    }

    const communes = await this.prisma.commune.findMany({
      where: { isActive: true },
      orderBy: [{ wilayaCode: 'asc' }, { name: 'asc' }],
      select: { wilayaCode: true, name: true },
    });

    const wilayaNameByCode = new Map(WILAYAS.map((wilaya) => [wilaya.code, wilaya.name]));

    const communeSheet = workbook.addWorksheet('Communes');
    communeSheet.columns = [
      { header: 'Commune', key: 'commune', width: 26 },
      { header: 'Wilaya', key: 'wilaya', width: 24 },
    ];
    communeSheet.getRow(1).font = { bold: true };
    for (const commune of communes) {
      communeSheet.addRow({
        commune: commune.name,
        wilaya: wilayaNameByCode.get(commune.wilayaCode) ?? '',
      });
    }

    // --- Validation de la colonne Wilaya -------------------------------------
    // Bornee a mille lignes : au-dela, un import releve d'une integration, pas
    // d'un classeur, et poser la validation sur le million de lignes d'une
    // feuille alourdit le fichier pour rien.
    const wilayaColumn = COLUMNS.findIndex((column) => column.header === 'Wilaya*') + 1;
    const letter = orders.getColumn(wilayaColumn).letter;

    for (let row = 2; row <= 1000; row += 1) {
      orders.getCell(`${letter}${row}`).dataValidation = {
        type: 'list',
        allowBlank: false,
        // La plage vise les NOMS de la feuille Wilayas, pas les codes : c'est
        // le nom que le commercant reconnait, et `resolveWilaya` sait le lire.
        formulae: [`=Wilayas!$B$2:$B$${WILAYAS.length + 1}`],
        showErrorMessage: true,
        errorTitle: 'Wilaya inconnue',
        error: 'Choisissez une wilaya dans la liste proposée.',
      };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
