import { expect, test } from 'claude-code/testing'

import { buildDashboard } from '../hooks/dashboard.ts'
import {
  appendSwitch,
  formatContext,
  readSwitches,
  summarizeSwitches,
  SWITCH_CAP,
} from '../hooks/switchlog.ts'
import type { SwitchRecord } from '../hooks/switchlog.ts'
import { DAY, NEW_STATE } from '../hooks/tune.ts'

const rec = (over: Partial<SwitchRecord> = {}): SwitchRecord => ({
  at: 100 * DAY + 3_600_000,
  from: 'balanced',
  to: 'fast',
  context: 184_000,
  allowed: false,
  reason: 'kept balanced: switching to fast would cost $0.06 more over 3 turns',
  ...over,
})

const page = (switches: SwitchRecord[]) =>
  buildDashboard({
    now: 100 * DAY + 6 * 3_600_000,
    configured: 0.3,
    autoTune: true,
    state: NEW_STATE,
    trail: [],
    stats: {},
    log: [],
    switches,
  })

test('malformed stored entries are dropped, good ones kept', () => {
  const stored = [rec(), null, 'x', { at: 1, from: 'nope', to: 'fast', allowed: true }, { ...rec(), context: 'big' }]
  const read = readSwitches(stored)
  expect(read.length).toBe(2)
  expect(read[1]?.context).toBe(null)
  expect(readSwitches(undefined)).toEqual([])
})

test('appending keeps the newest records up to the cap', () => {
  let list: SwitchRecord[] = []
  for (let i = 0; i < SWITCH_CAP + 5; i++) list = appendSwitch(list, rec({ at: i }))
  expect(list.length).toBe(SWITCH_CAP)
  expect(list[0]?.at).toBe(5)
  expect(list[SWITCH_CAP - 1]?.at).toBe(SWITCH_CAP + 4)
})

test('summary counts switched and kept; context is formatted in k', () => {
  expect(summarizeSwitches([rec(), rec({ allowed: true }), rec({ allowed: true })])).toEqual({ allowed: 2, kept: 1 })
  expect(formatContext(184_000)).toBe('184k')
  expect(formatContext(null)).toBe('?')
})

test('the dashboard lists decisions newest first with context and result', () => {
  const html = page([
    rec({ at: 100 * DAY + 3_600_000, context: 12_000, allowed: true, reason: 'context small (12k)' }),
    rec({ at: 100 * DAY + 5 * 3_600_000 }),
  ])
  expect(html).toContain('Main-loop switch decisions')
  expect(html).toContain('1 switched, 1 kept')
  expect(html).toContain('184k')
  expect(html).toContain('kept balanced')
  expect(html).toContain('context small (12k)')
  expect(html.indexOf('184k')).toBeLessThan(html.indexOf('12k'))
})

test('with none recorded the dashboard says so, and escapes the reason', () => {
  expect(page([])).toContain('None recorded yet.')
  expect(page([rec({ reason: '<b>x</b>' })])).toContain('&lt;b&gt;x&lt;/b&gt;')
})

test('only the newest 15 are listed', () => {
  const many = Array.from({ length: 20 }, (_, i) => rec({ at: 100 * DAY + i * 60_000, context: (i + 1) * 1000 }))
  const html = page(many)
  expect(html).toContain('newest 15 shown')
  expect(html).toContain('>20k<')
  expect(html).not.toContain('>5k<')
})
