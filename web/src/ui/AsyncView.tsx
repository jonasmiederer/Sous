import type { ReactNode } from 'react';
import { ErrorBanner } from './ErrorBanner';
import { SkeletonList } from './Skeleton';

/** The subset of a TanStack Query result that AsyncView reads. */
export interface AsyncState<T> {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: T | undefined;
  isFetching?: boolean;
  refetch?: () => unknown;
}

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

export interface AsyncViewProps<T> {
  query: AsyncState<T>;
  children: (data: T) => ReactNode;
  /** Returns true when the loaded data counts as an empty list. */
  isEmpty?: (data: T) => boolean;
  /** Rendered when `isEmpty` returns true, usually an EmptyState. */
  empty?: ReactNode;
  /** Rendered while pending. Defaults to a SkeletonList. */
  loading?: ReactNode;
  /** Maps an error to a user-facing message, for example the API client's `messageFor`. */
  errorMessage?: (error: unknown) => string;
  errorTitle?: ReactNode;
}

/**
 * Standard pending / error / empty / content switch for query-backed views
 * (Requirement 13.16).
 */
export function AsyncView<T>({ query, children, isEmpty, empty, loading, errorMessage, errorTitle }: AsyncViewProps<T>) {
  if (query.isPending) return <>{loading ?? <SkeletonList />}</>;
  if (query.isError || query.data === undefined) {
    const message = errorMessage ? errorMessage(query.error) : GENERIC_ERROR_MESSAGE;
    const refetch = query.refetch;
    return (
      <ErrorBanner
        title={errorTitle}
        message={message || GENERIC_ERROR_MESSAGE}
        onRetry={refetch ? () => void refetch() : undefined}
        retrying={query.isFetching}
      />
    );
  }
  if (isEmpty?.(query.data) && empty !== undefined) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
