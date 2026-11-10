# Sous infrastructure (AWS CDK v2)

`npm run synth` compiles the project (`tsc`), builds the Client_App (`npm run build:web`, output in `web/dist`) and runs `cdk synth` on `dist/infra/bin/sous.js`, producing the `Sous` stack in `cdk.out/`. The stack refuses to synthesize without `web/dist/index.html`, so run `npm run build:web` before calling `npx cdk synth` or `npx cdk deploy` directly. Lambda code is bundled locally with esbuild (ESM, Node.js 22, arm64), including the AWS SDK, so client versions come from `package-lock.json`.

Synth does not need Docker. The Suggestion_Agent and the Voice Lambda are Docker image assets (see below), and CDK only stages their build contexts in `cdk.out/` during synth. `cdk deploy` builds and pushes both images, so deploying needs a running Docker daemon with linux/arm64 build support (native on Apple silicon; on x86 hosts, QEMU emulation through `docker buildx`).

Nothing in this repository deploys. To deploy, run `npm run build && npm run build:web && npx cdk deploy Sous` yourself with credentials and the configuration below, then complete the [MMDSv2 step](#post-deploy-require-mmdsv2-on-the-agent-runtime).

## Configuration

Set context in `cdk.json` or per command with `-c key=value`.

| Context key | Effect |
|---|---|
| `agentRuntimeMode` | `asset` (default in `cdk.json`): build `agent/Dockerfile` as an image asset and create the `AWS::BedrockAgentCore::Runtime` and its execution role from it. `parameter`: create no runtime and take the ARN of an existing one as the **`AgentRuntimeArn` stack parameter** at deploy time (`--parameters AgentRuntimeArn=arn:aws:bedrock-agentcore:...:runtime/...`). Any other value fails synth. |
| `agentContainerUri` | In `asset` mode, use this ECR image URI instead of building the image. The stack still creates the runtime and role, and grants ECR pull on that repository only. Combining it with `agentRuntimeMode=parameter` fails synth. |
| `agentModelId` | The Suggestion_Agent's `MODEL_ID`. Default in `cdk.json`: `global.anthropic.claude-haiku-5-5` (Claude Haiku 5.5 through the global cross-Region inference profile). To keep requests in one geography, use a geo profile, e.g. `-c agentModelId=eu.anthropic.claude-haiku-5-5` (`us.`, `ca.`, `eu.`, `au.`, `jp.`). The agent sends `thinking: {type: disabled}` for Haiku 5.5 ids only, because adaptive thinking is on by default on that model. Synth rejects ids that are not Anthropic Claude models or inference profiles, and the runtime role may invoke only those. Ignored in `parameter` mode. |
| `memoryPreferenceStrategyId` | Sets `MEMORY_PREFERENCE_STRATEGY_ID` on the runtime. CloudFormation does not return strategy ids, so read it after the first deploy (`aws bedrock-agentcore-control get-memory --memory-id <MemoryId output>`) and redeploy with it. It is optional. |
| `corsAllowOrigins` | Comma-separated allowed origins for the HTTP API. Default: the Client_App CloudFront origin only (`WebUrl` output). Setting it **replaces** the default, so include the CloudFront origin when adding others (see [Local development](#local-development)). |

## Suggestion_Agent image and runtime

In `asset` mode the stack builds `agent/Dockerfile` as a `DockerImageAsset` for `linux/arm64` (AgentCore Runtime runs ARM64 containers only), with the repository root as the build context. The context is an allowlist: `package.json`, `package-lock.json`, `tsconfig.json`, `src/`, `agent/src/` and `agent/Dockerfile`, without tests. Changes elsewhere (`web/`, `node_modules/`, `cdk.out/`, the voice image) do not change the image hash. CDK pushes the image to its bootstrap ECR repository on deploy.

The runtime (`sous_suggestion_agent`, public network mode, HTTP protocol) gets `MEMORY_ID`, `MEMORY_PREFERENCE_STRATEGY_ID` (when set), `MODEL_ID` and `BEDROCK_REGION`. Its execution role allows image pull, `bedrock:InvokeModel` and `InvokeModelWithResponseStream` on Anthropic Claude foundation models and inference profiles, `RetrieveMemoryRecords` and `ListMemoryRecords` on the stack's memory (the agent never writes memory), and runtime log delivery.

### Post-deploy: require MMDSv2 on the agent runtime

Since June 30, 2026, AgentCore rejects invocations of runtimes whose `metadataConfiguration.requireMMDSV2` is not `true` ([Troubleshoot AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-troubleshooting.html)). `CfnRuntime` in aws-cdk-lib 2.275.0 and the `AWS::BedrockAgentCore::Runtime` CloudFormation schema do not expose this setting yet, so the stack cannot set it. After a deploy that creates or updates the runtime, set it with `UpdateAgentRuntime`. The CLI marks `--agent-runtime-artifact` and `--role-arn` as required ([update-agent-runtime](https://docs.aws.amazon.com/cli/latest/reference/bedrock-agentcore-control/update-agent-runtime.html)), so the commands below copy the current configuration from `get-agent-runtime` and add only the metadata setting:

```sh
RUNTIME_ARN=$(aws cloudformation describe-stacks --stack-name Sous \
  --query "Stacks[0].Outputs[?OutputKey=='AgentRuntimeArnOutput'].OutputValue" --output text)
RUNTIME_ID=${RUNTIME_ARN##*/}

aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
  --query '{agentRuntimeArtifact: agentRuntimeArtifact, roleArn: roleArn, description: description,
            networkConfiguration: networkConfiguration, protocolConfiguration: protocolConfiguration,
            environmentVariables: environmentVariables}' > runtime-update.json

aws bedrock-agentcore-control update-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
  --cli-input-json file://runtime-update.json \
  --metadata-configuration requireMMDSV2=true

# Check: prints true
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
  --query metadataConfiguration.requireMMDSV2
```

Existing sessions are not affected; new invocations use the setting. Run the check after every `cdk deploy` that changes the runtime, and repeat the update if it prints anything other than `true`. In `parameter` mode the same applies to the runtime you pass in. Remove this step once `CfnRuntime` supports the setting, and set it in `sousStack.ts` instead.

## Client_App hosting

- **Bucket**: private S3 bucket (SSE-S3, all public access blocked, TLS only, retained on stack deletion). Only the CloudFront distribution can read it, through Origin Access Control.
- **Distribution**: HTTP to HTTPS redirect, HTTP/2 and HTTP/3, price class 100. A viewer-request CloudFront Function rewrites in-app paths without a file extension (e.g. `/plans/123`) to `/index.html`, so deep links and reloads work. The cache policy honours the origin's `Cache-Control` with a zero minimum TTL.
- **Security headers** (response headers policy): CSP, HSTS (2 years, subdomains), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy: microphone=(self), camera=(), geolocation=()`. The CSP `connect-src` allows `'self'`, `https://cognito-idp.{region}.amazonaws.com` and `https://*.execute-api.{region}.amazonaws.com`. It uses the execute-api wildcard instead of the exact API URL because the API's CORS default references the distribution's domain; the distribution cannot also reference the API without a CloudFormation dependency cycle. The wildcard is limited to API Gateway endpoints in the stack's Region.
- **Files**: two `BucketDeployment`s. `web/dist/assets/**` (content-hashed) is uploaded first with `Cache-Control: public, max-age=31536000, immutable`. Everything else (`index.html`, `sw.js`, `manifest.webmanifest`, icons) is uploaded with `no-cache`, together with a generated `config.json`, and `/index.html`, `/config.json`, `/sw.js` and `/manifest.webmanifest` are invalidated. Neither deployment prunes, so clients mid-update still find old hashed assets. Any `config.json` inside `web/dist` is ignored.
- **Runtime config**: `config.json` holds `{ apiUrl, region, userPoolId, userPoolClientId }` from this stack's resources (`web/src/config/runtimeConfig.ts`), so one web build works with any stack.
- **CORS**: by default the HTTP API allows only the `WebUrl` origin, with headers `authorization`, `content-type` and `x-active-household`, methods GET, POST, PUT, DELETE and OPTIONS, and `retry-after` exposed so the client can show the sign-in lockout wait.

## Local development

The Vite dev server (`npm run dev -w web`) serves the Client_App at `http://localhost:5173` against a deployed stack:

1. Deploy once, then read the `WebUrl` output (e.g. `https://d1234abcd.cloudfront.net`).
2. Redeploy with both origins allowed, because `corsAllowOrigins` replaces the default:
   ```sh
   npx cdk deploy Sous -c corsAllowOrigins=https://d1234abcd.cloudfront.net,http://localhost:5173
   ```
   To keep the setting, put `"corsAllowOrigins": "https://d1234abcd.cloudfront.net,http://localhost:5173"` in the `context` of `cdk.json` instead. Drop `http://localhost:5173` again for production stacks.
3. Give the dev server the runtime config. The app fetches `/config.json` from its own origin, and Vite serves `web/public/` at the root, so copy the deployed file there (it is git-ignored and never deployed):
   ```sh
   curl -fsS https://d1234abcd.cloudfront.net/config.json -o web/public/config.json
   ```
   Or write it by hand from the `ApiUrl`, `UserPoolId` and `UserPoolClientId` outputs: `{"apiUrl": "https://abc123.execute-api.eu-west-1.amazonaws.com", "region": "eu-west-1", "userPoolId": "eu-west-1_XXXX", "userPoolClientId": "..."}`.
4. Start the dev server on exactly that port. Vite falls back to another port when 5173 is taken, which the API would reject:
   ```sh
   npm run dev -w web -- --strictPort
   ```

The CloudFront CSP does not apply to the dev server. Voice capture needs a secure context; `http://localhost` counts as one in browsers.

AgentCore Memory (`AWS::BedrockAgentCore::Memory`) is always created by the stack. Its user-preference strategy writes to namespace `{actorId}`. Callers use `actorId = householdId` (and `sessionId = conversationId` for short-term events), so long-term records land in exactly `{householdId}`.

## Components

- **Cognito**: user pool (email sign-in, minimum password length 8, no character-class rules; the 128 maximum and the 5-failures-in-15-minutes lockout are enforced in code) and app client `sous-web` with `ALLOW_USER_PASSWORD_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH`, no secret, no OAuth.
- **HTTP API** `sous-api`: Cognito JWT authorizer on every route except `POST /auth/login`. CORS allows the Client_App origin by default (see [Client_App hosting](#client_app-hosting)). Clients should send the **ID token**, because membership and invitation handling read the `email` claim, which access tokens do not carry.
- **Lambdas**: one function per service (auth, suggestions, plans, grocery, preferences, fridge, conversations, voice; voice is a container image with ffmpeg), plus the `MealPlanChanged` grocery consumer and the invitation expiry sweep. Each role grants only the DynamoDB item actions the data layer uses (`GetItem`, `PutItem`, `DeleteItem`, `Query`, `ConditionCheckItem`), `bedrock-agentcore:InvokeAgentRuntime` on the runtime, the memory data-plane actions on the memory, `events:PutEvents` on the bus (plans, conversations, voice), `transcribe:StartStreamTranscription` and `s3:PutObject` on `households/*` (voice). The auth function needs no IAM grant, because `InitiateAuth` is a public app-client API.
- **DynamoDB** `sous-table`: `PK`/`SK`, GSI1 (user → households, keys only), GSI2 (invitation id → household, keys only), GSI3 (sparse pending-invitation index), TTL on `ttl`, PITR, AWS-managed encryption, deletion protection.
- **S3 audio bucket**: SSE-S3, all public access blocked, TLS only, objects under `households/` expire after 1 day.
- **EventBridge**: bus `sous-events`. A rule on `source = sous.plans`, `detail-type = MealPlanChanged` targets the grocery consumer. Failed deliveries and failed async invocations go to the `sous-dlq` queue.
- **EventBridge Scheduler**: `sous-invitation-expiry-sweep` runs hourly.

## Voice Lambda image and ffmpeg

The Voice Lambda is a `DockerImageFunction` (arm64, 1024 MB, 20 s) built from `infra/docker/voice/Dockerfile` with the repository root as the build context. The context is an allowlist: `package.json`, `package-lock.json`, `tsconfig.json`, `src/` (without tests) and the Dockerfile. The build runs three stages:

1. `npm ci` for the root package only, then an esbuild bundle of `src/services/voice/lambda.ts` with the same settings as the other Lambdas.
2. A static arm64 `ffmpeg` binary copied from `mwader/static-ffmpeg:9.0.2-1`, pinned by its index digest, into `/opt/bin/ffmpeg`.
3. `public.ecr.aws/lambda/nodejs:22` (arm64) with the bundle and ffmpeg. `FFMPEG_PATH=/opt/bin/ffmpeg` is set on the function, so WebM and MP4 recordings are converted to 16 kHz mono PCM before transcription. Without `FFMPEG_PATH`, the handler rejects them as `UNSUPPORTED_AUDIO`.

**Licence.** The static-ffmpeg build scripts are MIT. They configure FFmpeg with `--enable-gpl --enable-version3`, so the binary is GPLv3. Sous runs the unmodified binary as a separate process inside its own private Lambda image, and does not link it into its code. The GPL source obligations apply only if the image is distributed to third parties. In that case, provide the FFmpeg 9.0.2 sources and the static-ffmpeg Dockerfile at the pinned tag. No widely published static LGPL arm64 build exists. Moving to LGPL would mean building FFmpeg from source without GPL libraries.

Only a small part of ffmpeg is used, always with the fixed arguments from `ffmpegArgs` in `src/voice/audioConverter.ts`: the `matroska` (WebM) and `mov` (MP4) demuxers, the native Opus and AAC decoders, and `pcm_s16le` output to `pipe:1`, restricted by `-protocol_whitelist file,pipe`. To update ffmpeg, change the tag and the digest together (`docker buildx imagetools inspect mwader/static-ffmpeg:<tag>`).

## Invitation expiry sweep

Creating an invitation writes sparse GSI3 keys (`GSI3PK = INVITE_PENDING`, `GSI3SK = {expiresAt}#{invitationId}`). Accept, decline and the sweep rewrite the item without those keys, so GSI3 holds only pending invitations. Each run does one range query (`GSI3SK < {now}$`), re-reads each candidate from the base table and writes `expired` with `replaceIfVersion`. A concurrent accept or decline changes the version, so the sweep never overwrites it. The job never scans the table, and acceptance time still checks expiry, so a late sweep cannot extend an invitation's life. All pending invitations share one GSI3 partition. Invitation write rates are far below a partition's limits.

Invitations created before GSI3 existed are not in the index. They still cannot be accepted after expiry, because acceptance checks it. Only their stored status stays `pending`.

## Known limits

- HTTP API integrations time out at 30 s. Plan generation stays synchronous and is sized to fit: the Suggestion_Agent generates plans in parallel chunks of at most 4 days within a 26 s budget, and the plan service's agent deadline (`PLAN_DEADLINE_MS`) is 28 s, which leaves about 2 s for the conditional write and the response. Generation still running at 28 s is rejected and nothing is stored, so a plan is never saved after the client has already received a gateway timeout. The 30 s hard cap on any agent invocation is unchanged. The plan function's Lambda timeout stays at 35 s, above both bounds.
