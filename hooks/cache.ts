/**
 * jev-model-router — cache-aware switching of the main loop's model.
 *
 * The prompt cache belongs to one model. A turn that moves to a model whose
 * cache is cold sends the whole conversation again as a cache write instead of
 * a cache read, so a switch that looks cheaper per token can cost more over the
 * next few turns. This works that out, for a switch made to save money.
 *
 * Pure: no `$`. The router tells it the context size and when each model was
 * last used, and it says whether switching pays.
 *
 * Prices are per million tokens, from Anthropic's published rates as of
 * 2026-10-06. They are an estimate: edit PRICES when the rates change.
 */
import { rankOf, TIER_ORDER } from './policy.ts'
import type { Tier, Tiers } from './policy.ts'

export interface TierPrice {
  input: number
  output: number
  /** Cache read per million tokens. */
  read: number
  /** Above this many prompt tokens the `long` rates apply, when set. */
  longAbove?: number
  long?: { input: number; output: number; read: number }
}

/** fast = Haiku 5.5, balanced = Sonnet 5.5, deep = Opus 5.5. A cache write is the input price times 1.25 (5 minute) or 2 (1 hour). */
export const PRICES: Readonly<Record<Tier, TierPrice>> = {
  fast: {
    input: 0.1,
    output: 0.5,
    read: 0.01,
    longAbove: 100_000,
    long: { input: 0.5, output: 2.5, read: 0.05 },
  },
  balanced: { input: 2, output: 10, read: 0.2 },
  deep: { input: 4, output: 20, read: 0.2 },
}

export interface CacheSettings {
  /** At or under this many context tokens a switch is always allowed. */
  smallContext: number
  /** How many turns a switch is expected to last, the first one included. */
  horizonTurns: number
  /** How long a cache stays warm after its last use. */
  ttlMinutes: number
  /** Output tokens assumed per turn, since output is where a cheaper model saves. */
  outputTokens: number
  /** Whether a move to a more capable model is held to the same test. */
  gateUpgrades: boolean
}

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  smallContext: 20_000,
  horizonTurns: 3,
  ttlMinutes: 60,
  outputTokens: 1500,
  gateUpgrades: false,
}

/** When each tier's model last served a request, in `$.clock.now()` ms. */
export type LastUsed = Partial<Record<Tier, number>>

export interface SwitchQuestion {
  from: Tier
  to: Tier
  /** Input tokens the last response was answered over, or null when unknown. */
  contextTokens: number | null
  lastUsed: LastUsed
  now: number
}

export interface SwitchVerdict {
  allow: boolean
  reason: string
  /** What staying costs over the horizon, in dollars, when it was worked out. */
  stay?: number
  /** What switching costs over the horizon. */
  switched?: number
  /** Extra cost of this one turn from the switch (the cache rebuild), when worked out. */
  rebuild?: number
}

export const tierOfModel = (model: string, tiers: Tiers): Tier | null => {
  const rank = rankOf(model, tiers)
  return rank === null ? null : (TIER_ORDER[rank] as Tier)
}

const usd = (value: number): string => `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`

/** Whether a model's cache can be expected to still hold the conversation. */
export function isWarm(tier: Tier, lastUsed: LastUsed, now: number, ttlMinutes: number): boolean {
  const at = lastUsed[tier]
  return at !== undefined && now - at < ttlMinutes * 60_000
}

/** One turn on `tier`: the context as a cache read or a cache write, plus the output. */
export function turnCost(
  tier: Tier,
  contextTokens: number,
  warm: boolean,
  settings: CacheSettings,
): number {
  const price = PRICES[tier]
  const rates = price.long && price.longAbove !== undefined && contextTokens > price.longAbove ? price.long : price
  const writeFactor = settings.ttlMinutes > 5 ? 2 : 1.25
  const context = contextTokens * (warm ? rates.read : rates.input * writeFactor)
  return (context + settings.outputTokens * rates.output) / 1_000_000
}

/** The first turn as the cache stands, then the rest with it warm. */
function horizonCost(tier: Tier, contextTokens: number, warmNow: boolean, settings: CacheSettings): number {
  const rest = Math.max(0, settings.horizonTurns - 1)
  return turnCost(tier, contextTokens, warmNow, settings) + rest * turnCost(tier, contextTokens, true, settings)
}

/**
 * Whether a model switch should go ahead. A small context, an unknown one, or
 * a move up (made for quality, not for savings) is allowed. Otherwise the
 * switch has to cost less than staying, counting the cache rebuild.
 */
export function judgeSwitch(question: SwitchQuestion, settings: CacheSettings): SwitchVerdict {
  const { from, to, contextTokens, lastUsed, now } = question
  if (from === to) return { allow: true, reason: 'same model' }
  if (contextTokens === null) return { allow: true, reason: 'context size unknown' }
  if (contextTokens <= settings.smallContext) {
    return { allow: true, reason: `context small (${Math.round(contextTokens / 1000)}k)` }
  }

  const upgrade = TIER_ORDER.indexOf(to) > TIER_ORDER.indexOf(from)
  const fromWarm = isWarm(from, lastUsed, now, settings.ttlMinutes)
  const toWarm = isWarm(to, lastUsed, now, settings.ttlMinutes)
  const stay = horizonCost(from, contextTokens, fromWarm, settings)
  const switched = horizonCost(to, contextTokens, toWarm, settings)
  const rebuild = turnCost(to, contextTokens, toWarm, settings) - turnCost(from, contextTokens, fromWarm, settings)
  const size = `${Math.round(contextTokens / 1000)}k context`

  if (upgrade && !settings.gateUpgrades) {
    return { allow: true, reason: `move up, not gated (${size}; this turn ${usd(rebuild)} more)`, stay, switched, rebuild }
  }
  if (switched <= stay) {
    return {
      allow: true,
      reason: `switching saves ${usd(stay - switched)} over ${settings.horizonTurns} turns (${size}${toWarm ? ', cache warm' : ', cache rebuild included'})`,
      stay,
      switched,
      rebuild,
    }
  }
  return {
    allow: false,
    reason: `kept ${from}: switching to ${to} would cost ${usd(switched - stay)} more over ${settings.horizonTurns} turns (${size}, cache rebuild ${usd(rebuild)})`,
    stay,
    switched,
    rebuild,
  }
}
