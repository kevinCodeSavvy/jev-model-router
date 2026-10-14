import { expect, test } from 'claude-code/testing'
import {
  appendAudit,
  applyEntry,
  BLAME_WINDOW,
  clampFloor,
  COOLDOWN,
  DAY,
  describeEntry,
  effectiveFloor,
  FLOOR_MAX,
  FLOOR_MIN,
  formatTuneReport,
  FREEZE,
  gatherEvidence,
  MIN_RECORDS,
  NEW_STATE,
  proposeMove,
  readAudit,
  readState,
  readStats,
  recordPrompt,
  shouldRollBack,
} from '../hooks/tune.ts'
import type { AuditEntry, Stats, TuneState } from '../hooks/tune.ts'
import type { ShadowRecord } from '../hooks/shadow.ts'

type Tier = 'fast' | 'balanced' | 'deep'

const rec = (at: number, confidence: number | null, jev: Tier, opus: Tier | null): ShadowRecord => ({
  at,
  prompt: 'p',
  jev: { tier: jev, confidence, effort: null, risky: null },
  opus: { tier: opus, effort: null },
  agree: opus === null ? null : opus === jev,
  unsure: false,
})

/** `n` records, the first `bad` of which are of the wanted kind. */
const many = (n: number, bad: number, make: (isBad: boolean, i: number) => ShadowRecord): ShadowRecord[] =>
  Array.from({ length: n }, (_, i) => make(i < bad, i))

// Just above a 0.30 floor, Jev said fast; Opus said deep (underrated) or fast (agreed).
const above = (n: number, underrated: number, at = 1000, floor = 0.3) =>
  many(n, underrated, (bad) => rec(at, floor + 0.05, 'fast', bad ? 'deep' : 'fast'))
// Just below it, where the turn went deep anyway; Opus agreed it needed deep, or did not.
const below = (n: number, needDeep: number, at = 1000, floor = 0.3) =>
  many(n, needDeep, (bad) => rec(at, floor - 0.05, 'fast', bad ? 'deep' : 'balanced'))

const NOW = 100 * DAY

test('a floor is rounded to hundredths and held inside the hard limits', () => {
  expect(clampFloor(0.3)).toBe(0.3)
  expect(clampFloor(0.1 + 0.2)).toBe(0.3)
  expect(clampFloor(0.01)).toBe(FLOOR_MIN)
  expect(clampFloor(0.9)).toBe(FLOOR_MAX)
  expect(clampFloor(-4)).toBe(FLOOR_MIN)
})

test('the floor in force is the configured one unless tuning is on, set, and the floor is not off', () => {
  const tuned: TuneState = { value: 0.4, changedAt: 1, frozenUntil: 0 }
  expect(effectiveFloor(0.3, tuned, true)).toBe(0.4)
  expect(effectiveFloor(0.3, tuned, false)).toBe(0.3)
  expect(effectiveFloor(0.3, NEW_STATE, true)).toBe(0.3)
  expect(effectiveFloor(0, tuned, true)).toBe(0)
  // A damaged store cannot push the floor past the limits.
  expect(effectiveFloor(0.3, { ...tuned, value: 0.95 }, true)).toBe(FLOOR_MAX)
  expect(effectiveFloor(0.3, { ...tuned, value: 0 }, true)).toBe(FLOOR_MIN)
})

test('evidence counts only records near the floor, newer than the last move, with a tier from Opus', () => {
  const log = [
    ...above(2, 1),
    ...below(3, 1),
    rec(1000, 0.5, 'fast', 'deep'), // 0.20 over the floor: outside the band
    rec(1000, 0.1, 'fast', 'deep'), // 0.20 under it: outside the band
    rec(1000, null, 'fast', 'deep'), // no confidence reported
    rec(1000, 0.35, 'fast', null), // Opus named no tier
    rec(50, 0.35, 'fast', 'deep'), // older than the last move
  ]
  expect(gatherEvidence(log, 0.3, 100)).toEqual({
    above: { n: 2, underrated: 1 },
    below: { n: 3, needDeep: 1 },
  })
  expect(gatherEvidence(log, 0.3, 0).above.n).toBe(3)
})

test('the floor rises one step when Opus rates more than 40% of near-floor answers higher', () => {
  const move = proposeMove(above(MIN_RECORDS, 13), 0.3, NEW_STATE, NOW)
  expect(move?.action).toBe('raise')
  expect(move?.from).toBe(0.3)
  expect(move?.to).toBe(0.35)
  expect(move?.reason).toContain('43%')
  expect(proposeMove(above(MIN_RECORDS, 12), 0.3, NEW_STATE, NOW)).toBeNull()
})

test('the floor falls one step when Opus wanted deep for under 30% of the answers it escalated', () => {
  const move = proposeMove(below(MIN_RECORDS, 8), 0.3, NEW_STATE, NOW)
  expect(move?.action).toBe('lower')
  expect(move?.to).toBe(0.25)
  expect(proposeMove(below(MIN_RECORDS, 9), 0.3, NEW_STATE, NOW)).toBeNull()
})

test('nothing moves on fewer than 30 records', () => {
  expect(proposeMove(above(MIN_RECORDS - 1, MIN_RECORDS - 1), 0.3, NEW_STATE, NOW)).toBeNull()
  expect(proposeMove(below(MIN_RECORDS - 1, 0), 0.3, NEW_STATE, NOW)).toBeNull()
  expect(proposeMove([], 0.3, NEW_STATE, NOW)).toBeNull()
})

test('raising wins when both rules would fire, since too cheap is the costlier mistake', () => {
  const log = [...above(MIN_RECORDS, MIN_RECORDS), ...below(MIN_RECORDS, 0)]
  expect(proposeMove(log, 0.3, NEW_STATE, NOW)?.action).toBe('raise')
})

test('a move waits out the cooldown and counts only evidence gathered after the last one', () => {
  const log = above(MIN_RECORDS, MIN_RECORDS, NOW - 1000)
  const moved: TuneState = { value: 0.35, changedAt: NOW - COOLDOWN + 1, frozenUntil: 0 }
  expect(proposeMove(log, 0.35, moved, NOW)).toBeNull()
  // Cooldown over, but every record predates the move.
  const old: TuneState = { value: 0.35, changedAt: NOW - 1, frozenUntil: 0 }
  expect(proposeMove(log, 0.35, { ...old, changedAt: NOW - 500 }, NOW + COOLDOWN)).toBeNull()
  const later: TuneState = { value: 0.35, changedAt: NOW - 2000 - COOLDOWN, frozenUntil: 0 }
  expect(proposeMove(log, 0.35, later, NOW)?.to).toBe(0.4)
})

test('a frozen tuner does not move until the freeze ends', () => {
  const frozen: TuneState = { value: null, changedAt: 0, frozenUntil: NOW + 1 }
  expect(proposeMove(above(MIN_RECORDS, MIN_RECORDS), 0.3, frozen, NOW)).toBeNull()
  expect(proposeMove(above(MIN_RECORDS, MIN_RECORDS), 0.3, frozen, NOW + 2)?.action).toBe('raise')
})

test('the hard limits stop a move that would leave them', () => {
  expect(proposeMove(above(MIN_RECORDS, MIN_RECORDS, 1000, FLOOR_MAX), FLOOR_MAX, NEW_STATE, NOW)).toBeNull()
  expect(proposeMove(below(MIN_RECORDS, 0, 1000, FLOOR_MIN), FLOOR_MIN, NEW_STATE, NOW)).toBeNull()
  expect(proposeMove(above(MIN_RECORDS, MIN_RECORDS, 1000, 0.48), 0.48, NEW_STATE, NOW)?.to).toBe(FLOOR_MAX)
  expect(proposeMove(below(MIN_RECORDS, 0, 1000, 0.17), 0.17, NEW_STATE, NOW)?.to).toBe(FLOOR_MIN)
})

test('a prompt is counted in its UTC day, and days older than two weeks are dropped', () => {
  let stats: Stats = {}
  stats = recordPrompt(stats, NOW, true, 0.2)
  stats = recordPrompt(stats, NOW + 1000, false, 0.9)
  expect(stats[String(NOW / DAY)]).toEqual({ prompts: 2, unsure: 1, confSum: 1.1, confN: 2 })
  stats = recordPrompt(stats, NOW + 20 * DAY, false, 0.5)
  expect(Object.keys(stats)).toEqual([String(NOW / DAY + 20)])
})

/** Stats with `recent` over today and yesterday, `base` spread over the seven days before. */
function spread(recent: [number, number], base: [number, number]): Stats {
  const day = NOW / DAY
  const stats: Stats = {
    [String(day)]: { prompts: recent[0], unsure: recent[1] },
  }
  stats[String(day - 4)] = { prompts: base[0], unsure: base[1] }
  return stats
}

const tuned: TuneState = { value: 0.4, changedAt: NOW - DAY, frozenUntil: 0 }

test('a jump in the share of escalated prompts triggers a rollback, with the reason', () => {
  const why = shouldRollBack(spread([40, 20], [200, 20]), tuned, NOW)
  expect(why).toContain('50%')
  expect(why).toContain('10%')
})

test('no rollback without a tuned floor, enough prompts, a real spike, or a recent move', () => {
  const spike = spread([40, 20], [200, 20])
  expect(shouldRollBack(spike, NEW_STATE, NOW)).toBeNull()
  expect(shouldRollBack(spread([19, 19], [200, 20]), tuned, NOW)).toBeNull()
  expect(shouldRollBack(spread([40, 20], [49, 5]), tuned, NOW)).toBeNull()
  expect(shouldRollBack(spread([40, 4], [200, 0]), tuned, NOW)).toBeNull()
  expect(shouldRollBack(spread([40, 6], [200, 20]), tuned, NOW)).toBeNull() // 15% is not over 1.5 x 10%
  expect(shouldRollBack(spike, { ...tuned, changedAt: NOW - BLAME_WINDOW - 1 }, NOW)).toBeNull()
})

test('a rollback clears the tuned floor and freezes tuning; a move keeps the rest of the state', () => {
  const rollback: AuditEntry = { at: NOW, action: 'rollback', from: 0.4, to: 0.3, reason: 'x' }
  expect(applyEntry(tuned, rollback)).toEqual({ value: null, changedAt: NOW, frozenUntil: NOW + FREEZE })
  const raise: AuditEntry = { at: NOW, action: 'raise', from: 0.4, to: 0.45, reason: 'x' }
  expect(applyEntry(tuned, raise)).toEqual({ value: 0.45, changedAt: NOW, frozenUntil: 0 })
})

test('the audit trail keeps the newest hundred entries', () => {
  let trail: AuditEntry[] = []
  for (let i = 0; i < 105; i++) {
    trail = appendAudit(trail, { at: i, action: 'raise', from: 0.3, to: 0.35, reason: String(i) })
  }
  expect(trail.length).toBe(100)
  expect(trail[0]?.reason).toBe('5')
  expect(trail[99]?.reason).toBe('104')
})

test('stored values that are not state, audit or stats read as empty rather than throwing', () => {
  expect(readState('x')).toEqual(NEW_STATE)
  expect(readState({ value: 'high' })).toEqual(NEW_STATE)
  expect(readAudit('x')).toEqual([])
  expect(readAudit([null, 3, { at: 1, to: 0.3 }])).toEqual([{ at: 1, to: 0.3 }])
  expect(readStats([1, 2])).toEqual({})
  expect(readStats({ '1': { prompts: 2, unsure: 1 }, '2': { prompts: 'x' } })).toEqual({ '1': { prompts: 2, unsure: 1 } })
  expect(readStats({ '1': { prompts: 2, unsure: 1, confSum: 1.5, confN: 2 } })).toEqual({
    '1': { prompts: 2, unsure: 1, confSum: 1.5, confN: 2 },
  })
})

test('the report names the floor in force, any freeze, and the latest changes', () => {
  const entry: AuditEntry = { at: Date.UTC(2026, 9, 20, 6, 30), action: 'raise', from: 0.3, to: 0.35, reason: 'Opus said so' }
  expect(describeEntry(entry)).toBe('2026-10-20 06:30 UTC  raise 0.30 → 0.35: Opus said so')

  const none = formatTuneReport(0.3, NEW_STATE, [], true, NOW)
  expect(none).toBe('unsureBelow 0.30 (as configured, not tuned)\nno tuning changes yet')

  const live = formatTuneReport(0.3, { value: 0.35, changedAt: entry.at, frozenUntil: 0 }, [entry], true, NOW)
  expect(live).toContain('unsureBelow 0.35 (tuned; configured 0.30)')
  expect(live).toContain('raise 0.30 → 0.35')

  const frozen = formatTuneReport(0.3, { value: null, changedAt: 1, frozenUntil: NOW + DAY }, [], true, NOW)
  expect(frozen).toContain('tuning frozen until')

  expect(formatTuneReport(0.3, tuned, [], false, NOW)).toContain('auto-tune off')
  expect(formatTuneReport(0, NEW_STATE, [], true, NOW)).toContain('off (0)')
})
