/**
 * AudioStore: narrow interface over the S3 audio bucket.
 *
 * Voice_Input audio is stored under `households/{householdId}/voice/{voiceId}`
 * so every object is Household-prefixed (Requirement 11.6). The bucket's
 * lifecycle rule (task 16.1) expires these objects; the application never
 * reads them back in the request path.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { assertKeyComponent } from '../data/keys.js';

export interface PutAudioInput {
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface AudioStore {
  put(input: PutAudioInput, options: { signal: AbortSignal }): Promise<void>;
}

/** S3 object key for a Voice_Input. Both ids are validated (no `#`, `/` or empty). */
export function audioObjectKey(householdId: string, voiceId: string): string {
  for (const [field, value] of [
    ['householdId', householdId],
    ['voiceId', voiceId],
  ] as const) {
    assertKeyComponent(field, value);
    if (value.includes('/')) throw new Error(`${field} must not contain '/'`);
  }
  return `households/${householdId}/voice/${voiceId}`;
}

/** S3 PutObject adapter with server-side encryption. */
export class S3AudioStore implements AudioStore {
  constructor(
    private readonly bucket: string,
    private readonly client: Pick<S3Client, 'send'> = new S3Client({}),
  ) {}

  async put(input: PutAudioInput, options: { signal: AbortSignal }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ServerSideEncryption: 'AES256',
      }),
      { abortSignal: options.signal },
    );
  }
}

/** In-memory AudioStore for tests; `failNext` makes the next put reject. */
export class InMemoryAudioStore implements AudioStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  private failure: Error | undefined;

  failNext(error: Error = new Error('injected audio store failure')): void {
    this.failure = error;
  }

  async put(input: PutAudioInput): Promise<void> {
    if (this.failure) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }
    this.objects.set(input.key, { body: input.body.slice(), contentType: input.contentType });
  }
}
