# Validation record

This file records the evidence behind the plugin's current behavior and its boundaries. It is not a claim that every provider or gateway failure class was exercised end to end.

## Environment

- DSH `0.2.1-rc.2` (Desktop carrier), Node.js 24 on macOS.
- Plugin mounted in a real Cordis context (fiber ACTIVE) and disposed without error.
- CI runs the same checks on Node 20, 22, and 24 on `ubuntu-latest`.

## Automated checks

```sh
node --check index.js
node --test test/plugin.test.mjs
```

Current result: **57 passing, 0 failing, 0 skipped, exit 0**.

Coverage includes:

- permanent-failure precedence: auth/permission, quota/billing, context length, invalid schema/request/API key, model not found/unsupported, content policy, adapter `deferred`/`pending` states;
- unclassified `PI_AI_ERROR`/`UNKNOWN` gateway errors treated as transient by default, and strict allowlist mode with `retryUnclassified: false`;
- transient HTTP status exceptions 408/425/429 versus other 4xx;
- gateway encrypted-reasoning replay faults (`encrypted content ... could not be verified/decrypted`, `previous_response_id ... not found`) retried despite an HTTP 400 / `INVALID_REQUEST` classification, with `excludeIncludes` able to veto the override;
- upstream mid-stream transport breaks (`上游流中途断开`, `TransferEncodingError`, `ConnectionResetError`, incomplete payload/chunked read, "network name no longer available") retried despite HTTP 400 / `INVALID_REQUEST`, while `Response incomplete: content_filter` stays terminal;
- standard transport codes (`SERVER`, `TIMEOUT`, `TRANSPORT`, `RATE_LIMIT`, `EMPTY_RESPONSE`) stay recoverable without a provider retry policy, and `Connection error.` is recognized in normal, strict, and pseudo-400 modes;
- provider retry policies: `normal` exhaustion escalating straight to a turn restart, `always` policies left untouched, misconfigured permanent codes not restarted;
- same-request recovery, other recovery owners taking precedence, user stop/unload cancellation, replaced-agent protection, backoff and `Retry-After` handling;
- turn-restart queuing from the idle transition (not during the failing turn), per-chain budgets, reset on completed turns and real user input, withdrawal when other input arrives, discarded-slot refunds, pending-user/pending-goal precedence, pending automatic notices not blocking a restart, user-stop suppression, `agent/pre-step` reservation checks, unload withdrawal, and `maxRestarts: 0` compatibility;
- emergency failover after both in-step retries and turn restarts are spent: one retry is routed to `fallbackProvider`/`fallbackModel`, the request-header hand-off stops forcing the route once normal selection catches up, an explicit `model/selection` event clears it, the conversation notice is emitted once, and no failover occurs when the route is unconfigured.

The suite is hermetic: it uses Node's mock timers and fake Agent/Cordis boundaries, makes no paid model requests, no SSH connections, and no network calls.

## Observed in real sessions (sanitized)

These observations motivated the compatibility work; session identifiers and local paths are intentionally omitted.

- A long-running session produced four model requests inside one failed step — one original plus three same-request retries — before the turn failed during a multi-minute "overloaded" window. That confirmed the in-step retry path.
- A later `PI_AI_ERROR: Upstream request failed` failure produced only one attempt because the old text allowlist did not match it, which motivated the unclassified-gateway-error fallback.
- A provider-managed `TRANSPORT` failure exhausted the built-in retry budget and failed the turn in an earlier session, which motivated escalation after provider exhaustion.
- A subagent session failed with `encrypted content ... could not be verified` while replaying a reasoning item produced earlier by a different upstream account; the same session history succeeded after a later retry, which motivated the replay-fault transient override.
- A later turn failed with `upstream_error: 上游流中途断开: Response payload is not completed ... TransferEncodingError ... ConnectionResetError`; the adapter classified it as `INVALID_REQUEST` because the text embeds a "400", and the step produced a single attempt before the turn failed. The message is a mid-stream network break, not an invalid request, which motivated the transport-break override. `Response incomplete: content_filter` was also observed and stays permanent.
- Two long goal-driven turns exhausted the built-in provider budget on `TRANSPORT` `Connection error.` (five retries each) and then failed the turn without a restart prompt. Code inspection showed why: the agent-loop turn-error path throws out of the driver, so a `followup()` queued during the failing turn never wakes the agent, and the previous pending-input guard also skipped when an automatic notice was queued. 2.3.0 records a restart intent and queues it from the idle transition instead; pending user prompts and goal rounds still take precedence. 2.3.1 additionally keeps standard transport codes recoverable without a provider policy and recognizes `Connection error.` wording. Both behaviors are covered by unit tests but were not re-verified against a live outage after the change.
- 2.4.0 adds opt-in emergency failover to `deepseek-account/deepseek-flash` after the restart allowance is spent. It is covered by unit tests for routing, header catch-up, explicit-selection clearing and notice generation, but has not been exercised against a real multi-provider outage; the fallback account must be signed in.

## Boundaries not verified

- No live end-to-end verification for every provider/gateway error class or for the automatic turn-restart path under a real long outage.
- GUI presentation of restart prompts was not verified.
- Whether a running DSH host hot-reloads changed Host plugin code depends on HMR and package relinking; restart the host if in doubt.
- The plugin cannot see errors thrown before a model stream starts, nor direct LLM calls outside the agent loop.
