/**
 * e2e-tools.mjs — drive the real tools the way the model will, without Cordis.
 *
 * Not part of `node --test` (it moves the real mouse and writes real frames):
 *   node test/e2e-tools.mjs
 */

import assert from 'node:assert/strict'

import { createToolDefinitions } from '../lib/tools.mjs'

const saved = []
const attachments = {
  async saveImage({ data, mediaType, name }) {
    saved.push({ name, mediaType, bytes: data.length })
    return { mimeType: mediaType, name, size: data.length }
  },
}

const ctx = {
  get: (key) => (key === 'attachments' ? attachments : undefined),
  logger: { info: (message) => console.log(`  · ${message}`) },
}

const env = {
  ...process.env,
  DSH_SEE_ACT_QUALITY: 'fast',
  DSH_SEE_ACT_NARRATE: 'false',
}

const tools = new Map(
  createToolDefinitions({ ctx, env, log: (message) => console.log(`  ! ${message}`) }).map((tool) => [
    tool.name,
    tool,
  ]),
)

function report(label, result) {
  console.log(`\n=== ${label} ===`)
  console.log(result.text)
  console.log(`images: ${(result.images ?? []).length}  meta keys: ${Object.keys(result.meta ?? {}).join(', ')}`)
}

// A previous run may have left the brake on; start from a known state.
await tools.get('see_stop').execute({ action: 'clear' })

// 1. look at the screen, aiming at a point, at the cheapest quality
const look = await tools.get('see_look').execute({ quality: 'fast', at: { nx: 0.5, ny: 0.2 } })
report('see_look', look)
assert.match(look.text, /^LOOK/)
assert.equal(look.images.length, 1)
assert.ok(look.meta.screen.width >= 800)
assert.match(look.text, /cursor \d+,\d+/)
console.log(`attachments: ${JSON.stringify(saved.at(-1))}`)

// 2. zoom into the cursor so the assertions check a stable place
const zoom = await tools.get('see_zoom').execute({ at: { nx: 0.5, ny: 0.5 }, factor: 2, size: 160 })
report('see_zoom', zoom)
assert.match(zoom.text, /^ZOOM 2x/)
assert.equal(zoom.images.length, 1)

// 3. a real pointer move, with no frames requested
const move = await tools.get('see_act').execute({ do: 'move', at: { nx: 0.5, ny: 0.5 }, shots: 'none' })
report('see_act move', move)
assert.match(move.text, /^ACT/)
assert.equal(move.images.length, 0)

// 4. the stop switch reports, arms and clears
const status = await tools.get('see_stop').execute({ action: 'status' })
report('see_stop status', status)
assert.match(status.text, /armed|stopped/)
assert.match(status.text, /see-now float: (not open|\d+,\d+ \d+x\d+)/)

const armed = await tools.get('see_stop').execute({ action: 'stop', reason: 'e2e-tools check' })
assert.match(armed.text, /STOPPED/)
assert.match(armed.text, /e2e-tools check/)

await assert.rejects(
  () => tools.get('see_act').execute({ do: 'move', at: { nx: 0.5, ny: 0.5 }, shots: 'none' }),
  /see-act is stopped/,
)
console.log('\n=== stop flag blocks see_act ===')

const cleared = await tools.get('see_stop').execute({ action: 'clear' })
report('see_stop clear', cleared)
assert.match(cleared.text, /re-armed|nothing to clear/i)

// 5. dangerous keys need force
await assert.rejects(
  () => tools.get('see_act').execute({ do: 'key', keys: 'CTRL+ALT+DEL', shots: 'none' }),
  /take the screen away/,
)
console.log('=== dangerous keys refused ===')

// 6. a bad point is refused before anything moves
await assert.rejects(
  () => tools.get('see_act').execute({ do: 'click', at: { nx: 3, ny: 0.5 } }),
  /0\.\.1/,
)
console.log('=== bad coordinates refused ===')

console.log('\nall e2e checks passed')
