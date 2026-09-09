'use client';

/**
 * Centre de confirmation telephonique — V1 §9, V2 §11.
 * Mise en forme : « EcomFlow — Centre de confirmation », planches 1 a 4.
 *
 * ECRAN LE PLUS UTILISE DU PRODUIT.
 *   Un agent y passe sa journee. Trois choix en decoulent :
 *
 *   1. UN TABLEAU QUI S'OUVRE EN PLACE. La file est une liste dense — dix
 *      colonnes, la commande lisible sans clic — et la ligne cliquee se
 *      deplie SOUS elle en tiroir d'edition. Jamais de nouvelle page, jamais
 *      de fenetre modale, et une seule ligne ouverte a la fois.
 *   2. RACCOURCIS CLAVIER. Les trois decisions les plus frequentes portent
 *      F1, F2 et F3 ; sur cinquante appels par jour, cela represente
 *      plusieurs minutes gagnees et beaucoup moins de fatigue.
 *   3. LE CLIENT AVANT LA COMMANDE. Fiabilite, historique et notes sont
 *      visibles immediatement : l'agent sait a qui il parle avant de composer
 *      le numero.
 *
 * LE TIROIR TIENT EN TROIS COLONNES, dans l'ordre de l'appel :
 *   client (a qui je parle) -> commande (ce dont on parle) -> decision (ce que
 *   j'en fais). Les colonnes 1 et 2 sont editables sur place : c'est pendant
 *   l'appel que l'on apprend que la commune est fausse ou qu'il en faut deux.
 *
 * UNE SEULE LANGUE A L'ECRAN, JAMAIS DEUX.
 *   Les maquettes portent des libelles bilingues (« Statut de confirmation
 *   FR + AR », « Type de livraison segmente, bilingue »). L'application ne les
 *   reprend PAS : elle est monolingue, et l'on bascule d'une langue a l'autre
 *   par le selecteur de l'en-tete (D-037). Empiler « Confirmer / تأكيد » sur
 *   un bouton double sa largeur, n'aide ni le francophone ni l'arabophone, et
 *   rend la ligne illisible dans les deux langues.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Minus, Phone, Plus } from 'lucide-react';
import {
  CONFIRMATION_QUEUE_STATUSES,
  WILAYAS,
  formatCentimes,
  getWilayaByCode,
} from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Money,
  ReliabilityBadge,
  Select,
  StatusBadge,
  Textarea,
  formatDateTime,
  useRelativeTime,
} from '@/components/ui';

interface QueueItem {
  readonly orderId: string;
  readonly reference: string;
  readonly status: string;
  readonly customerName: string;
  readonly phone: string;
  readonly wilayaCode: number | null;
  readonly commune: string | null;
  readonly address: string | null;
  readonly deliveryType: 'HOME' | 'PICKUP_POINT';
  readonly totalCentimes: number;
  readonly deliveryFeeCentimes: number;
  readonly items: readonly {
    id: string;
    sku: string;
    productName: string;
    variantLabel: string | null;
    quantity: number;
    unitPriceCentimes: number;
    discountCentimes: number;
    availableStock: number | null;
  }[];
  readonly notes: string | null;
  readonly callAttemptsCount: number;
  readonly nextCallbackAt: string | null;
  readonly assigneeName: string | null;
  readonly createdAt: string;
  readonly reliabilityScore: number | null;
  readonly reliabilityTier: string;
  readonly customerHistory: {
    ordersCount: number;
    deliveredCount: number;
    refusedCount: number;
  };
  readonly source: string;
  readonly attempts: readonly {
    attemptNumber: number;
    outcome: string;
    note: string | null;
    agentName: string | null;
    createdAt: string;
  }[];
  readonly confirmationChannel: string;
  readonly whatsappState: string;
  readonly pendingDuplicateFlags: number;
}

interface QueueStats {
  readonly total: number;
  readonly dueNow: number;
  readonly scheduled: number;
  readonly unassigned: number;
  readonly byStatus: Record<string, number>;
  /** Seuil d'abandon : au-dela, le bouton « Tentative » est desactive. */
  readonly maxCallAttempts: number;
}

/** Compteurs d'etape, affiches en onglets au-dessus de la file. */
interface StageCounts {
  readonly pendingConfirmation: number;
  readonly inPreparation: number;
  readonly inDelivery: number;
  readonly inReturn: number;
}

/** Coordonnees de livraison en cours de saisie. */
interface DeliveryDraft {
  customerName: string;
  phone: string;
  wilayaCode: string;
  commune: string;
  address: string;
  deliveryType: 'HOME' | 'PICKUP_POINT';
}

type Action =
  | 'CONFIRM'
  | 'CALL_BACK'
  | 'POSTPONE'
  | 'NO_ANSWER'
  | 'CANCEL'
  | 'REFUSED'
  | 'WRONG_NUMBER';

/** Statuts que la file peut contenir — les seuls proposes au filtre. */
const QUEUE_STATUSES = CONFIRMATION_QUEUE_STATUSES;

/**
 * Issues d'appel, et la facon dont chacune se presente.
 *
 * CETTE TABLE EST LA SEULE SOURCE. Les boutons du tiroir, la liste deroulante
 * « Issue de l'appel » et les raccourcis clavier en derivent tous. Une seconde
 * liste ecrite a la main aurait diverge des le premier ajout — c'est
 * exactement ce qui etait arrive au statut REFUSEE, present parmi les statuts
 * de commande mais absent des actions.
 *
 * `rank` traduit la hierarchie de la planche 4 : les trois decisions qui
 * closent l'appel portent une touche de fonction et occupent le haut de la
 * colonne ; les autres restent accessibles, en retrait.
 */
const ACTIONS: readonly {
  action: Action;
  /** Raccourci lettre, historique et sans conflit navigateur. */
  shortcut: string;
  /** Touche de fonction, telle que la maquette l'affiche. */
  fKey?: 'F1';
  needsReason?: boolean;
  needsCallback?: boolean;
}[] = [
  { action: 'CONFIRM', shortcut: 'C', fKey: 'F1' },
  // « Tentative N » = un appel de plus sans decision. C'est NO_ANSWER cote
  // metier : le compteur avance, la commande RESTE dans la file.
  { action: 'NO_ANSWER', shortcut: 'S' },
  { action: 'POSTPONE', shortcut: 'P', needsCallback: true },
  { action: 'CANCEL', shortcut: 'A', needsReason: true },
];

/**
 * Issues proposees par la liste « Statut ».
 *
 * PERIMETRE VOLONTAIREMENT RESTREINT.
 *   Cinq entrees, et cinq seulement : trois tentatives, un report, une
 *   annulation. Le centre de confirmation ne sert qu'a cela — decrocher,
 *   compter les essais, et finir par oui ou par non.
 *
 *   Trois issues que l'API sait traiter n'ont donc plus d'entree ici :
 *   NUMERO INCORRECT, REFUS CLIENT et RAPPELER. Elles restent disponibles par
 *   l'API et par la fiche commande ; elles ne sont simplement plus proposees
 *   dans cette liste. C'est une restriction demandee, pas un oubli — et elle
 *   est reversible en ajoutant une ligne ci-dessous.
 *
 * `attempt` porte le numero de tentative que l'entree represente. Seule celle
 * qui correspond au PROCHAIN appel est selectionnable : proposer « Tentative
 * 1 » a une commande deja appelee deux fois afficherait un choix que le
 * serveur refuserait — le compteur avance tout seul, il ne se choisit pas.
 */
const STATUS_CHOICES: readonly {
  key: string;
  action: Action;
  attempt?: 1 | 2 | 3;
}[] = [
  { key: 'ATTEMPT_1', action: 'NO_ANSWER', attempt: 1 },
  { key: 'ATTEMPT_2', action: 'NO_ANSWER', attempt: 2 },
  { key: 'ATTEMPT_3', action: 'NO_ANSWER', attempt: 3 },
  { key: 'POSTPONED', action: 'POSTPONE' },
  { key: 'CANCELLED', action: 'CANCEL' },
];

/** Coordonnees de la commande, sous la forme editable du tiroir. */
function draftFromEntry(entry: QueueItem): DeliveryDraft {
  return {
    customerName: entry.customerName,
    phone: entry.phone,
    wilayaCode: entry.wilayaCode ? String(entry.wilayaCode) : '',
    commune: entry.commune ?? '',
    address: entry.address ?? '',
    deliveryType: entry.deliveryType,
  };
}

function quantitiesFromEntry(entry: QueueItem): Record<string, number> {
  return Object.fromEntries(entry.items.map((item) => [item.id, item.quantity]));
}

function sameDetails(entry: QueueItem, draft: DeliveryDraft): boolean {
  const original = draftFromEntry(entry);
  return (
    original.customerName === draft.customerName.trim() &&
    original.phone === draft.phone.trim() &&
    original.wilayaCode === draft.wilayaCode &&
    original.commune === draft.commune.trim() &&
    original.address === draft.address.trim() &&
    original.deliveryType === draft.deliveryType
  );
}

function sameQuantities(entry: QueueItem, draft: Record<string, number>): boolean {
  return entry.items.every((item) => (draft[item.id] ?? item.quantity) === item.quantity);
}

/** Etapes du cycle, dans l'ordre ou une commande les traverse. */
const STAGES = [
  { key: 'pendingConfirmation', href: '/confirmation', current: true },
  { key: 'inPreparation', href: '/preparation', current: false },
  { key: 'inDelivery', href: '/expeditions', current: false },
  { key: 'inReturn', href: '/retours', current: false },
] as const;

export default function ConfirmationPage() {
  const t = useTranslations('confirmation');
  const tCommon = useTranslations('common');
  const tStatus = useTranslations('orderStatus');
  const tOutcome = useTranslations('callOutcome');
  const relativeTime = useRelativeTime();
  const queryClient = useQueryClient();

  /** Commande dont la ligne est deployee. Une seule a la fois. */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /**
   * Vrai quand l'agent a REFERME lui-meme la ligne ouverte. Sans ce drapeau,
   * l'ouverture automatique de la premiere ligne rouvrirait aussitot ce que
   * l'agent vient de fermer : le clic n'aurait aucun effet visible.
   */
  const [collapsedByUser, setCollapsedByUser] = useState(false);

  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [callbackAt, setCallbackAt] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; message: string } | null>(
    null,
  );

  /** Quantites en cours de saisie, par identifiant de ligne. */
  const [draftItems, setDraftItems] = useState<Record<string, number> | null>(null);
  /** Coordonnees de livraison en cours de correction. */
  const [draftDetails, setDraftDetails] = useState<DeliveryDraft | null>(null);

  // --- Filtres --------------------------------------------------------------
  // Appliques PAR LE SERVEUR : la file est paginee, filtrer dans le navigateur
  // ne montrerait que ce qui est deja charge et mentirait sur le total.
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [wilayaCode, setWilayaCode] = useState('');
  const [productSku, setProductSku] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [orderedFrom, setOrderedFrom] = useState('');
  const [orderedTo, setOrderedTo] = useState('');
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const queueQuery = useQuery({
    queryKey: [
      'confirmation',
      'queue',
      { debouncedSearch, wilayaCode, productSku, statusFilter, orderedFrom, orderedTo },
    ],
    queryFn: () =>
      api.get<{ data: QueueItem[]; meta: { total: number } }>('/confirmation/queue', {
        query: {
          pageSize: 50,
          dueOnly: true,
          search: debouncedSearch || undefined,
          wilayaCode: wilayaCode || undefined,
          productSku: productSku || undefined,
          status: statusFilter || undefined,
          orderedFrom: orderedFrom || undefined,
          orderedTo: orderedTo || undefined,
        },
      }),
    // La file bouge en permanence : les imports arrivent, les collegues
    // traitent. Un rafraichissement regulier evite de travailler sur une
    // commande deja prise en charge.
    refetchInterval: 30_000,
  });

  const statsQuery = useQuery({
    queryKey: ['confirmation', 'stats'],
    queryFn: () => api.get<QueueStats>('/confirmation/queue/stats'),
    refetchInterval: 30_000,
  });

  const stagesQuery = useQuery({
    queryKey: ['dashboard', 'alerts'],
    queryFn: () => api.get<StageCounts>('/dashboard/alerts'),
    refetchInterval: 60_000,
  });

  // Catalogue, uniquement pour le filtre « produit ». Il change rarement.
  const catalogQuery = useQuery({
    queryKey: ['confirmation', 'catalog-skus'],
    queryFn: () =>
      api.get<{ data: { name: string; variants: { sku: string; label: string | null }[] }[] }>(
        '/products',
        { query: { pageSize: 100 } },
      ),
    staleTime: 5 * 60_000,
  });

  const skuOptions = useMemo(
    () =>
      (catalogQuery.data?.data ?? []).flatMap((product) =>
        product.variants.map((variant) => ({
          sku: variant.sku,
          label: variant.label ? `${product.name} — ${variant.label}` : product.name,
        })),
      ),
    [catalogQuery.data],
  );

  const queue = queueQuery.data?.data ?? [];
  const stats = statsQuery.data;
  const maxAttempts = stats?.maxCallAttempts ?? 3;

  const expanded = queue.find((entry) => entry.orderId === expandedId) ?? null;

  /**
   * Pastilles de filtres actifs. Chacune porte sa propre croix, et la liste
   * sert aussi a savoir s'il faut proposer « Tout effacer ». Un filtre qu'on
   * ne voit pas est un filtre qu'on oublie d'enlever — et l'agent conclut que
   * la file est vide.
   */
  const activePills = useMemo(() => {
    const pills: { key: string; label: string; clear: () => void }[] = [];
    if (debouncedSearch) {
      pills.push({
        key: 'search',
        label: `${tCommon('search')} : ${debouncedSearch}`,
        clear: () => setSearch(''),
      });
    }
    if (wilayaCode) {
      const wilaya = getWilayaByCode(Number(wilayaCode));
      pills.push({
        key: 'wilaya',
        label: `${tCommon('wilaya')} : ${wilaya ? `${wilaya.code2} — ${wilaya.name}` : wilayaCode}`,
        clear: () => setWilayaCode(''),
      });
    }
    if (productSku) {
      const option = skuOptions.find((entry) => entry.sku === productSku);
      pills.push({
        key: 'product',
        label: `${tCommon('product')} : ${option?.label ?? productSku}`,
        clear: () => setProductSku(''),
      });
    }
    if (statusFilter) {
      pills.push({
        key: 'status',
        label: `${tCommon('status')} : ${tStatus(statusFilter)}`,
        clear: () => setStatusFilter(''),
      });
    }
    if (orderedFrom || orderedTo) {
      pills.push({
        key: 'period',
        label: `${t('period')} : ${orderedFrom || '…'} → ${orderedTo || '…'}`,
        clear: () => {
          setOrderedFrom('');
          setOrderedTo('');
        },
      });
    }
    return pills;
  }, [
    debouncedSearch,
    wilayaCode,
    productSku,
    statusFilter,
    orderedFrom,
    orderedTo,
    skuOptions,
    t,
    tCommon,
    tStatus,
  ]);

  function clearAllFilters() {
    setSearch('');
    setWilayaCode('');
    setProductSku('');
    setStatusFilter('');
    setOrderedFrom('');
    setOrderedTo('');
  }

  /**
   * Ouvre la premiere ligne quand aucune ne l'est — l'agent arrive et appelle
   * sans clic prealable. Couvre aussi le cas ou la commande ouverte DISPARAIT
   * de la file : la suivante prend sa place.
   */
  useEffect(() => {
    if (collapsedByUser) return;
    if (queue.length === 0) return;
    if (expandedId && queue.some((entry) => entry.orderId === expandedId)) return;
    setExpandedId(queue[0]?.orderId ?? null);
  }, [queue, expandedId, collapsedByUser]);

  /**
   * Changer de ligne REINITIALISE le tiroir sur la commande ouverte.
   *
   * Les champs du tiroir sont editables en permanence — le systeme de design
   * ne prevoit pas de bascule « consulter / modifier », il montre des champs
   * de saisie (planche 4 : « Champs editables hauteur 40, rayon 11 », avec
   * leurs etats rempli / focus / vide / erreur). Les brouillons sont donc
   * PRE-REMPLIS depuis la commande, et non laisses vides.
   *
   * Note d'appel, motif et date de rappel repartent a zero : ils decrivent
   * l'appel en cours, pas la commande. Les laisser en place afficherait la
   * note prise pour Madame X sous le nom de Monsieur Y.
   *
   * `queueRef` plutot que `queue` en dependance : la file se rafraichit toutes
   * les trente secondes, et dependre d'elle effacerait la saisie en cours a
   * chaque rafraichissement.
   */
  const expandedOrderId = expanded?.orderId ?? null;
  const queueRef = useRef(queue);
  queueRef.current = queue;

  useEffect(() => {
    const entry = queueRef.current.find((row) => row.orderId === expandedOrderId) ?? null;
    setDraftDetails(entry ? draftFromEntry(entry) : null);
    setDraftItems(entry ? quantitiesFromEntry(entry) : null);
    setNote('');
    setReason('');
    setCallbackAt('');
  }, [expandedOrderId]);

  /**
   * Modifications non enregistrees, par colonne.
   *
   * Elles commandent deux choses : l'apparition du bouton d'enregistrement, et
   * le blocage des raccourcis clavier — un F1 presse par reflexe ne doit pas
   * confirmer la commande en abandonnant au passage une adresse corrigee.
   */
  const detailsDirty = Boolean(
    expanded && draftDetails && !sameDetails(expanded, draftDetails),
  );
  const itemsDirty = Boolean(expanded && draftItems && !sameQuantities(expanded, draftItems));

  const toggleRow = useCallback(
    (orderId: string) => {
      const closing = expandedId === orderId;
      setCollapsedByUser(closing);
      setExpandedId(closing ? null : orderId);
    },
    [expandedId],
  );

  const actionMutation = useMutation({
    mutationFn: (payload: { orderId: string; action: Action }) =>
      api.post<{ to: string; attemptNumber: number; maxAttemptsReached: boolean }>(
        `/confirmation/orders/${payload.orderId}/action`,
        {
          action: payload.action,
          note: note.trim() || undefined,
          reason: reason.trim() || undefined,
          callbackAt: callbackAt ? new Date(callbackAt).toISOString() : undefined,
        },
      ),
    onSuccess: (result, variables) => {
      setFeedback({
        tone: 'success',
        message: t('actionDone', { status: tStatus(result.to), attempt: result.attemptNumber }),
      });
      setNote('');
      setReason('');
      setCallbackAt('');

      // On deploie la commande suivante : l'agent enchaine sans clic
      // supplementaire. `collapsedByUser` est leve, sinon une ligne refermee
      // plus tot empecherait l'ouverture automatique de la suivante.
      const index = queue.findIndex((entry) => entry.orderId === variables.orderId);
      setCollapsedByUser(false);
      setExpandedId(queue[index + 1]?.orderId ?? null);

      void queryClient.invalidateQueries({ queryKey: ['confirmation'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (error) => {
      setFeedback({
        tone: 'danger',
        message: error instanceof ApiError ? error.userMessage : tCommon('actionFailed'),
      });
    },
  });

  // Le serveur RECALCULE les montants et les renvoie : l'ecran n'additionne
  // rien lui-meme. Le total a encaisser est annonce au client de vive voix, il
  // ne peut pas dependre d'un arrondi fait dans le navigateur.
  const itemsMutation = useMutation({
    mutationFn: (payload: { orderId: string; lines: { orderItemId: string; quantity: number }[] }) =>
      api.patch<{ totalCentimes: number }>(`/confirmation/orders/${payload.orderId}/items`, {
        lines: payload.lines,
      }),
    onSuccess: () => {
      setFeedback({ tone: 'success', message: t('itemsUpdated') });
      setDraftItems(null);
      void queryClient.invalidateQueries({ queryKey: ['confirmation'] });
    },
    onError: (error) => {
      setFeedback({
        tone: 'danger',
        message: error instanceof ApiError ? error.userMessage : tCommon('actionFailed'),
      });
    },
  });

  const detailsMutation = useMutation({
    mutationFn: (payload: { orderId: string; draft: DeliveryDraft }) =>
      api.patch<{ updated: boolean }>(
        `/confirmation/orders/${payload.orderId}/delivery-details`,
        {
          customerName: payload.draft.customerName.trim() || undefined,
          phone: payload.draft.phone.trim() || undefined,
          wilayaCode: payload.draft.wilayaCode ? Number(payload.draft.wilayaCode) : undefined,
          commune: payload.draft.commune.trim() || undefined,
          address: payload.draft.address.trim() || undefined,
          deliveryType: payload.draft.deliveryType,
        },
      ),
    onSuccess: () => {
      setFeedback({ tone: 'success', message: t('detailsUpdated') });
      setDraftDetails(null);
      void queryClient.invalidateQueries({ queryKey: ['confirmation'] });
    },
    onError: (error) => {
      setFeedback({
        tone: 'danger',
        message: error instanceof ApiError ? error.userMessage : tCommon('actionFailed'),
      });
    },
  });

  const runAction = useCallback(
    (action: Action) => {
      // L'action porte TOUJOURS sur la ligne deployee : c'est elle que l'agent
      // a sous les yeux et au telephone.
      if (!expanded) return;

      const config = ACTIONS.find((entry) => entry.action === action);
      // Une tentative de plus au-dela du seuil n'a pas de sens : la commande
      // attend une decision, pas un enieme appel.
      if (action === 'NO_ANSWER' && expanded.callAttemptsCount >= maxAttempts) {
        setFeedback({ tone: 'danger', message: t('attemptsExhausted', { max: maxAttempts }) });
        return;
      }
      if (config?.needsReason && !reason.trim()) {
        setFeedback({ tone: 'danger', message: t('cancelReasonRequired') });
        return;
      }

      actionMutation.mutate({ orderId: expanded.orderId, action });
    },
    [expanded, reason, actionMutation, maxAttempts, t],
  );

  /**
   * Raccourcis clavier.
   *
   * Deux jeux cohabitent : les lettres (C, A, S...) et les touches de
   * fonction F1 a F3 que la maquette affiche sur les boutons. F1 ouvre l'aide
   * du navigateur — `preventDefault` la retient, mais la lettre reste le
   * chemin sur, et c'est pourquoi les deux existent.
   *
   * Desactives des qu'un champ a le focus, sinon taper « c » dans une note
   * declencherait une confirmation ; et pendant une modification en cours,
   * sans quoi un raccourci abandonnerait silencieusement la saisie.
   */
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (detailsDirty || itemsDirty) return;

      const config = ACTIONS.find(
        (entry) =>
          entry.fKey === event.key || entry.shortcut.toLowerCase() === event.key.toLowerCase(),
      );
      if (config) {
        event.preventDefault();
        runAction(config.action);
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [runAction, detailsDirty, itemsDirty]);

  if (queueQuery.isLoading) return <LoadingState label={t('loadingQueue')} />;

  if (queueQuery.error) {
    return (
      <ErrorState
        message={
          queueQuery.error instanceof ApiError
            ? queueQuery.error.userMessage
            : tCommon('loadFailed')
        }
        onRetry={() => void queueQuery.refetch()}
      />
    );
  }

  const stages = stagesQuery.data;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          stats ? (
            <div className="flex flex-wrap gap-2">
              <Badge tone="warning">{t('stats.dueNow', { count: stats.dueNow })}</Badge>
              {stats.scheduled > 0 ? (
                <Badge tone="neutral">{t('stats.scheduled', { count: stats.scheduled })}</Badge>
              ) : null}
            </div>
          ) : null
        }
      />

      {/* --- Onglets d'etape -------------------------------------------------
          Ils donnent la position de la file dans le cycle complet : combien
          attendent un appel, combien sont deja au depot, en route, ou revenus.
          Ce sont des LIENS vers les ecrans concernes, pas des filtres de cette
          page — chaque etape a son propre outil. */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {STAGES.map((stage) => {
          const count = stages?.[stage.key] ?? 0;
          return (
            <a
              key={stage.key}
              href={stage.href}
              aria-current={stage.current ? 'page' : undefined}
              className={clsx(
                'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors',
                stage.current
                  ? 'bg-ink text-white'
                  : 'bg-surface text-ink-2 hover:bg-canvas border border-line',
              )}
            >
              {t(`stages.${stage.key}`)}
              <span
                className={clsx(
                  'tabular rounded-full px-1.5 text-xs font-bold',
                  stage.current ? 'bg-lime text-ink' : 'bg-canvas text-muted',
                )}
              >
                {count}
              </span>
            </a>
          );
        })}
      </div>

      {feedback ? (
        <div className="mb-3">
          <Alert tone={feedback.tone === 'success' ? 'success' : 'danger'}>
            {feedback.message}
          </Alert>
        </div>
      ) : null}

      {/* --- Barre de filtres -------------------------------------------------
          RECHERCHE LOCALE, distincte de celle de l'en-tete. Celle de la coque
          applicative envoie vers la liste des commandes ; celle-ci reste dans
          la file d'appel. Un agent qui cherche un nom pendant sa session ne
          veut pas quitter sa file. */}
      <Card className="mb-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            label={tCommon('search')}
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />

          <Select
            label={tCommon('wilaya')}
            value={wilayaCode}
            onChange={(event) => setWilayaCode(event.target.value)}
          >
            <option value="">{t('allWilayas')}</option>
            {WILAYAS.map((wilaya) => (
              <option key={wilaya.code} value={wilaya.code}>
                {wilaya.code2} — {wilaya.name}
              </option>
            ))}
          </Select>

          <Select
            label={tCommon('product')}
            value={productSku}
            onChange={(event) => setProductSku(event.target.value)}
          >
            <option value="">{t('allProducts')}</option>
            {skuOptions.map((option) => (
              <option key={option.sku} value={option.sku}>
                {option.label} ({option.sku})
              </option>
            ))}
          </Select>

          <Select
            label={tCommon('status')}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="">{t('allStatuses')}</option>
            {/* Uniquement les statuts que la file peut contenir : proposer
                « Livree » dans une file d'appel ne renverrait jamais rien. */}
            {QUEUE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {tStatus(status)}
              </option>
            ))}
          </Select>
        </div>

        <div className="mt-2 flex flex-wrap items-end gap-3">
          <button
            className="text-sm font-semibold text-brand-700 hover:underline"
            aria-expanded={moreFiltersOpen}
            onClick={() => setMoreFiltersOpen((open) => !open)}
          >
            {t('moreFilters')}
          </button>
        </div>

        {/* Divulgation progressive : la periode est un filtre de second rang,
            replie par defaut comme sur la planche 3. */}
        {moreFiltersOpen ? (
          <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              label={t('periodFrom')}
              type="date"
              value={orderedFrom}
              onChange={(event) => setOrderedFrom(event.target.value)}
            />
            <Input
              label={t('periodTo')}
              type="date"
              value={orderedTo}
              onChange={(event) => setOrderedTo(event.target.value)}
            />
          </div>
        ) : null}

        {/* --- Pastilles de filtres actifs --- */}
        {activePills.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
            {activePills.map((pill) => (
              <span
                key={pill.key}
                className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-ink-2"
              >
                {pill.label}
                <button
                  onClick={pill.clear}
                  aria-label={t('removeFilter', { filter: pill.label })}
                  className="text-muted hover:text-ink"
                >
                  ×
                </button>
              </span>
            ))}
            <button
              className="ms-1 text-xs font-semibold text-brand-700 hover:underline"
              onClick={clearAllFilters}
            >
              {t('clearAllFilters')}
            </button>
          </div>
        ) : null}
      </Card>

      {queue.length === 0 ? (
        <Card>
          <EmptyState
            title={activePills.length > 0 ? t('queueEmptyFiltered') : t('queueEmpty')}
            description={
              activePills.length > 0 ? t('queueEmptyFilteredHint') : t('queueEmptyHint')
            }
          />
        </Card>
      ) : (
        <Card
          title={t('queueTitle', { count: queue.length })}
          padded={false}
          footer={<p className="text-xs text-muted">{t('rowHint')}</p>}
        >
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="w-8" />
                  <th>{t('columns.reference')}</th>
                  <th>{tCommon('customer')}</th>
                  <th>{tCommon('phone')}</th>
                  <th>{tCommon('wilaya')}</th>
                  <th>{tCommon('commune')}</th>
                  <th>{tCommon('product')}</th>
                  <th>{tCommon('note')}</th>
                  <th>{tCommon('status')}</th>
                  <th className="text-end">{t('columns.attempts')}</th>
                  <th className="text-end">{tCommon('total')}</th>
                </tr>
              </thead>
                {queue.map((entry) => {
                  const open = entry.orderId === expandedId;
                  const wilaya = entry.wilayaCode ? getWilayaByCode(entry.wilayaCode) : null;
                  const firstItem = entry.items[0];

                  return (
                    <RowGroup key={entry.orderId} open={open}>
                      {/* La LIGNE ENTIERE est cliquable — elle s'ouvre en
                          place, jamais dans une nouvelle page. */}
                      <tr
                        onClick={() => toggleRow(entry.orderId)}
                        aria-expanded={open}
                        className={clsx(
                          'cursor-pointer',
                          open ? 'bg-canvas' : 'hover:bg-slate-50',
                        )}
                      >
                        <td>
                          {open ? (
                            <ChevronDown
                              className="h-4 w-4 text-ink"
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                          ) : (
                            // `rtl:-scale-x-100` : le chevron pointe vers
                            // l'avant du sens de lecture.
                            <ChevronRight
                              className="h-4 w-4 text-muted rtl:-scale-x-100"
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                          )}
                        </td>
                        <td className="font-mono text-xs text-muted">{entry.reference}</td>
                        <td className="font-semibold text-ink">{entry.customerName}</td>
                        <td className="tabular whitespace-nowrap">{entry.phone}</td>
                        <td className="whitespace-nowrap">
                          {wilaya ? `${wilaya.code2} — ${wilaya.name}` : tCommon('none')}
                        </td>
                        <td>{entry.commune ?? tCommon('none')}</td>
                        <td className="max-w-[14rem] truncate">
                          {firstItem ? firstItem.productName : tCommon('none')}
                          {entry.items.length > 1 ? (
                            <span className="text-muted"> +{entry.items.length - 1}</span>
                          ) : null}
                        </td>
                        <td className="max-w-[12rem] truncate text-muted">
                          {entry.notes ?? ''}
                        </td>
                        <td>
                          <StatusBadge status={entry.status} />
                        </td>
                        <td className="tabular text-end">{entry.callAttemptsCount}</td>
                        <td className="text-end">
                          <Money centimes={entry.totalCentimes} bold />
                        </td>
                      </tr>

                      {open ? (
                        <tr className="bg-canvas">
                          <td colSpan={11} className="p-0">
                            <EditDrawer
                              entry={entry}
                              detailsDirty={detailsDirty}
                              itemsDirty={itemsDirty}
                              draftItems={draftItems}
                              setDraftItems={setDraftItems}
                              draftDetails={draftDetails}
                              setDraftDetails={setDraftDetails}
                              itemsMutation={itemsMutation}
                              detailsMutation={detailsMutation}
                              actionMutation={actionMutation}
                              runAction={runAction}
                              note={note}
                              setNote={setNote}
                              reason={reason}
                              setReason={setReason}
                              callbackAt={callbackAt}
                              setCallbackAt={setCallbackAt}
                              relativeTime={relativeTime}
                              t={t}
                              tCommon={tCommon}
                              tOutcome={tOutcome}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </RowGroup>
                  );
                })}
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

/**
 * Regroupe la ligne et son tiroir.
 *
 * `<tbody>` par commande plutot qu'un fragment : c'est le seul conteneur
 * qu'un tableau accepte autour de plusieurs `<tr>`, et il permet de marquer
 * visuellement la commande ouverte d'un filet lime a gauche (planche 4 :
 * « Ouverte — fond canvas, filet lime a gauche »).
 */
function RowGroup({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <tbody
      className={clsx(
        'border-b border-line',
        open ? 'border-s-2 border-s-lime' : undefined,
      )}
    >
      {children}
    </tbody>
  );
}

/**
 * Tiroir d'edition : client · commande & note · decision.
 *
 * LES CHAMPS SONT EDITABLES EN PERMANENCE.
 *   Il n'y a pas de bascule « consulter / modifier » : le systeme de design ne
 *   montre que des champs de saisie (planche 4, « Champs editables hauteur 40,
 *   rayon 11 », avec leurs etats rempli / focus / vide / erreur). Un agent au
 *   telephone corrige une commune en la retapant, pas en cherchant d'abord un
 *   bouton « modifier ».
 *
 *   Le prix de cette forme est qu'il faut dire QUAND une saisie est partie :
 *   c'est le role du bandeau d'enregistrement, qui n'apparait qu'en presence
 *   d'une modification reelle (`detailsDirty`, `itemsDirty`).
 */
function EditDrawer({
  entry,
  detailsDirty,
  itemsDirty,
  draftItems,
  setDraftItems,
  draftDetails,
  setDraftDetails,
  itemsMutation,
  detailsMutation,
  actionMutation,
  runAction,
  note,
  setNote,
  reason,
  setReason,
  callbackAt,
  setCallbackAt,
  relativeTime,
  t,
  tCommon,
  tOutcome,
}: {
  entry: QueueItem;
  detailsDirty: boolean;
  itemsDirty: boolean;
  draftItems: Record<string, number> | null;
  setDraftItems: (value: Record<string, number> | null) => void;
  draftDetails: DeliveryDraft | null;
  setDraftDetails: (value: DeliveryDraft | null) => void;
  itemsMutation: {
    isPending: boolean;
    mutate: (payload: {
      orderId: string;
      lines: { orderItemId: string; quantity: number }[];
    }) => void;
  };
  detailsMutation: {
    isPending: boolean;
    mutate: (payload: { orderId: string; draft: DeliveryDraft }) => void;
  };
  actionMutation: { isPending: boolean; variables?: { action: Action } };
  runAction: (action: Action) => void;
  note: string;
  setNote: (value: string) => void;
  reason: string;
  setReason: (value: string) => void;
  callbackAt: string;
  setCallbackAt: (value: string) => void;
  relativeTime: (value: string | Date | null | undefined) => string;
  t: ReturnType<typeof useTranslations>;
  tCommon: ReturnType<typeof useTranslations>;
  tOutcome: ReturnType<typeof useTranslations>;
}) {
  // Le tiroir ne s'affiche qu'avec ses brouillons : ils sont poses en meme
  // temps que l'ouverture de la ligne.
  if (!draftDetails || !draftItems) return null;

  const quantities = draftItems;

  /**
   * Enregistrement UNIQUE des deux colonnes editables.
   *
   * Coordonnees et quantites partent par deux appels distincts — ce sont deux
   * ressources et deux regles metier — mais l'agent n'a qu'un bouton : il a
   * corrige « la commande », pas « la colonne 1 puis la colonne 2 ».
   *
   * Aucun des deux ne touche au STATUT : c'est toute la difference avec
   * « Confirmer ». Une adresse rectifiee s'enregistre sans decider a la place
   * du client.
   */
  const hasPendingEdits = detailsDirty || itemsDirty;
  const savingEdits = detailsMutation.isPending || itemsMutation.isPending;

  function saveEdits() {
    if (detailsDirty) detailsMutation.mutate({ orderId: entry.orderId, draft: draftDetails! });
    if (itemsDirty) {
      itemsMutation.mutate({
        orderId: entry.orderId,
        lines: Object.entries(quantities).map(([orderItemId, quantity]) => ({
          orderItemId,
          quantity,
        })),
      });
    }
  }

  /** Numero du prochain appel : c'est lui que la liste « Statut » propose. */
  const nextAttempt = entry.callAttemptsCount + 1;
  const quantityOf = (itemId: string, fallback: number) => quantities[itemId] ?? fallback;

  function bumpQuantity(itemId: string, current: number, delta: number) {
    setDraftItems({
      ...quantities,
      [itemId]: Math.max(0, (quantities[itemId] ?? current) + delta),
    });
  }

  const itemsSubtotal = entry.items.reduce(
    (sum, item) => sum + quantityOf(item.id, item.quantity) * item.unitPriceCentimes,
    0,
  );
  const discountTotal = entry.items.reduce((sum, item) => sum + item.discountCentimes, 0);
  // Total PROVISOIRE, recalcule a l'ecran pendant que l'agent ajuste les
  // quantites. Le serveur refait le calcul a l'enregistrement et fait foi —
  // c'est sa valeur qui revient ensuite dans la file.
  const provisionalTotal = itemsSubtotal + entry.deliveryFeeCentimes - discountTotal;

  return (
    <div className="grid gap-5 p-4 lg:grid-cols-3">
      {/* ================= Colonne 1 — Informations client ================= */}
      <section className="space-y-2">
        <p className="eyebrow">{t('customerSection')}</p>

        <Input
          label={t('customerNameLabel')}
          value={draftDetails.customerName}
          onChange={(event) =>
            setDraftDetails({ ...draftDetails, customerName: event.target.value })
          }
        />

        <div>
          <Input
            label={tCommon('phone')}
            value={draftDetails.phone}
            onChange={(event) => setDraftDetails({ ...draftDetails, phone: event.target.value })}
          />
          {/* Appeler suit immediatement le numero : c'est le geste qui suit la
              lecture, et le seul de cette colonne qui ne modifie rien. */}
          <a href={`tel:${entry.phone}`} className="mt-1 inline-block">
            <Button size="sm" variant="secondary" icon={<Phone className="h-3.5 w-3.5" />}>
              {t('callNow')}
            </Button>
          </a>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Select
            label={tCommon('wilaya')}
            value={draftDetails.wilayaCode}
            onChange={(event) =>
              setDraftDetails({ ...draftDetails, wilayaCode: event.target.value })
            }
          >
            <option value="">{tCommon('select')}</option>
            {/* Format « code — nom », le meme que partout ailleurs. */}
            {WILAYAS.map((item) => (
              <option key={item.code} value={item.code}>
                {item.code2} — {item.name}
              </option>
            ))}
          </Select>
          <Input
            label={tCommon('commune')}
            value={draftDetails.commune}
            onChange={(event) => setDraftDetails({ ...draftDetails, commune: event.target.value })}
          />
        </div>

        <Input
          label={tCommon('address')}
          value={draftDetails.address}
          onChange={(event) => setDraftDetails({ ...draftDetails, address: event.target.value })}
        />

        {/* Choix segmente plutot qu'une liste deroulante : deux options
            seulement, et le mode change les frais de livraison — autant que les
            deux soient visibles en meme temps. */}
        <div>
          <p className="field-label">{t('deliveryTypeLabel')}</p>
          <div
            role="group"
            aria-label={t('deliveryTypeLabel')}
            className="inline-flex rounded-full border border-line bg-surface p-0.5"
          >
            {(['HOME', 'PICKUP_POINT'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={draftDetails.deliveryType === mode}
                onClick={() => setDraftDetails({ ...draftDetails, deliveryType: mode })}
                className={clsx(
                  'rounded-full px-3 py-1.5 text-xs font-bold transition-colors',
                  draftDetails.deliveryType === mode
                    ? 'bg-ink text-white'
                    : 'text-ink-2 hover:bg-canvas',
                )}
              >
                {t(`deliveryTypes.${mode}`)}
              </button>
            ))}
          </div>
          <p className="field-hint">{t('deliveryTypeHint')}</p>
        </div>

        {/* Fiabilite : le palier, et les chiffres qui l'expliquent. Un palier
            seul n'est pas verifiable ; « 6 commandes, 5 livrees » l'est. */}
        <div className="border-t border-line pt-2">
          <ReliabilityBadge tier={entry.reliabilityTier} score={entry.reliabilityScore} />
          <p className="mt-1 text-xs text-muted">
            {t('customerHistory', {
              orders: entry.customerHistory.ordersCount,
              delivered: entry.customerHistory.deliveredCount,
              refused: entry.customerHistory.refusedCount,
            })}
          </p>
        </div>

      </section>

      {/* ============ Colonne 2 — Commande, prix et observation ============ */}
      <section className="space-y-2">
        <p className="eyebrow">{t('orderSection')}</p>

        <ul className="space-y-2">
          {entry.items.map((item) => {
            const quantity = quantityOf(item.id, item.quantity);
            const dropped = quantity === 0;
            const short = item.availableStock !== null && item.availableStock < quantity;

            return (
              <li key={item.id} className="rounded-lg border border-line bg-surface p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p
                      className={clsx(
                        'truncate text-sm font-bold',
                        dropped ? 'text-muted line-through' : 'text-ink',
                      )}
                    >
                      {item.productName}
                      {item.variantLabel ? (
                        <span className="font-medium text-muted"> · {item.variantLabel}</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-xs text-muted">
                      <span>{item.sku}</span>
                      {item.availableStock !== null ? (
                        // Le stock disponible se lit AVANT de promettre une
                        // quantite : au-dela, la commande se transformerait en
                        // annulation quelques jours plus tard.
                        <span
                          className={clsx(
                            'font-sans font-bold',
                            short ? 'text-danger' : 'text-muted',
                          )}
                        >
                          {t('stockAvailable', { count: item.availableStock })}
                        </span>
                      ) : null}
                    </p>
                  </div>

                  <span className="tabular shrink-0 text-sm font-bold text-ink">
                    {formatCentimes(quantity * item.unitPriceCentimes)}
                  </span>
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  {/* Modificateur « − 1 + », toujours visible : ajuster une
                      quantite est le geste courant de l'appel, pas une
                      operation a deverrouiller. */}
                  <span className="inline-flex items-center rounded-full border border-line bg-canvas">
                    <button
                      type="button"
                      aria-label={t('decreaseQuantity', { product: item.productName })}
                      className="rounded-s-full px-2.5 py-1 text-ink-2 hover:bg-surface disabled:text-muted"
                      disabled={quantity === 0}
                      onClick={() => bumpQuantity(item.id, item.quantity, -1)}
                    >
                      <Minus className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                    </button>
                    <span className="tabular w-8 text-center text-sm font-bold text-ink">
                      {quantity}
                    </span>
                    <button
                      type="button"
                      aria-label={t('increaseQuantity', { product: item.productName })}
                      className="rounded-e-full px-2.5 py-1 text-ink-2 hover:bg-surface"
                      onClick={() => bumpQuantity(item.id, item.quantity, 1)}
                    >
                      <Plus className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                    </button>
                  </span>

                  <span className="tabular text-xs text-muted">
                    {t('unitPrice', { price: formatCentimes(item.unitPriceCentimes) })}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>


        <div className="space-y-1 border-t border-line pt-2 text-sm">
          <div className="flex justify-between">
            <span className="text-ink-2">{t('itemsSubtotal')}</span>
            <Money centimes={itemsSubtotal} />
          </div>
          <div className="flex justify-between">
            <span className="text-ink-2">{t('deliveryFee')}</span>
            <Money centimes={entry.deliveryFeeCentimes} />
          </div>
          {discountTotal > 0 ? (
            <div className="flex justify-between">
              <span className="text-ink-2">{t('discount')}</span>
              <Money centimes={-discountTotal} />
            </div>
          ) : null}
        </div>

        {/* Le TOTAL A ENCAISSER est le chiffre que l'agent prononce au
            telephone : il sort de la liste des lignes et prend un fond a lui. */}
        <div className="flex items-center justify-between rounded-xl bg-ink px-3 py-2.5 text-white">
          <span className="text-xs font-bold uppercase tracking-wide">{t('totalDue')}</span>
          <span className="tabular text-xl font-extrabold">
            {formatCentimes(provisionalTotal)}
          </span>
        </div>
        {itemsDirty ? <p className="field-hint">{t('provisionalTotalHint')}</p> : null}

        <Textarea
          label={t('observationLabel')}
          placeholder={t('notePlaceholder')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
        />

        {entry.notes ? (
          <div className="rounded-lg bg-surface px-3 py-2">
            <p className="field-label">{t('orderNote')}</p>
            <p className="text-sm text-ink-2">{entry.notes}</p>
          </div>
        ) : null}
      </section>

      {/* ================= Colonne 3 — Decision de l'appel ================= */}
      <section className="space-y-3">
        <p className="eyebrow">{t('decisionSection')}</p>

        {/* --- CONFIRMER : la seule issue qui sort la commande de la file ---
            Elle la fait passer en PREPARATION. Toutes les autres — tentative,
            report, annulation — la laissent ici, ou l'ecrivent simplement
            autrement. C'est pourquoi ce bouton est seul en haut, en vert, et
            les autres tiennent dans une liste. */}
        <Button
          variant="success"
          size="lg"
          className="w-full justify-between"
          loading={actionMutation.isPending && actionMutation.variables?.action === 'CONFIRM'}
          disabled={actionMutation.isPending}
          onClick={() => runAction('CONFIRM')}
        >
          <span>{t('actions.CONFIRM')}</span>
          <kbd className="rounded border border-current/30 px-1 text-[10px] opacity-70">F1</kbd>
        </Button>

        {/* --- ENREGISTRER LES MODIFICATIONS ---
            Deuxieme bouton, et deuxieme intention : il ecrit ce que l'agent a
            corrige — coordonnees, quantites — SANS toucher au statut. Sans
            lui, la seule facon de sauver une adresse rectifiee serait de
            confirmer la commande, c'est-a-dire de decider a la place du
            client.

            Il ne s'affiche actif que s'il y a reellement quelque chose a
            enregistrer : un bouton toujours cliquable qui parfois n'ecrit rien
            n'apprend rien a l'agent. */}
        <Button
          variant="secondary"
          className="w-full"
          disabled={!hasPendingEdits || savingEdits}
          loading={savingEdits}
          onClick={saveEdits}
        >
          {t('saveEdits')}
        </Button>
        {hasPendingEdits ? (
          <p className="text-xs text-warning">{tCommon('unsavedChanges')}</p>
        ) : null}

        {/* --- Statut : cinq issues, pas une de plus --- */}
        <Select
          label={tCommon('status')}
          value=""
          disabled={actionMutation.isPending}
          onChange={(event) => {
            const chosen = STATUS_CHOICES.find((entry) => entry.key === event.target.value);
            if (chosen) runAction(chosen.action);
          }}
        >
          <option value="">{tCommon('select')}</option>
          {STATUS_CHOICES.map((choice) => (
            <option
              key={choice.key}
              value={choice.key}
              // Seule la tentative qui suit reellement est selectionnable : le
              // compteur avance de lui-meme, il ne se choisit pas.
              disabled={choice.attempt !== undefined && choice.attempt !== nextAttempt}
            >
              {t(`statusChoices.${choice.key}`)}
            </option>
          ))}
        </Select>

        <Input
          label={t('callbackAt')}
          type="datetime-local"
          value={callbackAt}
          onChange={(event) => setCallbackAt(event.target.value)}
          hint={t('callbackHint')}
        />

        <Input
          label={t('reasonLabel')}
          placeholder={t('reasonPlaceholder')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />

        {/* --- Historique des tentatives ---
            Il repond a la question que l'agent se pose avant de composer :
            « a-t-on deja essaye, quand, et qu'a-t-on obtenu ? » */}
        <div className="border-t border-line pt-2">
          <p className="eyebrow">{t('attemptsHistory')}</p>
          {entry.attempts.length === 0 ? (
            <p className="mt-1 text-xs text-muted">{t('noAttempt')}</p>
          ) : (
            <ol className="mt-1.5 space-y-2">
              {entry.attempts.map((attempt) => (
                <li key={attempt.attemptNumber} className="border-s-2 border-peach ps-2.5">
                  <p className="text-xs font-bold text-ink">
                    {t('attemptLine', {
                      number: attempt.attemptNumber,
                      outcome: tOutcome(attempt.outcome),
                    })}
                  </p>
                  <p className="text-xs text-muted">
                    {formatDateTime(attempt.createdAt)}
                    {attempt.agentName ? ` · ${attempt.agentName}` : ''}
                  </p>
                  {attempt.note ? (
                    <p className="mt-0.5 text-xs text-ink-2">{attempt.note}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          <p className="mt-2 text-xs text-muted">
            {t('receivedAgo', { when: relativeTime(entry.createdAt) })} ·{' '}
            {t(`sources.${entry.source}`)}
          </p>
        </div>
      </section>
    </div>
  );
}
