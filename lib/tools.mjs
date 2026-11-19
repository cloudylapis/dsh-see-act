/**
 * tools.mjs — the four tools the model actually sees.
 *
 * Shape note: these are registered through `ctx.tools.register` with a *full*
 * JSON Schema for `parameters` (the way dsh-plugin-real-input does it), and a
 * `text`/`images`/`meta` result the way `see_now` returns one. Both shapes are
 * proven against this runtime; do not mix them up.
 *
 * @module dsh-see-act/tools
 */

import { canAct, loadConfig } from './config.mjs'
import { describePoint, normalizeScreen, parsePoint, targetWidthFor } from './geometry.mjs'
import { clearStop, describeStep, normalizeSteps, readStop, setStop } from './act.mjs'
import { actOnScreen, lookScreen, probeDesktop, zoomScreen } from './win32ps.mjs'
import {
  attachFrames,
  buildText,
  dropOutDir,
  fallbackFrame,
  makeOutDir,
  sweepFrameRoot,
} from './frame.mjs'
import { narrate, overlayPid, say } from './seecompat.mjs'

const content = (body) => [{ type: 'text', text: body }]

/** Every result: a rendered text answer, optional images, and the raw facts. */
const TOOL_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', description: 'What happened, in words the next turn can still read.' },
    images: { type: 'array', description: 'Screenshots, already attached.', items: { type: 'object' } },
    meta: { type: 'object', description: 'Screen geometry, steps, warnings.' },
  },
}

/** A point in any of the three forms `parsePoint` understands. */
const pointSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Where to aim. Prefer {"nx":0..1,"ny":0..1} (fractions of the frame — the image is scaled, so fractions ' +
    'are the only numbers that stay true), {"x":px,"y":px} for physical pixels, or {"cell":"row,col"}.',
  properties: {
    nx: { type: 'number', description: '0 left .. 1 right of the captured region.' },
    ny: { type: 'number', description: '0 top .. 1 bottom of the captured region.' },
    x: { type: 'integer', description: 'Physical screen x (not image x).' },
    y: { type: 'integer', description: 'Physical screen y (not image y).' },
    cell: { type: 'string', description: 'Grid cell "row,col", each 0..9, e.g. "4,7" = middle of row 4, col 7.' },
  },
}

const screenSchema = {
  type: 'string',
  description:
    'Which monitor: "foreground" (default — the one the front window is on), "primary", "cursor", ' +
    '"all"/"virtual" (every monitor in one frame), or a monitor index like "1".',
}

const saySchema = {
  type: 'string',
  description:
    'What the user hears in the floating window. Your normal reply does not reach it — only `say` does. ' +
    'Two or three sentences, once, when it actually matters.',
}

/** Build a registry-ready definition (same assembly as dsh-plugin-real-input). */
function tool(spec) {
  const definition = {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: TOOL_OUTPUT,
      render: (_args, value) => [
        ...(value.images ?? []).map((attachment) => ({ type: 'image', attachment })),
        { type: 'text', text: value.text },
      ],
    },
    async execute(args, exec) {
      return spec.execute(args ?? {}, exec)
    },
  }
  if (spec.timeoutMs) definition.timeoutMs = spec.timeoutMs
  if (spec.presentCall) definition.presentCall = (args) => spec.presentCall(args)
  return definition
}

/** Attach the image size the text needs, from whichever frame was written. */
function withImage(result) {
  const frame = (result.frames ?? [])[0]
  return frame ? { ...result, image: { width: frame.width, height: frame.height } } : result
}

/** Resolve the whole see-act runtime for one call. */
function configFor(env, log) {
  return loadConfig(env, log)
}

export function createToolDefinitions({ ctx = null, env = process.env, log = () => {} } = {}) {
  const configForCall = () => configFor(env, log)

  const lookTool = tool({
    name: 'see_look',
    description:
      'Take one annotated screenshot of the screen right now and return it in about a second. No waiting, no ' +
      'blocking. Every frame carries a 0.1 grid (labels at 0, 0.5 and 1), a red crosshair where you aim, a red box ' +
      'around the see-now floating window, and a 3x zoom inset of the crosshair corner.\n\n' +
      'Use it when: you need to find something before acting, you want to confirm a click landed, or the number of ' +
      'monitors/windows is unclear. Then aim with `see_act` using nx/ny from this frame.\n\n' +
      'Do NOT read pixel numbers off the image — it is scaled down. Use nx/ny, or pass `at` here and read the ' +
      'pixel coordinates in the text answer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        at: { ...pointSchema, description: pointSchema.description + ' Draws the crosshair and the zoom inset there.' },
        quality: {
          type: 'string',
          enum: ['fast', 'aim', 'read'],
          description: 'Image width: fast 800 (cheap), aim 1280 (default), read 1600 (small text).',
        },
        screen: screenSchema,
        grid: { type: 'boolean', description: 'Draw the 0.1 grid (default true).' },
        say: saySchema,
      },
    },
    async execute(args) {
      const config = configForCall()
      let at = null
      if (args.at !== undefined) {
        const parsed = parsePoint(args.at, 'at')
        if (parsed.error) throw new Error(parsed.error)
        at = parsed.point
      }
      const screen = normalizeScreen(args.screen) ?? config.screen
      const targetWidth = targetWidthFor(args.quality || config.quality)
      const outDir = await makeOutDir(config, env, 'look')
      try {
        const result = withImage(
          await lookScreen({ outDir, targetWidth, crosshair: at, overlayPid: await overlayPid(env), screen }),
        )
        const images = await attachFrames(ctx, result.frames, 'see-look')
        const notes = []
        if (at) notes.push(`aimed at ${describePoint(at)}`)
        if (args.say) await say(args.say, { env, log })
        if (config.narrate && !args.say) {
          await narrate(at ? `看了一下屏幕（准星 ${describePoint(at)}）` : '看了一下屏幕', { env, log })
        }
        return {
          text: buildText(result, { header: 'LOOK: the screen right now', notes }),
          images,
          meta: { screen: result.screen, region: result.region, image: result.image, overlay: result.overlay },
        }
      } finally {
        await dropOutDir(outDir)
        await sweepFrameRoot(env, 6)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Look at the screen', kind: 'other', rawInput: '' }),
  })

  const zoomTool = tool({
    name: 'see_zoom',
    description:
      'Magnify one spot at native pixels (default 3x of a 320px square) to read small text, check a menu item, or ' +
      'verify that a target really is what you think before clicking it. Needs `at`; everything else has a default.\n\n' +
      'This is the tool for "is that button really at 0.47, 0.44?" — the answer is a 960x960 crop with a crosshair ' +
      'at the exact point, and the physical pixel in the text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['at'],
      properties: {
        at: pointSchema,
        factor: { type: 'integer', description: 'Magnification 2..8 (default 3).' },
        size: { type: 'integer', description: 'Source square in screen px, 80..1200 (default 320).' },
        screen: screenSchema,
        say: saySchema,
      },
    },
    async execute(args) {
      const config = configForCall()
      const parsed = parsePoint(args.at, 'at')
      if (parsed.error) throw new Error(parsed.error)
      const screen = normalizeScreen(args.screen) ?? config.screen
      const outDir = await makeOutDir(config, env, 'zoom')
      try {
        const result = withImage(
          await zoomScreen({
            outDir,
            at: parsed.point,
            factor: args.factor ?? 3,
            size: args.size ?? 320,
            screen,
          }),
        )
        const images = await attachFrames(ctx, result.frames, 'see-zoom')
        if (args.say) await say(args.say, { env, log })
        const where = result.at ? ` at ${result.at.x},${result.at.y}` : ''
        return {
          text: buildText(result, {
            header: `ZOOM ${result.factor}x${where}`,
            notes: result.crop ? [`crop ${result.crop.width}x${result.crop.height} screen px from ${result.crop.x},${result.crop.y}`] : [],
          }),
          images,
          meta: { region: result.region, at: result.at, crop: result.crop, factor: result.factor },
        }
      } finally {
        await dropOutDir(outDir)
        await sweepFrameRoot(env, 6)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Zoom into the screen', kind: 'other', rawInput: '' }),
  })

  const actTool = tool({
    name: 'see_act',
    description:
      'Move the REAL mouse and type REAL keys, and get before+after screenshots back in the same call — that ' +
      'pairing is the point: you never have to guess whether it worked.\n\n' +
      'One call = one action (or up to 8 chained steps when the sequence is obvious: click a field, type, press ' +
      'enter, wait, look). Aim with `at` as nx/ny fractions of the frame from `see_look` — the image is scaled, so ' +
      'pixels read off it are wrong; nx/ny are not.\n\n' +
      'The after-frame carries: a crosshair where the pointer ended up, a 3x zoom of that spot (so you can see ' +
      'whether it landed on the control), the float-window rectangle, and the fraction of the screen that changed. ' +
      '"nothing changed" is a real answer — read it as your click did nothing, not as an error.\n\n' +
      'When the target sits under the see-now floating window, the window is hidden for the duration of the step ' +
      'and put back afterwards (the text says so). Pass `say` when the user should hear what you are doing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        do: {
          type: 'string',
          enum: ['click', 'double', 'right', 'middle', 'move', 'scroll', 'drag', 'type', 'key', 'wait', 'focus'],
          description: 'The action. Omit only when `steps` is given.',
        },
        at: pointSchema,
        to: { ...pointSchema, description: 'End point — only for do:"drag".' },
        text: { type: 'string', description: 'Text to type — only for do:"type". Unicode works (Chinese included).' },
        keys: { type: 'string', description: 'Key combo like "CTRL+S", "ENTER", "ALT+TAB" — only for do:"key".' },
        wheel: { type: 'integer', description: 'Scroll notches, negative = up — only for do:"scroll" (default 3).' },
        ms: { type: 'integer', description: 'Milliseconds to wait — only for do:"wait".' },
        enter: { type: 'boolean', description: 'With do:"type": press Enter afterwards.' },
        repeat: { type: 'integer', description: 'With do:"key": how many times (1..20).' },
        needle: { type: 'string', description: 'With do:"focus": part of the window title to bring to the front.' },
        handle: { type: 'integer', description: 'With do:"focus": a window handle from an earlier result.' },
        steps: {
          type: 'array',
          description: 'Several actions in one call (max 8). Each entry takes the same fields as the top level.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['do'],
            properties: {
              do: {
                type: 'string',
                enum: ['click', 'double', 'right', 'middle', 'move', 'scroll', 'drag', 'type', 'key', 'wait', 'focus'],
              },
              at: pointSchema,
              to: pointSchema,
              text: { type: 'string' },
              keys: { type: 'string' },
              wheel: { type: 'integer' },
              ms: { type: 'integer' },
              enter: { type: 'boolean' },
              repeat: { type: 'integer' },
              needle: { type: 'string' },
              handle: { type: 'integer' },
            },
          },
        },
        quality: {
          type: 'string',
          enum: ['fast', 'aim', 'read'],
          description: 'Frame width: fast 800, aim 1280 (default), read 1600.',
        },
        screen: screenSchema,
        shots: {
          type: 'string',
          enum: ['both', 'after', 'none'],
          description: 'Which frames to return (default both). Use "none" for fire-and-forget steps to save tokens.',
        },
        zoomInset: { type: 'boolean', description: 'Draw the 3x inset in the after-frame (default true).' },
        settleMs: { type: 'integer', description: 'Quiet wait after each step before the frame is taken (default 140).' },
        say: saySchema,
        force: { type: 'boolean', description: 'Allow key combos that would take the screen away (Win, Alt+F4, Alt+Tab); only when the user asked for it.' },
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      const config = configForCall()
      const stop = readStop(env)
      if (stop.stopped) {
        throw new Error(
          `see-act is stopped (${stop.reason}); the user must re-arm it with see_stop({action:"clear"}) before anything moves`,
        )
      }
      if (!canAct(config)) {
        throw new Error('see-act is configured readonly (mode:"readonly"); see_look/see_zoom still work')
      }

      const normalized = normalizeSteps(args, config, log)
      if (normalized.error) throw new Error(normalized.error)
      const { steps, warnings } = normalized

      const screen = normalizeScreen(args.screen) ?? config.screen
      const shots = args.shots ?? config.shots
      const settleMs = Number.isFinite(args.settleMs) ? Math.max(0, Math.min(3000, args.settleMs)) : config.settleMs
      const zoomInset = args.zoomInset === undefined ? config.zoomInset : args.zoomInset === true
      const quality = args.quality || config.quality
      const overlay = await overlayPid(env)
      const outDir = await makeOutDir(config, env, 'act')
      const started = Date.now()

      try {
        const plan = {
          action: 'act',
          screen,
          outDir,
          targetWidth: targetWidthFor(quality),
          steps: steps.map(toPlanStep),
          settleMs,
          shots,
          zoomInset: zoomInset && shots !== 'none',
          overlayPid: overlay,
          dodge: config.dodge,
          label: `ACT ${steps.map((step) => step.do).join(', ')}`,
        }
        const result = withImage(await actOnScreen(plan, { timeoutMs: 120_000 }))
        const extra = []

        // A black frame means GDI saw nothing useful (protected video, locked
        // desktop). One ffmpeg frame at least tells the model what is there.
        if (config.captureFallback && shots !== 'none' && result.blackScreen) {
          const fallback = await fallbackFrame({ outDir, width: plan.targetWidth, env })
          if (fallback) {
            result.frames = [{ role: 'fallback', path: fallback, width: plan.targetWidth, height: 0 }, ...result.frames]
            extra.push('captured via ffmpeg (Desktop Duplication) because the GDI frame was black')
          }
        }

        const images = await attachFrames(ctx, result.frames, 'see-act')
        const lines = result.steps.map((step, index) => ({
          text: describeStep(steps[index]),
          changed: step.changed,
          ms: step.ms,
        }))

        if (args.say) await say(args.say, { env, log })
        else if (config.narrate) {
          await narrate(`点击/输入：${steps.map((step) => describeStep(step)).join(' → ')}`, { env, log })
        }

        const text = buildText(result, {
          header: `ACT ${steps.length === 1 ? describeStep(steps[0]) : `${steps.length} steps`} in ${Date.now() - started}ms`,
          steps: lines,
          notes: extra,
          warnings,
        })
        return {
          text,
          images,
          meta: {
            screen: result.screen,
            region: result.region,
            image: result.image,
            overlay: result.overlay,
            dodged: result.dodged,
            steps: result.steps,
            changed: result.changed,
            changedBox: result.changedBox,
            warnings: [...(result.warnings ?? []), ...warnings],
          },
        }
      } finally {
        await dropOutDir(outDir)
        await sweepFrameRoot(env, 6)
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.do ? `see-act: ${args.do}` : 'see-act: act',
      kind: 'other',
      rawInput: '',
    }),
  })

  const stopTool = tool({
    name: 'see_stop',
    description:
      'Emergency brake for see-act. `action:"stop"` writes a flag so the very next see_act refuses to move ' +
      'anything; `"clear"` removes it; `"status"` reports whether it is armed and which monitor the next action ' +
      'would use. Use it the moment the user says stop, or when you are not sure what you are about to touch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['stop', 'clear', 'status'], description: 'Default "status".' },
        reason: { type: 'string', description: 'Why it was stopped (kept in the flag file).' },
      },
    },
    timeoutMs: 30_000,
    async execute(args) {
      const config = configForCall()
      const action = String(args.action || 'status').toLowerCase()
      if (action === 'stop') {
        const reason = args.reason || 'stopped from see_stop'
        const file = setStop(reason, env)
        return {
          text: `SEE-ACT STOPPED — ${reason}. Flag written to ${file}; see_act now refuses to run until "clear".`,
          meta: { stop: { stopped: true, reason }, file },
        }
      }
      if (action === 'clear') {
        const had = clearStop(env)
        return { text: had ? 'see-act re-armed: clicks and keys are allowed again.' : 'see-act was not stopped; nothing to clear.' }
      }

      const stop = readStop(env)
      const probe = await probeDesktop({ overlayPid: await overlayPid(env), screen: config.screen })
      const screens = (probe.screens ?? []).map((monitor) => `  ${monitor.index}: ${monitor.width}x${monitor.height} @ ${monitor.left},${monitor.top}${monitor.primary ? ' (primary)' : ''}`)
      const float = probe.overlay
        ? `${probe.overlay.left},${probe.overlay.top} ${probe.overlay.width}x${probe.overlay.height} — hidden while an action would land on it`
        : 'not open'
      const lines = [
        stop.stopped ? `stopped: ${stop.reason}` : 'armed: see_act may act',
        `mode: ${config.mode} · dodge: ${config.dodge}`,
        `next screen: ${probe.region?.label ?? 'unknown'}`,
        `cursor: ${probe.cursor?.x},${probe.cursor?.y}`,
        `foreground: "${probe.foreground?.title ?? ''}" #${probe.foreground?.handle ?? 0}`,
        `see-now float: ${float}`,
        screens.length > 0 ? 'monitors:' : 'monitors: none reported',
        ...screens,
      ]
      return {
        text: lines.join('\n'),
        meta: {
          stop,
          config: { mode: config.mode, dodge: config.dodge, quality: config.quality },
          overlay: probe.overlay ?? null,
        },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'see-act stop / status', kind: 'other', rawInput: '' }),
  })

  return [lookTool, zoomTool, actTool, stopTool]
}

/** Strip the tool-level fields a step does not own before it reaches PowerShell. */
function toPlanStep(step) {
  const out = { do: step.do }
  if (step.at) out.at = step.at
  if (step.to) out.to = step.to
  if (step.text !== undefined) out.text = step.text
  if (step.keys !== undefined) out.keys = step.keys
  if (step.wheel !== undefined) out.wheel = step.wheel
  if (step.ms !== undefined) out.ms = step.ms
  if (step.enter !== undefined) out.enter = step.enter
  if (step.repeat !== undefined) out.repeat = step.repeat
  if (step.needle !== undefined) out.needle = step.needle
  if (step.handle !== undefined) out.handle = step.handle
  if (step.delayMs !== undefined) out.delayMs = step.delayMs
  return out
}
