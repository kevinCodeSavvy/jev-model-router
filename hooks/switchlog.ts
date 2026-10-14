/**
 * jev-model-router — the record of main-loop switch decisions.
 *
 * One entry each time the router wanted to move the main loop to a different
 * model: whether the cache check let it through or kept the current model,
 * with the context size it saw. Counts, tiers and a generated sentence only,
 * never a prompt. Pure; the router keeps the list in `$.store`.
 */
import { TIER_ORDER } from './policy.ts'
import type { Tier } from './policy.ts'

export const SWITCH_KEY = 'switch-log'
/** Newest records kept. */
export const SWITCH_CAP = 100

export interface SwitchRecord {
  at: number
  from: Tier
  to: Tier
  /** Input tokens of the last response, or null when unknown. */
  context: number | null
  allowed: boolean
  /** The cache check's sentence; empty when the check was off. */
  reason: string
}

const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && (TIER_ORDER as readonly string[]).includes(value)

/** The stored list, with anything that is not a well-formed record dropped. */
export function readSwitches(raw: unknown): SwitchRecord[] {
  if (!Array.isArray(raw)) return []
  const out: SwitchRecord[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    if (typeof r.at !== 'number' || !isTier(r.from) || !isTier(r.to) || typeof r.allowed !== 'boolean') continue
    out.push({
      at: r.at,
      from: r.from,
      to: r.to,
      context: typeof r.context === 'number' ? r.context : null,
      allowed: r.allowed,
      reason: typeof r.reason === 'string' ? r.reason : '',
    })
  }
  return out
}

/** The stored list with one more record, oldest dropped past the cap. */
export function appendSwitch(raw: unknown, record: SwitchRecord, cap: number = SWITCH_CAP): SwitchRecord[] {
  return [...readSwitches(raw), record].slice(-cap)
}

export interface SwitchSummary {
  allowed: number
  kept: number
}

export const summarizeSwitches = (records: readonly SwitchRecord[]): SwitchSummary => ({
  allowed: records.filter((r) => r.allowed).length,
  kept: records.filter((r) => !r.allowed).length,
})

/** `184k`, `12k`, or `?` when the size was unknown. */
export const formatContext = (tokens: number | null): string =>
  tokens === null ? '?' : `${Math.round(tokens / 1000)}k`
