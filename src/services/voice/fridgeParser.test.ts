import { describe, expect, it } from 'vitest';

import { parseFridgeTranscript } from './fridgeParser.js';

describe('parseFridgeTranscript', () => {
  it('extracts quantities, units, and names from spoken lists', () => {
    expect(parseFridgeTranscript('Two liters of milk, 3 cloves garlic; half a cup of rice & 1.5 kg potatoes.')).toEqual([
      { name: 'milk', quantity: 2, unit: 'l' },
      { name: 'garlic', quantity: 3, unit: 'clove' },
      { name: 'rice', quantity: 0.5, unit: 'cup' },
      { name: 'potatoes', quantity: 1.5, unit: 'kg' },
    ]);
  });

  it('defaults to 1 piece, handles "a couple", fluid ounces, and skips empty segments', () => {
    expect(parseFridgeTranscript('butter, , a couple of onions and 8 fluid ounces cream and')).toEqual([
      { name: 'butter', quantity: 1, unit: 'piece' },
      { name: 'onions', quantity: 2, unit: 'piece' },
      { name: 'cream', quantity: 8, unit: 'fl_oz' },
    ]);
  });

  it('returns no items for an empty transcript', () => {
    expect(parseFridgeTranscript('   ')).toEqual([]);
  });
});
