# ChatGPT Plan Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional, officially authorized ChatGPT-plan text inference as a provider for OpenWhispr Transcript Studio without copying Codex credentials or requiring an OpenAI API key.

**Architecture:** Gate implementation on OpenAI's current Sign in with ChatGPT plan-use documentation and the fork's eligibility. Use a main-process-only OAuth/session store and narrow IPC provider service; the renderer receives connection/model/capability status and inference output, never bearer/refresh tokens. Integrate as an optional provider in the existing inference registry; keep local and existing BYOK providers fully functional.

**Tech Stack:** Electron main/preload IPC, TypeScript/Node.js >=24, system secure credential store/keychain, OAuth 2.0 Authorization Code + PKCE, eligible Responses streaming API, existing `src/services/ai/inferenceProviders` registry.

**Spec:** `docs/superpowers/specs/2026-10-29-openwhispr-integrated-studio-design.md`

## Global Constraints

- Only documented official Sign in with ChatGPT plan-use APIs and grants; no undocumented `chatgpt.com/backend-api` or reading Codex CLI's local credentials.
- Do not promise universal availability: required grants, supported models, scopes and plan limits must be verified on an eligible account during execution.
- Sign-in is explicit user action. Transcripts are not transmitted to a remote service without the user's informed choice.
- Only text-model operations; no audio/video transcription via ChatGPT plan.
- Credentials stored securely by main process, never in renderer localStorage, environment logging, Git, or MCP responses.
- Retain existing local inference and API key options as fallback; never silently switch to a paid API route.

## Review Focus

1. Fork/account cannot obtain required plan-use grant: fail closed, show unavailable, leave local model unaffected. [Task 1]
2. Invalid callback state, PKCE verifier, host ID rotation: reject and don't persist tokens. [Task 2]
3. Expired/revoked token or account switch mid-request: stop and clear only affected session. [Task 3]
4. Unsupported model, 429/rate limit or partial Responses stream: report error without applying an edit. [Task 4]
5. Permission revoked or remote mode disabled: no text exfiltration or silent API-key fallback. [Task 5]

---

## File Structure

- Create `docs/custom/chatgpt-plan-eligibility.md`: capability/registration/limitations decision record.
- Create `src/custom-features/chatgpt-plan/auth/hostIdentity.ts`: stable opaque host identifier.
- Create `src/custom-features/chatgpt-plan/auth/oauthFlow.ts`: authorization PKCE/state validation (main-process contract; exact APIs set after eligibility).
- Create `src/custom-features/chatgpt-plan/auth/sessionStore.ts`: secure credential store.
- Create `src/custom-features/chatgpt-plan/provider/planResponses.ts`: eligible text-only inference adapter.
- Create `src/services/ai/inferenceProviders/chatgptPlan.ts`: registry-facing provider.
- Modify `src/services/ai/inferenceProviders/index.ts`: optional provider registration.
- Modify `src/models/ModelRegistry.ts` and settings UI only once capability model catalog is verified.
- Modify main/preload IPC registration and `src/types/electron.ts` to add minimal authorization/status/inference methods.
- Tests `test/services/chatgptPlanEligibility.test.js`, `test/services/chatgptPlanOAuth.test.js`, `test/services/chatgptPlanSession.test.js`, `test/services/chatgptPlanResponse.test.js`, `test/services/chatgptPlanGuardrails.test.js`.

### Task 1: Eligibility and Supported-Flow Verification (No Credential Collection)

**Files:** Create `docs/custom/chatgpt-plan-eligibility.md`; test `test/services/chatgptPlanEligibility.test.js`.

**Interfaces:** `assessPlanUseCapabilities(input:{registrationAllowed:boolean; scopes:string[]; models:string[]; textResponsesSupported:boolean}): {eligible:boolean; reasons:string[]}`.

- [ ] **Step 1:** Add failing tests for missing grant, unsupported Responses path, empty model list and eligible text model; unavailable state never invokes ChatGPT network route.
- [ ] **Step 2:** Run targeted test and confirm failure.
- [ ] **Step 3:** Review current official docs (registration, sessions, model inference, preview limitations), capture eligibility/allowed operations for this OSS fork in decision record; implement pure gate.
- [ ] **Step 4:** Run tests and verify documentation against a registered test client only after explicit user sign-in.
- [ ] **Step 5:** Commit `docs(auth): gate ChatGPT plan provider on documented eligibility`.

**Stop condition:** If registration/grant cannot be acquired or the use is unsupported, mark this project `BLOCKED`, do not implement unofficial fallback; Transcript Studio continues with local inference.

### Task 2: Official OAuth Registration, Host Identity and Secure Sign-In

**Files:** Create `auth/hostIdentity.ts`, `auth/oauthFlow.ts`, `auth/sessionStore.ts`; test `test/services/chatgptPlanOAuth.test.js`.

**Interfaces:** `getOrCreateHostId():Promise<string>` with supported stable `urn:uuid:` format (or documented JWK thumbprint); `startPlanSignIn():Promise<{authorizationUrl:string;stateHandle:string}>`; `finishPlanSignIn(callbackUrl:string):Promise<{connected:boolean;accountLabel:string}>` with PKCE/state/issuer validation; renderer never sees credentials.

- [ ] **Step 1:** Write failing tests: stable host ID, duplicate callback rejected, state mismatch rejected, token in renderer/console never exposed, repeated sign-in reuses registration where permitted.
- [ ] **Step 2:** Run targeted test; confirm failure.
- [ ] **Step 3:** Implement official browser registration/sign-in/PKCE flow in main; secure token storage and minimal status-only IPC; use system-provided secure storage facility, not plaintext files.
- [ ] **Step 4:** Run tests, typecheck and manual sign-in on disposable profile with user approval.
- [ ] **Step 5:** Commit `feat(auth): implement secure ChatGPT plan sign-in`.

### Task 3: Session Refresh, Revocation and Account Isolation

**Files:** Modify `auth/sessionStore.ts`, `auth/oauthFlow.ts`; test `test/services/chatgptPlanSession.test.js`.

**Interfaces:** `withValidPlanSession<T>(accountId:string, operation:(accessToken:string)=>Promise<T>):Promise<T>` main-process only; `signOutPlan(accountId:string):Promise<void>`; account change invalidates active requests.

- [ ] **Step 1:** Add failing tests for expired tokens, refresh races, revoked permissions, sign-out during inference, machine restart, two account scopes, secrets absent from errors.
- [ ] **Step 2:** Confirm red tests.
- [ ] **Step 3:** Implement atomic refresh lock, bounded retry, session/account binding and sign-out; never recycle a token for another profile.
- [ ] **Step 4:** Run targeted tests and typecheck.
- [ ] **Step 5:** Commit `feat(auth): handle plan session lifecycle safely`.

### Task 4: Eligible Responses Text Inference Provider

**Files:** Create `provider/planResponses.ts` and `src/services/ai/inferenceProviders/chatgptPlan.ts`; modify provider registry and typed main IPC; test `test/services/chatgptPlanResponse.test.js`.

**Interfaces:** `runPlanTextInference(input:{accountId:string;model:string;systemPrompt:string;userText:string;requestId:string}): Promise<{text:string;complete:boolean}>`; exported `chatgptPlanProvider: InferenceProvider`. Only official eligible Responses request shape, limits and models; reject incomplete streams.

- [ ] **Step 1:** Write failing mocked tests for complete response assembly, model allowlist, rate limit, cancellation, malformed event, truncated output and no audio support.
- [ ] **Step 2:** Run targeted tests and confirm failure.
- [ ] **Step 3:** Implement the documented plan-use Responses streaming path in the main process and provider adapter. Extend `ProviderContext` narrowly if required by the credential boundary; never send token to renderer.
- [ ] **Step 4:** Run tests and verify a user-authorized end-to-end text request against a test transcript (never private real content).
- [ ] **Step 5:** Commit `feat(ai): add authorized ChatGPT-plan text provider`.

### Task 5: Consent-Based Settings UI and Transcript Studio Integration

**Files:** Modify provider settings UI, `src/models/ModelRegistry.ts`, `src/components/notes/NoteEditor.tsx` or dedicated Transcript Studio provider picker; test `test/services/chatgptPlanGuardrails.test.js`.

**Interfaces:** provider status `unavailable|disconnected|connected|expired|rate_limited`; explicit user choice of local vs plan, and explicit per-session remote-processing consent prior to transmitting transcript text.

- [ ] **Step 1:** Add failing tests: default local; disconnected state no request; remote consent required; sign-out doesn't erase local settings; account switch cancels queued chunks; no automatic BYOK fallback.
- [ ] **Step 2:** Verify red tests.
- [ ] **Step 3:** Add connected-status UI, supported model selector and provider choice; connect to Transcript Studio without altering raw transcription route.
- [ ] **Step 4:** Run provider tests, existing inference/provider tests, full `npm test`, `npm run typecheck` and `npm run lint`.
- [ ] **Step 5:** Commit `feat(ai): expose optional ChatGPT-plan transcript processing`.

## Deliverable / Gate

Users eligible for the official flow can explicitly sign in and select supported plan-based **text** inference. Other users see a clear unavailable/disabled state and retain local model functionality. Never equate an OpenAI API key with ChatGPT plan usage, and never claim usage without actual connection tests.