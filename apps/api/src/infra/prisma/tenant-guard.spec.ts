/**
 * Contrat de classification des modeles vis-a-vis du multi-tenant.
 *
 * POURQUOI CE TEST EXISTE
 *   `tenant-scoped-models.ts` se declare lui-meme « verifie par un test
 *   unitaire (tenant-guard.spec.ts) qui compare son contenu au modele Prisma
 *   reel ». Ce test n'existait pas. La garantie annoncee en tete du fichier —
 *   « il est donc impossible d'ajouter une table portant des donnees de
 *   boutique sans decider consciemment de son perimetre » — n'etait donc pas
 *   tenue : un modele oublie dans la liste n'aurait fait echouer aucune suite.
 *
 *   Or l'oubli est SILENCIEUX et grave. Le garde d'isolation ne connait que
 *   trois familles (scope / optionnel / global) ; un modele absent des trois
 *   n'est pas refuse par defaut, il est simplement inconnu — donc non filtre.
 *   C'est exactement le mode de defaillance que D-004 dit vouloir rendre
 *   impossible.
 *
 * COMMENT IL S'Y PREND
 *   La source de verite est `schema.prisma`, lu comme un fichier texte plutot
 *   que via `Prisma.dmmf`. C'est deliberé : le test doit pouvoir echouer sur
 *   une machine ou `prisma generate` n'a pas encore tourne, c'est-a-dire
 *   precisement au moment ou l'on vient d'ajouter un modele.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ALL_CLASSIFIED_MODELS,
  GLOBAL_MODELS,
  TENANT_OPTIONAL_MODELS,
  TENANT_SCOPED_MODELS,
} from './tenant-scoped-models';

const SCHEMA_PATH = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma');

const schema = readFileSync(SCHEMA_PATH, 'utf8');

/** Noms des modeles declares dans le schema, dans leur ordre d'apparition. */
function declaredModels(source: string): string[] {
  return [...source.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
}

/**
 * Modeles dont le bloc porte une colonne `tenantId` NON NULLE.
 * `tenantId String?` (nullable) est volontairement exclu : ces modeles-la
 * relevent de `TENANT_OPTIONAL_MODELS`.
 */
function modelsWithNonNullTenantId(source: string): string[] {
  const result: string[] = [];

  for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    if (/^\s*tenantId\s+String\s+/m.test(body ?? '')) result.push(name);
  }

  return result;
}

const models = declaredModels(schema);

describe('classification multi-tenant des modeles', () => {
  it('lit bien le schema Prisma', () => {
    // Garde-fou : si le chemin ou la syntaxe changent, ce test doit le dire
    // franchement plutot que de valider une liste vide.
    expect(models.length).toBeGreaterThan(50);
    expect(models).toContain('Order');
  });

  it('classe explicitement chaque modele du schema', () => {
    const classified = new Set<string>(ALL_CLASSIFIED_MODELS);
    const unclassified = models.filter((model) => !classified.has(model));

    expect(unclassified).toEqual([]);
  });

  it('ne classe aucun modele qui n existe plus dans le schema', () => {
    const declared = new Set(models);
    const orphans = ALL_CLASSIFIED_MODELS.filter((model) => !declared.has(model));

    expect(orphans).toEqual([]);
  });

  it('ne range un modele que dans une seule famille', () => {
    const seen = new Map<string, number>();
    for (const model of ALL_CLASSIFIED_MODELS) {
      seen.set(model, (seen.get(model) ?? 0) + 1);
    }

    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([model]) => model);

    expect(duplicated).toEqual([]);
  });

  it('scope tout modele portant un tenantId non nul', () => {
    const scoped = new Set<string>(TENANT_SCOPED_MODELS);
    // Un modele porteur de donnees de boutique qui aurait ete range parmi les
    // globaux : la faute exacte que D-004 rend couteuse a commettre.
    const misplaced = modelsWithNonNullTenantId(schema).filter((model) => !scoped.has(model));

    expect(misplaced).toEqual([]);
  });

  /**
   * Un modele GLOBAL peut legitimement porter un `tenantId` NULLABLE : la
   * colonne sert alors de renseignement (« a quelle boutique cet evenement
   * s'est-il avere appartenir ? »), pas de perimetre de lecture.
   *
   * Le seul cas admis aujourd'hui est `ProcessedWebhook`, dont la
   * deduplication doit avoir lieu AVANT que le tenant soit resolu — le filtrer
   * par tenant reviendrait a ne pas pouvoir le lire au moment ou l'on en a
   * besoin. L'exception est listee ici nommement : en ajouter une autre est un
   * acte conscient, qui passe par ce fichier.
   */
  const GLOBAL_MODELS_WITH_NULLABLE_TENANT: readonly string[] = ['ProcessedWebhook'];

  it('ne declare global aucun modele portant un tenantId NON NUL', () => {
    const nonNull = new Set(modelsWithNonNullTenantId(schema));
    const suspicious = GLOBAL_MODELS.filter((model) => nonNull.has(model));

    expect(suspicious).toEqual([]);
  });

  it('n admet un tenantId nullable sur un modele global que par exception listee', () => {
    const withTenantColumn = new Set(
      [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)]
        .filter(([, , body]) => /^\s*tenantId\s+String/m.test(body ?? ''))
        .map(([, name]) => name),
    );

    const undocumented = GLOBAL_MODELS.filter(
      (model) =>
        withTenantColumn.has(model) && !GLOBAL_MODELS_WITH_NULLABLE_TENANT.includes(model),
    );

    expect(undocumented).toEqual([]);
  });

  it('n admet en optionnel que des modeles a tenantId nullable', () => {
    const nullable = new Set(
      [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)]
        .filter(([, , body]) => /^\s*tenantId\s+String\?/m.test(body ?? ''))
        .map(([, name]) => name),
    );

    const wrong = TENANT_OPTIONAL_MODELS.filter((model) => !nullable.has(model));

    expect(wrong).toEqual([]);
  });
});
