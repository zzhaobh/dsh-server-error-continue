import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, createMatcher, isPermanentFailure, resolveConfig } from '../index.js'

// Exercise the public Host waterfall. The Agent deliberately exposes only id:
// any inbox, session, followup, or model-routing dependency must fail loudly.
const timerContexts = new WeakSet()
function harness(t, config = {}, priorRecovery) {
  if (!timerContexts.has(t)) {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    timerContexts.add(t)
  }
  const listeners = new Map()
  const registered = []
  const agents = new Map()
  const cleanups = []
  const logs = []
  const ctx = {
    on(name, listener, options = {}) {
      registered.push(name)
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name)[options.prepend ? 'unshift' : 'push'](listener)
      return () => {
        const list = listeners.get(name)
        const index = list?.indexOf(listener) ?? -1
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(register) { const cleanup = register(); cleanups.push(cleanup); return cleanup },
    agents: { get: id => agents.get(id) },
    logger: Object.fromEntries(['warn', 'info', 'error'].map(level => [level, (...args) => logs.push([level, ...args])])),
  }
  if (priorRecovery !== undefined) ctx.on('agent/request-error', priorRecovery)
  apply(ctx, config)
  const controller = new AbortController()
  const agent = { id: 's1' }
  agents.set(agent.id, agent)
  const payload = {
    agent,
    turn: 1,
    step: 1,
    provider: 'test-provider',
    failure: { code: 'TRANSPORT', message: 'Connection error.' },
    retryPolicy: undefined,
    signal: controller.signal,
  }
  return {
    agent, agents, controller, logs, registered,
    recover(overrides = {}, next) {
      const list = listeners.get('agent/request-error') ?? []
      assert.ok(list.length > 0, 'recovery must attach to agent/request-error')
      const invoke = index => {
        if (index >= list.length) return Promise.resolve(next?.() ?? undefined)
        return list[index]({ ...payload, ...overrides }, () => invoke(index + 1))
      }
      return invoke(0)
    },
    replaceAgent() { agents.delete(agent.id) },
    async advance(ms) {
      await new Promise(resolve => setImmediate(resolve))
      t.mock.timers.tick(ms)
      await new Promise(resolve => setImmediate(resolve))
    },
    async dispose() { for (const cleanup of cleanups) await cleanup?.() },
  }
}

const transientFailure = code => ({ code, message: `synthetic ${code}` })
const retry = { kind: 'retry' }
const matcher = () => createMatcher(resolveConfig())

test('apply registers only the public request-error hook and needs no private Agent APIs', (t) => {
  const h = harness(t)
  assert.deepEqual(h.registered, ['agent/request-error'])
  assert.deepEqual(Object.keys(h.agent), ['id'])
})

test('all normalized transient codes retry the same request without a provider policy', async (t) => {
  for (const code of ['SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'EMPTY_RESPONSE']) {
    const h = harness(t, { delayMs: 1 })
    const pending = h.recover({ failure: transientFailure(code) })
    await h.advance(1)
    assert.deepEqual(await pending, retry, code)
    await h.dispose()
  }
})

test('representative connection failures retry across provider wrappers', async (t) => {
  for (const message of [
    'Connection error.',
    'TransferEncodingError: Response payload is not completed',
    'ConnectionResetError: 上游流中途断开',
    'OpenAI Responses stream ended before a terminal response event',
    'socket hang up',
  ]) {
    const h = harness(t, { delayMs: 1 })
    const pending = h.recover({ failure: { code: 'PI_AI_ERROR', message } })
    await h.advance(1)
    assert.deepEqual(await pending, retry, message)
    await h.dispose()
  }
})

test('legacy restart and fallback keys only warn and have no recovery effect', (t) => {
  const h = harness(t, {
    prompt: 'continue', maxRestarts: 2,
    fallbackProvider: 'backup', fallbackModel: 'flash',
  })
  assert.deepEqual(h.registered, ['agent/request-error'])
  assert.ok(h.logs.some(entry => entry.join(' ').includes('ignored legacy keys')))
  assert.deepEqual(Object.keys(h.agent), ['id'])
})

test('a provider normal policy remains authoritative after exhaustion', async (t) => {
  const h = harness(t)
  const result = await h.recover({
    failure: transientFailure('SERVER'),
    retryPolicy: { mode: 'normal', maxRetries: 1, retryableCodes: ['SERVER'] },
  })
  assert.equal(result, undefined)
  assert.equal(h.logs.some(entry => entry.join(' ').includes('restart')), false)
})

test('a provider always policy owns recovery without plugin retries', async (t) => {
  let nextCalls = 0
  const h = harness(t)
  const result = await h.recover(
    { failure: transientFailure('TRANSPORT'), retryPolicy: { mode: 'always' } },
    () => { nextCalls += 1 },
  )
  assert.equal(result, undefined)
  assert.equal(nextCalls, 1)
})

test('downstream recovery decisions are preserved without another wait', async (t) => {
  const h = harness(t)
  const result = await h.recover({}, () => retry)
  assert.deepEqual(result, retry)
})

test('downstream recovery errors propagate rather than being masked', async (t) => {
  const h = harness(t)
  await assert.rejects(h.recover({}, (t) => { throw new Error('downstream failed') }), /downstream failed/)
})

test('content filtering is terminal even with an always-retry downstream owner', async (t) => {
  let downstreamCalls = 0
  const h = harness(t, {}, (t) => { downstreamCalls += 1; return retry })
  const result = await h.recover({
    failure: { code: 'INVALID_REQUEST', status: 400, message: 'Response incomplete: content_filter' },
    retryPolicy: { mode: 'always' },
  })
  assert.equal(result, undefined)
  assert.equal(downstreamCalls, 0)
})

test('per-step retry budget exhausts without restart or failover behavior', async (t) => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  const first = h.recover()
  await h.advance(1)
  assert.deepEqual(await first, retry)
  assert.equal(await h.recover({ used: 1 }), undefined)
  assert.deepEqual(h.registered, ['agent/request-error'])
  assert.deepEqual(Object.keys(h.agent), ['id'])
  assert.equal(h.logs.some(entry => entry.join(' ').includes('restart')), false)
})

test('retry budget is tracked without payload.used or a session API', async (t) => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  const first = h.recover()
  await h.advance(1)
  assert.deepEqual(await first, retry)
  const second = h.recover()
  await h.advance(1)
  assert.equal(await second, undefined)
})

test('a different request step receives its own retry budget', async (t) => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  const pending = h.recover({ step: 2 })
  await h.advance(1)
  assert.deepEqual(await pending, retry)
})

test('backoff doubles and remains capped', async (t) => {
  const h = harness(t, { delayMs: 100, maxDelayMs: 250, maxContinues: 3 })
  for (const delay of [100, 200, 250]) {
    const pending = h.recover()
    await h.advance(delay)
    assert.deepEqual(await pending, retry)
  }
  const delays = h.logs
    .filter(entry => typeof entry[1] === 'string' && entry[1].includes('waiting %dms'))
    .map(entry => entry[3])
  assert.deepEqual(delays, [100, 200, 250])
  assert.equal(await h.recover(), undefined)
})

test('provider Retry-After is honored without shortening its bounded delay', async (t) => {
  const h = harness(t, { delayMs: 100, maxDelayMs: 1000 })
  let settled = false
  const pending = h.recover({ failure: { code: 'TRANSPORT', message: 'delayed', providerRetryAfterMs: 150 } }).finally(() => { settled = true })
  await h.advance(149)
  assert.equal(settled, false)
  await h.advance(1)
  assert.deepEqual(await pending, retry)
})

test('user cancellation aborts an in-progress retry wait', async (t) => {
  const h = harness(t)
  const pending = h.recover()
  h.controller.abort()
  await assert.rejects(pending, error => error?.name === 'AbortError')
})

test('an Agent replaced during backoff cannot retry', async (t) => {
  const h = harness(t, { delayMs: 1 })
  const pending = h.recover()
  h.replaceAgent()
  await h.advance(1)
  assert.equal(await pending, undefined)
})

test('plugin disposal aborts and drains pending recovery', async (t) => {
  const h = harness(t)
  const pending = h.recover()
  const disposal = h.dispose()
  await assert.rejects(pending, /disposed/)
  await disposal
})

test('configuration remains bounded and legacy-only knobs do not alter defaults', (t) => {
  assert.equal(resolveConfig().maxContinues, 3)
  for (const raw of [
    { maxContinues: -1 }, { maxContinues: 1.5 }, { delayMs: 0 },
    { maxDelayMs: 10, delayMs: 100 }, { retryUnclassified: 'yes' },
    { excludeIncludes: 'x' }, { unknownKnob: true },
  ]) assert.throws(() => resolveConfig(raw), undefined, JSON.stringify(raw))
})

test('permanent failures never match the transient classifier', (t) => {
  const matches = createMatcher(resolveConfig())
  for (const failure of [
    { code: 'AUTH', message: 'upstream unauthorized' },
    { code: 'QUOTA', message: 'quota exceeded' },
    { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context window exceeded' },
    { code: 'INVALID_REQUEST', status: 400, message: 'invalid schema' },
    { code: 'PI_AI_ERROR', message: 'model_not_found' },
  ]) {
    assert.equal(isPermanentFailure(failure), true)
    assert.equal(matches(failure, undefined), false)
  }
})

test('normalized server and wrapped gateway failures match', () => {
  for (const failure of [
    { code: 'SERVER', message: 'failed', status: 503 },
    { code: 'PI_AI_ERROR', message: 'server_error: overloaded' },
    { code: 'PI_AI_ERROR', message: 'upstream_error: Upstream request failed' },
    { code: 'UNKNOWN', message: 'failed', status: 502 },
  ]) assert.equal(matcher()(failure), true, failure.message)
})

for (const code of ['AUTH', 'QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED']) {
  test(`${code} remains terminal when configured as retryable`, () => {
    const matches = createMatcher(resolveConfig({ codes: ['SERVER', code] }))
    assert.equal(matches({ code, message: 'upstream_error: overloaded', status: 503 }), false)
  })
}

test('tool schema and arbitrary tool errors are not model-connection failures', () => {
  const message = "Invalid schema for function 'ssh_exec': schema must be a JSON Schema of 'type: \"object\"', got 'type: null'."
  assert.equal(matcher()({ code: 'INVALID_REQUEST', message, status: 400 }), false)
  assert.equal(matcher()({ code: 'SERVER', message, status: 500 }), false)
  assert.equal(matcher()(new Error('upstream_error: tool failed')), false)
})

test('strict mode allows only known transient wording', () => {
  const strict = createMatcher(resolveConfig({ retryUnclassified: false }))
  assert.equal(strict({ code: 'PI_AI_ERROR', message: 'some new gateway wording' }), false)
  for (const message of [
    'Upstream request failed', 'upstream_error: temporarily unavailable',
    'server_error: overloaded', 'rate_limit_exceeded: retry later',
    'request timed out', 'connection reset by peer', 'http 503',
    '上游请求失败', '请稍后重试',
    'OpenAI Responses stream ended before a terminal response event',
  ]) assert.equal(strict({ code: 'PI_AI_ERROR', message }), true, message)
})

test('permanent provider facts beat retry codes, status, and transient text', () => {
  for (const failure of [
    { code: 'SERVER', message: 'Model "x" is not supported by any configured account', status: 503 },
    { code: 'PI_AI_ERROR', message: 'Authentication Fails, your api key is invalid', status: 503 },
    { code: 'PI_AI_ERROR', message: 'insufficient quota for this billing period' },
    { code: 'PI_AI_ERROR', message: 'maximum context length exceeded', status: 503 },
    { code: 'PI_AI_ERROR', message: 'content policy violation detected' },
    { code: 'PI_AI_ERROR', message: 'pi-ai deferred response is not supported' },
    { code: 'PI_AI_ERROR', message: 'pi-ai stream for model "x" ended pending' },
    { code: 'PI_AI_ERROR', message: 'model_not_found: no available channel' },
  ]) assert.equal(matcher()(failure), false, failure.message)
})

test('encrypted reasoning and replay affinity failures override pseudo-400 errors', () => {
  const failure = {
    code: 'INVALID_REQUEST', status: 400,
    message: 'The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
  }
  assert.equal(matcher()(failure), true)
  assert.equal(matcher()({ code: 'INVALID_REQUEST', message: 'previous_response_id rs_123 not found' }), true)
  const excluded = createMatcher(resolveConfig({ excludeIncludes: ['encrypted content'] }))
  assert.equal(excluded(failure), false)
  assert.equal(matcher()({ code: 'INVALID_REQUEST', message: 'invalid request: bad body', status: 400 }), false)
})

test('mid-stream transport breaks override pseudo-400 errors', () => {
  const failure = {
    code: 'INVALID_REQUEST', status: 400,
    message: "upstream_error: 上游流中途断开: Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>",
  }
  assert.equal(matcher()(failure), true)
  for (const message of [
    'httpx.RemoteProtocolError: peer closed connection without sending complete message body (incomplete chunked read)',
    "ConnectionResetError(54, 'Connection reset by peer')",
    'upstream stream disconnected',
    'Response payload is not completed',
  ]) assert.equal(matcher()({ code: 'INVALID_REQUEST', message }), true, message)
  const excluded = createMatcher(resolveConfig({ excludeIncludes: ['上游流中途断开'] }))
  assert.equal(excluded(failure), false)
})

test('content-filter codes and suffixed policy text always win', () => {
  const matches = createMatcher(resolveConfig({ codes: ['SERVER', 'CONTENT_FILTER'] }))
  for (const failure of [
    { code: 'PI_AI_ERROR', message: 'Response incomplete: content_filter' },
    { code: 'SERVER', status: 503, message: 'Connection error. Response incomplete: content_filter' },
    { code: 'CONTENT_FILTER', message: 'blocked' },
    { code: 'PI_AI_ERROR', message: 'upstream error. content_policy_violation' },
  ]) assert.equal(matches(failure), false, failure.message)
})

test('transient 4xx statuses recover while other 4xx statuses stay terminal', () => {
  for (const status of [408, 425, 429]) {
    assert.equal(matcher()({ code: 'PI_AI_ERROR', message: 'opaque gateway failure', status }), true, String(status))
  }
  for (const status of [400, 401, 404, 409, 422]) {
    assert.equal(matcher()({ code: 'PI_AI_ERROR', message: 'opaque gateway failure', status }), false, String(status))
  }
})

test('custom wrapper text and exclusions remain case-insensitive', () => {
  const custom = createMatcher(resolveConfig({ messageIncludes: ['vendor_busy'] }))
  assert.equal(custom({ code: 'PI_AI_ERROR', message: 'VENDOR_BUSY: try again' }), true)
  const excluded = createMatcher(resolveConfig({ excludeIncludes: ['upstream request failed'] }))
  assert.equal(excluded({ code: 'PI_AI_ERROR', message: 'unknown: Upstream Request Failed' }), false)
  assert.equal(excluded({ code: 'PI_AI_ERROR', message: 'server_error: overloaded' }), true)
})

test('nested adapter failure objects are classified from their actual failure', () => {
  const wrapped = { failure: { code: 'TRANSPORT', message: 'socket hang up' } }
  assert.equal(matcher()(wrapped), true)
  assert.equal(matcher()({ failure: { code: 'AUTH', message: 'unauthorized' } }), false)
})

test('an excessive Retry-After hint fails closed instead of waiting unbounded time', async (t) => {
  const h = harness(t, { delayMs: 100, maxDelayMs: 1000 })
  assert.equal(await h.recover({ failure: { code: 'TRANSPORT', message: 'delayed', providerRetryAfterMs: 1001 } }), undefined)
})

test('an already-aborted request rejects before scheduling a retry', async (t) => {
  const h = harness(t)
  h.controller.abort()
  await assert.rejects(h.recover(), error => error?.name === 'AbortError')
})

test('an unregistered Agent is rejected before any wait', async (t) => {
  const h = harness(t)
  h.replaceAgent()
  assert.equal(await h.recover(), undefined)
})

test('explicit unlimited mode remains opt-in and exceeds the finite default', async (t) => {
  const h = harness(t, { delayMs: 1, maxDelayMs: 1, maxContinues: 0 })
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const pending = h.recover()
    await h.advance(1)
    assert.deepEqual(await pending, retry)
  }
})

test('legacy values are ignored rather than revalidated as active behavior', () => {
  const config = resolveConfig({ maxRestarts: -1, fallbackProvider: 1, fallbackModel: false })
  assert.equal(config.fallbackProvider, undefined)
  assert.equal(config.maxRestarts, undefined)
})

test('terminal codes cannot be bypassed by transient override wording', () => {
  const matches = matcher()
  const messages = [
    'Connection error.',
    'Connection reset by peer',
    '上游流中途断开',
    'encrypted content could not be decrypted or parsed',
  ]
  for (const code of ['AUTH', 'QUOTA', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED', 'CANCELED', 'NO_ADAPTER']) {
    for (const message of messages) {
      const failure = { code, message }
      assert.equal(isPermanentFailure(failure), true, `${code}: ${message}`)
      assert.equal(matches(failure), false, `${code}: ${message}`)
    }
  }
})

test('permanent text wins over transport overrides under wrapper codes', () => {
  const matches = matcher()
  for (const message of [
    'Authentication failed: Connection error.',
    'quota exceeded; connection reset by peer',
    'maximum context length exceeded; 上游流中途断开',
    'model_not_found: Connection error.',
    'content_policy_violation: Connection error.',
  ]) {
    const failure = { code: 'PI_AI_ERROR', message }
    assert.equal(isPermanentFailure(failure), true, message)
    assert.equal(matches(failure), false, message)
  }
})

test('only genuine pseudo-invalid-request transport overrides remain retryable', () => {
  for (const code of ['INVALID_REQUEST', 'PI_AI_ERROR']) {
    assert.equal(matcher()({ code, message: 'upstream_error: Connection error.', status: 400 }), true, code)
  }
  assert.equal(matcher()({
    code: 'INVALID_REQUEST', status: 400,
    message: 'encrypted content could not be decrypted or parsed',
  }), true)
})

test('minimum Node runtime includes AbortSignal.any and has an exact CI gate', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.equal(packageJson.engines.node, '>=20.3.0')
  assert.match(ci, /node:\s*\[20\.3\.0, 20, 22, 24\]/)
})
