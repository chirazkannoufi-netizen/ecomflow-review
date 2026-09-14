/**
 * Les deux familles de transporteurs, et ZR Express — contre un `fetch` double.
 *
 * CE QUE CES TESTS PROTEGENT, ET CE QU'ILS NE PROUVENT PAS
 *   Ils figent ce que NOUS envoyons et ce que nous faisons de la reponse :
 *   chemins, en-tetes, noms de champs, normalisation des statuts, traitement
 *   des refus. C'est tout ce qu'on peut tenir sans compte marchand.
 *
 *   Ils ne prouvent PAS que ces API existent sous cette forme : les points
 *   d'entree viennent d'integrations open-source concordantes, pas de la
 *   documentation des transporteurs. C'est exactement ce que le statut
 *   UNVERIFIED du catalogue dit (D-070) — et ces tests sont ce qui rendra la
 *   premiere confrontation a un vrai compte LISIBLE : si un champ est refuse,
 *   le test qui le fige nommera le champ.
 *
 * POURQUOI DOUBLER `fetch` ET NON LE CLIENT HTTP
 *   Les adaptateurs appellent `fetch` directement. Doubler la couche que le
 *   code utilise reellement teste le code reel ; doubler une abstraction
 *   qu'il n'a pas testerait l'abstraction.
 */

import { EcotrackAdapter, ECOTRACK_TENANTS } from './ecotrack.adapter';
import { ZrExpressAdapter } from './zr-express.adapter';
import { YalidineFamilyAdapter, YALIDINE_RESELLERS, YALIDINE_IDENTITY } from './yalidine.adapter';
import type { CarrierContext, ShipmentRequest } from './carrier-adapter.interface';

// ---------------------------------------------------------------------------
// Outillage
// ---------------------------------------------------------------------------

type FetchCall = { url: string; headers: Record<string, string>; body: string };

let calls: FetchCall[] = [];

/** Reponse HTTP minimale, telle que les adaptateurs la consomment. */
function reply(body: unknown, status = 200): Response {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(raw) as unknown,
    text: async () => raw,
  } as unknown as Response;
}

function mockFetch(...responses: Response[]): void {
  const queue = [...responses];
  global.fetch = jest.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // Le corps et les en-tetes sont figes A L'APPEL : un test qui les relirait
    // plus tard lirait un objet que l'adaptateur a pu recycler entre-temps.
    calls.push({
      url: requestedUrl(input),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === 'string' ? init.body : '{}',
    });
    return queue.shift() ?? reply({});
  });
}

/** `fetch` accepte trois formes d'adresse ; nos adaptateurs n'en passent qu'une. */
function requestedUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function context(credentials: Record<string, string>): CarrierContext {
  return { credentials, config: {} };
}

const ORDER: ShipmentRequest = {
  idempotencyKey: 'cle-idempotence',
  orderReference: 'CMD-2026-000042',
  customerName: 'Amine Belkacem',
  phoneE164: '+213661234567',
  secondaryPhone: null,
  wilayaCode: 16,
  wilayaName: 'Alger',
  commune: 'Bab Ezzouar',
  addressText: '12 rue des Freres',
  deliveryType: 'HOME',
  pickupPointId: null,
  codAmountCentimes: 450_000,
  declaredValueCentimes: 450_000,
  weightGrams: 1200,
  items: [{ name: 'Casque audio', sku: 'CASQ-01', quantity: 2 }],
  notes: null,
  allowOpening: true,
  allowExchange: false,
};

beforeEach(() => {
  calls = [];
});

/** L'identite d'une societe Ecotrack, par son code. */
function tenant(code: string) {
  const identity = ECOTRACK_TENANTS.find((entry) => entry.code === code);
  if (!identity) throw new Error(`Societe Ecotrack inconnue : ${code}`);
  return identity;
}

/** L'identite d'un revendeur Yalidine, par son code. */
function reseller(code: string) {
  const identity = YALIDINE_RESELLERS.find((entry) => entry.code === code);
  if (!identity) throw new Error(`Revendeur Yalidine inconnu : ${code}`);
  return identity;
}

function body(index: number): Record<string, unknown> {
  return JSON.parse(calls[index]?.body ?? '{}') as Record<string, unknown>;
}

function headers(index: number): Record<string, string> {
  return calls[index]?.headers ?? {};
}

// ---------------------------------------------------------------------------
// ZR Express — v2, plateforme Procolis
// ---------------------------------------------------------------------------

describe('ZR Express (v2 / Procolis)', () => {
  const adapter = new ZrExpressAdapter();
  const ctx = context({ token: 'jeton-zr', key: 'cle-zr' });

  it('depose un colis avec NOTRE reference comme numero de suivi', async () => {
    // C'est tout le mecanisme d'idempotence de cette API : un Tracking fourni
    // par nous rend le rejeu detectable cote ZR.
    mockFetch(reply({ Colis: [{ Tracking: 'CMD-2026-000042', MessageRetour: 'Good' }] }));

    const result = await adapter.createShipment(ctx, ORDER);

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://procolis.com/api_v1/add_colis');
    // Procolis lit ses identifiants dans deux en-tetes a lui.
    expect(headers(0).token).toBe('jeton-zr');
    expect(headers(0).key).toBe('cle-zr');

    const colis = (body(0).Colis as Record<string, unknown>[])[0] ?? {};
    expect(colis.Tracking).toBe('CMD-2026-000042');
    expect(colis.IDWilaya).toBe('16');
    expect(colis.Commune).toBe('Bab Ezzouar');
    // Dinars, pas centimes : 450 000 centimes = 4 500 DA.
    expect(colis.Total).toBe('4500');
    // Format national, comme l'attendent les plateformes algeriennes.
    expect(colis.MobileA).toBe('0661234567');
    // La faute de frappe est celle de l'API : le colis part « pret a expedier ».
    expect(colis.Confrimee).toBe('1');
    expect(colis.TypeLivraison).toBe('0');
  });

  it('lit « Double Tracking » comme un doublon, non comme une panne', async () => {
    mockFetch(reply({ Colis: [{ MessageRetour: 'Double Tracking' }] }));

    const result = await adapter.createShipment(ctx, ORDER);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ALREADY_EXISTS');
    // Rejouer ne servirait a rien : le colis est deja chez le transporteur.
    expect(result.retryable).toBe(false);
  });

  it('refuse d annuler SANS appeler quoi que ce soit, et dit ou le faire', async () => {
    mockFetch();

    const result = await adapter.cancelShipment();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_IMPLEMENTED');
    expect(result.message).toContain('tableau de bord');
    // Un aller-retour reseau pour une reponse connue d'avance serait du bruit.
    expect(calls).toHaveLength(0);
  });

  it('ne declare pas connecte un compte dont l acces API n est pas actif', async () => {
    // LE PIEGE : Procolis repond 200 meme quand l'acces est ferme. S'arreter au
    // code HTTP ferait passer le compte en CONNECTED, et le Dispatcher le
    // proposerait pour des colis qui ne partiraient jamais.
    mockFetch(reply({ Statut: 'Acces desactive' }));

    const health = await adapter.healthCheck(ctx);

    expect(health.ok).toBe(false);
    expect(health.message).toContain('Acces desactive');
  });

  it('accepte l acces actif, accents compris', async () => {
    mockFetch(reply({ Statut: 'Accès activé' }));

    await expect(adapter.healthCheck(ctx)).resolves.toMatchObject({ ok: true });
  });

  it('traduit le « null » litteral d un colis inconnu en NOT_FOUND', async () => {
    // `lire` ne rend pas un objet vide mais la chaine « null ». La traiter
    // comme un objet masquerait l'absence derriere un statut vide.
    mockFetch(reply('null'));

    const result = await adapter.getShipmentStatus(ctx, 'INEXISTANT');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_FOUND');
  });

  it('normalise les statuts, suffixe d agence et accents compris', () => {
    expect(adapter.normalizeStatus('En Livraison ( 1528 )')).toBe('OUT_FOR_DELIVERY');
    expect(adapter.normalizeStatus('Livrée [ Encaisser ]')).toBe('DELIVERED');
    // Un appel sans reponse est une TENTATIVE ECHOUEE : c'est elle qui
    // declenche le rappel du client, la confondre avec un transit la perdrait.
    expect(adapter.normalizeStatus('Appel sans Réponse 2')).toBe('FAILED_ATTEMPT');
    // Le retour EN COURS et le retour ARRIVE ne se confondent pas.
    expect(adapter.normalizeStatus('Retour Livreur')).toBe('RETURNING');
    expect(adapter.normalizeStatus('Retour Stock')).toBe('RETURNED');
    expect(adapter.normalizeStatus('Annuler par le Client')).toBe('CANCELLED');
    // Un libelle inconnu ne bloque pas le colis.
    expect(adapter.normalizeStatus('Statut invente')).toBe('IN_TRANSIT');
  });
});

// ---------------------------------------------------------------------------
// Famille Ecotrack
// ---------------------------------------------------------------------------

describe('famille Ecotrack', () => {
  const dhd = new EcotrackAdapter(tenant('DHD'));
  const ctx = context({ apiToken: 'jeton-dhd' });

  it('cree un colis sur le domaine de la societe, avec son jeton', async () => {
    mockFetch(reply({ success: true, tracking: 'DHD-778899' }));

    const result = await dhd.createShipment(ctx, ORDER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trackingNumber).toBe('DHD-778899');
    // Le bordereau existe cote Ecotrack, mais en OCTETS PDF : pas d'URL a
    // promettre tant qu'aucune route ne les sert (D-049).
    expect(result.labelUrl).toBeNull();

    expect(calls[0]?.url).toBe('https://platform.dhd-dz.com/api/v1/create/order');
    expect(headers(0).authorization).toBe('Bearer jeton-dhd');

    const payload = body(0);
    expect(payload.reference).toBe('CMD-2026-000042');
    expect(payload.code_wilaya).toBe(16);
    expect(payload.montant).toBe(4500);
    expect(payload.telephone).toBe('0661234567');
    // 1 = livraison. L'echange vaudrait 2, et n'est pas demande ici.
    expect(payload.type).toBe(1);
    expect(payload.stop_desk).toBe(0);
    // Une cle inutile peut faire refuser la requete entiere : elle n'est
    // envoyee que sur un echange.
    expect(payload).not.toHaveProperty('produit_a_recuperer');
  });

  it('lit un refus metier dans une reponse 200', async () => {
    // Ecotrack repond 200 avec `success: false` : l'echec est dans le corps.
    mockFetch(reply({ success: false, message: 'Commune inconnue' }));

    const result = await dhd.createShipment(ctx, ORDER);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_ADDRESS');
    expect(result.message).toBe('Commune inconnue');
  });

  it('rend l historique du BON colis, en ordre chronologique', async () => {
    // Le suivi revient parfois indexe par numero de colis. Prendre le premier
    // venu ecrirait l'historique d'un colis sur un autre.
    mockFetch(
      reply({
        'DHD-778899': {
          status: 'en_livraison',
          activity: [
            { status: 'en_livraison', date: '2026-09-12', time: '09:30', station: 'Alger' },
            { status: 'picked', date: '2026-09-11', time: '17:05' },
          ],
        },
        'DHD-000000': { status: 'livred', activity: [{ status: 'livred', date: '2026-09-13' }] },
      }),
    );

    const result = await dhd.getTrackingEvents(ctx, 'DHD-778899');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((event) => event.providerStatus)).toEqual([
      'picked',
      'en_livraison',
    ]);
    expect(result.events[1]?.location).toBe('Alger');
    // L'empreinte rejoue sans doublon.
    expect(result.events[0]?.fingerprint).toBe('DHD-778899|picked|2026-09-1117:05');
  });

  it('normalise les statuts, y compris la variante accentuee', () => {
    expect(dhd.normalizeStatus('en_livraison')).toBe('OUT_FOR_DELIVERY');
    expect(dhd.normalizeStatus('attempt_delivery')).toBe('FAILED_ATTEMPT');
    expect(dhd.normalizeStatus('payé_et_archivé')).toBe('DELIVERED');
    // Notre machine a etats distingue le retour qui roule de celui qui arrive.
    expect(dhd.normalizeStatus('return_in_transit')).toBe('RETURNING');
    expect(dhd.normalizeStatus('retour_recu')).toBe('RETURNED');
    expect(dhd.normalizeStatus('annule')).toBe('CANCELLED');
  });

  it('refuse d appeler quoi que ce soit sans URL de base', async () => {
    // SpeedMail ne publie pas son domaine : le marchand doit le donner. Sans
    // lui, il n'y a pas d hote a appeler — et surtout aucun a deviner.
    const speedmail = new EcotrackAdapter(tenant('SPEEDMAIL'));
    mockFetch();

    const health = await speedmail.healthCheck(context({ apiToken: 'jeton' }));

    expect(health.ok).toBe(false);
    expect(health.message).toContain('URL de base manquante');
    expect(calls).toHaveLength(0);
  });

  it('refuse une URL de base en clair', async () => {
    // Ces appels transportent un jeton d'API : `http://` l'enverrait en clair.
    const speedmail = new EcotrackAdapter(tenant('SPEEDMAIL'));
    mockFetch();

    const health = await speedmail.healthCheck(
      context({ apiToken: 'jeton', baseUrl: 'http://speedmail.ecotrack.dz' }),
    );

    expect(health.ok).toBe(false);
    expect(health.message).toContain('URL de base invalide');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Famille Yalidine
// ---------------------------------------------------------------------------

describe('famille Yalidine', () => {
  it('envoie un revendeur sur SON domaine, pas sur celui de Yalidine', async () => {
    const guepex = new YalidineFamilyAdapter(reseller('GUEPEX'));
    mockFetch(reply({ data: [] }));

    await guepex.healthCheck(
      context({
        apiId: 'id-guepex',
        apiToken: 'jeton-guepex',
        fromWilayaName: 'Alger',
        baseUrl: 'https://api.guepex.app/v1/',
      }),
    );

    // La barre finale est retiree, sans quoi chaque appel porterait un double
    // slash.
    expect(calls[0]?.url).toBe('https://api.guepex.app/v1/wilayas/?page_size=1');
    expect(headers(0)['X-API-ID']).toBe('id-guepex');
  });

  it('garde son domaine par defaut a Yalidine, qui le publie', async () => {
    const yalidine = new YalidineFamilyAdapter(YALIDINE_IDENTITY);
    mockFetch(reply({ data: [] }));

    await yalidine.healthCheck(
      context({ apiId: 'id', apiToken: 'jeton', fromWilayaName: 'Alger' }),
    );

    expect(calls[0]?.url).toBe('https://api.yalidine.app/v1/wilayas/?page_size=1');
  });

  it('exige l URL de base d un revendeur, et la rend facultative a Yalidine', () => {
    const guepex = new YalidineFamilyAdapter(reseller('GUEPEX'));
    const yalidine = new YalidineFamilyAdapter(YALIDINE_IDENTITY);

    const field = (adapter: YalidineFamilyAdapter) =>
      adapter.credentialFields.find((entry) => entry.key === 'baseUrl');

    // Le domaine d'un revendeur n'est publie nulle part : il ne peut pas etre
    // devine, donc il est demande.
    expect(field(guepex)?.required).toBe(true);
    expect(field(yalidine)?.required).toBe(false);
  });

  it('nomme le transporteur concerne dans ses erreurs', async () => {
    // Un message disant « Yalidine » sur un compte Yalitec enverrait le
    // commercant verifier les identifiants du mauvais transporteur.
    const yalitec = new YalidineFamilyAdapter(reseller('YALITEC'));
    mockFetch(reply('acces refuse', 401));

    const health = await yalitec.healthCheck(
      context({
        apiId: 'id',
        apiToken: 'jeton',
        fromWilayaName: 'Alger',
        baseUrl: 'https://api.yalitec.app/v1',
      }),
    );

    expect(health.ok).toBe(false);
    expect(health.message).toContain('Yalitec');
  });
});
