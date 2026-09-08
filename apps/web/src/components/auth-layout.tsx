'use client';

/**
 * Coque des ecrans d'authentification — panneau formulaire + panneau produit.
 *
 * Le panneau de droite (sombre) est purement editorial : aucune logique
 * metier n'y vit, seulement un rappel du produit pendant que l'utilisateur
 * remplit le formulaire. En RTL, `flex-row` s'inverse naturellement avec
 * `dir="rtl"` (c'est le comportement standard de l'axe principal flexbox) :
 * le panneau sombre passe a gauche sans variante `rtl:` explicite.
 */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { LanguageSwitcher } from './language-switcher';

export interface AuthHeroStep {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
  readonly badge?: string;
}

export function AuthLayout({
  eyebrow,
  headline,
  subtitle,
  steps,
  topRight,
  children,
}: {
  eyebrow: string;
  headline: string;
  subtitle: string;
  steps: readonly AuthHeroStep[];
  topRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col bg-canvas lg:flex-row">
      {/* --- Panneau formulaire --- */}
      <div className="flex flex-1 flex-col px-6 py-8 sm:px-12 lg:px-16 lg:py-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-sm font-extrabold text-lime">
              E
            </div>
            <span className="text-lg font-extrabold text-ink">EcomFlow</span>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher persist={false} className="w-28" />
            {topRight}
          </div>
        </div>

        <div className="flex flex-1 items-center py-10">
          <div className="mx-auto w-full max-w-sm">{children}</div>
        </div>

        <p className="text-center text-xs text-muted lg:text-start">
          © {new Date().getFullYear()} EcomFlow
        </p>
      </div>

      {/* --- Panneau produit (editorial, non fonctionnel) --- */}
      <div className="relative hidden overflow-hidden bg-ink px-12 py-10 lg:flex lg:w-[46%] lg:flex-col lg:justify-center">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              'linear-gradient(rgba(217,244,90,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(217,244,90,0.08) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
          aria-hidden="true"
        />

        <div className="relative">
          <span className="eyebrow inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-lime">
            <span className="h-1.5 w-1.5 rounded-full bg-lime" />
            {eyebrow}
          </span>

          <h2 className="text-display mt-5 text-white">{headline}</h2>
          <p className="mt-3 max-w-md text-sm text-white/60">{subtitle}</p>

          <ol className="relative mt-10 space-y-6 border-s border-white/15 ps-6">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <li key={step.title} className="relative">
                  <span className="absolute -start-[calc(1.5rem+9px)] top-0.5 flex h-7 w-7 items-center justify-center rounded-lg bg-lime text-ink">
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
                  </span>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-white">{step.title}</p>
                    {step.badge ? (
                      <span className="eyebrow rounded-full bg-white/10 px-2 py-0.5 text-white/60">
                        {step.badge}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-white/55">{step.description}</p>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </main>
  );
}
