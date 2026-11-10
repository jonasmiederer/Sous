/**
 * Default deterministic parser from a free-text fridge Transcript to fridge
 * recording items `{ name, quantity, unit }`.
 *
 * The parser is pluggable (see FridgeTranscriptParser); this default handles
 * the common spoken forms:
 *
 *   "2 liters of milk, a dozen eggs and some cheese"
 *     -> milk 2 l, eggs 12 piece, cheese 1 piece
 *
 * Rules:
 * - Items are separated by commas, semicolons, newlines, `&`, or the word
 *   "and". Dish names containing "and" are therefore split; the User can
 *   correct the Transcript before confirming (Requirement 11.3).
 * - Optional leading quantity: a number (`2`, `1.5`, `1/2`), a number word
 *   (`one`..`twenty`, `a`, `an`, `half`, `a couple`), optionally followed by
 *   `dozen` (x12). Missing quantity defaults to 1.
 * - Optional unit after the quantity, recognized by canonicalUnit's alias
 *   table (two-word aliases like "fluid ounces" included); an optional "of"
 *   after the unit is dropped. Missing unit defaults to `piece`.
 * - Leading filler ("some", "a few", "a bit of", "about") is dropped.
 * - Segments with no remaining name are skipped. The fridge service applies
 *   its own validation to whatever this returns.
 */
import type { Ingredient } from '../../domain/types.js';
import { canonicalUnit, CANONICAL_UNITS } from '../../domain/units.js';

export type FridgeTranscriptParser = (transcript: string) => Ingredient[];

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  half: 0.5,
};

const FILLER_PREFIXES = [/^about\s+/, /^around\s+/, /^some\s+/, /^a\s+few\s+/, /^a\s+bit\s+of\s+/, /^a\s+little\s+/];

const KNOWN_CANONICAL = new Set<string>(CANONICAL_UNITS);

/** True if canonicalUnit maps the token to a known canonical unit. */
function isUnitToken(token: string): boolean {
  return token.length > 0 && KNOWN_CANONICAL.has(canonicalUnit(token));
}

function parseNumberToken(token: string): number | undefined {
  if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
  const fraction = /^(\d+)\/(\d+)$/.exec(token);
  if (fraction) {
    const d = Number(fraction[2]);
    return d === 0 ? undefined : Number(fraction[1]) / d;
  }
  return NUMBER_WORDS[token];
}

function parseSegment(segment: string): Ingredient | undefined {
  let text = segment
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const filler of FILLER_PREFIXES) text = text.replace(filler, '');
  let tokens = text.split(' ').filter((t) => t.length > 0);

  let quantity = 1;
  let sawQuantity = false;
  // "a couple of" -> 2
  if (tokens[0] === 'a' && tokens[1] === 'couple') {
    quantity = 2;
    sawQuantity = true;
    tokens = tokens.slice(tokens[2] === 'of' ? 3 : 2);
  } else if (tokens[0] !== undefined) {
    const n = parseNumberToken(tokens[0]);
    if (n !== undefined && n > 0) {
      quantity = n;
      sawQuantity = true;
      // "half a cup" / "half an onion"
      tokens = tokens.slice(tokens[0] === 'half' && (tokens[1] === 'a' || tokens[1] === 'an') ? 2 : 1);
    }
  }
  if (tokens[0] === 'dozen') {
    quantity = (sawQuantity ? quantity : 1) * 12;
    tokens = tokens.slice(tokens[1] === 'of' ? 2 : 1);
  }

  let unit = 'piece';
  // Two-word units first ("fl oz", "fluid ounces"), then one-word units.
  // A unit needs a following name, so "2 cans" alone is name "cans".
  const two = tokens.length > 2 ? `${tokens[0]} ${tokens[1]}` : '';
  if (two && isUnitToken(two)) {
    unit = canonicalUnit(two);
    tokens = tokens.slice(2);
  } else if (tokens.length > 1 && tokens[0] !== undefined && isUnitToken(tokens[0])) {
    unit = canonicalUnit(tokens[0]);
    tokens = tokens.slice(1);
  }
  if (tokens[0] === 'of') tokens = tokens.slice(1);

  const name = tokens.join(' ').trim();
  if (name.length === 0) return undefined;
  return { name, quantity, unit };
}

/** Default parser; see the module comment for the accepted forms. */
export const parseFridgeTranscript: FridgeTranscriptParser = (transcript) =>
  transcript
    .split(/\s*(?:[,;\n&]|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseSegment)
    .filter((i): i is Ingredient => i !== undefined);
