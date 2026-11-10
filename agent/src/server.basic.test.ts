import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { buildAdHocPayload } from '../../src/agent/payload.js';
import { parseAgentResponse } from '../../src/agent/responses.js';
import type { PreferenceProfile } from '../../src/domain/types.js';
import { FakeModelClient, failedResult, okResult } from '../test/fakeModelClient.js';
import type { AgentConfig } from './config.js';
import { createServer, MAX_BODY_BYTES, shutdown, type LogLine, type ServerDeps } from './server.js';
import type { SoftPreferenceRead, SoftPreferenceSource } from './softPreferences.js';

const config: AgentConfig = {
  port: 8080,
  modelId: 'model',
  bedrockRegion: 'us-east-1',
  memoryId: 'mem',
  budgetsMs: { ad_hoc: 8_000, refine: 13_000, plan: 26_000 },
  adHocSuggestionCount: 2,
  planChunkDays: 4,
};

const profile = {
  likes: [],
  dislikes: [],
  excludedIngredients: ['coconut'],
  dietaryConstraints: [],
  acceptances: [],
  updatedAt: '2025-01-01T00:00:00.000Z',
} as unknown as PreferenceProfile;

const SECRET_CONTEXT = 'secret-context-do-not-log';

function adHocBody(): string {
  return JSON.stringify(
    buildAdHocPayload({
      householdId: 'hh-1',
      preferenceProfile: profile,
      fridgeInventory: [],
      presets: [],
      contextInput: SECRET_CONTEXT,
      rejectedSuggestionNames: [],
    }),
  );
}

const meal = { name: 'Leek soup', ingredients: [{ name: 'leek', quantity: 2, unit: 'piece' }], steps: ['Cook'], attributes: [] };

class FakeSoftPreferences implements SoftPreferenceSource {
  calls = 0;
  async read(): Promise<SoftPreferenceRead> {
    this.calls++;
    return { entries: [], degraded: false };
  }
}

let server: Server | undefined;
let logs: LogLine[] = [];

async function start(deps: Partial<ServerDeps> & Pick<ServerDeps, 'model'>): Promise<{ url: string; memory: FakeSoftPreferences }> {
  const memory = new FakeSoftPreferences();
  logs = [];
  server = createServer({ softPreferences: memory, config, log: (l) => logs.push(l), wallClock: () => 1_700_000_000_500, ...deps });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, memory };
}

afterEach(async () => {
  if (server) await shutdown(server, 100);
  server = undefined;
});

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

function post(url: string, body: string): Promise<Response> {
  return fetch(`${url}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}

describe('agent HTTP server', () => {
  it('answers /ping with Healthy and a fixed status-change time', async () => {
    const { url } = await start({ model: new FakeModelClient() });
    const first = await fetch(`${url}/ping`);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/json');
    expect(await first.json()).toEqual({ status: 'Healthy', time_of_last_update: 1_700_000_000 });
    expect(await (await fetch(`${url}/ping`)).json()).toEqual({ status: 'Healthy', time_of_last_update: 1_700_000_000 });
  });

  it('returns 404 for other routes and methods', async () => {
    const { url } = await start({ model: new FakeModelClient() });
    expect((await fetch(`${url}/other`)).status).toBe(404);
    const res = await fetch(`${url}/invocations`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });

  it('returns 400 for invalid JSON and invalid payloads without calling the model or memory', async () => {
    const model = new FakeModelClient();
    const { url, memory } = await start({ model });
    const bad = await post(url, '{not json');
    expect(bad.status).toBe(400);
    expect((await errorCode(bad))).toBe('INVALID_REQUEST');
    const invalid = await post(url, JSON.stringify({ ...JSON.parse(adHocBody()), preferenceMemoryNamespace: 'other' }));
    expect(invalid.status).toBe(400);
    expect((await errorCode(invalid))).toBe('INVALID_REQUEST');
    expect(model.callCount).toBe(0);
    expect(memory.calls).toBe(0);
  });

  it('returns 413 for a body above 512 KB', async () => {
    const model = new FakeModelClient();
    const { url } = await start({ model });
    const { hostname, port } = new URL(url);
    const status = await new Promise<number>((resolve, reject) => {
      // Chunked upload (no content-length) so the streaming limit is exercised.
      const req = httpRequest({ hostname, port, path: '/invocations', method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write('x'.repeat(MAX_BODY_BYTES));
      req.end('xx');
    });
    expect(status).toBe(413);
    expect(model.callCount).toBe(0);
  });

  it('returns 200 with exactly the contract JSON and logs no user content', async () => {
    const model = new FakeModelClient([okResult({ mode: 'ad_hoc', suggestions: [meal] })]);
    const { url, memory } = await start({ model });
    const res = await post(url, adHocBody());
    expect(res.status).toBe(200);
    const text = await res.text();
    const parsed = parseAgentResponse('ad_hoc', text);
    expect(parsed.ok).toBe(true);
    expect(JSON.parse(text)).toEqual({ mode: 'ad_hoc', suggestions: [meal] });
    expect(memory.calls).toBe(1);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ msg: 'request', mode: 'ad_hoc', status: 200, modelCalls: 1, softPreferences: 'memory' });
    expect(typeof logs[0]?.durationMs).toBe('number');
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SECRET_CONTEXT);
    expect(serialized).not.toContain('Leek soup');
  });

  it('returns 500 GENERATION_FAILED when output is still nonconforming after the repair call', async () => {
    const model = new FakeModelClient([okResult({ mode: 'plan' }), failedResult('no_structured_output')]);
    const { url } = await start({ model });
    const res = await post(url, adHocBody());
    expect(res.status).toBe(500);
    expect((await errorCode(res))).toBe('GENERATION_FAILED');
    expect(model.callCount).toBe(2);
    expect(logs[0]).toMatchObject({ status: 500, errorCode: 'GENERATION_FAILED', modelCalls: 2 });
  });

  it('returns 504 GENERATION_TIMEOUT when the mode budget runs out', async () => {
    const model = new FakeModelClient([], { fallback: okResult({ mode: 'ad_hoc', suggestions: [meal] }), delayMs: 5_000 });
    const { url } = await start({ model, config: { ...config, budgetsMs: { ...config.budgetsMs, ad_hoc: 50 } } });
    const res = await post(url, adHocBody());
    expect(res.status).toBe(504);
    expect((await errorCode(res))).toBe('GENERATION_TIMEOUT');
  });

  it('returns 500 when generation throws unexpectedly', async () => {
    const { url } = await start({
      model: new FakeModelClient(),
      generate: async () => {
        throw new Error(SECRET_CONTEXT);
      },
    });
    const res = await post(url, adHocBody());
    expect(res.status).toBe(500);
    expect((await errorCode(res))).toBe('GENERATION_FAILED');
    expect(JSON.stringify(logs)).not.toContain(SECRET_CONTEXT);
  });

  it('lets an in-flight request finish during shutdown', async () => {
    const model = new FakeModelClient([], { fallback: okResult({ mode: 'ad_hoc', suggestions: [meal] }), delayMs: 200 });
    const { url } = await start({ model });
    const pending = post(url, adHocBody());
    await new Promise((r) => setTimeout(r, 50));
    const closed = shutdown(server!, 5_000);
    server = undefined;
    const res = await pending;
    expect(res.status).toBe(200);
    await closed;
  });
});
