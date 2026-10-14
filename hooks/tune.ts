/**
 * jev-model-router — guarded auto-tune of the `unsureBelow` floor.
 *
 * Pure logic, no `$`: it reads the shadow log and the per-day escalation
 * counts and says whether the floor should move, or be rolled back. The router
 * stores what it decides; nothing here touches I/O.
 *
 * Only `unsureBelow` is tuned. The shadow log does not record what model a
 * turn ran on, so there is no evidence about the upgrade or downgrade bars.
 *
 * Every move is small, needs evidence, waits out a cooldown, stays inside hard
 * limits, and is written to an audit trail. A sudden rise in how often turns
 * escalate undoes the tuning and freezes it for a week.
 */
import { TIER_ORDER } from './policy.ts'
import type { Tier } from './policy.ts'
import type { ShadowRecord } from './shadow.ts'

/** `$.store` keys. */
export const TUNE_STATE_KEY = 'tune-state'
export const TUNE_AUDIT_KEY = 'tune-audit'
export const TUNE_STATS_KEY = 'tune-stats'

/** The floor never leaves this range, whatever the evidence says. */
export const FLOOR_MIN = 0.15
export const FLOOR_MAX = 0.5

/** One move changes the floor by this much, and no more. */
export const STEP = 0.05

/** Records needed in a band, gathered since the last move, before it counts. */
export const MIN_RECORDS = 30

/** How far either side of the floor counts as "near" it. */
export const BAND = 0.15

/** Share of just-above-floor records Opus rates higher than Jev, above which the floor rises. */
export const RAISE_ABOVE = 0.4

/** Share of just-below-floor records Opus agrees need the deep tier, under which the floor falls. */
export const LOWER_BELOW = 0.3

const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

/** At most one move in this long. */
export const COOLDOWN = DAY

/** After a rollback, no tuning for this long. */
export const FREEZE = 7 * DAY

/** A rollback is only blamed on tuning while the last move is this recent. */
export const BLAME_WINDOW = 7 * DAY

/** Escalation share rising past this multiple of its baseline triggers a rollback. */
export const ROLLBACK_RATIO = 1.5

/** Prompts needed in the recent window and the baseline before a rollback can fire. */
export const ROLLBACK_MIN_RECENT = 20
export const ROLLBACK_MIN_BASELINE = 50
/** Escalations needed in the recent window, so a share of 0 against 1 prompt in 20 is not a spike. */
export const ROLLBACK_MIN_UNSURE = 5

const AUDIT_CAP = 100
const STATS_DAYS = 14

export interface TuneState {
  /** The tuned floor, or null while the configured one stands. */
  value: number | null
  /** When the floor last moved, or was rolled back. 0 when never. */
  changedAt: number
  /** No tuning before this time. */
  frozenUntil: number
}

export interface AuditEntry {
  at: number
  action: 'raise' | 'lower' | 'rollback'
  from: number
  to: number
  reason: string
}

export interface DayStats {
  prompts: number
  unsure: number
  /** Sum of Jev's tier confidence over `confN` prompts; absent in days counted before it was kept. */
  confSum?: number
  confN?: number
}

/** Counts per UTC day, keyed by the day's index since the epoch. */
export type Stats = Record<string, DayStats>

export const NEW_STATE: TuneState = { value: null, changedAt: 0, frozenUntil: 0 }

/** The stored state, or a fresh one when what is stored is not a state. */
export function readState(raw: unknown): TuneState {
  const state = raw as Partial<TuneState> | null
  if (typeof state !== 'object' || state === null) return { ...NEW_STATE }
  return {
    value: typeof state.value === 'number' ? state.value : null,
    changedAt: typeof state.changedAt === 'number' ? state.changedAt : 0,
    frozenUntil: typeof state.frozenUntil === 'number' ? state.frozenUntil : 0,
  }
}

export function readAudit(raw: unknown): AuditEntry[] {
  return Array.isArray(raw)
    ? (raw as AuditEntry[]).filter(
        (entry) =>
          typeof entry === 'object' && entry !== null && typeof entry.at === 'number' && typeof entry.to === 'number',
      )
    : []
}

export function readStats(raw: unknown): Stats {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const stats: Stats = {}
  for (const [day, value] of Object.entries(raw as Record<string, Partial<DayStats>>)) {
    if (typeof value?.prompts === 'number' && typeof value?.unsure === 'number') {
      stats[day] = { prompts: value.prompts, unsure: value.unsure }
      if (typeof value.confSum === 'number' && typeof value.confN === 'number') {
        stats[day] = { ...stats[day], confSum: value.confSum, confN: value.confN }
      }
    }
  }
  return stats
}

/** A floor rounded to hundredths, held inside the hard limits. */
export function clampFloor(value: number): number {
  return Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Math.round(value * 100) / 100))
}

/**
 * The floor the router runs on. A configured floor of 0 (off) or a tuning
 * switched off is respected; a tuned value is clamped again on the way out, so
 * a damaged store cannot push it past the limits.
 */
export function effectiveFloor(configured: number, state: TuneState, enabled: boolean): number {
  if (!enabled || configured <= 0 || state.value === null) return configured
  return clampFloor(state.value)
}

const rank = (tier: Tier | null): number => (tier === null ? -1 : TIER_ORDER.indexOf(tier))

export interface Evidence {
  /** Records with a reported confidence just at or above the floor, that Opus tiered. */
  above: { n: number; underrated: number }
  /** Records just under the floor, that Opus tiered. */
  below: { n: number; needDeep: number }
}

/**
 * What the log says near the floor, counting only records newer than `since`
 * so that each move is judged on evidence gathered after the last one.
 */
export function gatherEvidence(log: readonly ShadowRecord[], floor: number, since: number): Evidence {
  const evidence: Evidence = { above: { n: 0, underrated: 0 }, below: { n: 0, needDeep: 0 } }
  for (const record of log) {
    const { confidence } = record.jev
    if (record.at <= since || confidence === null || record.opus.tier === null) continue
    if (confidence >= floor && confidence < floor + BAND) {
      evidence.above.n += 1
      if (rank(record.opus.tier) > rank(record.jev.tier)) evidence.above.underrated += 1
    } else if (confidence < floor && confidence >= floor - BAND) {
      evidence.below.n += 1
      if (record.opus.tier === 'deep') evidence.below.needDeep += 1
    }
  }
  return evidence
}

const pct = (part: number, whole: number) => `${Math.round((100 * part) / whole)}%`

/**
 * A move of one STEP, or null. Raising wins over lowering, because a task
 * kept on a cheap model that needed more is the costlier mistake. Nothing
 * moves while frozen, inside the cooldown, or without MIN_RECORDS of evidence.
 */
export function proposeMove(
  log: readonly ShadowRecord[],
  floor: number,
  state: TuneState,
  now: number,
): AuditEntry | null {
  if (now < state.frozenUntil || now - state.changedAt < COOLDOWN) return null
  const { above, below } = gatherEvidence(log, floor, state.changedAt)

  if (above.n >= MIN_RECORDS && above.underrated / above.n > RAISE_ABOVE) {
    const to = clampFloor(floor + STEP)
    if (to === floor) return null
    return {
      at: now,
      action: 'raise',
      from: floor,
      to,
      reason: `Opus rated ${pct(above.underrated, above.n)} of ${above.n} answers just above ${floor.toFixed(2)} higher than Jev`,
    }
  }
  if (below.n >= MIN_RECORDS && below.needDeep / below.n < LOWER_BELOW) {
    const to = clampFloor(floor - STEP)
    if (to === floor) return null
    return {
      at: now,
      action: 'lower',
      from: floor,
      to,
      reason: `Opus wanted the deep tier for only ${pct(below.needDeep, below.n)} of ${below.n} answers just under ${floor.toFixed(2)}`,
    }
  }
  return null
}

/** The UTC day a time falls in, as the key of a Stats entry. */
export const dayKey = (at: number): string => String(Math.floor(at / DAY))

/** The stats with one more prompt counted, older than two weeks dropped. */
export function recordPrompt(stats: Stats, at: number, unsure: boolean, confidence: number): Stats {
  const today = Math.floor(at / DAY)
  const next: Stats = {}
  for (const [day, value] of Object.entries(stats)) {
    if (today - Number(day) < STATS_DAYS) next[day] = value
  }
  const key = dayKey(at)
  const held = next[key] ?? { prompts: 0, unsure: 0 }
  next[key] = {
    prompts: held.prompts + 1,
    unsure: held.unsure + (unsure ? 1 : 0),
    confSum: (held.confSum ?? 0) + confidence,
    confN: (held.confN ?? 0) + 1,
  }
  return next
}

function sumDays(stats: Stats, from: number, to: number): DayStats {
  const total: DayStats = { prompts: 0, unsure: 0 }
  for (let day = from; day <= to; day++) {
    const held = stats[String(day)]
    if (held) {
      total.prompts += held.prompts
      total.unsure += held.unsure
    }
  }
  return total
}

/**
 * Whether tuning should be undone: the share of prompts escalated as unsure,
 * over today and yesterday, is well above the week before them. Only while a
 * tuned floor is in force and was moved recently enough to be the suspect.
 */
export function shouldRollBack(stats: Stats, state: TuneState, now: number): string | null {
  if (state.value === null || now - state.changedAt > BLAME_WINDOW) return null
  const today = Math.floor(now / DAY)
  const recent = sumDays(stats, today - 1, today)
  const baseline = sumDays(stats, today - 8, today - 2)
  if (recent.prompts < ROLLBACK_MIN_RECENT || baseline.prompts < ROLLBACK_MIN_BASELINE) return null
  if (recent.unsure < ROLLBACK_MIN_UNSURE) return null

  const recentShare = recent.unsure / recent.prompts
  const baselineShare = baseline.unsure / baseline.prompts
  if (recentShare <= baselineShare * ROLLBACK_RATIO) return null
  return `escalations rose to ${pct(recent.unsure, recent.prompts)} of prompts, from ${pct(baseline.unsure, baseline.prompts)} the week before`
}

/** The state after a move or a rollback. A rollback also freezes tuning. */
export function applyEntry(state: TuneState, entry: AuditEntry): TuneState {
  return entry.action === 'rollback'
    ? { value: null, changedAt: entry.at, frozenUntil: entry.at + FREEZE }
    : { ...state, value: entry.to, changedAt: entry.at }
}

/** The audit trail with one more entry, cut to the newest hundred. */
export function appendAudit(trail: readonly AuditEntry[], entry: AuditEntry): AuditEntry[] {
  return [...trail, entry].slice(-AUDIT_CAP)
}

/** One line for the log, and for the report. */
export function describeEntry(entry: AuditEntry): string {
  const when = new Date(entry.at).toISOString().slice(0, 16).replace('T', ' ')
  const what =
    entry.action === 'rollback'
      ? `rolled back ${entry.from.toFixed(2)} → ${entry.to.toFixed(2)}`
      : `${entry.action} ${entry.from.toFixed(2)} → ${entry.to.toFixed(2)}`
  return `${when} UTC  ${what}: ${entry.reason}`
}

/** The tuning lines appended to the `/jev-shadow` report. */
export function formatTuneReport(
  configured: number,
  state: TuneState,
  trail: readonly AuditEntry[],
  enabled: boolean,
  now: number,
): string {
  const floor = effectiveFloor(configured, state, enabled)
  const head = !enabled
    ? `unsureBelow ${configured.toFixed(2)} (auto-tune off)`
    : configured <= 0
      ? 'unsureBelow off (0), so nothing to tune'
      : state.value === null
        ? `unsureBelow ${floor.toFixed(2)} (as configured, not tuned)`
        : `unsureBelow ${floor.toFixed(2)} (tuned; configured ${configured.toFixed(2)})`
  const lines = [head]
  if (now < state.frozenUntil) {
    lines.push(`tuning frozen until ${new Date(state.frozenUntil).toISOString().slice(0, 10)} after a rollback`)
  }
  if (trail.length === 0) lines.push('no tuning changes yet')
  else lines.push(...trail.slice(-5).map(describeEntry))
  return lines.join('\n')
}
