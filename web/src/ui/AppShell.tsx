import type { ComponentType, ReactNode } from 'react';
import { OfflineBanner } from './OfflineBanner';
import { TabBar, type NavItem, type NavLinkProps } from './TabBar';

export const MAIN_CONTENT_ID = 'main-content';

export interface AppShellProps {
  navItems: readonly NavItem[];
  activeNavId?: string;
  /** Link component for navigation items; defaults to a plain anchor. */
  linkComponent?: ComponentType<NavLinkProps>;
  /** Right side of the top bar, for example ThemeToggle or a household switcher. */
  actions?: ReactNode;
  /** Optional context shown under the brand, for example the Active_Household name. */
  subtitle?: ReactNode;
  children: ReactNode;
}

function BrandMark({ size }: { size: 'sm' | 'lg' }) {
  return (
    <img
      src="/icons/icon.svg"
      alt=""
      width={size === 'lg' ? 44 : 32}
      height={size === 'lg' ? 44 : 32}
      className={size === 'lg' ? 'size-11 rounded-2xl shadow-card' : 'size-8 rounded-xl'}
    />
  );
}

/**
 * Application frame: skip link, top bar, offline notice, main landmark, and
 * primary navigation (bottom tab bar on phones, side rail from `lg`).
 * Screens render their own single `h1` inside `children`.
 */
export function AppShell({ navItems, activeNavId, linkComponent, actions, subtitle, children }: AppShellProps) {
  return (
    <div className="min-h-dvh lg:pl-24">
      <a
        href={`#${MAIN_CONTENT_ID}`}
        className="sr-only z-[60] rounded-xl bg-accent px-4 py-3 font-medium text-accent-contrast focus:not-sr-only focus:fixed focus:top-[max(0.75rem,env(safe-area-inset-top))] focus:left-3"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-border/70 bg-bg/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="mx-auto flex min-h-14 w-full max-w-screen-sm items-center gap-3 px-4 sm:px-6 lg:max-w-3xl">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="lg:hidden">
              <BrandMark size="sm" />
            </span>
            <div className="min-w-0">
              <p className="text-base font-semibold tracking-tight lg:sr-only">Sous</p>
              {subtitle && <p className="truncate text-xs text-text-muted">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
        <OfflineBanner />
      </header>

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="mx-auto w-full max-w-screen-sm px-4 pt-6 pb-[calc(6rem+env(safe-area-inset-bottom))] outline-none sm:px-6 lg:max-w-3xl lg:pt-10 lg:pb-16"
      >
        {children}
      </main>

      <TabBar items={navItems} activeId={activeNavId} linkComponent={linkComponent} railHeader={<BrandMark size="lg" />} />
    </div>
  );
}
