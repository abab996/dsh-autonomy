// check-autonomy-injection.mjs — verify the autonomy prompt injection chain
// from the durable session log: the autonomy/level switch event and the
// request/header system text actually sent to the model.
import { zstdDecompressSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const f = process.argv[2]
if (!f) {
  console.error('usage: node check-autonomy-injection.mjs <session.jsonl.zstd>')
  process.exit(1)
}
const data = readFileSync(f)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
let idx = 0
while ((idx = data.indexOf(magic, idx)) !== -1) { offsets.push(idx); idx += 4 }
let all = ''
for (let i = 0; i < offsets.length; i++) {
  all += zstdDecompressSync(data.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : data.length)).toString('utf8')
}
const evts = all.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
console.log('events:', evts.length)

const when = (e) => new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false })

for (const e of evts) {
  const t = e.type
  if (t === 'autonomy/level') {
    console.log(`${when(e)} [switch]`, JSON.stringify(e.data))
  }
  if (t === 'request/header') {
    const sys = e.data?.header?.system ?? ''
    const m = sys.match(/AUTONOMY: [A-Z]+/)
    console.log(`${when(e)} [request] system=${sys.length} chars, autonomy=${m ? m[0] : '(NOT INJECTED)'}`)
  }
}
