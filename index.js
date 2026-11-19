/**
 * dsh-see-act — the hands for dsh-see-now's eyes.
 *
 * `see_now` watches the screen but cannot touch it; the `real_*` tools can touch
 * it but cannot see it in the same breath. This plugin closes that gap without
 * patching either of them:
 *
 *   - every action returns the **before and after frame**, annotated with the
 *     grid, the crosshair, a 3x inset of the point, and the float window;
 *   - the capture, the action and the second capture run inside ONE PowerShell
 *     process, so a click costs one round trip, not three;
 *   - it borrows `dsh-see-now`'s chat stream (narration in the same bubble the
 *     user is watching) and its window pid (step around the always-on-top
 *     window) — both optional, both degrading to nothing.
 *
 * Coordinates are the contract: `at` takes nx/ny fractions of the frame, never
 * pixels read off a scaled-down image.
 *
 * @module dsh-see-act
 */

import { createToolDefinitions } from './lib/tools.mjs'
import { loadConfig } from './lib/config.mjs'
import { primeSeeNow } from './lib/seecompat.mjs'

/** Cordis plugin name. */
export const name = 'see-act'

/**
 * Services the tools use. `attachments` is how a PNG becomes an image in the
 * conversation; without it the frames would be written and thrown away.
 */
export const inject = ['tools', 'attachments']

export function apply(ctx, config = {}) {
  const log = (message) => {
    try {
      ctx?.logger?.info?.(`[dsh-see-act] ${message}`)
    } catch {
      /* logging must never break the plugin */
    }
  }

  // The patch may carry config, but ~/.dsh/see-act.json (and the DSH_SEE_ACT_*
  // env overrides) is the real source of truth at call time.
  const resolved = loadConfig(process.env, log)
  const mode = config.mode ?? resolved.mode

  const features = []
  features.push('see_look', 'see_zoom')
  if (mode !== 'readonly') features.push('see_act')
  features.push('see_stop')

  for (const definition of createToolDefinitions({ ctx, env: process.env, log })) {
    ctx.tools.register(definition)
  }
  log(`registered ${features.join(', ')} (mode ${mode}, screen ${resolved.screen})`)

  // Warm the see-now modules in the background: the first action should not pay
  // for the first import, and a broken peer should say so once, not per call.
  primeSeeNow(process.env)
    .then((entry) => {
      if (entry.error) log(`dsh-see-now not fully reachable (${entry.error}); narration/dodging degrade to no-ops`)
      else log(`dsh-see-now found at ${entry.dir}`)
    })
    .catch((error) => log(`dsh-see-now probe failed: ${error.message}`))
}
