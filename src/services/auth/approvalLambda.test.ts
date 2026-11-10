import { describe, expect, it, vi } from 'vitest';
import { gateNewUser, type ApprovalDeps, type PostConfirmationEvent } from './approvalLambda.js';

const event = (triggerSource: string): PostConfirmationEvent => ({
  userPoolId: 'eu-west-1_POOL',
  userName: 'user-1',
  triggerSource,
  request: { userAttributes: { email: 'ana@example.com' } },
});

const deps = (overrides: Partial<ApprovalDeps> = {}): ApprovalDeps => ({
  disableUser: vi.fn().mockResolvedValue(undefined),
  notify: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('gateNewUser', () => {
  it('disables a freshly confirmed user and notifies the operator', async () => {
    const d = deps();
    const e = event('PostConfirmation_ConfirmSignUp');
    await expect(gateNewUser(e, d)).resolves.toBe(e);
    expect(d.disableUser).toHaveBeenCalledWith('eu-west-1_POOL', 'user-1');
    const [, message] = vi.mocked(d.notify).mock.calls[0]!;
    expect(message).toContain('ana@example.com');
    expect(message).toContain('admin-enable-user --user-pool-id eu-west-1_POOL --username user-1');
  });

  it('leaves users alone after a password reset', async () => {
    const d = deps();
    await gateNewUser(event('PostConfirmation_ConfirmForgotPassword'), d);
    expect(d.disableUser).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('fails closed when disabling fails, without notifying', async () => {
    const d = deps({ disableUser: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(gateNewUser(event('PostConfirmation_ConfirmSignUp'), d)).rejects.toThrow('boom');
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('still succeeds when the notification fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = deps({ notify: vi.fn().mockRejectedValue(new Error('sns down')) });
    await expect(gateNewUser(event('PostConfirmation_ConfirmSignUp'), d)).resolves.toBeDefined();
    expect(d.disableUser).toHaveBeenCalled();
  });
});
