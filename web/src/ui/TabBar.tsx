import type { AnchorHTMLAttributes, ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

export type NavLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode };

/** Plain anchor; the router (task 23.11) passes its own link component. */
export function DefaultNavLink(props: NavLinkProps) {
  return <a {...props} />;
}

export interface TabBarProps {
  items: readonly NavItem[];
  activeId?: string;
  linkComponent?: ComponentType<NavLinkProps>;
  /** Rendered at the top of the side rail (`lg` and up), usually the brand mark. */
  railHeader?: ReactNode;
  label?: string;
  className?: string;
}

/**
 * Primary navigation. A bottom tab bar on phones and tablets (respecting
 * safe-area insets, every target at least 44 × 44 px) that becomes a
 * left-hand side rail from the `lg` breakpoint. One `<nav>` serves both
 * layouts so the landmark is never duplicated.
 */
export function TabBar({ items, activeId, linkComponent: Link = DefaultNavLink, railHeader, label = 'Primary', className }: TabBarProps) {
  return (
    <nav
      aria-label={label}
      className={cx(
        'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur-md',
        'lg:inset-x-auto lg:inset-y-0 lg:left-0 lg:flex lg:w-24 lg:flex-col lg:items-center lg:gap-6 lg:border-t-0 lg:border-r lg:bg-surface lg:pt-[max(1.25rem,env(safe-area-inset-top))] lg:pr-0 lg:pb-6 lg:backdrop-blur-none',
        className,
      )}
    >
      {railHeader && <div className="hidden lg:flex">{railHeader}</div>}
      <ul className="grid lg:flex lg:flex-col lg:gap-2" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item) => {
          const active = item.id === activeId;
          const Icon = item.icon;
          return (
            <li key={item.id} className="flex">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'group flex min-h-14 min-w-11 flex-1 flex-col items-center justify-center gap-1 px-1 py-1.5 text-xs font-medium transition-colors duration-150 lg:min-h-16 lg:w-20 lg:rounded-2xl',
                  active ? 'text-accent-text' : 'text-text-muted hover:text-text',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    'flex h-8 w-14 items-center justify-center rounded-full transition-colors duration-200',
                    active ? 'bg-accent-soft' : 'group-hover:bg-surface-2',
                  )}
                >
                  <Icon className="size-5" strokeWidth={active ? 2.25 : 2} />
                </span>
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
