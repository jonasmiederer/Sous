import { describe, expect, it } from 'vitest';
import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { BedrockConverseModelClient, type ConverseSender } from './bedrockConverseModelClient.js';
import { SUBMIT_RESPONSE_TOOL_NAME, type StructuredRequest } from './modelClient.js';

const SCHEMA = { type: 'object', properties: { mode: { const: 'ad_hoc' } }, required: ['mode'] };

function request(overrides: Partial<StructuredRequest> = {}): StructuredRequest {
  return {
    system: 'system prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text: '<request_data>{}</request_data>' }] }],
    tool: { name: SUBMIT_RESPONSE_TOOL_NAME, description: 'Submit the response.', inputSchema: SCHEMA },
    maxTokens: 1024,
    temperature: 0.3,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function output(content: NonNullable<NonNullable<ConverseCommandOutput['output']>['message']>['content'], stopReason = 'tool_use'): ConverseCommandOutput {
  return {
    $metadata: {},
    output: { message: { role: 'assistant', content } },
    stopReason: stopReason as ConverseCommandOutput['stopReason'],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    metrics: { latencyMs: 5 },
  };
}

class RecordingSender implements ConverseSender {
  readonly calls: Array<{ command: ConverseCommand; abortSignal: AbortSignal | undefined }> = [];
  constructor(private readonly respond: (command: ConverseCommand) => Promise<ConverseCommandOutput>) {}
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput> {
    this.calls.push({ command, abortSignal: options?.abortSignal });
    return this.respond(command);
  }
}

describe('BedrockConverseModelClient', () => {
  it('forces the submit_response tool with the configured model id and passes the signal', async () => {
    const sender = new RecordingSender(async () =>
      output([{ toolUse: { toolUseId: 't1', name: 'submit_response', input: { mode: 'ad_hoc', suggestions: [] } } }]),
    );
    const client = new BedrockConverseModelClient({ modelId: 'model-x', sender });
    const req = request();

    const result = await client.generateStructured(req);

    expect(result).toEqual({
      ok: true,
      document: { mode: 'ad_hoc', suggestions: [] },
      toolUseId: 't1',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const call = sender.calls[0]!;
    expect(call.abortSignal).toBe(req.signal);
    const input = call.command.input;
    expect(input.modelId).toBe('model-x');
    expect(input.system).toEqual([{ text: 'system prompt' }]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 1024, temperature: 0.3 });
    expect(input.toolConfig).toEqual({
      tools: [{ toolSpec: { name: 'submit_response', description: 'Submit the response.', inputSchema: { json: SCHEMA } } }],
      toolChoice: { tool: { name: 'submit_response' } },
    });
    expect(input.additionalModelRequestFields).toBeUndefined();
  });

  it('disables adaptive thinking only for Claude Haiku 5.5 ids', () => {
    const fields = (modelId: string) =>
      new BedrockConverseModelClient({ modelId, sender: new RecordingSender(async () => output([])) }).buildCommandInput(
        request(),
      ).additionalModelRequestFields;
    for (const id of [
      'global.anthropic.claude-haiku-5-5',
      'eu.anthropic.claude-haiku-5-5',
      'anthropic.claude-haiku-5-5',
    ]) {
      expect(fields(id)).toEqual({ thinking: { type: 'disabled' } });
    }
    for (const id of [
      'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      'global.anthropic.claude-sonnet-5-5',
    ]) {
      expect(fields(id)).toBeUndefined();
    }
  });

  it('ignores extra content blocks such as reasoning next to the tool use', async () => {
    const sender = new RecordingSender(async () =>
      output([
        { reasoningContent: { reasoningText: { text: 'hmm' } } },
        { text: 'note' },
        { toolUse: { toolUseId: 't2', name: 'submit_response', input: { mode: 'ad_hoc' } } },
      ]),
    );
    const result = await new BedrockConverseModelClient({ modelId: 'm', sender }).generateStructured(request());
    expect(result).toMatchObject({ ok: true, document: { mode: 'ad_hoc' }, toolUseId: 't2' });
  });

  it('maps repair turns to toolUse and error toolResult blocks', () => {
    const client = new BedrockConverseModelClient({ modelId: 'm', sender: new RecordingSender(async () => output([])) });
    const input = client.buildCommandInput(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          { role: 'assistant', content: [{ type: 'tool_use', toolUseId: 't1', input: { mode: 'plan' } }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 't1', status: 'error', text: 'response.meals must contain exactly 4 items' }],
          },
        ],
      }),
    );
    expect(input.messages).toEqual([
      { role: 'user', content: [{ text: 'q' }] },
      { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'submit_response', input: { mode: 'plan' } } }] },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 't1',
              status: 'error',
              content: [{ text: 'response.meals must contain exactly 4 items' }],
            },
          },
        ],
      },
    ]);
  });

  it('returns no_structured_output when the model answers without the tool', async () => {
    const client = new BedrockConverseModelClient({
      modelId: 'm',
      sender: new RecordingSender(async () => output([{ text: 'Here are some meals' }], 'end_turn')),
    });
    const result = await client.generateStructured(request());
    expect(result).toMatchObject({ ok: false, reason: 'no_structured_output' });
  });

  it('returns model_error for a thrown service error', async () => {
    const err = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const client = new BedrockConverseModelClient({
      modelId: 'm',
      sender: new RecordingSender(async () => {
        throw err;
      }),
    });
    const result = await client.generateStructured(request());
    expect(result).toEqual({ ok: false, reason: 'model_error', message: 'ThrottlingException: Rate exceeded' });
  });

  it('returns aborted when the signal fires during the call, and skips the call when already aborted', async () => {
    const controller = new AbortController();
    const sender = new RecordingSender(
      (_command) =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const client = new BedrockConverseModelClient({ modelId: 'm', sender });
    const pending = client.generateStructured(request({ signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted' });

    const result = await client.generateStructured(request({ signal: controller.signal }));
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
    expect(sender.calls).toHaveLength(1);
  });
});
