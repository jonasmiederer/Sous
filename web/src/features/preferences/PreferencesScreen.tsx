/**
 * Preferences (route `/preferences`, Requirements 6.5, 6.6, 13.14): likes and
 * dislikes recorded from feedback, excluded ingredients, and dietary
 * constraints with the ConstraintForm.
 */
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import type { GetPreferencesResponse, PreferenceProfile, SavedProfile } from '../../api/types';
import { AsyncView, cx, useToast } from '../../ui';
import { ConstraintForm } from './ConstraintForm';
import { errorMessage, preferencesKey, usePreferences } from './preferenceQueries';

const EMPTY: Pick<PreferenceProfile, 'likes' | 'dislikes' | 'excludedIngredients' | 'dietaryConstraints'> = {
  likes: [],
  dislikes: [],
  excludedIngredients: [],
  dietaryConstraints: [],
};

export function PreferencesScreen() {
  const preferences = usePreferences();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { activeHouseholdId } = useActiveHousehold();

  function onAdded(saved: SavedProfile) {
    queryClient.setQueryData<GetPreferencesResponse>(preferencesKey(activeHouseholdId), saved);
    toast.show({ tone: 'success', message: 'Dietary need added.' });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Preferences</h1>
        <p className="mt-1.5 text-text-muted">What your household likes, dislikes, and must avoid.</p>
      </div>
      <AsyncView query={preferences} errorMessage={errorMessage}>
        {(data) => {
          const profile = data.profile ?? EMPTY;
          return (
            <div className="flex flex-col gap-5">
              <Section
                title="Dietary needs"
                icon={<ShieldCheck />}
                description="These are hard rules. Sous always respects needs like “no coconut” or “vegetarian” in every suggestion and plan."
              >
                {profile.dietaryConstraints.length === 0 ? (
                  <p className="text-sm text-text-muted">No dietary needs yet.</p>
                ) : (
                  <ul aria-label="Dietary needs" className="flex flex-col divide-y divide-border rounded-xl border border-border">
                    {profile.dietaryConstraints.map((c) => (
                      <li key={c} className="break-words px-3.5 py-2.5 text-sm text-text">
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
                {profile.excludedIngredients.length > 0 && (
                  <TagList label="Never included" items={profile.excludedIngredients} tone="danger" />
                )}
                <ConstraintForm existing={profile.dietaryConstraints} onAdded={onAdded} />
              </Section>
              <Section
                title="Likes"
                icon={<ThumbsUp />}
                description="Meals you liked. Sous suggests more like these."
              >
                <TagList label="Likes" items={profile.likes} tone="accent" empty="Like a suggestion to see it here." />
              </Section>
              <Section
                title="Dislikes"
                icon={<ThumbsDown />}
                description="Meals you didn’t like. Sous suggests these less often."
              >
                <TagList label="Dislikes" items={profile.dislikes} tone="neutral" empty="Nothing here yet." />
              </Section>
            </div>
          );
        }}
      </AsyncView>
    </div>
  );
}

function Section({ title, icon, description, children }: { title: string; icon: ReactNode; description: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text [&_svg]:size-5">
          {icon}
        </span>
        <div>
          <h2 className="text-base font-semibold text-text">{title}</h2>
          <p className="text-sm text-text-muted">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

const TAG_TONES = {
  accent: 'border-accent/40 bg-accent-soft text-accent-text',
  neutral: 'border-border-strong bg-surface-2 text-text',
  danger: 'border-danger/40 bg-danger-soft text-danger',
} as const;

function TagList({ label, items, tone, empty }: { label: string; items: readonly string[]; tone: keyof typeof TAG_TONES; empty?: string }) {
  if (items.length === 0) return empty ? <p className="text-sm text-text-muted">{empty}</p> : null;
  return (
    <div className="flex flex-col gap-2">
      {tone === 'danger' && <p className="text-sm font-medium text-text">{label}</p>}
      <ul aria-label={label} className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item} className={cx('inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm font-medium', TAG_TONES[tone])}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
