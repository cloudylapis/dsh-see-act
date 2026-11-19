/**
 * geometry.mjs — the one place that knows how a point in the model's request
 * becomes a pixel on a monitor.
 *
 * The rules that keep clicks honest:
 *
 *   1. **Normalised coordinates are the default** (0..1 of the captured
 *      region), because the image the model sees is scaled down and it has no
 *      reliable way to count pixels inside it. `x`/`y` physical pixels are
 *      accepted for the case where a tool result already printed them.
 *   2. **Rounding happens exactly once**, here and in `Resolve-Point` (PS),
 *      which use the same formula: `round(left + n * (width - 1))`.
 *   3. A resolution never guesses a monitor. `foreground` means the monitor the
 *      front window sits on, `cursor` the one the mouse is on; anything else
 *      is explicit.
 *
 * @module dsh-see-act/geometry
 */

/** Capture widths per quality step, in image pixels. */
export const QUALITY_WIDTHS = Object.freeze({ fast: 800, aim: 1280, read: 1600 })

/** Region selectors the PowerShell side understands. */
export const SCREEN_CHOICES = Object.freeze(['foreground', 'primary', 'cursor', 'all', 'virtual'])

/** Grid lines per axis (0.1 of the region). */
export const GRID_STEPS = 10

/** Target width for a quality name, falling back to `aim`. */
export function targetWidthFor(quality, fallback = 'aim') {
  const key = String(quality ?? '').trim().toLowerCase()
  return QUALITY_WIDTHS[key] ?? QUALITY_WIDTHS[fallback] ?? QUALITY_WIDTHS.aim
}

/** Normalise the `screen` argument; `undefined` means "let config decide". */
export function normalizeScreen(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = typeof raw === 'number' ? raw : String(raw).trim().toLowerCase()
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (SCREEN_CHOICES.includes(value)) return value
  return undefined
}

/**
 * Parse a point request.
 *
 * Accepts `{ nx, ny }` (0..1 of the region), `{ x, y }` (physical pixels),
 * or `{ cell: "row,col" }` (`"3,7"` is the middle of the 4th row, 8th column of
 * the grid). Returns `{ point }` or `{ error }`.
 */
export function parsePoint(raw, label = 'point') {
  if (raw === undefined || raw === null) {
    return { error: `${label} is required: pass {"nx":0..1,"ny":0..1}, {"x":px,"y":px} or {"cell":"row,col"}` }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${label} must be an object, got ${typeof raw}` }
  }

  if (typeof raw.cell === 'string' && raw.cell.trim() !== '') {
    const match = /^(\d+)\s*[,;:\s]\s*(\d+)$/.exec(raw.cell.trim())
    if (!match) return { error: `${label}.cell must look like "row,col" with 0..9 in both, e.g. "4,7"` }
    const row = Number(match[1])
    const col = Number(match[2])
    if (row >= GRID_STEPS || col >= GRID_STEPS) {
      return { error: `${label}.cell is 0..${GRID_STEPS - 1} on both axes, got ${row},${col}` }
    }
    return { point: { nx: (col + 0.5) / GRID_STEPS, ny: (row + 0.5) / GRID_STEPS } }
  }

  const nx = Number(raw.nx)
  const ny = Number(raw.ny)
  if (raw.nx !== undefined && raw.ny !== undefined && Number.isFinite(nx) && Number.isFinite(ny)) {
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      return { error: `${label}.nx/.ny are 0..1 (a fraction of the region), got ${nx},${ny}` }
    }
    return { point: { nx, ny } }
  }

  const x = Number(raw.x)
  const y = Number(raw.y)
  if (raw.x !== undefined && raw.y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
    return { point: { x: Math.round(x), y: Math.round(y) } }
  }

  return { error: `${label} needs either nx+ny (0..1) or x+y (physical pixels), or a cell` }
}

/** `nx=0.47 ny=0.44` or `x=1204 y=708` — the form used in every text reply. */
export function describePoint(point) {
  if (!point) return 'nowhere'
  if (point.nx !== undefined) return `nx=${point.nx.toFixed(3)} ny=${point.ny.toFixed(3)}`
  return `x=${point.x} y=${point.y}`
}

/** Resolve a parsed point to a physical pixel inside `region` (same maths as PS). */
export function pixelOf(point, region) {
  if (!point || !region) return null
  if (point.nx !== undefined) {
    return {
      x: Math.round(region.left + point.nx * (region.width - 1)),
      y: Math.round(region.top + point.ny * (region.height - 1)),
    }
  }
  return { x: point.x, y: point.y }
}

/** `"1 image px = 2 screen px"` (or the identity when nothing was scaled). */
export function scaleText(region, image) {
  if (!region || !image || !image.width) return 'image scale unknown'
  const ratio = region.width / image.width
  if (!Number.isFinite(ratio) || ratio <= 0) return 'image scale unknown'
  if (Math.abs(ratio - 1) < 0.01) return '1 image px = 1 screen px'
  return `1 image px = ${ratio.toFixed(2)} screen px`
}

/** `monitor 1  2560x1600 @ 0,0` and friends. */
export function describeRegion(region) {
  if (!region) return 'region unknown'
  const label = region.label ? `${region.label}` : `monitor ${region.index ?? '?'}`
  return `${label}  ${region.width}x${region.height}`
}

/** How much of the region changed, in percent, with one decimal. */
export function changedText(changed) {
  const value = Number(changed)
  if (!Number.isFinite(value) || value <= 0) return 'no change'
  const percent = value * 100
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}% changed`
}
