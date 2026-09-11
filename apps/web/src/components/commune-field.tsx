'use client';

/**
 * Champ Commune, suggestions filtrees par la wilaya choisie.
 *
 * POURQUOI UN COMPOSANT, ET NON DEUX FOIS LA MEME REQUETE
 *   Le couple wilaya + commune se saisit a plusieurs endroits — creation de
 *   commande, correction des coordonnees pendant l'appel de confirmation, et
 *   partout ou une adresse se corrige ensuite. Recopier la requete, le
 *   `datalist` et le comportement au changement de wilaya les ferait diverger,
 *   et la divergence serait silencieuse : un ecran filtrerait, l'autre non.
 *
 * UNE SAISIE LIBRE AVEC SUGGESTIONS, PAS UNE LISTE FERMEE
 *   Le referentiel compte 1541 communes : les proposer toutes serait aussi
 *   inutilisable que de n'en proposer aucune. Filtrer par wilaya ramene le
 *   choix a une cinquantaine.
 *
 *   Mais c'est un `input` avec `datalist`, jamais un `select`. D-018 refuse de
 *   bloquer une commande parce que sa commune ne figure pas dans une liste :
 *   les translitterations varient trop d'un transporteur a l'autre pour qu'une
 *   absence signifie une erreur. On AIDE la saisie, on ne l'emprisonne pas.
 *
 * L'IDENTIFIANT DU `datalist` EST UNIQUE PAR INSTANCE
 *   Deux champs Commune sur une meme page — le cas du tiroir de confirmation
 *   ouvert au-dessus d'une liste — partageraient sinon la meme liste, et le
 *   second afficherait les suggestions du premier.
 */

import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api-client';
import { Input } from './ui';

interface CommuneOption {
  readonly id: string;
  readonly name: string;
}

export function CommuneField({
  wilayaCode,
  value,
  onChange,
  required,
  label,
}: {
  /** Code de la wilaya selectionnee, ou chaine vide tant qu'aucune ne l'est. */
  readonly wilayaCode: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly required?: boolean;
  readonly label?: string;
}) {
  const t = useTranslations('geo');
  const tCommon = useTranslations('common');
  const listId = useId();

  const { data } = useQuery({
    queryKey: ['geo', 'communes', wilayaCode],
    queryFn: () => api.get<CommuneOption[]>(`/geo/wilayas/${wilayaCode}/communes`),
    // Chargee A LA DEMANDE : les 1541 communes representent une cinquantaine de
    // kilo-octets, que la plupart des ecrans n'ouvriront jamais.
    enabled: Boolean(wilayaCode),
    // Un decoupage administratif ne change pas pendant une session de travail.
    staleTime: Infinity,
  });

  const communes = data ?? [];

  return (
    <div>
      <Input
        label={label ?? tCommon('commune')}
        required={required}
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={wilayaCode ? t('communePlaceholder') : t('communePickWilayaFirst')}
        hint={wilayaCode && communes.length > 0 ? t('communeCount', { count: communes.length }) : undefined}
      />
      <datalist id={listId}>
        {communes.map((commune) => (
          <option key={commune.id} value={commune.name} />
        ))}
      </datalist>
    </div>
  );
}
