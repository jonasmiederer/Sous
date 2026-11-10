# Implementation Plan: Meal Planner

## Overview

This plan implements Sous as an AWS-native, TypeScript/Node.js application. It builds bottom-up: shared domain types and the DynamoDB single-table access layer first, then the deterministic pure business logic (grocery consolidation, fridge subtraction, preset validation, exclusion enforcement, invitation lifecycle, tenant scoping) which carries most of the 35 correctness properties, then the AgentCore and Transcribe clients (mocked for property tests), then the per-domain orchestration Lambdas, and finally the API Gateway / Cognito / EventBridge wiring and infrastructure-as-code.

Property-based tests use `fast-check` at a minimum of 100 runs, each tagged `Feature: meal-planner, Property N: ...`. The AgentCore Runtime client and the AgentCore Memory client are mocked for generation and memory-contract properties. Example, integration, and smoke tests cover the non-PBT criteria (Cognito, AgentCore wiring, Transcribe, graceful degradation).

All code is TypeScript. Property-test sub-tasks are marked optional with `*` but SHOULD be implemented alongside the code they verify.

## Tasks

- [x] 1. Set up project scaffolding, domain types, and tooling
  - Initialize a TypeScript Node.js project with AWS SDK v3, a test runner (Vitest or Jest), and `fast-check`
  - Create directory structure: `src/domain`, `src/data`, `src/agent`, `src/services`, `src/voice`, `infra`, `test`
  - Configure a shared fast-check harness that defaults to 100+ runs and a tagging helper for `Feature: meal-planner, Property N: ...`
  - Define core domain types and the ingredient quantity/unit model: `Household`, `Membership`, `Invitation`, `Meal`, `MealPlan`, `MealSuggestion`, `PreferenceProfile`, `HouseholdPreferenceMemoryEntry`, `FridgeInventory`, `GroceryList`, `Conversation`, `Ingredient { name, quantity, unit }`, `GroceryEntry`, `Preset`
  - Define canonical unit compatibility rules (same name + same canonical unit = compatible)
  - _Requirements: 8.1, 8.5_

- [x] 2. Implement the DynamoDB single-table data access layer
  - [x] 2.1 Implement key construction and the Household-scoped repository
    - Implement `PK`/`SK` builders for every entity (`HH#{householdId}` prefix for all tenant data; `USER#`, `MEMBER#`, `INVITE#`, `MEAL#`, `PLAN#`, `SUGGESTION#`, `PREFERENCE_PROFILE`, `PREF_MEMORY#`, `FRIDGE`, `GROCERY#`, `CONVERSATION#`, `META`) and GSI1/GSI2 keys
    - Implement a repository that always constructs queries with the Active_Household as the partition key and never uses cross-partition scans in request paths
    - Implement conditional-write helpers that leave the prior persisted record unchanged on failure and return a save-did-not-complete error
    - _Requirements: 1.4, 8.5, 8.6_

  - [ ]* 2.2 Write property test for tenant data isolation at the storage layer
    - **Property 3: Tenant data isolation** (scoped reads return only the Active_Household's items; non-member access returns an authorization error and no data)
    - **Validates: Requirements 1.4, 1.5, 10.6, 11.6**

  - [ ]* 2.3 Write property test for conditional-write persistence semantics
    - **Property 11: Generated plans are persisted under the requesting Household** (store then read-back yields identical days/Meals under the Household)
    - **Validates: Requirements 3.5**

  - [ ]* 2.4 Write example tests for storage write-failure branches
    - Inject write failures and assert the record remains in its prior persisted state with a save-did-not-complete error (8.6, 6.2)
    - _Requirements: 8.6, 6.2_

- [x] 3. Implement household, membership, and invitation domain logic (pure functions)
  - [x] 3.1 Implement Household creation and membership rules
    - Creating a Household records the creator as both Household_Owner and member; set `preferenceMemoryNamespace = householdId`
    - Implement Active_Household scoping that verifies the authenticated User's membership set contains the target Household
    - Implement member removal that revokes access but rejects removal of the Household_Owner
    - _Requirements: 10.1, 10.6, 10.7, 10.8_

  - [ ]* 3.2 Write property test for Household creation isolation and ownership
    - **Property 29: New Household assigns creator as owner and member and is isolated**
    - **Validates: Requirements 10.1**

  - [ ]* 3.3 Write property test for member removal and owner protection
    - **Property 32: Member removal revokes access but never the owner**
    - **Validates: Requirements 10.7, 10.8**

  - [x] 3.4 Implement the Invitation lifecycle state machine
    - Create pending Invitations with `expiresAt = createdAt + 7 days`, associated with the Household and invitee
    - Acceptance succeeds iff status is pending and expiry has not passed; otherwise return an invalid-invitation error and add no member
    - Implement expiry evaluation (checked both at acceptance time and by the scheduled sweep)
    - _Requirements: 10.2, 10.3, 10.4, 10.5_

  - [ ]* 3.5 Write property test for invitation creation associations
    - **Property 30: Invitations are created pending with correct associations**
    - **Validates: Requirements 10.2**

  - [ ]* 3.6 Write property test for the invitation acceptance lifecycle
    - **Property 31: Invitation acceptance follows the lifecycle** (use generators with ages crossing the 7-day boundary)
    - **Validates: Requirements 10.3, 10.4, 10.5**

- [x] 4. Implement preference, preset, and exclusion domain logic (pure functions)
  - [x] 4.1 Implement Preference_Profile mutations
    - Record like/dislike Feedback and acceptances into the structured profile
    - Validate and store dietary constraints (non-empty, ≤200 chars, not duplicate); reject invalid ones leaving the profile unchanged
    - _Requirements: 6.1, 6.3, 6.5, 6.6_

  - [ ]* 4.2 Write property test for feedback and acceptance recording
    - **Property 18: Feedback and acceptances are recorded in the profile**
    - **Validates: Requirements 6.1, 6.3**

  - [ ]* 4.3 Write property test for dietary constraint validation
    - **Property 20: Valid dietary constraints are stored; invalid ones are rejected** (empty/>200/duplicate rejected, profile unchanged)
    - **Validates: Requirements 6.5, 6.6**

  - [x] 4.4 Implement deterministic exclusion enforcement and preset validation
    - Implement a hard-exclusion filter run in Lambda over returned Meals: drop any Meal with an excluded ingredient or matching a dietary-constraint-excluded item, independent of any soft-memory contents
    - Implement the four named Presets (healthy, quick, craving, fine dining), unrecognized-preset rejection, and conflicting-preset detection
    - _Requirements: 2.2, 3.2, 5.1, 5.5, 5.6, 6.7_

  - [ ]* 4.5 Write property test for exclusion enforcement
    - **Property 7: Exclusions are always honored** (also exercise with arbitrary mocked soft-memory contents to confirm hard exclusions hold regardless of soft bias)
    - **Validates: Requirements 2.2, 3.2, 6.7**

  - [ ]* 4.6 Write property test for preset conflict detection
    - **Property 16: Conflicting presets are rejected; compatible presets proceed** (reject iff jointly unsatisfiable)
    - **Validates: Requirements 5.5**

  - [ ]* 4.7 Write property test for unrecognized presets
    - **Property 17: Unrecognized presets are rejected**
    - **Validates: Requirements 5.6**

  - [ ]* 4.8 Write smoke test for preset configuration
    - Assert exactly four named Presets are configured (5.1)
    - _Requirements: 5.1_

- [x] 5. Implement fridge and grocery-list domain logic (pure functions)
  - [x] 5.1 Implement Fridge_Inventory replacement and ranking
    - Replace the previous inventory with updated items; reject recordings with zero valid items and preserve the prior inventory
    - Implement candidate-Meal ranking so Meals using at least one fridge item rank above Meals using none
    - _Requirements: 4.3, 4.4, 4.5, 4.6_

  - [ ]* 5.2 Write property test for fridge update replace/persist semantics
    - **Property 14: Fridge update replaces and persists** (valid non-empty replaces exactly; zero-item recording rejected, prior inventory unchanged)
    - **Validates: Requirements 4.3, 4.4, 4.6**

  - [ ]* 5.3 Write property test for fridge-using Meal ranking
    - **Property 15: Fridge-using Meals rank above non-fridge Meals**
    - **Validates: Requirements 4.5**

  - [x] 5.4 Implement grocery-list consolidation and fridge subtraction
    - Build a list covering every ingredient of every Meal in the plan
    - Sum occurrences that share name + compatible unit; keep incompatible-unit occurrences as separate entries
    - Subtract matching (name + compatible unit) Fridge_Inventory quantities and omit fully-covered ingredients
    - Return an empty list for a plan with zero Meals; associate the list with the plan and Household
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.7_

  - [ ]* 5.5 Write property test for grocery-list coverage
    - **Property 21: Grocery list covers every planned Meal ingredient** (except where fully covered by fridge)
    - **Validates: Requirements 7.1**

  - [ ]* 5.6 Write property test for summing compatible occurrences
    - **Property 22: Compatible occurrences are summed**
    - **Validates: Requirements 7.2**

  - [ ]* 5.7 Write property test for keeping incompatible units separate
    - **Property 23: Incompatible units are kept separate**
    - **Validates: Requirements 7.3**

  - [ ]* 5.8 Write property test for fridge subtraction and omission
    - **Property 24: Fridge quantities are subtracted and covered items omitted**
    - **Validates: Requirements 7.4**

  - [ ]* 5.9 Write property test for grocery-list plan/Household association
    - **Property 26: Grocery lists are associated with plan and Household**
    - **Validates: Requirements 7.7**

  - [ ]* 5.10 Write example test for the empty-plan edge case
    - Empty plan yields an empty Grocery_List (7.6)
    - _Requirements: 7.6_

- [x] 6. Checkpoint - deterministic domain logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement the AgentCore Runtime and Memory clients
  - [x] 7.1 Implement the AgentCore Runtime client and invocation payload assembly
    - Build the invocation payload (`householdId`, `mode`, `preferenceProfile` snapshot, `fridgeInventory`, `presets`, `contextInput`, `rangeDays`, `rejectedSuggestionNames`, `conversationId`, `preferenceMemoryNamespace = householdId`)
    - Invoke only through the AgentCore Runtime `InvokeAgentRuntime` API with a 30s hard cap
    - Define a mockable client interface so generation property tests run without a live model
    - _Requirements: 8.2, 8.3, 8.4, 6.4_

  - [x] 7.2 Implement the AgentCore Memory client for short-term and long-term memory
    - Short-term: read/write Conversation turns at namespace `{householdId}:{conversationId}`
    - Long-term: read/write household preference memory at namespace `{householdId}` only (never userId, never conversationId); derive the namespace solely from the Active_Household
    - Make long-term reads best-effort: on failure/timeout, return empty soft bias so generation can still proceed
    - Define a mockable client interface for the memory-contract property tests
    - _Requirements: 1.4, 1.6, 6.2, 9.3, 9.7, 10.6_

  - [ ]* 7.3 Write property test for the profile snapshot passed to the agent
    - **Property 19: The agent receives the current profile snapshot** (mock AgentCore client; assert passed profile equals stored profile)
    - **Validates: Requirements 6.4**

  - [ ]* 7.4 Write property test for long-term memory household-only namespacing
    - **Property 34: Long-term preference memory is namespaced only by Household** (mock Memory client; namespace equals householdId for randomized users/conversations; distinct Households never share a namespace)
    - **Validates: Requirements 1.4, 1.5, 10.6**

  - [ ]* 7.5 Write property test for cross-member preference sharing
    - **Property 35: An expressed preference is shared across the whole Household** (mock Memory client; seed one member's extracted preference, assert another member's later generation sees it)
    - **Validates: Requirements 1.6, 6.2**

- [x] 8. Implement the Suggestion Service Lambda (ad hoc suggestions)
  - [x] 8.1 Implement ad hoc suggestion orchestration
    - Validate Context_Input ≤500 chars and the preset set before any generation; reject over-length input without invoking the agent
    - Load Household-scoped Preference_Profile and Fridge_Inventory, invoke the agent (soft long-term memory read best-effort), enforce the 10s bound
    - Post-process: run hard-exclusion enforcement, enforce 1–3 well-formed suggestions, enforce distinctness from rejected names
    - Handle no-profile (generate without filtering + indicate), no-suggestion, exhausted-distinct, and timeout branches without partial writes
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 4.1, 4.2, 5.2, 5.3, 5.4_

  - [ ]* 8.2 Write property test for well-formed, count-bounded suggestions
    - **Property 6: Ad hoc suggestions are well-formed and count-bounded** (mock AgentCore client)
    - **Validates: Requirements 2.1**

  - [ ]* 8.3 Write property test for rejected-suggestion distinctness
    - **Property 8: Rejected suggestions are not repeated within a session** (mock AgentCore client)
    - **Validates: Requirements 2.5**

  - [ ]* 8.4 Write property test for over-length Context_Input rejection
    - **Property 13: Over-length Context_Input is rejected before generation** (assert agent not invoked)
    - **Validates: Requirements 4.2**

  - [ ]* 8.5 Write example tests for ad hoc branch behaviors
    - No-suggestion message, exhausted-distinct message, no-profile branch, and 10s timeout with no partial store (2.3, 2.4, 2.6, 2.7)
    - _Requirements: 2.3, 2.4, 2.6, 2.7_

- [x] 9. Implement the Plan Service Lambda (weekly/custom plans)
  - [x] 9.1 Implement plan generation and day editing
    - Validate range 1–31 days (including weekly N=7); reject out-of-range with a 1-to-31 error and store nothing
    - Require an existing Preference_Profile for plan generation; reject with a profile-required error if absent, storing nothing
    - Build the full plan in memory, enforce the 30s bound, and persist only a complete plan in a single conditional write
    - Implement single-day replacement that changes only that day; emit `MealPlanChanged` on day add/remove/replace
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [ ]* 9.2 Write property test for plan range coverage
    - **Property 9: Plan covers exactly the requested range with one Meal per day** (mock AgentCore client; N from 1 to 31)
    - **Validates: Requirements 3.1, 3.7**

  - [ ]* 9.3 Write property test for out-of-range plan rejection
    - **Property 10: Out-of-range plan requests are rejected and store nothing**
    - **Validates: Requirements 3.8**

  - [ ]* 9.4 Write property test for day-edit locality
    - **Property 12: Editing one plan day is local** (also covers refine locality, 9.2)
    - **Validates: Requirements 3.6, 9.2**

  - [ ]* 9.5 Write example tests for plan no-profile and timeout branches
    - No-profile rejection (3.3) and 30s timeout with no partial store (3.4)
    - _Requirements: 3.3, 3.4_

- [x] 10. Implement the Grocery Service Lambda and regeneration consumer
  - [x] 10.1 Wire grocery generation and the MealPlanChanged consumer
    - Implement `POST /plans/{id}/grocery-list` over the consolidation logic from task 5.4, associating output with plan and Household
    - Implement the EventBridge `MealPlanChanged` consumer that regenerates the list from the current plan
    - _Requirements: 7.1, 7.5, 7.7_

  - [ ]* 10.2 Write property test for regeneration equivalence
    - **Property 25: Regenerated grocery list matches fresh generation**
    - **Validates: Requirements 7.5**

- [x] 11. Implement the Preference and Fridge Service Lambdas
  - [x] 11.1 Wire preference and fridge endpoints
    - Implement `POST /preferences/feedback` (within 2s), `/preferences/acceptances`, `/preferences/constraints` over task 4.1 logic with conditional writes
    - Implement `PUT /fridge` (within 3s) over task 5.1 logic, rejecting empty lists and preserving prior inventory on rejection
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 4.3, 4.4, 4.6_

  - [ ]* 11.2 Write example tests for feedback write-failure branch
    - Inject failure and assert the Preference_Profile is unchanged with a not-saved error (6.2)
    - _Requirements: 6.2_

- [x] 12. Implement the Conversation Service Lambda (chat refinement)
  - [x] 12.1 Implement conversation creation and refinement routing
    - `POST /conversations` scoped to the Active_Household; persist Conversation metadata and `memorySessionId`
    - `POST /conversations/{id}/messages`: assemble prior turns from short-term memory as context, route to the agent, enforce the 15s bound
    - Preserve unaffected attributes on suggestion refinement; update only the targeted day for plan refinement; support grocery-list refinement
    - On ambiguity/timeout, return a clarification or timeout response and leave the prior artifact unchanged
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [ ]* 12.2 Write property test for conversation context assembly
    - **Property 27: Conversations carry prior turns as context** (mock AgentCore client; payload includes all prior turns; conversation associated with Active_Household)
    - **Validates: Requirements 9.3, 9.7**

  - [ ]* 12.3 Write property test for grocery refinement
    - **Property 28: Grocery refinement reflects the requested change**
    - **Validates: Requirements 9.4**

  - [ ]* 12.4 Write example tests for refinement clarification and timeout
    - Ambiguous refinement returns a clarification and leaves the prior artifact unchanged (9.5); 15s timeout leaves the prior artifact unchanged (9.6)
    - _Requirements: 9.5, 9.6_

- [x] 13. Implement the Voice Service Lambda (Amazon Transcribe)
  - [x] 13.1 Implement voice transcription and confirmation flow
    - `POST /voice`: upload audio to the Household-prefixed S3 key, transcribe via Amazon Transcribe within 15s, return the Transcript for confirmation; apply nothing before confirmation
    - `POST /voice/{id}/confirm`: dispatch the confirmed Transcript to the target operation (fridge, context, conversation) as equivalent typed input, scoped to the Active_Household
    - Handle transcription failure / empty transcript / 15s timeout with a retry prompt, leaving stored data unchanged
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

  - [ ]* 13.2 Write property test for confirmation-gated dispatch
    - **Property 33: Voice input dispatches as equivalent typed input only after confirmation**
    - **Validates: Requirements 11.1, 11.3**

  - [ ]* 13.3 Write example tests for voice failure branches
    - Transcription failure / empty transcript / timeout leave stored data unchanged with a retry prompt (11.4, 11.5)
    - _Requirements: 11.4, 11.5_

  - [ ]* 13.4 Write smoke test for voice entry points
    - Assert voice entry points exist for fridge, context, and conversation operations (11.2)
    - _Requirements: 11.2_

- [x] 14. Implement the Auth & Membership Service Lambda and Cognito integration
  - [x] 14.1 Wire auth endpoints and membership operations over Cognito
    - `POST /auth/login` returns a session on success and a generic invalid-credentials error on failure (no field disclosure); enforce 5-failures-in-15-min lockout
    - Implement `/households`, `/households/{id}/invitations`, `/invitations/{id}/accept|decline`, `DELETE /members/{userId}`, `PUT /session/active-household` over tasks 3.1/3.4
    - _Requirements: 1.1, 1.2, 1.3, 10.1, 10.2, 10.3, 10.4, 10.6, 10.7, 10.8_

  - [ ]* 14.2 Write property test for invalid-credentials handling
    - **Property 1: Invalid credentials are denied without field disclosure**
    - **Validates: Requirements 1.2**

  - [ ]* 14.3 Write property test for lockout behavior
    - **Property 2: Lockout after repeated failures** (≥5 failures in 15 min locks; fewer does not)
    - **Validates: Requirements 1.3**

- [x] 15. Implement the API Gateway authorizer and shared-visibility wiring
  - [x] 15.1 Wire the authorizer and cross-member read path
    - Reject any request without a valid authenticated session (401, no data) via the Cognito/Lambda authorizer
    - Enforce per-request Active_Household membership verification in every orchestration entry point (403, no data for non-members)
    - Ensure committed shared changes are visible to other members on their next read
    - _Requirements: 1.5, 1.6, 1.7_

  - [ ]* 15.2 Write property test for unauthenticated request handling
    - **Property 4: Unauthenticated requests return no Household data**
    - **Validates: Requirements 1.7**

  - [ ]* 15.3 Write property test for shared-change visibility
    - **Property 5: Shared changes are visible to other members**
    - **Validates: Requirements 1.6**

- [x] 16. Implement infrastructure-as-code and the invitation-expiry scheduler
  - [x] 16.1 Define IaC for all AWS components
    - Define Cognito User Pool (password policy 8–128, lockout), API Gateway + authorizer, the orchestration Lambdas, DynamoDB single table with GSI1/GSI2, S3 audio bucket with lifecycle expiry, EventBridge bus/rules for `MealPlanChanged`, and the AgentCore Runtime/Memory configuration wiring
    - Implement the EventBridge Scheduler / Step Functions sweep that sets pending Invitations to expired after 7 days
    - _Requirements: 8.1, 8.2, 8.5, 10.5, 11.7_

  - [ ]* 16.2 Write smoke/IaC assertion tests for platform constraints
    - Assert backend components are AWS services, the agent runs on Bedrock AgentCore, persistence uses AWS-managed storage, and transcription uses Amazon Transcribe (8.1, 8.2, 8.5, 11.7)
    - _Requirements: 8.1, 8.2, 8.5, 11.7_

- [ ] 17. Integration tests against external services
  - [ ]* 17.1 Write integration tests for Cognito, AgentCore, and Transcribe wiring
    - Cognito login establishes a session for valid credentials within the time bound (1.1)
    - Generation paths invoke the Bedrock AgentCore Runtime client and the agent receives Context_Input and selected presets (8.3, 4.1, 5.2, 5.4)
    - Chat refinement preserves unaffected suggestion attributes end-to-end through AgentCore (9.1)
    - Long-term preference memory: a free-form preference stated in a Conversation is extracted and later retrievable from the household namespace and reflected in generation (1–3 examples)
    - Amazon Transcribe produces a Transcript for a sample Voice_Input
    - _Requirements: 1.1, 4.1, 5.2, 5.4, 8.3, 9.1_

  - [ ]* 17.2 Write integration test for graceful memory degradation
    - When the memory client fails, generation still succeeds using the structured Preference_Profile and still enforces hard exclusions (1–2 examples)
    - _Requirements: 8.4, 6.7_

- [x] 18. Final checkpoint - full suite
  - Ensure all tests pass, ask the user if questions arise.

- [x] 19. Implement the Suggestion_Agent container (`agent/`)
  - [x] 19.1 Scaffold `agent/` and implement config, budgets, and the request parser
    - Create `agent/src/config.ts` (env: `PORT` default 8080, `MODEL_ID`, `BEDROCK_REGION`, `MEMORY_ID`, optional `MEMORY_PREFERENCE_STRATEGY_ID`, budgets capped at 8 s ad hoc / 13 s refine / 26 s plan, `AD_HOC_SUGGESTION_COUNT` 1–3 default 2, `PLAN_CHUNK_DAYS` 1–7 default 4)
    - Create `agent/src/budget.ts` (monotonic deadline, remaining time, `AbortSignal` that fires at the deadline)
    - Create `agent/src/requestParser.ts`: `parseAgentRequest(value)` accepting exactly the `AdHocPayload`, `PlanPayload`, and `RefinePayload` shapes from `src/agent/payload.ts` plus the optional `householdPreferenceMemory` field. Use `validateHouseholdId`, require `preferenceMemoryNamespace === householdId`, `validatePresets`, `contextInput` ≤ 500 code points, integer `rangeDays` 1–31, and `currentArtifact.type === targetArtifactType` when present
    - Add `agent/**/*.ts` to the root `tsconfig.json` include and `agent/**/*.test.ts` to `vitest.config.ts`
    - _Requirements: 12.3, 12.13_

  - [ ]* 19.2 Write property test for invalid-request rejection at the server
    - File `agent/src/server.invalidRequest.property.test.ts`; assert `400` and zero `ModelClient` / `SoftPreferenceSource` calls
    - **Property 37: Invalid agent requests never reach the model or memory**
    - **Validates: Requirements 12.3**

  - [x] 19.3 Implement response schemas and prompt builders
    - `agent/src/schemas.ts`: one JSON Schema per mode mirroring `src/agent/responses.ts` (constant `mode`, `unit` enum from `CANONICAL_UNITS`, non-negative `quantity`, bounded arrays; refine as `updated` | `clarification`)
    - `agent/src/prompts.ts`: pure `buildSystemPrompt(mode)` and `buildUserMessage(request, softPreferences, chunk?)` that put all request data into one JSON-encoded `<request_data>` block (avoid list, presets with `definingAttribute`/`description` from `PRESET_DEFINITIONS`, `preferIngredients` from fridge, likes/dislikes, soft preferences labelled soft, rejected names, context input, plan days, refine `currentArtifact`/`priorTurns`/`changeRequest`); handle `preferenceProfile: null`
    - _Requirements: 12.1, 12.7, 12.9_

  - [ ]* 19.4 Write property test for prompt completeness
    - File `agent/src/prompts.property.test.ts`; generate payloads only via `buildAdHocPayload` / `buildPlanPayload` / `buildRefinePayload`
    - **Property 40: Prompts carry every request constraint**
    - **Validates: Requirements 12.7**

  - [ ]* 19.5 Write unit tests for schema/parser parity and prompt snapshots
    - File `agent/src/schemas.test.ts` and `agent/src/prompts.test.ts`: schema-valid samples parse with `parseAgentResponseValue`; per-mode prompt snapshots; user strings containing `</request_data>` stay JSON-escaped
    - _Requirements: 12.1, 12.7_

  - [x] 19.6 Implement the `ModelClient` interface and the Claude-on-Bedrock client
    - Create `agent/src/model/modelClient.ts` (`StructuredRequest`, `StructuredResult`, `ModelClient`) and `agent/test/fakeModelClient.ts` (scripted results, records requests)
    - Verify `@strands-agents/sdk` on npm (current version, licence, ESM + Node 22, Bedrock provider, structured output without tools, esbuild bundling); if usable implement `agent/src/model/strandsModelClient.ts`, otherwise implement `agent/src/model/bedrockConverseModelClient.ts` with `@aws-sdk/client-bedrock-runtime` `ConverseCommand`, a single `submit_response` tool, and `toolChoice: { tool: { name: 'submit_response' } }`; record the decision in a header comment
    - Add the chosen dependency to the root `package.json`
    - Map missing tool use to `no_structured_output`, service errors to `model_error`, aborts to `aborted`
    - _Requirements: 8.2, 12.1, 12.2_

  - [ ]* 19.7 Write unit tests for the model client
    - File `agent/src/model/modelClient.test.ts`: mocked `send` (or Strands model) verifies the forced tool / structured-output request, the configured `MODEL_ID`, output mapping, and abort handling
    - _Requirements: 12.1, 12.2_

  - [x] 19.8 Implement soft preferences, contract checks, and the generation pipeline
    - `agent/src/softPreferences.ts`: read-only `SoftPreferenceSource.read(householdId, query?)` over `AgentCoreMemoryClient.readHouseholdPreferences` with a 1.5 s read timeout; expose no write or turn methods
    - `agent/src/contractChecks.ts`: ad hoc filtering (rejected names case-insensitive/trimmed, excluded ingredients via the `src/domain/exclusions.ts` matcher, de-duplicate, truncate to 3); plan chunk count and exclusion checks; refine target-type and existing-day checks
    - `agent/src/generate.ts`: use included `householdPreferenceMemory` or read memory once; build prompts; call the model; validate with `parseAgentResponseValue` + `contractChecks`; one repair call with the validator message when budget allows (≥ 3 s ad hoc/refine, ≥ 8 s plan chunk); plan chunks of `PLAN_CHUNK_DAYS` generated concurrently and merged in day order; fail the whole plan if any chunk fails; return `GENERATION_FAILED` / `GENERATION_TIMEOUT` results
    - _Requirements: 12.1, 12.2, 12.4, 12.5, 12.6, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13_

  - [ ]* 19.9 Write property test for contract conformance
    - File `agent/src/generate.contract.property.test.ts`; scripted model-result sequences including invalid documents and errors
    - **Property 36: Agent success responses always parse for their mode**
    - **Validates: Requirements 12.1, 12.2**

  - [ ]* 19.10 Write property test for plan length
    - File `agent/src/generate.plan.property.test.ts`; N from 1 to 31, chunk size 1 to 7
    - **Property 38: Plan-mode responses contain exactly rangeDays Meals**
    - **Validates: Requirements 12.4**

  - [ ]* 19.11 Write property test for ad hoc filtering
    - File `agent/src/generate.adHoc.property.test.ts`
    - **Property 39: Ad-hoc responses are bounded and exclude rejected and excluded Meals**
    - **Validates: Requirements 12.5, 12.6**

  - [ ]* 19.12 Write property test for agent memory access
    - File `agent/src/generate.memory.property.test.ts`; fake memory records every call
    - **Property 41: Agent memory access is read-only, household-namespaced, and skipped when preferences are supplied**
    - **Validates: Requirements 12.8, 12.9, 12.11**

  - [ ]* 19.13 Write property test for memory degradation
    - File `agent/src/generate.degradation.property.test.ts`
    - **Property 42: Memory failure degrades to generation without soft preferences**
    - **Validates: Requirements 12.10**

  - [ ]* 19.14 Write property test for refine targets
    - File `agent/src/generate.refine.property.test.ts`
    - **Property 43: Refine responses target the requested artifact**
    - **Validates: Requirements 12.12**

  - [x] 19.15 Implement the HTTP server, entry point, and ARM64 Dockerfile
    - Verify the current AgentCore Runtime HTTP contract in the AgentCore developer guide (`POST /invocations`, `GET /ping` body, port 8080, ARM64) and note the source in a header comment
    - `agent/src/server.ts` (node:http): `GET /ping` → `{"status":"Healthy","time_of_last_update":<epoch s>}`; `POST /invocations` with a 512 KB body limit, `parseAgentRequest`, `generate`, and `200` / `400` / `413` / `500` / `504` mapping; `404` otherwise; JSON logs without user content; graceful SIGTERM
    - `agent/src/main.ts` wiring config, `AgentCoreMemoryClient`, `SoftPreferenceSource`, the model client, and the server
    - `agent/Dockerfile`: `linux/arm64` multi-stage build (root-only `npm ci`, esbuild bundle of `agent/src/main.ts`), runtime as user `node`, `EXPOSE 8080`, `CMD ["node","main.mjs"]`
    - _Requirements: 8.2, 12.1, 12.3, 12.13, 12.14_

  - [ ]* 19.16 Write unit tests for the server
    - File `agent/src/server.test.ts`: `/ping` body, 404, 413, error-status mapping, timeout → 504 using fake timers and the fake model
    - _Requirements: 12.13, 12.14_

  - [x] 19.17 Lower the plan agent deadline to fit the API Gateway limit
    - Change `PLAN_DEADLINE_MS` in `src/agent/runtimeClient.ts` to 28 000 ms and update affected tests in `src/agent/runtimeClient.test.ts` and `src/services/plans/` (the 30 s hard cap stays)
    - Update the "Known limits" entry in `infra/README.md` with the chunked synchronous plan decision
    - _Requirements: 3.4, 8.4_

- [x] 20. Implement server-side audio conversion in the Voice Service
  - [x] 20.1 Classify and validate convertible audio
    - In `src/voice/audio.ts` add `classifyContentType` (accepted encodings; `audio/webm`, `video/webm` → `webm`; `audio/mp4`, `audio/x-m4a` → `mp4`) and `validateIncomingAudio`, reusing the base64 and `MAX_AUDIO_BYTES` checks; check EBML magic `1A 45 DF A3` for WebM and `ftyp` at bytes 4–7 for MP4; leave the accepted-format path unchanged; update the header comment
    - _Requirements: 14.4, 14.6, 14.7_

  - [x] 20.2 Implement the `AudioConverter` interface and the ffmpeg converter
    - Create `src/voice/audioConverter.ts`: `AudioConverter`, `ConversionResult`, `ffmpegArgs(container, inputPath)` returning the fixed argument list from the design (demuxer `matroska` | `mov`, `-protocol_whitelist file,pipe`, `-t 31`, mono 16 kHz `pcm_s16le` to `pipe:1`), an injectable `ProcessRunner`, `FfmpegAudioConverter` (temp dir via `mkdtemp`, input file mode 0600, `spawn` with `shell: false` and empty env, SIGKILL on abort/timeout/output over `maxOutputBytes`, ≤ 4 KB stderr kept, cleanup in `finally`, odd/empty output → `failed`), and `FakeAudioConverter`
    - _Requirements: 14.5, 14.7, 14.8, 14.10_

  - [ ]* 20.3 Write property test for fixed converter arguments
    - File `src/voice/audioConverter.args.property.test.ts`; fake `ProcessRunner` records invocations
    - **Property 51: Converter arguments are fixed**
    - **Validates: Requirements 14.10**

  - [ ]* 20.4 Write unit tests for the ffmpeg converter
    - File `src/voice/audioConverter.test.ts`: oversize kill, non-zero exit, abort, odd-length output, temp-dir cleanup on every path
    - _Requirements: 14.7, 14.8_

  - [x] 20.5 Integrate conversion into the Voice Service and Lambda
    - In `src/services/voice/service.ts` route convertible input through the `AudioConverter` with a budget of `min(5 s, remaining − 5 s)` inside the existing 15 s deadline, then continue on the PCM upload/transcribe path; add `AUDIO_CONVERSION_FAILED` (422) to the error codes and `VOICE_ERROR_STATUS`; map `too_large` → `AUDIO_TOO_LARGE`, `timeout` → `VOICE_TIMEOUT`; write nothing on failure
    - Inject `FfmpegAudioConverter` (path from `FFMPEG_PATH`) in `src/services/voice/lambda.ts`
    - _Requirements: 11.5, 14.4, 14.5, 14.7, 14.8, 14.9_

  - [ ]* 20.6 Write property test for conversion routing
    - File `src/services/voice/service.conversionRouting.property.test.ts`
    - **Property 49: Accepted audio bypasses conversion; mislabelled or unsupported audio never reaches the converter**
    - **Validates: Requirements 14.4, 14.6**

  - [ ]* 20.7 Write property test for converted output
    - File `src/services/voice/service.convertedOutput.property.test.ts`
    - **Property 50: Converted audio meets the accepted format and size bound**
    - **Validates: Requirements 14.5, 14.7, 14.8**

  - [ ]* 20.8 Write example tests for conversion timing and an optional real-ffmpeg check
    - File `src/services/voice/service.conversion.test.ts`: a slow fake converter yields `VOICE_TIMEOUT` within 15 s and stores nothing; when `FFMPEG_PATH` is set, convert small WebM and MP4 fixtures and assert 16 kHz mono PCM output (skipped otherwise)
    - _Requirements: 14.9, 14.5_

- [x] 21. Add read endpoints required by the Client_App
  - [x] 21.1 Implement Household and member reads
    - Add `GET /households` (caller's memberships via `listHouseholdIdsForUser`, returning `householdId`, `name`, `role`, `ownerUserId`) and `GET /households/{id}/members` (member-only, `403 NOT_A_MEMBER` otherwise; `userId`, `email` from the `USER#` mirror, `role`, `joinedAt`) to `src/services/auth/membershipService.ts` and `handlers.ts`
    - _Requirements: 13.6, 13.8, 1.5_

  - [x] 21.2 Implement plan and grocery-list reads
    - Add `GET /plans` (newest first, at most 20, summary fields) and `GET /plans/{id}` (`{ plan, meals, version }`, `404 PLAN_NOT_FOUND`) to the Plan Service and handlers; add `GET /plans/{id}/grocery-list` (`404 GROCERY_LIST_NOT_FOUND`) to the Grocery Service and handlers; all scoped to the Active_Household
    - _Requirements: 13.12, 13.13, 1.4_

  - [x] 21.3 Register the read routes in the HTTP API
    - Add the five GET routes to the `routes` table in `infra/lib/sousStack.ts`
    - _Requirements: 13.6, 13.8, 13.12, 13.13_

  - [ ]* 21.4 Write unit tests for the read endpoints
    - Scoping to the Active_Household, `403` for non-members, `404` for unknown plans and lists, newest-first ordering
    - _Requirements: 13.6, 13.8, 13.12, 13.13, 1.5_

- [x] 22. Scaffold the Client_App, API client, design system, and authentication
  - [x] 22.1 Create the `web/` workspace
    - Add `"workspaces": ["web"]` and the scripts `build:web`, `test:web`, `test:all` to the root `package.json`; keep root `build` and `test` unchanged
    - Create `web/package.json`, `tsconfig.json`, `vite.config.ts` (React, `@tailwindcss/vite`, `vite-plugin-pwa` with the manifest, `navigateFallback`, NetworkFirst for `/config.json`, no API caching, `registerType: 'prompt'`), `vitest.config.ts` (jsdom), `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles/app.css`, and icons
    - Install React 19, React Router, TanStack Query, lucide-react, Testing Library, vitest-axe, and fast-check in the workspace
    - Configure the `@sous/domain` alias to `../src/domain` and verify `presets.ts`/`types.ts`/`units.ts` import cleanly in the browser build; otherwise copy them into `web/src/domain/`
    - _Requirements: 13.1, 13.2_

  - [x] 22.2 Implement runtime config and the typed API client
    - `web/src/config/runtimeConfig.ts` (loads `/config.json`)
    - `web/src/api/types.ts` with wire types taken from the handler and service result types; `web/src/api/errors.ts` (`ApiError`, `ERROR_MESSAGES` for every handler error code found by grepping the services, `messageFor`)
    - `web/src/api/client.ts`: `Authorization` = ID token on all non-public calls, `X-Active-Household` on Household calls, `NoActiveHouseholdError` without fetch, per-endpoint timeouts via `AbortController`, `retry-after` parsing, 401 → single-flight refresh and one retry
    - `web/src/api/endpoints.ts`: one typed function per route in the design's API client table
    - _Requirements: 13.5, 13.16, 13.17_

  - [ ]* 22.3 Write property test for request headers
    - File `web/src/api/client.headers.property.test.ts`
    - **Property 44: The Client_App sends identity and Active_Household on every Household request**
    - **Validates: Requirements 13.5**

  - [ ]* 22.4 Write property test for error mapping
    - File `web/src/api/errors.property.test.ts`
    - **Property 45: Every API error code maps to a user-facing message**
    - **Validates: Requirements 13.16**

  - [ ]* 22.5 Write unit tests for the API client
    - File `web/src/api/client.test.ts`: timeouts, refresh-once single-flight under concurrent 401s, failed refresh clears the session, error body parsing
    - _Requirements: 13.16, 13.17_

  - [x] 22.6 Implement the design system and app shell
    - Design tokens for light and dark in `web/src/styles/app.css` with `data-theme` override and `ThemeToggle`
    - `web/src/ui/` components: Button, IconButton, Chip (`aria-pressed`), TextField, TextArea with `CharCounter`, Dialog (native `<dialog>` with focus trap and restore), Sheet, Toast (`aria-live`), ErrorBanner (`role="alert"`), EmptyState, Skeleton, Spinner, `AsyncView`, `OfflineBanner`
    - `web/src/ui/AppShell.tsx` with a mobile bottom `TabBar` (safe-area insets, 44 px targets), a side rail from `lg`, and a skip link
    - _Requirements: 13.1, 13.2, 13.16, 13.19_

  - [ ]* 22.7 Write accessibility and contrast tests for the design system
    - File `web/src/ui/ui.a11y.test.tsx`: token pairs meet 4.5:1 (3:1 for large text and UI boundaries) in both themes; axe checks on each component; keyboard operation of Dialog and Chip
    - _Requirements: 13.19_

  - [x] 22.8 Implement session, Cognito sign-up, Active_Household selection, and auth screens
    - `web/src/auth/session.ts` (`sous.session.v1`), `cognitoPublic.ts` (`SignUp`, `ConfirmSignUp`, `ResendConfirmationCode`, `InitiateAuth REFRESH_TOKEN_AUTH`, `RevokeToken` via `fetch`), `SessionProvider`, `RequireSession`
    - `web/src/household/ActiveHouseholdProvider.tsx` (`sous.activeHousehold.v1.{userId}`, confirmed with `PUT /session/active-household`), `RequireHousehold`
    - `SignIn` (lockout message from `retry-after`, challenge message), `SignUp` (8–128 character passwords), `ConfirmSignUp` screens
    - Sign-out clearing session, Active_Household, grocery check keys, and the query cache
    - `web/src/routes.tsx` with the auth routes and guards; mount providers and `AppShell` in `App.tsx`
    - _Requirements: 13.3, 13.4, 13.5, 13.6, 13.17, 13.18, 1.3_

  - [ ]* 22.9 Write unit tests for authentication flows
    - File `web/src/auth/auth.test.tsx`: sign-in success, invalid credentials, lockout; sign-up and confirmation request shapes; guard redirects; sign-out removes all keys
    - _Requirements: 13.3, 13.4, 13.17, 13.18_

- [x] 23. Implement the Client_App screens
  - [x] 23.1 Implement household screens
    - `web/src/features/households/`: `HouseholdPicker` (role badges, empty state prompting creation), `CreateHousehold`, `Members` (remove control only for the owner and only on non-owner rows), `InviteDialog` (email, then Invitation_Link with Copy and Share), `AcceptInvitation` (accept/decline and the System's outcome)
    - _Requirements: 13.6, 13.7, 13.8, 10.1, 10.2, 10.3, 10.4, 10.7, 10.8_

  - [ ]* 23.2 Write component tests for household screens
    - File `web/src/features/households/households.test.tsx`: remove-control visibility rules, invitation link display, accept/decline outcomes including `INVALID_INVITATION`
    - _Requirements: 13.7, 13.8_

  - [x] 23.3 Implement the Suggest now screen
    - `web/src/features/suggest/`: `ContextInput` (code-point counter, blocks > 500), `PresetChips` (runs `validatePresets`, names the conflicting pair, disables submit), `SuggestionCard` (like/dislike feedback, accept into plan, reject), `SuggestScreen` (keeps `sessionId` and every rejected id, sends them on "another"; shows `notice` and `softPreferencesDegraded`)
    - _Requirements: 13.9, 13.10, 13.11, 2.5, 4.2, 5.5, 6.1, 6.3_

  - [ ]* 23.4 Write property test for client-side validation parity
    - File `web/src/features/suggest/validation.property.test.ts`
    - **Property 46: Client-side input checks agree with the server**
    - **Validates: Requirements 13.9, 13.10**

  - [ ]* 23.5 Write component tests for the Suggest now screen
    - File `web/src/features/suggest/SuggestScreen.test.tsx`: conflict feedback, counter, reject-then-another payload, error and empty states
    - _Requirements: 13.10, 13.11, 13.16_

  - [x] 23.6 Implement plan screens
    - `web/src/features/plans/`: `PlansList`, `NewPlan` (week or 1–31 days, optional start date, context, presets; progress state for the 32 s request; refetch `GET /plans` after a client timeout), `PlanView` and `DayEditor` (replace, add, remove a day)
    - _Requirements: 13.12, 3.1, 3.6, 3.7, 3.8_

  - [x] 23.7 Implement the grocery screen
    - `web/src/features/grocery/`: generate/regenerate and view; `useGroceryChecks` storing `{ generatedAt, checked }` under `sous.grocery.v1.{householdId}.{planId}` and resetting when `generatedAt` changes
    - _Requirements: 13.13, 7.1, 7.6_

  - [x] 23.8 Implement fridge and preferences screens
    - `web/src/features/fridge/FridgeEditor.tsx` (rows with unit select from `CANONICAL_UNITS`, blocks empty saves) and `web/src/features/preferences/` (likes, dislikes, constraints; `ConstraintForm` 1–200 characters with duplicate check and counter)
    - _Requirements: 13.9, 13.14, 4.3, 4.4, 6.5, 6.6_

  - [x] 23.9 Implement the chat refinement panel
    - `web/src/features/chat/ChatPanel.tsx`: starts a Conversation for a target artifact, sends messages, shows clarifications as assistant messages without changing the artifact, and emits the updated artifact on `outcome: updated`; bottom sheet on mobile, side panel on wide screens
    - _Requirements: 13.14, 9.1, 9.5_

  - [ ]* 23.10 Write component tests for plans, grocery, fridge, preferences, and chat
    - Files `web/src/features/{plans,grocery,fridge,preferences,chat}/*.test.tsx`: day actions, check persistence and reset, constraint validation, clarification keeps the artifact, axe checks per screen in both themes
    - _Requirements: 13.12, 13.13, 13.14, 13.19_

  - [x] 23.11 Wire screens into routing and navigation
    - Register every screen route from the design in `web/src/routes.tsx` behind `RequireSession` / `RequireHousehold`, connect the `TabBar` items, and add chat launch points to `SuggestionCard`, `PlanView` days, and the grocery screen
    - _Requirements: 13.6, 13.12, 13.13, 13.14_

- [x] 24. Implement voice capture and encoding in the browser
  - [x] 24.1 Implement the PCM encoder and AudioWorklet
    - `web/src/voice/pcmEncoder.ts` (pure `downmix`, streaming `createResampler(inputRate, 16000)` with box low-pass and fractional carry, `floatToInt16LE` with clamping) and `web/src/voice/pcm-capture.worklet.ts` registering `sous-pcm-capture` and posting transferable chunks; verify Vite's `?worker&url` import works with `audioWorklet.addModule`
    - _Requirements: 14.1_

  - [ ]* 24.2 Write property test for PCM encoding
    - File `web/src/voice/pcmEncoder.property.test.ts`
    - **Property 47: Browser PCM encoding yields 16 kHz mono 16-bit little-endian samples**
    - **Validates: Requirements 14.1**

  - [x] 24.3 Implement the recorder state machine
    - `web/src/voice/recorder.ts`: AudioContext created on the user gesture, worklet capture as primary path, `MediaRecorder` fallback preferring `audio/ogg;codecs=opus`, then `audio/webm;codecs=opus`, `audio/webm`, `audio/mp4`; stop at 30 s or 960 000 PCM bytes; `remainingMs` for the countdown; refuse fallback blobs over 1 000 000 bytes; stop tracks and close the context on stop/cancel; permission and unsupported-browser errors
    - _Requirements: 14.1, 14.2, 14.3_

  - [ ]* 24.4 Write property test for recording size limits
    - File `web/src/voice/recorder.property.test.ts` with fake timers and fake worklet messages
    - **Property 48: Recorded uploads never exceed the size limit**
    - **Validates: Requirements 14.3**

  - [x] 24.5 Implement the voice button and transcript dialog and integrate them
    - `web/src/features/voice/VoiceButton.tsx` (countdown, recording state, upload via `submitVoice` with `audio/pcm` + `sampleRateHertz: 16000` or the fallback content type) and `TranscriptDialog.tsx` (editable transcript, Confirm → `confirmVoice` with the edited text, Cancel applies nothing)
    - Add the button to `FridgeEditor`, `ContextInput`, and the `ChatPanel` composer with the matching `targetOperation`, and refresh the affected view after confirmation
    - _Requirements: 13.15, 11.1, 11.2, 11.3, 11.4, 14.1, 14.2, 14.3_

  - [ ]* 24.6 Write component tests for voice input
    - File `web/src/features/voice/voice.test.tsx`: countdown and auto-stop, confirm sends the corrected transcript, cancel sends nothing, `VOICE_NOT_UNDERSTOOD` / `AUDIO_CONVERSION_FAILED` show retry prompts
    - _Requirements: 13.15, 11.3, 11.4, 14.8_

- [x] 25. Wire the agent image, voice container, and web hosting into CDK
  - [x] 25.1 Build the Suggestion_Agent image and create the runtime by default
    - Add `{ kind: 'asset' }` to `AgentRuntimeConfig` as the default in `infra/lib/sousStack.ts`: `DockerImageAsset` (repo root, `file: 'agent/Dockerfile'`, `Platform.LINUX_ARM64`, excludes from the design), `asset.repository.grantPull(role)`, `CfnRuntime` from `asset.imageUri`
    - Set runtime env `MEMORY_ID`, `MEMORY_PREFERENCE_STRATEGY_ID` (when known), `MODEL_ID`, `BEDROCK_REGION`; reduce memory actions to `RetrieveMemoryRecords` and `ListMemoryRecords`; narrow `bedrock:InvokeModel` to Anthropic Claude models and inference profiles; set the MMDSv2 metadata requirement if `CfnRuntime` exposes it
    - In `infra/bin/sous.ts` add `agentRuntimeMode` (`asset` | `parameter`) and `agentModelId` context keys, keeping `agentContainerUri`; set a verified Claude model id default in `cdk.json`
    - _Requirements: 8.2, 8.3, 12.11_

  - [x] 25.2 Package the Voice Lambda as a container image with ffmpeg
    - Create `infra/docker/voice/Dockerfile` (esbuild bundle of `src/services/voice/lambda.ts`, static ARM64 ffmpeg copied from a digest-pinned image to `/opt/bin/ffmpeg` after verifying its licence, `public.ecr.aws/lambda/nodejs:22` arm64 base)
    - Replace the voice `NodejsFunction` with a `DockerImageFunction` (ARM64, 1024 MB, 20 s, `FFMPEG_PATH`) keeping its env, IAM grants, and routes
    - _Requirements: 14.5, 14.9, 8.1_

  - [x] 25.3 Host the Client_App on S3 and CloudFront
    - Add the private web bucket, the distribution with Origin Access Control, HTTPS redirect, the SPA rewrite CloudFront Function, and the response headers policy (CSP with the API and Cognito endpoints in `connect-src`, HSTS, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy)
    - Add the two `BucketDeployment`s (immutable `assets/**`; `no-cache` rest plus `config.json` from `Source.jsonData`) with invalidation paths; add the `webAssetPath` prop (default `web/dist`, clear error without `index.html`) and a fixture directory for stack tests
    - Default HTTP API CORS to the distribution origin unless `corsAllowOrigins` is set; output `WebUrl`
    - _Requirements: 13.2, 13.20, 8.1_

  - [x] 25.4 Update scripts and infrastructure documentation
    - Root `synth` script builds the web app before `cdk synth`; document `agentRuntimeMode`, `agentModelId`, the image assets (Docker needed for `cdk deploy`, not for synth), web hosting, CORS default, and local development with `http://localhost:5173` in `infra/README.md`
    - _Requirements: 8.1, 13.20_

  - [ ]* 25.5 Write IaC assertion tests for the new infrastructure
    - In `infra/lib/sousStack.test.ts`: runtime from the image asset by default and parameter/container modes still synthesize; runtime role has no `CreateEvent`/`ListEvents`; web bucket blocks public access and uses OAC; HTTPS redirect, headers policy, and SPA function on the distribution; CORS default equals the distribution origin; new GET routes exist; Voice function is a container image with `FFMPEG_PATH`
    - _Requirements: 8.1, 8.2, 12.11, 13.20, 14.5_

- [x] 26. Final checkpoint - backend, agent, and Client_App suites
  - Ensure all tests pass, ask the user if questions arise.

- [x] 27. Switch the Suggestion_Agent default model to Claude Haiku 5.5
  - [x] 27.1 Use `global.anthropic.claude-haiku-5-5` as the default model
    - Verify against the Bedrock model card (https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html) and the Converse/thinking docs how to disable adaptive thinking (it is on by default and conflicts with the forced `toolChoice` of `submit_response`); set the verified field in `agent/src/model/bedrockConverseModelClient.ts` (for example through `additionalModelRequestFields`) only for models that need it, and update its unit test
    - Change `DEFAULT_AGENT_MODEL_ID` in `infra/lib/sousStack.ts` and `agentModelId` in `cdk.json`; make sure `CLAUDE_MODEL_ID` and the IAM resources accept the id; update tests, `infra/README.md` and `README.md` mentions
    - Update `docs/cost-estimate.md` with the verified Haiku 5.5 price (check an AWS source) and recalculate the tables
    - _Requirements: 12.11, 8.2_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP, but each maps to a specific correctness property or acceptance criterion for traceability.
- Property-based tests use `fast-check` at a minimum of 100 runs and are each tagged `Feature: meal-planner, Property N: ...`.
- Generation and memory-contract property tests (6, 7, 8, 9, 19, 27, 34, 35) run against a mocked AgentCore Runtime client and a mocked AgentCore Memory client; live-service behavior is covered by the integration tests in task 17.
- Hard exclusion enforcement (Property 7) runs deterministically in Lambda over returned Meals and holds regardless of soft long-term memory contents.
- Checkpoints ensure incremental validation after the deterministic domain layer and at the end.
- Tasks 19–26 implement Requirements 12–14. Agent tests (Properties 36–43) run in root Vitest with the fake `ModelClient` and fake `SoftPreferenceSource`; Client_App tests (Properties 44–48) run with `npm run test:web`; audio-conversion tests (Properties 49–51) run in root Vitest with `FakeAudioConverter` or a fake `ProcessRunner`. `npm run test:all` runs both suites.
- New property-test sub-tasks name a dedicated test file so that tasks in the same wave never write the same file.
- `cdk synth` and the stack tests do not need Docker; the agent and voice images are built by `cdk deploy`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.1", "4.1", "4.4", "5.1", "5.4", "7.1", "7.2"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "4.2", "4.3", "4.5", "4.6", "4.7", "4.8", "5.2", "5.3", "5.5", "5.6", "5.7", "5.8", "5.9", "5.10", "7.3", "7.4", "7.5"] },
    { "id": 4, "tasks": ["3.5", "3.6", "8.1", "9.1", "12.1", "14.1"] },
    { "id": 5, "tasks": ["8.2", "8.3", "8.4", "8.5", "9.2", "9.3", "9.4", "9.5", "10.1", "11.1", "12.2", "12.3", "12.4", "13.1", "14.2", "14.3", "15.1"] },
    { "id": 6, "tasks": ["10.2", "11.2", "13.2", "13.3", "13.4", "15.2", "15.3", "16.1"] },
    { "id": 7, "tasks": ["16.2", "17.1", "17.2"] },
    { "id": 8, "tasks": ["19.1", "19.17", "20.1", "20.2", "21.1", "21.2", "22.1"] },
    { "id": 9, "tasks": ["19.3", "19.6", "20.3", "20.4", "20.5", "21.3", "22.2", "22.6", "24.1"] },
    { "id": 10, "tasks": ["19.4", "19.5", "19.7", "19.8", "20.6", "20.7", "20.8", "21.4", "22.3", "22.4", "22.5", "22.7", "22.8", "24.2", "24.3", "25.2"] },
    { "id": 11, "tasks": ["19.9", "19.10", "19.11", "19.12", "19.13", "19.14", "19.15", "22.9", "23.1", "23.3", "23.6", "23.7", "23.8", "23.9", "24.4", "25.3"] },
    { "id": 12, "tasks": ["19.2", "19.16", "23.2", "23.4", "23.5", "23.10", "23.11", "25.1"] },
    { "id": 13, "tasks": ["24.5", "25.4"] },
    { "id": 14, "tasks": ["24.6", "25.5"] },
    { "id": 15, "tasks": ["27.1"] }
  ]
}
```
