/**
 * Smoke test: run probe -> look -> act(wait) and print the JSON plus the PNG
 * paths, so the images can be inspected by eye.
 *
 *   node test/smoke.mjs
 */
import os from 'node:os'
import path from 'node:path'
import { actOnScreen, lookScreen, probeDesktop, zoomScreen } from '../lib/win32ps.mjs'

const outDir = path.join(os.tmpdir(), 'see-act-smoke')

const t0 = Date.now()
const probe = await probeDesktop()
console.log('probe', Date.now() - t0, 'ms', JSON.stringify(probe))

const t1 = Date.now()
const look = await lookScreen({ outDir, targetWidth: 1280, crosshair: { nx: 0.5, ny: 0.5 } })
console.log('look', Date.now() - t1, 'ms', JSON.stringify(look))

const t2 = Date.now()
const zoom = await zoomScreen({ outDir, at: { nx: 0.5, ny: 0.5 }, factor: 3, size: 320 })
console.log('zoom', Date.now() - t2, 'ms', JSON.stringify(zoom))

const t3 = Date.now()
const act = await actOnScreen({
  outDir,
  targetWidth: 1280,
  settleMs: 120,
  steps: [{ do: 'wait', ms: 200 }],
  shots: 'both',
  zoomInset: true,
  dodge: 'hide',
  overlayPid: 0,
})
console.log('act', Date.now() - t3, 'ms', JSON.stringify(act, null, 2))
