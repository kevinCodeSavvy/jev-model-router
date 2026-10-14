import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput } from 'claude-code'

tier('user')

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

const run = (args = ''): CommandRunInput => ({
  command: 'jev-shadow',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
})

const rec = (confidence: number | null, agree: boolean | null) => ({
  at: 1,
  prompt: 'p',
  jev: { tier: 'fast', confidence, effort: null, risky: null },
  opus: { tier: agree === null ? null : agree ? 'fast' : 'deep', effort: null },
  agree,
  unsure: false,
})

/** The engine beneath the mod: a store the test fills, and a command table it records. */
function world(on: On, stored: Map<string, unknown>) {
  const registered: string[] = []
  mock.clock(on, { now: 1_000_000 })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  return { registered }
}

describe('/jev-shadow', () => {
  test('registers at session start and prints counts by confidence from the stored log', async ($, on) => {
    const w = world(on, new Map([['shadow-log', [rec(0.2, false), rec(0.2, true), rec(0.95, true)]]]))
    await $.session.start(session)
    expect(w.registered).toContain('jev-shadow')

    const result = await $.command.run(run())
    const lines = (result.text ?? '').split('\n')
    expect(lines[0]).toBe('jev shadow log: 3 records, 2 agree, 1 disagree, 0 with no Opus tier')
    expect(lines.some((line) => /^<0\.30\s+1\s+1\s+0\s+50%$/.test(line))).toBe(true)
    expect(lines.some((line) => /^>=0\.90\s+1\s+0\s+0\s+0%$/.test(line))).toBe(true)
  })

  test('says so when nothing has been logged yet', async ($, on) => {
    world(on, new Map())
    await $.session.start(session)
    expect((await $.command.run(run())).text).toContain('No shadow records yet')
  })

  test('survives a damaged store value', async ($, on) => {
    world(on, new Map([['shadow-log', 'garbage']]))
    await $.session.start(session)
    expect((await $.command.run(run())).text).toContain('No shadow records yet')
  })
})
