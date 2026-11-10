import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { LogIn } from 'lucide-react';
import { useApi } from '../../app/ServicesProvider';
import { isApiError } from '../../api/errors';
import { useSession } from '../../auth/SessionProvider';
import { safeReturnPath, type SignInLocationState } from '../../auth/RequireSession';
import { Button, ErrorBanner, TextField } from '../../ui';
import { AuthLayout, LINK_CLASS, Notice } from './AuthLayout';

/** Shown when Cognito answers with a challenge (e.g. NEW_PASSWORD_REQUIRED) this app cannot complete. */
export const CHALLENGE_MESSAGE =
  "This account needs an extra sign-in step that the Sous app doesn't support yet, such as setting a new password. Ask whoever manages your account for help.";

/** Lockout text from the `retry-after` seconds (Requirement 1.3). */
export function lockoutMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined || retryAfterSeconds <= 0) {
    return 'Too many sign-in attempts. Your account is locked for up to 15 minutes; try again later.';
  }
  if (retryAfterSeconds < 60) {
    return `Too many sign-in attempts. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`;
  }
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/**
 * Email + password sign-in form. On success it returns the user to the page
 * they were sent from (validated by `safeReturnPath` to avoid open redirects).
 * Router state can prefill the email after confirmation and explain why the
 * user landed here (e.g. an expired session).
 */
export function SignIn() {
  const api = useApi();
  const { completeSignIn } = useSession();
  const navigate = useNavigate();
  const state = (useLocation().state ?? {}) as SignInLocationState;
  const [email, setEmail] = useState(state.confirmedEmail ?? '');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const identifier = email.trim();
    const errors = {
      ...(identifier === '' ? { email: 'Enter your email.' } : {}),
      ...(password === '' ? { password: 'Enter your password.' } : {}),
    };
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setPending(true);
    setError(undefined);
    try {
      const response = await api.login({ identifier, password });
      // `completeSignIn` returns false when the response is a challenge rather than tokens.
      if (completeSignIn(response)) {
        navigate(safeReturnPath(state.from), { replace: true });
        return;
      }
      setError(CHALLENGE_MESSAGE);
    } catch (err) {
      if (isApiError(err) && err.code === 'ACCOUNT_TEMPORARILY_LOCKED') setError(lockoutMessage(err.retryAfterSeconds));
      else setError(isApiError(err) ? err.userMessage : 'Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      description="Sign in to plan meals with your household."
      footer={
        <>
          New to Sous?{' '}
          <Link to="/sign-up" className={LINK_CLASS}>
            Create an account
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
        {state.confirmedEmail && !error && <Notice tone="success">Your email is confirmed. During the beta, new accounts also need approval before you can sign in.</Notice>}
        {state.reason === 'expired' && !state.confirmedEmail && !error && (
          <Notice>Your session has ended. Please sign in again.</Notice>
        )}
        {error && <ErrorBanner message={error} />}
        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
        />
        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />
        <Button type="submit" size="lg" fullWidth loading={pending} icon={<LogIn aria-hidden="true" className="size-5" />}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
