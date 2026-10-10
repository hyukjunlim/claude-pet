import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-03-14T09:00:00.000Z')
const context = { window: 200_000 }

// The engine's side: it echoes a measurement, and records the files the mod writes.
function engine(on: On, { failWrites = false } = {}) {
  mock.clock(on, { now: NOW })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const writes: { path: string, text: string }[] = []
  on('fs.write', (_$, e, next) => {
    if (failWrites) throw new Error('EACCES')
    writes.push(e)
    return next(e)
  })
  return writes
}

test('saves the limits from each measurement, two folders above the mod', async ($, on) => {
  const writes = engine(on)

  await $.session.measure({
    context,
    changed: ['rateLimits'],
    rateLimits: [
      { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-03-14T11:00:00.000Z' },
      { kind: 'seven_day', percentUsed: 45, resetsAt: '2026-03-17T06:00:00.000Z' },
    ],
  })

  expect(writes.length).toBe(1)
  expect(/[\\/]usage\.json$/.test(writes[0].path)).toBe(true)   // the engine writes the path the OS's way
  expect(JSON.parse(writes[0].text)).toEqual({
    version: 1,
    at: NOW,
    limits: [
      { kind: 'five_hour', percent: 12, resetsAt: Date.parse('2026-03-14T11:00:00.000Z') },
      { kind: 'seven_day', percent: 45, resetsAt: Date.parse('2026-03-17T06:00:00.000Z') },
    ],
  })
})

test('writes nothing before the first reply, or off a subscription', async ($, on) => {
  const writes = engine(on)

  await $.session.measure({ context, changed: ['context'], rateLimits: [] })

  expect(writes.length).toBe(0)
})

test('a failed write leaves the session alone', async ($, on) => {
  engine(on, { failWrites: true })

  const result = await $.session.measure({
    context,
    changed: ['rateLimits'],
    rateLimits: [{ kind: 'seven_day', percentUsed: 45 }],
  })

  expect(result.changed).toEqual(['rateLimits'])
})
