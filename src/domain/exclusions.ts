/**
 * Deterministic hard-exclusion enforcement (Requirements 2.2, 3.2, 6.7).
 *
 * Runs in Lambda over the Meals returned by the Suggestion_Agent and drops any
 * Meal that contains an excluded ingredient or matches an item excluded by a
 * recorded dietary constraint. The result depends only on the structured
 * Preference_Profile; soft long-term preference memory is accepted as an
 * argument for call-site convenience but is never consulted (Property 7).
 *
 * How exclusion terms are derived
 * -------------------------------
 * 1. `excludedIngredients` entries are used as terms directly.
 * 2. `dietaryConstraints` are normalized (lower-case, `-`/`_` -> space) and:
 *    a. any known diet name contained in the text (vegetarian, vegan,
 *       pescatarian, gluten free, celiac, dairy free, lactose free, lactose
 *       intolerant, nut free, egg free, shellfish free, halal, kosher)
 *       contributes its ingredient groups (see KNOWN_CONSTRAINTS);
 *    b. "no X", "without X", "avoid X", "exclude X", "allergic to X" and
 *       "allergy to X" contribute X (a list split on `,` `and` `or` `&`);
 *    c. "X free" and "X allergy" contribute X (the word before, plus words
 *       joined to it by connectors, e.g. "dairy and nut free").
 *    Constraint text that matches none of these yields no terms.
 * 3. Every term that names an ingredient group (e.g. "dairy", "meat", "nuts")
 *    is expanded to the group's members, keeping the term itself.
 *
 * How terms are matched
 * ---------------------
 * Ingredient names and Meal attributes are normalized the same way and a term
 * matches when it occurs as whole words, allowing a plural suffix (`s`, `es`,
 * `y` -> `ies`). So "coconut" excludes "coconut milk" and "egg" excludes
 * "eggs", while "nut" does not exclude "nutmeg" or "coconut". An occurrence
 * that is negated ("gluten free", "no dairy", "non dairy", "without nuts") is
 * not a match. Matching is deliberately conservative: group members such as
 * "flour" or "cheese" match even when qualified ("rice flour", "dairy free
 * cheese"), because a false exclusion is cheaper than a constraint violation.
 */
import { normalizeIngredientName } from './units.js';
import type { PreferenceProfile } from './types.js';

// ---------------------------------------------------------------------------
// Ingredient groups and known constraints
// ---------------------------------------------------------------------------

const PORK = ['pork', 'bacon', 'ham', 'lard', 'prosciutto', 'pancetta', 'chorizo', 'pepperoni', 'salami', 'gelatin'];

/** Named ingredient groups. A term equal to a key expands to its members. */
export const INGREDIENT_GROUPS: Readonly<Record<string, readonly string[]>> = {
  meat: [
    'meat', 'beef', 'chicken', 'lamb', 'mutton', 'veal', 'turkey', 'duck', 'goose', 'venison',
    'sausage', 'steak', 'mince', 'gelatine', 'bone broth', 'chicken stock', 'beef stock', ...PORK,
  ],
  pork: PORK,
  poultry: ['poultry', 'chicken', 'turkey', 'duck', 'goose'],
  fish: [
    'fish', 'salmon', 'tuna', 'cod', 'haddock', 'trout', 'sardine', 'anchovy', 'mackerel',
    'halibut', 'tilapia', 'fish sauce',
  ],
  seafood: ['seafood', 'fish', 'shellfish', 'shrimp', 'prawn', 'crab', 'lobster', 'clam', 'mussel', 'oyster', 'scallop', 'squid', 'octopus'],
  shellfish: [
    'shellfish', 'shrimp', 'prawn', 'crab', 'lobster', 'clam', 'mussel', 'oyster', 'scallop',
    'squid', 'octopus', 'crawfish', 'crayfish',
  ],
  dairy: [
    'dairy', 'milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', 'ghee', 'whey', 'casein',
    'parmesan', 'mozzarella', 'cheddar', 'ricotta', 'mascarpone', 'buttermilk', 'feta', 'brie',
  ],
  lactose: ['lactose', 'milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', 'whey', 'buttermilk', 'mozzarella', 'ricotta', 'mascarpone'],
  gluten: [
    'gluten', 'wheat', 'barley', 'rye', 'flour', 'bread', 'pasta', 'couscous', 'semolina', 'spelt',
    'bulgur', 'seitan', 'breadcrumb', 'soy sauce', 'spaghetti', 'tortilla',
  ],
  wheat: ['wheat', 'flour', 'bread', 'pasta', 'couscous', 'semolina', 'spelt', 'bulgur', 'seitan', 'breadcrumb', 'spaghetti'],
  nut: [
    'nut', 'almond', 'cashew', 'walnut', 'pecan', 'pistachio', 'hazelnut', 'macadamia', 'peanut',
    'pine nut', 'brazil nut',
  ],
  peanut: ['peanut', 'peanut butter'],
  egg: ['egg', 'mayonnaise', 'meringue'],
  alcohol: ['alcohol', 'wine', 'beer', 'rum', 'vodka', 'brandy', 'sake', 'mirin', 'whiskey', 'bourbon'],
  honey: ['honey'],
};

/** Known diet names (normalized, hyphens as spaces) -> ingredient groups. */
export const KNOWN_CONSTRAINTS: Readonly<Record<string, readonly string[]>> = {
  vegetarian: ['meat', 'fish', 'shellfish'],
  vegan: ['meat', 'fish', 'shellfish', 'dairy', 'egg', 'honey'],
  pescatarian: ['meat'],
  'gluten free': ['gluten'],
  celiac: ['gluten'],
  coeliac: ['gluten'],
  'dairy free': ['dairy'],
  'lactose free': ['lactose'],
  'lactose intolerant': ['lactose'],
  'nut free': ['nut'],
  'egg free': ['egg'],
  'shellfish free': ['shellfish'],
  halal: ['pork', 'alcohol'],
  kosher: ['pork', 'shellfish'],
};

// ---------------------------------------------------------------------------
// Normalization and matching
// ---------------------------------------------------------------------------

/** Lower-case, `-`/`_`/`/` and punctuation to spaces, collapse whitespace. */
export function normalizeExclusionText(value: string): string {
  return normalizeIngredientName(value.replace(/[-_/(),.;:!?"']+/g, ' '));
}

const WORD_CHAR = '[\\p{L}\\p{N}]';
const NEGATED_BEFORE = /(?:^|\s)(?:no|non|without)\s$/u;
const NEGATED_AFTER = /^\s(?:free)(?:\s|$)/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termPattern(term: string): RegExp {
  const words = term.split(' ').map(escapeRegExp);
  const last = words.pop() ?? '';
  const lastAlternatives = [`${last}(?:s|es)?`];
  if (last.endsWith('y') && last.length > 1) lastAlternatives.push(`${last.slice(0, -1)}ies`);
  const body = [...words, `(?:${lastAlternatives.join('|')})`].join('\\s+');
  return new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, 'gu');
}

/**
 * True iff `term` occurs in `text` as whole words (plural-tolerant) at least
 * once without being negated. Both arguments are normalized first.
 */
export function textMatchesTerm(text: string, term: string): boolean {
  const normalizedText = normalizeExclusionText(text);
  const normalizedTerm = normalizeExclusionText(term);
  if (normalizedTerm.length === 0 || normalizedText.length === 0) return false;
  for (const match of normalizedText.matchAll(termPattern(normalizedTerm))) {
    const start = match.index ?? 0;
    const before = normalizedText.slice(0, start);
    const after = normalizedText.slice(start + match[0].length);
    if (!NEGATED_BEFORE.test(before) && !NEGATED_AFTER.test(after)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Term derivation
// ---------------------------------------------------------------------------

const CONNECTORS = new Set(['and', 'or', '&', ',']);

function splitList(value: string): string[] {
  return value
    .split(/\s*(?:,|&|\band\b|\bor\b)\s*/u)
    .map((part) => part.replace(/^(?:any|all|the)\s+/u, '').trim())
    .filter((part) => part.length > 0);
}

/** Words before index `end` joined by connectors: "dairy and nut" free. */
function wordsBefore(tokens: readonly string[], end: number): string[] {
  const result: string[] = [];
  let i = end - 1;
  while (i >= 0) {
    const word = tokens[i];
    if (word === undefined || CONNECTORS.has(word)) break;
    result.push(word);
    const connector = tokens[i - 1];
    if (connector === undefined || !CONNECTORS.has(connector)) break;
    i -= 2;
  }
  return result;
}

const LEADING_PATTERN = /(?:^|\s)(?:no|without|avoid|exclude|excluding|allergic to|allergy to)\s+(.+)$/u;

/** Group lookup tolerant of a plural form ("nuts" -> "nut", "eggs" -> "egg"). */
function groupFor(term: string): readonly string[] | undefined {
  return (
    INGREDIENT_GROUPS[term] ??
    (term.endsWith('s') ? INGREDIENT_GROUPS[term.slice(0, -1)] : undefined)
  );
}

function expandTerm(term: string, into: Set<string>): void {
  into.add(term);
  for (const member of groupFor(term) ?? []) into.add(member);
}

/**
 * Exclusion terms implied by one dietary constraint, normalized and
 * group-expanded. Unrecognized constraint text yields an empty array.
 */
export function constraintExclusionTerms(constraint: string): string[] {
  // Like normalizeExclusionText, but list separators survive as " , " tokens.
  const text = normalizeIngredientName(
    constraint.replace(/[,.;]+/g, ' , ').replace(/[-_/()!?:"']+/g, ' '),
  );
  const terms = new Set<string>();
  const plain = text.replace(/\s*,\s*/g, ' ').trim();

  for (const [name, groups] of Object.entries(KNOWN_CONSTRAINTS)) {
    if (textContainsPhrase(plain, name)) for (const group of groups) expandTerm(group, terms);
  }

  const leading = LEADING_PATTERN.exec(text);
  if (leading?.[1] !== undefined) {
    for (const item of splitList(leading[1])) expandTerm(item, terms);
  }

  const tokens = text.split(' ');
  tokens.forEach((token, index) => {
    if (token === 'free' || token === 'allergy') {
      for (const word of wordsBefore(tokens, index)) expandTerm(word, terms);
    }
  });

  return [...terms];
}

function textContainsPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(?<!${WORD_CHAR})${phrase.split(' ').map(escapeRegExp).join('\\s+')}(?!${WORD_CHAR})`, 'u').test(text);
}

// ---------------------------------------------------------------------------
// Rules and enforcement
// ---------------------------------------------------------------------------

export type ExclusionSource = 'excluded_ingredient' | 'dietary_constraint';

/** One compiled hard-exclusion rule, traceable to the profile entry. */
export interface ExclusionRule {
  source: ExclusionSource;
  /** The profile entry the rule came from, as written. */
  origin: string;
  /** Normalized terms; matching any one excludes the Meal. */
  terms: string[];
}

/** The profile fields that drive hard exclusions. */
export type HardExclusionProfile = Pick<PreferenceProfile, 'excludedIngredients' | 'dietaryConstraints'>;

/** Minimal Meal shape the filter needs; fits Meal and MealSuggestion. */
export interface ExcludableMeal {
  readonly name: string;
  readonly ingredients: ReadonlyArray<{ readonly name: string }>;
  readonly attributes?: readonly string[];
}

export interface ExclusionViolation {
  source: ExclusionSource;
  origin: string;
  term: string;
  matchedIn: 'ingredient' | 'attribute';
  matchedValue: string;
}

export interface ExclusionResult<T> {
  allowed: T[];
  excluded: Array<{ meal: T; violations: ExclusionViolation[] }>;
}

/** Compile a profile into rules. A missing profile yields no rules (2.3). */
export function buildExclusionRules(profile: HardExclusionProfile | null | undefined): ExclusionRule[] {
  if (!profile) return [];
  const rules: ExclusionRule[] = [];
  for (const entry of profile.excludedIngredients) {
    const terms = new Set<string>();
    const normalized = normalizeExclusionText(entry);
    if (normalized.length > 0) expandTerm(normalized, terms);
    if (terms.size > 0) rules.push({ source: 'excluded_ingredient', origin: entry, terms: [...terms] });
  }
  for (const entry of profile.dietaryConstraints) {
    const terms = constraintExclusionTerms(entry);
    if (terms.length > 0) rules.push({ source: 'dietary_constraint', origin: entry, terms });
  }
  return rules;
}

/** Every rule violation in a Meal's recorded ingredients and attributes. */
export function findViolations(meal: ExcludableMeal, rules: readonly ExclusionRule[]): ExclusionViolation[] {
  const candidates: Array<{ matchedIn: 'ingredient' | 'attribute'; value: string }> = [
    ...meal.ingredients.map((i) => ({ matchedIn: 'ingredient' as const, value: i.name })),
    ...(meal.attributes ?? []).map((a) => ({ matchedIn: 'attribute' as const, value: a })),
  ];
  const violations: ExclusionViolation[] = [];
  for (const rule of rules) {
    for (const candidate of candidates) {
      const term = rule.terms.find((t) => textMatchesTerm(candidate.value, t));
      if (term !== undefined) {
        violations.push({
          source: rule.source,
          origin: rule.origin,
          term,
          matchedIn: candidate.matchedIn,
          matchedValue: candidate.value,
        });
      }
    }
  }
  return violations;
}

export function isMealAllowed(meal: ExcludableMeal, profile: HardExclusionProfile | null | undefined): boolean {
  return findViolations(meal, buildExclusionRules(profile)).length === 0;
}

/**
 * Drop every Meal that violates a hard exclusion in `profile`, preserving the
 * order of the remaining Meals.
 *
 * `_softMemory` (household long-term preference memory) is intentionally
 * ignored: hard exclusions depend only on the structured profile, so soft
 * preferences can neither admit an excluded Meal nor drop an allowed one.
 */
export function enforceHardExclusions<T extends ExcludableMeal>(
  meals: readonly T[],
  profile: HardExclusionProfile | null | undefined,
  _softMemory?: unknown,
): ExclusionResult<T> {
  const rules = buildExclusionRules(profile);
  const result: ExclusionResult<T> = { allowed: [], excluded: [] };
  for (const meal of meals) {
    const violations = findViolations(meal, rules);
    if (violations.length === 0) result.allowed.push(meal);
    else result.excluded.push({ meal, violations });
  }
  return result;
}
