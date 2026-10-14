import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput } from 'claude-code'

import { buildDashboard, dayRows, escapeHtml } from '../hooks/dashboard.ts'
import type { DashboardInput } from '../hooks/dashboard.ts'
import { DAY, NEW_STATE } from '../hooks/tune.ts'

tier('user')

const DAY_INDEX = 100
const NOW = DAY_INDEX * DAY + 6 * 60 * 60 * 1000 // 06:00 UTC on day 100
const key = (back: number) => String(DAY_INDEX - back)

const record = (back: number, confidence: number | null, jev: string, opus: string | null) => ({
  at: (DAY_INDEX - back) * DAY + 1000,
  prompt: 'do NOT show this prompt text',
  jev: { tier: jev, confidence, effort: null, risky: null },
  opus: { tier: opus, effort: null },
  agree: opus === null ? null : opus === jev,
  unsure: false,
})

const input = (over: Partial<DashboardInput> = {}): DashboardInput =>
  ({
    now: NOW,
    configured: 0.3,
    autoTune: true,
    state: NEW_STATE,
    trail: [],
    stats: {
      [key(0)]: { prompts: 10, unsure: 2, confSum: 8, confN: 10 },
      [key(1)]: { prompts: 4, unsure: 0 },
    },
    log: [
      record(0, 0.9, 'fast', 'fast'),
      record(0, 0.2, 'fast', 'deep'),
      record(0, 0.2, 'fast', null),
      record(1, 0.6, 'balanced', 'balanced'),
    ],
    ...over,
  }) as DashboardInput

test('each day gets its prompts, average confidence, escalations and shadow counts', () => {
  const rows = dayRows(input())
  expect(rows.length).toBe(14)
  expect(rows[0]).toMatchObject({
    date: '1970-04-11',
    prompts: 10,
    avgConfidence: 0.8,
    escalated: 2,
    shadow: 3,
    agree: 1,
    disagree: 1,
    noTier: 1,
  })
  // A day counted before confidences were kept has no average rather than a wrong one.
  expect(rows[1]).toMatchObject({ prompts: 4, avgConfidence: null, shadow: 1, agree: 1 })
  expect(rows[2]).toMatchObject({ prompts: 0, shadow: 0 })
  expect(rows[13]?.date).toBe('1970-03-29')
})

test('a floor move is listed on the day it happened', () => {
  const rows = dayRows(
    input({ trail: [{ at: NOW - DAY, action: 'raise', from: 0.3, to: 0.35, reason: 'x' }] }),
  )
  expect(rows[1]?.moves).toEqual(['raise 0.30 → 0.35'])
  expect(rows[0]?.moves).toEqual([])
})

test('the page is a complete document with the five steps, the day table and the audit trail', () => {
  const html = buildDashboard(
    input({
      state: { value: 0.35, changedAt: NOW - DAY, frozenUntil: 0 },
      trail: [{ at: NOW - DAY, action: 'raise', from: 0.3, to: 0.35, reason: 'Opus rated 43% higher' }],
    }),
  )
  expect(html.startsWith('<!doctype html>')).toBe(true)
  for (const step of ['1 · Jev rates', '2 · Router decides', '3 · Shadow check', '4 · Opus vs Jev', '5 · Auto-tune']) {
    expect(html).toContain(step)
  }
  expect(html).toContain('<div class="big">10</div>')
  expect(html).toContain('avg confidence 0.80')
  expect(html).toContain('<div class="big">1 / 1</div>')
  expect(html).toContain('<div class="big">0.35</div>')
  expect(html).toContain('tuned; configured 0.30')
  expect(html).toContain('Opus rated 43% higher')
  expect(html).toContain('raise 0.30 → 0.35')
  expect(html).toContain('1970-04-11')
})

test('the page is self-contained: no scripts, no network, and no prompt text', () => {
  const html = buildDashboard(input())
  expect(html).not.toContain('<script')
  expect(html).not.toMatch(/https?:\/\//)
  expect(html).not.toContain('do NOT show')
})

test('generated text is escaped before it goes into the page', () => {
  expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;')
  const html = buildDashboard(
    input({ trail: [{ at: NOW, action: 'raise', from: 0.3, to: 0.35, reason: '<img src=x onerror=alert(1)>' }] }),
  )
  expect(html).not.toContain('<img src=x')
  expect(html).toContain('&lt;img src=x')
})

test('an empty store still produces a readable page', () => {
  const html = buildDashboard(input({ stats: {}, log: [], trail: [] }))
  expect(html).toContain('No shadow records yet.')
  expect(html).toContain('No tuning changes yet.')
  expect(html).toContain('as configured, not tuned')
})

test('the floor card says why when tuning is off, frozen, or not applicable', () => {
  expect(buildDashboard(input({ autoTune: false }))).toContain('auto-tune off')
  expect(buildDashboard(input({ configured: 0 }))).toContain('floor off, nothing to tune')
  const frozen = buildDashboard(input({ state: { value: null, changedAt: 1, frozenUntil: NOW + DAY } }))
  expect(frozen).toContain('frozen until 1970-04-12')
})

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }
const run = (args = ''): CommandRunInput => ({
  command: 'jev-dashboard',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
})

/** The engine beneath the mod, recording what it was asked to write and run. */
function world(on: On, stored: Map<string, unknown>, system = 'Darwin\n', openExit = 0) {
  const written: { path: string; text: string }[] = []
  const ran: string[][] = []
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.write', ($, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const [program] = e.argv
    const stdout = program === 'printenv' ? '/Users/kev\n' : program === 'uname' ? system : ''
    const exitCode = program === 'open' || program === 'xdg-open' ? openExit : 0
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { written, ran }
}

describe('/jev-dashboard', () => {
  test('writes the page under ~/.claude and opens it in the browser', async ($, on) => {
    const stored = new Map<string, unknown>([['tune-stats', { [key(0)]: { prompts: 7, unsure: 1, confSum: 6, confN: 7 } }]])
    const w = world(on, stored)
    await $.session.start(session)
    const result = await $.command.run(run())

    const path = '/Users/kev/.claude/jev-model-router/dashboard.html'
    expect(w.written.length).toBe(1)
    expect(w.written[0]?.path).toBe(path)
    expect(w.written[0]?.text).toContain('<div class="big">7</div>')
    expect(w.ran).toContainEqual(['open', path])
    expect(result.text).toBe(`Dashboard opened in your browser: ${path}`)
  })

  test('no-open writes the page and leaves the browser alone', async ($, on) => {
    const w = world(on, new Map())
    await $.session.start(session)
    const result = await $.command.run(run('no-open'))
    expect(result.text).toBe('Dashboard written to /Users/kev/.claude/jev-model-router/dashboard.html')
    expect(w.ran.some(([program]) => program === 'open')).toBe(false)
  })

  test('uses xdg-open on Linux, and says so plainly when the browser does not open', async ($, on) => {
    const w = world(on, new Map(), 'Linux\n', 1)
    await $.session.start(session)
    const result = await $.command.run(run())
    expect(w.ran.some(([program]) => program === 'xdg-open')).toBe(true)
    expect(result.text).toContain('the browser did not open')
  })

  test('on an unknown system the page is written and the path is given', async ($, on) => {
    const w = world(on, new Map(), 'Plan9\n')
    await $.session.start(session)
    const result = await $.command.run(run())
    expect(w.written.length).toBe(1)
    expect(result.text).toContain('Open that file in a browser')
  })
})
