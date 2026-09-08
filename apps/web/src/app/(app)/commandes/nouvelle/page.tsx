'use client';

/**
 * Saisie manuelle d'une commande — V1 §5.
 *
 * TOUTES LES COMMANDES N'ARRIVENT PAS PAR GOOGLE SHEETS : un appel entrant,
 * une commande prise en boutique, un client fidele sur WhatsApp. Ce formulaire
 * existe pour que ces commandes-la vivent dans le meme systeme que les autres.
 *
 * TROIS CHOIX DE CONCEPTION
 *   1. LE TELEPHONE EST VALIDE PENDANT LA FRAPPE, localement. L'agent voit
 *      immediatement la forme normalisee — inutile d'attendre un aller-retour
 *      serveur pour apprendre qu'il manque un chiffre.
 *   2. LE CLIENT EXISTANT EST RECONNU AVANT VALIDATION. Des que le numero est
 *      complet, on interroge le serveur : si le client est connu, son score de
 *      fiabilite s'affiche AVANT que l'agent ne s'engage.
 *   3. LES PRODUITS SONT CHOISIS DANS LE CATALOGUE, pas saisis librement. Une
 *      commande manuelle sans variante rattachee ne pourrait pas reserver de
 *      stock ni calculer de marge.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  WILAYAS,
  dinarsToCentimes,
  formatCentimes,
  maskPhone,
  parseAlgerianPhone,
} from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Button,
  Card,
  Input,
  ReliabilityBadge,
  Select,
  Textarea,
} from '@/components/ui';

interface Variant {
  readonly id: string;
  readonly sku: string;
  readonly label: string | null;
  readonly salePriceCentimes: number;
  readonly available: number;
}

interface Product {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly salePriceCentimes: number;
  readonly variants: readonly Variant[];
}

interface KnownCustomer {
  readonly id: string;
  readonly fullName: string;
  readonly phoneE164: string;
  readonly ordersCount: number;
  readonly deliveredCount: number;
  readonly refusedCount: number;
  readonly reliabilityScore: number | null;
  readonly reliabilityTier: string;
}

interface Line {
  readonly key: string;
  variantId: string;
  quantity: string;
  /** Prix saisi en dinars ; vide = prix du catalogue. */
  unitPrice: string;
}

function emptyLine(): Line {
  return { key: crypto.randomUUID(), variantId: '', quantity: '1', unitPrice: '' };
}

export default function NewOrderPage() {
  const t = useTranslations('newOrder');
  const tCommon = useTranslations('common');
  const router = useRouter();

  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [wilaya, setWilaya] = useState('');
  const [commune, setCommune] = useState('');
  const [addressText, setAddressText] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);

  const parsedPhone = parseAlgerianPhone(phone);
  const phoneValid = parsedPhone.ok;

  const productsQuery = useQuery({
    queryKey: ['products', 'all-for-order'],
    queryFn: () =>
      api.get<{ data: Product[] }>('/products', { query: { pageSize: 100, activeOnly: true } }),
  });

  // Recherche du client dès que le numero est valide : l'agent doit savoir a
  // qui il a affaire AVANT de saisir la commande.
  const [lookupPhone, setLookupPhone] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setLookupPhone(parsedPhone.ok ? parsedPhone.value.e164 : null);
    }, 400);
    return () => clearTimeout(timer);
  }, [phone, parsedPhone]);

  const knownCustomerQuery = useQuery({
    queryKey: ['customers', 'by-phone', lookupPhone],
    queryFn: () => api.get<KnownCustomer | null>(`/customers/by-phone/${lookupPhone}`),
    enabled: Boolean(lookupPhone),
    retry: false,
  });

  const knownCustomer = knownCustomerQuery.data ?? null;

  // Pre-remplit le nom quand le client est deja connu, sans ecraser une saisie
  // deliberee de l'agent.
  useEffect(() => {
    if (knownCustomer && customerName.trim().length === 0) {
      setCustomerName(knownCustomer.fullName);
    }
  }, [knownCustomer, customerName]);

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post<{ orderId: string; reference: string; duplicateFlags: unknown[] }>(
        '/orders',
        payload,
      ),
    onSuccess: (result) => {
      router.push(`/commandes/${result.orderId}`);
    },
    onError: (caught) => {
      setFormError(caught instanceof ApiError ? caught.userMessage : t('failed'));
    },
  });

  const products = productsQuery.data?.data ?? [];

  /** Toutes les variantes, aplaties, pour le selecteur de ligne. */
  const variantOptions = products.flatMap((product) =>
    product.variants.map((variant) => ({
      id: variant.id,
      label: `${product.name}${variant.label ? ` — ${variant.label}` : ''}`,
      sku: variant.sku,
      priceCentimes: variant.salePriceCentimes,
      available: variant.available,
    })),
  );

  function findVariant(id: string) {
    return variantOptions.find((entry) => entry.id === id) ?? null;
  }

  /** Total estime, calcule localement pour donner un repere a l'agent. */
  const itemsTotalCentimes = lines.reduce((sum, line) => {
    const variant = findVariant(line.variantId);
    if (!variant) return sum;
    const parsedPrice = line.unitPrice.trim() ? dinarsToCentimes(line.unitPrice) : null;
    const unit = parsedPrice ?? variant.priceCentimes;
    return sum + unit * (Number(line.quantity) || 0);
  }, 0);

  const deliveryFeeCentimes = deliveryFee.trim() ? (dinarsToCentimes(deliveryFee) ?? 0) : 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    if (!phoneValid) {
      setFormError(t('phoneInvalidLong'));
      return;
    }

    const filled = lines.filter((line) => line.variantId);
    if (filled.length === 0) {
      setFormError(t('noProduct'));
      return;
    }

    const payloadLines = filled.map((line) => {
      const parsedPrice = line.unitPrice.trim() ? dinarsToCentimes(line.unitPrice) : null;
      return {
        variantId: line.variantId,
        quantity: Number(line.quantity) || 1,
        ...(parsedPrice !== null ? { unitPriceCentimes: parsedPrice } : {}),
      };
    });

    createMutation.mutate({
      customerName: customerName.trim(),
      phone,
      wilaya,
      commune: commune.trim(),
      addressText: addressText.trim(),
      lines: payloadLines,
      ...(deliveryFee.trim() ? { deliveryFeeCentimes } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <Link href="/commandes">
            <span className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700">
              {tCommon('cancel')}
            </span>
          </Link>
        }
      />

      <form onSubmit={submit} className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}

          {/* --- Client --------------------------------------------------- */}
          <Card title={t('customerSection')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label={tCommon('phone')}
                type="tel"
                required
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="0555 12 34 56"
                hint={
                  parsedPhone.ok
                    ? t('phonePreview', { masked: maskPhone(parsedPhone.value.e164) })
                    : t('phoneHint')
                }
                error={phone.length > 0 && !phoneValid ? t('phoneInvalid') : null}
              />
              <Input
                label={t('customerName')}
                required
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                placeholder={t('customerNamePlaceholder')}
              />
            </div>

            {knownCustomer ? (
              <div className="mt-3 rounded-md border border-brand-200 bg-brand-50/50 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800">
                    {t('knownCustomer', { name: knownCustomer.fullName })}
                  </span>
                  <ReliabilityBadge
                    tier={knownCustomer.reliabilityTier}
                    score={knownCustomer.reliabilityScore}
                  />
                </div>
                <p className="mt-0.5 text-xs text-slate-600">
                  {t('knownCustomerStats', {
                    orders: knownCustomer.ordersCount,
                    delivered: knownCustomer.deliveredCount,
                    refused: knownCustomer.refusedCount,
                  })}{' '}
                  <Link
                    href={`/clients/${knownCustomer.id}`}
                    className="text-brand-700 underline"
                  >
                    {t('viewCustomer')}
                  </Link>
                </p>
              </div>
            ) : null}
          </Card>

          {/* --- Livraison ------------------------------------------------- */}
          <Card title={t('deliverySection')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={tCommon('wilaya')}
                required
                value={wilaya}
                onChange={(event) => setWilaya(event.target.value)}
              >
                <option value="">{tCommon('select')}</option>
                {WILAYAS.map((entry) => (
                  <option key={entry.code} value={String(entry.code)}>
                    {entry.code2} — {entry.name}
                  </option>
                ))}
              </Select>
              <Input
                label={tCommon('commune')}
                required
                value={commune}
                onChange={(event) => setCommune(event.target.value)}
                placeholder={t('communePlaceholder')}
              />
            </div>
            <div className="mt-3">
              <Textarea
                label={tCommon('address')}
                required
                rows={2}
                value={addressText}
                onChange={(event) => setAddressText(event.target.value)}
                placeholder={t('addressPlaceholder')}
              />
            </div>
          </Card>

          {/* --- Produits --------------------------------------------------- */}
          <Card
            title={t('productsSection')}
            action={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setLines([...lines, emptyLine()])}
              >
                {t('addLine')}
              </Button>
            }
          >
            {variantOptions.length === 0 && !productsQuery.isLoading ? (
              <Alert
                tone="warning"
                action={
                  <Link href="/produits">
                    <span className="text-sm font-medium underline">{t('addProduct')}</span>
                  </Link>
                }
              >
                {t('emptyCatalog')}
              </Alert>
            ) : (
              <div className="space-y-2">
                {lines.map((line, index) => {
                  const variant = findVariant(line.variantId);
                  const quantity = Number(line.quantity) || 0;
                  const shortage = variant !== null && quantity > variant.available;

                  return (
                    <div
                      key={line.key}
                      className="grid gap-2 rounded-md border border-slate-200 p-2.5 sm:grid-cols-[1fr_5rem_7rem_2rem]"
                    >
                      <Select
                        label={index === 0 ? tCommon('product') : undefined}
                        value={line.variantId}
                        onChange={(event) =>
                          setLines(
                            lines.map((entry) =>
                              entry.key === line.key
                                ? { ...entry, variantId: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      >
                        <option value="">Selectionner…</option>
                        {variantOptions.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {t('variantOption', {
                              label: entry.label,
                              sku: entry.sku,
                              available: entry.available,
                            })}
                          </option>
                        ))}
                      </Select>

                      <Input
                        label={index === 0 ? tCommon('quantity') : undefined}
                        type="number"
                        min={1}
                        value={line.quantity}
                        onChange={(event) =>
                          setLines(
                            lines.map((entry) =>
                              entry.key === line.key
                                ? { ...entry, quantity: event.target.value }
                                : entry,
                            ),
                          )
                        }
                        error={shortage ? t('insufficientStock') : null}
                      />

                      <Input
                        label={index === 0 ? t('priceColumn') : undefined}
                        inputMode="decimal"
                        value={line.unitPrice}
                        onChange={(event) =>
                          setLines(
                            lines.map((entry) =>
                              entry.key === line.key
                                ? { ...entry, unitPrice: event.target.value }
                                : entry,
                            ),
                          )
                        }
                        placeholder={
                          variant
                            ? String(Math.round(variant.priceCentimes / 100))
                            : t('pricePlaceholder')
                        }
                      />

                      <div className="flex items-end justify-center pb-1">
                        {lines.length > 1 ? (
                          <button
                            type="button"
                            className="text-sm text-slate-400 hover:text-danger"
                            aria-label={t('removeLine')}
                            onClick={() =>
                              setLines(lines.filter((entry) => entry.key !== line.key))
                            }
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title={tCommon('notes')}>
            <Textarea
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={t('notesPlaceholder')}
            />
          </Card>
        </div>

        {/* --- Recapitulatif ------------------------------------------------ */}
        <div>
          <Card title={t('summary')} className="lg:sticky lg:top-4">
            <div className="space-y-2 text-sm">
              <Input
                label={t('deliveryFee')}
                inputMode="decimal"
                value={deliveryFee}
                onChange={(event) => setDeliveryFee(event.target.value)}
                placeholder="500"
              />

              <div className="border-t border-slate-200 pt-2">
                <div className="flex justify-between">
                  <span className="text-slate-600">{t('itemsLine')}</span>
                  <span className="tabular">{formatCentimes(itemsTotalCentimes)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">{t('deliveryLine')}</span>
                  <span className="tabular">{formatCentimes(deliveryFeeCentimes)}</span>
                </div>
                <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold">
                  <span>{t('totalDue')}</span>
                  <span className="tabular">
                    {formatCentimes(itemsTotalCentimes + deliveryFeeCentimes)}
                  </span>
                </div>
              </div>

              <p className="text-xs text-slate-500">
                {t('estimateNote')}
              </p>

              <Button type="submit" className="w-full" loading={createMutation.isPending}>
                {t('submit')}
              </Button>

              <p className="text-xs text-slate-500">
                {t('queueNote')}
              </p>
            </div>
          </Card>
        </div>
      </form>
    </>
  );
}
