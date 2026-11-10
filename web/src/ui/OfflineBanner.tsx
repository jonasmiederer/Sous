import { useSyncExternalStore } from 'react';
import { WifiOff } from 'lucide-react';

function subscribe(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Tracks `navigator.onLine` and the online/offline events. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

export const OFFLINE_MESSAGE = "You're offline. Sous needs a connection to load and save your household's data.";

/** Shown while the device is offline (Requirement 13.2). Renders nothing when online. */
export function OfflineBanner({ className }: { className?: string }) {
  const online = useOnlineStatus();
  return (
    <div role="status" aria-live="polite" className={className}>
      {!online && (
        <p className="flex items-center gap-2 bg-warning-soft px-4 py-2.5 text-sm font-medium text-text">
          <WifiOff aria-hidden="true" className="size-4 shrink-0 text-warning" />
          <span>{OFFLINE_MESSAGE}</span>
        </p>
      )}
    </div>
  );
}
