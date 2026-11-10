# Sous cost estimate

Monthly running cost of the deployed stack, in USD, on-demand pricing, before free tiers. Prices for Bedrock, AgentCore and Transcribe come from the AWS Price List API (AWS Pricing MCP server, region `eu-central-1` / Frankfurt, publication dates October to November 2026). Token counts and usage are assumptions, not measurements. Check them against your own bill (Cost Explorer, grouped by service) after a month of real use.

## Prices used (verified)

| Item | Price | Notes |
|---|---|---|
| Claude Haiku 5.5, global inference profile | $0.10 / 1M input tokens, $0.50 / 1M output tokens | Cache read $0.01, cache write (5 min) $0.125 per 1M |
| Claude Haiku 5.5, EU geo profile (`eu.`) | $0.11 / 1M input, $0.55 / 1M output | 10% more than global. Use it if data must stay in the EU |
| Claude Haiku 5.5, long-context requests | 5 times the standard rates (global $0.50 input, $2.50 output) | This app's prompts stay far below the long-context tier |
| AgentCore Runtime (microVM, v1) | $0.0895 per vCPU-hour, $0.00945 per GB-hour | Per second. v2 rates are $0.1276 per vCPU-hour and $0.0169 per GB-hour. The difference is immaterial at this volume |
| AgentCore Memory, short-term | $1.00 per GB ingested, $0.20 per GB read, $0.10 per GB-month stored | Events here are a few KB, so this rounds to zero |
| AgentCore Memory, long-term (built-in strategy) | $0.00075 per record per month stored, $0.0005 per retrieval | |
| Amazon Transcribe streaming | $0.0001667 per second ($0.01 per minute) | |
| Everything else | Standard AWS on-demand rates (Lambda, API Gateway HTTP API, DynamoDB on-demand, S3, CloudFront, ECR, CloudWatch Logs, EventBridge, Cognito) | Not looked up. Small at this volume, rounded estimates |

The agent sends `thinking: {type: disabled}` for Haiku 5.5, because adaptive thinking is on by default and thinking tokens bill as output tokens.

## Usage assumptions (one household, two people)

Per month: 30 ad hoc suggestion requests, 4 week plans, 40 chat refinement turns, 10 voice inputs of about 10 seconds. Each agent call reads long-term memory once (about 150 retrievals) and the household holds about 50 preference records.

| Call | Input tokens | Output tokens | Cost per call (global profile) |
|---|---|---|---|
| Ad hoc suggestions | ~3,000 | ~1,500 | ~$0.001 |
| Week plan (2 chunks of up to 4 days) | ~8,000 | ~6,000 | ~$0.004 |
| Chat refinement turn | ~3,000 | ~1,000 | ~$0.001 |

The input includes the system prompt, household preferences, fridge contents and context. Plans are generated in two chunk calls because of the 4-day chunking (`PLAN_CHUNK_DAYS`), preceded by one small call that picks a distinct dish name per day (about 300 output tokens). One repair call (Property 36) is rare and would add about 5% to 10%. Token counts are my assumptions.

## Scenario 1: one household

| Service | Monthly cost | Basis |
|---|---|---|
| Bedrock (Claude Haiku 5.5) | ~$0.08 | 30 × $0.00105 + 4 × $0.0038 + 40 × $0.0008 |
| AgentCore Runtime | ~$0.01 | ~150 invocations, about 1 s of CPU and 0.5 GB for 30 s each |
| AgentCore Memory | ~$0.12 | 150 retrievals × $0.0005 + 50 records × $0.00075. Short-term events are under $0.01 |
| Transcribe | ~$0.02 | 100 seconds of audio |
| Lambda, API Gateway, EventBridge, Scheduler | ~$0.00 | Inside the free tier or a fraction of a cent. The hourly invitation sweep is about 720 invocations |
| DynamoDB (on-demand) | ~$0.01 | Thousands of small requests |
| S3, CloudFront | ~$0.05 | Small static site |
| ECR | ~$0.10 | Two ARM64 images, storage only |
| CloudWatch Logs | ~$0.10 to $0.50 | Depends on log volume and retention |
| Cognito | $0.00 | Free up to the monthly active user allowance |
| **Total** | **about $0.50 to $0.90** | |

There are no fixed-price components: no NAT gateway, no VPC endpoints, no provisioned capacity, no always-on compute. An idle stack costs close to $0.30 to $0.70 per month (ECR, logs, the hourly sweep, S3).

## Scenario 2: scale

Assuming each household behaves like the one above and keeps about 50 long-term records.

| Households | Bedrock | Runtime | Memory | Transcribe | Other | Total |
|---|---|---|---|---|---|---|
| 1 | $0.08 | $0.01 | $0.12 | $0.02 | $0.26 to $0.66 | ~$0.50 to $0.90 |
| 100 | $8 | $1 | $12 | $2 | $5 to $15 | ~$28 to $38 |
| 1,000 | $80 | $10 | $120 | $20 | $30 to $80 | ~$260 to $310 |

At this model price, AgentCore Memory costs more than the model. Long-term records accumulate over time, so the Memory column grows with the age of the household, not only with usage.

## What moves the bill

1. **Model choice.** At Haiku 5.5 prices the model line is small. A model priced at $3 / $15 per million tokens (Claude Sonnet class) makes it about 30 times higher. Change it with `-c agentModelId=...`.
2. **Memory retrievals.** Each agent call that reads long-term memory costs $0.0005. That is about 5 times the Bedrock cost of a typical suggestion request. Skipping retrieval for requests that don't need household preferences would cut the Memory line the most.
3. **Week plans.** One plan costs as much as about 3 ad hoc requests. Longer plan ranges mean more chunks.
4. **Prompt size and caching.** The preference and fridge context is sent on every call. Cache reads cost a tenth of normal input ($0.01 per 1M), but the agent does not use prompt caching yet and the saving is small at this price.
5. **Thinking.** With thinking enabled, output tokens could be several times higher. The agent disables it for Haiku 5.5.
6. **Retries.** The one-repair limit caps the worst case at about 2 times the model cost for a request.
7. **Geo profiles.** `eu.` profiles cost 10% more than the global profile.
8. **Log retention.** CloudWatch Logs is the main cost that grows with no user activity, if retention is unlimited.
9. **Data transfer.** Not included. CloudFront and API responses here are small.

## How to verify

- Set an AWS Budget alert (for example $10) before the first deploy.
- Tag the stack and group Cost Explorer by service.
- After a week, compare Bedrock input and output token counts (CloudWatch `InputTokenCount` and `OutputTokenCount`) with the table above, and rescale.
- Use the [AWS Pricing Calculator](https://calculator.aws/) for your region and any free-tier credits.
