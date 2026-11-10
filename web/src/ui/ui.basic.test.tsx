import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Inbox } from 'lucide-react';
import { AsyncView, GENERIC_ERROR_MESSAGE, type AsyncState } from './AsyncView';
import { Button } from './Button';
import { CharCounter } from './CharCounter';
import { Chip } from './Chip';
import { Dialog } from './Dialog';
import { EmptyState } from './EmptyState';
import { OFFLINE_MESSAGE, OfflineBanner } from './OfflineBanner';
import { TextArea } from './TextArea';
import { TextField } from './TextField';
import { ThemeToggle } from './ThemeToggle';
import { ToastProvider, useToast } from './Toast';
import { UpdateAvailableToast } from './UpdateAvailableToast';
import { codePointLength } from './text';
import { THEME_STORAGE_KEY, setThemePreference } from './theme';
import { notifyUpdateAvailable, resetPendingUpdate } from './updateAvailable';

describe('codePointLength and CharCounter', () => {
  it('counts code points, so emoji and astral characters count once', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('🥕🥕')).toBe(2);
    expect('🥕🥕'.length).toBe(4);
  });

  it('shows usage and announces when over the limit', () => {
    const { rerender } = render(<CharCounter value="🥕ab" max={3} />);
    expect(screen.getByText('3 of 3 characters used')).toBeInTheDocument();
    rerender(<CharCounter value="🥕abc" max={3} />);
    expect(screen.getByText('1 character over the 3-character limit')).toBeInTheDocument();
  });
});

describe('form controls', () => {
  it('TextArea links the counter and turns invalid past the code-point limit', () => {
    const { rerender } = render(<TextArea label="Notes" value={'a'.repeat(5)} onChange={() => {}} maxCodePoints={5} />);
    const box = screen.getByRole('textbox', { name: 'Notes' });
    expect(box).not.toHaveAttribute('aria-invalid');
    expect(box).toHaveAccessibleDescription('5 of 5 characters used');
    rerender(<TextArea label="Notes" value={'a'.repeat(6)} onChange={() => {}} maxCodePoints={5} />);
    expect(box).toHaveAttribute('aria-invalid', 'true');
  });

  it('TextField exposes its label and error', () => {
    render(<TextField label="Email" error="Enter an email address." />);
    const input = screen.getByRole('textbox', { name: 'Email' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter an email address.');
  });

  it('Chip toggles aria-pressed', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [pressed, setPressed] = useState(false);
      return (
        <Chip pressed={pressed} onPressedChange={setPressed}>
          Healthy
        </Chip>
      );
    }
    render(<Harness />);
    const chip = screen.getByRole('button', { name: 'Healthy' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('Button in loading state is busy and ignores clicks', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Confirm transcript" footer={<button type="button">Confirm</button>}>
          <input aria-label="Transcript" />
        </Dialog>
      </>
    );
  }

  it('focuses inside on open, traps Tab, closes on Escape, and restores focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Confirm transcript' });
    const input = screen.getByRole('textbox', { name: 'Transcript' });
    expect(input).toHaveFocus();

    // Focus order inside: Close, Transcript, Confirm. Tab from the last wraps to the first.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Transcript' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe('feedback components', () => {
  it('ErrorBanner via AsyncView uses role="alert", the mapped message, and retries', async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    const query: AsyncState<string[]> = { isPending: false, isError: true, error: new Error('x'), data: undefined, refetch };
    render(
      <AsyncView query={query} errorMessage={() => 'Plan not found.'}>
        {(data) => data.join(',')}
      </AsyncView>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Plan not found.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('AsyncView shows loading, empty, generic error, and content states', () => {
    const base = { isError: false, error: null } as const;
    const { rerender } = render(
      <AsyncView query={{ ...base, isPending: true, data: undefined }}>{(d: string[]) => d.join(',')}</AsyncView>,
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');

    const empty = <EmptyState icon={<Inbox />} title="No plans yet" />;
    rerender(
      <AsyncView query={{ ...base, isPending: false, data: [] }} isEmpty={(d) => d.length === 0} empty={empty}>
        {(d: string[]) => d.join(',')}
      </AsyncView>,
    );
    expect(screen.getByText('No plans yet')).toBeInTheDocument();

    rerender(
      <AsyncView query={{ isPending: false, isError: true, error: 'boom', data: undefined }}>{(d: string[]) => d.join(',')}</AsyncView>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(GENERIC_ERROR_MESSAGE);

    rerender(<AsyncView query={{ ...base, isPending: false, data: ['a', 'b'] }}>{(d: string[]) => d.join(',')}</AsyncView>);
    expect(screen.getByText('a,b')).toBeInTheDocument();
  });

  it('Toast renders in a polite live region and auto-dismisses', async () => {
    vi.useFakeTimers();
    try {
      function Trigger() {
        const toast = useToast();
        return (
          <button type="button" onClick={() => toast.show({ message: 'Saved', durationMs: 1000 })}>
            Go
          </button>
        );
      }
      render(
        <ToastProvider>
          <Trigger />
        </ToastProvider>,
      );
      const region = screen.getByRole('region', { name: 'Notifications' });
      expect(region).toHaveAttribute('aria-live', 'polite');
      act(() => screen.getByRole('button', { name: 'Go' }).click());
      expect(region).toHaveTextContent('Saved');
      act(() => vi.advanceTimersByTime(1000));
      expect(region).not.toHaveTextContent('Saved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('UpdateAvailableToast offers a reload that applies the waiting service worker', async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    render(
      <ToastProvider>
        <UpdateAvailableToast />
      </ToastProvider>,
    );
    act(() => notifyUpdateAvailable(apply));
    await user.click(await screen.findByRole('button', { name: 'Reload' }));
    expect(apply).toHaveBeenCalledTimes(1);
    resetPendingUpdate();
  });
});

describe('OfflineBanner', () => {
  let online = true;
  beforeEach(() => {
    online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  });
  afterEach(() => vi.restoreAllMocks());

  it('appears when the device goes offline and hides when back online', () => {
    render(<OfflineBanner />);
    expect(screen.queryByText(OFFLINE_MESSAGE)).not.toBeInTheDocument();
    act(() => {
      online = false;
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText(OFFLINE_MESSAGE)).toBeInTheDocument();
    act(() => {
      online = true;
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByText(OFFLINE_MESSAGE)).not.toBeInTheDocument();
  });
});

describe('ThemeToggle', () => {
  afterEach(() => {
    act(() => setThemePreference('system'));
  });

  it('cycles system → light → dark, sets data-theme, and stores the choice', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button', { name: /Theme: device setting/ }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    await user.click(screen.getByRole('button', { name: /Theme: light/ }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await user.click(screen.getByRole('button', { name: /Theme: dark/ }));
    await waitFor(() => expect(document.documentElement).not.toHaveAttribute('data-theme'));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});
