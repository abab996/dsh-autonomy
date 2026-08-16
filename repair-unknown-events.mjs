#!/usr/bin/env node
/**
 * Repair a DSH session log whose custom plugin events lack the `ignorable`
 * envelope marker, which makes the harness reader refuse the whole log with
 * SessionFormatUnsupportedError ("contains event type ... unknown to this
 * harness and not marked ignorable").
 *
 * The on-disk format is a concatenation of independently checksummed zstd
 * frames; each frame holds one batch of JSONL event lines. This script:
 *   1. backs the log up,
 *   2. scans complete frames (same structural rules as the harness),
 *   3. decompresses ONLY the frames containing a target event type,
 *      adds `"ignorable": true` to those event envelopes (nothing else
 *      changes), recompresses them with the same checksum flag the writer
 *      uses, and copies untouched frames verbatim,
 *   4. verifies the rewritten artifact (structure + content diff),
 *   5. atomically swaps it into place.
 *
 * Usage:
 *   node repair-unknown-events.mjs <session.jsonl.zstd> [--type autonomy/level]...
 *
 * Only mark events ignorable when skipping them cannot change how the rest
 * of the log is interpreted (purely informational records). For
 * autonomy/level that is exactly the semantics: it only tunes prompt text.
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 little-endian

function scanFrames(buffer) {
  // Structural frame scan — mirrors scanZstdFrames in
  // @deepseek-ai/dsh-session-persistence-jsonl (header layout, block
  // iteration, checksum tail).
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart: undefined }
}

function splitLines(plaintext) {
  // Preserve trailing-newline semantics: a frame whose plaintext ends in "\n"
  // yields a final "" element; rejoining restores it exactly.
  return plaintext.toString('utf8').split('\n')
}

function joinLines(lines) {
  return Buffer.from(lines.join('\n'), 'utf8')
}

function parseArgs(argv) {
  const file = argv.find((a) => !a.startsWith('--'))
  if (!file) {
    console.error('usage: node repair-unknown-events.mjs <session.jsonl.zstd> [--type <type>]...')
    process.exit(2)
  }
  const types = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--type' && argv[i + 1]) types.push(argv[i + 1])
  }
  return { file, types }
}

const { file, types } = parseArgs(process.argv.slice(2))
if (types.length === 0) types.push('autonomy/level')

const source = readFileSync(file)
const { frames, tornStart } = scanFrames(source)
if (tornStart !== undefined) {
  console.error(`refusing: log has a torn/incomplete final frame at byte ${tornStart}; recover it first`)
  process.exit(1)
}
console.log(`scanned ${frames.length} complete frames in ${file}`)

const outParts = []
let modifiedFrames = 0
let modifiedEvents = 0
const diff = [] // { frame, seq, type } for the report

for (const [index, frame] of frames.entries()) {
  const raw = source.subarray(frame.start, frame.end)
  const plaintext = zstdDecompressSync(raw)
  const lines = splitLines(plaintext)
  let frameChanged = false
  const rewritten = lines.map((line) => {
    if (line === '') return line
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      return line // not JSON (should not happen inside a valid batch)
    }
    if (!parsed || typeof parsed.type !== 'string' || !types.includes(parsed.type)) return line
    if (parsed.ignorable === true) return line // already marked
    parsed.ignorable = true
    frameChanged = true
    modifiedEvents++
    diff.push({ frame: index, seq: parsed.seq, type: parsed.type })
    return JSON.stringify(parsed)
  })
  if (!frameChanged) {
    outParts.push(raw) // untouched frame: keep the original bytes verbatim
  } else {
    const recompressed = zstdCompressSync(joinLines(rewritten), {
      params: { [constants.ZSTD_c_checksumFlag]: 1 },
    })
    outParts.push(recompressed)
    modifiedFrames++
  }
}

if (modifiedEvents === 0) {
  console.log('no target events found; nothing to do')
  process.exit(0)
}
console.log(`marked ${modifiedEvents} event(s) ignorable across ${modifiedFrames} frame(s)`)
for (const d of diff) console.log(`  frame ${d.frame}: ${d.type} seq ${d.seq}`)

const repaired = Buffer.concat(outParts)

// --- verification pass: structure + content diff ---------------------------
const { frames: vFrames, tornStart: vTorn } = scanFrames(repaired)
if (vFrames.length !== frames.length || vTorn !== undefined) {
  console.error('VERIFY FAILED: frame structure changed after rewrite')
  process.exit(1)
}
const originalText = Buffer.concat(frames.map((f) => zstdDecompressSync(source.subarray(f.start, f.end))))
const repairedText = Buffer.concat(vFrames.map((f) => zstdDecompressSync(repaired.subarray(f.start, f.end))))
const oLines = splitLines(originalText)
const rLines = splitLines(repairedText)
if (oLines.length !== rLines.length) {
  console.error(`VERIFY FAILED: line count changed (${oLines.length} -> ${rLines.length})`)
  process.exit(1)
}
let contentChanged = 0
for (let i = 0; i < oLines.length; i++) {
  if (oLines[i] === rLines[i]) continue
  contentChanged++
  const o = JSON.parse(oLines[i])
  const r = JSON.parse(rLines[i])
  if (!types.includes(o.type) || r.ignorable !== true || r.type !== o.type || r.seq !== o.seq || r.time !== o.time || JSON.stringify(r.data) !== JSON.stringify(o.data)) {
    console.error(`VERIFY FAILED: unexpected content change at line ${i}`)
    console.error('  before:', oLines[i].slice(0, 160))
    console.error('  after: ', rLines[i].slice(0, 160))
    process.exit(1)
  }
}
console.log(`verify ok: ${contentChanged} line(s) differ, all only by the ignorable marker`)
console.log(`sha256 original: ${createHash('sha256').update(source).digest('hex')}`)
console.log(`sha256 repaired: ${createHash('sha256').update(repaired).digest('hex')}`)

// --- commit ---------------------------------------------------------------
const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
copyFileSync(file, backup)
const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
writeFileSync(tmp, repaired)
renameSync(tmp, file) // overwrite in place after the backup exists
console.log(`backup:  ${backup}`)
console.log(`repaired ${file} (${statSync(file).size} bytes)`)
