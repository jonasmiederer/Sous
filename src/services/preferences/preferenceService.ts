/**
 * Preference Service core (Requirements 6.1, 6.2, 6.3, 6.5, 6.6).
 *
 * Bound to one Active_Household through its HouseholdRepository. Each mutation
 * is a read-modify-write of the single PREFERENCE_PROFILE record using the
 * pure functions from domain/preferences.ts:
 *
 *   1. read the record (absent → empty profile);
 *   2. apply the pure mutation (validation failures stop here, nothing written);
 *   3. write with optimistic concurrency: `create` when absent, otherwise
 *      `replaceIfVersion`. A version conflict re-reads and retries, up to
 *      `maxAttempts` and only while the deadline has not passed.
 *
 * Every write is one conditional PutItem, so it either commits atomically or
 * leaves the stored profile unchanged; on a storage failure the caller gets
 * NOT_SAVED (6.2). Each operation is raced against a deadline (2s by default,
 * the feedback bound from 6.2). Once the deadline passes no new write is
 * started; a write already in flight still commits or fails atomically.
 *
 * Stored shape: the record's attributes are exactly the PreferenceProfile
 * fields (householdId, likes, dislikes, excludedIngredients,
 * dietaryConstraints, acceptances, updatedAt), as read by the other services.
 */
import { sortKeys } from '../../data/keys.js';
import type { Attributes, HouseholdRepository, StoredRecord } from '../../data/repository.js';
import {
  addDietaryConstraint,
  emptyPreferenceProfile,
  recordAcceptance,
  recordFeedback,
} from '../../domain/preferences.js';
import type { FeedbackValue, PreferenceProfile } from '../../domain/types.js';
import {
  PREFERENCE_ERROR_MESSAGES,
  preferenceError,
  type PreferenceError,
  type PreferenceResult,
} from './errors.js';

/** Feedback bound from Requirement 6.2. */
export const DEFAULT_PREFERENCE_DEADLINE_MS = 2_000;
export const DEFAULT_MAX_WRITE_ATTEMPTS = 3;
/** Upper bound for a feedback item (Meal/Meal_Suggestion name or id) and a meal id. */
export const MAX_ITEM_LENGTH = 200;

export interface Clock {
  now(): Date;
}

export interface PreferenceServiceDeps {
  /** Repository bound to the Active_Household. */
  repository: HouseholdRepository;
  clock?: Clock;
  /** Per-operation time bound in ms. */
  deadlineMs?: number;
  maxAttempts?: number;
}

export interface SavedProfile {
  profile: PreferenceProfile;
  version: number;
}

type Mutation =
  | { ok: true; profile: PreferenceProfile }
  | { ok: false; error: PreferenceError };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Converts stored attributes to a PreferenceProfile; unexpected types read as empty. */
export function toPreferenceProfile(householdId: string, a: Attributes): PreferenceProfile {
  return {
    householdId,
    likes: strings(a.likes),
    dislikes: strings(a.dislikes),
    excludedIngredients: strings(a.excludedIngredients),
    dietaryConstraints: strings(a.dietaryConstraints),
    acceptances: strings(a.acceptances),
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
  };
}

/** The exact attribute shape persisted for the PREFERENCE_PROFILE record. */
export function preferenceProfileAttributes(p: PreferenceProfile): Attributes {
  return {
    householdId: p.householdId,
    likes: [...p.likes],
    dislikes: [...p.dislikes],
    excludedIngredients: [...p.excludedIngredients],
    dietaryConstraints: [...p.dietaryConstraints],
    acceptances: [...p.acceptances],
    updatedAt: p.updatedAt,
  };
}

/** Validates a required, trimmed, length-bounded string field. */
function requiredString(value: unknown, field: string): PreferenceResult<string> {
  if (typeof value !== 'string') return preferenceError('INVALID_REQUEST', `"${field}" must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return preferenceError('INVALID_REQUEST', `"${field}" must not be empty.`);
  if ([...trimmed].length > MAX_ITEM_LENGTH) {
    return preferenceError('INVALID_REQUEST', `"${field}" must be at most ${MAX_ITEM_LENGTH} characters.`);
  }
  return { ok: true, value: trimmed };
}

const TIMED_OUT = Symbol('timed_out');

export class PreferenceService {
  private readonly clock: Clock;
  private readonly deadlineMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly deps: PreferenceServiceDeps) {
    this.clock = deps.clock ?? { now: () => new Date() };
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_PREFERENCE_DEADLINE_MS;
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_WRITE_ATTEMPTS);
  }

  private get householdId(): string {
    return this.deps.repository.householdId;
  }

  /** GET /preferences: the stored profile, or null when none exists yet. */
  async getProfile(): Promise<PreferenceResult<SavedProfile | null>> {
    const record = await this.deps.repository.get(sortKeys.preferenceProfile());
    if (record === undefined) return { ok: true, value: null };
    return { ok: true, value: { profile: toPreferenceProfile(this.householdId, record.attributes), version: record.version } };
  }

  /**
   * POST /preferences/feedback (6.1). `item` is the Meal_Suggestion or Meal
   * name (or id) the Feedback is about; the latest value for an item wins.
   */
  async recordFeedback(input: { item?: unknown; value?: unknown }): Promise<PreferenceResult<SavedProfile>> {
    const item = requiredString(input.item, 'item');
    if (!item.ok) return item;
    if (input.value !== 'like' && input.value !== 'dislike') {
      return preferenceError('INVALID_REQUEST', '"value" must be "like" or "dislike".');
    }
    const value: FeedbackValue = input.value;
    return this.mutate((p, now) => ({ ok: true, profile: recordFeedback(p, item.value, value, now) }));
  }

  /** POST /preferences/acceptances (6.3): records that a Meal was accepted into a plan. */
  async recordAcceptance(input: { mealId?: unknown }): Promise<PreferenceResult<SavedProfile>> {
    const mealId = requiredString(input.mealId, 'mealId');
    if (!mealId.ok) return mealId;
    return this.mutate((p, now) => ({ ok: true, profile: recordAcceptance(p, mealId.value, now) }));
  }

  /** POST /preferences/constraints (6.5, 6.6). Invalid constraints are rejected with a reason. */
  async addDietaryConstraint(input: { constraint?: unknown }): Promise<PreferenceResult<SavedProfile>> {
    if (typeof input.constraint !== 'string') {
      return preferenceError('INVALID_REQUEST', '"constraint" must be a string.');
    }
    const constraint = input.constraint;
    return this.mutate((p, now) => {
      const r = addDietaryConstraint(p, constraint, now);
      return r.ok
        ? { ok: true, profile: r.profile }
        : { ok: false, error: { code: 'INVALID_DIETARY_CONSTRAINT', message: r.message, reason: r.reason } };
    });
  }

  private async mutate(
    apply: (profile: PreferenceProfile, now: string) => Mutation,
  ): Promise<PreferenceResult<SavedProfile>> {
    const state = { expired: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        state.expired = true;
        resolve(TIMED_OUT);
      }, this.deadlineMs);
    });
    try {
      const result = await Promise.race([this.readModifyWrite(apply, state), timeout]);
      return result === TIMED_OUT ? preferenceError('TIMEOUT', PREFERENCE_ERROR_MESSAGES.timeout) : result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readModifyWrite(
    apply: (profile: PreferenceProfile, now: string) => Mutation,
    state: { expired: boolean },
  ): Promise<PreferenceResult<SavedProfile>> {
    const repo = this.deps.repository;
    const sk = sortKeys.preferenceProfile();
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let record: StoredRecord | undefined;
      try {
        record = await repo.get(sk);
      } catch {
        return preferenceError('NOT_SAVED', PREFERENCE_ERROR_MESSAGES.notSaved);
      }
      const now = this.clock.now().toISOString();
      const current = record
        ? toPreferenceProfile(this.householdId, record.attributes)
        : emptyPreferenceProfile(this.householdId, now);
      const mutation = apply(current, now);
      if (!mutation.ok) return mutation;

      // Never start a write after the deadline; the caller already got TIMEOUT.
      if (state.expired) return preferenceError('TIMEOUT', PREFERENCE_ERROR_MESSAGES.timeout);
      const attributes = preferenceProfileAttributes(mutation.profile);
      const write = record
        ? await repo.replaceIfVersion(sk, record.version, attributes)
        : await repo.create(sk, attributes);
      if (write.ok) {
        return { ok: true, value: { profile: mutation.profile, version: record ? record.version + 1 : 1 } };
      }
      if (write.error.reason !== 'condition_failed') {
        return preferenceError('NOT_SAVED', PREFERENCE_ERROR_MESSAGES.notSaved);
      }
      // Version conflict: another writer committed first. Re-read and retry.
    }
    return preferenceError('PROFILE_CONFLICT', PREFERENCE_ERROR_MESSAGES.conflict);
  }
}
