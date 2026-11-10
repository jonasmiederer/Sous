<p align="center">
  <img src="web/public/icons/icon-192.png" alt="Sous logo" width="120" height="120">
</p>

# Sous

A meal planner for households, built entirely on AWS. Ask for ad hoc meal suggestions or a full week plan, tell Sous what is in the fridge and what you feel like, and refine anything by chat or voice. Sous learns the household's preferences ("no coconut", "favourite meal is lasagna") and applies them to the whole household, not just one user.

The Suggestion_Agent runs on Amazon Bedrock AgentCore.

## Features

- Ad hoc suggestions and week plans, with presets (healthy / quick, craving, fine dining)
- Fridge inventory and free-text context as input
- Grocery lists generated from plans
- Chat refinement of suggestions, plan days and grocery lists
- Voice input (fridge, suggestion note, chat). You review and edit the transcript before anything is applied
- Households as tenants: create one, invite other users, switch between households
- Household-level preferences stored in AgentCore Memory, used as a soft bias
- Mobile-first installable web app (PWA)

## Architecture

| Layer | Implementation |
|---|---|
| Client | React 19, Vite, Tailwind v4, TanStack Query, PWA. Hosted on S3 + CloudFront (OAC) |
| Auth | Amazon Cognito. Login goes through the backend so the lockout applies |
| API | API Gateway HTTP API with a Cognito JWT authorizer, one Lambda per service |
| Data | DynamoDB single table, S3 for short-lived audio |
| Agent | TypeScript container on Bedrock AgentCore Runtime, using the Bedrock Converse API (Claude) |
| Memory | AgentCore Memory: short-term conversation turns plus long-term household preferences |
| Voice | Amazon Transcribe. WebM/MP4 recordings are converted to PCM with ffmpeg in the Voice Lambda |
| Events | EventBridge (grocery list regeneration, invitation expiry sweep) |
| IaC | AWS CDK v2 (TypeScript) |

## Repository layout

```
src/      Backend: domain logic, data layer, services (Lambda handlers), voice, agent client
agent/    Suggestion_Agent container (node:http server on 8080, ARM64 Dockerfile)
web/      Client app (npm workspace)
infra/    CDK stack, voice Lambda Dockerfile, infrastructure README
.kiro/specs/meal-planner/   Requirements, design and task list
```

## Prerequisites

- Node.js 20 or newer (22 recommended)
- AWS credentials and a CDK-bootstrapped account/region with Bedrock model access
- Docker with linux/arm64 build support, for `cdk deploy` only. Tests and `synth` do not need it

## Development

```sh
npm install

npm run build        # compile backend and agent (tsc)
npm test             # backend and agent tests (vitest, fast-check)
npm run build:web    # build the web app
npm run test:web     # web app tests
npm run test:all     # both test suites
npm run synth        # build everything, then cdk synth
```

To run the web app locally against a deployed stack, see [Local development](infra/README.md#local-development).

## Deployment

```sh
npm run build && npm run build:web
npx cdk deploy Sous
```

### Releases and CI/CD
Versions follow [semver](https://semver.org). `package.json` and `web/package.json` share one version.
- `.github/workflows/ci.yml` runs typecheck, build, tests and `cdk synth` on pull requests and pushes to `main`.
- `.github/workflows/release.yml` is run manually (Actions > "Release and deploy"). Pick `patch`, `minor` or `major`: it tests, bumps the version (`scripts/bump-version.mjs`), commits, tags `vX.Y.Z`, creates a GitHub release and runs `cdk deploy Sous` with a `Version` stack tag. `none` deploys without bumping.

One-time setup: create a GitHub environment named `production`, add the variables `AWS_DEPLOY_ROLE_ARN` (an IAM role trusting GitHub OIDC for this repo, with permission to assume the CDK bootstrap roles) and `AWS_REGION`. If `main` is branch-protected, allow `github-actions[bot]` to push the version commit.

Useful context keys (`cdk.json` or `-c key=value`): `agentRuntimeMode`, `agentContainerUri`, `agentModelId`, `memoryPreferenceStrategyId`, `corsAllowOrigins`. All are documented in [infra/README.md](infra/README.md).

## Notes

- Plan generation is synchronous and sized for the 30 s API Gateway limit.
- The Voice Lambda image bundles a static ffmpeg build (GPLv3). It is used unmodified as a separate process. See the licence note in [infra/README.md](infra/README.md#voice-lambda-image-and-ffmpeg).
- Specs: [requirements](.kiro/specs/meal-planner/requirements.md), [design](.kiro/specs/meal-planner/design.md), [tasks](.kiro/specs/meal-planner/tasks.md).

## Known limitations

- Chat message length is counted in UTF-16 units on the server and in characters in the app, so emoji-heavy messages can pass the app check and be rejected by the server.
- Signing out clears locally stored grocery checkmarks for all users on that device.
- If the session cannot refresh while offline, the user is signed out.
- Regenerating a grocery list can overwrite edits made through chat.
