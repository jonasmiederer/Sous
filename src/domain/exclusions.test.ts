import { describe, expect, it } from 'vitest';
import {
  buildExclusionRules,
  constraintExclusionTerms,
  enforceHardExclusions,
  isMealAllowed,
  textMatchesTerm,
  type ExcludableMeal,
  type HardExclusionProfile,
} from './exclusions.js';

function meal(name: string, ingredients: string[], attributes: string[] = []): ExcludableMeal {
  return { name, ingredients: ingredients.map((n) => ({ name: n })), attributes };
}

function profile(excludedIngredients: string[] = [], dietaryConstraints: string[] = []): HardExclusionProfile {
  return { excludedIngredients, dietaryConstraints };
}

describe('textMatchesTerm', () => {
  it('matches whole words, case-insensitively, including multi-word names', () => {
    expect(textMatchesTerm('Coconut Milk', 'coconut')).toBe(true);
    expect(textMatchesTerm('light coconut-milk', 'coconut milk')).toBe(true);
    expect(textMatchesTerm('nutmeg', 'nut')).toBe(false);
    expect(textMatchesTerm('coconut', 'nut')).toBe(false);
    expect(textMatchesTerm('eggplant', 'egg')).toBe(false);
  });

  it('tolerates plurals', () => {
    expect(textMatchesTerm('eggs', 'egg')).toBe(true);
    expect(textMatchesTerm('anchovies', 'anchovy')).toBe(true);
    expect(textMatchesTerm('tomatoes', 'tomato')).toBe(true);
  });

  it('ignores negated occurrences', () => {
    expect(textMatchesTerm('gluten-free', 'gluten')).toBe(false);
    expect(textMatchesTerm('non-dairy creamer', 'dairy')).toBe(false);
    expect(textMatchesTerm('dairy', 'dairy')).toBe(true);
  });
});

describe('constraintExclusionTerms', () => {
  it('maps known diets to ingredient groups', () => {
    const vegetarian = constraintExclusionTerms('Vegetarian');
    expect(vegetarian).toEqual(expect.arrayContaining(['chicken', 'beef', 'salmon', 'shrimp']));
    expect(vegetarian).not.toContain('cheese');
    expect(constraintExclusionTerms('vegan')).toEqual(expect.arrayContaining(['cheese', 'egg', 'honey']));
    expect(constraintExclusionTerms('Gluten-Free')).toEqual(expect.arrayContaining(['wheat', 'pasta']));
  });

  it('extracts "no X", "without X", "X-free" and lists', () => {
    expect(constraintExclusionTerms('no mushrooms')).toContain('mushrooms');
    expect(constraintExclusionTerms('without cilantro or olives')).toEqual(
      expect.arrayContaining(['cilantro', 'olives']),
    );
    expect(constraintExclusionTerms('sesame-free')).toContain('sesame');
    expect(constraintExclusionTerms('dairy and soy free')).toEqual(expect.arrayContaining(['milk', 'soy']));
    expect(constraintExclusionTerms('allergic to peanuts')).toContain('peanut');
  });

  it('yields no terms for unrecognized text', () => {
    expect(constraintExclusionTerms('low sodium')).toEqual([]);
  });
});

describe('enforceHardExclusions', () => {
  const curry = meal('Thai curry', ['chicken thighs', 'coconut milk', 'rice']);
  const salad = meal('Greek salad', ['tomatoes', 'feta cheese', 'cucumber'], ['vegetarian']);
  const pasta = meal('Pasta primavera', ['spaghetti', 'zucchini'], ['contains-gluten']);

  it('drops meals with an excluded ingredient, matching by substring word', () => {
    const result = enforceHardExclusions([curry, salad, pasta], profile(['coconut']));
    expect(result.allowed).toEqual([salad, pasta]);
    expect(result.excluded[0]?.violations[0]).toMatchObject({
      source: 'excluded_ingredient',
      origin: 'coconut',
      matchedIn: 'ingredient',
      matchedValue: 'coconut milk',
    });
  });

  it('expands excluded ingredient groups', () => {
    expect(isMealAllowed(salad, profile(['dairy']))).toBe(false);
  });

  it('drops meals violating a dietary constraint via ingredients or attributes', () => {
    expect(enforceHardExclusions([curry, salad, pasta], profile([], ['vegetarian'])).allowed).toEqual([
      salad,
      pasta,
    ]);
    const attrOnly = meal('Mystery bake', ['rice'], ['contains-gluten']);
    expect(isMealAllowed(attrOnly, profile([], ['gluten free']))).toBe(false);
  });

  it('allows everything when there is no profile or no rules', () => {
    expect(enforceHardExclusions([curry, salad], null).allowed).toEqual([curry, salad]);
    expect(buildExclusionRules(profile([' '], ['low sodium']))).toEqual([]);
  });

  it('ignores soft memory contents entirely', () => {
    const hard = profile(['coconut'], ['vegetarian']);
    const base = enforceHardExclusions([curry, salad, pasta], hard);
    const softLoves = [{ statement: 'we love coconut chicken curry', polarity: 'favorite' }];
    const softHates = [{ statement: 'we hate pasta', polarity: 'avoid-soft' }];
    expect(enforceHardExclusions([curry, salad, pasta], hard, softLoves)).toEqual(base);
    expect(enforceHardExclusions([curry, salad, pasta], hard, softHates)).toEqual(base);
  });

  it('does not mutate inputs and preserves order', () => {
    const meals = [pasta, salad];
    const snapshot = JSON.stringify(meals);
    const result = enforceHardExclusions(meals, profile(['tofu']));
    expect(result.allowed).toEqual([pasta, salad]);
    expect(JSON.stringify(meals)).toBe(snapshot);
  });
});
