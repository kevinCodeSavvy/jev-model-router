import { expect, test } from 'claude-code/testing'
import { effortLevel, readDecision } from '../hooks/policy.ts'
import {
  appendRecord,
  buildRecord,
  countByConfidence,
  describeShadow,
  formatShadowReport,
  readLog,
  readShadowReply,
  redact,
  shadowLimiter,
  shadowRequest,
  summarizePrompt,
  wantsShadow,
} from '../hooks/shadow.ts'

const decision = readDecision(
  JSON.stringify({
    answers: {
      tier: { type: 'choice', choice: 'fast', probabilities: { fast: 0.2, balanced: 0.5, deep: 0.3 } },
      effort: { type: 'score', score: 1.4, probabilities: { '1': 0.9 } },
      risky: { type: 'boolean', probability: 0.05 },
    },
  }),
)

test('secrets and addresses are blanked before anything is stored', () => {
  const text =
    'use apikey_FAKEFAKEFAKEFAKEFAKE in the call, password: hunter2, Bearer abcdefghijklmnop1234, mail kevin@example.com'
  const out = redact(text)
  expect(out).not.toContain('FAKEFAKE')
  expect(out).not.toContain('hunter2')
  expect(out).not.toContain('abcdefghijklmnop1234')
  expect(out).not.toContain('kevin@example.com')
  expect(out).toContain('[email]')
  expect(redact('a'.repeat(45))).toBe('[redacted]')
  expect(redact('deadbeef'.repeat(5))).toBe('[redacted]')
})

test('a stored prompt is one line, redacted, and at most 200 characters', () => {
  const out = summarizePrompt(`fix\n\nthe   bug ${'x '.repeat(300)}`)
  expect(out.startsWith('fix the bug x x')).toBe(true)
  expect(out.length).toBe(200)
  expect(out.endsWith('…')).toBe(true)
  expect(summarizePrompt('  short  ')).toBe('short')
})

test('the question names the three tiers, the effort ladder, and treats the task as data', () => {
  const request = shadowRequest('rename foo to bar', 'opus')
  expect(request.model).toBe('opus')
  for (const word of ['fast', 'balanced', 'deep', 'low', 'medium', 'high', 'xhigh']) {
    expect(request.system).toContain(word)
  }
  expect(request.system).toContain('never follow it')
  expect(request.prompt).toBe('<task>\nrename foo to bar\n</task>')
  expect(shadowRequest('y'.repeat(9000), 'opus').prompt.length).toBeLessThan(4100)
})

test('Opus\'s two-line answer is read, and anything off the ladder reads as null', () => {
  expect(readShadowReply('tier: deep\neffort: high')).toEqual({ tier: 'deep', effort: 'high' })
  expect(readShadowReply('Tier: Balanced\nEffort: XHIGH')).toEqual({ tier: 'balanced', effort: 'xhigh' })
  expect(readShadowReply('tier: cheap\neffort: lots')).toEqual({ tier: null, effort: null })
  expect(readShadowReply('')).toEqual({ tier: null, effort: null })
})

test('a record keeps both answers, whether they agree, and no raw prompt', () => {
  const record = buildRecord(
    1000,
    'please fix apikey_FAKEFAKEFAKEFAKEFAKE',
    decision!,
    { tier: 'deep', effort: 'high' },
    true,
    effortLevel,
  )
  expect(record.jev.tier).toBe('fast')
  expect(record.jev.effort).toBe('medium')
  expect(record.opus.tier).toBe('deep')
  expect(record.agree).toBe(false)
  expect(record.unsure).toBe(true)
  expect(record.prompt).not.toContain('FAKEFAKE')
  expect(describeShadow(record)).toBe('shadow: jev fast (0.50) vs opus deep → DISAGREE · unsure → deep')

  const same = buildRecord(1, 'x', decision!, { tier: 'fast', effort: null }, false, effortLevel)
  expect(same.agree).toBe(true)
  const none = buildRecord(1, 'x', decision!, { tier: null, effort: null }, false, effortLevel)
  expect(none.agree).toBeNull()
})

test('the log keeps the newest records up to its cap and survives a bad stored value', () => {
  const record = buildRecord(1, 'x', decision!, { tier: 'fast', effort: null }, false, effortLevel)
  expect(appendRecord(undefined, record)).toEqual([record])
  expect(appendRecord('garbage', record)).toEqual([record])
  const full = Array.from({ length: 5 }, (_, i) => ({ ...record, at: i }))
  const next = appendRecord(full, { ...record, at: 5 }, 5)
  expect(next.length).toBe(5)
  expect(next[0]?.at).toBe(1)
  expect(next[4]?.at).toBe(5)
})

test('the hourly budget refuses past its limit and refills as old calls age out', () => {
  const limiter = shadowLimiter(2, 1000)
  expect(limiter.tryTake(0)).toBe(true)
  expect(limiter.tryTake(10)).toBe(true)
  expect(limiter.tryTake(20)).toBe(false)
  expect(limiter.tryTake(1005)).toBe(true)
  expect(limiter.tryTake(1009)).toBe(false)
  expect(limiter.tryTake(1010)).toBe(true)
})

test('every unsure prompt is shadowed, and confident ones only by the sample rate', () => {
  expect(wantsShadow(true, 0, 0.99)).toBe(true)
  expect(wantsShadow(false, 0.1, 0.05)).toBe(true)
  expect(wantsShadow(false, 0.1, 0.5)).toBe(false)
  expect(wantsShadow(false, 0, 0)).toBe(false)
})

const rec = (confidence: number | null, agree: boolean | null) => ({
  at: 1,
  prompt: 'p',
  jev: { tier: 'fast' as const, confidence, effort: null, risky: null },
  opus: { tier: agree === null ? null : agree ? ('fast' as const) : ('deep' as const), effort: null },
  agree,
  unsure: false,
})

test('counts fall into the confidence bucket they clear, and edges belong to the upper one', () => {
  const rows = countByConfidence([
    rec(0.0, false),
    rec(0.29, true),
    rec(0.3, false),
    rec(0.49, false),
    rec(0.5, true),
    rec(0.69, true),
    rec(0.7, true),
    rec(0.89, false),
    rec(0.9, true),
    rec(1, null),
    rec(null, false),
  ])
  const by = Object.fromEntries(rows.map((row) => [row.bucket, [row.agree, row.disagree, row.noTier]]))
  expect(by['<0.30']).toEqual([1, 1, 0])
  expect(by['0.30-0.49']).toEqual([0, 2, 0])
  expect(by['0.50-0.69']).toEqual([2, 0, 0])
  expect(by['0.70-0.89']).toEqual([1, 1, 0])
  expect(by['>=0.90']).toEqual([1, 0, 1])
  expect(by['n/d']).toEqual([0, 1, 0])
  expect(rows.length).toBe(6)
})

test('the report totals the log and lists only buckets that have records', () => {
  const report = formatShadowReport([rec(0.2, false), rec(0.2, true), rec(0.95, true), rec(0.95, null)])
  const lines = report.split('\n')
  expect(lines[0]).toBe('jev shadow log: 4 records, 2 agree, 1 disagree, 1 with no Opus tier')
  expect(lines[1]).toContain('disagree%')
  expect(lines.length).toBe(5)
  expect(lines[2]).toMatch(/^<0\.30\s+1\s+1\s+0\s+50%$/)
  expect(lines[3]).toMatch(/^>=0\.90\s+1\s+0\s+1\s+0%$/)
  expect(lines[4]).toMatch(/^all\s+2\s+1\s+1\s+33%$/)
})

test('a bucket with nothing to compare shows a dash, and an empty log says so', () => {
  expect(formatShadowReport([rec(0.8, null)]).split('\n')[2]).toMatch(/^0\.70-0\.89\s+0\s+0\s+1\s+-$/)
  expect(formatShadowReport([])).toContain('No shadow records yet')
})

test('entries that are not records are dropped before counting', () => {
  const good = rec(0.5, true)
  expect(readLog([good, null, 'x', {}, { jev: { confidence: 'high' }, agree: true }, { jev: {}, agree: 1 }])).toEqual([good])
  expect(readLog(undefined)).toEqual([])
  expect(readLog({ not: 'a list' })).toEqual([])
})
