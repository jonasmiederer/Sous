import { useId, useState } from 'react';
import { Check, ChevronDown, MessageSquare, ShoppingBasket, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import type { FeedbackValue, Ingredient, SuggestionView } from '../../api/types';
import { Button, IconButton, Skeleton, cx } from '../../ui';
import { AddToGroceryListDialog } from '../grocery/AddToGroceryListDialog';

/** Ingredient names shown on the collapsed card before "+N more". */
export const KEY_INGREDIENT_COUNT = 5;

export interface SuggestionCardProps {
  suggestion: SuggestionView;
  /** Feedback already recorded for this suggestion in this session. */
  feedback?: FeedbackValue;
  /** The value being sent, while a feedback request is in flight. */
  pendingFeedback?: FeedbackValue;
  accepted?: boolean;
  accepting?: boolean;
  /** True while this card is being replaced after a rejection. */
  rejecting?: boolean;
  /** Disables Reject, for example while another request is in flight. */
  rejectDisabled?: boolean;
  onFeedback: (value: FeedbackValue) => void;
  onAccept: () => void;
  onReject: () => void;
  /** Opens chat refinement for this suggestion (wired by tasks 23.9/23.11). Hidden when absent. */
  onRefine?: () => void;
}

/** Whole numbers as-is; fractions rounded to two decimals. */
function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity) ? String(quantity) : String(Math.round(quantity * 100) / 100);
}

function formatIngredient(ingredient: Ingredient): string {
  return `${formatQuantity(ingredient.quantity)} ${ingredient.unit}`;
}

/** "gluten-free" or "quick_meal" -> "Gluten free" / "Quick meal". */
function humanizeAttribute(attribute: string): string {
  const text = attribute.replace(/[-_]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A Meal_Suggestion with feedback, accept, reject, and refine actions (Requirements 6.1, 6.3, 13.11). */
export function SuggestionCard({
  suggestion,
  feedback,
  pendingFeedback,
  accepted = false,
  accepting = false,
  rejecting = false,
  rejectDisabled = false,
  onFeedback,
  onAccept,
  onReject,
  onRefine,
}: SuggestionCardProps) {
  const [open, setOpen] = useState(false);
  const [addingToList, setAddingToList] = useState(false);
  const headingId = useId();
  const detailsId = useId();
  const names = suggestion.ingredients.map((i) => i.name);
  const keyNames = names.slice(0, KEY_INGREDIENT_COUNT);
  const more = names.length - keyNames.length;
  // Optimistic display: show the in-flight value until the request settles.
  const shownFeedback = pendingFeedback ?? feedback;

  // Keep the layout stable while the rejected suggestion is being replaced.
  if (rejecting) return <SuggestionCardSkeleton label={`Finding another idea instead of ${suggestion.name}`} />;

  return (
    <article
      aria-labelledby={headingId}
      className="flex animate-rise-in flex-col gap-4 rounded-3xl border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-lg leading-snug font-semibold tracking-tight">
            {suggestion.name}
          </h3>
          {suggestion.attributes.length > 0 && (
            <ul aria-label="Attributes" className="mt-2 flex flex-wrap gap-1.5">
              {suggestion.attributes.map((attribute) => (
                <li key={attribute} className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-text">
                  {humanizeAttribute(attribute)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <IconButton label={`Not for me: ${suggestion.name}`} icon={<X />} onClick={onReject} disabled={rejectDisabled} />
      </header>

      <p className="text-sm text-text-muted">
        <span className="font-medium text-text">Key ingredients: </span>
        {keyNames.join(', ')}
        {more > 0 && ` and ${more} more`}
      </p>

      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl text-sm font-medium text-accent-text hover:underline"
        >
          {open ? 'Hide recipe' : 'Show recipe'}
          <ChevronDown aria-hidden="true" className={cx('size-4 transition-transform duration-150', open && 'rotate-180')} />
        </button>
        <div id={detailsId} hidden={!open} className="mt-2 grid gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section>
            <h4 className="text-xs font-semibold tracking-wide text-text-muted uppercase">Ingredients</h4>
            <ul className="mt-2 flex flex-col gap-1.5 text-sm">
              {suggestion.ingredients.map((ingredient, index) => (
                <li key={`${ingredient.name}-${index}`} className="flex justify-between gap-3 border-b border-border pb-1.5 last:border-0">
                  <span>{ingredient.name}</span>
                  <span className="shrink-0 text-text-muted tabular-nums">{formatIngredient(ingredient)}</span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h4 className="text-xs font-semibold tracking-wide text-text-muted uppercase">Steps</h4>
            <ol className="mt-2 flex flex-col gap-2.5 text-sm">
              {suggestion.steps.map((step, index) => (
                <li key={index} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold tabular-nums"
                  >
                    {index + 1}
                  </span>
                  <span className="pt-0.5 leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <div className="flex gap-1" role="group" aria-label="Feedback">
          <FeedbackButton
            value="like"
            label={`Like ${suggestion.name}`}
            pressed={shownFeedback === 'like'}
            busy={pendingFeedback === 'like'}
            onClick={() => onFeedback('like')}
          />
          <FeedbackButton
            value="dislike"
            label={`Dislike ${suggestion.name}`}
            pressed={shownFeedback === 'dislike'}
            busy={pendingFeedback === 'dislike'}
            onClick={() => onFeedback('dislike')}
          />
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="ghost"
            icon={<ShoppingBasket aria-hidden="true" className="size-4" />}
            onClick={() => setAddingToList(true)}
            aria-label={`Add ${suggestion.name} to grocery list`}
          >
            Add to list
          </Button>
          {onRefine && (
            <Button variant="ghost" icon={<MessageSquare aria-hidden="true" className="size-4" />} onClick={onRefine}>
              Refine
            </Button>
          )}
          <Button
            variant={accepted ? 'secondary' : 'primary'}
            icon={accepted ? <Check aria-hidden="true" className="size-4" /> : undefined}
            loading={accepting}
            disabled={accepted}
            onClick={onAccept}
            aria-label={accepted ? `${suggestion.name} accepted` : `Accept ${suggestion.name}`}
          >
            {accepted ? 'Accepted' : 'Accept'}
          </Button>
        </div>
      </footer>

      <AddToGroceryListDialog
        open={addingToList}
        onClose={() => setAddingToList(false)}
        mealName={suggestion.name}
        ingredients={suggestion.ingredients}
      />
    </article>
  );
}

/** Like/dislike toggle. Ignores clicks while already selected or while a request is in flight. */
function FeedbackButton({
  value,
  label,
  pressed,
  busy,
  onClick,
}: {
  value: FeedbackValue;
  label: string;
  pressed: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  const Icon = value === 'like' ? ThumbsUp : ThumbsDown;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      onClick={() => {
        if (!pressed && !busy) onClick();
      }}
      className={cx(
        'inline-flex size-11 items-center justify-center rounded-full border transition-colors duration-150 [&_svg]:size-5',
        pressed
          ? value === 'like'
            ? 'border-accent bg-accent-soft text-accent-text'
            : 'border-danger bg-danger-soft text-danger'
          : 'border-transparent text-text-muted hover:bg-surface-2 hover:text-text',
        busy && 'animate-pulse',
      )}
    >
      <Icon aria-hidden="true" fill={pressed ? 'currentColor' : 'none'} fillOpacity={pressed ? 0.2 : 0} />
    </button>
  );
}

/** Card-shaped placeholder that matches SuggestionCard's layout. */
export function SuggestionCardSkeleton({ label }: { label?: string }) {
  return (
    <div
      role={label ? 'status' : undefined}
      aria-busy={label ? true : undefined}
      className="flex flex-col gap-4 rounded-3xl border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      {label && <span className="sr-only">{label}</span>}
      <Skeleton className="h-6 w-3/5" />
      <div className="flex gap-1.5">
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Skeleton className="size-11 rounded-full" />
        <Skeleton className="size-11 rounded-full" />
        <Skeleton className="ml-auto h-11 w-24" />
      </div>
    </div>
  );
}
