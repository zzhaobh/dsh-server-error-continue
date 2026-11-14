import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

// Run with the installed Electron runtime, for example:
// ELECTRON_RUN_AS_NODE=1 DSH_CORDIS_ENTRY="/Applications/DeepSeek Harness.app/.../cordis/lib/index.js" \
//   "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/cordis-mount.mjs
const entry = process.env.DSH_CORDIS_ENTRY
assert.ok(entry, 'DSH_CORDIS_ENTRY must point to the installed Cordis lib/index.js')
const { Context } = await import(pathToFileURL(entry).href)
const ctx = new Context()
const agent = { id: 'cordis-smoke' }
const agents = new Map([[agent.id, agent]])
const registrations = []
const effects = []

assert.equal(typeof ctx.reflect?.provide, 'function', 'real Cordis Context must expose service registration')
ctx.reflect.provide('agents', { get: id => agents.get(id) })

const on = ctx.on.bind(ctx)
ctx.on = (name, listener, options) => {
  registrations.push({ name, listener, options })
  return on(name, listener, options)
}
const effect = ctx.effect.bind(ctx)
ctx.effect = (register, ...args) => {
  const cleanup = effect(register, ...args)
  effects.push(cleanup)
  return cleanup
}

apply(ctx, { delayMs: 1, maxDelayMs: 1, maxContinues: 1 })
assert.deepEqual(registrations.map(entry => entry.name), ['agent/request-error'])
assert.deepEqual(Object.keys(agent), ['id'])

const controller = new AbortController()
const result = await registrations[0].listener({
  agent,
  turn: 1,
  step: 1,
  provider: 'cordis-smoke',
  failure: { code: 'TRANSPORT', message: 'Connection error.' },
  retryPolicy: undefined,
  signal: controller.signal,
}, async () => undefined)
assert.deepEqual(result, { kind: 'retry' })

assert.equal(effects.length, 2, 'listener disposal plus plugin recovery cleanup')
for (const cleanup of effects) await cleanup?.()
console.log(JSON.stringify({
  ok: true,
  cordisContext: true,
  runtime: process.version,
  registeredHooks: registrations.map(entry => entry.name),
  retry: result,
  effectsDisposed: effects.length,
  networkRequests: 0,
}))
