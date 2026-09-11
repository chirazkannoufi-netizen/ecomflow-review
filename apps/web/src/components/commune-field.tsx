'use client';

/**
 * Champ Commune : liste fermee filtree par wilaya, avec une porte de sortie.
 *
 * POURQUOI UN COMPOSANT, ET NON DEUX FOIS LA MEME REQUETE
 *   Le couple wilaya + commune se saisit a plusieurs endroits — creation de
 *   commande, correction des coordonnees pendant l'appel de confirmation, et
 *   partout ou une adresse se corrige ensuite. Recopier la requete et le
 *   comportement au changement de wilaya les ferait diverger, et la divergence
 *   serait silencieuse : un ecran filtrerait, l'autre non.
 *
 * UNE LISTE FERMEE, PLUS « AUTRE »
 *   Le rendu est celui d'un `select` : on clique, on choisit, on ne tape pas.
 *   C'est ce que l'agent attend d'un referentiel de 1541 entrees ramene a une
 *   cinquantaine par la wilaya — et une saisie libre par defaut invite aux
 *   fautes d'orthographe que le referentiel existe justement pour eviter.
 *
 *   La DERNIERE entree, « Autre / commune non listee », revele un champ texte.
 *   Ce n'est pas un ornement : c'est D-018 rendu utilisable. Le referentiel
 *   assiste la saisie, il ne la ferme pas, et aucune commune absente ne doit
 *   empecher la creation d'une commande. Sans cette porte, un `select` seul
 *   transformerait une aide en blocage — et le blocage tomberait sur les cas
 *   les plus rares, donc les moins bien couverts par le referentiel.
 *
 * UNE VALEUR HORS LISTE OUVRE « AUTRE » TOUTE SEULE
 *   A l'ouverture d'une commande dont la commune ne figure pas au referentiel
 *   — import, saisie anterieure, translitteration d'un transporteur — le champ
 *   s'affiche en mode libre avec sa valeur. La faire disparaitre dans un
 *   `select` qui ne la contient pas l'effacerait au premier enregistrement.
 */

import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api-client';
import { Input, Select } from './ui';

interface CommuneOption {
  readonly id: string;
  readonly name: string;
}

/** Valeur sentinelle de l'entree « Autre », impossible a confondre avec un nom. */
const OTHER = '__other__';

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
  const selectId = useId();

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
  const [freeText, setFreeText] = useState(false);

  // Une valeur qui n'est pas dans la liste CHARGEE bascule le champ en saisie
  // libre. La condition sur `data` est essentielle : tant que la requete n'a
  // pas repondu, toute valeur parait absente, et basculer trop tot ferait
  // clignoter le champ a chaque ouverture.
  useEffect(() => {
    if (!data || !value) return;
    if (!data.some((commune) => commune.name === value)) setFreeText(true);
  }, [data, value]);

  // Changer de wilaya remet le champ en mode liste : la porte de sortie se
  // reouvre si la nouvelle wilaya l'exige, mais ne reste pas ouverte par
  // inertie.
  useEffect(() => {
    setFreeText(false);
  }, [wilayaCode]);

  if (freeText) {
    return (
      <div>
        <Input
          label={label ?? tCommon('commune')}
          required={required}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t('communePlaceholder')}
          hint={t('communeFreeHint')}
        />
        <button
          type="button"
          className="mt-1 text-xs text-muted underline underline-offset-2 hover:text-ink"
          onClick={() => {
            setFreeText(false);
            onChange('');
          }}
        >
          {t('communeBackToList')}
        </button>
      </div>
    );
  }

  return (
    <Select
      id={selectId}
      label={label ?? tCommon('commune')}
      required={required}
      value={value}
      disabled={!wilayaCode}
      hint={
        wilayaCode && communes.length > 0
          ? t('communeCount', { count: communes.length })
          : undefined
      }
      onChange={(event) => {
        if (event.target.value === OTHER) {
          setFreeText(true);
          onChange('');
          return;
        }
        onChange(event.target.value);
      }}
    >
      <option value="">
        {wilayaCode ? tCommon('select') : t('communePickWilayaFirst')}
      </option>
      {communes.map((commune) => (
        <option key={commune.id} value={commune.name}>
          {commune.name}
        </option>
      ))}
      {/* Toujours proposee, meme quand la liste est vide : une wilaya sans
          commune connue au referentiel est precisement le cas ou la porte de
          sortie est indispensable. */}
      {wilayaCode ? <option value={OTHER}>{t('communeOther')}</option> : null}
    </Select>
  );
}
