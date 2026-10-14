import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { On, SessionStartInput } from 'claude-code'

tier('user')

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

function world(on: On, stored: Map<string, unknown>, failWrite = false) {
  const logs: string[] = []
  mock.clock(on, { now: 1_000_000 })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    if (failWrite) throw new Error('read-only')
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return { logs }
}

describe('key hint', () => {
  test('with no key, says once how to add one, and names the configure command', async ($, on) => {
    const stored = new Map<string, unknown>()
    const w = world(on, stored)
    await $.session.start(session)
    const hint = w.logs.filter((line) => line.includes('claude plugin configure'))
    expect(hint).toHaveLength(1)
    expect(hint[0]).toContain('typesafeApiKey')
    expect(hint[0]).toContain('read -rs')
    expect(stored.get('key-hint-shown')).toBe(true)
  })

  test('does not repeat in a later session', async ($, on) => {
    const w = world(on, new Map([['key-hint-shown', true]]))
    await $.session.start(session)
    expect(w.logs.some((line) => line.includes('claude plugin configure'))).toBe(false)
  })

  test('says nothing when a TypeSafe key is set', { options: { typesafeApiKey: 'k' } }, async ($, on) => {
    const stored = new Map<string, unknown>()
    const w = world(on, stored)
    await $.session.start(session)
    expect(w.logs.some((line) => line.includes('claude plugin configure'))).toBe(false)
    expect(stored.has('key-hint-shown')).toBe(false)
  })

  test('says nothing for someone who chose the built-in classifier', { options: { provider: 'builtin' } }, async ($, on) => {
    const w = world(on, new Map())
    await $.session.start(session)
    expect(w.logs.some((line) => line.includes('claude plugin configure'))).toBe(false)
  })

  test('a store that cannot be written skips the hint instead of failing the session', async ($, on) => {
    const w = world(on, new Map(), true)
    await $.session.start(session)
    expect(w.logs.some((line) => line.includes('claude plugin configure'))).toBe(false)
  })
})
