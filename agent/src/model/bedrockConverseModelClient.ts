/**
 * Claude-on-Bedrock `ModelClient` using the Converse API with one forced tool
 * (design.md, "Structured output, validation, and repair"; Requirements 8.2,
 * 12.1, 12.2).
 *
 * Decision (task 19.6): Converse, not Strands. `@strands-agents/sdk` 1.24.0
 * (Apache-2.0, ESM, Node >= 22, Bedrock provider) was checked. Its structured
 * output takes Zod schemas, while the agent's mode schemas are JSON Schema,
 * and it retries on validation failure inside its own agent loop, which would
 * break the "at most one repair call" bound (Property 36). It also adds about
 * 5 MB of unpacked dependencies to the bundle. `ConverseCommand` with a single
 * `submit_response` tool and `toolChoice: { tool: { name } }` gives the same
 * structured output with one call per invocation and no extra dependency
 * beyond `@aws-sdk/client-bedrock-runtime`, which Strands itself uses.
 *
 * Mapping:
 * - response without a `submit_response` tool use -> `no_structured_output`
 * - thrown SDK/service error (throttling, validation, 5xx, network) -> `model_error`
 * - the request's AbortSignal fired (before or during the call) -> `aborted`
 */

import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type BedrockRuntimeClientConfig,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import {
  SUBMIT_RESPONSE_TOOL_NAME,
  type ModelClient,
  type ModelContentBlock,
  type ModelMessage,
  type StructuredRequest,
  type StructuredResult,
} from './modelClient.js';

/** The SDK's JSON document type (tool inputs and input schemas). */
type DocumentType = NonNullable<ToolUseBlock['input']>;

/**
 * Claude Haiku 5.5 runs adaptive thinking when the request omits `thinking`,
 * and bills thinking tokens as output tokens. The agent needs a plain forced
 * tool call, so send `thinking: { type: 'disabled' }` (allowed on Haiku 5.5 at
 * effort high or below; effort is left at its default). Other models are left
 * unchanged: Haiku 4.5 does not think by default, and some Claude 5 models
 * (e.g. Sonnet 5.5) reject `disabled` with a 400. Source:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html
 */
const DISABLE_THINKING_MODEL = /(?:^|\.)anthropic\.claude-haiku-5-5(?:$|[:.-])/;

/** Minimal surface of BedrockRuntimeClient used here, for injection in tests. */
export interface ConverseSender {
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

export interface BedrockConverseModelClientConfig {
  /** Claude model id or inference profile id (`MODEL_ID`). */
  modelId: string;
  /** Bedrock region (`BEDROCK_REGION`); used only when `sender` is omitted. */
  region?: string;
  /**
   * Optional cross-account role (`MODEL_ROLE_ARN`) assumed for Bedrock calls;
   * credentials are refreshed automatically. Used only when `sender` is omitted.
   */
  assumeRole?: { roleArn: string; externalId?: string };
  /** Defaults to a new BedrockRuntimeClient for `region`. */
  sender?: ConverseSender;
}

/** Client options for `BedrockRuntimeClient`, adding assumed-role credentials when configured. */
export function bedrockClientOptions(
  config: Pick<BedrockConverseModelClientConfig, 'region' | 'assumeRole'>,
): BedrockRuntimeClientConfig {
  const options: BedrockRuntimeClientConfig = config.region ? { region: config.region } : {};
  if (config.assumeRole) {
    options.credentials = fromTemporaryCredentials({
      params: {
        RoleArn: config.assumeRole.roleArn,
        RoleSessionName: 'sous-suggestion-agent',
        ...(config.assumeRole.externalId ? { ExternalId: config.assumeRole.externalId } : {}),
      },
      ...(config.region ? { clientConfig: { region: config.region } } : {}),
    });
  }
  return options;
}

export class BedrockConverseModelClient implements ModelClient {
  private readonly sender: ConverseSender;

  constructor(private readonly config: BedrockConverseModelClientConfig) {
    if (!config.modelId) throw new Error('modelId is required');
    this.sender = config.sender ?? (new BedrockRuntimeClient(bedrockClientOptions(config)) as ConverseSender);
  }

  /** The exact Converse input for a request (exposed for testing). */
  buildCommandInput(request: StructuredRequest): ConverseCommandInput {
    const inferenceConfig: NonNullable<ConverseCommandInput['inferenceConfig']> = { maxTokens: request.maxTokens };
    if (request.temperature !== undefined) inferenceConfig.temperature = request.temperature;
    const input: ConverseCommandInput = {
      modelId: this.config.modelId,
      system: [{ text: request.system }],
      messages: request.messages.map(toConverseMessage),
      inferenceConfig,
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: request.tool.name,
              description: request.tool.description,
              inputSchema: { json: request.tool.inputSchema as DocumentType },
            },
          },
        ],
        toolChoice: { tool: { name: request.tool.name } },
      },
    };
    if (DISABLE_THINKING_MODEL.test(this.config.modelId)) {
      input.additionalModelRequestFields = { thinking: { type: 'disabled' } };
    }
    return input;
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    if (request.signal.aborted) return aborted();
    let output: ConverseCommandOutput;
    try {
      output = await this.sender.send(new ConverseCommand(this.buildCommandInput(request)), {
        abortSignal: request.signal,
      });
    } catch (err) {
      if (request.signal.aborted) return aborted();
      return { ok: false, reason: 'model_error', message: describeError(err) };
    }
    if (request.signal.aborted) return aborted();

    const toolUse = output.output?.message?.content?.find(
      (block) => block.toolUse !== undefined && block.toolUse.name === request.tool.name,
    )?.toolUse;
    if (toolUse === undefined || toolUse.input === undefined) {
      return {
        ok: false,
        reason: 'no_structured_output',
        message: `model returned no ${request.tool.name} tool use (stopReason: ${output.stopReason ?? 'unknown'})`,
      };
    }

    const result: StructuredResult = { ok: true, document: toolUse.input };
    if (toolUse.toolUseId) result.toolUseId = toolUse.toolUseId;
    if (output.usage) {
      result.usage = {};
      if (output.usage.inputTokens !== undefined) result.usage.inputTokens = output.usage.inputTokens;
      if (output.usage.outputTokens !== undefined) result.usage.outputTokens = output.usage.outputTokens;
    }
    return result;
  }
}

function toConverseMessage(message: ModelMessage): Message {
  return { role: message.role, content: message.content.map(toConverseBlock) };
}

function toConverseBlock(block: ModelContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { text: block.text };
    case 'tool_use':
      return {
        toolUse: { toolUseId: block.toolUseId, name: SUBMIT_RESPONSE_TOOL_NAME, input: block.input as DocumentType },
      };
    case 'tool_result':
      return { toolResult: { toolUseId: block.toolUseId, status: block.status, content: [{ text: block.text }] } };
  }
}

function aborted(): StructuredResult {
  return { ok: false, reason: 'aborted', message: 'model call aborted' };
}

/** Error name and message only; never request content. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message ? `${err.name}: ${err.message}` : err.name;
  return String(err);
}
