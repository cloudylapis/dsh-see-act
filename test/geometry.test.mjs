import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GRID_STEPS,
  changedText,
  describePoint,
  describeRegion,
  normalizeScreen,
  parsePoint,
  pixelOf,
  scaleText,
  targetWidthFor,
} from '../lib/geometry.mjs'

test('quality picks the documented widths and falls back to aim', () => {
  assert.equal(targetWidthFor('fast'), 800)
  assert.equal(targetWidthFor('aim'), 1280)
  assert.equal(targetWidthFor('read'), 1600)
  assert.equal(targetWidthFor('READ'), 1600)
  assert.equal(targetWidthFor('gigantic'), 1280)
  assert.equal(targetWidthFor(undefined), 1280)
})

test('screen accepts the named choices, monitor indexes, and rejects nonsense', () => {
  assert.equal(normalizeScreen('PRIMARY'), 'primary')
  assert.equal(normalizeScreen(' foreground '), 'foreground')
  assert.equal(normalizeScreen(1), 1)
  assert.equal(normalizeScreen(undefined), undefined)
  assert.equal(normalizeScreen('left-wing'), undefined)
})

test('a point can be fractions, physical pixels, or a grid cell', () => {
  assert.deepEqual(parsePoint({ nx: 0.5, ny: 0.25 }), { point: { nx: 0.5, ny: 0.25 } })
  assert.deepEqual(parsePoint({ x: 1204.4, y: 860.6 }), { point: { x: 1204, y: 861 } })
  assert.deepEqual(parsePoint({ cell: '3,7' }), {
    point: { nx: (7 + 0.5) / GRID_STEPS, ny: (3 + 0.5) / GRID_STEPS },
  })
  assert.deepEqual(parsePoint({ cell: '0, 0' }).point, { nx: 0.05, ny: 0.05 })
})

test('a bad point says what to pass instead', () => {
  assert.match(parsePoint(undefined, 'at').error, /at is required/)
  assert.match(parsePoint('0.5,0.5', 'at').error, /must be an object/)
  assert.match(parsePoint({ nx: 1.4, ny: 0.5 }, 'at').error, /0\.\.1/)
  assert.match(parsePoint({ cell: '10,2' }, 'at').error, /0\.\.9/)
  assert.match(parsePoint({ cell: 'x' }, 'at').error, /row,col/)
  assert.match(parsePoint({}, 'at').error, /nx\+ny/)
})

test('pixelOf uses the same formula as the PowerShell side', () => {
  const region = { left: 0, top: 0, width: 2560, height: 1600 }
  assert.deepEqual(pixelOf({ nx: 0, ny: 0 }, region), { x: 0, y: 0 })
  assert.deepEqual(pixelOf({ nx: 1, ny: 1 }, region), { x: 2559, y: 1599 })
  assert.deepEqual(pixelOf({ nx: 0.5, ny: 0.5 }, region), { x: 1280, y: 800 })

  const second = { left: 2560, top: 145, width: 1920, height: 1080 }
  assert.deepEqual(pixelOf({ nx: 0.5, ny: 0.5 }, second), { x: 3520, y: 685 })
  assert.deepEqual(pixelOf({ x: 12, y: 34 }, second), { x: 12, y: 34 })
  assert.equal(pixelOf(null, region), null)
})

test('scale text tells the model how far off its pixel reading would be', () => {
  assert.equal(scaleText({ width: 2560 }, { width: 1280 }), '1 image px = 2.00 screen px')
  assert.equal(scaleText({ width: 1280 }, { width: 1280 }), '1 image px = 1 screen px')
  assert.equal(scaleText(null, { width: 1280 }), 'image scale unknown')
  assert.equal(scaleText({ width: 2560 }, { width: 0 }), 'image scale unknown')
})

test('changed text stays readable at both ends of the range', () => {
  assert.equal(changedText(0), 'no change')
  assert.equal(changedText(undefined), 'no change')
  assert.equal(changedText(0.042), '4.2% changed')
  assert.equal(changedText(0.25), '25% changed')
})

test('points and regions print the way the model should quote them', () => {
  assert.equal(describePoint({ nx: 1 / 3, ny: 0.5 }), 'nx=0.333 ny=0.500')
  assert.equal(describePoint({ x: 10, y: 20 }), 'x=10 y=20')
  assert.equal(describePoint(null), 'nowhere')
  assert.equal(describeRegion({ label: 'monitor 1', width: 2560, height: 1600 }), 'monitor 1  2560x1600')
  assert.equal(describeRegion({ index: 2, width: 1920, height: 1080 }), 'monitor 2  1920x1080')
  assert.equal(describeRegion(null), 'region unknown')
})
