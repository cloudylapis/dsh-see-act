/**
 * config.mjs — what see-act does by default, and how a user changes it.
 *
 * Three layers, later wins: built-in defaults -> `~/.dsh/see-act.json` ->
 * environment variables. The JSON file is optional; a broken one is logged and
 * ignored rather than taking the whole plugin down (a typo must not cost the
 * user their mouse).
 *
 * @module dsh-see-act/config
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Every knob, with the value used when nothing else says otherwise. */
export const DEFAULTS = Object.freeze({
  /** 'act' moves the real mouse; 'readonly' allows look/zoom only. */
  mode: 'act',
  /** Default capture width: fast 800 / aim 1280 / read 1600. */
  quality: 'aim',
  /** Which monitor to work on: foreground | primary | cursor | all | index. */
  screen: 'foreground',
  /** Quiet wait after each step, so the after-frame is not caught mid-animation. */
  settleMs: 140,
  /** Hard cap on chained steps in one see_act call. */
  maxSteps: 8,
  /** Refuse a plan whose estimated wall time exceeds this (ms). */
  maxPlanMs: 60_000,
  /** 'both' returns before+after, 'after' only after, 'none' no frames. */
  shots: 'both',
  /** Draw the 3x zoom inset next to the crosshair. */
  zoomInset: true,
  /** Hide the see-now float window while a click lands inside it, then restore. */
  dodge: 'hide',
  /** Write one grey line per action into the see-now chat stream. */
  narrate: true,
  /** When GDI captures an all-black frame, retry through ffmpeg (Desktop Duplication). */
  captureFallback: true,
})

const MODES = new Set(['act', 'readonly'])
const QUALITIES = new Set(['fast', 'aim', 'read'])
const SHOTS = new Set(['both', 'after', 'none'])
const DODGES = new Set(['hide', 'off'])
const SCREENS = new Set(['foreground', 'primary', 'cursor', 'all', 'virtual'])

/** `DSH_HOME`, or `~/.dsh`. */
export function dshHome(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** `~/.dsh/see-act.json` (or `DSH_SEE_ACT_CONFIG`). */
export function configPath(env = process.env) {
  return env.DSH_SEE_ACT_CONFIG || path.join(dshHome(env), 'see-act.json')
}

/** Where per-call frames are written before they become attachments. */
export function frameRoot(env = process.env) {
  return env.DSH_SEE_ACT_FRAMES || path.join(dshHome(env), 'see-act-frames')
}

/** The stop flag: while this file exists, see_act refuses to move the mouse. */
export function stopPath(env = process.env) {
  return env.DSH_SEE_ACT_STOP || path.join(dshHome(env), 'see-act.stop')
}

function asBool(raw, fallback) {
  if (typeof raw === 'boolean') return raw
  if (typeof raw !== 'string') return fallback
  const value = raw.trim().toLowerCase()
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false
  return fallback
}

function asInt(raw, fallback, min, max) {
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Read the optional JSON config; unreadable or invalid means "use defaults". */
export function readConfigFile(env = process.env, log = () => {}) {
  const file = configPath(env)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log(`ignoring ${file}: expected a JSON object`)
      return {}
    }
    return parsed
  } catch (error) {
    log(`ignoring ${file}: ${error.message}`)
    return {}
  }
}

/** Merge defaults, the config file and environment overrides into one object. */
export function loadConfig(env = process.env, log = () => {}) {
  const file = readConfigFile(env, log)
  const config = { ...DEFAULTS, ...file }

  // Each field is validated on its own: one bad value must not reset the rest.
  if (!MODES.has(config.mode)) config.mode = DEFAULTS.mode
  if (!QUALITIES.has(config.quality)) config.quality = DEFAULTS.quality
  if (!SHOTS.has(config.shots)) config.shots = DEFAULTS.shots
  if (!DODGES.has(config.dodge)) config.dodge = DEFAULTS.dodge
  if (!SCREENS.has(String(config.screen)) && !Number.isInteger(config.screen)) config.screen = DEFAULTS.screen
  config.zoomInset = asBool(config.zoomInset, DEFAULTS.zoomInset)
  config.narrate = asBool(config.narrate, DEFAULTS.narrate)
  config.captureFallback = asBool(config.captureFallback, DEFAULTS.captureFallback)
  config.settleMs = asInt(config.settleMs, DEFAULTS.settleMs, 0, 3000)
  config.maxSteps = asInt(config.maxSteps, DEFAULTS.maxSteps, 1, 16)
  config.maxPlanMs = asInt(config.maxPlanMs, DEFAULTS.maxPlanMs, 1000, 120_000)

  const envMode = env.DSH_SEE_ACT_MODE
  if (envMode && MODES.has(envMode.trim())) config.mode = envMode.trim()
  const envQuality = env.DSH_SEE_ACT_QUALITY
  if (envQuality && QUALITIES.has(envQuality.trim())) config.quality = envQuality.trim()
  const envScreen = env.DSH_SEE_ACT_SCREEN
  if (envScreen && SCREENS.has(envScreen.trim())) config.screen = envScreen.trim()
  config.narrate = asBool(env.DSH_SEE_ACT_NARRATE, config.narrate)
  config.dodge = asBool(env.DSH_SEE_ACT_NO_DODGE, false) ? 'off' : config.dodge
  config.settleMs = asInt(env.DSH_SEE_ACT_SETTLE_MS, config.settleMs, 0, 3000)

  return config
}

/** True when see_act is allowed to drive the mouse. */
export function canAct(config) {
  return config.mode === 'act'
}
