# Single-hook model-request retry design

Date: 2026-11-14
Status: Approved for implementation

## Problem

`dsh-server-error-continue` 2.4.2 is reliable in its 66 mocked boundary tests, but its recovery behavior depends on ten event hooks plus private Agent inbox/session behavior. Turn restarts, queued prompts, model failover, and replay-routing account for most upgrade sensitivity; they are not required to retry a failed model request.

The desired outcome is a smaller plugin that retries transient connection failures across providers through one stable Host extension point, without changing turn history, model selection, or user-visible messages.

## Chosen approach

Use only the public `agent/request-error` waterfall. DSH's built-in `llm-retry` remains the first recovery owner when present. This plugin handles eligible failures left unhandled by the native retryer, with a bounded budget and cancellation.

Version 3.0.0 is a deliberate behavior change, not a feature-compatible release.

## Public surface retained

- `agent/request-error`: classify the failure, delegate through `next()`, wait with cancellation, and return `{ kind: 'retry' }` only when this plugin owns another attempt.
- `ctx.agents.get(agent.id)`: verify that the same Agent still exists after a wait.
- `ctx.effect`: abort pending waits and drain in-flight recovery during disposal.
- `ctx.logger`: report retries, exhaustion, ignored legacy configuration, and skipped policy outcomes.

No other Host events or private Agent methods are used. The plugin injects no system-prompt context, continuation text, or user/assistant messages; it does not mutate durable history or own the Agent lifecycle. Normal requests and successful turns are completely untouched.

## Surface removed

- Turn restart prompts and `agent.followup()`.
- Inbox reads/removals and inbox lifecycle events.
- `session/event`, `agent/status`, `agent/pre-step`, and `agent/request` listeners.
- Emergency `fallbackProvider` / `fallbackModel` route changes and model-selection notices.
- Replay-schema route switching and restart-prompt rendering.

`maxRestarts`, `fallbackProvider`, `fallbackModel`, and legacy `prompt` are accepted only as ignored legacy keys with a warning. They have no behavioral effect.

## Recovery algorithm

1. A content-filter outcome returns immediately without calling downstream recovery, so even an always-retry owner cannot bypass policy filtering.
2. Call `next()` and preserve any downstream recovery decision or thrown error.
3. If a provider `always` policy exists, leave recovery to that policy.
4. If a provider `normal` policy manages the failure code, treat its budget as authoritative and add no second retry budget.
5. Classify permanent facts first: authentication/permission, quota/billing, context overflow, invalid request/schema/model, missing model, unsupported effort, content policy, and other 4xx failures do not retry.
6. Retry eligible transient failures when no policy owns them:
   - `SERVER`, `TIMEOUT`, `TRANSPORT`, `RATE_LIMIT`, `EMPTY_RESPONSE`;
   - HTTP 408, 425, 429, and 5xx;
   - connection reset/refused/terminated, timeout, EOF, incomplete chunked response, missing terminal response, and equivalent gateway wording;
   - configured wrapper-code text and approved replay/transport overrides.
7. Wait with exponential backoff from `delayMs` to `maxDelayMs`, honoring a bounded provider `Retry-After`. Abort on user cancellation, Agent replacement, or plugin disposal.
8. Return `{ kind: 'retry' }` so DSH re-runs the same open step over the same durable history. Never insert a user message or start a new turn.

`maxContinues` remains the per-step additional-attempt budget. Zero retains its existing explicit unlimited-opt-in meaning; the default remains finite. No restart or failover stage follows exhaustion.

## Compatibility and migration

- Preserve `delayMs`, `maxDelayMs`, `maxContinues`, `codes`, `messageIncludes`, `excludeIncludes`, and `retryUnclassified` semantics.
- Update `cordis.patch.yml` to remove restart/fallback keys and use a finite default retry budget.
- Document that native provider `normal` policies are not supplemented after exhaustion; users needing more attempts should configure this plugin's fallback budget for uncovered codes or adjust provider policy deliberately.
- Mark 3.0.0 as requiring migration away from turn restarts and emergency model switching.

## Test design

TDD begins with failing tests that prove the new boundary before refactoring:

- `apply()` registers only `agent/request-error`; an Agent with no inbox, followup, session, or model-selection API works.
- Legacy restart/fallback keys warn and do not create prompts or route changes.
- Each normalized transient code retries without provider policy.
- Connection reset, mid-stream disconnect, incomplete payload, missing terminal event, and encrypted-reasoning transient overrides retry; permanent and policy failures do not.
- Native `normal` policy exhaustion adds no retry; native `always` remains the owner; downstream decisions and exceptions propagate.
- Budget exhaustion, backoff, Retry-After, user stop, Agent replacement, and disposal behave exactly as specified.

Retain the useful existing classifier tests and delete tests for removed behavior. Add CI/runtime evidence on Node 20, 22, and 24, plus a real Cordis mount/disposal check on the current DSH rc3 installation without a paid model request.

## Rollout and rollback

1. Write the tests and observe expected failures on the invasive implementation.
2. Replace the implementation with the single-hook recovery path and update configuration/docs.
3. Run syntax, unit, coverage, and real Cordis mount checks.
4. Review the final diff for accidental private API use and update `VERIFICATION.md` with evidence boundaries.

Rollback restores the 2.4.2 package. No migration of session history is required because version 3 adds no messages and changes no model-selection state.

## Evidence boundaries

Unit and Cordis checks prove retry decisions, cancellation, and API surface. They do not prove every provider's live outage behavior or guarantee that a transient service returns within the finite budget. Direct `ctx.llm.stream()` calls outside the agent loop and failures before stream creation remain outside this plugin's boundary.
