/**
 * Garde-fou des catalogues de traduction.
 *
 * CE QUE CE TEST EMPECHE CONCRETEMENT
 *   Ajouter une cle en francais sans son equivalent arabe. Le defaut ne se
 *   verrait pas a la compilation, ni au premier coup d'oeil : il n'apparaitrait
 *   qu'a l'ecran d'un utilisateur arabophone, sous la forme d'une cle brute
 *   (« orders.title ») au milieu d'une page traduite.
 *
 *   C'est exactement le mode de degradation d'une traduction « partielle », que
 *   la mission interdit : l'arabe doit etre une seconde langue COMPLETE.
 */

import ar from './messages/ar.json';
import fr from './messages/fr.json';

type Tree = { [key: string]: string | Tree };

/** Aplatit un catalogue en chemins pointes : `orders.columns.total`. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();

  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      result.set(path, value);
    } else {
      for (const [nested, nestedValue] of flatten(value, path)) {
        result.set(nested, nestedValue);
      }
    }
  }

  return result;
}

/** Extrait les variables ICU d'un message : `{count}`, `{name}`… */
function placeholders(message: string): Set<string> {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{\s*(\w+)\s*[,}]/g)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return names;
}

const french = flatten(fr);
const arabic = flatten(ar);

describe('catalogues de traduction', () => {
  it('couvre un nombre significatif de messages', () => {
    // Garde-fou grossier : si ce nombre s'effondre, c'est qu'un catalogue a
    // ete tronque par une mauvaise fusion.
    expect(french.size).toBeGreaterThan(400);
  });

  it('ne laisse aucune cle francaise sans traduction arabe', () => {
    const missing = [...french.keys()].filter((key) => !arabic.has(key));

    expect(missing).toEqual([]);
  });

  it('ne contient aucune cle arabe orpheline', () => {
    // Une cle arabe sans equivalent francais est du code mort : elle signale
    // une cle renommee d'un seul cote.
    const orphans = [...arabic.keys()].filter((key) => !french.has(key));

    expect(orphans).toEqual([]);
  });

  it('n a aucun message vide', () => {
    const empty = [...french.entries(), ...arabic.entries()]
      .filter(([, value]) => value.trim().length === 0)
      .map(([key]) => key);

    expect(empty).toEqual([]);
  });

  it('utilise les memes variables dans les deux langues', () => {
    // Une variable oubliee cote arabe produirait un message ampute — par
    // exemple « الطلبات » sans le nombre — sans jamais lever d'erreur.
    const mismatched: string[] = [];

    for (const [key, frenchValue] of french) {
      const arabicValue = arabic.get(key);
      if (arabicValue === undefined) continue;

      const expected = [...placeholders(frenchValue)].sort();
      const actual = [...placeholders(arabicValue)].sort();

      if (expected.join(',') !== actual.join(',')) {
        mismatched.push(`${key} : fr[${expected.join(', ')}] vs ar[${actual.join(', ')}]`);
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('couvre les six formes plurielles arabes la ou le francais en a deux', () => {
    // L'arabe distingue zero, one, two, few, many, other. Reprendre telle
    // quelle la forme francaise (one/other) donnerait des accords faux pour
    // 2, 3 et 11 elements — les cas les plus frequents en exploitation.
    const pluralKeys = [...french.entries()]
      .filter(([, value]) => value.includes(', plural,'))
      .map(([key]) => key);

    expect(pluralKeys.length).toBeGreaterThan(5);

    const incomplete = pluralKeys.filter((key) => {
      const value = arabic.get(key) ?? '';
      return !['one', 'two', 'few', 'many', 'other'].every((form) =>
        new RegExp(`\\b${form}\\s*\\{`).test(value),
      );
    });

    expect(incomplete).toEqual([]);
  });

  it('traduit reellement en arabe, sans copie du francais', () => {
    // Une valeur identique dans les deux catalogues trahit un copier-coller
    // oublie. Les exceptions legitimes sont listees : marques, symboles et
    // libelles de langue ecrits dans leur propre alphabet.
    const allowed = new Set([
      'common.appName',
      'common.none',
      'language.fr',
      'language.ar',
      'integrations.googleTitle',
      'subscription.baridimob',
    ]);

    const untranslated = [...french.entries()]
      .filter(([key, value]) => !allowed.has(key) && arabic.get(key) === value)
      .map(([key]) => key);

    expect(untranslated).toEqual([]);
  });

  it('ecrit les messages arabes en alphabet arabe', () => {
    const arabicScript = /[؀-ۿ]/;

    // Ce qui NE compte pas comme du texte a traduire :
    //   - les variables ICU (`{status}`), qui portent une donnee ;
    //   - les noms propres et marques (Google Sheets, CIB, EcomFlow…) ;
    //   - la ponctuation, les fleches et les symboles.
    // Un message reduit a cela apres nettoyage n'a rien a traduire : c'est le
    // cas de « ← {status} ». On ne signale donc que du texte LATIN residuel.
    const PROPER_NOUNS =
      /EcomFlow|Google|Sheets|SKU|OAuth|GOOGLE_[A-Z_]+|Chargily|CIB|BaridiMob|API/g;

    function translatableRemainder(value: string): string {
      return value
        .replace(/\{[^}]*\}/g, ' ')
        .replace(PROPER_NOUNS, ' ')
        .replace(/[^A-Za-zÀ-ÿ]/g, '');
    }

    // Seule exception assumee : le selecteur de langue nomme chaque langue
    // DANS SON PROPRE alphabet. « Francais » doit rester lisible tel quel pour
    // qu'un francophone perdu dans une interface arabe puisse revenir.
    const selfNamed = new Set(['language.fr']);

    const untranslated = [...arabic.entries()]
      .filter(([key]) => !selfNamed.has(key))
      .filter(([, value]) => !arabicScript.test(value))
      .filter(([, value]) => translatableRemainder(value).length > 0)
      .map(([key]) => key);

    expect(untranslated).toEqual([]);
  });
});
