/**
 * Length in Unicode code points, so an emoji counts as one character.
 * Matches the backend's `characterLength` (src/services/suggestions/validation.ts).
 */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}
