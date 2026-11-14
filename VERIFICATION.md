# Validation record

This file records evidence for the 3.0.0 single-hook implementation. It does not claim that every provider or gateway failure was exercised end to end.

## Environment

- `@deepseek-ai/dsh-agent` `0.2.2-rc.3` in the installed desktop runtime.
- `@deepseek-ai/cordis` `4.1.0`.
- Cordis smoke runtime: Node.js `v24.21.0` through the installed Electron binary on macOS.
- Unit tests also run under the repository's Node.js test runner; CI is configured for the exact minimum Node.js 20.3.0 plus current Node.js 20, 22, and 24.
- No live or paid model request was made.

## Baseline and TDD evidence

The isolated worktree began at `d6d671c` (`v2.4.2`) with **66/66** existing tests passing.

The new single-hook contract was written before the implementation. Corrected RED tests produced **7 behavioral failures** on 2.4.2:

- ten event hooks instead of one;
- legacy restart/fallback behavior instead of warning-only compatibility;
- provider exhaustion escalating to turn restart;
- cancellation and disposal races before the wait was established;
- zero-delay configuration accepted.

Test-harness mistakes were fixed before accepting RED evidence. After the rewrite, the core suite passed **19/19**. The expanded matrix then passed **39/39**; four review regression tests brought the final matrix to **43/43**.

## Automated checks

```sh
node --check index.js
node --test --test-timeout=10000 test/plugin.test.mjs
```

Current result: **43 passing, 0 failing, 0 cancelled, 0 skipped, exit 0**. Coverage: **99.22% lines, 92.36% branches, 97.30% functions** (`node --test --experimental-test-coverage`). `git diff --check` passes and `npm pack --dry-run` contains nine intended runtime/docs files (13.2kB), with no development plans or test artifacts.

Coverage includes:

- exactly one registration: `agent/request-error`; an Agent exposing only `id` needs no private API;
- normalized `SERVER`, `TIMEOUT`, `TRANSPORT`, `RATE_LIMIT`, and `EMPTY_RESPONSE` retries without provider policy;
- provider wrapper text, connection reset/refusal, EOF, incomplete chunked responses, missing terminal response events, and encrypted-reasoning transient overrides;
- authentication, quota, context overflow, invalid request/schema/model, unsupported model, content policy, and ordinary 4xx remaining terminal;
- content-filter preemption of a downstream always-retry owner;
- native `normal` policy ownership, native `always` ownership, and downstream decision/error propagation;
- finite and explicitly unlimited budgets, per-step isolation, exponential backoff, bounded Retry-After, user cancellation, Agent replacement, and disposal;
- legacy restart/fallback/prompt keys warning and having no behavioral effect.

Two development-time hangs were fixture errors, not production defects: Retry-After was initially placed at payload level instead of inside `failure`, and the unlimited test advanced 1ms when exponential backoff correctly required 2ms. The fixtures were corrected; tests now have a 10s timeout and use `setImmediate` to flush microtasks before advancing mock time.

## Independent review fixes

A fresh-context reviewer found two Important issues. Both were reproduced before editing:

- Mixed permanent/transport wording could bypass the permanent-failure guard. Terminal codes and permanent text now win before any override; only a pseudo-400 without another permanent fact may use the transport/replay override. Regression matrix: terminal codes cannot be bypassed by transient override wording; permanent text wins over transport overrides under wrapper codes; genuine pseudo-invalid-request transport overrides remain retryable.
- `AbortSignal.any()` requires Node 20.3.0 while the package declared 20.0. The engine is now `>=20.3.0`, CI adds an exact 20.3.0 job, and a metadata regression test locks both values.

The four targeted tests changed from RED to GREEN, followed by the full 43/43 suite, coverage, Cordis smoke, package dry-run, and diff check above. The reviewer independently reran the pre-fix suite and reported no Critical findings.

## Real Cordis mount and disposal

Command:

```sh
ELECTRON_RUN_AS_NODE=1 \
DSH_CORDIS_ENTRY="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js" \
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/cordis-mount.mjs
```

Observed output:

```json
{"ok":true,"cordisContext":true,"runtime":"v24.21.0","registeredHooks":["agent/request-error"],"retry":{"kind":"retry"},"effectsDisposed":2,"networkRequests":0}
```

The smoke check mounts the real Cordis `Context`, provides only the minimal `agents` registry, invokes the registered listener with a synthetic `TRANSPORT` failure, and receives `{ kind: "retry" }`. Two effects are Cordis's listener disposer plus the plugin's recovery cleanup; both complete. No network request is issued.

Initial smoke-script adjustments were test setup only: services use `ctx.reflect.provide()` on rc3, and Cordis's real LoggerService replaces the unnecessary capture stub.

## Reduced surface evidence

Version 2.4.2 registered ten event hooks and contained 740 lines in `index.js`. Version 3.0.0 registers one event hook and contains 380 lines.

Removed behavior:

- no prompt/context injection or continuation messages;
- no inbox, followup, session, status, pre-step, request-route, or model-selection listeners;
- no turn restart or emergency model switching;
- no provider replay-route bypass;
- no durable-history reads or writes.

The only retained services are the public request-error waterfall, Agent registry lookup, logger, and effect/disposal support.

## Boundaries not verified

- No live end-to-end outage was injected into every provider or gateway.
- No claim that a provider returns within the finite retry budget.
- Direct `ctx.llm.stream()` calls and model activity outside the agent loop are outside the plugin boundary.
- Real provider adapters may use additional error wording; `retryUnclassified: false`, `messageIncludes`, and `excludeIncludes` remain the explicit controls for site-specific behavior.
- A later prepended listener can change waterfall ownership; production profiles should retain the intended recovery order.
