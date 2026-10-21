# @zzhaobh/dsh-server-error-continue

English | [中文](README.zh.md)

[![CI](https://github.com/zzhaobh/dsh-server-error-continue/actions/workflows/ci.yml/badge.svg)](https://github.com/zzhaobh/dsh-server-error-continue/actions/workflows/ci.yml)

A DeepSeek Harness (DSH) bundle that adds bounded, cancellable recovery for transient model-request failures. It retries the failed request in place, escalates after a provider's own retry budget is spent, and finally restarts the turn a bounded number of times — without fabricating user messages or retrying permanent failures such as authentication, quota, context overflow, or unknown models.

- **Same-request retries** — `maxContinues` extra attempts inside the same turn/step, exponential backoff, `Retry-After` support.
- **Provider-exhaustion escalation** — when a provider's `normal` retry policy has already retried a code and given up, the plugin does not stack more identical requests; it moves straight to a bounded turn restart.
- **Bounded turn restarts** — a fresh turn (new request) queued through `agent.followup()`, with its own in-step budget, capped per failure chain and withdrawn when real user input arrives or the user stops the turn.
- **Permanent-failure denylist** — auth/permission, quota/billing, context length, invalid schema/request/API key, model not found/unsupported, content policy, deferred/pending adapter states stay terminal even if they look transient.
- **Unclassified gateway errors** — `PI_AI_ERROR` / `UNKNOWN` wrapper codes fall back to a curated transient-text matcher and, by default, treat unclassified messages as transient (bounded). Strict modes are configurable.
- **Gateway replay faults** — encrypted-reasoning replay rejected with HTTP 400 (cross-account `encrypted_content` decryption failure) is treated as a transient override rather than a permanent invalid request.

## Requirements

- DSH `>=0.2.1-rc.2 <0.3.0` (declared through `engines.dsh`; the bundle is skipped with a warning by installations outside the range unless an exact-version exemption is granted).
- Node.js 20 or newer.
- The bundle is Host-only: it contributes a Cordis loader row and no client UI.

## Install

The package is plain JavaScript — there is no build step, so a git install needs no `prepare` script and no pnpm build-script allowance.

Install from GitHub into a profile:

```sh
dsh plugin --profile <profile> add github:zzhaobh/dsh-server-error-continue
```

Pin a commit for reproducible installs:

```sh
dsh plugin --profile <profile> add "github:zzhaobh/dsh-server-error-continue#<commit>"
```

Or install a local checkout while developing:

```sh
dsh plugin --profile <profile> add /path/to/dsh-server-error-continue
```

Verify the layer before booting, then boot:

```sh
dsh --profile <profile> --dump-config | grep -A6 server-error-continue
dsh --profile <profile>
```

The Electron-managed `desktop` profile rejects CLI boot/config-dump commands; manage it through the app's plugin manager or by editing the profile files directly.

To remove the plugin, `dsh plugin --profile <profile> remove @zzhaobh/dsh-server-error-continue` removes both the dependency and the bundle layer.

## Configuration

Defaults ship in the bundle's [`cordis.patch.yml`](cordis.patch.yml). A profile can override the row in its own `cordis.patch.yml`; a patch replaces the entire `config` value, so restate every key you need.

| Key | Default | Meaning |
|---|---|---|
| `delayMs` | `1000` | First in-step retry delay; doubles per attempt. |
| `maxDelayMs` | `30000` | Backoff cap; must be at least `delayMs`. |
| `maxContinues` | `3` | Extra same-request attempts per failed step. `0` means unlimited (documented opt-in); the turn-restart stage then becomes unreachable. |
| `maxRestarts` | `2` | Extra turn restarts per failure chain. `0` disables restarts and keeps same-request-only behavior. |
| `codes` | `["SERVER"]` | Additional always-retryable failure codes. Terminal-code and permanent-text exclusions still win. |
| `messageIncludes` | `["server_error", "upstream_error", "overloaded"]` | Extra case-insensitive transient substrings for wrapper codes. |
| `excludeIncludes` | `[]` | Site-specific permanent substrings; a match vetoes both text fallback and the built-in replay override. |
| `retryUnclassified` | `true` | Whether wrapper codes with no matching permanent/transient text are treated as transient. `false` switches to strict allowlist mode. |
| `prompt` | `continue` | Legacy v1 key, accepted for compatibility but never sent; configuring it logs a deprecation warning. |

Example profile override:

```yaml
- id: server-error-continue
  name: '@zzhaobh/dsh-server-error-continue'
  config:
    delayMs: 2000
    maxDelayMs: 30000
    maxContinues: 3
    maxRestarts: 3
    codes:
      - SERVER
    messageIncludes:
      - server_error
      - upstream_error
      - overloaded
    excludeIncludes: []
    retryUnclassified: true
```

## How recovery works

1. **Classify.** Permanent facts are checked before every retry rule: terminal failure codes, permanent text (auth, quota, context, invalid request/schema/API key, model not found/unsupported, content policy, adapter `deferred`/`pending` states), `excludeIncludes`, and non-transient 4xx. Transient 408/425/429 are exceptions. Then `codes` and HTTP 5xx match; finally `PI_AI_ERROR`/`UNKNOWN` fall back to `messageIncludes`, curated transient text (English and Chinese), and `retryUnclassified`.
2. **Same-request retry.** A match schedules a retry of the same request inside the same step with exponential backoff. Other recovery owners (including DSH's built-in provider retry) get precedence through the request-error waterfall.
3. **Provider-exhaustion escalation.** If the provider's `normal` retry policy already managed the failing code, the plugin skips further identical requests and schedules a turn restart directly. Provider `always` policies keep ownership; the plugin never races them.
4. **Bounded turn restart.** With no pending inbox input and an un-aborted signal, the plugin queues a restart prompt through `agent.followup()`. DSH opens a new turn with a new model request; the prompt's `source.kind` is `server-error-continue` (not `user`) and it is visible in history as an explicit automatic-restart record.

A restart chain is bounded per agent: it resets on a non-error turn end, on real user input, or on unload. Queued restarts are withdrawn when user or other automatic input arrives, and `agent/pre-step` rejects a restart whose reservation went stale. Unloading drains in-flight waits and withdraws queued restart prompts.

## Verification and known limits

- Unit tests: `node --test test/plugin.test.mjs` — see [VERIFICATION.md](VERIFICATION.md) for the current pass counts and evidence boundaries.
- CI runs `node --check` and the full suite on Node 20, 22, and 24.
- Only in-band model-stream finish errors reach the plugin; errors thrown before a stream starts, and direct LLM calls outside the agent loop (session titles, compaction summaries), are not covered.
- "Unclassified is transient" is bounded but optimistic: an unknown permanent error may consume `maxContinues` retries and up to `maxRestarts` restarts before surfacing. Use `retryUnclassified: false` or `excludeIncludes` to tighten.
- Restart prompts are visible session messages (same mechanism as goal rounds), not user speech.
- Recovery budgets are per running process and per failure chain; they do not persist across plugin reloads or DSH restarts.
- No live end-to-end verification is claimed for every provider/gateway error class; see [VERIFICATION.md](VERIFICATION.md).

## Development

```sh
node --check index.js
node --test test/plugin.test.mjs
```

No runtime dependencies. The plugin entry exports `apply(ctx, config)`; the bundle loader row is declared in `cordis.patch.yml`.

## License

[MIT](LICENSE) © zzhaobh
