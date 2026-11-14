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

export const name = 'server-error-continue'
export const inject = ['agents']

const MAX_TIMER_MS = 2_147_483_647
const LEGACY_KEYS = Object.freeze(['prompt', 'maxRestarts', 'fallbackProvider', 'fallbackModel'])
const DEFAULTS = Object.freeze({
  delayMs: 1000,
  maxDelayMs: 30_000,
  maxContinues: 3,
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
// Provider-managed transport codes that stay recoverable even when a provider
// supplies no retry policy; otherwise a missing policy would make them terminal.
const TRANSIENT_CODES = new Set(['SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'EMPTY_RESPONSE'])
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
  /connection (?:error|failed|failure)/,
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
  /connection (?:error|failed|failure)/,
  /connect error/,
  /网络(?:连接)?错误/,
  /连接失败/,
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

/** Content filtering is a policy outcome, never a transport or replay fault. */
export function isContentFilterFailure(error) {
  const code = codeOf(error)?.toUpperCase()
  return code === 'CONTENT_FILTER' || code === 'CONTENT_POLICY_VIOLATION'
    || /\bcontent[_ -](?:filter|policy)(?=$|[^a-z0-9])/i.test(messageOf(error))
}

/** Whether one failure is a permanent fact no retry rule may override. */
export function isPermanentFailure(error, excludes = []) {
  if (isContentFilterFailure(error)) return true
  const message = messageOf(error).toLowerCase()
  if (excludes.some(needle => message.includes(needle))) return true
  const code = codeOf(error)
  if (code === undefined) return true
  // Explicit terminal facts and permanent text always win. Only an otherwise
  // well-formed pseudo-400 may use the bounded transport/replay override.
  if (code !== 'INVALID_REQUEST' && TERMINAL_CODES.has(code)) return true
  if (PERMANENT_TEXT.some(pattern => pattern.test(message))) return true
  if (hasTransientOverride(message)) return false
  if (TERMINAL_CODES.has(code)) return true
  const status = statusOf(error)
  if (status !== undefined && status >= 400 && status < 500 && !TRANSIENT_STATUS.has(status)) return true
  return false
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
    if (codes.has(code) || TRANSIENT_CODES.has(code)) return true
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
  const allowed = new Set([...Object.keys(DEFAULTS), ...LEGACY_KEYS])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`server-error-continue: unknown config key "${key}"`)
  }
  const requireDelay = (value, key) => {
    requireCount(value, key, MAX_TIMER_MS)
    if (value < 1) throw new Error(`server-error-continue: ${key} must be at least 1`)
    return value
  }
  const config = {
    delayMs: requireDelay(raw.delayMs ?? DEFAULTS.delayMs, 'delayMs'),
    maxDelayMs: requireDelay(raw.maxDelayMs ?? DEFAULTS.maxDelayMs, 'maxDelayMs'),
    maxContinues: requireCount(raw.maxContinues ?? DEFAULTS.maxContinues, 'maxContinues'),
    codes: requireStringList(raw.codes ?? [...DEFAULTS.codes], 'codes'),
    messageIncludes: requireStringList(raw.messageIncludes ?? [...DEFAULTS.messageIncludes], 'messageIncludes'),
    excludeIncludes: requireStringList(raw.excludeIncludes ?? [...DEFAULTS.excludeIncludes], 'excludeIncludes'),
    retryUnclassified: requireBoolean(raw.retryUnclassified ?? DEFAULTS.retryUnclassified, 'retryUnclassified'),
  }
  if (config.maxDelayMs < config.delayMs) throw new Error('server-error-continue: maxDelayMs must be >= delayMs')
  return config
}

/** Reject on cancellation and remove both timer and listener. */
function abortReason(signal) {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function wait(delayMs, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    function onAbort() { finish(abortReason(signal)) }
    const timer = setTimeout(() => finish(), delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const matches = createMatcher(config)
  const lifetime = new AbortController()
  // Budgets live only in this plugin. New turns, steps, and signals do not
  // inherit them, and no session history is consulted or mutated.
  const attempts = new WeakMap()
  const active = new Set()
  const ignored = LEGACY_KEYS.filter(key => rawConfig?.[key] !== undefined)
  if (ignored.length > 0) {
    ctx.logger.warn('[server-error-continue] ignored legacy keys: %s; recovery now only retries the failed request', ignored.join(', '))
  }

  /** Native normal policy owns its eligible code and is never supplemented. */
  function providerExhausted(failure, retryPolicy) {
    return retryPolicy?.mode === 'normal'
      && Array.isArray(retryPolicy.retryableCodes)
      && retryPolicy.retryableCodes.includes(codeOf(failure))
  }

  async function recover(payload, next) {
    const { agent, turn, step, signal, failure, retryPolicy } = payload
    // Policy outcomes must not reach a downstream always-retry owner.
    if (isContentFilterFailure(failure)) {
      ctx.logger.warn('[server-error-continue] agent %s content_filter: skipping automatic recovery', agent.id)
      return
    }
    const downstream = await next()
    if (downstream !== undefined) return downstream
    if (signal.aborted) throw abortReason(signal)
    if (lifetime.signal.aborted) throw abortReason(lifetime.signal)
    if (retryPolicy?.mode === 'always') return
    if (providerExhausted(failure, retryPolicy)) return
    if (!matches(failure)) return

    let state = attempts.get(agent)
    if (state === undefined || state.turn !== turn || state.step !== step || state.signal !== signal) {
      state = { turn, step, signal, used: 0 }
      attempts.set(agent, state)
    }
    if (config.maxContinues > 0 && state.used >= config.maxContinues) {
      ctx.logger.warn('[server-error-continue] agent %s stopped after %d extra request retries', agent.id, state.used)
      return
    }
    if (ctx.agents.get(agent.id) !== agent) return

    const exponential = Math.min(config.maxDelayMs, config.delayMs * 2 ** Math.min(state.used, 31))
    const hint = failure.providerRetryAfterMs
    if (Number.isFinite(hint) && hint > config.maxDelayMs) {
      ctx.logger.warn('[server-error-continue] agent %s Retry-After exceeds maxDelayMs; leaving failure terminal', agent.id)
      return
    }
    const delayMs = Number.isFinite(hint) && hint > 0 ? Math.max(exponential, hint) : exponential
    state.used += 1
    ctx.logger.warn('[server-error-continue] agent %s waiting %dms for extra request retry %d (%s)', agent.id, delayMs, state.used, codeOf(failure) ?? 'UNKNOWN')

    const fused = AbortSignal.any([signal, lifetime.signal])
    await wait(delayMs, fused)
    if (fused.aborted) throw abortReason(fused)
    if (ctx.agents.get(agent.id) !== agent) return
    return { kind: 'retry' }
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    const operation = recover(payload, next)
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }, { prepend: true })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('server-error-continue disposed'))
    await Promise.allSettled([...active])
  }, 'server-error-continue: abort and drain request recovery')
}
