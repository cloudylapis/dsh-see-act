import assert from 'node:assert/strict'
import test from 'node:test'

import { createToolDefinitions } from '../lib/tools.mjs'

const definitions = createToolDefinitions({
  ctx: null,
  env: { DSH_HOME: 'C:/nowhere' },
  log: () => {},
})

const byName = new Map(definitions.map((definition) => [definition.name, definition]))

test('the four tools are registered under the documented names', () => {
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ['see_look', 'see_zoom', 'see_act', 'see_stop'],
  )
})

test('every definition is registry-ready', () => {
  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 80, `${definition.name} description is too thin`)

    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(typeof definition.parameters.properties, 'object')

    assert.equal(definition.output.schema.type, 'object')
    assert.ok(definition.output.schema.required.includes('text'))
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('render puts the images first and the words last', () => {
  const value = {
    text: 'clicked',
    images: [{ mimeType: 'image/png', id: 'one' }],
    meta: { steps: [] },
  }
  const content = byName.get('see_act').output.render({}, value)
  assert.deepEqual(content, [
    { type: 'image', attachment: { mimeType: 'image/png', id: 'one' } },
    { type: 'text', text: 'clicked' },
  ])

  const bare = byName.get('see_look').output.render({}, { text: 'nothing to show' })
  assert.deepEqual(bare, [{ type: 'text', text: 'nothing to show' }])
})

test('aiming is described in the schema where the model reads it', () => {
  const at = byName.get('see_zoom').parameters.properties.at
  assert.equal(at.type, 'object')
  assert.ok(at.properties.nx)
  assert.ok(at.properties.ny)
  assert.ok(at.properties.cell)
  assert.match(at.description, /nx/)
})

test('act exposes the whole plan surface and a generous timeout', () => {
  const properties = byName.get('see_act').parameters.properties
  for (const key of ['do', 'at', 'to', 'text', 'keys', 'wheel', 'ms', 'enter', 'steps', 'force', 'say']) {
    assert.ok(properties[key], `see_act is missing ${key}`)
  }
  assert.equal(byName.get('see_act').timeoutMs, 120_000)
  assert.equal(byName.get('see_stop').timeoutMs, 30_000)
})

test('the stop tool is the only one that is safe to call repeatedly', () => {
  const actions = byName.get('see_stop').parameters.properties.action
  assert.deepEqual(actions.enum, ['stop', 'clear', 'status'])
})

test('descriptions say what the tool is for, not how it is built', () => {
  for (const definition of definitions) {
    assert.doesNotMatch(definition.description, /PowerShell|Add-Type|P\/Invoke/i, definition.name)
  }
  assert.match(byName.get('see_act').description, /nx/)
})

// The host validates these schemas before it mounts the plugin and refuses the
// whole fiber on a single bad keyword: "unsupported JSON schema:
// schema.properties.images.items.type must be one of object/array/..." — a
// `{ type: 'json' }` shorthands is read as an unknown type. Keep every `type`
// a plain JSON type so the plugin can actually load.
const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function collectTypes(node, path, bad) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectTypes(entry, `${path}[${index}]`, bad))
    return
  }
  if ('type' in node) {
    const value = node.type
    if (typeof value === 'string' && !JSON_TYPES.has(value)) bad.push(`${path}.type = ${value}`)
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!JSON_TYPES.has(entry)) bad.push(`${path}.type includes ${entry}`)
      }
    }
  }
  for (const [key, child] of Object.entries(node)) collectTypes(child, `${path}.${key}`, bad)
}

test('every schema keyword is something the host accepts', () => {
  const bad = []
  for (const definition of definitions) {
    collectTypes(definition.parameters, `${definition.name}.parameters`, bad)
    collectTypes(definition.output.schema, `${definition.name}.output.schema`, bad)
  }
  assert.deepEqual(bad, [])
})

