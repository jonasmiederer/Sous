/**
 * Entry point of the Suggestion_Agent container (design.md, "Code layout and
 * packaging"; Requirements 8.2, 12.14).
 *
 * Reads the configuration from the environment, wires the read-only
 * soft-preference source over AgentCore Memory and the Claude-on-Bedrock
 * model client, and serves the AgentCore HTTP contract on 0.0.0.0:PORT.
 * On SIGTERM or SIGINT it stops accepting connections, lets in-flight
 * requests finish (at most SHUTDOWN_GRACE_MS), and exits.
 */

import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';

import { ConfigError, loadConfig, type AgentConfig } from './config.js';
import { BedrockConverseModelClient } from './model/bedrockConverseModelClient.js';
import { createServer, defaultLog, shutdown } from './server.js';
import { createAgentCoreSoftPreferenceSource } from './softPreferences.js';

/** Longer than the largest mode budget (26 s) so in-flight plans can finish. */
export const SHUTDOWN_GRACE_MS = 28_000;

function start(config: AgentConfig): void {
  // Memory lives in the runtime's own region (ambient AWS_REGION); Bedrock may differ.
  const softPreferences = createAgentCoreSoftPreferenceSource({
    client: new BedrockAgentCoreClient({}),
    memoryId: config.memoryId,
    ...(config.memoryPreferenceStrategyId !== undefined ? { preferenceStrategyId: config.memoryPreferenceStrategyId } : {}),
  });
  const model = new BedrockConverseModelClient({
    modelId: config.modelId,
    region: config.bedrockRegion,
    ...(config.modelRoleArn !== undefined
      ? {
          assumeRole: {
            roleArn: config.modelRoleArn,
            ...(config.modelRoleExternalId !== undefined ? { externalId: config.modelRoleExternalId } : {}),
          },
        }
      : {}),
  });
  const server = createServer({ model, softPreferences, config });

  server.listen(config.port, '0.0.0.0', () => {
    defaultLog({ level: 'info', msg: 'listening', port: config.port, modelId: config.modelId });
  });

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    defaultLog({ level: 'info', msg: 'shutting down', signal });
    void shutdown(server, SHUTDOWN_GRACE_MS).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

try {
  start(loadConfig(process.env));
} catch (err) {
  defaultLog({
    level: 'error',
    msg: 'startup failed',
    error: err instanceof ConfigError ? err.message : err instanceof Error ? err.name : String(err),
  });
  process.exit(1);
}
