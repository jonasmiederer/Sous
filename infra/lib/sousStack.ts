/**
 * Sous: the complete AWS deployment (Requirements 8.1, 8.2, 8.5, 10.5, 11.7).
 *
 *   Cognito User Pool + app client (USER_PASSWORD_AUTH)       identity
 *   API Gateway HTTP API + Cognito JWT authorizer             API edge
 *   Orchestration Lambdas (one per service; voice is a container image with ffmpeg) compute
 *   DynamoDB single table (GSI1, GSI2, sparse GSI3, TTL, PITR) persistence
 *   S3 audio bucket (Household-prefixed keys, lifecycle expiry) voice audio
 *   EventBridge bus + MealPlanChanged rule -> grocery consumer list regeneration
 *   EventBridge Scheduler (hourly) -> invitation expiry sweep  invitation expiry
 *   Bedrock AgentCore Memory (+ Runtime, see AgentRuntimeConfig) Suggestion_Agent
 *   Private S3 web bucket + CloudFront (OAC, HTTPS, SPA rewrite, security headers) Client_App
 *
 * Every Lambda gets only the IAM actions its code calls, on the specific
 * resources it uses. See infra/README.md for deploy-time configuration.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CfnOutput,
  CfnParameter,
  Duration,
  IgnoreMode,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_bedrockagentcore as agentcore,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_ecr_assets as ecrAssets,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_destinations as destinations,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_scheduler as scheduler,
  aws_scheduler_targets as schedulerTargets,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { GSI1_NAME, GSI2_NAME, GSI3_NAME } from '../../src/data/keys.js';
import { MEAL_PLAN_CHANGED_DETAIL_TYPE, MEAL_PLAN_CHANGED_SOURCE } from '../../src/services/plans/events.js';
import { VOICE_TTL_ATTRIBUTE } from '../../src/services/voice/service.js';
import { projectRoot } from './projectRoot.js';

/** How the stack obtains the Suggestion_Agent's AgentCore Runtime. */
export type AgentRuntimeConfig =
  /** Build agent/Dockerfile as a CDK image asset and create the AgentCore Runtime from it (default). */
  | { kind: 'asset' }
  /** Create an AgentCore Runtime from a container image already pushed to ECR. */
  | { kind: 'container'; containerUri: string }
  /** Use an existing runtime whose ARN is supplied as the `AgentRuntimeArn` stack parameter at deploy time. */
  | { kind: 'parameter' };

export interface CrossAccountModelConfig {
  /** IAM role in the model account that allows Bedrock invocation and trusts the agent runtime role. */
  roleArn: string;
  /** Claude model or inference profile id available in the model account. */
  modelId: string;
  /** Bedrock Region in the model account. Defaults to the stack Region. */
  region?: string;
  /** Optional ExternalId required by the role's trust policy. */
  externalId?: string;
}

const IAM_ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/;

export interface SousStackProps extends StackProps {
  /** Defaults to `{ kind: 'asset' }`. */
  agentRuntime?: AgentRuntimeConfig;
  /**
   * Bedrock model or inference profile id the Suggestion_Agent calls (`MODEL_ID`).
   * Must be an Anthropic Claude id. Defaults to {@link DEFAULT_AGENT_MODEL_ID}.
   * Ignored in `parameter` mode, where the stack does not create the runtime.
   */
  agentModelId?: string;
  /**
   * Optional: call the model in another AWS account. When set, the agent
   * assumes `roleArn` for Bedrock calls and uses `modelId` (in `region`,
   * default: this stack's Region) instead of `agentModelId`. When omitted, the
   * agent calls `agentModelId` (default Haiku 4.5) in this account.
   * Ignored in `parameter` mode.
   */
  crossAccountModel?: CrossAccountModelConfig;
  /** Long-term preference strategy id of the AgentCore Memory, once known (not exposed by CloudFormation). */
  memoryPreferenceStrategyId?: string;
  /**
   * Allowed CORS origins for the HTTP API. Defaults to the CloudFront origin of
   * the Client_App (`https://{distributionDomainName}`). Override to add, for
   * example, `http://localhost:5173` for local development.
   */
  corsAllowOrigins?: string[];
  /**
   * Optional custom domain for the Client_App CloudFront distribution. The
   * certificate must be an ACM certificate in us-east-1 covering the domain.
   * DNS (an alias record to the distribution) is managed outside this stack.
   * The domain is added to the default CORS origins.
   */
  customDomain?: { domainName: string; certificateArn: string };
  /**
   * Directory of the built Client_App, absolute or relative to the repository
   * root. Defaults to `web/dist`. Must contain `index.html`.
   */
  webAssetPath?: string;
}

/** Default Client_App build output, relative to the repository root. */
const DEFAULT_WEB_ASSET_PATH = 'web/dist';
/** Files that must always be revalidated: the shell, the runtime config, the service worker, the manifest. */
const WEB_INVALIDATION_PATHS = ['/index.html', '/config.json', '/sw.js', '/manifest.webmanifest'];

/**
 * CloudFront Function (viewer request): serves the SPA shell for in-app paths
 * (Requirement 13.20). Paths under /assets/ and /icons/, and any path whose last
 * segment has a file extension (sw.js, manifest.webmanifest, config.json, ...),
 * are left alone so missing files still return real errors.
 */
export const SPA_REWRITE_FUNCTION_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf('/assets/') === 0 || uri.indexOf('/icons/') === 0) return request;
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') !== -1) return request;
  request.uri = '/index.html';
  return request;
}`;

const LAMBDA_RUNTIME = lambda.Runtime.NODEJS_22_X;

/** DynamoDB item-level actions used by DocumentTableClient (Get, Put, Delete, Query, TransactWrite). */
const TABLE_ACTIONS = [
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:DeleteItem',
  'dynamodb:Query',
  'dynamodb:ConditionCheckItem',
];

/** AgentCore Memory data-plane actions used by AgentCoreMemoryClient. */
const MEMORY_CLIENT_ACTIONS = [
  'bedrock-agentcore:CreateEvent',
  'bedrock-agentcore:ListEvents',
  'bedrock-agentcore:ListMemoryRecords',
  'bedrock-agentcore:RetrieveMemoryRecords',
  'bedrock-agentcore:BatchCreateMemoryRecords',
];

/** Dockerfile of the Voice Lambda image, relative to the repository root (the build context). */
const VOICE_DOCKERFILE = 'infra/docker/voice/Dockerfile';
/** Where the Voice image installs the static ffmpeg binary. */
const VOICE_FFMPEG_PATH = '/opt/bin/ffmpeg';
/**
 * Docker-style allowlist for the Voice image build context: only what `npm ci`
 * and the esbuild bundle need. Everything else (node_modules, cdk.out, dist,
 * web, agent, .git, .kiro, tests) is left out, so changes there neither enter
 * the image nor change its asset hash.
 */
const VOICE_IMAGE_EXCLUDE = [
  '*',
  '!package.json',
  '!package-lock.json',
  '!tsconfig.json',
  '!src',
  '!infra/docker/voice/Dockerfile',
  'src/**/*.test.ts',
  '**/.gitkeep',
];

/** Dockerfile of the Suggestion_Agent image, relative to the repository root (the build context). */
const AGENT_DOCKERFILE = 'agent/Dockerfile';
/**
 * Docker-style allowlist for the Suggestion_Agent build context: what
 * agent/Dockerfile copies (root package files, tsconfig, src, agent/src).
 * This leaves out node_modules, web, cdk.out, dist, .git, .kiro, coverage and
 * the voice image, so changes there neither enter the image nor change its hash.
 */
const AGENT_IMAGE_EXCLUDE = [
  '*',
  '!package.json',
  '!package-lock.json',
  '!tsconfig.json',
  '!src',
  '!agent/src',
  '!agent/Dockerfile',
  'src/**/*.test.ts',
  'agent/**/*.test.ts',
  '**/.gitkeep',
];

/**
 * Default model: Claude Haiku 4.5 through the global cross-Region inference
 * profile, used when no cross-account model is configured. Haiku 5.5 (the
 * design.md "Model" choice) is not enabled in every account, so it is only
 * used through `crossAccountModel`. The agent sends `thinking: disabled` for
 * Haiku 5.5 only.
 */
export const DEFAULT_AGENT_MODEL_ID = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
/**
 * An Anthropic Claude or Amazon Nova foundation model id, optionally prefixed
 * by an inference-profile scope. (Name kept for history; Nova is allowed for testing.)
 */
const CLAUDE_MODEL_ID = /^(?:[a-z]{2,6}\.)?(?:anthropic\.claude-|amazon\.nova-)[a-z0-9.-]+(?::\d+)?$/;

const ECR_URI = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/([a-z0-9._/-]+)[:@].+$/;

export class SousStack extends Stack {
  constructor(scope: Construct, id: string, props: SousStackProps = {}) {
    super(scope, id, props);
    const root = projectRoot();
    const webAssetPath = resolve(root, props.webAssetPath ?? DEFAULT_WEB_ASSET_PATH);
    if (!existsSync(join(webAssetPath, 'index.html'))) {
      throw new Error(
        `Client_App build not found: ${webAssetPath} has no index.html. Run "npm run build:web" first, ` +
          'or pass webAssetPath pointing at a built Client_App.',
      );
    }

    // ---------------------------------------------------------------------
    // Persistence
    // ---------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'Table', {
      tableName: 'sous-table',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // SUGGESTION#, VOICE# and LOCKOUT# items carry an epoch-seconds `ttl`.
      timeToLiveAttribute: VOICE_TTL_ATTRIBUTE,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // GSI1: a user's Households (reads GSI1SK only).
    table.addGlobalSecondaryIndex({
      indexName: GSI1_NAME,
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    // GSI2: invitation id -> owning Household (reads PK only).
    table.addGlobalSecondaryIndex({
      indexName: GSI2_NAME,
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    // GSI3: sparse index of pending invitations ordered by expiry (expiry sweep).
    table.addGlobalSecondaryIndex({
      indexName: GSI3_NAME,
      partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI3SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['invitationId'],
    });

    const audioBucket = new s3.Bucket(this, 'AudioBucket', {
      // SSE-S3 matches the AES256 header S3AudioStore sends on every PutObject.
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [
        { id: 'expire-voice-audio', prefix: 'households/', expiration: Duration.days(1) },
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------------
    // Identity
    // ---------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'sous-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      // Requirement 1.1: passwords of 8 to 128 characters. Cognito enforces the
      // minimum; the 128 maximum is enforced by the login service. No
      // character-class rules, so every 8-128 character password is allowed.
      passwordPolicy: {
        minLength: 8,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: 'sous-web',
      // ALLOW_USER_PASSWORD_AUTH + ALLOW_REFRESH_TOKEN_AUTH. The 5-in-15-minutes
      // lockout is enforced by the login service (LOCKOUT# items).
      authFlows: { userPassword: true },
      generateSecret: false,
      disableOAuth: true,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // ---------------------------------------------------------------------
    // Events and dead-letter queue
    // ---------------------------------------------------------------------
    const bus = new events.EventBus(this, 'EventBus', { eventBusName: 'sous-events' });
    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: 'sous-dlq',
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    // ---------------------------------------------------------------------
    // Bedrock AgentCore
    // ---------------------------------------------------------------------
    // Short-term events: actorId = householdId, sessionId = conversationId.
    // Long-term preference records land in namespace `{actorId}`, which is
    // exactly `{householdId}`: shared by all members, isolated per Household.
    const memory = new agentcore.CfnMemory(this, 'Memory', {
      name: 'sous_memory',
      description: 'Sous conversation turns (short-term) and household preference memory (long-term).',
      eventExpiryDuration: 30,
      memoryStrategies: [
        {
          userPreferenceMemoryStrategy: {
            name: 'HouseholdPreferences',
            description: 'Free-form household likes, dislikes and favourites; soft bias only.',
            namespaces: ['{actorId}'],
          },
        },
      ],
    });
    const agentRuntimeArn = this.agentRuntime(props.agentRuntime ?? { kind: 'asset' }, memory, {
      modelId: props.crossAccountModel?.modelId ?? props.agentModelId ?? DEFAULT_AGENT_MODEL_ID,
      ...(props.crossAccountModel ? { crossAccountModel: props.crossAccountModel } : {}),
      ...(props.memoryPreferenceStrategyId ? { memoryPreferenceStrategyId: props.memoryPreferenceStrategyId } : {}),
    });

    // ---------------------------------------------------------------------
    // Lambdas
    // ---------------------------------------------------------------------
    const fn = (name: string, entry: string, options: Partial<nodejs.NodejsFunctionProps> & { timeout: Duration }) =>
      new nodejs.NodejsFunction(this, name, {
        entry: join(root, entry),
        projectRoot: root,
        depsLockFilePath: join(root, 'package-lock.json'),
        runtime: LAMBDA_RUNTIME,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: {
          format: nodejs.OutputFormat.ESM,
          target: 'node22',
          minify: true,
          sourceMap: true,
          mainFields: ['module', 'main'],
          // Bundle the AWS SDK too: the runtime's built-in SDK may predate the
          // Bedrock AgentCore client, and bundling pins versions to the lockfile.
          externalModules: [],
          // Lets CommonJS dependencies inside the ESM bundle call require().
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        },
        ...options,
        environment: {
          NODE_OPTIONS: '--enable-source-maps',
          TABLE_NAME: table.tableName,
          ...options.environment,
        },
      });

    const agentEnv: Record<string, string> = {
      AGENT_RUNTIME_ARN: agentRuntimeArn,
      MEMORY_ID: memory.attrMemoryId,
      ...(props.memoryPreferenceStrategyId ? { MEMORY_PREFERENCE_STRATEGY_ID: props.memoryPreferenceStrategyId } : {}),
    };

    const auth = fn('AuthFunction', 'src/services/auth/lambda.ts', {
      timeout: Duration.seconds(10),
      environment: { COGNITO_CLIENT_ID: userPoolClient.userPoolClientId },
    });
    const suggestions = fn('SuggestionsFunction', 'src/services/suggestions/lambda.ts', {
      timeout: Duration.seconds(15),
      environment: agentEnv,
    });
    const plans = fn('PlansFunction', 'src/services/plans/lambda.ts', {
      timeout: Duration.seconds(35),
      environment: { ...agentEnv, EVENT_BUS_NAME: bus.eventBusName },
    });
    const conversations = fn('ConversationsFunction', 'src/services/conversations/lambda.ts', {
      timeout: Duration.seconds(20),
      environment: { ...agentEnv, EVENT_BUS_NAME: bus.eventBusName },
    });
    // The Voice Lambda is a container image so it can ship a static ffmpeg for
    // WebM/MP4 conversion (Requirement 14.5). See infra/docker/voice/Dockerfile.
    // CDK only stages the build context at synth; Docker runs at deploy time.
    const voice = new lambda.DockerImageFunction(this, 'VoiceFunction', {
      code: lambda.DockerImageCode.fromImageAsset(root, {
        file: VOICE_DOCKERFILE,
        platform: ecrAssets.Platform.LINUX_ARM64,
        ignoreMode: IgnoreMode.DOCKER,
        exclude: VOICE_IMAGE_EXCLUDE,
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(20),
      logGroup: new logs.LogGroup(this, 'VoiceFunctionLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        TABLE_NAME: table.tableName,
        ...agentEnv,
        EVENT_BUS_NAME: bus.eventBusName,
        AUDIO_BUCKET_NAME: audioBucket.bucketName,
        FFMPEG_PATH: VOICE_FFMPEG_PATH,
      },
    });
    const preferences = fn('PreferencesFunction', 'src/services/preferences/lambda.ts', {
      timeout: Duration.seconds(10),
    });
    const fridge = fn('FridgeFunction', 'src/services/fridge/lambda.ts', { timeout: Duration.seconds(10) });
    const grocery = fn('GroceryFunction', 'src/services/grocery/lambda.ts', { timeout: Duration.seconds(30) });
    const groceryConsumer = fn('GroceryRegenerationFunction', 'src/services/grocery/lambda.ts', {
      handler: 'mealPlanChangedHandler',
      timeout: Duration.seconds(60),
      retryAttempts: 2,
      onFailure: new destinations.SqsDestination(dlq),
    });
    const expirySweep = fn('InvitationExpirySweepFunction', 'src/services/auth/expirySweepLambda.ts', {
      timeout: Duration.minutes(5),
    });

    // ---------------------------------------------------------------------
    // Least-privilege grants
    // ---------------------------------------------------------------------
    const tableResources = [table.tableArn, `${table.tableArn}/index/*`];
    for (const f of [auth, suggestions, plans, conversations, voice, preferences, fridge, grocery, groceryConsumer]) {
      f.addToRolePolicy(new iam.PolicyStatement({ actions: TABLE_ACTIONS, resources: tableResources }));
    }
    // The sweep reads GSI3 and rewrites invitation items; nothing else.
    expirySweep.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [`${table.tableArn}/index/${GSI3_NAME}`] }),
    );
    expirySweep.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem'], resources: [table.tableArn] }),
    );

    for (const f of [suggestions, plans, conversations, voice]) {
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:InvokeAgentRuntime'],
          resources: [agentRuntimeArn, `${agentRuntimeArn}/runtime-endpoint/*`],
        }),
      );
      f.addToRolePolicy(new iam.PolicyStatement({ actions: MEMORY_CLIENT_ACTIONS, resources: [memory.attrMemoryArn] }));
    }
    for (const f of [plans, conversations, voice]) bus.grantPutEventsTo(f);

    // StartStreamTranscription does not support resource-level permissions.
    voice.addToRolePolicy(new iam.PolicyStatement({ actions: ['transcribe:StartStreamTranscription'], resources: ['*'] }));
    voice.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [audioBucket.arnForObjects('households/*')] }),
    );
    // The auth Lambda calls only cognito-idp:InitiateAuth (USER_PASSWORD_AUTH),
    // a public app-client API that needs no IAM permission.

    // ---------------------------------------------------------------------
    // MealPlanChanged -> grocery regeneration; hourly invitation expiry sweep
    // ---------------------------------------------------------------------
    new events.Rule(this, 'MealPlanChangedRule', {
      eventBus: bus,
      eventPattern: { source: [MEAL_PLAN_CHANGED_SOURCE], detailType: [MEAL_PLAN_CHANGED_DETAIL_TYPE] },
      targets: [
        new eventTargets.LambdaFunction(groceryConsumer, {
          deadLetterQueue: dlq,
          retryAttempts: 4,
          maxEventAge: Duration.hours(2),
        }),
      ],
    });

    new scheduler.Schedule(this, 'InvitationExpirySchedule', {
      scheduleName: 'sous-invitation-expiry-sweep',
      description: 'Sets pending Invitations to expired once their 7-day expiry has passed (Requirement 10.5).',
      schedule: scheduler.ScheduleExpression.rate(Duration.hours(1)),
      target: new schedulerTargets.LambdaInvoke(expirySweep, {
        retryAttempts: 2,
        maxEventAge: Duration.hours(1),
        deadLetterQueue: dlq,
      }),
    });

    // ---------------------------------------------------------------------
    // Client_App hosting (Requirements 13.2, 13.20)
    // ---------------------------------------------------------------------
    // Private bucket; only the distribution can read it (Origin Access Control).
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // connect-src uses the regional execute-api wildcard rather than the exact
    // API URL: the API's CORS origin references this distribution, so the
    // distribution cannot also reference the API without a dependency cycle.
    const contentSecurityPolicy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' https://*.execute-api.${this.region}.${this.urlSuffix} https://cognito-idp.${this.region}.${this.urlSuffix}`,
      "worker-src 'self'",
      "manifest-src 'self'",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    const webHeaders = new cloudfront.ResponseHeadersPolicy(this, 'WebResponseHeaders', {
      comment: 'Sous Client_App security headers.',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(63_072_000),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()', override: true },
        ],
      },
    });
    const spaRewrite = new cloudfront.Function(this, 'WebSpaRewrite', {
      comment: 'Serve /index.html for in-app paths without a file extension.',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(SPA_REWRITE_FUNCTION_CODE),
    });
    // Like CachingOptimized but with a zero minimum TTL, so `no-cache` objects
    // (index.html, config.json, sw.js, manifest) are revalidated on every request.
    const webCachePolicy = new cloudfront.CachePolicy(this, 'WebCachePolicy', {
      comment: 'Sous Client_App: honours origin Cache-Control.',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.days(1),
      maxTtl: Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      comment: 'Sous Client_App',
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      ...(props.customDomain
        ? {
            domainNames: [props.customDomain.domainName],
            certificate: acm.Certificate.fromCertificateArn(this, 'WebCertificate', props.customDomain.certificateArn),
          }
        : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: webCachePolicy,
        responseHeadersPolicy: webHeaders,
        compress: true,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
    });
    const webOrigin = `https://${distribution.distributionDomainName}`;

    // ---------------------------------------------------------------------
    // HTTP API
    // ---------------------------------------------------------------------
    const api = new apigw.HttpApi(this, 'HttpApi', {
      apiName: 'sous-api',
      defaultAuthorizer: new authorizers.HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
        userPoolClients: [userPoolClient],
      }),
      corsPreflight: {
        allowOrigins:
          props.corsAllowOrigins ??
          (props.customDomain ? [webOrigin, `https://${props.customDomain.domainName}`] : [webOrigin]),
        allowHeaders: ['authorization', 'content-type', 'x-active-household'],
        // The client reads retry-after for the sign-in lockout message.
        exposeHeaders: ['retry-after'],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        maxAge: Duration.hours(1),
      },
    });
    const { GET, POST, PUT, DELETE } = apigw.HttpMethod;
    const routes: Array<[lambda.IFunction, apigw.HttpMethod, string]> = [
      [auth, GET, '/households'],
      [auth, GET, '/households/{id}/members'],
      [auth, POST, '/households'],
      [auth, POST, '/households/{id}/invitations'],
      [auth, POST, '/invitations/{id}/accept'],
      [auth, POST, '/invitations/{id}/decline'],
      [auth, DELETE, '/households/{id}/members/{userId}'],
      [auth, PUT, '/session/active-household'],
      [suggestions, POST, '/suggestions'],
      [plans, GET, '/plans'],
      [plans, GET, '/plans/{id}'],
      [plans, POST, '/plans'],
      [plans, PUT, '/plans/{id}/days/{day}'],
      [plans, POST, '/plans/{id}/days'],
      [plans, DELETE, '/plans/{id}/days/{day}'],
      [grocery, GET, '/plans/{id}/grocery-list'],
      [grocery, POST, '/plans/{id}/grocery-list'],
      [preferences, GET, '/preferences'],
      [preferences, POST, '/preferences/feedback'],
      [preferences, POST, '/preferences/acceptances'],
      [preferences, POST, '/preferences/constraints'],
      [fridge, GET, '/fridge'],
      [fridge, PUT, '/fridge'],
      [conversations, POST, '/conversations'],
      [conversations, POST, '/conversations/{id}/messages'],
      [voice, POST, '/voice'],
      [voice, POST, '/voice/{id}/confirm'],
    ];
    const integrationsByFn = new Map<lambda.IFunction, integrations.HttpLambdaIntegration>();
    const integrationFor = (f: lambda.IFunction) => {
      let integration = integrationsByFn.get(f);
      if (integration === undefined) {
        integration = new integrations.HttpLambdaIntegration(`${f.node.id}Integration`, f);
        integrationsByFn.set(f, integration);
      }
      return integration;
    };
    for (const [f, method, path] of routes) api.addRoutes({ path, methods: [method], integration: integrationFor(f) });
    // The only unauthenticated route.
    api.addRoutes({
      path: '/auth/login',
      methods: [POST],
      integration: integrationFor(auth),
      authorizer: new apigw.HttpNoneAuthorizer(),
    });

    // ---------------------------------------------------------------------
    // Client_App files. Hashed assets are immutable; everything else, plus
    // the runtime config.json, is no-cache and invalidated on each deploy.
    // prune: false keeps old hashed assets for clients that are mid-update.
    // ---------------------------------------------------------------------
    const hashedAssets = join(webAssetPath, 'assets');
    const assetsDeployment = existsSync(hashedAssets)
      ? new s3deploy.BucketDeployment(this, 'WebAssetsDeployment', {
          sources: [s3deploy.Source.asset(hashedAssets)],
          destinationBucket: webBucket,
          destinationKeyPrefix: 'assets/',
          cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
          prune: false,
          memoryLimit: 512,
        })
      : undefined;
    const shellDeployment = new s3deploy.BucketDeployment(this, 'WebShellDeployment', {
      sources: [
        // config.json is excluded so a local development copy in web/public
        // (copied into web/dist by Vite) never shadows the generated one.
        s3deploy.Source.asset(webAssetPath, { exclude: ['assets', 'assets/**', 'config.json'] }),
        // The web RuntimeConfig (web/src/config/runtimeConfig.ts); apiEndpoint has no trailing slash.
        s3deploy.Source.jsonData('config.json', {
          apiUrl: api.apiEndpoint,
          region: this.region,
          userPoolId: userPool.userPoolId,
          userPoolClientId: userPoolClient.userPoolClientId,
        }),
      ],
      destinationBucket: webBucket,
      cacheControl: [s3deploy.CacheControl.noCache()],
      prune: false,
      memoryLimit: 512,
      distribution,
      distributionPaths: WEB_INVALIDATION_PATHS,
    });
    // Upload hashed assets before the shell that references them.
    if (assetsDeployment) shellDeployment.node.addDependency(assetsDeployment);

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new CfnOutput(this, 'WebUrl', { value: webOrigin });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'AudioBucketName', { value: audioBucket.bucketName });
    new CfnOutput(this, 'EventBusName', { value: bus.eventBusName });
    new CfnOutput(this, 'MemoryId', { value: memory.attrMemoryId });
    new CfnOutput(this, 'AgentRuntimeArnOutput', { value: agentRuntimeArn });
  }

  /**
   * Returns the Suggestion_Agent runtime ARN. In `asset` and `container` mode
   * the stack creates the AgentCore Runtime and its execution role; in
   * `parameter` mode it takes the ARN of an existing runtime.
   */
  private agentRuntime(
    config: AgentRuntimeConfig,
    memory: agentcore.CfnMemory,
    agent: { modelId: string; crossAccountModel?: CrossAccountModelConfig; memoryPreferenceStrategyId?: string },
  ): string {
    if (config.kind === 'parameter') {
      return new CfnParameter(this, 'AgentRuntimeArn', {
        type: 'String',
        description: 'ARN of the existing Bedrock AgentCore Runtime hosting the Suggestion_Agent.',
        allowedPattern: '^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\\d{12}:runtime/[A-Za-z0-9_-]+$',
      }).valueAsString;
    }
    if (!CLAUDE_MODEL_ID.test(agent.modelId)) {
      throw new Error(
        `agentModelId must be an Anthropic Claude or Amazon Nova model or inference profile id, got "${agent.modelId}"`,
      );
    }

    const cross = agent.crossAccountModel;
    if (cross && !IAM_ROLE_ARN.test(cross.roleArn)) {
      throw new Error(`crossAccountModel.roleArn must be an IAM role ARN, got "${cross.roleArn}"`);
    }

    const role = new iam.Role(this, 'AgentRuntimeRole', {
      description: 'Execution role of the Sous Suggestion_Agent AgentCore Runtime.',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
    });

    let containerUri: string;
    if (config.kind === 'asset') {
      // CDK stages the build context at synth; Docker builds and pushes the
      // ARM64 image at deploy (asset publishing) time.
      const image = new ecrAssets.DockerImageAsset(this, 'SuggestionAgentImage', {
        directory: projectRoot(),
        file: AGENT_DOCKERFILE,
        platform: ecrAssets.Platform.LINUX_ARM64,
        ignoreMode: IgnoreMode.DOCKER,
        exclude: AGENT_IMAGE_EXCLUDE,
      });
      image.repository.grantPull(role);
      containerUri = image.imageUri;
    } else {
      const match = ECR_URI.exec(config.containerUri);
      if (match === null) throw new Error(`agentContainerUri must be an ECR image URI, got "${config.containerUri}"`);
      const [, account, region, repository] = match;
      role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
          resources: [`arn:${this.partition}:ecr:${region}:${account}:repository/${repository}`],
        }),
      );
      containerUri = config.containerUri;
    }

    // Anthropic Claude only. Cross-Region (geo and global) inference profiles
    // route to foundation models in other Regions, so the foundation-model
    // resource keeps a Region wildcard (global profiles use an empty Region).
    if (cross) {
      // Model calls go through the role in the model account; that account's
      // role carries the Bedrock permissions.
      role.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [cross.roleArn] }));
    } else {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:${this.partition}:bedrock:*::foundation-model/anthropic.claude-*`,
            `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*anthropic.claude-*`,
            `arn:${this.partition}:bedrock:*::foundation-model/amazon.nova-*`,
            `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*amazon.nova-*`,
          ],
        }),
      );
    }
    // The agent only reads Memory: short-term turns are written by the
    // orchestration Lambdas (Requirement 12.11).
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:RetrieveMemoryRecords', 'bedrock-agentcore:ListMemoryRecords'],
        resources: [memory.attrMemoryArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [
          `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        ],
      }),
    );

    // MMDSv2: the AgentCore control-plane API has `metadataConfiguration.requireMMDSV2`
    // (required for invocations from June 30, 2026), but neither CfnRuntime in
    // aws-cdk-lib 2.275.0 nor the AWS::BedrockAgentCore::Runtime CloudFormation
    // schema exposes it yet, so it is not set here. See infra/README.md.
    const runtime = new agentcore.CfnRuntime(this, 'SuggestionAgentRuntime', {
      agentRuntimeName: 'sous_suggestion_agent',
      description: 'Sous Suggestion_Agent (meal suggestions, plans and chat refinement).',
      roleArn: role.roleArn,
      agentRuntimeArtifact: { containerConfiguration: { containerUri } },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      environmentVariables: {
        MEMORY_ID: memory.attrMemoryId,
        ...(agent.memoryPreferenceStrategyId ? { MEMORY_PREFERENCE_STRATEGY_ID: agent.memoryPreferenceStrategyId } : {}),
        MODEL_ID: agent.modelId,
        BEDROCK_REGION: cross?.region ?? this.region,
        ...(cross ? { MODEL_ROLE_ARN: cross.roleArn } : {}),
        ...(cross?.externalId ? { MODEL_ROLE_EXTERNAL_ID: cross.externalId } : {}),
      },
    });
    // The role's policy (image pull, model, memory, logs) must exist before the runtime starts.
    runtime.node.addDependency(role);
    return runtime.attrAgentRuntimeArn;
  }
}
