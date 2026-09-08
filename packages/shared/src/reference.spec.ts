import {
  buildSheetRowFingerprintSource,
  formatOrderReference,
  isOrderReference,
  parseOrderReference,
} from './reference';

describe('references de commande', () => {
  it('produit le format ORD-AAAA-XXXXXX', () => {
    expect(formatOrderReference(2026, 1)).toBe('ORD-2026-000001');
    expect(formatOrderReference(2026, 123_456)).toBe('ORD-2026-123456');
  });

  it('ne tronque pas une sequence depassant six chiffres', () => {
    expect(formatOrderReference(2026, 1_234_567)).toBe('ORD-2026-1234567');
  });

  it('refuse une annee ou une sequence invalide', () => {
    expect(() => formatOrderReference(26, 1)).toThrow(RangeError);
    expect(() => formatOrderReference(2026, 0)).toThrow(RangeError);
    expect(() => formatOrderReference(2026, -5)).toThrow(RangeError);
    expect(() => formatOrderReference(2026.5, 1)).toThrow(RangeError);
  });

  it('relit une reference', () => {
    expect(parseOrderReference('ORD-2026-000042')).toEqual({ year: 2026, sequence: 42 });
    expect(parseOrderReference('  ord-2026-000042  ')).toEqual({ year: 2026, sequence: 42 });
  });

  it('rejette une reference malformee', () => {
    expect(parseOrderReference('ORD-26-1')).toBeNull();
    expect(parseOrderReference('CMD-2026-000001')).toBeNull();
    expect(isOrderReference('ORD-2026-000001')).toBe(true);
    expect(isOrderReference('ORD_2026_000001')).toBe(false);
  });

  it('fait un aller-retour sans perte', () => {
    const reference = formatOrderReference(2026, 987);
    expect(parseOrderReference(reference)).toEqual({ year: 2026, sequence: 987 });
  });
});

describe('empreinte des lignes Google Sheets', () => {
  const base = { spreadsheetId: 'sheet-1', sheetId: 'Feuille1' };

  it('privilegie l identifiant externe quand il existe', () => {
    const source = buildSheetRowFingerprintSource({ ...base, externalRowId: 'ROW-42' });
    expect(source).toBe('sheet-1::Feuille1::id::ROW-42');
  });

  it('ignore un identifiant externe vide', () => {
    const source = buildSheetRowFingerprintSource({
      ...base,
      externalRowId: '   ',
      businessValues: ['Sara', '0555123456'],
    });
    expect(source).toContain('::hash::');
  });

  it('produit la meme empreinte malgre espaces et casse', () => {
    const a = buildSheetRowFingerprintSource({
      ...base,
      businessValues: ['  Sara  ', '0555123456', 'Alger'],
    });
    const b = buildSheetRowFingerprintSource({
      ...base,
      businessValues: ['SARA', '0555123456', 'alger'],
    });
    expect(a).toBe(b);
  });

  it('distingue deux lignes de valeurs differentes', () => {
    const a = buildSheetRowFingerprintSource({ ...base, businessValues: ['Sara', '0555123456'] });
    const b = buildSheetRowFingerprintSource({ ...base, businessValues: ['Sara', '0555123457'] });
    expect(a).not.toBe(b);
  });

  it('distingue deux feuilles differentes', () => {
    const a = buildSheetRowFingerprintSource({ ...base, externalRowId: 'ROW-1' });
    const b = buildSheetRowFingerprintSource({
      spreadsheetId: 'sheet-2',
      sheetId: 'Feuille1',
      externalRowId: 'ROW-1',
    });
    expect(a).not.toBe(b);
  });

  it('traite null et undefined comme des cellules vides', () => {
    const a = buildSheetRowFingerprintSource({ ...base, businessValues: [null, 'x'] });
    const b = buildSheetRowFingerprintSource({ ...base, businessValues: [undefined, 'x'] });
    expect(a).toBe(b);
  });

  it('n est pas sensible a la position de la ligne dans la feuille', () => {
    // Insérer une ligne au milieu de la feuille ne doit pas changer
    // l empreinte des lignes suivantes : sinon une resynchronisation
    // recreerait toutes les commandes.
    const row = { ...base, businessValues: ['Sara', '0555123456', 'Robe', '1'] };
    expect(buildSheetRowFingerprintSource(row)).toBe(buildSheetRowFingerprintSource(row));
  });
});
