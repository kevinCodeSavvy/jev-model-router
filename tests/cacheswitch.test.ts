import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { On, SessionStartInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'

tier('user')

const NOW = 5_000_000
const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }
const options = { typesafeApiKey: 'test-key', shadowOpus: false, routeMainModel: true, routeMainEffort: false }

/** Jev answering with a tier it is sure of: 'fast' makes the router want Haiku, 'balanced' keeps Sonnet. */
const answer = (choice: 'fast' | 'balanced') =>
  JSON.stringify({
    model: 'jev-1.13',
    answers: {
    tier: { type: 'choice', choice, confidence: 0.95, probabilities: { [choice]: 0.95 } },
    effort: { type: 'score', score: 0.5, confidence: 0.8 },
    risky: { type: 'noul', noul: 0.01 },
    },
  })

function world(on: On, stored: Map<string, unknown> = new Map()) {
  const logs: string[] = []
  const sent: string[] = []
  const jev = { choice: 'fast' as 'fast' | 'balanced' }
  mock.clock(on, { now: NOW })
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: answer(jev.choice) } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.measure', () => ({ changed: [] }))
  on('turn.step', async function* ($, e) {
    sent.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { logs, sent, jev }
}

async function turn($: Engine, id: string, model: string, tokens: number) {
  await $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [], changed: [] })
  await $.prompt.submit({ text: 'a small task', wait: false, origin: { kind: 'composer' } })
  const step = $.turn.step({ turnId: id, index: 0, model, messageCount: 4 })
  for await (const _chunk of step) {
    // drain
  }
}

/** One turn Jev keeps on Sonnet, so Sonnet's cache counts as warm for the next. */
async function warmSonnet($: Engine, jev: { choice: 'fast' | 'balanced' }) {
  jev.choice = 'balanced'
  await turn($, 't0', 'claude-sonnet-5-5', 184_000)
  jev.choice = 'fast'
}

describe('cache-aware main-loop switching', () => {
  test('a small context switches to Haiku as before', { options }, async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await turn($, 't1', 'claude-sonnet-5-5', 12_000)
    expect(w.sent[0]).toContain('haiku')
  })

  test('a 184k context stays on Sonnet, and the log says why', { options }, async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await warmSonnet($, w.jev)
    await turn($, 't2', 'claude-sonnet-5-5', 184_000)
    expect(w.sent[1]).toBe('claude-sonnet-5-5')
    expect(w.logs.some((line) => line.includes('kept balanced') && line.includes('184k context'))).toBe(true)
  })

  test('cacheAware off switches at any size', { options: { ...options, cacheAware: false } }, async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await warmSonnet($, w.jev)
    await turn($, 't2', 'claude-sonnet-5-5', 184_000)
    expect(w.sent[1]).toContain('haiku')
  })

  test('a longer horizon makes the 184k switch pay', { options: { ...options, cacheHorizonTurns: 10 } }, async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await warmSonnet($, w.jev)
    await turn($, 't2', 'claude-sonnet-5-5', 184_000)
    expect(w.sent[1]).toContain('haiku')
  })

  test('with nothing warm, a cold Sonnet rebuild is dearer than a cold Haiku one, so it switches', { options }, async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await turn($, 't1', 'claude-sonnet-5-5', 184_000)
    expect(w.sent[0]).toContain('haiku')
  })

  test('each judged switch is recorded with its context, tiers and result', { options }, async ($, on) => {
    const stored = new Map<string, unknown>()
    const w = world(on, stored)
    await $.session.start(session)
    await warmSonnet($, w.jev)
    await turn($, 't2', 'claude-sonnet-5-5', 184_000)
    const log = stored.get('switch-log') as { from: string; to: string; context: number; allowed: boolean; reason: string }[]
    const last = log[log.length - 1]
    expect(last).toEqual(expect.objectContaining({ from: 'balanced', to: 'fast', context: 184_000, allowed: false }))
    expect(last?.reason).toContain('kept balanced')
  })

  test('a turn that stays on its model records nothing', { options }, async ($, on) => {
    const stored = new Map<string, unknown>()
    const w = world(on, stored)
    await $.session.start(session)
    w.jev.choice = 'balanced'
    await turn($, 't1', 'claude-sonnet-5-5', 50_000)
    expect(stored.get('switch-log')).toBeUndefined()
  })
})
