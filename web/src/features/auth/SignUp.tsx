import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { UserPlus } from 'lucide-react';
import { useServices } from '../../app/ServicesProvider';
import { CognitoError } from '../../auth/cognitoPublic';
import type { SignInLocationState } from '../../auth/RequireSession';
import { Button, ErrorBanner, TextField, codePointLength } from '../../ui';
import { AuthLayout, LINK_CLASS, isPlausibleEmail } from './AuthLayout';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const CONFIRM_PATH = '/sign-up/confirm';

/** Navigation state for the confirmation screen. */
export interface ConfirmLocationState {
  email?: string;
  destination?: string;
}

/** Password rule shared with the user pool (Requirement 1.1, 13.4): 8 to 128 characters. */
export function passwordError(password: string): string | undefined {
  const length = codePointLength(password);
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return undefined;
}

export function SignUp() {
  const { cognito } = useServices();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    const pwError = passwordError(password);
    const errors = {
      ...(isPlausibleEmail(address) ? {} : { email: 'Enter a valid email address.' }),
      ...(pwError ? { password: pwError } : {}),
    };
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setPending(true);
    setError(undefined);
    try {
      const result = await cognito.signUp(address, password);
      if (result.userConfirmed) {
        const state: SignInLocationState = { confirmedEmail: address };
        navigate('/sign-in', { state });
      } else {
        const state: ConfirmLocationState = { email: address, ...(result.destination ? { destination: result.destination } : {}) };
        navigate(CONFIRM_PATH, { state });
      }
    } catch (err) {
      setError(err instanceof CognitoError ? err.userMessage : 'Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      description="We'll email you a code to confirm it."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/sign-in" className={LINK_CLASS}>
            Sign in
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
        {error && <ErrorBanner message={error} />}
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
          label="Password"
          type="password"
          name="new-password"
          autoComplete="new-password"
          hint={`${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />
        <Button type="submit" size="lg" fullWidth loading={pending} icon={<UserPlus aria-hidden="true" className="size-5" />}>
          Create account
        </Button>
        <p className="text-center text-sm text-text-muted">
          Have a code already?{' '}
          <Link to={CONFIRM_PATH} className={LINK_CLASS}>
            Confirm your account
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
