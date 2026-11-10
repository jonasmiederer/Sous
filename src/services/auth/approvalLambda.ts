/**
 * Cognito Post-confirmation trigger: beta approval gate.
 *
 * When a user confirms their email after sign-up, the account is disabled
 * right away and the operator is notified through SNS. The operator approves
 * the user with:
 *
 *   aws cognito-idp admin-enable-user --user-pool-id <id> --username <email>
 *
 * Only `PostConfirmation_ConfirmSignUp` is gated. The same trigger also fires
 * after a password reset (`PostConfirmation_ConfirmForgotPassword`), which must
 * never disable an already approved user.
 *
 * Environment: APPROVAL_TOPIC_ARN (optional; without it nobody is notified,
 * the user is still disabled).
 *
 * If disabling fails the handler throws, so Cognito reports an error to the
 * client. Failing closed is intended: the user can retry the confirmation
 * code, and nobody gets in unapproved. A failed notification is only logged,
 * because the user is already disabled and shows up in the Cognito console.
 */
import {
  AdminDisableUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';

export const GATED_TRIGGER_SOURCE = 'PostConfirmation_ConfirmSignUp';

/** The part of the Cognito trigger event this handler reads. */
export interface PostConfirmationEvent {
  userPoolId: string;
  userName: string;
  triggerSource: string;
  request: { userAttributes: Record<string, string> };
}

export interface ApprovalDeps {
  disableUser(userPoolId: string, username: string): Promise<void>;
  notify(subject: string, message: string): Promise<void>;
}

export async function gateNewUser<E extends PostConfirmationEvent>(event: E, deps: ApprovalDeps): Promise<E> {
  if (event.triggerSource !== GATED_TRIGGER_SOURCE) return event;

  await deps.disableUser(event.userPoolId, event.userName);

  const email = event.request.userAttributes.email ?? event.userName;
  try {
    await deps.notify(
      'Sous: new user waiting for approval',
      [
        `${email} confirmed their sign-up and is waiting for approval.`,
        '',
        'Approve:',
        `  aws cognito-idp admin-enable-user --user-pool-id ${event.userPoolId} --username ${event.userName}`,
        '',
        'Reject:',
        `  aws cognito-idp admin-delete-user --user-pool-id ${event.userPoolId} --username ${event.userName}`,
      ].join('\n'),
    );
  } catch (err) {
    console.warn('approval notification failed', { error: err instanceof Error ? err.name : 'UnknownError' });
  }
  return event;
}

let cognito: CognitoIdentityProviderClient | undefined;
let sns: SNSClient | undefined;

export async function handler(event: PostConfirmationEvent): Promise<PostConfirmationEvent> {
  cognito ??= new CognitoIdentityProviderClient({});
  sns ??= new SNSClient({});
  const topicArn = process.env.APPROVAL_TOPIC_ARN;
  const cognitoClient = cognito;
  const snsClient = sns;
  return gateNewUser(event, {
    async disableUser(userPoolId, username) {
      await cognitoClient.send(new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username }));
    },
    async notify(subject, message) {
      if (!topicArn) return;
      await snsClient.send(new PublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }));
    },
  });
}
