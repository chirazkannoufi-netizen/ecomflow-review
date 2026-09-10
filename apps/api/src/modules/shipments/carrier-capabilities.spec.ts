/**
 * Alignement entre la matrice de capacites en base et la liste exposee.
 *
 * CE QUE CE TEST EMPECHE
 *   Ajouter une colonne a `CarrierCapability` sans l'ajouter a
 *   `CARRIER_CAPABILITY_KEYS`. Le defaut serait INVISIBLE : la capacite
 *   existerait en base, serait renseignee par le seed, et n'apparaitrait
 *   simplement jamais a l'ecran. Personne ne cherche un bouton qu'on ne lui a
 *   jamais montre.
 *
 *   Et la reciproque : une cle exposee sans colonne correspondante produirait
 *   une capacite affichee comme absente pour tous les transporteurs, ce qui
 *   ferait masquer une action pourtant disponible.
 *
 * POURQUOI LIRE LE SCHEMA PLUTOT QUE `Prisma.dmmf`
 *   Meme raison que `tenant-guard.spec.ts` : le test doit pouvoir echouer sur
 *   une machine ou `prisma generate` n'a pas encore tourne, c'est-a-dire juste
 *   apres avoir ajoute la colonne.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CARRIER_CAPABILITY_KEYS } from './shipments.service';

const SCHEMA_PATH = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma');
const schema = readFileSync(SCHEMA_PATH, 'utf8');

/** Champs booleens declares dans le modele `CarrierCapability`. */
function capabilityColumns(source: string): string[] {
  const model = /^model\s+CarrierCapability\s*\{([\s\S]*?)^\}/m.exec(source);
  if (!model) throw new Error('Modele CarrierCapability introuvable dans schema.prisma.');

  return [...(model[1] ?? '').matchAll(/^\s*(\w+)\s+Boolean\b/gm)].map((match) => match[1]);
}

describe('matrice de capacites transporteur', () => {
  const columns = capabilityColumns(schema);

  it('declare bien dix-sept capacites en base', () => {
    // Le nombre est fige volontairement : en ajouter une doit etre un acte
    // conscient, qui passe par ce test ET par chaque adaptateur.
    expect(columns).toHaveLength(17);
  });

  it('expose exactement les colonnes du schema', () => {
    expect([...CARRIER_CAPABILITY_KEYS].sort()).toEqual([...columns].sort());
  });

  it('n expose aucune cle en double', () => {
    expect(new Set(CARRIER_CAPABILITY_KEYS).size).toBe(CARRIER_CAPABILITY_KEYS.length);
  });
});
