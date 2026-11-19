/**
 * act.mjs — turn one tool call into a plan the PowerShell side can execute.
 *
 * The plan is deliberately boring: a list of steps, each one a verb plus the
 * arguments that verb needs, already clamped to something safe. All the
 * judgement (how many steps, which keys are off limits, how long this may
 * take) lives here so the script only has to do what it is told.
 *
 * @module dsh-see-act/act
 */

import fs from 'node:fs'
import path from 'node:path'

import { describePoint, parsePoint } from './geometry.mjs'
import { stopPath } from './config.mjs'

/** Step verbs the script understands. */
export const STEP_KINDS = Object.freeze([
  'click',
  'double',
  'right',
  'middle',
  'move',
  'scroll',
  'drag',
  'type',
  'key',
  'wait',
  'focus',
])

/** Kinds that mean "put the pointer here first". */
const POINTED = new Set(['click', 'double', 'right', 'middle', 'move', 'scroll'])

/** A model that writes in prose sometimes also names the verb in prose. */
const ALIASES = Object.freeze({
  click: 'click',
  left: 'click',
  leftclick: 'click',
  tap: 'click',
  double: 'double',
  dblclick: 'double',
  doubleclick: 'double',
  right: 'right',
  rightclick: 'right',
  contextmenu: 'right',
  middle: 'middle',
  move: 'move',
  hover: 'move',
  scroll: 'scroll',
  wheel: 'scroll',
  drag: 'drag',
  type: 'type',
  text: 'type',
  paste: 'type',
  key: 'key',
  keys: 'key',
  hotkey: 'key',
  press: 'key',
  wait: 'wait',
  sleep: 'wait',
  focus: 'focus',
  activate: 'focus',
})

/**
 * Key combinations that would yank the machine away from the user (lock the
 * screen, switch windows, kill the front app). They are legitimate sometimes,
 * so `force: true` passes them through — but never by accident.
 */
export const DANGEROUS_KEYS = Object.freeze([
  'WIN',
  'LWIN',
  'WIN+R',
  'WIN+X',
  'WIN+L',
  'WIN+D',
  'WIN+E',
  'WIN+TAB',
  'CTRL+ALT+DEL',
  'CTRL+SHIFT+ESC',
  'ALT+F4',
  'ALT+TAB',
])

function clamp(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Normalise `ATL+ENTER` / `ctrl + shift + esc` into `CTRL+SHIFT+ESC`. */
export function normalizeKeyName(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('+')
}

/** `{ ok: true }` or `{ ok: false, reason }` for a key combination. */
export function checkKeyDanger(raw) {
  const combo = normalizeKeyName(raw)
  if (!combo) return { ok: false, reason: 'key needs `keys`, e.g. "CTRL+S"' }
  if (DANGEROUS_KEYS.includes(combo)) {
    return {
      ok: false,
      reason: `${combo} would take the screen away from the user; pass force:true only if they asked for it`,
    }
  }
  return { ok: true }
}

/** Build one step object, or return `{ error }`. */
function buildStep(raw, index, config, force) {
  const where = `steps[${index}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${where} must be an object like {"do":"click","at":{"nx":0.5,"ny":0.5}}` }
  }
  const wanted = String(raw.do ?? raw.action ?? '').trim().toLowerCase().replace(/[\s_-]/g, '')
  const kind = ALIASES[wanted]
  if (!kind) {
    return {
      error: `${where}.do "${raw.do ?? ''}" is not one of ${STEP_KINDS.join(', ')}`,
    }
  }

  const step = { do: kind }

  if (POINTED.has(kind)) {
    const parsed = parsePoint(raw.at, `${where}.at`)
    if (parsed.error) return { error: parsed.error }
    step.at = parsed.point
  }

  if (kind === 'drag') {
    const from = parsePoint(raw.at, `${where}.at`)
    if (from.error) return { error: from.error }
    const to = parsePoint(raw.to, `${where}.to`)
    if (to.error) return { error: `${where}.to is required for drag (${to.error})` }
    step.at = from.point
    step.to = to.point
  }

  if (kind === 'scroll') {
    step.wheel = clamp(raw.wheel ?? raw.notches, -30, 30, 3)
    if (step.wheel === 0) step.wheel = 3
  }

  if (kind === 'type') {
    const text = typeof raw.text === 'string' ? raw.text : ''
    if (!text) return { error: `${where}.text is required for type` }
    if (text.length > 4000) return { error: `${where}.text is too long (${text.length} chars, max 4000)` }
    step.text = text
    step.delayMs = clamp(raw.delayMs, 0, 500, 30)
    step.enter = raw.enter === true
  }

  if (kind === 'key') {
    const keys = typeof raw.keys === 'string' ? raw.keys : typeof raw.text === 'string' ? raw.text : ''
    const danger = checkKeyDanger(keys)
    if (!danger.ok && !force) return { error: `${where}.keys ${danger.reason}` }
    step.keys = normalizeKeyName(keys)
    step.repeat = clamp(raw.repeat, 1, 20, 1)
  }

  if (kind === 'wait') {
    step.ms = clamp(raw.ms, 1, 10_000, 400)
  }

  if (kind === 'focus') {
    const needle = typeof raw.needle === 'string' ? raw.needle.trim() : ''
    const handle = Number.parseInt(String(raw.handle ?? ''), 10)
    if (!needle && !Number.isFinite(handle)) {
      return { error: `${where} needs needle (part of the window title) or handle for focus` }
    }
    if (needle) step.needle = needle
    if (Number.isFinite(handle) && handle > 0) step.handle = handle
  }

  return { step }
}

/**
 * Turn `args` into `{ steps, warnings }`.
 *
 * `steps: [...]` chains several actions in one call (the fast path for
 * "type, press enter, then wait and look"); the flat fields build exactly one
 * step, which is what a simple "click here" call should use.
 */
export function normalizeSteps(args, config, log = () => {}) {
  const force = args?.force === true
  const source = Array.isArray(args?.steps) && args.steps.length > 0 ? args.steps : [{ ...args, do: args?.do }]

  if (!Array.isArray(source) || source.length === 0) {
    return { error: 'see_act needs at least one action: pass do:"click" with at:{…}, or a steps array' }
  }
  const maxSteps = config?.maxSteps ?? 8
  if (source.length > maxSteps) {
    return { error: `too many steps (${source.length}); split the call or raise maxSteps (now ${maxSteps})` }
  }

  const steps = []
  const warnings = []
  for (let i = 0; i < source.length; i += 1) {
    const built = buildStep(source[i], i, config, force)
    if (built.error) return { error: built.error }
    steps.push(built.step)
    if (built.step.do === 'scroll' && !source[i].at) {
      warnings.push(`steps[${i}].scroll has no at; it scrolls under the current cursor`)
    }
  }

  const estimate = estimatePlanMs(steps, config?.settleMs ?? 140)
  const cap = config?.maxPlanMs ?? 60_000
  if (estimate > cap) {
    return {
      error: `this plan would take about ${Math.round(estimate / 1000)}s (cap ${Math.round(cap / 1000)}s); split it`,
    }
  }
  if (source.length > 3) warnings.push(`${steps.length} steps in one call: the before/after frames only show the ends`)

  return { steps, warnings }
}

/** Rough wall-clock estimate, used only to refuse absurd plans. */
export function estimatePlanMs(steps, settleMs = 140) {
  let total = 400 // process start + P/Invoke compile
  for (const step of steps) {
    total += settleMs
    switch (step.do) {
      case 'click':
      case 'right':
      case 'middle':
        total += 260
        break
      case 'double':
        total += 340
        break
      case 'move':
        total += 90
        break
      case 'scroll':
        total += 120 + Math.abs(step.wheel ?? 3) * 40
        break
      case 'drag':
        total += 900
        break
      case 'type':
        // Each character costs its own delay plus the SendInput round trip.
        total += 260 + (step.text ?? '').length * ((step.delayMs ?? 30) + 4)
        break
      case 'key':
        total += 160 + (step.repeat ?? 1) * 80
        break
      case 'wait':
        total += step.ms ?? 400
        break
      case 'focus':
        total += 700
        break
      default:
        total += 200
    }
  }
  return total
}

/** `click nx=0.470 ny=0.440`, `type 24 chars`, ... for the text reply. */
export function describeStep(step) {
  switch (step.do) {
    case 'click':
    case 'double':
    case 'right':
    case 'middle':
    case 'move':
      return `${step.do} at ${describePoint(step.at)}`
    case 'drag':
      return `drag ${describePoint(step.at)} to ${describePoint(step.to)}`
    case 'scroll':
      return `scroll ${step.wheel > 0 ? 'down' : 'up'} ${Math.abs(step.wheel)} notches${step.at ? ` at ${describePoint(step.at)}` : ''}`
    case 'type': {
      const preview = step.text.length > 40 ? `${step.text.slice(0, 40)}…` : step.text
      return `type "${preview}"${step.enter ? ' then enter' : ''}`
    }
    case 'key':
      return `${step.keys}${step.repeat > 1 ? ` x${step.repeat}` : ''}`
    case 'wait':
      return `wait ${step.ms}ms`
    case 'focus':
      return `focus ${step.needle ? `"${step.needle}"` : `#${step.handle}`}`
    default:
      return step.do
  }
}

// ---- the stop flag -------------------------------------------------------
// A file, not a process signal: the user (or the model) can arm it from
// anywhere, and the next see_act call sees it even in a fresh process.

/** `{ stopped: boolean, reason?: string, at?: string }`. */
export function readStop(env = process.env) {
  const file = stopPath(env)
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return { stopped: true, reason: 'stop file is empty' }
    try {
      const parsed = JSON.parse(raw)
      return { stopped: true, reason: parsed.reason || 'stopped', at: parsed.at }
    } catch {
      return { stopped: true, reason: raw.slice(0, 200) }
    }
  } catch {
    return { stopped: false }
  }
}

/** Arm the flag. Returns the path it wrote. */
export function setStop(reason = 'stopped by the user', env = process.env) {
  const file = stopPath(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ reason, at: new Date().toISOString() }), 'utf8')
  return file
}

/** Disarm it. Returns true when a flag was actually there. */
export function clearStop(env = process.env) {
  const file = stopPath(env)
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}
