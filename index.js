/**
 * Bounded, cancellable recovery for transient model-request failures.
 * Same-request retries first, then bounded automatic turn restarts.
 *
 * The first stage retries the failed model request in place and never
 * fabricates a human follow-up. The second stage, reached only after that
 * bounded in-step budget is exhausted, queues one bounded same-session turn
 * restart so a fresh request can outlast a longer upstream outage without the
 * plugin ever sending an unbounded stream of identical requests.
 *
 * @module @zzhaobh/dsh-server-error-continue
 */
import { randomUUID } from 'node:crypto'

export const name = 'server-error-continue'
export const inject = ['agents']

const MAX_TIMER_MS = 2_147_483_647
/** Reserved message-source kind of the plugin's own turn-restart prompt. */
const RESTART_SOURCE_KIND = 'server-error-continue'
const DEFAULTS = Object.freeze({
  prompt: 'continue', // Accepted for v1 configuration compatibility; not sent.
  delayMs: 1000,
  maxDelayMs: 30_000,
  maxContinues: 3,
  maxRestarts: 2,
  codes: Object.freeze(['SERVER']),
  messageIncludes: Object.freeze(['server_error', 'upstream_error', 'overloaded']),
  excludeIncludes: Object.freeze([]),
  retryUnclassified: true,
})
const TERMINAL_CODES = new Set([
  'AUTH', 'QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED',
  'ABORTED', 'CANCELED', 'CANCELLED', 'NO_ADAPTER',
])
// Adapter wrapper codes whose text is the only classification signal.
const FALLBACK_CODES = new Set(['PI_AI_ERROR', 'UNKNOWN'])
// HTTP statuses that are transient despite being 4xx.
const TRANSIENT_STATUS = new Set([408, 425, 429])
// Non-transient facts no gateway wording may override. Matched before every retry rule.
const PERMANENT_TEXT = Object.freeze([
  /invalid[_ ](?:schema|request|parameter|argument|api[_ ]key|model|response)/,
  /unauthori[sz]ed/,
  /forbidden/,
  /permission (?:denied|error)/,
  /auth(?:entication|orization)?[_ ]?(?:fail|error|required)/,
  /\b40[13]\b/,
  /quota/,
  /insufficient/,
  /billing/,
  /payment/,
  /(?:insufficient|out[_ ]of|low)[_ ](?:balance|credit|funds)/,
  /context[_ ](?:length|window|overflow)/,
  /maximum context/,
  /too many tokens/,
  /token limit/,
  /request (?:body )?too large/,
  /payload too large/,
  /\b413\b/,
  /model[_ ]not[_ ]found/,
  /model[_ ]unsupported/,
  /not supported/,
  /unsupported/,
  /does not exist/,
  /no available (?:channel|account|model|capacity)/,
  /no configured account/,
  /content[_ ]policy/,
  /content[_ ]filter/,
  /response incomplete: content[_ ]filter/,
  /safety (?:system|policy|filter)/,
  /moderation/,
  /flagged/,
  /violat(?:e|es|ion)/,
  /deferred response/,
  /ended pending/,
  /account[_ ]sign[_ ]in/,
  /token[_ ]invalid/,
  /client[_ ]upgrade/,
])
// Gateway-side replay faults. The request is well-formed; an encrypted reasoning
// item stored in session history cannot be decrypted by the newly routed upstream
// account (callers see HTTP 400 / INVALID_REQUEST). Retrying can recover because
// the gateway may route the next attempt back to the producing account.
const TRANSIENT_OVERRIDE_TEXT = Object.freeze([
  /encrypted (?:content|reasoning).*could not be (?:verified|decrypted|parsed)/,
  /could not be decrypted or parsed/,
  /could not (?:verify|decrypt|parse).*encrypted/,
  /failed to (?:verify|decrypt|parse).*encrypted/,
  /previous_response_id.*not found/,
  /previous response (?:with id .* )?not found/,
  // Upstream transport breaks mid-stream: Python gateways report these as 400,
  // and adapter classifiers then see "400" and mark INVALID_REQUEST.
  /上游流中途断开/,
  /连接(?:被)?重置/,
  /指定的网络名不再可用/,
  /upstream stream (?:disconnected|closed|reset|interrupted)/,
  /stream (?:was )?(?:interrupted|disconnected)/,
  /(?:response )?payload is not completed/,
  /transferencodingerror/,
  /not enough data to satisfy transfer length header/,
  /connectionreseterror/,
  /connection reset by peer/,
  /network name is no longer available/,
  /incomplete chunked read/,
  /peer closed connection without sending (?:complete|full) message body/,
  /remote protocol error/,
  /broken pipe/,
  /server disconnected/,
])
// Transient wording used as the allowlist when `retryUnclassified` is off.
const TRANSIENT_TEXT = Object.freeze([
  /server_error/,
  /upstream_error/,
  /upstream request failed/,
  /upstream (?:connect error|response|service|request)/,
  /connection (?:reset|refused|closed|terminated|aborted|termination)/,
  /disconnect/,
  /bad gateway/,
  /gateway time-?out/,
  /service (?:temporarily )?unavailable/,
  /temporarily unavailable/,
  /internal server error/,
  /rate.?limit/,
  /too many requests/,
  /overloaded/,
  /timed? ?out/,
  /timeout/,
  /请求超时/,
  /超时/,
  /stream (?:ended|closed) (?:before|without|unexpectedly)/,
  /stream idle timeout/,
  /unexpected eof/,
  /premature (?:close|end)/,
  /socket hang up/,
  /network (?:error|failure|unreachable)/,
  /econn(?:reset|refused|aborted)/,
  /etimedout/,
  /eai_again/,
  /epipe/,
  /terminated/,
  /上游流中途断开/,
  /连接(?:被)?重置/,
  /指定的网络名不再可用/,
  /upstream stream (?:disconnected|closed|reset|interrupted)/,
  /(?:response )?payload is not completed/,
  /transferencodingerror/,
  /not enough data to satisfy transfer length header/,
  /connectionreseterror/,
  /network name is no longer available/,
  /incomplete chunked read/,
  /peer closed connection without sending (?:complete|full) message body/,
  /remote protocol error/,
  /broken pipe/,
  /server disconnected/,
  /try again later/,
  /please retry/,
  /retry later/,
  /稍后重试/,
  /服务(?:暂时)?不可用/,
  /上游/,
  /限流/,
  /繁忙/,
  /过载/,
  /\b(?:502|503|504)\b/,
])

function failureOf(error) {
  return error?.failure !== null && typeof error?.failure === 'object' ? error.failure : error
}
export function messageOf(error) {
  const failure = failureOf(error)
  return typeof failure?.message === 'string' ? failure.message : typeof error === 'string' ? error : ''
}
export function codeOf(error) {
  const code = failureOf(error)?.code
  return typeof code === 'string' ? code : undefined
}
export function statusOf(error) {
  const status = failureOf(error)?.status
  return Number.isInteger(status) ? status : undefined
}

/** Whether the text names a gateway-side replay/account-affinity fault. */
export function hasTransientOverride(message) {
  return TRANSIENT_OVERRIDE_TEXT.some(pattern => pattern.test(message))
}

/** Whether one failure is a permanent fact no retry rule may override. */
export function isPermanentFailure(error, excludes = []) {
  const message = messageOf(error).toLowerCase()
  if (excludes.some(needle => message.includes(needle))) return true
  // Gateway replay faults look like malformed 400 requests to the adapter but recover on a fresh route.
  if (hasTransientOverride(message)) return false
  const code = codeOf(error)
  if (code === undefined || TERMINAL_CODES.has(code)) return true
  const status = statusOf(error)
  if (status !== undefined && status >= 400 && status < 500 && !TRANSIENT_STATUS.has(status)) return true
  return PERMANENT_TEXT.some(pattern => pattern.test(message))
}

/**
 * Classify one failure as recoverable. Permanent facts win over every retry
 * rule, transient HTTP statuses beat the generic 4xx exclusion, and adapter
 * wrapper codes (PI_AI_ERROR/UNKNOWN) fall back to text.
 */
export function createMatcher(config) {
  const codes = new Set(config.codes)
  const needles = config.messageIncludes.map(value => value.toLowerCase())
  const excludes = config.excludeIncludes.map(value => value.toLowerCase())
  const unclassified = config.retryUnclassified !== false
  return error => {
    if (isPermanentFailure(error, excludes)) return false
    const code = codeOf(error)
    const status = statusOf(error)
    const message = messageOf(error).toLowerCase()
    if (hasTransientOverride(message)) return true
    if (codes.has(code)) return true
    if (status !== undefined && status >= 500 && status <= 599) return true
    if (status !== undefined && TRANSIENT_STATUS.has(status)) return true
    // PI_AI_ERROR and UNKNOWN are generic adapter wrappers, not normalized codes.
    if (!FALLBACK_CODES.has(code)) return false
    if (needles.some(needle => message.includes(needle))) return true
    if (TRANSIENT_TEXT.some(pattern => pattern.test(message))) return true
    return unclassified
  }
}

function requireString(value, key) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`server-error-continue: ${key} must be a non-empty string`)
  }
  return value
}
function requireCount(value, key, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`server-error-continue: ${key} must be an integer from 0 through ${maximum}`)
  }
  return value
}
function requireStringList(value, key) {
  if (!Array.isArray(value)) throw new Error(`server-error-continue: ${key} must be an array of strings`)
  return value.map(entry => requireString(entry, `${key}[]`))
}
function requireBoolean(value, key) {
  if (typeof value !== 'boolean') throw new Error(`server-error-continue: ${key} must be a boolean`)
  return value
}
export function resolveConfig(raw = {}) {
  if (raw == null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('server-error-continue: config must be an object')
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`server-error-continue: unknown config key "${key}"`)
  }
  const config = {
    prompt: requireString(raw.prompt ?? DEFAULTS.prompt, 'prompt'),
    delayMs: requireCount(raw.delayMs ?? DEFAULTS.delayMs, 'delayMs', MAX_TIMER_MS),
    maxDelayMs: requireCount(raw.maxDelayMs ?? DEFAULTS.maxDelayMs, 'maxDelayMs', MAX_TIMER_MS),
    maxContinues: requireCount(raw.maxContinues ?? DEFAULTS.maxContinues, 'maxContinues'),
    maxRestarts: requireCount(raw.maxRestarts ?? DEFAULTS.maxRestarts, 'maxRestarts'),
    codes: requireStringList(raw.codes ?? [...DEFAULTS.codes], 'codes'),
    messageIncludes: requireStringList(raw.messageIncludes ?? [...DEFAULTS.messageIncludes], 'messageIncludes'),
    excludeIncludes: requireStringList(raw.excludeIncludes ?? [...DEFAULTS.excludeIncludes], 'excludeIncludes'),
    retryUnclassified: requireBoolean(raw.retryUnclassified ?? DEFAULTS.retryUnclassified, 'retryUnclassified'),
  }
  if (config.maxDelayMs < config.delayMs) throw new Error('server-error-continue: maxDelayMs must be >= delayMs')
  return config
}

/** Read one message's source object without trusting its shape. */
function sourceOf(message) {
  const source = message?.source
  return typeof source === 'object' && source !== null && !Array.isArray(source) ? source : undefined
}
/** Recognize the plugin's own queued restart prompt across reloads and splices. */
function isRestartMessage(message) {
  return sourceOf(message)?.kind === RESTART_SOURCE_KIND
}
/** Whether one message came from the human client rather than another producer. */
function isUserMessage(message) {
  return sourceOf(message)?.kind === 'user'
}
/** Count every pending prompt the agent would run before a restarted turn. */
function queuedInput(agent) {
  return (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0)
}
/** Render the model-visible restart prompt retained in session history. */
export function restartPrompt(failure, restart, maxRestarts) {
  const code = codeOf(failure) ?? 'UNKNOWN'
  const message = messageOf(failure).trim()
  const detail = message.length === 0 ? code : `${code}: ${message.length > 240 ? `${message.slice(0, 239)}…` : message}`
  return [{
    type: 'text',
    text: [
      '<server_error_restart>',
      `上一次模型请求被服务端临时错误中断（${detail}）。`,
      `这是第 ${restart}/${maxRestarts} 次自动重启，不是用户的新指令。`,
      '请依据当前会话里已经记录的工具结果、文件状态和已完成的工作继续原任务，不要重复已完成的工作，也不要因这次中断降低验证标准；若服务已恢复，直接继续下一步。',
      '</server_error_restart>',
    ].join('\n'),
  }]
}

/** Detach and deeply freeze one message so the Loader never hands out mutable history. */
function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/** Build the plugin's own user-role restart message with a reserved source kind. */
export function createRestartMessage(failure, restart, maxRestarts) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: restartPrompt(failure, restart, maxRestarts),
    source: { kind: RESTART_SOURCE_KIND, restart, code: codeOf(failure) ?? 'UNKNOWN' },
  })
}

/** Returns false on cancellation and removes both timer and listener. */
function wait(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    function finish(value) {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    function onAbort() { finish(false) }
    const timer = setTimeout(() => finish(true), delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const matches = createMatcher(config)
  const lifetime = new AbortController()
  // One live failed request per Agent; new steps/signals do not inherit a budget.
  const attempts = new WeakMap()
  // One bounded restart chain per Agent: extra turns, not extra identical requests.
  const chains = new WeakMap()
  const active = new Set()
  const queuedRestarts = new Set()
  if (rawConfig?.prompt !== undefined) {
    ctx.logger.warn('[server-error-continue] prompt is deprecated; recovery now retries the same model request and restarts at most a bounded number of turns')
  }
  if (config.maxContinues === 0 && config.maxRestarts > 0) {
    ctx.logger.warn('[server-error-continue] maxContinues 0 keeps same-request retries unlimited, so turn restarts are unreachable')
  }

  /** Restart-chain state for one Agent; created lazily and never enumerated. */
  function chainOf(agent) {
    let state = chains.get(agent)
    if (state === undefined) {
      state = { restarts: 0, pending: undefined }
      chains.set(agent, state)
    }
    return state
  }
  /** Forget one Agent's chain without touching its durable inbox. */
  function forget(agent) {
    chains.delete(agent)
    queuedRestarts.delete(agent)
  }
  /** Withdraw one queued restart prompt and optionally refund its budget slot. */
  function dropPending(agent, state, refund) {
    const pending = state.pending
    if (pending === undefined) return
    state.pending = undefined
    queuedRestarts.delete(agent)
    if (refund && pending.phase === 'queued' && state.restarts > 0) state.restarts -= 1
    try {
      if (agent.inbox?.remove?.(pending.id) === false) return
    } catch (error) {
      ctx.logger.warn('[server-error-continue] agent %s could not withdraw its queued turn restart: %s', agent.id, String(error))
    }
  }
  /** End the current restart chain: a non-error turn or a real user prompt takes over. */
  function resetChain(agent) {
    const state = chains.get(agent)
    if (state === undefined) return
    dropPending(agent, state, true)
    state.restarts = 0
    state.pending = undefined
  }

  /**
   * Queue one same-session turn restart after the in-step budget is exhausted.
   * Returns whether a restart prompt was queued.
   */
  function scheduleRestart(agent, failure, signal, used) {
    if (config.maxRestarts === 0) return false
    const state = chainOf(agent)
    if (state.pending !== undefined && state.pending.phase === 'queued') return false
    if (state.restarts >= config.maxRestarts) {
      ctx.logger.warn('[server-error-continue] agent %s exhausted %d turn restarts; leaving the failure terminal', agent.id, config.maxRestarts)
      return false
    }
    if (signal.aborted || ctx.agents.get(agent.id) !== agent) return false
    if (queuedInput(agent) > 0) {
      ctx.logger.warn('[server-error-continue] agent %s has pending input; not restarting the turn', agent.id)
      return false
    }
    const restart = state.restarts + 1
    const message = createRestartMessage(failure, restart, config.maxRestarts)
    try {
      agent.followup(message)
    } catch (error) {
      ctx.logger.warn('[server-error-continue] agent %s could not queue a turn restart: %s', agent.id, String(error))
      return false
    }
    state.restarts = restart
    state.pending = { id: message.id, phase: 'queued', restart }
    queuedRestarts.add(agent)
    ctx.logger.warn('[server-error-continue] agent %s queued turn restart %d/%d after %d in-step retries', agent.id, restart, config.maxRestarts, used)
    return true
  }

  /** Whether the built-in provider retry already owns (and spent) this code's budget. */
  function providerExhausted(failure, retryPolicy) {
    return retryPolicy?.mode === 'normal'
      && Array.isArray(retryPolicy.retryableCodes)
      && retryPolicy.retryableCodes.includes(codeOf(failure))
  }

  async function recover(payload, next) {
    // Other recovery owners (including built-in retry) have precedence.
    const downstream = await next()
    if (downstream !== undefined) return downstream
    const { agent, turn, step, signal, failure, retryPolicy } = payload
    const fused = AbortSignal.any([signal, lifetime.signal])
    if (fused.aborted || ctx.agents.get(agent.id) !== agent) return
    // A provider "always" policy owns recovery forever; never race it with restarts.
    if (retryPolicy?.mode === 'always') return
    // A normal provider policy already spent its own retries on this code; escalate instead
    // of stacking more identical in-step requests behind it.
    if (providerExhausted(failure, retryPolicy)) {
      if (isPermanentFailure(failure, config.excludeIncludes.map(value => value.toLowerCase()))) {
        ctx.logger.warn('[server-error-continue] agent %s provider-managed %s stayed terminal; not restarting', agent.id, codeOf(failure) ?? 'UNKNOWN')
        return
      }
      ctx.logger.warn('[server-error-continue] agent %s escalating %s to a turn restart after provider retries', agent.id, codeOf(failure) ?? 'UNKNOWN')
      scheduleRestart(agent, failure, fused, 0)
      return
    }
    if (!matches(failure)) return
    let state = attempts.get(agent)
    if (state === undefined || state.turn !== turn || state.step !== step || state.signal !== signal) {
      state = { turn, step, signal, used: 0 }
      attempts.set(agent, state)
    }
    if (config.maxContinues > 0 && state.used >= config.maxContinues) {
      ctx.logger.warn('[server-error-continue] agent %s stopped after %d extra request retries', agent.id, state.used)
      // Escalate to a bounded new turn instead of repeating the same request forever.
      scheduleRestart(agent, failure, fused, state.used)
      return
    }
    const exponential = config.delayMs === 0 ? 0 : Math.min(config.maxDelayMs, config.delayMs * 2 ** Math.min(state.used, 31))
    const hint = failure.providerRetryAfterMs
    if (Number.isFinite(hint) && hint > config.maxDelayMs) {
      ctx.logger.warn('[server-error-continue] agent %s Retry-After exceeds maxDelayMs; leaving failure terminal', agent.id)
      return
    }
    const delayMs = Number.isFinite(hint) && hint > 0 ? Math.max(exponential, hint) : exponential
    state.used += 1
    ctx.logger.warn('[server-error-continue] agent %s waiting %dms for extra request retry %d (%s)', agent.id, delayMs, state.used, failure.code)
    if (!await wait(delayMs, fused)) return
    if (fused.aborted || ctx.agents.get(agent.id) !== agent) return
    return { kind: 'retry' }
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    const operation = recover(payload, next)
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  })
  // A claimed restart no longer needs withdrawal; a discarded one refunds its slot.
  const disposeClaimed = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const state = chains.get(agent)
    if (state?.pending === undefined || state.pending.id !== message?.id) return
    state.pending.phase = 'claimed'
    queuedRestarts.delete(agent)
  })
  const disposeDiscarded = ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    const state = chains.get(agent)
    if (state?.pending === undefined || state.pending.id !== message?.id) return
    state.pending = undefined
    queuedRestarts.delete(agent)
    if (state.restarts > 0) state.restarts -= 1
  })
  // Real user input or another automatic producer takes precedence over this restart.
  const disposeInserted = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message === undefined || isRestartMessage(message)) return
    const state = chains.get(agent)
    if (state === undefined) return
    if (isUserMessage(message)) {
      resetChain(agent)
      return
    }
    if (state.pending !== undefined && state.pending.phase === 'queued') {
      dropPending(agent, state, true)
      state.restarts = 0
    }
  })
  // Any turn that does not end in an error closes the restart chain.
  const disposeTurnEnd = ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const agent = ctx.agents.get(session?.id)
    if (agent === undefined) return
    if (event.data?.reason?.kind === 'error') return
    resetChain(agent)
  })
  // Fail closed if a restart prompt outlives its reservation (unload, reset, replay).
  const disposePreStep = ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const submitted = messages.find(isRestartMessage)
    if (submitted === undefined) return next()
    const state = chains.get(agent)
    const pending = state?.pending
    const valid = ctx.agents.get(agent.id) === agent
      && !signal.aborted
      && pending !== undefined
      && pending.id === submitted.id
    if (!valid) {
      if (pending !== undefined && pending.id === submitted.id) {
        state.pending = undefined
        queuedRestarts.delete(agent)
      }
      ctx.logger.warn('[server-error-continue] agent %s rejected a stale turn restart', agent.id)
      return { kind: 'reject' }
    }
    let decision
    try {
      decision = await next()
    } catch (error) {
      state.pending = undefined
      queuedRestarts.delete(agent)
      throw error
    }
    if (decision.kind === 'reject') {
      state.pending = undefined
      queuedRestarts.delete(agent)
      return decision
    }
    return { ...decision, startsRequestSeries: true }
  })
  const disposeAgent = ctx.on('agent/disposed', ({ agent }) => {
    forget(agent)
  })
  ctx.effect(() => async () => {
    for (const dispose of [disposeListener, disposeClaimed, disposeDiscarded, disposeInserted, disposeTurnEnd, disposePreStep, disposeAgent]) dispose()
    for (const agent of [...queuedRestarts]) {
      const state = chains.get(agent)
      if (state !== undefined) dropPending(agent, state, false)
    }
    queuedRestarts.clear()
    lifetime.abort(new Error('server-error-continue disposed'))
    await Promise.allSettled([...active])
  }, 'server-error-continue: abort and drain request recovery')
}
