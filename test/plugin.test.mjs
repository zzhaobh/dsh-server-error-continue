import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, createMatcher, resolveConfig, restartPrompt } from '../index.js'

// Exercise our waterfall decisions at the Host boundary, not an LLM/network mock.
function harness(t, config = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const listeners = new Map()
  const agents = new Map()
  const cleanups = []
  const logs = []
  const ctx = {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {
        const list = listeners.get(name)
        const index = list?.indexOf(listener) ?? -1
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(register) { const cleanup = register(); cleanups.push(cleanup); return cleanup },
    agents: { get: (id) => agents.get(id) },
    logger: Object.fromEntries(['warn', 'info', 'error'].map(level => [level, (...args) => logs.push([level, ...args])])),
  }
  apply(ctx, config)
  const controller = new AbortController()
  const agent = {
    id: 's1',
    status: 'running',
    inbox: {
      nextTurn: [],
      nextStep: [],
      remove(id) {
        for (const list of [this.nextTurn, this.nextStep]) {
          const index = list.findIndex(message => message.id === id)
          if (index >= 0) { list.splice(index, 1); return true }
        }
        return false
      },
    },
    followups: [],
    followup(message) { this.followups.push(message); this.inbox.nextTurn.push(message) },
  }
  agents.set(agent.id, agent)
  const payload = { agent, turn: 1, step: 1, provider: 'ds', failure: { code: 'PI_AI_ERROR', message: 'upstream_error: Upstream request failed' }, retryPolicy: undefined, signal: controller.signal }
  return {
    agent, agents, controller, payload, logs,
    recover(overrides = {}, next = async () => undefined) {
      const list = listeners.get('agent/request-error') ?? []
      assert.ok(list.length > 0, 'Recovery must attach to the cancellable model-request boundary')
      return list[0]({ ...payload, ...overrides }, next)
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
    waterfall(name, payload, terminal) {
      const list = listeners.get(name) ?? []
      const invoke = (index) => index >= list.length ? Promise.resolve(terminal) : list[index](payload, () => invoke(index + 1))
      return invoke(0)
    },
    claim(message) { this.agent.inbox.remove(message.id); this.emit('agent/inbox/claimed', { agent, message }) },
    goIdle() { this.agent.status = 'idle'; this.emit('agent/status', { agent: this.agent, status: 'idle' }) },
    async advance(ms) { await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(ms) },
    async dispose() { for (const cleanup of cleanups) await cleanup?.() },
  }
}

const userMessage = (id = 'u1') => ({ id, role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user', rpcId: 'r1' } })

const matcher = () => createMatcher(resolveConfig())

test('matches normalized server failures and PI_AI upstream/overload failures', () => {
  const matches = matcher()
  for (const failure of [
    { code: 'SERVER', message: 'failed', status: 503 },
    { code: 'PI_AI_ERROR', message: 'server_error: overloaded' },
    { code: 'PI_AI_ERROR', message: 'upstream_error: Upstream request failed' },
    { code: 'UNKNOWN', message: 'failed', status: 502 },
  ]) assert.equal(matches(failure), true)
})

for (const code of ['AUTH', 'QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED']) {
  test(`${code} overrides misleading upstream error text and SERVER configuration`, () => {
    const matches = createMatcher(resolveConfig({ codes: ['SERVER', code] }))
    assert.equal(matches({ code, message: 'upstream_error: overloaded', status: 503 }), false)
  })
}

test('the reported ssh_exec invalid-schema failure is terminal even when mislabeled SERVER', () => {
  const message = "Invalid schema for function 'ssh_exec': schema must be a JSON Schema of 'type: \"object\"', got 'type: null'."
  assert.equal(matcher()({ code: 'INVALID_REQUEST', message, status: 400 }), false)
  assert.equal(matcher()({ code: 'SERVER', message, status: 500 }), false)
})

test('HTTP 4xx overrides text, invalid status ranges and arbitrary tool errors do not match', () => {
  const matches = matcher()
  assert.equal(matches({ code: 'PI_AI_ERROR', message: 'overloaded', status: 400 }), false)
  assert.equal(matches({ code: 'X', message: 'plain', status: 600 }), false)
  assert.equal(matches(new Error('upstream_error: tool failed')), false)
})

test('unclassified gateway errors under PI_AI_ERROR/UNKNOWN are recoverable by default', () => {
  const matches = matcher()
  for (const failure of [
    { code: 'PI_AI_ERROR', message: 'Upstream request failed' },
    { code: 'PI_AI_ERROR', message: 'unknown: Upstream request failed' },
    { code: 'PI_AI_ERROR', message: 'some new gateway wording' },
    { code: 'UNKNOWN', message: 'Upstream request failed' },
  ]) assert.equal(matches(failure), true, failure.message)
})

test('strict mode only allows known transient wording', () => {
  const strict = createMatcher(resolveConfig({ retryUnclassified: false }))
  assert.equal(strict({ code: 'PI_AI_ERROR', message: 'some new gateway wording' }), false)
  for (const message of [
    'Upstream request failed',
    'unknown: Upstream request failed',
    'upstream_error: Upstream service temporarily unavailable',
    'server_error: overloaded',
    'rate_limit_exceeded: retry later',
    'request timed out',
    'connection reset by peer',
    'http 503',
    '上游请求失败',
    '请稍后重试',
  ]) assert.equal(strict({ code: 'PI_AI_ERROR', message }), true, message)
})

test('permanent failures beat retry codes, status and transient wording', () => {
  const matches = matcher()
  for (const failure of [
    { code: 'SERVER', message: "Model \"gpt-6.1-sol\" is not supported by any configured account", status: 503 },
    { code: 'PI_AI_ERROR', message: 'upstream_error: HTTP 404: Model "x" is not supported', status: 500 },
    { code: 'PI_AI_ERROR', message: 'Authentication Fails, your api key is invalid', status: 503 },
    { code: 'PI_AI_ERROR', message: 'insufficient quota for this billing period' },
    { code: 'PI_AI_ERROR', message: 'maximum context length exceeded', status: 503 },
    { code: 'PI_AI_ERROR', message: 'content policy violation detected' },
    { code: 'PI_AI_ERROR', message: 'pi-ai deferred response is not supported' },
    { code: 'PI_AI_ERROR', message: 'pi-ai stream for model "x" ended pending' },
    { code: 'PI_AI_ERROR', message: "Invalid schema for function 'ssh_exec'" },
    { code: 'PI_AI_ERROR', message: 'model_not_found: no available channel' },
  ]) assert.equal(matches(failure), false, failure.message)
})

test('gateway encrypted-reasoning replay faults are recoverable despite HTTP 400/INVALID_REQUEST', () => {
  const matches = matcher()
  const failure = {
    code: 'INVALID_REQUEST',
    message: 'ds API error (400): {"message":"The encrypted content for item rs_06de56afbc041ce5016ad8abe610ec819891b095da22c9a8dd could not be verified. Reason: Encrypted content could not be decrypted or parsed.","type":"upstream_error","param":"","code":"upstream_error"}',
  }
  assert.equal(matches(failure), true)
  assert.equal(matches({ ...failure, status: 400 }), true)
  assert.equal(matches({ code: 'PI_AI_ERROR', message: 'encrypted content could not be decrypted or parsed' }), true)
  assert.equal(matches({ code: 'INVALID_REQUEST', message: 'previous_response_id rs_123 not found' }), true)
  // A user exclusion still vetoes the built-in transient override.
  const excluded = createMatcher(resolveConfig({ excludeIncludes: ['encrypted content'] }))
  assert.equal(excluded(failure), false)
  // Ordinary invalid requests remain terminal.
  assert.equal(matches({ code: 'INVALID_REQUEST', message: 'invalid request: bad body', status: 400 }), false)
})

test('standard transport codes and connection-error wording stay recoverable without a provider policy', () => {
  const matches = matcher()
  for (const code of ['SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'EMPTY_RESPONSE']) {
    assert.equal(matches({ code, message: 'opaque failure' }), true, code)
  }
  assert.equal(matches({ code: 'TRANSPORT', message: 'Connection error.' }), true)
  assert.equal(matches({ code: 'PI_AI_ERROR', message: 'Connection error.' }), true)
  assert.equal(createMatcher(resolveConfig({ retryUnclassified: false }))({ code: 'PI_AI_ERROR', message: 'Connection error.' }), true)
  // Python gateways can also label a connection break as a 400 pseudo-invalid request.
  assert.equal(matches({ code: 'INVALID_REQUEST', message: 'Connection error.', status: 400 }), true)
})

test('a connection error without a provider policy retries the same request', async t => {
  const h = harness(t, { delayMs: 10 })
  const result = h.recover({ failure: { code: 'TRANSPORT', message: 'Connection error.' }, retryPolicy: undefined })
  await h.advance(10)
  assert.deepEqual(await result, { kind: 'retry' })
  await h.dispose()
})

test('upstream mid-stream disconnects are recoverable despite 400/INVALID_REQUEST', () => {
  const matches = matcher()
  const failure = {
    code: 'INVALID_REQUEST',
    message: "upstream_error: 上游流中途断开: Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>. ConnectionResetError(22, '指定的网络名不再可用。', None, 64, None)",
  }
  assert.equal(matches(failure), true)
  assert.equal(matches({ ...failure, status: 400 }), true)
  for (const message of [
    'httpx.RemoteProtocolError: peer closed connection without sending complete message body (incomplete chunked read)',
    "ConnectionResetError(54, 'Connection reset by peer')",
    'upstream stream disconnected',
    'Response payload is not completed',
  ]) assert.equal(matches({ code: 'INVALID_REQUEST', message }), true, message)
  const excluded = createMatcher(resolveConfig({ excludeIncludes: ['上游流中途断开'] }))
  assert.equal(excluded(failure), false)
  // A content-filter truncated response is permanent, not a transport retry.
  assert.equal(matches({ code: 'PI_AI_ERROR', message: 'Response incomplete: content_filter' }), false)
})

test('an upstream mid-stream disconnect retries the same request', async t => {
  const h = harness(t, { delayMs: 10 })
  const failure = {
    code: 'INVALID_REQUEST',
    message: "upstream_error: 上游流中途断开: Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>",
  }
  const result = h.recover({ failure })
  await h.advance(10)
  assert.deepEqual(await result, { kind: 'retry' })
  await h.dispose()
})

test('an encrypted-reasoning replay failure retries the same request', async t => {
  const h = harness(t, { delayMs: 10 })
  const failure = {
    code: 'INVALID_REQUEST',
    message: 'ds API error (400): {"message":"The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.","type":"upstream_error","code":"upstream_error"}',
  }
  const result = h.recover({ failure })
  await h.advance(10)
  assert.deepEqual(await result, { kind: 'retry' })
  await h.dispose()
})

test('transient 4xx statuses stay recoverable; other 4xx stay terminal', () => {
  const matches = matcher()
  for (const status of [408, 425, 429]) assert.equal(matches({ code: 'PI_AI_ERROR', message: 'opaque gateway failure', status }), true, String(status))
  for (const status of [400, 401, 404, 409, 422]) assert.equal(matches({ code: 'PI_AI_ERROR', message: 'opaque gateway failure', status }), false, String(status))
})

test('user excludeIncludes vetoes a transient-looking message', () => {
  const matches = createMatcher(resolveConfig({ excludeIncludes: ['upstream request failed'] }))
  assert.equal(matches({ code: 'PI_AI_ERROR', message: 'unknown: Upstream request failed' }), false)
  assert.equal(matches({ code: 'PI_AI_ERROR', message: 'server_error: overloaded' }), true)
})

test('provider-exhausted retryable codes escalate straight to a turn restart', async t => {
  const h = harness(t, { delayMs: 1000 })
  const failure = { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' }
  const result = await h.recover({ failure, retryPolicy: { mode: 'normal', retryableCodes: ['TRANSPORT', 'TIMEOUT'] } })
  assert.equal(result, undefined, 'the built-in retry already spent its budget; do not stack more identical requests')
  assert.equal(h.agent.followups.length, 0, 'the restart waits for the idle transition')
  h.goIdle()
  assert.equal(h.agent.followups.length, 1)
  assert.equal(h.agent.followups[0].source.kind, 'server-error-continue')
  await h.dispose()
})

test('provider always policy owns recovery and never restarts turns', async t => {
  const h = harness(t)
  const result = await h.recover({ failure: { code: 'TRANSPORT', message: 'transport failed' }, retryPolicy: { mode: 'always' } })
  assert.equal(result, undefined)
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('provider-managed permanent codes never restart turns even if misconfigured', async t => {
  const h = harness(t)
  const result = await h.recover({
    failure: { code: 'AUTH', message: 'Authentication Fails, your api key is invalid' },
    retryPolicy: { mode: 'normal', retryableCodes: ['AUTH'] },
  })
  assert.equal(result, undefined)
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('provider policies still allow in-step retries for codes they do not manage', async t => {
  const h = harness(t, { delayMs: 10 })
  const result = h.recover({
    failure: { code: 'PI_AI_ERROR', message: 'Upstream request failed' },
    retryPolicy: { mode: 'normal', retryableCodes: ['TRANSPORT'] },
  })
  await h.advance(10)
  assert.deepEqual(await result, { kind: 'retry' })
  await h.dispose()
})

test('transient model failure retries the same request without adding user input', async t => {
  const h = harness(t, { delayMs: 10 })
  const result = h.recover()
  await h.advance(10)
  assert.deepEqual(await result, { kind: 'retry' })
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('a downstream recovery decision is preserved with no extra wait', async t => {
  const h = harness(t)
  const action = { kind: 'retry' }
  assert.equal(await h.recover({}, async () => action), action)
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('downstream failures propagate rather than being masked', async t => {
  const h = harness(t)
  const error = new Error('other recovery hook failed')
  await assert.rejects(h.recover({}, async () => { throw error }), e => e === error)
  await h.dispose()
})

test('permanent errors delegate and never schedule a retry or restart', async t => {
  const h = harness(t)
  assert.equal(await h.recover({ failure: { code: 'INVALID_REQUEST', message: 'upstream_error: invalid schema', status: 400 } }), undefined)
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('user stop cancels an in-progress retry wait immediately', async t => {
  const h = harness(t, { delayMs: 1000 })
  const result = h.recover()
  await h.advance(0)
  h.controller.abort()
  assert.equal(await result, undefined)
  await h.advance(1000)
  await h.dispose()
})

test('already-aborted requests do not recover', async t => {
  const h = harness(t)
  h.controller.abort()
  assert.equal(await h.recover(), undefined)
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('unload aborts and drains pending recovery', async t => {
  const h = harness(t)
  const result = h.recover()
  await h.advance(0)
  await h.dispose()
  assert.equal(await result, undefined)
})

test('an unregistered or replaced agent cannot retry after waiting', async t => {
  const h = harness(t, { delayMs: 10 })
  const result = h.recover()
  await h.advance(0)
  h.agents.set('s1', { id: 's1' })
  await h.advance(10)
  assert.equal(await result, undefined)
  await h.dispose()
})

test('default in-step budget stops after three extra requests and escalates to one turn restart', async t => {
  const h = harness(t, { delayMs: 1 })
  for (let i = 0; i < 3; i++) {
    const result = h.recover()
    await h.advance(4)
    assert.deepEqual(await result, { kind: 'retry' })
  }
  assert.equal(await h.recover(), undefined)
  assert.equal(h.agent.followups.length, 0, 'the restart waits for the idle transition')
  h.goIdle()
  assert.equal(h.agent.followups.length, 1)
  const followup = h.agent.followups[0]
  assert.equal(followup.role, 'user')
  assert.equal(followup.source.kind, 'server-error-continue')
  assert.equal(followup.source.restart, 1)
  assert.match(followup.content[0].text, /<server_error_restart>/)
  assert.match(followup.content[0].text, /1\/2 次自动重启/)
  assert.deepEqual(h.agent.inbox.nextTurn, [followup])
  await h.dispose()
})

test('backoff doubles per extra attempt and remains capped', async t => {
  const h = harness(t, { delayMs: 10, maxDelayMs: 20, maxContinues: 3 })
  for (const delay of [10, 20, 20]) {
    let settled = false
    const result = h.recover().then(value => { settled = true; return value })
    await h.advance(delay - 1)
    await Promise.resolve()
    assert.equal(settled, false)
    await h.advance(1)
    assert.deepEqual(await result, { kind: 'retry' })
  }
  await h.dispose()
})

test('new request step gets its own budget without replenishing the failed step', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1, maxRestarts: 0 })
  let result = h.recover()
  await h.advance(1)
  assert.deepEqual(await result, { kind: 'retry' })
  assert.equal(await h.recover(), undefined)
  result = h.recover({ step: 2 })
  await h.advance(1)
  assert.deepEqual(await result, { kind: 'retry' })
  await h.dispose()
})

test('provider Retry-After is respected; an excessive hint is not shortened', async t => {
  const h = harness(t, { delayMs: 10, maxDelayMs: 100, maxRestarts: 0 })
  const failure = { code: 'SERVER', message: 'failed', providerRetryAfterMs: 50 }
  let settled = false
  const result = h.recover({ failure }).then(value => { settled = true; return value })
  await h.advance(49)
  await Promise.resolve()
  assert.equal(settled, false)
  await h.advance(1)
  assert.deepEqual(await result, { kind: 'retry' })
  assert.equal(await h.recover({ failure: { ...failure, providerRetryAfterMs: 101 } }), undefined)
  await h.dispose()
})

test('explicit maxContinues zero preserves unlimited opt-in and never restarts turns', async t => {
  const h = harness(t, { delayMs: 0, maxContinues: 0, maxRestarts: 0 })
  for (let i = 0; i < 5; i++) {
    const result = h.recover()
    await h.advance(0)
    assert.deepEqual(await result, { kind: 'retry' })
  }
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('legacy prompt config is accepted but not inserted as user input', async t => {
  const h = harness(t, { delayMs: 0, prompt: 'continue' })
  const result = h.recover()
  await h.advance(0)
  assert.deepEqual(await result, { kind: 'retry' })
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('restart budget is bounded per failure chain and reset by a completed turn', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1, maxRestarts: 1 })
  let result = h.recover()
  await h.advance(1)
  assert.deepEqual(await result, { kind: 'retry' })
  assert.equal(await h.recover(), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 1)
  // Claim and run the restarted turn: it gets a fresh in-step budget.
  h.claim(h.agent.followups[0])
  result = h.recover({ turn: 2 })
  await h.advance(1)
  assert.deepEqual(await result, { kind: 'retry' })
  assert.equal(await h.recover({ turn: 2 }), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 1, 'restart budget must stay bounded')
  // A completed turn closes the chain and replenishes the restart budget.
  h.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  result = h.recover({ turn: 3 })
  await h.advance(1)
  assert.deepEqual(await result, { kind: 'retry' })
  assert.equal(await h.recover({ turn: 3 }), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 2)
  await h.dispose()
})

test('a real user prompt withdraws a queued restart and resets its budget', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1, maxRestarts: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  assert.equal(await h.recover(), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 1)
  const queued = h.agent.followups[0]
  const user = userMessage()
  h.agent.inbox.nextTurn.push(user)
  h.emit('agent/inbox/inserted', { agent: h.agent, message: user })
  assert.equal(h.agent.inbox.nextTurn.some(message => message.id === queued.id), false)
  // The user's queued turn claims the inbox before any further failure chain.
  h.claim(user)
  // New chain after the user takes over: the restart budget is available again.
  result = h.recover({ turn: 2 })
  await h.advance(1)
  assert.deepEqual(await result, { kind: 'retry' })
  assert.equal(await h.recover({ turn: 2 }), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 2)
  await h.dispose()
})

test('a foreign automatic prompt also withdraws a queued restart', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1, maxRestarts: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  await h.recover()
  h.goIdle()
  const queued = h.agent.followups[0]
  assert.ok(queued)
  const goal = staticGoalMessage(h)
  assert.equal(h.agent.inbox.nextTurn.some(message => message.id === queued.id), false)
  h.claim(goal)
  result = h.recover({ turn: 2 })
  await h.advance(1)
  assert.deepEqual(await result, { kind: 'retry' })
  await h.dispose()
})

function staticGoalMessage(h) {
  const goal = { id: 'g1', role: 'user', content: [{ type: 'text', text: '<goal_round>continue</goal_round>' }], source: { kind: 'goal', goalId: 'g', revision: 1, round: 1 } }
  h.agent.inbox.nextTurn.push(goal)
  h.emit('agent/inbox/inserted', { agent: h.agent, message: goal })
  return goal
}

test('a discarded restart refunds its budget slot', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1, maxRestarts: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  await h.recover()
  h.goIdle()
  const queued = h.agent.followups[0]
  h.agent.inbox.remove(queued.id)
  h.emit('agent/inbox/discarded', { agent: h.agent, message: queued })
  result = h.recover({ turn: 2 })
  await h.advance(1)
  assert.deepEqual(await result, { kind: 'retry' })
  assert.equal(await h.recover({ turn: 2 }), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 2)
  await h.dispose()
})

test('a turn restart is queued from the idle transition, not during the failing turn', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  assert.equal(await h.recover(), undefined)
  assert.equal(h.agent.followups.length, 0)
  h.goIdle()
  assert.equal(h.agent.followups.length, 1)
  await h.dispose()
})

test('a pending user prompt takes precedence over the restart', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  h.agent.inbox.nextTurn.push(userMessage())
  assert.equal(await h.recover(), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('a pending automatic notice does not block the restart', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  const notice = { id: 'n1', role: 'user', content: [{ type: 'text', text: 'subagent finished' }], source: { kind: 'subagent-settled', form: 'notice' } }
  h.agent.inbox.nextStep.push(notice)
  assert.equal(await h.recover(), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 1)
  assert.deepEqual(h.agent.inbox.nextStep, [notice])
  await h.dispose()
})

test('a pending goal round takes precedence over the restart', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  staticGoalMessage(h)
  assert.equal(await h.recover(), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('no restart is queued after a user stop', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  h.controller.abort()
  assert.equal(await h.recover(), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('pre-step admits the reserved restart with a fresh request series', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  await h.recover()
  h.goIdle()
  const restart = h.agent.inbox.nextTurn[0]
  h.claim(restart)
  const decision = await h.waterfall('agent/pre-step', { agent: h.agent, messages: [restart], signal: h.controller.signal }, { kind: 'enter', messages: [restart] })
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.startsRequestSeries, true)
  await h.dispose()
})

test('pre-step rejects a restart whose reservation was reset', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  await h.recover()
  h.goIdle()
  const restart = h.agent.inbox.nextTurn[0]
  h.claim(restart)
  h.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const decision = await h.waterfall('agent/pre-step', { agent: h.agent, messages: [restart], signal: h.controller.signal }, { kind: 'enter', messages: [restart] })
  assert.equal(decision.kind, 'reject')
  await h.dispose()
})

test('unload withdraws a queued restart prompt', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1 })
  let result = h.recover()
  await h.advance(1)
  await result
  await h.recover()
  h.goIdle()
  const queued = h.agent.followups[0]
  assert.ok(h.agent.inbox.nextTurn.some(message => message.id === queued.id))
  await h.dispose()
  assert.equal(h.agent.inbox.nextTurn.some(message => message.id === queued.id), false)
})

test('maxRestarts zero keeps the same-request-only behavior', async t => {
  const h = harness(t, { delayMs: 1, maxContinues: 1, maxRestarts: 0 })
  let result = h.recover()
  await h.advance(1)
  await result
  assert.equal(await h.recover(), undefined)
  h.goIdle()
  assert.equal(h.agent.followups.length, 0)
  await h.dispose()
})

test('restart prompt is bounded and keeps the failure fact visible', () => {
  const failure = { code: 'PI_AI_ERROR', message: `server_error: ${'overloaded '.repeat(100)}` }
  const text = restartPrompt(failure, 2, 3)[0].text
  assert.match(text, /PI_AI_ERROR/)
  assert.match(text, /第 2\/3 次自动重启/)
  assert.match(text, /不是用户的新指令/)
  assert.ok(text.length < 500, 'restart prompt must stay bounded')
})

test('config validates restart caps, classification switches and rejects unsafe values', () => {
  assert.equal(resolveConfig().maxRestarts, 2)
  assert.equal(resolveConfig().retryUnclassified, true)
  assert.deepEqual(resolveConfig().excludeIncludes, [])
  for (const raw of [
    { maxRestarts: -1 }, { maxRestarts: 1.5 }, { maxRestarts: Number.MAX_SAFE_INTEGER + 1 },
    { delayMs: 2147483648 }, { maxContinues: Number.MAX_SAFE_INTEGER + 1 },
    { retryUnclassified: 'yes' }, { retryUnclassified: 1 },
    { excludeIncludes: 'x' }, { excludeIncludes: [42] },
    { toString: 'x' }, { delayMs: 100, maxDelayMs: 10 },
  ]) assert.throws(() => resolveConfig(raw))
  assert.throws(() => resolveConfig({ unknownKnob: true }), /unknown config key/)
})
