// Manual acceptance test: really opens Notepad, focuses it through the plugin,
// types Chinese text, and leaves the two annotated frames in %TEMP%\see-act-accept.
//
//   node test/accept-real.mjs
//
// Nothing else on screen is touched: the only actions are "focus the window
// whose title contains 记事本/Notepad" and "type". Close Notepad afterwards.

import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createToolDefinitions } from '../lib/tools.mjs'
import { clearStop } from '../lib/act.mjs'

const outDir = path.join(os.tmpdir(), 'see-act-accept')
await fsp.mkdir(outDir, { recursive: true })

// Start Notepad unless one is already open.
const notepad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
notepad.unref()
await new Promise((r) => setTimeout(r, 1200))

clearStop(process.env)

// A stand-in for the host's attachments service: writes the PNG and remembers a path.
let n = 0
const saved = []
const attachments = {
  async saveImage({ data, mediaType, name }) {
    const file = path.join(outDir, `${n++}-${name}`)
    await fsp.writeFile(file, data)
    saved.push(file)
    return { id: `local:${path.basename(file)}`, mediaType, name, path: file }
  },
}

const ctx = {
  get: (key) => (key === 'attachments' ? attachments : undefined),
  tools: { register: () => () => {} },
  logger: { info: () => {}, warn: () => {} },
}

const logs = []
const defs = createToolDefinitions({ ctx, env: process.env, log: (m) => logs.push(m) })
const byName = Object.fromEntries(defs.map((d) => [d.name, d]))

const text = process.argv[2] || '看屏操作测试：这一行是插件替我打的，中文没问题。'

console.log('→ see_act: focus Notepad, then type')
const t0 = Date.now()
// The window title follows the display language: "无标题 - 记事本" here.
const titles = ['记事本', 'Notepad']
let result = null
let lastError = null
for (const needle of titles) {
  try {
    result = await byName.see_act.execute({
      steps: [
        { do: 'focus', needle },
        { do: 'type', text, enter: false },
      ],
      quality: 'aim',
      shots: 'both',
    })
    break
  } catch (error) {
    lastError = error
  }
}
if (!result) throw lastError
const ms = Date.now() - t0

const content = byName.see_act.output.render({}, result)
console.log(`took ${ms}ms, ${saved.length} frame(s)`)
console.log(content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'))
for (const file of saved) console.log('frame:', file)
if (logs.length) console.log('log:', logs.join(' | '))
