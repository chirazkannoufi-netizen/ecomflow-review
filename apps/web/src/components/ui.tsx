'use client';

/**
 * Bibliotheque de composants EcomFlow — suite UI/UX "Foundations & Components".
 *
 * Ecrite a la main plutot qu'importee : la surface reellement necessaire tient
 * en un fichier, et une dependance de composants imposerait ses conventions de
 * theme a tout le produit pour un benefice nul a cette echelle.
 *
 * TOUS LES ETATS SONT COUVERTS — chargement, vide, erreur, succes — parce que
 * le cahier des charges les exige explicitement (V1 §26, V2 §25) et parce
 * qu'une interface qui ne dit rien pendant qu'elle travaille pousse
 * l'utilisateur a cliquer deux fois.
 *
 * REGLE DE COULEUR (page 01 — Foundations) : l'action primaire est en Ink,
 * jamais en couleur de marque vive ; le Lime est reserve a l'UNIQUE action de
 * creation d'un ecran donne (`variant="create"`). Un pastel ne porte jamais
 * seul le sens d'un statut — il est toujours accompagne d'un libelle.
 */

import clsx from 'clsx';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { forwardRef, useCallback, useId } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import {
  DEFAULT_LOCALE,
  LOCALE_TAGS,
  formatCentimes,
  type Locale,
  type OrderStatus,
} from '@ecomflow/shared';
import { useLocalePreference } from '@/i18n/provider';

// ---------------------------------------------------------------------------
// Bouton
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'create' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // Action primaire : encre — c'est la valeur par defaut de tout bouton.
  primary: 'bg-ink text-white hover:bg-ink/90 disabled:bg-ink/40',
  // Action de creation : LIME — a reserver a une seule occurrence par ecran
  // (« + Nouvelle commande », « + Nouveau produit »...).
  create: 'bg-lime text-ink-2 hover:brightness-95 disabled:opacity-40 font-bold',
  secondary:
    'bg-white text-ink-2 border border-line hover:bg-canvas disabled:text-muted',
  ghost: 'bg-transparent text-ink-2 hover:bg-canvas disabled:text-muted',
  danger: 'bg-danger text-white hover:bg-danger/90 disabled:bg-danger/40',
  success: 'bg-success text-white hover:bg-success/90 disabled:bg-success/40',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-base gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Affiche un indicateur et desactive le bouton. */
  readonly loading?: boolean;
  readonly icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // Un bouton en chargement est desactive : c'est la seule facon fiable
      // d'empecher un double envoi sur une action non idempotente.
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center rounded-md font-semibold transition-colors',
        'disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner className="h-3.5 w-3.5" /> : icon}
      {children}
    </button>
  );
});

/** Bouton icone seul — barre d'outils de tableau, actions rapides. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { readonly label: string; readonly active?: boolean }
>(function IconButton({ label, active, className, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
        active
          ? 'border-ink bg-ink text-white'
          : 'border-line bg-white text-ink-2 hover:bg-canvas',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Champs de formulaire
// ---------------------------------------------------------------------------

export interface FieldProps {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly children: ReactNode;
  readonly htmlFor?: string;
}

export function Field({ label, hint, error, required, children, htmlFor }: FieldProps) {
  return (
    <div>
      {label ? (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
          {required ? <span className="ms-0.5 text-danger">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? <p className="field-error">{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string | null;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <Field label={label} hint={hint} error={error} required={props.required} htmlFor={inputId}>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={clsx(
          'h-9 w-full rounded-md border bg-white px-3 text-sm text-ink transition-colors',
          'placeholder:text-muted disabled:bg-canvas disabled:text-muted',
          'focus:border-ink',
          error ? 'border-danger' : 'border-line',
          className,
        )}
        {...props}
      />
    </Field>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string | null;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, className, id, children, ...props },
  ref,
) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <Field label={label} hint={hint} error={error} required={props.required} htmlFor={selectId}>
      <select
        ref={ref}
        id={selectId}
        className={clsx(
          'h-9 w-full rounded-md border bg-white px-2.5 text-sm text-ink transition-colors',
          'focus:border-ink',
          error ? 'border-danger' : 'border-line',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    </Field>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string | null;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;

  return (
    <Field label={label} hint={hint} error={error} required={props.required} htmlFor={textareaId}>
      <textarea
        ref={ref}
        id={textareaId}
        rows={props.rows ?? 3}
        className={clsx(
          'w-full rounded-lg border bg-white px-3 py-2 text-sm text-ink transition-colors',
          'placeholder:text-muted focus:border-ink',
          error ? 'border-danger' : 'border-line',
          className,
        )}
        {...props}
      />
    </Field>
  );
});

// ---------------------------------------------------------------------------
// Cartes et sections
// ---------------------------------------------------------------------------

export function Card({
  title,
  action,
  children,
  footer,
  className,
  padded = true,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  /** Zone discrete sous le contenu : precision, note de bas de tableau. */
  footer?: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={clsx('card', className)}>
      {title || action ? (
        <header className="card-header">
          <h2 className="card-title">{title}</h2>
          {action}
        </header>
      ) : null}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
      {footer ? <div className="border-t border-line px-4 py-2.5">{footer}</div> : null}
    </section>
  );
}

/**
 * Carte metrique — fond pastel, icone circulaire, chiffre tabulaire, delta.
 *
 * Motif "Metric cards" du systeme de design : le tableau de bord et les
 * ecrans de synthese (statistiques, rentabilite) en sont composes. Le fond
 * pastel indique une CATEGORIE (neutre, attention, succes, risque...), jamais
 * un statut precis — le chiffre et le libelle restent la source de verite.
 */
const METRIC_TONES = {
  neutral: { ground: 'bg-lime-wash', icon: 'bg-lime text-ink' },
  warning: { ground: 'bg-peach/30', icon: 'bg-peach text-peach-deep' },
  success: { ground: 'bg-mint/30', icon: 'bg-mint text-mint-deep' },
  info: { ground: 'bg-sky/30', icon: 'bg-sky text-sky-deep' },
  danger: { ground: 'bg-lavender/25', icon: 'bg-lavender text-lavender-deep' },
} as const;

export function MetricCard({
  label,
  value,
  delta,
  deltaTone,
  hint,
  icon,
  tone = 'neutral',
  href,
}: {
  label: string;
  value: ReactNode;
  delta?: string;
  deltaTone?: 'success' | 'danger' | 'neutral';
  hint?: string;
  icon?: ReactNode;
  tone?: keyof typeof METRIC_TONES;
  href?: string;
}) {
  const tones = METRIC_TONES[tone];
  const deltaClass =
    deltaTone === 'success'
      ? 'text-success'
      : deltaTone === 'danger'
        ? 'text-danger'
        : 'text-muted';

  // La carte est entierement composee de proprietes LOGIQUES : `justify-between`
  // met le libelle au debut et l'icone a la fin de la ligne, donc a gauche puis
  // a droite en francais et l'inverse en arabe, sans une seule regle dediee.
  //
  // `min-w-0` sur le libelle est ce qui empeche l'icone de se faire pousser
  // hors de la carte : par defaut un element flex refuse de descendre sous la
  // largeur de son contenu (`min-width: auto`), et un libelle arabe long —
  // « المرتجعات والرفض » sur une carte de 2 colonnes — depassait donc sous
  // l'icone au lieu de passer a la ligne.
  const content = (
    <div className={clsx('rounded-xl p-4', tones.ground)}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-xs font-bold text-ink-2">{label}</p>
        {icon ? (
          <span className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', tones.icon)}>
            {icon}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-metric text-ink">
        <Numeric>{value}</Numeric>
      </p>
      {delta || hint ? (
        <p className="mt-1 text-xs text-ink-2">
          {/* Le delta est un nombre signe (« +12,4 % ») : il s'isole. Le
              `hint` est de la prose traduite, il suit la langue. */}
          {delta ? <Numeric className={clsx('font-bold', deltaClass)}>{delta}</Numeric> : null}
          {delta && hint ? ' ' : null}
          {hint ? <span className="text-muted">{hint}</span> : null}
        </p>
      ) : null}
    </div>
  );

  return href ? (
    <a href={href} className="block transition-shadow hover:shadow-raised">
      {content}
    </a>
  ) : (
    content
  );
}

// ---------------------------------------------------------------------------
// Etats : chargement, vide, erreur
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin', className ?? 'h-4 w-4')} aria-hidden="true" />;
}

export function LoadingState({ label }: { label?: string }) {
  const t = useTranslations('common');

  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
      <Spinner />
      <span>{label ?? t('loading')}</span>
    </div>
  );
}

/**
 * Etat vide.
 *
 * Il dit toujours QUOI FAIRE : un ecran vide sans action laisse
 * l'utilisateur bloque, surtout au premier usage.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon ? (
        <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-lime-wash text-ink-2">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-bold text-ink">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/**
 * Etat d'erreur, avec possibilite de reessayer.
 *
 * L'identifiant de correlation est affiche : c'est ce que l'utilisateur
 * communiquera au support pour retrouver la trace exacte de son incident.
 */
export function ErrorState({
  title,
  message,
  correlationId,
  onRetry,
}: {
  title?: string;
  message: string;
  correlationId?: string;
  onRetry?: () => void;
}) {
  const t = useTranslations('common');

  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-danger/10 text-danger">
        <AlertTriangle className="h-5 w-5" strokeWidth={1.6} aria-hidden="true" />
      </div>
      <p className="text-sm font-bold text-ink">{title ?? t('errorTitle')}</p>
      <p className="max-w-md text-sm text-ink-2">{message}</p>
      {correlationId ? (
        <p className="font-mono text-xs text-muted">
          {t('correlationId', { id: correlationId })}
        </p>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          {t('retry')}
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/**
 * Couleur par statut de commande.
 *
 * Chaque famille du cycle de vie (page 01 — Foundations : Import -> New ->
 * To Confirm -> Confirmed -> Preparation -> Ready to Ship -> Shipped ->
 * Out for Delivery -> Delivered, plus les 4 sorties Returned/Refused/
 * Cancelled/Wrong Number) recoit un pastel dedie. Le pastel ne porte jamais
 * seul le sens : le libelle traduit reste toujours affiche a cote.
 */
/**
 * LES QUATRE STATUTS DE LA FILE D'APPEL SE DISTINGUENT A L'OEIL.
 *
 * Ils partageaient tous la meme teinte peche. Dans la colonne STATUT du
 * centre de confirmation — la seule colonne qu'un agent balaie pour decider
 * par quoi commencer — « Sans reponse » et « Rappel prevu » etaient donc
 * strictement identiques, et la couleur n'apportait rien : il fallait lire.
 *
 * La repartition suit ce que chaque statut demande a l'agent :
 *   A CONFIRMER    ciel      — entree dans la file, personne n'a encore appele
 *   SANS REPONSE   gris/rouge — on a essaye, ca a echoue
 *   RAPPEL PREVU   peche     — une heure est fixee, l'attente est normale
 *   REPORTEE       alerte    — repoussee a la demande du client
 *
 * `ring` et texte restent lisibles sur fond clair : une pastille ne porte
 * jamais le sens seule (systeme de design, planche 4) — teinte, libelle, et
 * un point.
 */
const STATUS_STYLES: Record<OrderStatus, string> = {
  NEW: 'bg-slate-100 text-ink-2 ring-slate-200',
  TO_CONFIRM: 'bg-sky/35 text-sky-deep ring-sky/50',
  NO_ANSWER: 'bg-slate-100 text-danger ring-danger/30',
  CALL_BACK: 'bg-peach/40 text-peach-deep ring-peach/60',
  POSTPONED: 'bg-warning/10 text-warning ring-warning/30',
  WRONG_NUMBER: 'bg-danger/10 text-danger ring-danger/25',
  CONFIRMED: 'bg-mint/40 text-mint-deep ring-mint/60',
  IN_PREPARATION: 'bg-lavender/25 text-lavender-deep ring-lavender/40',
  READY_TO_SHIP: 'bg-sky/35 text-sky-deep ring-sky/50',
  SHIPPED: 'bg-sky/35 text-sky-deep ring-sky/50',
  IN_DELIVERY: 'bg-info/10 text-info ring-info/25',
  DELIVERED: 'bg-mint/40 text-mint-deep ring-mint/60',
  CANCELLED: 'bg-slate-100 text-muted ring-slate-200',
  REFUSED: 'bg-danger/10 text-danger ring-danger/25',
  RETURNED: 'bg-danger/10 text-danger ring-danger/25',
};

export function StatusBadge({ status }: { status: string }) {
  // Le libelle vient du catalogue de traduction, pas des constantes partagees :
  // celles-ci restent francaises car l'API les utilise aussi pour les exports
  // et les documents transporteurs, qui ne sont pas traduits.
  const t = useTranslations('orderStatus');
  const style = STATUS_STYLES[status as OrderStatus] ?? 'bg-slate-100 text-ink-2 ring-slate-200';
  const label = t.has(status) ? t(status) : status;

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ring-1 ring-inset',
        style,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

const TONE_STYLES = {
  neutral: 'bg-slate-100 text-ink-2 ring-slate-200',
  info: 'bg-info/10 text-info ring-info/25',
  success: 'bg-success/10 text-success ring-success/25',
  warning: 'bg-warning/10 text-warning ring-warning/25',
  danger: 'bg-danger/10 text-danger ring-danger/25',
} as const;

export type BadgeTone = keyof typeof TONE_STYLES;

export function Badge({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  /** Infobulle : explique un libelle court sans allonger la pastille. */
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ring-1 ring-inset',
        TONE_STYLES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Pastille de fiabilite client (Addendum §32).
 *
 * Affiche le niveau ET le score : un agent ne doit jamais avoir a deviner ce
 * que signifie une couleur. Le detail des facteurs est visible dans la fiche.
 */
export function ReliabilityBadge({
  tier,
  score,
}: {
  tier: string;
  score: number | null;
}) {
  const t = useTranslations('reliability');

  const tones: Record<string, BadgeTone> = {
    RELIABLE: 'success',
    WATCH: 'warning',
    AT_RISK: 'danger',
    UNKNOWN: 'neutral',
  };

  const known = tier in tones ? tier : 'UNKNOWN';

  return (
    <Badge tone={tones[known] ?? 'neutral'}>
      {t(known)}
      {score !== null ? <span className="ms-1 tabular opacity-70">{score}</span> : null}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Nombres et montants
// ---------------------------------------------------------------------------

/**
 * Isole un fragment NUMERIQUE du sens de lecture ambiant.
 *
 * POURQUOI CE COMPOSANT EXISTE
 *   L'algorithme bidirectionnel d'Unicode reordonne les caracteres neutres
 *   — « - », « + », « % », « DA » — selon la direction du PARAGRAPHE qui les
 *   contient, pas selon celle du nombre. Dans une page arabe, « -1 234,00 DA »
 *   s'affiche donc « 1 234,00 DA- » : le signe saute a l'autre bout. Sur un
 *   tableau de rentabilite, une perte se lit alors comme un gain — c'est un
 *   defaut de LISIBILITE COMPTABLE, pas un detail cosmetique.
 *
 *   `dir="ltr"` vaut, dans la feuille de style du navigateur,
 *   `direction: ltr; unicode-bidi: isolate` : le fragment est compose de
 *   gauche a droite ET traite comme un bloc opaque par le reste de la ligne.
 *   Le chiffre est donc CARACTERE POUR CARACTERE identique au francais.
 *
 *   L'isolation ne touche pas a l'ALIGNEMENT : celui-ci reste decide par le
 *   conteneur, donc un « 12,5 % » reste colle au bord droit d'une carte
 *   arabe. C'est exactement la parite recherchee — meme nombre, cote miroir.
 */
export function Numeric({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span dir="ltr" className={clsx('tabular', className)}>
      {children}
    </span>
  );
}

/** Affiche un montant en centimes, formate en dinars. */
export function Money({
  centimes,
  className,
  bold,
}: {
  centimes: number;
  className?: string;
  bold?: boolean;
}) {
  return (
    <Numeric className={clsx('whitespace-nowrap', bold && 'font-bold', className)}>
      {formatCentimes(centimes)}
    </Numeric>
  );
}

/**
 * Montant signe, colore selon son sens economique.
 * Un resultat negatif doit sauter aux yeux sur un tableau de rentabilite.
 */
export function SignedMoney({ centimes }: { centimes: number }) {
  return (
    <Numeric
      className={clsx(
        'whitespace-nowrap font-semibold',
        centimes < 0 ? 'text-danger' : centimes > 0 ? 'text-success' : 'text-ink-2',
      )}
    >
      {centimes > 0 ? '+' : ''}
      {formatCentimes(centimes)}
    </Numeric>
  );
}

/**
 * Identifiant technique — reference de commande, SKU, numero de suivi.
 * Police Mono dediee (jeton "Mono" du systeme de design) : un identifiant se
 * recopie caractere par caractere, la chasse fixe evite toute ambiguite
 * entre 0/O ou 1/l/I.
 */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('font-mono tabular tracking-tight', className)}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Confirmation d'action critique (V1 §26)
// ---------------------------------------------------------------------------

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  loading,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const t = useTranslations('common');

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md animate-fade-in rounded-xl bg-white shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-bold text-ink">{title}</h3>
        </div>
        <div className="space-y-3 px-4 py-4">
          {message ? <p className="text-sm text-ink-2">{message}</p> : null}
          {children}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={loading}>
            {cancelLabel ?? t('cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel ?? t('confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bandeaux
// ---------------------------------------------------------------------------

const ALERT_ICONS = {
  info: Info,
  warning: AlertTriangle,
  danger: XCircle,
  success: CheckCircle2,
} as const;

export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const styles = {
    info: 'bg-sky/20 border-sky/50 text-sky-deep',
    warning: 'bg-peach/25 border-peach/60 text-peach-deep',
    danger: 'bg-danger/10 border-danger/30 text-danger',
    success: 'bg-mint/25 border-mint/60 text-mint-deep',
  } as const;

  const Icon = ALERT_ICONS[tone];

  return (
    <div className={clsx('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm', styles[tone])}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      {/* `min-w-0` : un message long doit passer a la ligne DANS sa colonne
          plutot que d'elargir la ligne et de repousser l'action. Sans lui,
          la position du bouton dependait de la longueur du texte, donc de la
          langue — c'est ce qui decalait les actions en arabe. */}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-bold">{title}</p> : null}
        <div className={title ? 'mt-0.5' : undefined}>{children}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const t = useTranslations('common');

  if (totalPages <= 1) {
    return (
      <div className="px-3 py-2 text-xs text-muted">{t('results', { count: total })}</div>
    );
  }

  return (
    <div className="flex items-center justify-between border-t border-line px-3 py-2">
      <span className="text-xs text-muted">
        {t('page', { page, total: totalPages })} — {t('results', { count: total })}
      </span>
      <div className="flex gap-1">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          {t('previous')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          {t('next')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------

/**
 * POURQUOI LES DATES RESTENT EN `fr-DZ` DANS LES DEUX LANGUES
 *
 *   `formatDate` et `formatDateTime` ne produisent que des CHIFFRES et des
 *   separateurs — « 31/08/2026 ». Il n'y a pas un mot a traduire, et les
 *   chiffres sont latins dans les deux langues (voir D-037). La sortie est
 *   donc deja identique pour un lecteur arabophone, a ceci pres que `ar-DZ`
 *   y insererait des marques de direction invisibles qui desalignent les
 *   colonnes de tableau.
 *
 *   `formatRelative`, lui, produit des MOTS — « il y a 9 jours ». C'est une
 *   distinction de nature, pas de degre : voir la fonction plus bas.
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('fr-DZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('fr-DZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Duree relative lisible : « il y a 3 heures », « قبل 3 ساعات ».
 *
 * CETTE FONCTION PRODUIT DES MOTS, ET DOIT DONC SUIVRE LA LANGUE.
 *   Elle etait figee sur `'fr'`. Une interface arabe affichait par consequent
 *   « وردت il y a 9 jours » — du francais au milieu d'une phrase arabe, dans
 *   la file de confirmation, l'ecran le plus regarde du produit. Le defaut ne
 *   pouvait pas se voir en francais, ou la valeur figee est justement la
 *   bonne.
 *
 *   L'etiquette passe par `LOCALE_TAGS` : `ar-DZ` donne « قبل 9 أيام », avec
 *   des chiffres LATINS, la ou `ar-EG` donnerait « قبل ٩ أيام » (D-037).
 *
 * Preferer le hook `useRelativeTime` dans un composant : il fournit la langue
 * courante sans avoir a la passer a chaque appel.
 */
export function formatRelative(
  value: string | Date | null | undefined,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat(LOCALE_TAGS[locale], { numeric: 'auto' });

  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return formatter.format(diffHours, 'hour');
  return formatter.format(Math.round(diffHours / 24), 'day');
}

/**
 * `formatRelative` lie a la langue de l'interface.
 *
 * LA LANGUE VIENT DE `useLocalePreference`, PAS DE `useLocale` DE NEXT-INTL.
 *   Le fournisseur est monte avec l'ETIQUETTE COMPLETE (`LOCALE_TAGS[locale]`,
 *   donc « ar-DZ »), parce que c'est elle qui commande le formatage ICU des
 *   nombres et des dates. `useLocale()` rend donc « ar-DZ » la ou le type
 *   `Locale` du produit vaut « ar » — deux vocabulaires proches qu'il est
 *   facile de confondre, et la confusion est silencieuse : un filtrage sur
 *   `isLocale('ar-DZ')` echoue sans bruit et retombe sur le francais, ce qui
 *   redonne exactement le defaut que ce hook corrige.
 *
 *   `useLocalePreference` expose la valeur canonique (`'fr' | 'ar'`), typee,
 *   et c'est l'autorite du produit en matiere de langue.
 */
export function useRelativeTime(): (value: string | Date | null | undefined) => string {
  const { locale } = useLocalePreference();
  return useCallback((value: string | Date | null | undefined) => formatRelative(value, locale), [
    locale,
  ]);
}

/** Formatte un pourcentage, ou « — » si la valeur est absente. */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(digits)} %`;
}
