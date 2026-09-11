/**
 * DTO de requete transverses : pagination, tri, periode.
 *
 * La pagination est TOUJOURS cote serveur (V2 §22) et bornee : sans plafond,
 * un `pageSize=100000` transformerait chaque appel en denis de service
 * involontaire.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@ecomflow/shared';
import { asPrimitiveString } from '../utils/text';

export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1, description: 'Page, 1-indexee.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    description: `Taille de page. Plafonnee a ${MAX_PAGE_SIZE}.`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number = DEFAULT_PAGE_SIZE;
}

export class SortQueryDto {
  @ApiPropertyOptional({ description: 'Champ de tri.' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc' = 'desc';
}

/** Convertit une chaine ISO ou `AAAA-MM-JJ` en Date. */
const toDate = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') return undefined;
  // Une valeur non primitive (`?from[gte]=x`) est renvoyee telle quelle : le
  // validateur la refusera avec un message clair, plutot que de la convertir
  // en « [object Object] » puis en date invalide.
  const raw = asPrimitiveString(value);
  if (raw === null) return value;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? value : parsed;
};

export class DateRangeQueryDto {
  @ApiPropertyOptional({
    description: 'Debut de periode (ISO 8601). Par defaut : il y a 30 jours.',
    example: '2026-08-01',
  })
  @IsOptional()
  @Transform(toDate)
  @IsDate({ message: 'Date de debut invalide.' })
  from?: Date;

  @ApiPropertyOptional({
    description: 'Fin de periode (ISO 8601). Par defaut : maintenant.',
    example: '2026-08-31',
  })
  @IsOptional()
  @Transform(toDate)
  @IsDate({ message: 'Date de fin invalide.' })
  to?: Date;
}

/** Transforme `?status=A,B` ou `?status=A&status=B` en tableau. */
export const toStringArray = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') return undefined;

  // `?status=A&status=B` arrive sous forme de tableau, `?status=A,B` sous
  // forme de chaine. Une entree non primitive est ecartee : le validateur
  // `@IsIn` la refuserait de toute facon, autant ne pas la transformer en
  // « [object Object] » au passage.
  if (Array.isArray(value)) {
    return value
      .map((entry) => asPrimitiveString(entry)?.trim())
      .filter((entry): entry is string => Boolean(entry));
  }

  const raw = asPrimitiveString(value);
  if (raw === null) return value;

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

export class SearchQueryDto {
  @ApiPropertyOptional({
    description:
      'Recherche globale : reference, nom, telephone, tracking, SKU, produit, commune.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

/**
 * Selection de lignes a archiver, commune aux ecrans de liste.
 *
 * Le meme geste — cocher des lignes, archiver la selection — existe sur les
 * commandes, les clients et les produits. Un DTO unique evite que la borne
 * haute et le message d'erreur divergent d'un ecran a l'autre.
 */
export class BulkArchiveDto {
  @ApiProperty({
    type: [String],
    description:
      'Identifiants des lignes a archiver. Le lot est plafonne : au-dela, ' +
      'la selection releve d un filtre, pas d un clic.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Selectionnez au moins une ligne.' })
  @ArrayMaxSize(200, {
    message: 'Selection trop large : archivez par lots de 200 au maximum.',
  })
  @IsUUID('7', { each: true })
  ids!: string[];
}
