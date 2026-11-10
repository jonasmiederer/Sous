/**
 * Ingredient quantity / unit model and canonical unit compatibility rules.
 *
 * Two ingredient occurrences are compatible only when their normalized names
 * match AND their units resolve to the same canonical unit (Requirements 7.2,
 * 7.3, 7.4). No cross-unit conversion is performed: `g` and `kg` are distinct
 * canonical units and therefore incompatible.
 */

/** Canonical unit identifiers. Aliases below map onto these. */
export const CANONICAL_UNITS = [
  'g',
  'kg',
  'mg',
  'ml',
  'l',
  'tsp',
  'tbsp',
  'cup',
  'oz',
  'lb',
  'fl_oz',
  'piece',
  'pinch',
  'clove',
  'slice',
  'can',
  'bunch',
] as const;

export type CanonicalUnit = (typeof CANONICAL_UNITS)[number];

const UNIT_ALIASES: Readonly<Record<string, CanonicalUnit>> = {
  g: 'g',
  gram: 'g',
  grams: 'g',
  gr: 'g',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  l: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  tsp: 'tsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  tbsp: 'tbsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  cup: 'cup',
  cups: 'cup',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  'fl oz': 'fl_oz',
  fl_oz: 'fl_oz',
  floz: 'fl_oz',
  'fluid ounce': 'fl_oz',
  'fluid ounces': 'fl_oz',
  '': 'piece',
  pc: 'piece',
  pcs: 'piece',
  piece: 'piece',
  pieces: 'piece',
  unit: 'piece',
  units: 'piece',
  whole: 'piece',
  pinch: 'pinch',
  pinches: 'pinch',
  clove: 'clove',
  cloves: 'clove',
  slice: 'slice',
  slices: 'slice',
  can: 'can',
  cans: 'can',
  bunch: 'bunch',
  bunches: 'bunch',
};

/** Collapse whitespace and lower-case. Used for both names and units. */
function normalizeToken(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Resolve a unit string to its canonical form. Unknown units are returned in
 * normalized form, so two identical unknown units remain compatible with each
 * other but not with any other unit.
 */
export function canonicalUnit(unit: string): string {
  const normalized = normalizeToken(unit);
  return UNIT_ALIASES[normalized] ?? normalized;
}

/** Normalize an ingredient name for matching (case/whitespace-insensitive). */
export function normalizeIngredientName(name: string): string {
  return normalizeToken(name);
}

/** Anything carrying a name and a unit can be compared for compatibility. */
export interface NamedUnit {
  readonly name: string;
  readonly unit: string;
}

/** Same normalized name + same canonical unit. */
export function areCompatible(a: NamedUnit, b: NamedUnit): boolean {
  return (
    normalizeIngredientName(a.name) === normalizeIngredientName(b.name) &&
    canonicalUnit(a.unit) === canonicalUnit(b.unit)
  );
}

/**
 * Stable key identifying a compatibility class. Two occurrences share a key
 * iff `areCompatible` returns true for them.
 */
export function compatibilityKey(item: NamedUnit): string {
  return `${normalizeIngredientName(item.name)}\u0000${canonicalUnit(item.unit)}`;
}
