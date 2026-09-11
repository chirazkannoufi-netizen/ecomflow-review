/**
 * Referentiel geographique — lecture seule.
 *
 * DEUX REFERENTIELS, DEUX DOMICILES, UNE SEULE AUTORITE PAR NIVEAU
 *   Les wilayas viennent de `@ecomflow/shared` : elles sont lues a chaque ligne
 *   d'import pour resoudre « Algiers » ou « BBA » en un code, et ce travail
 *   doit rester synchrone (D-018). Les communes viennent de la base : elles
 *   servent a remplir une liste, et 1541 entrees n'ont rien a faire dans le
 *   bundle de chaque page du produit.
 *
 *   Ce service est l'endroit ou les deux se rejoignent, pour que personne
 *   d'autre n'ait a savoir lequel vient d'ou.
 *
 * AUCUNE VALIDATION ICI
 *   Le referentiel ASSISTE la saisie, il ne la ferme pas. Une commune absente
 *   de la table reste une commune acceptable — voir D-018 et le commentaire du
 *   modele `Commune`.
 */

import { Injectable } from '@nestjs/common';
import { WILAYAS, normalizeGeoName, type Wilaya } from '@ecomflow/shared';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';

export interface CommuneItem {
  readonly id: string;
  readonly name: string;
  readonly wilayaCode: number;
}

@Injectable()
export class GeoService {
  constructor(@InjectPrisma() private readonly prisma: PrismaClientExtended) {}

  /** Les 58 wilayas du decoupage de 2019, dans l'ordre des codes. */
  listWilayas(): readonly Wilaya[] {
    return WILAYAS;
  }

  /**
   * Communes d'une wilaya, par ordre alphabetique.
   *
   * Renvoie une liste VIDE plutot qu'une erreur pour une wilaya sans commune
   * connue : c'est un referentiel incomplet, pas une requete invalide, et
   * l'ecran doit pouvoir retomber sur une saisie libre.
   */
  async listCommunes(wilayaCode: number): Promise<readonly CommuneItem[]> {
    const rows = await this.prisma.commune.findMany({
      where: { wilayaCode, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, wilayaCode: true },
    });

    return rows;
  }

  /**
   * Rapproche un libelle saisi ou importe d'une commune connue.
   *
   * Retourne le libelle DE REFERENCE quand le rapprochement aboutit, et le
   * libelle d'origine sinon — jamais `null`. C'est la traduction en code de
   * D-018 : on corrige l'orthographe quand on sait le faire, on ne refuse
   * jamais une commande parce qu'on ne sait pas.
   */
  async resolveCommuneName(wilayaCode: number, input: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) return trimmed;

    const match = await this.prisma.commune.findUnique({
      where: {
        wilayaCode_searchName: { wilayaCode, searchName: normalizeGeoName(trimmed) },
      },
      select: { name: true },
    });

    return match?.name ?? trimmed;
  }
}
