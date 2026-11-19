/**
 * seecompat.mjs — the two optional things this plugin borrows from dsh-see-now.
 *
 * dsh-see-now is a *peer*, never a dependency: it may be missing, older, or
 * installed somewhere strange. Everything here degrades to "do nothing and say
 * so in the log", because the plugin still has to work when the other half of
 * the pair is absent.
 *
 *   - **the chat stream** (`dsh-see-now/chat`) — the same `chat.jsonl` the
 *     floating window renders, so an action can announce itself in the bubble
 *     the user is already looking at;
 *   - **the floating window's pid** (`dsh-see-now/window:pidPath()`) — so a
 *     click that lands under the always-on-top window can step around it.
 *
 * @module dsh-see-act/seecompat
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { dshHome } from './config.mjs'

const resolved = new Map()

/** The active profile directory: `DSH_PROFILE_DIR`, else `$DSH_HOME/profiles/$DSH_PROFILE`. */
export function profileDir(env = process.env) {
  if (env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR
  return path.join(dshHome(env), 'profiles', env.DSH_PROFILE || 'desktop')
}

/**
 * Resolve the see-now entry points for this profile (once per profile).
 *
 * Returns `{ dir, chat, window, error }`; `chat` and `window` are promise-ish
 * loaders (`load(key)`) so an import only happens when a tool really needs it.
 */
export function seeNow(env = process.env) {
  const dir = profileDir(env)
  const cached = resolved.get(dir)
  if (cached) return cached

  const entry = { dir, files: {}, modules: {}, error: null }
  let req
  try {
    req = createRequire(path.join(dir, 'package.json'))
  } catch (error) {
    entry.error = `no profile package.json at ${dir}: ${error.message}`
    resolved.set(dir, entry)
    return entry
  }

  for (const key of ['chat', 'window']) {
    try {
      entry.files[key] = req.resolve(`dsh-see-now/${key}`)
    } catch (error) {
      entry.error = entry.error || `dsh-see-now/${key}: ${error.message}`
    }
  }

  entry.load = async (key) => {
    if (entry.modules[key] !== undefined) return entry.modules[key]
    const file = entry.files[key]
    if (!file) {
      entry.modules[key] = null
      return null
    }
    try {
      entry.modules[key] = await import(pathToFileURL(file).href)
    } catch (error) {
      entry.error = entry.error || `${key}: ${error.message}`
      entry.modules[key] = null
    }
    return entry.modules[key]
  }

  resolved.set(dir, entry)
  return entry
}

/** True when the shared chat stream can be written to. */
export async function chatReady(env = process.env) {
  return Boolean(await seeNow(env).load('chat'))
}

/**
 * The see-now floating window's pid, or 0.
 *
 * Read from the pid file (see-now's own `pidPath()` when reachable, else the
 * documented default) rather than by scanning processes: a stale pid must read
 * as "no window" instead of as a rectangle somewhere on the desktop.
 */
export async function overlayPid(env = process.env) {
  const entry = seeNow(env)
  const windowModule = await entry.load('window')
  let file = path.join(dshHome(env), 'see-now-window.pid')
  if (windowModule && typeof windowModule.pidPath === 'function') {
    try {
      file = windowModule.pidPath()
    } catch {
      /* keep the default */
    }
  }

  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) return 0
  try {
    process.kill(pid, 0)
  } catch {
    return 0 // stale file: the process is gone
  }
  return pid
}

/**
 * Write one grey line into the see-now chat stream ("I clicked at x,y").
 *
 * Grey `meta` lines are diagnostics: they show up in the window without being
 * spoken, and without pretending to be something the assistant said.
 */
export async function narrate(text, { env = process.env, log = () => {} } = {}) {
  const chat = await seeNow(env).load('chat')
  if (!chat || typeof chat.appendSpoken !== 'function') return false
  try {
    chat.appendSpoken('meta', String(text), { speak: false, env })
    return true
  } catch (error) {
    log(`narrate failed: ${error.message}`)
    return false
  }
}

/** Say something to the user: one bubble in the float window, spoken once. */
export async function say(text, { env = process.env, log = () => {} } = {}) {
  const chat = await seeNow(env).load('chat')
  if (!chat || typeof chat.appendSpoken !== 'function') return false
  try {
    chat.appendSpoken('assistant', String(text), { speak: true, env })
    return true
  } catch (error) {
    log(`say failed: ${error.message}`)
    return false
  }
}

/** Warm the modules once at plugin start so the first action is not the first import. */
export async function primeSeeNow(env = process.env) {
  const entry = seeNow(env)
  await entry.load('chat')
  await entry.load('window')
  return entry
}
