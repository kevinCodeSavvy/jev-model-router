import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_CACHE_SETTINGS,
  isWarm,
  judgeSwitch,
  tierOfModel,
  turnCost,
} from '../hooks/cache.ts'
import type { CacheSettings, LastUsed } from '../hooks/cache.ts'

const NOW = 10_000_000
const MIN = 60_000
const tiers = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' }
const settings = (over: Partial<CacheSettings> = {}): CacheSettings => ({ ...DEFAULT_CACHE_SETTINGS, ...over })
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

test('a model id is mapped to its tier, and an unknown one to none', () => {
  expect(tierOfModel('claude-sonnet-5-5', tiers)).toBe('balanced')
  expect(tierOfModel('haiku', tiers)).toBe('fast')
  expect(tierOfModel('claude-opus-5-5', tiers)).toBe('deep')
  expect(tierOfModel('gpt-whatever', tiers)).toBe(null)
})

test('a cache is warm only inside its lifetime', () => {
  const last: LastUsed = { fast: NOW - 10 * MIN, balanced: NOW - 90 * MIN }
  expect(isWarm('fast', last, NOW, 60)).toBe(true)
  expect(isWarm('balanced', last, NOW, 60)).toBe(false)
  expect(isWarm('deep', last, NOW, 60)).toBe(false)
  expect(isWarm('fast', last, NOW, 5)).toBe(false)
})

test('a turn is the context as a read or a write, plus the output', () => {
  const s = settings({ outputTokens: 1500, ttlMinutes: 60 })
  // Sonnet, 50k warm: 50k x $0.20/M read + 1500 x $10/M output.
  expect(near(turnCost('balanced', 50_000, true, s), 0.01 + 0.015)).toBe(true)
  // Haiku, 50k cold on a 1-hour cache: write is 2 x $0.10/M.
  expect(near(turnCost('fast', 50_000, false, s), 0.01 + 0.00075)).toBe(true)
  // The same write on a 5-minute cache is 1.25x.
  expect(near(turnCost('fast', 50_000, false, settings({ ttlMinutes: 5, outputTokens: 0 })), 50_000 * 0.125 / 1e6)).toBe(true)
  // Over 100k Haiku moves to its long-context rates.
  expect(near(turnCost('fast', 184_000, true, settings({ outputTokens: 0 })), 184_000 * 0.05 / 1e6)).toBe(true)
})

test('a small or unknown context never blocks a switch', () => {
  const base = { from: 'balanced', to: 'fast', lastUsed: {}, now: NOW } as const
  expect(judgeSwitch({ ...base, contextTokens: 15_000 }, settings()).allow).toBe(true)
  expect(judgeSwitch({ ...base, contextTokens: null }, settings()).reason).toBe('context size unknown')
  expect(judgeSwitch({ ...base, from: 'fast', to: 'fast', contextTokens: 900_000 }, settings()).reason).toBe('same model')
})

test('Sonnet to Haiku at 50k pays even with Haiku cold', () => {
  const verdict = judgeSwitch(
    { from: 'balanced', to: 'fast', contextTokens: 50_000, lastUsed: { balanced: NOW - MIN }, now: NOW },
    settings(),
  )
  expect(verdict.allow).toBe(true)
  expect(near(verdict.stay ?? 0, 3 * 0.025)).toBe(true)
  expect(near(verdict.switched ?? 0, 0.01075 + 2 * 0.00125)).toBe(true)
})

test('Sonnet to Haiku at 184k is held back over 3 turns, and allowed over 10', () => {
  const q = { from: 'balanced', to: 'fast', contextTokens: 184_000, lastUsed: { balanced: NOW - MIN }, now: NOW } as const
  const short = judgeSwitch(q, settings({ horizonTurns: 3 }))
  expect(short.allow).toBe(false)
  expect(short.reason).toContain('kept balanced')
  expect(short.reason).toContain('184k context')
  expect(judgeSwitch(q, settings({ horizonTurns: 10 })).allow).toBe(true)
})

test('a Haiku cache that is already warm makes the same switch pay', () => {
  const verdict = judgeSwitch(
    {
      from: 'balanced',
      to: 'fast',
      contextTokens: 184_000,
      lastUsed: { balanced: NOW - MIN, fast: NOW - 2 * MIN },
      now: NOW,
    },
    settings(),
  )
  expect(verdict.allow).toBe(true)
  expect(verdict.reason).toContain('cache warm')
})

test('a Haiku cache past its lifetime counts as cold again', () => {
  const verdict = judgeSwitch(
    {
      from: 'balanced',
      to: 'fast',
      contextTokens: 184_000,
      lastUsed: { balanced: NOW - MIN, fast: NOW - 120 * MIN },
      now: NOW,
    },
    settings(),
  )
  expect(verdict.allow).toBe(false)
})

test('when neither cache is warm, the cheaper write wins', () => {
  // A resumed session: both caches cold, so staying rebuilds too.
  const verdict = judgeSwitch(
    { from: 'balanced', to: 'fast', contextTokens: 60_000, lastUsed: {}, now: NOW },
    settings(),
  )
  expect(verdict.allow).toBe(true)
})

test('a move up is not gated by default, and says what the rebuild costs', () => {
  const q = { from: 'balanced', to: 'deep', contextTokens: 184_000, lastUsed: { balanced: NOW - MIN }, now: NOW } as const
  const verdict = judgeSwitch(q, settings())
  expect(verdict.allow).toBe(true)
  expect(verdict.reason).toContain('move up, not gated')
  // Opus writes 184k at 2 x $4/M = $1.472, against a $0.037 Sonnet read, output being $0.03 vs $0.015.
  expect(near(verdict.rebuild ?? 0, 1.472 + 0.03 - (0.0368 + 0.015))).toBe(true)
})

test('gateUpgrades holds a costly move up back', () => {
  const q = { from: 'balanced', to: 'deep', contextTokens: 184_000, lastUsed: { balanced: NOW - MIN }, now: NOW } as const
  const verdict = judgeSwitch(q, settings({ gateUpgrades: true }))
  expect(verdict.allow).toBe(false)
  expect(verdict.reason).toContain('kept balanced')
})
