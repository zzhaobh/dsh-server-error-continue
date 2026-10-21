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

Current result: **45 passing, 0 failing, 0 skipped, exit 0**.

Coverage includes:

- permanent-failure precedence: auth/permission, quota/billing, context length, invalid schema/request/API key, model not found/unsupported, content policy, adapter `deferred`/`pending` states;
- unclassified `PI_AI_ERROR`/`UNKNOWN` gateway errors treated as transient by default, and strict allowlist mode with `retryUnclassified: false`;
- transient HTTP status exceptions 408/425/429 versus other 4xx;
- gateway encrypted-reasoning replay faults (`encrypted content ... could not be verified/decrypted`, `previous_response_id ... not found`) retried despite an HTTP 400 / `INVALID_REQUEST` classification, with `excludeIncludes` able to veto the override;
- provider retry policies: `normal` exhaustion escalating straight to a turn restart, `always` policies left untouched, misconfigured permanent codes not restarted;
- same-request recovery, other recovery owners taking precedence, user stop/unload cancellation, replaced-agent protection, backoff and `Retry-After` handling;
- turn-restart queuing, per-chain budgets, reset on completed turns and real user input, withdrawal when other input arrives, discarded-slot refunds, pending-input and user-stop suppression, `agent/pre-step` reservation checks, unload withdrawal, and `maxRestarts: 0` compatibility.

The suite is hermetic: it uses Node's mock timers and fake Agent/Cordis boundaries, makes no paid model requests, no SSH connections, and no network calls.

## Observed in real sessions (sanitized)

These observations motivated the compatibility work; session identifiers and local paths are intentionally omitted.

- A long-running session produced four model requests inside one failed step — one original plus three same-request retries — before the turn failed during a multi-minute "overloaded" window. That confirmed the in-step retry path.
- A later `PI_AI_ERROR: Upstream request failed` failure produced only one attempt because the old text allowlist did not match it, which motivated the unclassified-gateway-error fallback.
- A provider-managed `TRANSPORT` failure exhausted the built-in retry budget and failed the turn in an earlier session, which motivated escalation after provider exhaustion.
- A subagent session failed with `encrypted content ... could not be verified` while replaying a reasoning item produced earlier by a different upstream account; the same session history succeeded after a later retry, which motivated the replay-fault transient override.

## Boundaries not verified

- No live end-to-end verification for every provider/gateway error class or for the automatic turn-restart path under a real long outage.
- GUI presentation of restart prompts was not verified.
- Whether a running DSH host hot-reloads changed Host plugin code depends on HMR and package relinking; restart the host if in doubt.
- The plugin cannot see errors thrown before a model stream starts, nor direct LLM calls outside the agent loop.
