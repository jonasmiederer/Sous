/**
 * Model-client abstraction for the Suggestion_Agent (design.md,
 * "Structured output, validation, and repair"; Requirements 12.1, 12.2).
 *
 * A `ModelClient` makes exactly one structured-output model call per
 * `generateStructured` invocation. It never retries and never validates the
 * returned document: the generation pipeline validates with
 * `parseAgentResponseValue` and the contract checks, and decides whether to
 * spend its single repair call. The repair call is expressed as extra
 * conversation turns: the assistant's previous `tool_use` followed by a user
 * `tool_result` with status `error` carrying the validator message.
 */

/** The only tool the model is offered; it must answer by calling it. */
export const SUBMIT_RESPONSE_TOOL_NAME = 'submit_response';

/** A JSON Schema document (draft 2020-12 subset accepted by Bedrock tools). */
export type JsonSchema = Record<string, unknown>;

export type ModelContentBlock =
  | { type: 'text'; text: string }
  /** A tool call previously made by the model (assistant turns only). */
  | { type: 'tool_use'; toolUseId: string; input: unknown }
  /** Feedback on a previous tool call (user turns only). */
  | { type: 'tool_result'; toolUseId: string; status: 'success' | 'error'; text: string };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ModelContentBlock[];
}

export interface StructuredRequest {
  system: string;
  /** User/assistant turns, starting with a user turn; includes any repair turn. */
  messages: ModelMessage[];
  tool: { name: typeof SUBMIT_RESPONSE_TOOL_NAME; description: string; inputSchema: JsonSchema };
  maxTokens: number;
  temperature?: number;
  /** Tied to the request deadline; aborting it cancels the in-flight call. */
  signal: AbortSignal;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type StructuredFailureReason = 'no_structured_output' | 'model_error' | 'aborted';

export type StructuredResult =
  | {
      ok: true;
      /** The tool input as returned by the model; not yet validated. */
      document: unknown;
      /** Id of the tool call, needed to build a repair `tool_result` turn. */
      toolUseId?: string;
      usage?: ModelUsage;
    }
  | { ok: false; reason: StructuredFailureReason; message: string };

export interface ModelClient {
  /** Never throws: every failure is returned as `{ ok: false }`. */
  generateStructured(request: StructuredRequest): Promise<StructuredResult>;
}
