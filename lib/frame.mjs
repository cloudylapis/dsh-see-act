/**
 * frame.mjs — glue between one PowerShell run and one tool result.
 *
 * Responsibilities, in order of importance:
 *
 *   1. give the run a temporary directory (frames are handed to the attachment
 *      service and then deleted from disk — the conversation, not the
 *      filesystem, is where they live);
 *   2. turn PNG files into attachment references the renderer can show;
 *   3. write the text answer, which is the part that survives compression and
 *      the only part a later turn can still read.
 *
 * @module dsh-see-act/frame
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

import { frameRoot } from './config.mjs'
import { changedText, describeRegion, scaleText } from './geometry.mjs'

/** Find an optional service the way see-now does: `ctx.get` first, then `ctx[key]`. */
export function serviceOf(ctx, key) {
  try {
    const service = ctx.get(key)
    if (service) return service
  } catch {
    /* not available through get() */
  }
  try {
    return ctx?.[key] ?? null
  } catch {
    return null
  }
}

/** Create a throwaway directory for one run's PNGs. */
export async function makeOutDir(config, env = process.env, kind = 'run') {
  const root = frameRoot(env)
  await fsp.mkdir(root, { recursive: true })
  return fsp.mkdtemp(path.join(root, `${kind}-`))
}

/** Remove a run's directory; failures are not worth reporting. */
export async function dropOutDir(dir) {
  if (!dir) return
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** Read `result.frames[].path` files and register them as image attachments. */
export async function attachFrames(ctx, frames, namePrefix = 'see-act') {
  const service = serviceOf(ctx, 'attachments')
  if (!service || typeof service.saveImage !== 'function') return []
  const stamp = Date.now()
  const attachments = []
  for (const frame of frames ?? []) {
    try {
      const data = await fsp.readFile(frame.path)
      const name = `${namePrefix}-${frame.role || 'frame'}-${stamp}-${attachments.length + 1}.png`
      // `.call(service)` keeps `this` pointing at the service: saveImage reads
      // its own compression settings off `this`.
      const ref = await service.saveImage.call(service, { data, mediaType: 'image/png', name })
      if (ref) attachments.push(ref)
    } catch {
      /* a missing frame costs an image, not the whole call */
    }
  }
  return attachments
}

/** `monitor 1  2560x1600 @ 0,0  (2560x1600 on screen)` plus the image scale. */
export function regionLine(result) {
  const region = result?.region
  const image = result?.image
  const parts = [describeRegion(region)]
  if (!image?.width) return parts.join(' · (no frames requested)')
  parts.push(`image ${image.width}x${image.height}`)
  parts.push(scaleText(region, image))
  return parts.join(' · ')
}

/** `cursor 1437,701 · foreground "…" #197366`. */
export function whereLine(result) {
  const parts = []
  if (result?.cursor) parts.push(`cursor ${result.cursor.x},${result.cursor.y}`)
  if (result?.foreground) {
    const title = String(result.foreground.title || '').replace(/\s+/g, ' ').trim()
    const handle = result.foreground.handle ? ` #${result.foreground.handle}` : ''
    parts.push(title ? `foreground "${title}"${handle}` : `foreground untitled${handle}`)
  }
  return parts.join(' · ')
}

/** The float-window sentence: where it is, and whether it was stepped around. */
export function overlayLine(result) {
  const overlay = result?.overlay
  if (!overlay) return ''
  const rect = `${overlay.left},${overlay.top} ${overlay.width}x${overlay.height}`
  if (result.dodged) return `see-now float ${rect}: hidden while the action ran, then restored`
  return `see-now float ${rect} (always-on-top: clicks under it hit the float, not the app)`
}

/** Build the text half of a tool result. `notes` are extra lines for this tool. */
export function buildText(result, { header, steps = [], notes = [], warnings = [] } = {}) {
  const lines = []
  if (header) lines.push(header)
  lines.push(regionLine(result))
  const where = whereLine(result)
  if (where) lines.push(where)

  for (const [index, step] of steps.entries()) {
    const change = step.changed !== undefined ? ` (${changedText(step.changed)})` : ''
    const timing = step.ms !== undefined ? ` ${step.ms}ms` : ''
    lines.push(`${index + 1}. ${step.text}${timing}${change}`)
  }
  if (steps.length > 0 && result?.changed !== undefined) {
    lines.push(`total ${changedText(result.changed)}${boxText(result.changedBox)}`)
  }

  const overlayText = overlayLine(result)
  if (overlayText) lines.push(overlayText)

  for (const note of notes) lines.push(note)
  if (result?.blackScreen) {
    lines.push('warning: the capture came back all black (protected content, or the desktop was locked)')
  }
  for (const warning of [...(result?.warnings ?? []), ...warnings]) {
    if (warning) lines.push(`warning: ${warning}`)
  }
  return lines.join('\n')
}

function boxText(box) {
  if (!box) return ''
  const asPercent = (value) => (Number(value) * 100).toFixed(0)
  return ` · box nx ${asPercent(box.nx)}-${asPercent(Number(box.nx) + Number(box.nw))}% ny ${asPercent(box.ny)}-${asPercent(Number(box.ny) + Number(box.nh))}%`
}

/**
 * Last-resort capture for screens GDI cannot see (hardware overlays, protected
 * video): one Desktop-Duplication frame through ffmpeg.
 *
 * It is deliberately un-annotated and always the **primary monitor**: this is a
 * "can I see anything at all" frame, not a precision tool.
 */
export async function fallbackFrame({ outDir, width = 1280, env = process.env, timeoutMs = 20_000 } = {}) {
  const ffmpeg = env.DSH_FFMPEG_PATH || 'ffmpeg'
  const out = path.join(outDir, 'fallback.png')
  const scale = width > 0 ? `,scale=${Math.round(width)}:-2` : ''
  const filter = `ddagrab=0:output_fmt=bgra,hwdownload,format=bgra${scale}`
  try {
    await new Promise((resolve, reject) => {
      execFile(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex', filter, '-frames:v', '1', out],
        { timeout: timeoutMs, windowsHide: true },
        (error) => (error ? reject(error) : resolve()),
      )
    })
    const stat = await fsp.stat(out)
    return stat.size > 0 ? out : null
  } catch {
    return null
  }
}

/** `~`-shortened path for logs. */
export function shortPath(file) {
  const home = os.homedir()
  return file && file.startsWith(home) ? `~${file.slice(home.length)}` : file
}

/** Best-effort cleanup of old run directories (only when keepFrames === 0). */
export async function sweepFrameRoot(env = process.env, keep = 6) {
  const root = frameRoot(env)
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
  if (dirs.length <= keep) return
  const stats = await Promise.all(
    dirs.map(async (dir) => ({ dir, mtime: await fsp.stat(dir).then((s) => s.mtimeMs, () => 0) })),
  )
  stats.sort((a, b) => b.mtime - a.mtime)
  for (const { dir } of stats.slice(keep)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** True when a PNG path exists and is non-empty. */
export function frameExists(dir, name) {
  try {
    return fs.statSync(path.join(dir, name)).size > 0
  } catch {
    return false
  }
}
