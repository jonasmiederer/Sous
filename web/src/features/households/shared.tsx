/** Small helpers shared by the household screens. */
import { Crown, User } from 'lucide-react';
import { isApiError, messageFor } from '../../api/errors';
import type { MembershipRole } from '../../api/types';
import { cx } from '../../ui';

export const HOUSEHOLD_NAME_MAX = 100;
export const HOUSEHOLDS_PATH = '/households';
export const MEMBERS_PATH = '/households/members';

/** User-facing text for any thrown value. */
export function errorText(err: unknown): string {
  return isApiError(err) ? err.userMessage : messageFor('INTERNAL_ERROR');
}

/** Query key of a Household's member list (Household-scoped, see design.md "API client"). */
export function membersQueryKey(householdId: string) {
  return ['hh', householdId, 'members'] as const;
}

/** Invitation_Link per design.md: `https://{webDomain}/invitations/{invitationId}`. */
export function invitationLink(invitationId: string, origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, '')}/invitations/${encodeURIComponent(invitationId)}`;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isPlausibleEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

export function RoleBadge({ role, className }: { role: MembershipRole; className?: string }) {
  const owner = role === 'owner';
  const Icon = owner ? Crown : User;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        owner ? 'bg-accent-soft text-accent-text' : 'bg-surface-2 text-text-muted',
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {owner ? 'Owner' : 'Member'}
    </span>
  );
}

export function ScreenHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      {description && <p className="mt-1.5 text-text-muted">{description}</p>}
    </div>
  );
}

/**
 * Copies text with the async Clipboard API, falling back to a hidden textarea
 * and `execCommand('copy')`. Resolves `false` when neither works.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
