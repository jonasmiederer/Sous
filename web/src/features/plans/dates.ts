/**
 * Calendar-date helpers for plan screens. Plan days are `YYYY-MM-DD` strings
 * with no time zone, so every computation runs in UTC to avoid shifting a
 * day across the user's offset.
 */
import type { IsoDate, MealPlan } from '../../api/types';

export const MIN_PLAN_DAYS = 1;
export const MAX_PLAN_DAYS = 31;
export const WEEK_DAYS = 7;
/** Context_Input limit in code points, the same as the server's (Requirement 4.2). */
export const PLAN_CONTEXT_MAX = 500;

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in `YYYY-MM-DD` form. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function toUtc(day: IsoDate): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function fromUtc(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: IsoDate, count: number): IsoDate {
  return fromUtc(toUtc(day) + count * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** Every date from `start` to `end`, inclusive. */
export function dateRange(start: IsoDate, end: IsoDate): IsoDate[] {
  const count = daysBetween(start, end) + 1;
  return Array.from({ length: Math.max(0, count) }, (_, i) => addDays(start, i));
}

/** `YYYY-MM-DD` for "today" in UTC, matching the server's default start date. */
export function todayIso(now: number): IsoDate {
  return fromUtc(now);
}

function format(day: IsoDate, options: Intl.DateTimeFormatOptions): string {
  return new Date(toUtc(day)).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}

/** "Monday" */
export function weekdayLabel(day: IsoDate): string {
  return format(day, { weekday: 'long' });
}

/** "Jan 6" */
export function shortDateLabel(day: IsoDate): string {
  return format(day, { month: 'short', day: 'numeric' });
}

/** "Mon, Jan 6" */
export function dayLabel(day: IsoDate): string {
  return format(day, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Mon, Jan 6 – Sun, Jan 12", or a single day label. */
export function rangeLabel(start: IsoDate, end: IsoDate): string {
  return start === end ? dayLabel(start) : `${dayLabel(start)} – ${dayLabel(end)}`;
}

export function dayCountLabel(count: number): string {
  return count === 1 ? '1 day' : `${count} days`;
}

/**
 * Dates a Meal can be added to: unassigned dates inside the range, plus the
 * days just before and after it while the range stays within 31 days (the
 * server's rule for `POST /plans/{id}/days`).
 */
export function addableDays(plan: Pick<MealPlan, 'startDate' | 'endDate' | 'days'>): IsoDate[] {
  const assigned = new Set(plan.days.map((d) => d.day));
  const inside = dateRange(plan.startDate, plan.endDate).filter((day) => !assigned.has(day));
  const span = daysBetween(plan.startDate, plan.endDate) + 1;
  const adjacent = span < MAX_PLAN_DAYS ? [addDays(plan.startDate, -1), addDays(plan.endDate, 1)] : [];
  return [...inside, ...adjacent].sort();
}
