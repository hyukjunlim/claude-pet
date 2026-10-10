import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Claude Pet's mod for Claude Code. After each reply, Claude Code knows how much of the plan's
// limits the account has used (the 5-hour and the weekly window, and when each resets). This
// saves those figures for the pet, and does nothing else:
//
//   <home>/.claude-pet/usage.json
//   { "version": 1, "at": <ms>, "limits": [{ "kind": "seven_day", "percent": 45, "resetsAt": <ms> }, …] }
//
// The pet installs the mod at <home>/.claude-pet/mod/pet-usage, so the file is two folders
// up from it. A WSL session runs the copy on the Windows side (/mnt/c/…) and so writes the file
// the pet reads there.

function usageFile($: EngineInterface) {
  const home = $.plugin.root.replace(/[\\/]+$/, '').replace(/[\\/]mod[\\/][^\\/]+$/, '')
  return `${home}/usage.json`
}

async function save($: EngineInterface, rateLimits: readonly SessionRateLimit[]) {
  const limits = rateLimits.map((l) => {
    const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    return { kind: l.kind, percent: l.percentUsed, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }
  })
  if (!limits.length) return   // not on a subscription, or no reply yet
  try {
    await $.fs.write(usageFile($), JSON.stringify({ version: 1, at: await $.clock.now(), limits }))
  } catch {
    // The pet falls back to the figures it gets elsewhere.
  }
}

export const register: Register = on => {
  // After each turn, and when a window moves a whole point.
  on('session.measure', async ($, e, next) => {
    await save($, e.rateLimits)
    return next(e)
  })
}
