import type { Config } from 'tailwindcss';

/**
 * Systeme visuel EcomFlow — v2 (suite UI/UX "Foundations").
 *
 * PARTI PRIS : une interface d'OUTIL DE TRAVAIL, pas une vitrine.
 *   Un agent de confirmation passe sa journee sur cet ecran et traite des
 *   dizaines de commandes par heure. Les choix suivants en decoulent :
 *     - densite d'information elevee, marges resserrees ;
 *     - contraste eleve pour rester lisible sur un ecran d'entree de gamme ;
 *     - couleurs de STATUT tres distinctes, reconnaissables d'un coup d'oeil
 *       sans lire le libelle ;
 *     - aucune animation superflue : chaque milliseconde d'attente perçue se
 *       paie en fatigue sur une journee complete.
 *
 * `slate` et `brand` sont volontairement REDEFINIS ici (et non renommes dans
 * chaque fichier) : la quasi-totalite de l'application compose deja ses
 * couleurs a partir de ces deux echelles (`text-slate-600`, `bg-brand-600`,
 * `ring-brand-500`, ...). Remplacer les VALEURS de l'echelle plutot que son
 * usage propage instantanement la nouvelle palette (neutre chaud + encre)
 * a tous les ecrans existants, sans toucher un seul fichier de page — le
 * meme ordinal (50 = le plus clair, 900 = le plus fonce) garantit que les
 * rapports de contraste deja corrects le restent.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Neutre chaud : remplace le gris bleute par defaut de Tailwind.
        // Alignement direct sur les jetons Foundations : 50=Canvas,
        // 200=Line, 500=Muted, 700=Ink 2, 900=Ink.
        slate: {
          50: '#F7F7F5',
          100: '#F1F1EC',
          200: '#E9E9E4',
          300: '#D6D6CE',
          400: '#A6A7A8',
          500: '#777B88',
          600: '#5B5F70',
          700: '#3E4359',
          800: '#262A3D',
          900: '#171A2D',
          950: '#0F1120',
        },
        // Action primaire = Ink (jamais un bleu de marque) : le lime reste
        // reserve a LA seule action de creation d'un ecran (bouton `create`).
        brand: {
          50: '#F2F2F5',
          100: '#E6E7EC',
          200: '#C7C9D3',
          300: '#9A9DB0',
          400: '#6D7093',
          500: '#4A4D6E',
          600: '#171A2D',
          700: '#12141F',
          800: '#0A0B14',
          900: '#060710',
          950: '#030308',
        },
        canvas: '#F7F7F5',
        surface: '#FFFFFF',
        ink: { DEFAULT: '#171A2D', 2: '#3E4359' },
        muted: '#777B88',
        line: '#E9E9E4',
        lime: { DEFAULT: '#D9F45A', wash: '#F7FBE4', deep: '#4D5A0F' },
        lavender: { DEFAULT: '#D8A5F0', deep: '#6B2E8C' },
        peach: { DEFAULT: '#FFD6A3', deep: '#8A4F0A' },
        mint: { DEFAULT: '#A8E6D0', deep: '#0F6B49' },
        sky: { DEFAULT: '#A9CDF5', deep: '#1D4E8F' },
        success: '#2E9E6B',
        warning: '#B9820F',
        danger: '#CE4F47',
        info: '#3B6FD4',
        // Palette de statut historique — conservee pour compatibilite des
        // exports/documents transporteurs qui referencent encore ces cles.
        status: {
          new: '#777B88',
          confirm: '#B9820F',
          confirmed: '#2E9E6B',
          preparing: '#6B2E8C',
          shipped: '#1D4E8F',
          delivering: '#3B6FD4',
          delivered: '#0F6B49',
          failed: '#CE4F47',
          returned: '#CE4F47',
        },
      },
      fontFamily: {
        // `--font-ui` vaut Manrope en francais et IBM Plex Sans Arabic en
        // arabe (bascule par `html[lang]`, voir globals.css). Les deux
        // polices arabes de secours suivent au cas ou le telechargement
        // echoue : sans elles, l'arabe retomberait sur une serif systeme.
        sans: [
          'var(--font-ui)',
          'Segoe UI',
          'Noto Sans Arabic',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        mono: ['var(--font-plex-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Echelle resserree, alignee sur l'echelle typographique Foundations
        // (Table cell 12.5/1.4, Body 13/1.55) — densite elevee conservee.
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.125rem', { lineHeight: '1.75rem' }],
        // Jetons nommes du systeme de design (page 01 — Foundations).
        eyebrow: ['0.625rem', { lineHeight: '1', letterSpacing: '0.1em', fontWeight: '800' }],
        title: ['1.1875rem', { lineHeight: '1.25', fontWeight: '800' }],
        display: ['1.625rem', { lineHeight: '1.18', fontWeight: '800' }],
        metric: ['1.6875rem', { lineHeight: '1', fontWeight: '800' }],
      },
      borderRadius: {
        // Control(11) / Inner(14) / Card(20) / Pill(full) remplacent les
        // valeurs Tailwind par defaut aux memes noms de classe : chaque
        // `rounded-md`/`rounded-lg`/`rounded-xl` existant herite du bon
        // rayon sans edition fichier par fichier.
        md: '11px',
        lg: '14px',
        xl: '20px',
        '2xl': '20px',
      },
      boxShadow: {
        // Flat / Card / Raised / Pop — systeme d'elevation a 4 niveaux.
        flat: 'none',
        card: '0 1px 2px 0 rgb(23 26 45 / 0.04), 0 1px 3px 0 rgb(23 26 45 / 0.06)',
        panel: '0 8px 16px -4px rgb(23 26 45 / 0.10), 0 4px 6px -2px rgb(23 26 45 / 0.05)',
        raised: '0 8px 16px -4px rgb(23 26 45 / 0.10), 0 4px 6px -2px rgb(23 26 45 / 0.05)',
        pop: '0 24px 48px -12px rgb(23 26 45 / 0.25), 0 8px 16px -4px rgb(23 26 45 / 0.10)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(2px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
