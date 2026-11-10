/**
 * CDK app entry point. Run via `npm run synth` (compiles, then `cdk synth`).
 *
 * Context (cdk.json or `-c key=value`):
 *   agentRuntimeMode            `asset` (default): build agent/Dockerfile as an image asset and
 *                               create the AgentCore Runtime from it (Docker is needed for
 *                               `cdk deploy`, not for synth).
 *                               `parameter`: pass the existing runtime ARN as the
 *                               `AgentRuntimeArn` stack parameter at deploy time.
 *   agentContainerUri           ECR image URI; the stack creates the AgentCore Runtime from it
 *                               instead of building the image. Not allowed with
 *                               agentRuntimeMode=parameter.
 *   agentModelId                Claude model or inference profile id for the agent's MODEL_ID
 *                               (default in cdk.json: Haiku 4.5)
 *   crossAccountModelRoleArn    optional; IAM role in another account the agent assumes to call
 *                               Bedrock. When set, requires crossAccountModelId and replaces
 *                               agentModelId. When unset, the agent uses agentModelId locally.
 *   crossAccountModelId         model or inference profile id in that account
 *   crossAccountModelRegion     optional; Bedrock Region in that account (default: stack Region)
 *   crossAccountModelExternalId optional; ExternalId required by the role's trust policy
 *   memoryPreferenceStrategyId  optional; sets MEMORY_PREFERENCE_STRATEGY_ID
 *   corsAllowOrigins            optional comma-separated origin list (default: the Client_App
 *                               CloudFront origin; e.g. add http://localhost:5173 for development)
 *
 * Synth needs the built Client_App in web/dist; `npm run synth` builds it first.
 */
import { App } from 'aws-cdk-lib';
import { type AgentRuntimeConfig, type CrossAccountModelConfig, SousStack } from '../lib/sousStack.js';

const app = new App();
const context = (key: string): string | undefined => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

function agentRuntime(): AgentRuntimeConfig {
  const mode = context('agentRuntimeMode') ?? 'asset';
  const containerUri = context('agentContainerUri');
  if (mode !== 'asset' && mode !== 'parameter') {
    throw new Error(`agentRuntimeMode must be "asset" or "parameter", got "${mode}"`);
  }
  if (mode === 'parameter') {
    if (containerUri) throw new Error('agentContainerUri cannot be combined with agentRuntimeMode=parameter');
    return { kind: 'parameter' };
  }
  return containerUri ? { kind: 'container', containerUri } : { kind: 'asset' };
}

function crossAccountModel(): CrossAccountModelConfig | undefined {
  const roleArn = context('crossAccountModelRoleArn');
  if (!roleArn) return undefined;
  const modelId = context('crossAccountModelId');
  if (!modelId) throw new Error('crossAccountModelId is required when crossAccountModelRoleArn is set');
  const region = context('crossAccountModelRegion');
  const externalId = context('crossAccountModelExternalId');
  return { roleArn, modelId, ...(region ? { region } : {}), ...(externalId ? { externalId } : {}) };
}

const modelId = context('agentModelId');
const crossModel = crossAccountModel();
const strategyId = context('memoryPreferenceStrategyId');
const origins = context('corsAllowOrigins');
new SousStack(app, 'Sous', {
  description: 'Sous meal planner',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  agentRuntime: agentRuntime(),
  ...(modelId ? { agentModelId: modelId } : {}),
  ...(crossModel ? { crossAccountModel: crossModel } : {}),
  ...(strategyId ? { memoryPreferenceStrategyId: strategyId } : {}),
  ...(origins ? { corsAllowOrigins: origins.split(',').map((o) => o.trim()) } : {}),
});
