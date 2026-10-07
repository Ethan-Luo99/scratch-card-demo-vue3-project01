/**
 * 多卡运营墙「整墙归档」手写二进制容器（v4，无任何运行时依赖）
 *
 * 复用策略：墙容器只做「信封」，不重新定义任何单卡编码——
 * 每个 entry 的 payload 原样嵌入 v3 起定义的单卡快照字节（'SC1'，
 * 见 scratchCodec.js）。因此：
 *   - 墙内任意单卡段截出来即可直接喂给 ScratchCard.restore
 *     （extractCardSnapshot 做的就是这件事，零拷贝 subarray）；
 *   - 单卡 save() 产物经 migrateSingleToWall 包一层即可 wallRestore
 *     （v3 -> wall 容器的迁移演示路径）；
 *   - 单卡格式未来升级时容器格式无需变动（迁移挂在 scratchCodec 的
 *     registerSnapshotMigration 分发表上）。
 *
 * 容器布局（小端序）：
 *   magic 'S''C''W''L' | u8 version(=1) | u32 wallTotalBytes（含头部）
 *   varint cardCapacity（恢复时卡槽数语义见 decodeWallArchive 注释）
 *   varint entryCount
 *   重复 entryCount 次：
 *     varint index           卡槽下标（0..cardCapacity-1，稀疏存储，
 *                            未出现的卡槽 restore 时重置为全新空卡）
 *     u8 presentMask         bit0=有单卡快照  bit1=有覆盖配置 record
 *     若 bit0：u32 segLen | segLen 字节（完整 'SC1' 单卡快照，
 *             单卡自身 2MB 上限仍由 encodeSnapshot 保证）
 *     若 bit1：配置 record（固定布局，便于向旧版本前向兼容）
 *             u16 textLen | UTF8 字节（coverText）
 *             u16 colorLen | UTF8 字节（coverColor）
 *             u8 0/1 responsive | f32 aspectRatio | u8 threshold
 *             u16 brushSize | u32 fadeDuration | u16 maxHistory
 *             u16 rasterizeAfter
 *
 * 设计取舍：
 * - entry 显式带 index 而非按顺序排列：空卡（从未刮过/reset 后）不占
 *   任何字节，50 张空墙的归档只有 ~20 字节头部。
 * - 配置 record 与几何快照分离：v3 单卡快照本来就不含外观（外观归
 *   调用方），墙把每卡覆盖配置存在信封上，restore 时通过
 *   onConfigRestored 事件交还给宿主应用；旧单卡快照无此段，缺省即可。
 * - u32 wallTotalBytes 写在头部，解码前即可快速校验/分配。
 */

import {
  isSingleCardSnapshot,
  SNAPSHOT_VERSION,
} from './scratchCodec.js'

export const WALL_VERSION = 1
/** 整墙归档硬上限：8MB（需求 4）。50 卡 × 单卡 2MB 不可能同时顶满
 *  （笔迹由 maxHistory/rasterizeAfter 夹住），8MB 对正常运营数据绰绰
 *  有余；超限直接抛错，绝不静默裁剪几何。 */
export const WALL_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024

const WALL_MAGIC = [0x53, 0x43, 0x57, 0x4c] // 'SCWL'

export function isWallArchive(input) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null
  return !!bytes && bytes.length >= 5 && WALL_MAGIC.every((b, i) => bytes[i] === b)
}

/* ---------------- varint（与 scratchCodec 同约定） ---------------- */

function writeVarint(writer, value) {
  let n = value >>> 0
  while (n >= 0x80) {
    writer.u8((n & 0x7f) | 0x80)
    n >>>= 7
  }
  writer.u8(n)
}

function readVarint(reader) {
  let shift = 0
  let result = 0
  for (;;) {
    const byte = reader.u8()
    result |= (byte & 0x7f) << shift
    if (byte < 0x80) break
    shift += 7
    if (shift > 35) throw new Error('[wall] varint 溢出')
  }
  return result >>> 0
}

class ByteWriter {
  constructor() {
    this.buf = new Uint8Array(1024)
    this.len = 0
    this.view = new DataView(this.buf.buffer)
  }
  ensure(extra) {
    if (this.len + extra <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.len + extra) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
    this.view = new DataView(next.buffer)
  }
  u8(v) {
    this.ensure(1)
    this.buf[this.len++] = v & 0xff
  }
  u16(v) {
    this.ensure(2)
    this.view.setUint16(this.len, v, true)
    this.len += 2
  }
  u32(v) {
    this.ensure(4)
    this.view.setUint32(this.len, v >>> 0, true)
    this.len += 4
  }
  f32(v) {
    this.ensure(4)
    this.view.setFloat32(this.len, v, true)
    this.len += 4
  }
  bytes(array) {
    this.ensure(array.length)
    this.buf.set(array, this.len)
    this.len += array.length
  }
  result() {
    return this.buf.slice(0, this.len)
  }
}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes
    this.pos = 0
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u8() {
    if (this.pos >= this.bytes.length) throw new Error('[wall] 意外结尾')
    return this.bytes[this.pos++]
  }
  u16() {
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }
  u32() {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
  f32() {
    const v = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }
  take(length) {
    if (this.pos + length > this.bytes.length) throw new Error('[wall] 段数据不完整')
    const slice = this.bytes.subarray(this.pos, this.pos + length)
    this.pos += length
    return slice
  }
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

function writeShortString(writer, text) {
  const bytes = utf8Encoder.encode(text ?? '')
  if (bytes.length > 65535) throw new Error('[wall] 字符串过长')
  writer.u16(bytes.length)
  writer.bytes(bytes)
}

function readShortString(reader) {
  const length = reader.u16()
  return utf8Decoder.decode(reader.take(length))
}

/* ---------------- 每卡覆盖配置 record ---------------- */

/**
 * 只收录墙 props 支持逐卡覆盖的字段；其余字段（width/height 等）
 * 以墙 props 为准。传 null 表示该卡没有独立配置（不写 record）。
 */
function encodeConfigRecord(writer, config) {
  if (!config) {
    writer.u8(0)
    return
  }
  writer.u8(1)
  writeShortString(writer, config.coverText ?? '')
  writeShortString(writer, config.coverColor ?? '')
  writer.u8(config.responsive ? 1 : 0)
  writer.f32(Number(config.aspectRatio) || 0)
  writer.u8(Math.max(0, Math.min(100, Math.round(config.threshold ?? 40))))
  writer.u16(Math.max(1, Math.round(config.brushSize ?? 28)))
  writer.u32(Math.max(0, Math.round(config.fadeDuration ?? 500)))
  writer.u16(Math.max(1, Math.min(65535, Math.round(config.maxHistory ?? 200))))
  writer.u16(Math.max(1, Math.min(65535, Math.round(config.rasterizeAfter ?? 500))))
}

function decodeConfigRecord(reader) {
  const present = reader.u8()
  if (!present) return null
  return {
    coverText: readShortString(reader),
    coverColor: readShortString(reader),
    responsive: reader.u8() === 1,
    aspectRatio: reader.f32(),
    threshold: reader.u8(),
    brushSize: reader.u16(),
    fadeDuration: reader.u32(),
    maxHistory: reader.u16(),
    rasterizeAfter: reader.u16(),
  }
}

/* ---------------- 对外：编码整墙 ---------------- */

/**
 * @param {object} data
 *   capacity:number  当前卡槽总数（min(cards, maxCards)）
 *   entries: Array<{ index:number, snapshot?:Uint8Array|null,
 *                    config?:object|null }>（稀疏；空卡可直接省略）
 * @returns {Uint8Array}（<= WALL_ARCHIVE_MAX_BYTES，否则抛错）
 */
export function encodeWallArchive(data) {
  const capacity = Math.max(0, Math.floor(data.capacity ?? 0))
  const entries = (data.entries ?? []).filter(
    (e) => e && (e.snapshot || e.config) && Number.isInteger(e.index)
  )

  // 先编码正文（头部的总长度在收尾时回填），再做 8MB 硬校验
  const body = new ByteWriter()
  writeVarint(body, capacity)
  writeVarint(body, entries.length)
  for (const entry of entries) {
    if (entry.index < 0 || entry.index >= capacity) {
      throw new Error('[wall] entry 卡槽下标非法')
    }
    writeVarint(body, entry.index)
    let mask = 0
    if (entry.snapshot) mask |= 0x01
    if (entry.config) mask |= 0x02
    body.u8(mask)
    if (entry.snapshot) {
      if (!isSingleCardSnapshot(entry.snapshot)) {
        throw new Error('[wall] entry 段不是合法的单卡快照')
      }
      body.u32(entry.snapshot.length)
      body.bytes(entry.snapshot)
    }
    if (entry.config) encodeConfigRecord(body, entry.config)
  }

  const headerLen = WALL_MAGIC.length + 1 + 4
  const total = headerLen + body.len
  if (total > WALL_ARCHIVE_MAX_BYTES) {
    throw new Error(
      `[wall] 整墙归档 ${total} 字节超过 ${WALL_ARCHIVE_MAX_BYTES} 字节上限；` +
        '请减少笔迹规模/卡片数量后再存档（不会写入任何截断数据）'
    )
  }

  const out = new ByteWriter()
  WALL_MAGIC.forEach((b) => out.u8(b))
  out.u8(WALL_VERSION)
  out.u32(total)
  out.bytes(body.result())
  return out.result()
}

/**
 * 解码整墙归档（不校验单卡正文，单卡段在 restore 时交由
 * decodeSnapshot 校验——旧版本单卡快照也能被其迁移路径接受）。
 *
 * @returns {{ version, capacity, entries: Array<{index,snapshot:Uint8Array|null,
 *            config:object|null}> }}
 */
export function decodeWallArchive(input) {
  let bytes
  if (input instanceof Uint8Array) bytes = input
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input)
  else throw new Error('[wall] restore 需要 Uint8Array 或 ArrayBuffer')
  if (!isWallArchive(bytes)) throw new Error('[wall] magic 不合法，不是整墙归档')

  const reader = new ByteReader(bytes)
  WALL_MAGIC.forEach(() => reader.u8())
  const version = reader.u8()
  // 容器版本迁移：当前仅 v1。未来升版在此分派到 wallMigrations。
  if (version !== WALL_VERSION) {
    const migrate = wallMigrations.get(version)
    if (!migrate) throw new Error(`[wall] 不支持的墙归档版本：${version}`)
    return migrate(bytes)
  }
  const totalBytes = reader.u32()
  if (totalBytes !== bytes.length) {
    throw new Error(`[wall] 归档长度不匹配（头 ${totalBytes} / 实际 ${bytes.length}）`)
  }

  const capacity = readVarint(reader)
  if (capacity > 10000) throw new Error('[wall] 卡槽数非法')
  const entryCount = readVarint(reader)
  if (entryCount > capacity + 64) throw new Error('[wall] entry 数量非法')

  const entries = []
  const seen = new Set()
  for (let n = 0; n < entryCount; n++) {
    const index = readVarint(reader)
    const mask = reader.u8()
    let snapshot = null
    let config = null
    if (mask & 0x01) {
      const segLen = reader.u32()
      snapshot = reader.take(segLen).slice() // 段独立持有，原 buffer 可释放
    }
    if (mask & 0x02) config = decodeConfigRecord(reader)
    if (seen.has(index)) throw new Error('[wall] entry 卡槽下标重复')
    seen.add(index)
    entries.push({ index, snapshot, config })
  }
  return { version, capacity, entries }
}

/** 墙容器版本迁移分发表（与 scratchCodec 同模式，为未来版本预留） */
const wallMigrations = new Map()
export function registerWallMigration(fromVersion, migrateFn) {
  wallMigrations.set(fromVersion, migrateFn)
}

/* ---------------- v3 单卡快照 -> 墙容器（迁移演示路径） ---------------- */

/**
 * 交织场景⑤要求的「v3 单卡格式 → wall 容器格式」迁移函数。
 * 语义：把一张 v3 卡的 save() 产物包成容量 1 的墙归档；
 * wallRestore 解包后恢复为 1 卡墙（卡槽 0）。
 * 入参也接受已经是墙归档的字节（原样返回，幂等，便于调用方
 * 对「单卡 or 整墙」两种输入统一处理）。
 *
 * @param {Uint8Array|ArrayBuffer} singleSnapshot  v3 'SC1' 单卡快照
 * @param {object} [config] 可选的该卡覆盖配置
 */
export function migrateSingleToWall(singleSnapshot, config = null) {
  let bytes
  if (singleSnapshot instanceof Uint8Array) bytes = singleSnapshot
  else if (singleSnapshot instanceof ArrayBuffer) bytes = new Uint8Array(singleSnapshot)
  else throw new Error('[wall] 迁移输入需要 Uint8Array/ArrayBuffer')

  if (isWallArchive(bytes)) return bytes.slice()
  if (!isSingleCardSnapshot(bytes)) {
    throw new Error('[wall] 迁移输入既不是单卡快照也不是墙归档')
  }
  return encodeWallArchive({
    capacity: 1,
    entries: [{ index: 0, snapshot: bytes, config: config || null }],
  })
}

/**
 * 从墙归档中零拷贝取出某卡槽的单卡段（可直接喂 ScratchCard.restore）。
 * @returns {Uint8Array|null} 该卡槽没有快照段时返回 null（空卡）
 */
export function extractCardSnapshot(archiveInput, index) {
  const decoded = decodeWallArchive(archiveInput)
  const entry = decoded.entries.find((e) => e.index === index)
  return entry?.snapshot ?? null
}

/**
 * 统一识别输入类型：'wall' | 'single' | null。
 * wallRestore 同时接受两种输入（单卡 → 视为容量 1 的墙，见组件注释）。
 */
export function detectArchiveKind(input) {
  if (isWallArchive(input)) return 'wall'
  if (isSingleCardSnapshot(input)) return 'single'
  return null
}

export { SNAPSHOT_VERSION }
