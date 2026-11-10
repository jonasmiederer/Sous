/**
 * Runtime configuration for the Client_App (Requirement 13.20).
 *
 * One build serves any stack: the deployment writes `/config.json` next to
 * `index.html` with the API endpoint and the Cognito ids. The service worker
 * fetches it NetworkFirst, so an offline launch still gets the last copy.
 */
export interface RuntimeConfig {
  /** Base URL of the HTTP API, e.g. `https://abc.execute-api.eu-west-1.amazonaws.com`. No trailing slash. */
  apiUrl: string;
  /** AWS region of the Cognito user pool, e.g. `eu-west-1`. */
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

export const RUNTIME_CONFIG_PATH = '/config.json';

export class RuntimeConfigError extends Error {
  override readonly name = 'RuntimeConfigError';
}

const REQUIRED_FIELDS = ['apiUrl', 'region', 'userPoolId', 'userPoolClientId'] as const;

/** Validates a parsed `config.json` document. Throws RuntimeConfigError when it is unusable. */
export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuntimeConfigError('config.json must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    const v = record[field];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new RuntimeConfigError(`config.json is missing "${field}".`);
    }
  }
  const apiUrl = (record.apiUrl as string).trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new RuntimeConfigError('config.json "apiUrl" is not a valid URL.');
  }
  // HTTPS only, except a local API during development.
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new RuntimeConfigError('config.json "apiUrl" must use HTTPS.');
  }
  return {
    apiUrl,
    region: (record.region as string).trim(),
    userPoolId: (record.userPoolId as string).trim(),
    userPoolClientId: (record.userPoolClientId as string).trim(),
  };
}

/** Fetches and validates `/config.json`. */
export async function loadRuntimeConfig(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<RuntimeConfig> {
  let response: Response;
  try {
    response = await fetchImpl(RUNTIME_CONFIG_PATH, { cache: 'no-cache', headers: { accept: 'application/json' } });
  } catch {
    throw new RuntimeConfigError('Could not load config.json.');
  }
  if (!response.ok) throw new RuntimeConfigError(`Could not load config.json (HTTP ${response.status}).`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RuntimeConfigError('config.json is not valid JSON.');
  }
  return parseRuntimeConfig(body);
}
