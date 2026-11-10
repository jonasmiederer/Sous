import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { MailCheck } from 'lucide-react';
import { useServices } from '../../app/ServicesProvider';
import { CognitoError } from '../../auth/cognitoPublic';
import type { SignInLocationState } from '../../auth/RequireSession';
import { Button, ErrorBanner, TextField } from '../../ui';
import { AuthLayout, LINK_CLASS, Notice, isPlausibleEmail } from './AuthLayout';
import type { ConfirmLocationState } from './SignUp';

/** User-safe text for an error; unknown errors get a generic message. */
function messageOf(err: unknown): string {
  return err instanceof CognitoError ? err.userMessage : 'Something went wrong. Please try again.';
}

/**
 * Confirms a new account with the emailed code and can resend it. Email is
 * prefilled from router state when arriving from sign-up, but users who open
 * this page directly (e.g. "Have a code already?") can type it in.
 */
export function ConfirmSignUp() {
  const { cognito } = useServices();
  const navigate = useNavigate();
  const state = (useLocation().state ?? {}) as ConfirmLocationState;
  const [email, setEmail] = useState(state.email ?? '');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string | undefined>(
    state.email ? `We sent a confirmation code to ${state.destination ?? state.email}.` : undefined,
  );
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; code?: string }>({});

  function emailError(address: string) {
    return isPlausibleEmail(address) ? undefined : 'Enter the email you signed up with.';
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    const trimmedCode = code.trim();
    const eError = emailError(address);
    const errors = { ...(eError ? { email: eError } : {}), ...(trimmedCode === '' ? { code: 'Enter the code from the email.' } : {}) };
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setPending(true);
    setError(undefined);
    try {
      await cognito.confirmSignUp(address, trimmedCode);
      const next: SignInLocationState = { confirmedEmail: address };
      navigate('/sign-in', { replace: true, state: next });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  }

  async function onResend() {
    const address = email.trim();
    const eError = emailError(address);
    setFieldErrors(eError ? { email: eError } : {});
    if (eError) return;
    setResending(true);
    setError(undefined);
    try {
      const result = await cognito.resendConfirmationCode(address);
      setNotice(`We sent a new code to ${result.destination ?? address}.`);
    } catch (err) {
      setNotice(undefined);
      setError(messageOf(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <AuthLayout
      title="Confirm your email"
      description="Enter the code we emailed you to finish creating your account."
      footer={
        <Link to="/sign-in" className={LINK_CLASS}>
          Back to sign in
        </Link>
      }
    >
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
        {error ? <ErrorBanner message={error} /> : notice && <Notice>{notice}</Notice>}
        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
        />
        <TextField
          label="Confirmation code"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={fieldErrors.code}
        />
        <Button type="submit" size="lg" fullWidth loading={pending} icon={<MailCheck aria-hidden="true" className="size-5" />}>
          Confirm account
        </Button>
        <Button variant="ghost" fullWidth loading={resending} onClick={onResend}>
          Send a new code
        </Button>
      </form>
    </AuthLayout>
  );
}
