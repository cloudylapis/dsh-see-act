import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULTS,
  canAct,
  configPath,
  dshHome,
  frameRoot,
  loadConfig,
  readConfigFile,
  stopPath,
} from '../lib/config.mjs'

function emptyHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'see-act-config-'))
  return { home, env: { DSH_HOME: home } }
}

test('with no file and no env, every default holds', () => {
  const { home, env } = emptyHome()
  assert.deepEqual(loadConfig(env), { ...DEFAULTS })
  fs.rmSync(home, { recursive: true, force: true })
})

test('paths hang off DSH_HOME and can be overridden', () => {
  const { home, env } = emptyHome()
  assert.equal(dshHome(env), home)
  assert.equal(configPath(env), path.join(home, 'see-act.json'))
  assert.equal(frameRoot(env), path.join(home, 'see-act-frames'))
  assert.equal(stopPath(env), path.join(home, 'see-act.stop'))

  const custom = {
    ...env,
    DSH_SEE_ACT_CONFIG: 'C:/x/c.json',
    DSH_SEE_ACT_FRAMES: 'C:/x/frames',
    DSH_SEE_ACT_STOP: 'C:/x/stop',
  }
  assert.equal(configPath(custom), 'C:/x/c.json')
  assert.equal(frameRoot(custom), 'C:/x/frames')
  assert.equal(stopPath(custom), 'C:/x/stop')
  fs.rmSync(home, { recursive: true, force: true })
})

test('the JSON file overrides defaults', () => {
  const { home, env } = emptyHome()
  fs.writeFileSync(
    configPath(env),
    JSON.stringify({ quality: 'read', settleMs: 300, narrate: false, screen: 'primary' }),
  )
  const config = loadConfig(env)
  assert.equal(config.quality, 'read')
  assert.equal(config.settleMs, 300)
  assert.equal(config.narrate, false)
  assert.equal(config.screen, 'primary')
  assert.equal(config.mode, DEFAULTS.mode)
  fs.rmSync(home, { recursive: true, force: true })
})

test('a broken file is logged and ignored, not fatal', () => {
  const { home, env } = emptyHome()
  fs.writeFileSync(configPath(env), '{ not json')
  const logged = []
  assert.deepEqual(readConfigFile(env, (message) => logged.push(message)), {})
  assert.ok(logged.some((m) => /ignoring/.test(m)))

  fs.writeFileSync(configPath(env), '[1,2,3]')
  assert.deepEqual(readConfigFile(env, () => {}), {})
  assert.deepEqual(loadConfig(env), { ...DEFAULTS })
  fs.rmSync(home, { recursive: true, force: true })
})

test('one bad field does not reset the others', () => {
  const { home, env } = emptyHome()
  fs.writeFileSync(
    configPath(env),
    JSON.stringify({ mode: 'yolo', quality: 'read', settleMs: 99_999, zoomInset: 'yes please' }),
  )
  const config = loadConfig(env)
  assert.equal(config.mode, DEFAULTS.mode)
  assert.equal(config.quality, 'read')
  assert.equal(config.settleMs, 3000)
  assert.equal(config.zoomInset, DEFAULTS.zoomInset)
  fs.rmSync(home, { recursive: true, force: true })
})

test('environment variables beat the file', () => {
  const { home, env } = emptyHome()
  fs.writeFileSync(configPath(env), JSON.stringify({ mode: 'readonly', settleMs: 500 }))
  const config = loadConfig({
    ...env,
    DSH_SEE_ACT_MODE: 'act',
    DSH_SEE_ACT_QUALITY: 'fast',
    DSH_SEE_ACT_SCREEN: 'cursor',
    DSH_SEE_ACT_SETTLE_MS: '30',
    DSH_SEE_ACT_NARRATE: 'false',
    DSH_SEE_ACT_NO_DODGE: '1',
  })
  assert.equal(config.mode, 'act')
  assert.equal(config.quality, 'fast')
  assert.equal(config.screen, 'cursor')
  assert.equal(config.settleMs, 30)
  assert.equal(config.narrate, false)
  assert.equal(config.dodge, 'off')
  fs.rmSync(home, { recursive: true, force: true })
})

test('readonly is the only mode that cannot move the mouse', () => {
  assert.equal(canAct({ mode: 'act' }), true)
  assert.equal(canAct({ mode: 'readonly' }), false)
  assert.equal(canAct(loadConfig({ DSH_SEE_ACT_MODE: 'readonly' })), false)
})
