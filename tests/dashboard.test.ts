import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput } from 'claude-code'

import { agreementChart, buildDashboard, confidenceNote, dayRows, escapeHtml, lastCutoffChange, standing, trendOf } from '../hooks/dashboard.ts'
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

test('the page explains itself, gives a plain verdict, then today, the line, the confidence table and the day table', () => {
  const html = buildDashboard(
    input({
      state: { value: 0.35, changedAt: NOW - DAY, frozenUntil: 0 },
      trail: [{ at: NOW - DAY, action: 'raise', from: 0.3, to: 0.35, reason: 'Opus rated 43% higher' }],
    }),
  )
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html.indexOf('What is this?')).toBeLessThan(html.indexOf('class="banner'))
  expect(html.indexOf('class="banner')).toBeLessThan(html.indexOf('What happened today'))
  expect(html).toContain('Too early to tell.')
  expect(html).toContain('So far there are 3.')
  expect(html).toContain('Jev looked at <b>10</b> prompts. It was not sure about <b>2</b>')
  expect(html).toContain('double-checked <b>2</b> of Jev')
  expect(html).toContain('less than <b>35%</b> sure')
  expect(html).toContain('tuned; configured 0.30')
  expect(html).toContain('Under 30% sure')
  expect(html).toContain('Words used on this page')
  expect(html).toContain('Opus rated 43% higher')
  expect(html).toContain('raise 0.30 → 0.35')
  expect(html).toContain('1970-04-11')
  // Days with nothing in them are hidden, and the page says how many.
  expect(html).toContain('12 of the last 14 days had no activity')
})

test('the agreement line has one point per day with checks, oldest first, and waits for two days', () => {
  const log = [record(2, 0.8, 'fast', 'fast'), record(2, 0.8, 'fast', 'deep'), record(0, 0.8, 'fast', 'fast')]
  const svg = agreementChart(dayRows(input({ log })))
  expect(svg.match(/<circle/g)?.length).toBe(2)
  expect(svg).toContain('1970-04-09: 50% agreed (1 of 2)')
  expect(svg).toContain('1970-04-11: 100% agreed (1 of 1)')
  expect(svg.indexOf('04-09')).toBeLessThan(svg.indexOf('04-11'))
  expect(agreementChart(dayRows(input({ log: [record(0, 0.8, 'fast', 'fast')] })))).toContain('appears once two different days')
  expect(buildDashboard(input({ log }))).toContain('<polyline')
})

test('the trend compares the older half of the checks with the newer half', () => {
  const log = [
    ...Array.from({ length: 10 }, (_, i) => record(5, 0.8, 'fast', i < 5 ? 'fast' : 'deep')),
    ...Array.from({ length: 10 }, (_, i) => record(0, 0.8, 'fast', i < 9 ? 'fast' : 'deep')),
  ]
  expect(trendOf(log)).toEqual({ older: 0.5, newer: 0.9 })
  expect(trendOf(log.slice(0, 5))).toBeNull()
})

test('the banner says improving, worse, steady or too early, with the numbers', () => {
  const batch = (back: number, agreeing: number) =>
    Array.from({ length: 10 }, (_, i) => record(back, 0.8, 'fast', i < agreeing ? 'fast' : 'deep'))
  const better = standing([...batch(5, 5), ...batch(0, 9)])
  expect(better.kind).toBe('improving')
  expect(better.headline).toBe('Jev and Opus agree more often now.')
  expect(better.because).toContain('<b>90%</b>')
  expect(better.because).toContain('<b>50%</b>')
  expect(better.because).toContain('not proof that Jev learned anything')
  const worse = standing([...batch(5, 9), ...batch(0, 5)])
  expect(worse.kind).toBe('worse')
  expect(worse.headline).toBe('Jev and Opus agree less often now.')
  const steady = standing([...batch(5, 7), ...batch(0, 7)])
  expect(steady.kind).toBe('steady')
  expect(steady.headline).toBe('Jev and Opus agree about as often as before.')
  expect(standing(batch(0, 5).slice(0, 4)).kind).toBe('early')
  expect(buildDashboard(input({ log: [...batch(5, 5), ...batch(0, 9)] }))).toContain('class="banner improving"')
})

test('the page says Jev does not learn here, and what the router did to the cutoff last', () => {
  const html = buildDashboard(
    input({ trail: [{ at: NOW - DAY, action: 'lower', from: 0.3, to: 0.25, reason: 'Opus <agreed> a lot' }] }),
  )
  expect(html).toContain('Does Jev learn from this?')
  expect(html).toContain('<b>No.</b> Jev is a model run by TypeSafe')
  expect(html).toContain('on 1970-04-10 the line was lowered from <b>30%</b> to <b>25%</b>. Why: Opus &lt;agreed&gt; a lot.')
  expect(lastCutoffChange([{ at: NOW, action: 'rollback', from: 0.25, to: 0.3, reason: 'x' }])).toContain('moved back from')
  expect(lastCutoffChange([])).toBe('The "not sure" line has not been moved yet.')
  expect(buildDashboard(input())).toContain('has not been moved yet')
})

test('the confidence note says when "sure" does and does not mean right', () => {
  const useful = [record(0, 0.95, 'fast', 'fast'), record(0, 0.2, 'fast', 'deep')]
  expect(confidenceNote(useful)).toContain('the surer Jev says it is, the more often it is right')
  const flat = [record(0, 0.95, 'fast', 'deep'), record(0, 0.2, 'fast', 'deep')]
  expect(confidenceNote(flat)).toContain('does not mean it is right')
  expect(confidenceNote([record(0, 0.95, 'fast', 'fast')])).toBeNull()
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
  expect(html).toContain('No double-checks yet.')
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
    expect(w.written[0]?.text).toContain('Jev looked at <b>7</b> prompts')
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
