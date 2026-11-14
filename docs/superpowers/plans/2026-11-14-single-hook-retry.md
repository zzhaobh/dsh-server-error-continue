# Single-Hook Model-Request Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the invasive recovery implementation with a 3.0.0 plugin that uses only `agent/request-error` to retry transient model-request failures across providers.

**Architecture:** Native DSH recovery runs first. This plugin handles eligible failures left unhandled, performs bounded/cancellable backoff, and returns `{ kind: 'retry' }` so DSH repeats the same open step without inserting messages or changing models. All restart, inbox, session, and failover code is removed.

**Tech Stack:** JavaScript ESM, Node.js 20+, Cordis `agent/request-error` waterfall, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-14-single-hook-retry-design.md`

## Global Constraints

- Only public `agent/request-error`, `ctx.agents.get`, `ctx.effect`, and `ctx.logger` are used.
- No `followup`, inbox, session-event, model-selection, or route-rewrite dependency is allowed.
- No system-prompt context, continuation text, user/assistant messages, durable-history mutation, or Agent lifecycle ownership is allowed; successful requests and turns remain untouched.
- Native `normal` policy budgets are not supplemented; native `always` remains the owner.
- Content-filter outcomes never reach an always-retry owner. Auth, quota, context, invalid model/request, and non-transient 4xx failures do not retry.
- `maxContinues` remains finite by default; zero remains the explicit unlimited opt-in.
- No paid/live model request is used for validation. No commit or push unless the user explicitly asks later.

## Review Focus

- Private API or event-listener reintroduction.
- Retry ownership and listener ordering.
- Permanent-failure precedence and content-filter veto.
- Cancellation, disposal, Agent replacement, and Retry-After behavior.
- Legacy restart/fallback keys having no behavioral effect.

## File Map

- `index.js`: single-hook recovery, failure classification, configuration, backoff, cancellation.
- `test/plugin.test.mjs`: mocked Host-boundary contract and failure matrix.
- `test/cordis-mount.mjs`: real Cordis mount/disposal smoke check for the current desktop installation, run through Electron with no model request.
- `cordis.patch.yml`: finite retry defaults without restart/fallback keys.
- `package.json`: 3.0.0 metadata and test scripts.
- `README.md`, `README.zh.md`: configuration, migration, supported failure classes, and evidence boundaries.
- `VERIFICATION.md`: exact test/mount results and remaining unverified provider behavior.

### Task 1: Prove and implement the single-hook core

- [ ] **Step 1: Rewrite the mocked boundary tests first**

  In `test/plugin.test.mjs`, make the Agent contain no inbox, followup, session, or model-selection API. Assert `apply()` registers only `agent/request-error`. Add cases proving all five normalized transient codes retry without provider policy, legacy restart/fallback keys only warn, and exhaustion creates no prompt or route change.

- [ ] **Step 2: Run the new tests and capture RED**

  Run: `node --test test/plugin.test.mjs`

  Expected: failures because 2.4.2 registers additional listeners, touches restart/fallback state, and does not satisfy the single-hook boundary.

- [ ] **Step 3: Replace `index.js` with the minimal implementation**

  Keep the useful failure normalization/classification helpers. Implement downstream-first recovery, content-filter preemption, provider-policy ownership, bounded retry/backoff, Retry-After, Agent existence checks, and disposal. Delete every restart, inbox, session, and failover dependency.

  Update `cordis.patch.yml` to remove restart/fallback keys and set `maxContinues: 5`. Update `package.json` to version `3.0.0` and describe the single-hook behavior.

- [ ] **Step 4: Run the core suite GREEN**

  Run: `node --check index.js && node --test test/plugin.test.mjs`

  Expected: all core tests pass and no test double exposes removed APIs.

### Task 2: Complete the recovery and compatibility matrix

- [ ] **Step 1: Add policy, permanent-failure, and lifecycle tests**

  Cover: native `normal` exhaustion adds no attempts; native `always` owns recovery; downstream decisions/errors propagate; connection reset/refused, EOF, incomplete chunked response, missing terminal event, encrypted-reasoning override, and configured wrapper text retry; auth/quota/context/model/request/content-policy failures do not; max-attempt budget, exponential cap, Retry-After, user cancellation, Agent replacement, unload, and legacy-key warnings.

- [ ] **Step 2: Run the expanded tests and fix only observed gaps**

  Run: `node --test test/plugin.test.mjs`

  If a new case fails, record the exact failure and adjust the classifier or lifecycle code. Do not broaden recovery to unknown permanent failures merely to make a test pass.

- [ ] **Step 3: Re-run the complete matrix GREEN**

  Run: `node --check index.js && node --test test/plugin.test.mjs`

  Expected: all tests pass without restart, inbox, session, or failover behavior.

### Task 3: Validate a real Cordis mount and synchronize documentation

- [ ] **Step 1: Add `test/cordis-mount.mjs`**

  Mount the plugin in a real Cordis context with the minimal `agents` service stub, assert the single-hook registration surface, exercise one transient recovery without network I/O, and dispose. Run through the installed Electron runtime so the current rc3 package APIs and asar loading are exercised.

- [ ] **Step 2: Run the mount check**

  Run the Electron/Node command documented in the script and assert exit 0. Record the exact runtime/package versions and that no model request occurred.

- [ ] **Step 3: Update documentation**

  Rewrite `README.md` and `README.zh.md` for 3.0.0 migration, configuration, native-policy interaction, transient/permanent classification, and boundaries. Update `VERIFICATION.md` with the actual test counts, mount evidence, and unverified live-provider limitations.

- [ ] **Step 4: Verify documentation and package contents**

  Run: `npm test && npm pack --dry-run`

  Expected: tests pass and the package contains only intended runtime/docs files, not development plans or temporary artifacts.

### Task 4: Independent review and final evidence

- [ ] **Step 1: Run full verification**

  Run syntax, unit, coverage, real Cordis mount, and package dry-run checks. Capture exact counts and exit codes.

- [ ] **Step 2: Request a fresh-context review**

  Give a reviewer the approved spec, plan, final diff, and test output. Require checks for private API use, retry ownership, permanent-failure bypasses, and cancellation races. Fix Critical/High findings with regression tests.

- [ ] **Step 3: Re-run verification after any fix**

  Expected: all checks pass. Report changed files, test evidence, remaining live-provider limits, and the fact that no commit/push was made.
