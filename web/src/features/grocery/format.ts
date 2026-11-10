/**
 * Display helpers for Grocery_List entries: entry identity, quantities, and
 * units (Requirement 13.13).
 */
import type { GroceryEntry } from '../../api/types';

/** Identity of an entry for check-off state: `${name}|${unit}` (design.md, device storage). */
export function groceryEntryKey(entry: Pick<GroceryEntry, 'name' | 'unit'>): string {
  return `${entry.name}|${entry.unit}`;
}

/** Metric units read better as decimals ("1.5 kg") than as fractions. */
const DECIMAL_UNITS = new Set(['g', 'kg', 'mg', 'ml', 'l']);

const FRACTIONS: ReadonlyArray<readonly [number, string]> = [
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [1 / 2, '½'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
];
const FRACTION_TOLERANCE = 0.01;

function decimal(quantity: number): string {
  // At most two decimals, no trailing zeros: 1.50 → "1.5", 2.00 → "2".
  return String(Math.round(quantity * 100) / 100);
}

/** "2", "1½", "¼", "1.25" (metric), "0" for invalid input. */
export function formatQuantity(quantity: number, unit: string): string {
  if (!Number.isFinite(quantity) || quantity <= 0) return '0';
  if (Number.isInteger(quantity)) return String(quantity);
  if (DECIMAL_UNITS.has(unit)) return decimal(quantity);
  const whole = Math.floor(quantity);
  const rest = quantity - whole;
  for (const [value, glyph] of FRACTIONS) {
    if (Math.abs(rest - value) < FRACTION_TOLERANCE) return whole > 0 ? `${whole}${glyph}` : glyph;
  }
  if (rest > 1 - FRACTION_TOLERANCE) return String(whole + 1);
  return decimal(quantity);
}

/** Singular and plural labels for canonical units; abbreviations do not change. */
const UNIT_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  g: ['g', 'g'],
  kg: ['kg', 'kg'],
  mg: ['mg', 'mg'],
  ml: ['ml', 'ml'],
  l: ['l', 'l'],
  tsp: ['tsp', 'tsp'],
  tbsp: ['tbsp', 'tbsp'],
  oz: ['oz', 'oz'],
  lb: ['lb', 'lb'],
  fl_oz: ['fl oz', 'fl oz'],
  cup: ['cup', 'cups'],
  piece: ['piece', 'pieces'],
  pinch: ['pinch', 'pinches'],
  clove: ['clove', 'cloves'],
  slice: ['slice', 'slices'],
  can: ['can', 'cans'],
  bunch: ['bunch', 'bunches'],
};

/** "cup" for 1 or less, "cups" above 1; unknown units are shown as sent. */
export function formatUnit(unit: string, quantity: number): string {
  const labels = UNIT_LABELS[unit];
  if (!labels) return unit.replace(/_/g, ' ');
  return quantity > 1 ? labels[1] : labels[0];
}

/** "1½ cups", "500 g", "2 pieces". */
export function formatAmount(entry: Pick<GroceryEntry, 'quantity' | 'unit'>): string {
  const unit = formatUnit(entry.unit, entry.quantity);
  const quantity = formatQuantity(entry.quantity, entry.unit);
  return unit ? `${quantity} ${unit}` : quantity;
}
