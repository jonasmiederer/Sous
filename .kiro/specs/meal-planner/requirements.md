# Requirements Document

## Introduction

Sous is an AWS-hosted meal planning application that helps a household decide what to cook and what to buy. It provides meal suggestions on demand or as a full weekly plan, accepts contextual input such as current fridge contents and cravings, shapes suggestions through selectable presets (for example healthy, quick, craving, fine dining), learns household preferences over time, and generates consolidated grocery shopping lists from planned meals. The system is built entirely on AWS and uses Amazon Bedrock AgentCore to run the meal-suggestion agent. Users reach Sous through an installable, mobile-first web Client_App that also captures voice input in a transcribable audio format.

## Glossary

- **System**: The complete Sous application, including its backend services, agent, and data stores, hosted on AWS.
- **Suggestion_Agent**: The Amazon Bedrock AgentCore agent that generates meal suggestions and meal plans.
- **Household**: The tenant boundary of the System; a named group of one or more Users who share Meal_Plans, a Preference_Profile, Fridge_Inventory, Grocery_Lists, and Conversations. A User may belong to one or more Households, and each Household's data is isolated from every other Household.
- **Household_Owner**: The User who created a Household and who manages that Household's membership and Invitations, including inviting Users and removing members.
- **Invitation**: A record that allows a specified person, identified by an email address or user identifier, to join a specific Household. An Invitation has a status of pending, accepted, declined, or expired.
- **User**: An authenticated person who belongs to one or more Households and interacts with the System.
- **Active_Household**: The single Household a User has currently selected, to which the System scopes all of that User's operations and data access during the session.
- **Conversation**: A multi-turn chat session between a User and the Suggestion_Agent within a single Household, in which the User refines artifacts such as Meal_Suggestions, Meal_Plans, and Grocery_Lists, and which retains prior turns as context.
- **Meal**: A single dish or recipe with a name, ingredient list, and preparation details.
- **Meal_Suggestion**: A Meal proposed by the Suggestion_Agent in response to a request.
- **Meal_Plan**: An ordered set of Meals assigned to specific days, covering a defined date range such as one week.
- **Ad_Hoc_Suggestion**: A single Meal_Suggestion requested for immediate use rather than as part of a Meal_Plan.
- **Weekly_Plan**: A Meal_Plan that covers seven consecutive days.
- **Context_Input**: Free-form or structured information a User provides to influence suggestions, such as fridge contents or a specific craving.
- **Fridge_Inventory**: The list of ingredients a User records as currently available in the household.
- **Preset**: A named configuration (for example healthy, quick, craving, fine dining) that shapes how the Suggestion_Agent generates suggestions.
- **Preference_Profile**: The stored record of a Household's learned and explicitly stated likes, dislikes, and dietary constraints.
- **Grocery_List**: A consolidated, de-duplicated list of ingredients required to prepare the Meals in a Meal_Plan, minus available Fridge_Inventory items.
- **Feedback**: A User's rating or acceptance signal on a Meal_Suggestion used to refine the Preference_Profile.
- **Voice_Input**: Spoken audio a User provides, which the System transcribes to text and then processes as the equivalent typed input.
- **Transcript**: The text produced by transcribing a Voice_Input.
- **Foundation_Model**: The large language model on Amazon Bedrock that the Suggestion_Agent calls to generate Meals and refinements.
- **Agent_Response_Contract**: The structured response shape the System accepts from the Suggestion_Agent for each generation mode: a list of Meal_Suggestions for ad hoc mode, a list of Meals in day order for plan mode, and either an updated artifact or a clarification message for refine mode.
- **Soft_Preference**: A free-form household preference statement held in the Household's long-term preference memory, used only to bias generation and never to enforce exclusions.
- **Client_App**: The installable web application through which Users access the System from mobile and desktop browsers.
- **Invitation_Link**: A URL that identifies one Invitation and opens the Client_App screen for accepting or declining that Invitation.
- **Accepted_Audio_Format**: An audio encoding the System passes to transcription without conversion: Ogg/Opus, FLAC, or 16-bit little-endian mono PCM.
- **Convertible_Audio_Format**: An audio container the System converts before transcription: WebM or MP4.
- **Audio_Converter**: The System component that converts Voice_Input audio from a Convertible_Audio_Format into 16 kHz mono 16-bit little-endian PCM.

## Requirements

### Requirement 1: Household Account and Authentication

**User Story:** As a User, I want to sign in with my own identity and work within a household I belong to, so that my girlfriend and I share the same meal plans, preferences, and grocery lists while keeping each household's data separate.

#### Acceptance Criteria

1. WHEN a User submits credentials containing an identifier of 1 to 254 characters and a password of 8 to 128 characters that match a stored User identity, THE System SHALL authenticate the User, establish an authenticated session, and establish the User identity within 3 seconds.
2. IF a User submits credentials that do not match any stored User identity, THEN THE System SHALL deny access, return an authentication error message indicating the credentials are invalid without disclosing which field was incorrect, and leave the session unauthenticated.
3. IF a User submits invalid credentials for the same identifier 5 consecutive times within 15 minutes, THEN THE System SHALL deny access and reject further authentication attempts for that identifier for 15 minutes, returning an error message indicating the account is temporarily locked.
4. WHEN an authenticated User has an Active_Household of which the User is a member, THE System SHALL present only the Meal_Plans, Preference_Profile, Fridge_Inventory, Grocery_Lists, and Conversations belonging to that Active_Household and SHALL exclude data belonging to any Household of which the User is not a member.
5. IF an authenticated User requests data of a Household of which the User is not a member, THEN THE System SHALL reject the request, return an authorization error indicating the User is not a member of that Household, and return no Household data.
6. WHERE an Active_Household has 2 or more member Users, WHEN any authenticated member of that Active_Household commits a change to shared Household data, THE System SHALL persist the change and make it visible to every other member of that Active_Household on their next read of that data.
7. IF a request for Household data is received without a valid authenticated session, THEN THE System SHALL reject the request, return an authorization error indicating authentication is required, and return no Household data.

### Requirement 2: Ad Hoc Meal Suggestion

**User Story:** As a User, I want to request a meal suggestion right now, so that I can quickly decide what to cook today.

#### Acceptance Criteria

1. WHEN a User requests an Ad_Hoc_Suggestion, THE Suggestion_Agent SHALL return between 1 and 3 Meal_Suggestions, where each Meal_Suggestion includes a non-empty name, an ingredient list containing at least 1 ingredient, and preparation steps containing at least 1 step.
2. WHEN a User requests an Ad_Hoc_Suggestion, THE Suggestion_Agent SHALL generate each Meal_Suggestion using the Household Preference_Profile such that the Meal_Suggestion excludes every ingredient marked as excluded in the Preference_Profile.
3. IF a Household Preference_Profile does not exist when a User requests an Ad_Hoc_Suggestion, THEN THE Suggestion_Agent SHALL generate the Meal_Suggestion without preference filtering and return an indication that no Preference_Profile was applied.
4. IF the Suggestion_Agent cannot generate a Meal_Suggestion, THEN THE System SHALL return a message indicating that no suggestion is available and indicating the reason, and SHALL preserve the request session so the User can retry.
5. WHEN a User rejects an Ad_Hoc_Suggestion and requests another within the same request session, THE Suggestion_Agent SHALL return a Meal_Suggestion whose name differs from the name of every Meal_Suggestion already rejected in that request session.
6. IF the Suggestion_Agent cannot produce a Meal_Suggestion that differs from all previously rejected suggestions within the same request session, THEN THE System SHALL return a message indicating that no further distinct suggestions are available.
7. WHEN a User requests an Ad_Hoc_Suggestion, THE Suggestion_Agent SHALL return the Meal_Suggestion within 10 seconds, and IF generation exceeds 10 seconds, THEN THE System SHALL return a timeout message indicating that no suggestion was produced in time.

### Requirement 3: Weekly Meal Plan Generation

**User Story:** As a User, I want to generate a full week of meals, so that we do not have to decide what to cook each day.

#### Acceptance Criteria

1. WHEN a User requests a Weekly_Plan, THE Suggestion_Agent SHALL generate a Meal_Plan containing exactly one Meal assigned to each of the seven days, with no day left unassigned.
2. WHEN a User requests a Weekly_Plan, THE Suggestion_Agent SHALL generate the Meal_Plan using the Household Preference_Profile as the source of allowed and excluded Meals.
3. IF a Household has no Preference_Profile when a Weekly_Plan is requested, THEN THE Suggestion_Agent SHALL reject the request and return an error indicating that a Preference_Profile is required, and SHALL NOT store a Meal_Plan.
4. IF the Suggestion_Agent cannot generate a Meal for every day within 30 seconds of the request, THEN THE System SHALL reject the request and return an error indicating generation failed, and SHALL NOT store a partial Meal_Plan.
5. WHEN a Weekly_Plan is generated, THE System SHALL store the Meal_Plan and associate the Meal_Plan with the requesting Household.
6. WHEN a User replaces a single Meal within a Weekly_Plan, THE System SHALL update only that day's Meal and SHALL leave the Meals on all other days unchanged.
7. WHERE a User specifies a date range between 1 and 31 days inclusive, THE Suggestion_Agent SHALL generate exactly one Meal for each day in the specified range.
8. IF a User specifies a date range of fewer than 1 day or more than 31 days, THEN THE Suggestion_Agent SHALL reject the request and return an error indicating the allowed range is 1 to 31 days, and SHALL NOT store a Meal_Plan.

### Requirement 4: Contextual Input

**User Story:** As a User, I want to tell the app what is in the fridge or what I am craving, so that suggestions use what we already have and match what we want.

#### Acceptance Criteria

1. WHEN a User submits Context_Input with a suggestion request, THE Suggestion_Agent SHALL incorporate the Context_Input into the generated Meal_Suggestion.
2. IF a submitted Context_Input exceeds 500 characters, THEN THE Suggestion_Agent SHALL reject the request and return an error indication identifying the length limit, and SHALL NOT generate a Meal_Suggestion.
3. WHEN a User records Fridge_Inventory items, THE System SHALL store the Fridge_Inventory and associate the Fridge_Inventory with the Household.
4. IF a recorded Fridge_Inventory contains zero valid items, THEN THE System SHALL reject the recording and return an error indication identifying that at least one item is required, and SHALL preserve the previously stored Fridge_Inventory for that Household.
5. WHERE one or more Fridge_Inventory items are available for the Household, THE Suggestion_Agent SHALL rank Meals that use at least one recorded Fridge_Inventory item above Meals that use none.
6. WHEN a User updates Fridge_Inventory, THE System SHALL replace the previous Fridge_Inventory with the updated items for that Household within 3 seconds.

### Requirement 5: Presets

**User Story:** As a User, I want to pick a preset like healthy or quick, so that suggestions match the kind of meal I want at that moment.

#### Acceptance Criteria

1. THE System SHALL provide exactly four named Presets: healthy, quick, craving, and fine dining.
2. WHEN a User selects a Preset for a suggestion request, THE Suggestion_Agent SHALL generate a Meal_Suggestion that reflects the selected Preset's defining attribute.
3. WHERE no Preset is selected for a suggestion request, THE Suggestion_Agent SHALL generate the Meal_Suggestion using the Household Preference_Profile without Preset shaping.
4. WHEN a User selects more than one Preset for a single request, THE Suggestion_Agent SHALL generate a Meal_Suggestion that reflects the defining attribute of every selected Preset.
5. IF a User selects a combination of Presets whose defining attributes conflict such that no single Meal_Suggestion can satisfy all of them, THEN THE System SHALL reject the request and return an error indicating the Presets conflict, and SHALL NOT generate a Meal_Suggestion.
6. IF a User selects a Preset that is not one of the four named Presets, THEN THE System SHALL reject the request and return an error indicating the Preset is unrecognized.

### Requirement 6: Preference Learning

**User Story:** As a User, I want the app to learn our likes and dislikes, so that suggestions get better over time without us re-entering preferences.

#### Acceptance Criteria

1. WHEN a User submits Feedback with a value of like or dislike on a Meal_Suggestion, THE System SHALL store the Feedback and associate it with the Household Preference_Profile within 2 seconds.
2. IF storing Feedback fails, THEN THE System SHALL leave the Preference_Profile unchanged and return an error indication that the Feedback was not saved.
3. WHEN a User accepts a Meal_Suggestion into a Meal_Plan, THE System SHALL record the acceptance in the Household Preference_Profile.
4. WHEN the Suggestion_Agent generates a Meal_Suggestion, THE Suggestion_Agent SHALL use the Household Preference_Profile as it exists at the time of generation as input.
5. WHEN a User submits an explicit dietary constraint that is non-empty and at most 200 characters, THE System SHALL store the dietary constraint in the Household Preference_Profile.
6. IF a submitted dietary constraint is empty, exceeds 200 characters, or duplicates an existing dietary constraint, THEN THE System SHALL reject it, leave the Preference_Profile unchanged, and return an error indication identifying the reason.
7. WHILE a dietary constraint is recorded in the Preference_Profile, THE Suggestion_Agent SHALL exclude from every Meal_Suggestion any Meal whose recorded ingredients or attributes match the items excluded by that dietary constraint.

### Requirement 7: Grocery List Generation

**User Story:** As a User, I want a shopping list built from our planned meals, so that we know exactly what to buy.

#### Acceptance Criteria

1. WHEN a User requests a Grocery_List for a Meal_Plan, THE System SHALL generate a Grocery_List containing the ingredients of every Meal in the Meal_Plan.
2. WHEN the System generates a Grocery_List and the same ingredient measured in the same unit appears in multiple Meals, THE System SHALL combine those occurrences into a single entry whose quantity is the sum of the occurrences.
3. IF the same ingredient appears in multiple Meals with incompatible units, THEN THE System SHALL list each incompatible-unit occurrence as a separate entry rather than summing them.
4. WHERE Fridge_Inventory items are recorded, THE System SHALL subtract the available Fridge_Inventory quantity from the required quantity of each matching ingredient and SHALL omit from the Grocery_List any ingredient whose required quantity is fully covered by the Fridge_Inventory.
5. WHEN a User adds or removes a Meal in a Meal_Plan after a Grocery_List exists, THE System SHALL regenerate the Grocery_List to reflect the current Meals in the Meal_Plan.
6. IF a Grocery_List is requested for a Meal_Plan containing zero Meals, THEN THE System SHALL return an empty Grocery_List.
7. WHEN the System generates a Grocery_List, THE System SHALL associate the Grocery_List with the Meal_Plan and the Household.

### Requirement 8: AWS and Bedrock AgentCore Platform

**User Story:** As the product owner, I want the application built entirely on AWS using Bedrock AgentCore, so that the architecture matches our infrastructure standards.

#### Acceptance Criteria

1. THE System SHALL run all backend compute, storage, and networking components on AWS services, with no backend component running on non-AWS infrastructure.
2. THE System SHALL use Amazon Bedrock AgentCore to run the Suggestion_Agent.
3. WHEN the Suggestion_Agent generates a Meal_Suggestion or Meal_Plan, THE System SHALL invoke the Suggestion_Agent through Amazon Bedrock AgentCore.
4. IF an invocation of the Suggestion_Agent through Amazon Bedrock AgentCore fails or does not return a result within 30 seconds, THEN THE System SHALL abort the pending request, retain any previously persisted data unchanged, and return an error indication to the caller stating that suggestion generation was unavailable.
5. THE System SHALL persist Household data, Preference_Profiles, Meal_Plans, Fridge_Inventory, and Grocery_Lists in AWS-managed storage.
6. IF a write to AWS-managed storage fails, THEN THE System SHALL leave the affected record in its prior persisted state and return an error indication to the caller stating that the save operation did not complete.

### Requirement 9: Conversational Refinement via Chat

**User Story:** As a User, I want to refine suggestions, plans, and grocery lists by chatting with the app, so that I can adjust results in plain language without starting over.

#### Acceptance Criteria

1. WHEN a User sends a chat message within a Conversation requesting a refinement to the current Meal_Suggestion, THE Suggestion_Agent SHALL return an updated Meal_Suggestion that reflects the requested change and that preserves the attributes of the current Meal_Suggestion not affected by the request.
2. WHEN a User sends a chat message within a Conversation requesting a refinement to a single Meal of a Meal_Plan identified by its day, THE Suggestion_Agent SHALL update only the Meal assigned to that day and SHALL leave the Meals on all other days unchanged.
3. WHEN a User sends a chat message within a Conversation, THE Suggestion_Agent SHALL use the prior turns of that Conversation as context so that the returned artifact reflects both the current message and the accumulated refinements of that Conversation.
4. WHEN a User sends a chat message within a Conversation requesting a refinement to a Grocery_List, THE System SHALL return an updated Grocery_List that reflects the requested change.
5. IF a refinement request within a Conversation is ambiguous or cannot be fulfilled, THEN THE System SHALL return a clarification prompt or an error indicating that the change could not be applied, and SHALL leave the prior artifact unchanged.
6. WHEN a User sends a chat message within a Conversation requesting a refinement, THE Suggestion_Agent SHALL return the updated artifact or a clarification response within 15 seconds, and IF the refinement exceeds 15 seconds, THEN THE System SHALL return a timeout message indicating that the refinement did not complete in time and SHALL leave the prior artifact unchanged.
7. THE System SHALL associate each Conversation with the Active_Household of the User, and THE Suggestion_Agent SHALL refine only artifacts belonging to that Active_Household.

### Requirement 10: Household Creation and Membership

**User Story:** As a User, I want to create a household and invite others to join it, so that each household has its own private meal plans, preferences, and grocery lists.

#### Acceptance Criteria

1. WHEN an authenticated User creates a Household, THE System SHALL create a new Household, assign the creating User as the Household_Owner and a member, and isolate the new Household's data from the data of all other Households.
2. WHEN a Household_Owner invites a person identified by an email address or user identifier to a Household, THE System SHALL create an Invitation with a status of pending that is associated with that Household and that specified person.
3. WHEN an invited person accepts an Invitation whose status is pending and whose expiry time has not passed, THE System SHALL add the invited person as a member of the associated Household and SHALL grant that member access to that Household's data.
4. IF a person attempts to accept an Invitation whose status is not pending or whose expiry time has passed, THEN THE System SHALL reject the acceptance, return an error indicating the Invitation is invalid, already used, declined, or expired, and SHALL NOT add the person as a member.
5. WHEN a pending Invitation remains unaccepted for 7 days after creation, THE System SHALL set the Invitation status to expired and SHALL reject any subsequent acceptance of that Invitation.
6. WHEN a User who is a member of 2 or more Households selects a Household of which the User is a member as the Active_Household, THE System SHALL scope all of that User's subsequent operations and data access to the selected Active_Household and SHALL exclude data belonging to every other Household.
7. WHEN a Household_Owner removes a member from a Household, THE System SHALL revoke that member's access to that Household's data.
8. IF a Household_Owner attempts to remove the Household_Owner from the Household, THEN THE System SHALL reject the removal and return an error indicating the Household_Owner cannot be removed from the Household.

### Requirement 11: Voice Input

**User Story:** As a User, I want to speak my input instead of typing, so that I can describe fridge contents, cravings, and chat refinements faster and hands-free.

#### Acceptance Criteria

1. WHEN a User submits a Voice_Input for recording Fridge_Inventory, submitting Context_Input, or sending a Conversation refinement message, THE System SHALL transcribe the Voice_Input to a Transcript and process the Transcript as the equivalent typed input for that same operation.
2. THE System SHALL accept Voice_Input in each place free-text or chat input is accepted, specifically Fridge_Inventory recording, Context_Input submission, and Conversation refinement message sending.
3. WHEN the System produces a Transcript from a Voice_Input, THE System SHALL present the Transcript to the User for confirmation or correction and SHALL apply the Transcript to the target operation only after the User confirms the Transcript.
4. IF transcription of a Voice_Input fails or produces no recognizable text, THEN THE System SHALL return an error indicating the Voice_Input could not be understood, SHALL prompt the User to retry, and SHALL leave previously stored data unchanged.
5. WHEN a User submits a Voice_Input, THE System SHALL return either a Transcript or an error indication within 15 seconds, and IF transcription exceeds 15 seconds, THEN THE System SHALL return a timeout error indicating the Voice_Input was not transcribed in time and SHALL leave previously stored data unchanged.
6. THE System SHALL scope each Voice_Input and its Transcript to the Active_Household of the submitting User and SHALL apply the resulting Transcript only to data belonging to that Active_Household.
7. WHEN the System transcribes a Voice_Input, THE System SHALL perform the transcription using AWS-managed services, consistent with running all backend components on AWS.

### Requirement 12: Suggestion_Agent Behavior and Output Contract

**User Story:** As the product owner, I want the Suggestion_Agent to accept the System's generation requests and always answer in a structure the System can validate, so that suggestions, plans, and refinements are reliable and respect household preferences.

#### Acceptance Criteria

1. WHEN the Suggestion_Agent receives a generation request in ad hoc, plan, or refine mode, THE Suggestion_Agent SHALL return either a response that conforms to the Agent_Response_Contract for that same mode or an error indication, and SHALL NOT return a success response that does not conform to the Agent_Response_Contract for that mode.
2. IF the Foundation_Model output for a generation request does not conform to the Agent_Response_Contract for the requested mode, THEN THE Suggestion_Agent SHALL request exactly one corrected output from the Foundation_Model that states the nonconformity, and IF the corrected output also does not conform, THEN THE Suggestion_Agent SHALL return an error indication stating that generation failed.
3. IF a generation request is malformed, names an unrecognized mode, or carries a preference-memory namespace that differs from its Household identifier, THEN THE Suggestion_Agent SHALL reject the request with an error indication, SHALL NOT invoke the Foundation_Model, and SHALL NOT read long-term preference memory.
4. WHEN the Suggestion_Agent receives a plan-mode request for N days, THE Suggestion_Agent SHALL return either exactly N Meals in day order or an error indication.
5. WHEN the Suggestion_Agent receives an ad-hoc-mode request, THE Suggestion_Agent SHALL return at most 3 Meal_Suggestions, none of whose names equals, ignoring case and surrounding whitespace, a rejected Meal_Suggestion name listed in the request.
6. IF the Foundation_Model output contains a Meal with an ingredient listed as excluded in the received Preference_Profile, THEN THE Suggestion_Agent SHALL remove that Meal from an ad-hoc-mode response, and SHALL treat a plan-mode or refine-mode output containing such a Meal as nonconforming under criterion 12.2.
7. WHEN the Suggestion_Agent generates Meals, THE Suggestion_Agent SHALL provide the Foundation_Model with the defining attribute of every selected Preset, the Context_Input, the Fridge_Inventory items as preferred ingredients, the excluded ingredients and dietary constraints of the received Preference_Profile as items to avoid, the rejected Meal_Suggestion names, and, in plan mode, the requested number of days.
8. WHERE a generation request includes Soft_Preferences, THE Suggestion_Agent SHALL use the included Soft_Preferences and SHALL NOT read long-term preference memory for that request.
9. WHERE a generation request does not include Soft_Preferences, THE Suggestion_Agent SHALL read long-term preference memory only at the namespace equal to the request's Household identifier and SHALL provide the result to the Foundation_Model as Soft_Preferences that do not override excluded ingredients or dietary constraints.
10. IF reading long-term preference memory fails or exceeds its time budget, THEN THE Suggestion_Agent SHALL continue generation without Soft_Preferences.
11. THE Suggestion_Agent SHALL NOT write Conversation turns or preference records to AgentCore Memory.
12. WHEN the Suggestion_Agent receives a refine-mode request, THE Suggestion_Agent SHALL return either an updated artifact of the request's target artifact type or a clarification message, and for a Meal_Plan target SHALL return an updated Meal only for a day present in the Meal_Plan being refined.
13. THE Suggestion_Agent SHALL return its response or an error indication within 8 seconds of receiving an ad-hoc-mode request, within 13 seconds of receiving a refine-mode request, and within 26 seconds of receiving a plan-mode request.
14. WHILE the Suggestion_Agent is able to accept generation requests, THE Suggestion_Agent SHALL answer health checks from Amazon Bedrock AgentCore with a healthy status.

### Requirement 13: Web and Mobile Client

**User Story:** As a User, I want a clean, fast app on my phone and computer, so that my household and I can use every Sous feature without a separate native app.

#### Acceptance Criteria

1. THE Client_App SHALL present every screen without horizontal scrolling on viewport widths from 320 to 1920 CSS pixels.
2. THE Client_App SHALL be installable to a device home screen and, WHEN opened without network connectivity, SHALL display its application shell with a message stating that the device is offline.
3. WHEN a User submits valid sign-in credentials in the Client_App, THE Client_App SHALL authenticate through the System's sign-in operation and retain the resulting session until the User signs out or the session can no longer be renewed.
4. WHEN a person submits an email address and a password of 8 to 128 characters on the Client_App sign-up screen, THE Client_App SHALL register the person as a User and request the emailed confirmation code, and WHEN the person submits a valid confirmation code, THE Client_App SHALL confirm the registration and direct the person to sign in.
5. WHEN the Client_App sends a request for Household data, THE Client_App SHALL include the User's session identity token and the identifier of the Active_Household, and THE Client_App SHALL NOT send a request for Household data while no Active_Household is selected.
6. WHEN an authenticated User opens the Client_App, THE System SHALL provide the list of Households of which the User is a member, and THE Client_App SHALL let the User select one of them as the Active_Household or, IF the list is empty, prompt the User to create a Household.
7. WHEN a Household_Owner creates an Invitation in the Client_App, THE Client_App SHALL display an Invitation_Link for that Invitation, and WHEN an authenticated invitee opens the Invitation_Link, THE Client_App SHALL let the invitee accept or decline the Invitation and display the outcome returned by the System.
8. WHEN a member of the Active_Household opens the members screen, THE System SHALL provide the list of members with their roles, and THE Client_App SHALL show a remove control only to the Household_Owner and only for members other than the Household_Owner.
9. WHILE a User edits Context_Input or a dietary constraint in the Client_App, THE Client_App SHALL display the remaining character count and SHALL prevent submission of Context_Input longer than 500 characters or a dietary constraint that is empty or longer than 200 characters.
10. WHEN a User selects a combination of Presets that conflict, THE Client_App SHALL identify the conflicting Presets and SHALL prevent submission of the suggestion request until the conflict is resolved.
11. WHEN a User rejects a displayed Ad_Hoc_Suggestion and asks for another, THE Client_App SHALL send a new request within the same request session that identifies every Meal_Suggestion the User has rejected in that session.
12. WHEN a User opens a Meal_Plan in the Client_App, THE System SHALL provide that Meal_Plan with its Meals, and THE Client_App SHALL let the User generate a Weekly_Plan or a plan of 1 to 31 days, and replace, add, or remove the Meal of a single day.
13. WHEN a User opens the Grocery_List of a Meal_Plan, THE System SHALL provide the most recently generated Grocery_List of that Meal_Plan, and THE Client_App SHALL let the User generate the Grocery_List and mark entries as checked, retaining the checked state on that device for that Grocery_List.
14. THE Client_App SHALL provide screens for editing Fridge_Inventory, submitting like or dislike Feedback, adding dietary constraints, and refining a Meal_Suggestion, Meal_Plan, or Grocery_List in a Conversation, and WHEN the System returns a clarification for a refinement, THE Client_App SHALL display the clarification and leave the displayed artifact unchanged.
15. WHERE the Client_App accepts free-text input for Fridge_Inventory, Context_Input, or a Conversation message, THE Client_App SHALL offer Voice_Input and SHALL display the returned Transcript for the User to confirm or correct before the Transcript is applied.
16. WHEN the System returns an error to the Client_App, THE Client_App SHALL display a message specific to the returned error code, and IF the error code is not recognized, THEN THE Client_App SHALL display a generic failure message; WHILE a request is pending, THE Client_App SHALL display a loading indicator, and WHEN a list has no items, THE Client_App SHALL display an empty-state message.
17. IF the System reports that authentication is required, THEN THE Client_App SHALL attempt to renew the session once and, IF renewal fails, SHALL discard the session and all displayed Household data and show the sign-in screen.
18. WHEN a User signs out, THE Client_App SHALL discard the session, the selected Active_Household, and all cached Household data on that device.
19. THE Client_App SHALL meet WCAG 2.1 level AA for color contrast, keyboard operability, and accessible names of interactive controls, in both a light and a dark color scheme, defaulting to the device's color-scheme preference.
20. THE System SHALL serve the Client_App only over HTTPS, redirect HTTP requests to HTTPS, return the application shell for any in-app path, keep the hosted files inaccessible except through the delivery endpoint, and send a content security policy, strict transport security, content-type sniffing protection, and frame-embedding denial with every response.

### Requirement 14: Audio Format Conversion

**User Story:** As a User, I want voice input to work in every browser I use, including on my iPhone, so that I can speak instead of type wherever I am.

#### Acceptance Criteria

1. WHEN a User records a Voice_Input in the Client_App on a browser that supports audio processing, THE Client_App SHALL encode the recording as 16 kHz mono 16-bit little-endian PCM before upload.
2. WHERE the browser does not support audio processing, THE Client_App SHALL upload the recording in Ogg/Opus if the browser can record Ogg/Opus, and otherwise in the WebM or MP4 format the browser records.
3. WHILE a User records a Voice_Input, THE Client_App SHALL display the remaining recording time, SHALL stop recording automatically after 30 seconds, and SHALL NOT upload audio larger than 1,000,000 bytes.
4. WHEN the System receives a Voice_Input in an Accepted_Audio_Format, THE System SHALL transcribe the audio without invoking the Audio_Converter.
5. WHEN the System receives a Voice_Input declared as a Convertible_Audio_Format whose leading bytes match that container, THE Audio_Converter SHALL convert it to 16 kHz mono 16-bit little-endian PCM before transcription.
6. IF a Voice_Input declared as a Convertible_Audio_Format has leading bytes that do not match the declared container, or is declared with a content type that is neither an Accepted_Audio_Format nor a Convertible_Audio_Format, THEN THE System SHALL reject the Voice_Input with an unsupported-audio error and SHALL NOT invoke the Audio_Converter.
7. IF a Voice_Input exceeds 1,000,000 bytes before conversion, or its converted audio would exceed 1,000,000 bytes, THEN THE System SHALL reject the Voice_Input with an audio-too-large error and SHALL NOT transcribe it.
8. IF the Audio_Converter fails to convert a Voice_Input, THEN THE System SHALL return an error indicating the Voice_Input could not be processed, SHALL prompt the User to retry, and SHALL leave previously stored data unchanged.
9. WHEN the System receives a Voice_Input that requires conversion, THE System SHALL complete conversion and transcription, or return an error indication, within the 15-second bound of criterion 11.5.
10. THE Audio_Converter SHALL select its conversion settings only from the detected container format and SHALL NOT pass any value supplied in the request, other than the audio bytes, to the conversion process.
