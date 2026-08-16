// dump-injection.mjs — dump the FULL system text of the request that carried
// AUTONOMY: WILD, plus the surrounding conversation, to verify the injection.
import { zstdDecompressSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const f = process.argv[2]
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
const when = (e) => new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false })

// Find the last request/header whose system mentions AUTONOMY.
const targets = evts.filter((e) => e.type === 'request/header' && (e.data?.header?.system ?? '').includes('AUTONOMY'))
console.log('requests with AUTONOMY in system:', targets.length)
for (const t of targets) {
  console.log('----', when(t), 'reason=', t.data?.reason, '----')
  const sys = t.data?.header?.system ?? ''
  const i = sys.indexOf('AUTONOMY')
  console.log('AUTONOMY at char', i, 'of', sys.length)
  // 段前 80 字符上下文 + 完整 AUTONOMY 段
  console.log('...context before:', JSON.stringify(sys.slice(Math.max(0, i - 120), i)))
  const end = sys.indexOf('\n\n', i)
  console.log('AUTONOMY section:', JSON.stringify(sys.slice(i, end < 0 ? i + 700 : end)))
}

// Align the last AUTONOMY request with the surrounding conversation:
// the user messages immediately before it.
console.log('\n--- conversation around the last AUTONOMY request ---')
const lastIdx = evts.findLastIndex((e) => e.type === 'request/header' && (e.data?.header?.system ?? '').includes('AUTONOMY'))
const win = evts.slice(Math.max(0, lastIdx - 8), lastIdx + 4)
for (const e of win) {
  if (e.type === 'user/message') {
    const text = (e.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').slice(0, 120)
    console.log(when(e), 'USER:', JSON.stringify(text))
  }
  if (e.type === 'request/header') {
    console.log(when(e), 'REQ : system=', (e.data?.header?.system ?? '').length, 'chars, autonomy=', (e.data?.header?.system ?? '').includes('AUTONOMY'))
  }
  if (e.type === 'assistant/message') {
    const text = (e.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').slice(0, 80)
    console.log(when(e), 'ASST:', JSON.stringify(text))
  }
  if (e.type === 'autonomy/level') console.log(when(e), 'SWITCH:', JSON.stringify(e.data))
}
