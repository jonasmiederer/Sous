/**
 * Production dependencies shared by Lambda entry modules, built from the
 * environment once per container.
 *
 *   TABLE_NAME                   DynamoDB single table
 *   AGENT_RUNTIME_ARN            Bedrock AgentCore Runtime ARN of the Suggestion_Agent
 *   AGENT_RUNTIME_QUALIFIER      optional runtime endpoint qualifier
 *   MEMORY_ID                    AgentCore Memory resource id
 *   MEMORY_PREFERENCE_STRATEGY_ID optional long-term preference strategy id
 */
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AgentCoreMemoryClient, type AgentCoreMemorySender, type MemoryClient } from '../../agent/memoryClient.js';
import { AgentCoreRuntimeClient, type SuggestionAgentClient } from '../../agent/runtimeClient.js';
import { DocumentTableClient, type TableClient } from '../../data/tableClient.js';
import { requireEnv } from './authorization/index.js';

export function tableFromEnv(): TableClient {
  return new DocumentTableClient(DynamoDBDocumentClient.from(new DynamoDBClient({})), requireEnv('TABLE_NAME'));
}

export function agentFromEnv(): SuggestionAgentClient {
  const qualifier = process.env.AGENT_RUNTIME_QUALIFIER;
  return new AgentCoreRuntimeClient({
    agentRuntimeArn: requireEnv('AGENT_RUNTIME_ARN'),
    ...(qualifier ? { qualifier } : {}),
  });
}

export function memoryFromEnv(): MemoryClient {
  const preferenceStrategyId = process.env.MEMORY_PREFERENCE_STRATEGY_ID;
  return new AgentCoreMemoryClient({
    client: new BedrockAgentCoreClient({}) as unknown as AgentCoreMemorySender,
    memoryId: requireEnv('MEMORY_ID'),
    ...(preferenceStrategyId ? { preferenceStrategyId } : {}),
  });
}
