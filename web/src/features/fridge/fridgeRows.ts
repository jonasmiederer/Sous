/**
 * Pure helpers for the fridge editor (Requirements 4.3, 4.4, 13.14).
 *
 * A row keeps the quantity as the text the User typed, so "1," or "" can be
 * edited freely. Validity mirrors `isValidFridgeItem` in src/domain/fridge.ts:
 * a name that is non-empty after trimming and a finite quantity above 0.
 */
import { CANONICAL_UNITS, canonicalUnit, normalizeIngredientName, type CanonicalUnit } from '@sous/domain/units';
import type { Ingredient } from '../../api/types';

/** Server limit on items per recording (`MAX_FRIDGE_ITEMS` in the Fridge Service). */
export const MAX_FRIDGE_ROWS = 500;
export const DEFAULT_UNIT: CanonicalUnit = 'piece';

export interface FridgeRow {
  /** Stable client-side key for React lists. */
  key: string;
  name: string;
  /** Raw quantity text, e.g. "1.5" or "1,5". */
  quantity: string;
  unit: string;
}

export const UNIT_LABELS: Record<CanonicalUnit, string> = {
  g: 'grams (g)',
  kg: 'kilograms (kg)',
  mg: 'milligrams (mg)',
  ml: 'millilitres (ml)',
  l: 'litres (l)',
  tsp: 'teaspoons',
  tbsp: 'tablespoons',
  cup: 'cups',
  oz: 'ounces (oz)',
  lb: 'pounds (lb)',
  fl_oz: 'fluid ounces',
  piece: 'pieces',
  pinch: 'pinches',
  clove: 'cloves',
  slice: 'slices',
  can: 'cans',
  bunch: 'bunches',
};

export function isCanonicalUnit(unit: string): unit is CanonicalUnit {
  return (CANONICAL_UNITS as readonly string[]).includes(unit);
}

/** Friendly label for a unit; unknown units are shown as stored. */
export function unitLabel(unit: string): string {
  return isCanonicalUnit(unit) ? UNIT_LABELS[unit] : unit;
}

/** Parses the quantity text; accepts a comma decimal separator. NaN when not a number. */
export function parseQuantity(text: string): number {
  const trimmed = text.trim().replace(',', '.');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

export function formatQuantity(quantity: number): string {
  return Number.isFinite(quantity) ? String(quantity) : '';
}

export type RowProblem = 'name' | 'quantity';

/** Problem with a row, or null when it is a valid fridge item. */
export function rowProblem(row: FridgeRow): RowProblem | null {
  if (normalizeIngredientName(row.name).length === 0) return 'name';
  const q = parseQuantity(row.quantity);
  if (!Number.isFinite(q) || q <= 0) return 'quantity';
  return null;
}

/** A row the User has not filled in at all; it is ignored on save. */
export function isBlankRow(row: FridgeRow): boolean {
  return row.name.trim() === '' && row.quantity.trim() === '';
}

export function hasValidRow(rows: readonly FridgeRow[]): boolean {
  return rows.some((r) => rowProblem(r) === null);
}

export interface SavePlan {
  /** The PUT /fridge body items, in order. */
  items: Ingredient[];
  /** `rows` entries matching each submitted item, so `droppedIndexes` map back to rows. */
  submittedRows: FridgeRow[];
}

/**
 * The full-replace recording for PUT /fridge. Blank rows are skipped; filled
 * but invalid rows are still sent so the server reports them as dropped.
 */
export function planSave(rows: readonly FridgeRow[]): SavePlan {
  const submittedRows = rows.filter((r) => !isBlankRow(r));
  const items = submittedRows.map((r) => {
    const q = parseQuantity(r.quantity);
    return { name: r.name.trim(), quantity: Number.isFinite(q) ? q : 0, unit: r.unit };
  });
  return { items, submittedRows };
}

/** Normalizes a stored unit to the select's value: canonical when known, else kept as is. */
export function rowUnit(unit: string): string {
  const canonical = canonicalUnit(unit);
  return isCanonicalUnit(canonical) ? canonical : unit;
}

let keyCounter = 0;
export function newRowKey(): string {
  keyCounter += 1;
  return `row-${keyCounter}`;
}

export function rowsFromItems(items: readonly Ingredient[]): FridgeRow[] {
  return items.map((i) => ({ key: newRowKey(), name: i.name, quantity: formatQuantity(i.quantity), unit: rowUnit(i.unit) }));
}

export function emptyRow(): FridgeRow {
  return { key: newRowKey(), name: '', quantity: '', unit: DEFAULT_UNIT };
}

/** Comparable form of a row list, ignoring keys and blank rows. */
export function rowsSignature(rows: readonly FridgeRow[]): string {
  return JSON.stringify(
    rows.filter((r) => !isBlankRow(r)).map((r) => [r.name.trim(), r.quantity.trim().replace(',', '.'), r.unit]),
  );
}

/**
 * Parses a quick-add phrase: "eggs" → 1 piece of eggs, "6 eggs" → 6 pieces,
 * "500 g flour" or "500g flour" → 500 g, "2 cans tomatoes" → 2 cans.
 * Returns null when no name remains.
 */
export function parseQuickAdd(text: string): Omit<FridgeRow, 'key'> | null {
  const input = text.trim().replace(/\s+/g, ' ');
  if (input === '') return null;
  const match = /^(\d+(?:[.,]\d+)?)\s*(.*)$/.exec(input);
  if (!match) return { name: input, quantity: '1', unit: DEFAULT_UNIT };
  const quantity = match[1]!.replace(',', '.');
  const rest = match[2]!.trim();
  if (rest === '') return null;
  const space = rest.indexOf(' ');
  if (space > 0) {
    const token = rest.slice(0, space);
    const unit = canonicalUnit(token);
    const name = rest.slice(space + 1).replace(/^of\s+/i, '').trim();
    if (isCanonicalUnit(unit) && name !== '') return { name, quantity, unit };
  }
  return { name: rest, quantity, unit: DEFAULT_UNIT };
}
