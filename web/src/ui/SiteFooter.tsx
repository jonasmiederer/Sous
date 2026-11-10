import { cx } from './cx';

export const GITHUB_URL = 'https://github.com/jonasmiederer/Sous';
export const WEBSITE_URL = 'https://jonas-miederer.de';

const LINK_CLASS = 'font-medium text-accent-text underline-offset-4 hover:underline focus-visible:underline';

/** Operator credit: name, personal website, and a link to the GitHub repo. */
export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer className={cx('text-center text-xs text-text-muted', className)}>
      <p>
        Jonas Miederer ·{' '}
        <a href={WEBSITE_URL} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          jonas-miederer.de
        </a>{' '}
        ·{' '}
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          GitHub
        </a>
      </p>
    </footer>
  );
}
