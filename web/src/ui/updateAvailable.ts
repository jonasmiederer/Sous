/**
 * Bridges the service-worker registration in main.tsx to React. main.tsx
 * calls `notifyUpdateAvailable` from `onNeedRefresh`; `UpdateAvailableToast`
 * subscribes and offers a reload.
 */
export type ApplyUpdate = () => void | Promise<void>;

let pending: ApplyUpdate | null = null;
const listeners = new Set<() => void>();

export function notifyUpdateAvailable(apply: ApplyUpdate): void {
  pending = apply;
  for (const listener of listeners) listener();
}

export function getPendingUpdate(): ApplyUpdate | null {
  return pending;
}

export function subscribeToUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper. */
export function resetPendingUpdate(): void {
  pending = null;
}
