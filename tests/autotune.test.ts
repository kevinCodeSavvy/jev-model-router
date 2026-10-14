import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput } from 'claude-code'

import { DAY, FREEZE, MIN_RECORDS } from '../hooks/tune.ts'

tier('user')

const NOW = 100 * DAY
const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }
const report: CommandRunInput = {
  command: 'jev-shadow',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
}

/** `n` records just above the 0.30 floor; the first `underrated` have Opus rating them higher than Jev. */
const nearFloor = (n: number, underrated: number) =>
  Array.from({ length: n }, (_, i) => ({
    at: 1000,
    prompt: 'p',
    jev: { tier: 'fast', confidence: 0.35, effort: null, risky: null },
    opus: { tier: i < underrated ? 'deep' : 'fast', effort: null },
    agree: i >= underrated,
    unsure: false,
  }))

function world(on: On, stored: Map<string, unknown>, failRead = false) {
  const logs: string[] = []
  mock.clock(on, { now: NOW })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('store.get', ($, e) => {
    if (failRead) throw new Error('disk gone')
    return { value: stored.get(e.key) }
  })
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return { logs }
}

const state = (stored: Map<string, unknown>) => stored.get('tune-state') as Record<string, number | null> | undefined
const audit = (stored: Map<string, unknown>) => (stored.get('tune-audit') ?? []) as { action: string; from: number; to: number }[]

describe('auto-tune at session start', () => {
  test('raises the floor one step on enough evidence, and records why in the audit trail', async ($, on) => {
    const stored = new Map<string, unknown>([['shadow-log', nearFloor(MIN_RECORDS, MIN_RECORDS)]])
    const w = world(on, stored)
    await $.session.start(session)

    expect(state(stored)).toEqual({ value: 0.35, changedAt: NOW, frozenUntil: 0 })
    expect(audit(stored)).toEqual([expect.objectContaining({ action: 'raise', from: 0.3, to: 0.35 })])
    expect(w.logs.some((line) => line.includes('tune:') && line.includes('raise 0.30 → 0.35'))).toBe(true)

    const text = (await $.command.run(report)).text ?? ''
    expect(text).toContain('unsureBelow 0.35 (tuned; configured 0.30)')
    expect(text).toContain('raise 0.30 → 0.35')
  })

  test('starting again the same day moves nothing more', async ($, on) => {
    const stored = new Map<string, unknown>([['shadow-log', nearFloor(MIN_RECORDS * 2, MIN_RECORDS * 2)]])
    world(on, stored)
    await $.session.start(session)
    await $.session.start(session)
    expect(audit(stored).length).toBe(1)
    expect(state(stored)?.value).toBe(0.35)
  })

  test('29 records is not enough, and nothing is written', async ($, on) => {
    const stored = new Map<string, unknown>([['shadow-log', nearFloor(MIN_RECORDS - 1, MIN_RECORDS - 1)]])
    world(on, stored)
    await $.session.start(session)
    expect(stored.has('tune-state')).toBe(false)
    expect(stored.has('tune-audit')).toBe(false)
    expect(((await $.command.run(report)).text ?? '')).toContain('as configured, not tuned')
  })

  test('a spike in escalations rolls the tuned floor back and freezes tuning', async ($, on) => {
    const day = NOW / DAY
    const stored = new Map<string, unknown>([
      ['tune-state', { value: 0.4, changedAt: NOW - DAY, frozenUntil: 0 }],
      ['tune-stats', { [String(day)]: { prompts: 40, unsure: 20 }, [String(day - 4)]: { prompts: 200, unsure: 20 } }],
      ['shadow-log', nearFloor(MIN_RECORDS, MIN_RECORDS)],
    ])
    const w = world(on, stored)
    await $.session.start(session)

    expect(state(stored)).toEqual({ value: null, changedAt: NOW, frozenUntil: NOW + FREEZE })
    expect(audit(stored)).toEqual([expect.objectContaining({ action: 'rollback', from: 0.4, to: 0.3 })])
    expect(w.logs.some((line) => line.includes('rolled back 0.40 → 0.30'))).toBe(true)
    const text = (await $.command.run(report)).text ?? ''
    expect(text).toContain('unsureBelow 0.30 (as configured, not tuned)')
    expect(text).toContain('tuning frozen until')
  })

  test('a frozen tuner leaves the floor alone even with strong evidence', async ($, on) => {
    const stored = new Map<string, unknown>([
      ['tune-state', { value: null, changedAt: NOW - 2 * DAY, frozenUntil: NOW + DAY }],
      ['shadow-log', nearFloor(MIN_RECORDS, MIN_RECORDS)],
    ])
    world(on, stored)
    await $.session.start(session)
    expect(audit(stored)).toEqual([])
  })

  test('a store that fails to read keeps the configured floor and still starts the session', async ($, on) => {
    const stored = new Map<string, unknown>()
    const w = world(on, stored, true)
    await $.session.start(session)
    expect(w.logs.some((line) => line.includes('tune failed, keeping the configured floor'))).toBe(true)
  })

  test('with autoTune off the floor never moves', { options: { autoTune: false } }, async ($, on) => {
    const stored = new Map<string, unknown>([
      ['tune-state', { value: 0.45, changedAt: NOW - 5 * DAY, frozenUntil: 0 }],
      ['shadow-log', nearFloor(MIN_RECORDS, MIN_RECORDS)],
    ])
    world(on, stored)
    await $.session.start(session)
    expect(audit(stored)).toEqual([])
    expect(((await $.command.run(report)).text ?? '')).toContain('unsureBelow 0.30 (auto-tune off)')
  })

  test('a configured floor of 0 is off and is never tuned', { options: { unsureBelow: 0 } }, async ($, on) => {
    const stored = new Map<string, unknown>([['shadow-log', nearFloor(MIN_RECORDS, MIN_RECORDS)]])
    world(on, stored)
    await $.session.start(session)
    expect(stored.has('tune-state')).toBe(false)
    expect(((await $.command.run(report)).text ?? '')).toContain('nothing to tune')
  })
})

const answer = (confidence: number) =>
  JSON.stringify({
    model: 'jev-1.13',
    answers: {
      tier: { type: 'choice', choice: 'fast', confidence, probabilities: { fast: confidence } },
      effort: { type: 'score', score: 1.4, confidence: 0.8 },
      risky: { type: 'noul', noul: 0.01 },
    },
  })

describe('counting prompts for the rollback watch', () => {
  const options = { typesafeApiKey: 'test-key', shadowOpus: false }

  test('each classified prompt is counted in its day, and unsure ones are counted as unsure', { options }, async ($, on) => {
    const stored = new Map<string, unknown>()
    world(on, stored)
    const replies = [answer(0.95), answer(0.2), answer(0.9)]
    on('http.fetch', () => ({
      value: { status: 200, ok: true, headers: {}, text: replies.shift() ?? answer(0.95) },
    }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(session)
    for (const text of ['one task', 'two task', 'three task']) {
      await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
    }
    expect(stored.get('tune-stats')).toEqual({
      [String(NOW / DAY)]: { prompts: 3, unsure: 1, confSum: 0.95 + 0.2 + 0.9, confN: 3 },
    })
  })

  test('the router runs on the tuned floor from the store, not only the configured one', { options }, async ($, on) => {
    const stored = new Map<string, unknown>([['tune-state', { value: 0.5, changedAt: 1, frozenUntil: 0 }]])
    world(on, stored)
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: answer(0.4) } }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(session)
    await $.prompt.submit({ text: 'a task', wait: false, origin: { kind: 'composer' } })
    // 0.4 is under the tuned 0.5 but over the configured 0.3.
    expect((stored.get('tune-stats') as Record<string, { unsure: number }>)[String(NOW / DAY)]?.unsure).toBe(1)
  })

  test('without a tuned floor the same answer is not unsure', { options }, async ($, on) => {
    const stored = new Map<string, unknown>()
    world(on, stored)
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: answer(0.4) } }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(session)
    await $.prompt.submit({ text: 'a task', wait: false, origin: { kind: 'composer' } })
    expect((stored.get('tune-stats') as Record<string, { unsure: number }>)[String(NOW / DAY)]?.unsure).toBe(0)
  })

  test('with autoTune off nothing is counted', { options: { ...options, autoTune: false } }, async ($, on) => {
    const stored = new Map<string, unknown>()
    world(on, stored)
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: answer(0.2) } }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(session)
    await $.prompt.submit({ text: 'a task', wait: false, origin: { kind: 'composer' } })
    expect(stored.has('tune-stats')).toBe(false)
  })
})
