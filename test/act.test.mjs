import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  clearStop,
  describeStep,
  estimatePlanMs,
  normalizeKeyName,
  normalizeSteps,
  readStop,
  setStop,
} from '../lib/act.mjs'

const CONFIG = { maxSteps: 8, maxPlanMs: 60_000, settleMs: 140 }

test('one flat call becomes one step', () => {
  const { steps, warnings } = normalizeSteps({ do: 'click', at: { nx: 0.5, ny: 0.5 } }, CONFIG)
  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0], { do: 'click', at: { nx: 0.5, ny: 0.5 } })
  assert.deepEqual(warnings, [])
})

test('verbs accept the aliases a model actually writes', () => {
  const cases = [
    ['tap', 'click'],
    ['doubleclick', 'double'],
    ['right click', 'right'],
    ['hover', 'move'],
    ['wheel', 'scroll'],
    ['paste', 'type'],
    ['sleep', 'wait'],
    ['activate', 'focus'],
  ]
  for (const [alias, kind] of cases) {
    const args =
      kind === 'click' || kind === 'double' || kind === 'right' || kind === 'move' || kind === 'scroll'
        ? { do: alias, at: { nx: 0.5, ny: 0.5 } }
        : kind === 'type'
          ? { do: alias, text: 'hi' }
          : kind === 'wait'
            ? { do: alias, ms: 50 }
            : { do: alias, needle: 'Notepad' }
    const result = normalizeSteps(args, CONFIG)
    assert.equal(result.error, undefined, `${alias}: ${result.error}`)
    assert.equal(result.steps[0].do, kind, `${alias} -> ${kind}`)
  }
})

test('an unknown verb lists the real ones', () => {
  const { error } = normalizeSteps({ do: 'teleport', at: { nx: 0.5, ny: 0.5 } }, CONFIG)
  assert.match(error, /is not one of click, double, right/)
})

test('steps run in order and type/key keep their arguments', () => {
  const { steps } = normalizeSteps(
    {
      steps: [
        { do: 'click', at: { nx: 0.2, ny: 0.3 } },
        { do: 'text', text: '你好', enter: true },
        { do: 'press', keys: 'ctrl+s' },
      ],
    },
    CONFIG,
  )
  assert.deepEqual(steps[0].do, 'click')
  assert.equal(steps[1].do, 'type')
  assert.equal(steps[1].text, '你好')
  assert.equal(steps[1].enter, true)
  assert.equal(steps[2].do, 'key')
  assert.equal(steps[2].keys, 'CTRL+S')
})

test('values are clamped instead of trusted', () => {
  const { steps } = normalizeSteps(
    {
      steps: [
        { do: 'scroll', wheel: 99, at: { nx: 0.5, ny: 0.5 } },
        { do: 'wait', ms: 999_999 },
        { do: 'key', keys: 'F5', repeat: 500 },
      ],
    },
    CONFIG,
  )
  assert.equal(steps[0].wheel, 30)
  assert.equal(steps[1].ms, 10_000)
  assert.equal(steps[2].repeat, 20)
})

test('key combos that would steal the screen need force', () => {
  for (const keys of ['ctrl+alt+del', 'ALT+F4', 'win+r', 'alt+tab']) {
    const blocked = normalizeSteps({ do: 'key', keys }, CONFIG)
    assert.match(blocked.error, /take the screen away/, keys)
    const forced = normalizeSteps({ do: 'key', keys, force: true }, CONFIG)
    assert.equal(forced.error, undefined, keys)
  }
})

test('key names are normalised the way Windows spells them', () => {
  assert.equal(normalizeKeyName('ctrl + shift + esc'), 'CTRL+SHIFT+ESC')
  assert.equal(normalizeKeyName(' enter '), 'ENTER')
  assert.equal(normalizeKeyName(''), '')
})

test('missing essentials are refused with a usable message', () => {
  assert.match(normalizeSteps({ do: 'click' }, CONFIG).error, /at is required/)
  assert.match(normalizeSteps({ do: 'type' }, CONFIG).error, /text is required/)
  assert.match(normalizeSteps({ do: 'drag', at: { nx: 0.1, ny: 0.1 } }, CONFIG).error, /to/)
  assert.match(normalizeSteps({ do: 'focus' }, CONFIG).error, /needle/)
  assert.match(normalizeSteps({}, CONFIG).error, /is not one of/)
  assert.match(normalizeSteps({ do: 'type', text: 'x'.repeat(4001) }, CONFIG).error, /too long/)
})

test('step count and total time are capped', () => {
  const many = Array.from({ length: 9 }, () => ({ do: 'click', at: { nx: 0.5, ny: 0.5 } }))
  assert.match(normalizeSteps({ steps: many }, CONFIG).error, /too many steps/)

  const slow = normalizeSteps({ do: 'type', text: 'a'.repeat(4000) }, { ...CONFIG, maxPlanMs: 5000 })
  assert.match(slow.error, /would take about/)
})

test('long chains warn that the frames only show the ends', () => {
  const steps = Array.from({ length: 4 }, () => ({ do: 'wait', ms: 10 }))
  const { warnings } = normalizeSteps({ steps }, CONFIG)
  assert.ok(warnings.some((w) => /only show the ends/.test(w)))
})

test('the time estimate is monotone and roughly matches reality', () => {
  const click = estimatePlanMs([{ do: 'click', at: { nx: 0.5, ny: 0.5 } }], 140)
  assert.ok(click > 600 && click < 1200, `click estimate ${click}`)

  const typed = estimatePlanMs([{ do: 'type', text: 'abc', delayMs: 30 }], 0)
  assert.equal(typed, 400 + 260 + 3 * 34)

  const both = estimatePlanMs(
    [
      { do: 'click', at: { nx: 0.5, ny: 0.5 } },
      { do: 'type', text: 'abc', delayMs: 30 },
    ],
    140,
  )
  assert.ok(both > click)
})

test('steps print the way the narration reads', () => {
  assert.equal(describeStep({ do: 'click', at: { nx: 0.5, ny: 0.5 } }), 'click at nx=0.500 ny=0.500')
  assert.equal(describeStep({ do: 'type', text: 'abc', enter: true }), 'type "abc" then enter')
  assert.equal(describeStep({ do: 'key', keys: 'CTRL+S', repeat: 1 }), 'CTRL+S')
  assert.equal(describeStep({ do: 'scroll', wheel: -2 }), 'scroll up 2 notches')
  assert.equal(describeStep({ do: 'wait', ms: 200 }), 'wait 200ms')
  assert.equal(describeStep({ do: 'focus', handle: 42 }), 'focus #42')
})

test('the stop flag is a file that survives processes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'see-act-stop-'))
  const env = { DSH_HOME: home }

  assert.equal(readStop(env).stopped, false)
  const file = setStop('my hand slipped', env)
  assert.equal(file, path.join(home, 'see-act.stop'))

  const stopped = readStop(env)
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.reason, 'my hand slipped')
  assert.ok(stopped.at)

  assert.equal(clearStop(env), true)
  assert.equal(readStop(env).stopped, false)
  assert.equal(clearStop(env), false)

  fs.rmSync(home, { recursive: true, force: true })
})
