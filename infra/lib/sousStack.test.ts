import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_MODEL_ID, SPA_REWRITE_FUNCTION_CODE, SousStack, type SousStackProps } from './sousStack.js';

/** A minimal Client_App build, so the tests do not need `npm run build:web`. */
const WEB_FIXTURE = 'infra/test-fixtures/web-dist';

function synth(props: SousStackProps = {}): Template {
  // Skip asset bundling: these tests check wiring, not Lambda bundles.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  return Template.fromStack(new SousStack(app, 'Sous', { webAssetPath: WEB_FIXTURE, ...props }));
}

/** Runs the SPA rewrite CloudFront Function on a URI and returns the rewritten URI. */
function rewrite(uri: string): string {
  const handler = new Function(`${SPA_REWRITE_FUNCTION_CODE}; return handler;`)() as (e: {
    request: { uri: string };
  }) => { uri: string };
  return handler({ request: { uri } }).uri;
}

describe('SousStack', () => {
  let template: Template;
  beforeAll(() => {
    template = synth();
  });

  it('defines the single table with GSIs, TTL, PITR and encryption', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true },
      GlobalSecondaryIndexes: [
        Match.objectLike({ IndexName: 'GSI1' }),
        Match.objectLike({ IndexName: 'GSI2' }),
        Match.objectLike({ IndexName: 'GSI3', Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['invitationId'] } }),
      ],
    });
  });

  it('protects the audio bucket and expires audio', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({}),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ Prefix: 'households/', ExpirationInDays: 1 })]),
      },
    });
  });

  it('configures Cognito for USER_PASSWORD_AUTH and an 8-character minimum', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 8 }) },
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']),
    });
  });

  it('requires the JWT authorizer on every route except POST /auth/login', () => {
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const byKey = Object.fromEntries(
      Object.values(routes).map((r) => [r.Properties.RouteKey as string, r.Properties.AuthorizationType as string]),
    );
    expect(byKey['POST /auth/login']).toBe('NONE');
    const others = Object.entries(byKey).filter(([k]) => k !== 'POST /auth/login');
    expect(others.length).toBe(29);
    for (const [, type] of others) expect(type).toBe('JWT');
    for (const key of [
      'GET /households',
      'GET /households/{id}/members',
      'GET /plans',
      'GET /plans/{id}',
      'GET /plans/{id}/grocery-list',
    ]) {
      expect(byKey[key]).toBe('JWT');
    }
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowHeaders: Match.arrayWith(['x-active-household']),
        ExposeHeaders: ['retry-after'],
      }),
    });
  });

  it('defaults CORS to the distribution origin and honours corsAllowOrigins', () => {
    const [distributionId] = Object.keys(template.findResources('AWS::CloudFront::Distribution'));
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: [{ 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [distributionId, 'DomainName'] }]] }],
      }),
    });
    synth({ corsAllowOrigins: ['http://localhost:5173'] }).hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({ AllowOrigins: ['http://localhost:5173'] }),
    });
  });

  it('serves the Client_App from a private bucket through CloudFront with OAC and HTTPS', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        HttpVersion: 'http2and3',
        Origins: [Match.objectLike({ OriginAccessControlId: Match.anyValue() })],
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          ResponseHeadersPolicyId: Match.anyValue(),
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        }),
      }),
    });
    // The web bucket blocks public access and grants reads only to CloudFront.
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:GetObject',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
          }),
        ]),
      },
    });
    template.hasOutput('WebUrl', {});
  });

  it('sends CSP, HSTS, nosniff, frame denial, referrer and permissions policies', () => {
    const policies = Object.values(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    expect(policies).toHaveLength(1);
    const config = policies[0]!.Properties.ResponseHeadersPolicyConfig;
    const security = config.SecurityHeadersConfig;
    expect(security.StrictTransportSecurity).toMatchObject({ AccessControlMaxAgeSec: 63072000, IncludeSubdomains: true });
    expect(security.ContentTypeOptions).toMatchObject({ Override: true });
    expect(security.FrameOptions).toMatchObject({ FrameOption: 'DENY' });
    expect(security.ReferrerPolicy).toMatchObject({ ReferrerPolicy: 'strict-origin-when-cross-origin' });
    expect(config.CustomHeadersConfig.Items).toEqual([
      { Header: 'Permissions-Policy', Value: 'microphone=(self), camera=(), geolocation=()', Override: true },
    ]);
    const csp = JSON.stringify(security.ContentSecurityPolicy.ContentSecurityPolicy);
    for (const directive of [
      "script-src 'self'",
      "style-src 'self'",
      "worker-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      'https://*.execute-api.',
      'https://cognito-idp.',
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain('unsafe-inline');
  });

  it('rewrites in-app paths to the shell and leaves files alone', () => {
    for (const uri of ['/', '/plans', '/plans/abc/grocery', '/invitations/123e4567-e89b']) {
      expect(rewrite(uri)).toBe('/index.html');
    }
    for (const uri of ['/sw.js', '/config.json', '/manifest.webmanifest', '/assets/index-abc.js', '/assets/x', '/icons/icon']) {
      expect(rewrite(uri)).toBe(uri);
    }
  });

  it('deploys immutable assets and a no-cache shell with config.json and invalidation', () => {
    const deployments = Object.values(template.findResources('Custom::CDKBucketDeployment')).map((r) => r.Properties);
    expect(deployments).toHaveLength(2);
    const assets = deployments.find((d) => d.DestinationBucketKeyPrefix === 'assets/');
    expect(assets).toMatchObject({ Prune: false, SystemMetadata: { 'cache-control': 'public, max-age=31536000, immutable' } });
    const shell = deployments.find((d) => d.DestinationBucketKeyPrefix === undefined);
    expect(shell).toMatchObject({
      Prune: false,
      SystemMetadata: { 'cache-control': 'no-cache' },
      DistributionPaths: ['/index.html', '/config.json', '/sw.js', '/manifest.webmanifest'],
    });
    expect(shell!.SourceMarkers).toHaveLength(2);
  });

  it('fails synth with a clear message when the web build is missing', () => {
    expect(() => synth({ webAssetPath: 'infra/test-fixtures/empty' })).toThrow(/no index\.html.*build:web/);
  });

  it('packages the Voice Lambda as an ARM64 container image with ffmpeg', () => {
    const voice = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (r) => r.Properties.PackageType === 'Image',
    );
    expect(voice).toHaveLength(1);
    const props = voice[0]!.Properties;
    expect(props).toMatchObject({ Architectures: ['arm64'], MemorySize: 1024, Timeout: 20 });
    expect(props.Code.ImageUri).toBeDefined();
    expect(Object.keys(props.Environment.Variables).sort()).toEqual(
      ['AGENT_RUNTIME_ARN', 'AUDIO_BUCKET_NAME', 'EVENT_BUS_NAME', 'FFMPEG_PATH', 'MEMORY_ID', 'NODE_OPTIONS', 'TABLE_NAME'],
    );
    expect(props.Environment.Variables.FFMPEG_PATH).toBe('/opt/bin/ffmpeg');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'transcribe:StartStreamTranscription', Resource: '*' }),
        ]),
      },
    });
  });

  it('routes MealPlanChanged to the grocery consumer and schedules the expiry sweep', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { source: ['sous.plans'], 'detail-type': ['MealPlanChanged'] },
    });
    template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'rate(1 hour)' });
  });

  it('creates AgentCore Memory with a household-namespaced preference strategy', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      MemoryStrategies: [{ UserPreferenceMemoryStrategy: Match.objectLike({ Namespaces: ['{actorId}'] }) }],
    });
  });

  it('creates the AgentCore Runtime from the agent image asset by default', () => {
    const runtimes = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'));
    expect(runtimes).toHaveLength(1);
    const props = runtimes[0]!.Properties;
    // An image asset URI resolves to the CDK assets repository plus the asset hash.
    expect(JSON.stringify(props.AgentRuntimeArtifact.ContainerConfiguration.ContainerUri)).toContain('container-assets');
    expect(Object.keys(props.EnvironmentVariables).sort()).toEqual(['BEDROCK_REGION', 'MEMORY_ID', 'MODEL_ID']);
    expect(props.EnvironmentVariables.MODEL_ID).toBe(DEFAULT_AGENT_MODEL_ID);
    expect(Object.keys(template.toJSON().Parameters ?? {})).not.toContain('AgentRuntimeArn');

    const roleId = Object.keys(template.findResources('AWS::IAM::Role')).find((id) => id.startsWith('AgentRuntimeRole'))!;
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((p) => JSON.stringify(p.Properties.Roles).includes(roleId))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>);
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toEqual(
      expect.arrayContaining([
        'ecr:BatchGetImage',
        'bedrock-agentcore:RetrieveMemoryRecords',
        'bedrock-agentcore:ListMemoryRecords',
      ]),
    );
    expect(actions).not.toContain('bedrock-agentcore:CreateEvent');
    expect(actions).not.toContain('bedrock-agentcore:ListEvents');
    const invoke = statements.find((s) => [s.Action].flat().includes('bedrock:InvokeModel'))!;
    expect(JSON.stringify(invoke.Resource)).toContain('foundation-model/anthropic.claude-*');
    expect(JSON.stringify(invoke.Resource)).toContain('inference-profile/*anthropic.claude-*');
  });

  it('passes agentModelId and the preference strategy id to the runtime and rejects non-Claude/Nova ids', () => {
    const t = synth({ agentModelId: 'eu.anthropic.claude-haiku-5-5', memoryPreferenceStrategyId: 'strat-1' });
    t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        MODEL_ID: 'eu.anthropic.claude-haiku-5-5',
        MEMORY_PREFERENCE_STRATEGY_ID: 'strat-1',
      }),
    });
    // Amazon Nova ids are allowed (e.g. the Nova 2 Lite default used for testing).
    expect(() => synth({ agentModelId: 'amazon.nova-pro-v1:0' })).not.toThrow();
    expect(() => synth({ agentModelId: 'meta.llama3-70b-instruct-v1:0' })).toThrow(/Claude or Amazon Nova/);
  });

  it('takes an existing runtime ARN as a parameter in parameter mode', () => {
    const t = synth({ agentRuntime: { kind: 'parameter' } });
    t.hasParameter('AgentRuntimeArn', { Type: 'String' });
    t.resourceCountIs('AWS::BedrockAgentCore::Runtime', 0);
  });

  it('creates the AgentCore Runtime when a container image is given', () => {
    const t = synth({
      agentRuntime: { kind: 'container', containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/sous-agent:1' },
    });
    t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeArtifact: {
        ContainerConfiguration: { ContainerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/sous-agent:1' },
      },
    });
    expect(() => synth({ agentRuntime: { kind: 'container', containerUri: 'docker.io/agent:1' } })).toThrow(/ECR/);
  });
});
