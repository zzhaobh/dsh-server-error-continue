# @zzhaobh/dsh-server-error-continue

English | [中文](README.zh.md)

A low-intrusion DeepSeek Harness 3.0.0 plugin that retries recoverable connection, rate-limit, and server failures through the public `agent/request-error` waterfall after a model request has failed.

## Stability contract

- **One Host hook only:** `agent/request-error`.
- No system-prompt injection, continuation prompts, or synthetic user/assistant messages.
- No session-history access, inbox operations, `followup()`, or Agent lifecycle ownership.
- No provider/model rewriting, emergency routes, or model switching.
- DSH's native retryer runs first; this plugin handles only eligible failures left unhandled.
- No runtime dependencies or build step. Successful requests and turns are untouched.

## Requirements and installation

- DSH `>=0.2.1-rc.2 <0.3.0`.
- Node.js 20.3.0 or later (the minimum version with `AbortSignal.any()`).
- Host-only; no client UI.

```sh
dsh plugin --profile <profile> add "github:zzhaobh/dsh-server-error-continue#<commit>"
```

For local development:

```sh
dsh plugin --profile <profile> add /path/to/dsh-server-error-continue
```

Restart the Host after installation, upgrade, or removal and verify that the running instance loaded the intended version.

## Migrating from 2.x

Version 3.0.0 removes the high-intrusion features:

- Turn restarts and automatic `continue` prompts.
- Inbox/session/status/pre-step listeners.
- `fallbackProvider` / `fallbackModel` failover.
- Automatic route switching for provider replay item-ID mismatches.

Legacy `prompt`, `maxRestarts`, `fallbackProvider`, and `fallbackModel` keys are accepted only to emit an `ignored legacy keys` warning. They have no effect; remove them from the profile.

A code managed and exhausted by a native provider `normal` policy receives no second plugin budget and no turn restart. Adjust that provider's own `retryPolicy` when its native budget needs to change.

## Configuration

Bundle defaults live in [`cordis.patch.yml`](cordis.patch.yml). A profile patch replaces the whole `config` object rather than deep-merging it, so repeat every key you want to retain.

| Key | Bundle default | Meaning |
|---|---:|---|
| `delayMs` | `1000` | First additional-retry delay, doubled thereafter; must be ≥1 |
| `maxDelayMs` | `30000` | Backoff and accepted `Retry-After` ceiling; must be ≥`delayMs` |
| `maxContinues` | `5` | Additional attempts per failed step; code default is `3`, explicitly overridden to `5` by the bundle |
| `codes` | `["SERVER"]` | Additional recoverable codes; permanent exclusions still win |
| `messageIncludes` | `["server_error", "upstream_error", "overloaded"]` | Extra case-insensitive transient text for wrapper codes |
| `excludeIncludes` | `[]` | Permanent text exclusions, including transient overrides |
| `retryUnclassified` | `true` | Treat unknown `PI_AI_ERROR`/`UNKNOWN` wrappers as transient; `false` selects the strict allowlist |

`maxContinues: 0` is an explicit unlimited-retry opt-in, ending only on cancellation, Agent replacement, or disposal. Keep a finite default for unattended work.

## Recovery order

1. **Content filtering is terminal:** downstream recovery is not called, so even native `always` cannot bypass the policy outcome.
2. Call `next()` and preserve a downstream recovery decision or exception.
3. Leave provider `always` policies in exclusive control.
4. Treat native `normal` policy budgets as authoritative for their managed codes.
5. Permanent facts win: authentication/permission, quota/billing, context overflow, invalid schema/request/parameters, missing/unsupported models, content policy, and non-transient 4xx do not retry.
6. Retry an eligible unhandled failure in the same step, over the same history, with the same provider/model.
7. Honor cancellation and disposal while waiting; after the wait, confirm the original Agent is still registered before returning `{ kind: "retry" }`.

The plugin only returns DSH's native recovery action. The agent loop performs the retry; the plugin never issues its own network request.

## Transient failures covered

- `SERVER`, `TIMEOUT`, `TRANSPORT`, `RATE_LIMIT`, and `EMPTY_RESPONSE`.
- HTTP 408, 425, 429, and 5xx.
- Server, rate-limit, and transport wording wrapped in `PI_AI_ERROR` / `UNKNOWN`.
- Reset/refused/closed connections, socket hang up, EOF, timeout, broken pipe, and unreachable networks.
- Mid-stream upstream disconnects, `TransferEncodingError`, `ConnectionResetError`, incomplete chunked reads, and missing terminal response events.
- Known pseudo-400 gateway affinity failures involving encrypted reasoning verification/decryption or `previous_response_id`.

Set `retryUnclassified: false` to disable optimistic recovery of unknown wrapper text. `excludeIncludes` vetoes text fallback and transient overrides.

This plugin adds no retries for authentication, permission, quota, balance, context overflow, invalid tool/request parameters, missing or unsupported models, content filtering, or ordinary 4xx failures. Explicit terminal codes and permanent facts win even when the text also contains transport or encrypted-reasoning override wording. Explicit native `always`/`normal` policies retain their configured recovery ownership, except that this plugin always vetoes content filtering. Version 3 also never switches models to bypass a provider's replay item-ID rejection.

## Backoff and cancellation

- Backoff doubles from `delayMs` up to `maxDelayMs`.
- A valid `Retry-After` is not shortened; a hint above `maxDelayMs` leaves the failure terminal rather than waiting without a bound.
- User cancellation propagates the original `AbortError`; disposal aborts and drains active recovery.
- Budgets are in-memory only, isolated by Agent + turn + step + signal. No session state is read or persisted.

## Verification and boundaries

```sh
npm test
npm pack --dry-run
```

`test/cordis-mount.mjs` mounts the plugin in the installed Cordis runtime without a model request:

```sh
ELECTRON_RUN_AS_NODE=1 \
DSH_CORDIS_ENTRY="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js" \
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/cordis-mount.mjs
```

See [VERIFICATION.md](VERIFICATION.md) for exact current evidence.

Boundaries:

- Only agent-loop model-request failures are covered; direct `ctx.llm.stream()` calls, title generation, and independent summary calls are outside this boundary.
- Recovery is not guaranteed for every live provider outage or within every finite budget.
- Unit and Cordis tests prove classification, actions, cancellation, and API surface; they do not replace provider-specific live outage tests.

## Development

```sh
node --check index.js
node --test --test-timeout=10000 test/plugin.test.mjs
```

The package exports `apply(ctx, config)`. Its bundle contributes only the single loader entry in [`cordis.patch.yml`](cordis.patch.yml).

## License

[MIT](LICENSE) © zzhaobh
