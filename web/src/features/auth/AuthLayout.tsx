import type { ReactNode } from 'react';
import { CircleCheck, Info } from 'lucide-react';
import { MAIN_CONTENT_ID, ThemeToggle, cx } from '../../ui';

export interface AuthLayoutProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Links under the card, e.g. "No account? Create one". */
  footer?: ReactNode;
}

/** Centered card layout for the sign-in, sign-up, and confirmation screens. */
export function AuthLayout({ title, description, children, footer }: AuthLayoutProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="flex justify-end px-3 pt-3">
        <ThemeToggle />
      </header>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-1 items-start justify-center px-4 pb-12 outline-none sm:items-center">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <img src="/icons/icon.svg" alt="" width={56} height={56} className="size-14 rounded-2xl shadow-card" />
            <div>
              <p className="text-sm font-semibold tracking-wide text-accent-text">Sous</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
              {description && <p className="mt-1.5 text-text-muted">{description}</p>}
            </div>
          </div>
          <div className="rounded-3xl border border-border bg-surface p-5 shadow-card sm:p-6">{children}</div>
          {footer && <div className="text-center text-sm text-text-muted">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

export interface NoticeProps {
  tone?: 'info' | 'success';
  children: ReactNode;
  className?: string;
}

/** A non-error inline message, announced politely. */
export function Notice({ tone = 'info', children, className }: NoticeProps) {
  const Icon = tone === 'success' ? CircleCheck : Info;
  return (
    <div role="status" className={cx('flex items-start gap-3 rounded-2xl bg-accent-soft p-4 text-sm text-text', className)}>
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent-text" />
      <p>{children}</p>
    </div>
  );
}

export const LINK_CLASS = 'font-medium text-accent-text underline-offset-4 hover:underline focus-visible:underline';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPlausibleEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}
