/**
 * 多卡运营墙归档容器编解码（v4，手写二进制，无任何运行时依赖）
 *
 * 设计目标：
 *   1. wall.saveAll() 产出单一 Uint8Array，硬上限 8MB（超限抛错）；
 *   2. 容器内每个卡段就是一张完整的单卡快照（scratchCodec，magic 'SC1'），
 *      可 extractCardSegment 取出后直接交给 ScratchCard.restore() 单独恢复；
 *   3. v3 裸单卡快照（'SC1'）可直接被 wallRestore 接收，按 1 卡墙恢复
 *      （迁移函数 migrateV3CardToWall 显式演示 v3 -> wall 的升级路径）。
 *
 * 布局（小端序）：
 *   magic 'S''C''W' | u8 version(=1) | u32 totalLen（含头部，便于一次校验）
 *   u16 cardCount
 *   varint jsonLen | UTF-8 JSON（墙配置快照，仅记录，不强制恢复时采用）
 *   重复 cardCount 个 entry：
 *     u8 state
 *       0 = 活跃/休眠卡（段是常规单卡快照，含全部矢量+redo）
 *       1 = 冷存档卡（段同样是常规单卡快照——冷档直接复用 v3 save 产物）
 *       2 = 已丢弃（无段；恢复为一张空白卡，仅保留槽位/索引）
 *     state != 2 时：u32 segLen | segLen 字节的单卡快照
 *       （state=0 允许 segLen=0：该槽是一张从未刮过的空白活卡，
 *       恢复时直接建空白卡，省掉空快照的编解码；state=1 不允许 0）
 *
 * 为什么冷档与活跃段使用同一格式（不另造更紧的编码）：
 *   - 单卡格式已经是「最紧凑可序列化形式」（量化矢量 + 差分校戈尔码 +
 *     位图 RLE，v3 验证 5000 笔约 384KB），再造专用编码收益小、风险高；
 *   - 段格式统一 => 冷档被唤醒、墙段被单卡 restore、v3 快照进墙三者
 *     全部零转码，迁移路径只有「外面套一层 SCW 容器」这一条。
 *
 * 版本迁移策略：
 *   - 本文件 version=1；decode 只接受同 magic，版本不同且高于当前则抛错，
 *     低于当前在此函数内逐版本升级（当前只有 1，预留 switch 位置）。
 *   - v3 单卡 -> v4 墙：migrateV3CardToWall()，纯包封、不解压不重编码，
 *     因而无损且 O(1) 拷贝级开销。
 */

export const WALL_VERSION = 1
export const WALL_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024

const WALL_MAGIC = [0x53, 0x43, 0x57] // 'SCW'

/** 段状态：活跃/休眠（有完整快照） */
export const SEG_LIVE = 0
/** 段状态：冷存档（有完整快照，但墙内已无在册状态） */
export const SEG_ARCHIVED = 1
/** 段状态：已丢弃（无段体，恢复为空白新卡） */
export const SEG_DISCARDED = 2

/* ---------------- 轻量 writer/reader（与 scratchCodec 同思路自包含） ---------------- */

class Writer {
  constructor() {
    this.buf = new Uint8Array(4096)
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

  bytes(array) {
    this.ensure(array.length)
    this.buf.set(array, this.len)
    this.len += array.length
  }

  result() {
    return this.buf.slice(0, this.len)
  }
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes
    this.pos = 0
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  u8() {
    if (this.pos >= this.bytes.length) throw new Error('[wall] 归档意外结尾')
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

  take(length) {
    if (this.pos + length > this.bytes.length) {
      throw new Error('[wall] 归档卡段不完整')
    }
    const slice = this.bytes.slice(this.pos, this.pos + length)
    this.pos += length
    return slice
  }
}

function utf8Encode(text) {
  return new TextEncoder().encode(text)
}

function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes)
}

export function isWallArchive(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.length >= 4 &&
    WALL_MAGIC.every((b, idx) => bytes[idx] === b)
  )
}

/* ---------------- 编码 ---------------- */

/**
 * @param {Array<{state:number, segment:Uint8Array|null}>} entries
 *   按墙卡槽顺序；state 取 SEG_*；state != SEG_DISCARDED 时 segment 必填，
 *   且必须是 scratchCodec 产出的单卡快照（含 'SC1' magic）。
 * @param {object} [meta] 墙配置快照（maxCards / 预算 / 卡数等），仅记录
 * @returns {Uint8Array} <= WALL_ARCHIVE_MAX_BYTES，超限抛错（绝不截断）
 */
export function encodeWall(entries, meta = {}) {
  const body = new Writer()
  body.u16(entries.length)
  const jsonBytes = utf8Encode(JSON.stringify(meta ?? {}))
  // JSON 长度 varint 会过度长（配置极小），直接用 u32 定长，简单可校验
  body.u32(jsonBytes.length)
  body.bytes(jsonBytes)

  for (const entry of entries) {
    body.u8(entry.state)
    if (entry.state === SEG_DISCARDED) {
      if (entry.segment) throw new Error('[wall] 已丢弃卡段不应携带快照')
      continue
    }
    if (entry.state === SEG_ARCHIVED && !(entry.segment instanceof Uint8Array)) {
      throw new Error('[wall] 冷存档卡段缺少单卡快照')
    }
    if (entry.state === SEG_LIVE && entry.segment == null) {
      body.u32(0) // 空白活卡
      continue
    }
    if (!(entry.segment instanceof Uint8Array)) {
      throw new Error('[wall] 卡段缺少单卡快照')
    }
    body.u32(entry.segment.length)
    body.bytes(entry.segment)
  }

  const out = new Writer()
  WALL_MAGIC.forEach((b) => out.u8(b))
  out.u8(WALL_VERSION)
  // 4 magic + 1 version + 4 totalLen
  out.u32(8 + body.len)
  out.bytes(body.result())

  const archive = out.result()
  if (archive.length > WALL_ARCHIVE_MAX_BYTES) {
    throw new Error(
      `[wall] 整墙归档 ${archive.length} 字节超过 ${WALL_ARCHIVE_MAX_BYTES} 字节上限；` +
        '请减少卡数/笔迹规模或调小卡片 maxHistory'
    )
  }
  return archive
}

/**
 * 解码整墙归档。返回：
 *   { version, meta, entries: [{state, segment|null}] }
 * 不做单卡段解码（惰性：wallRestore 只对要恢复的段 decode，其余保持
 * Uint8Array 冷数据），段可直接 ScratchCard.restore。
 */
export function decodeWall(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (!isWallArchive(bytes)) throw new Error('[wall] 归档 magic 不合法')
  const reader = new Reader(bytes)
  WALL_MAGIC.forEach(() => reader.u8())
  const version = reader.u8()
  if (version !== WALL_VERSION) {
    // 预留：旧版本 -> 当前版本的升级 switch 写在这里；当前只有 v1
    throw new Error(`[wall] 不支持的归档版本：${version}`)
  }
  const totalLen = reader.u32()
  if (totalLen !== bytes.length) {
    throw new Error(`[wall] 归档长度不一致（声明 ${totalLen} / 实际 ${bytes.length}）`)
  }

  const cardCount = reader.u16()
  if (cardCount > 50_000) throw new Error('[wall] 归档卡数非法')
  const jsonLen = reader.u32()
  if (jsonLen > 1_000_000) throw new Error('[wall] 归档配置过大')
  const meta = JSON.parse(utf8Decode(reader.take(jsonLen)))

  const entries = []
  for (let i = 0; i < cardCount; i++) {
    const state = reader.u8()
    if (state === SEG_DISCARDED) {
      entries.push({ state, segment: null })
      continue
    }
    if (state !== SEG_LIVE && state !== SEG_ARCHIVED) {
      throw new Error(`[wall] 第 ${i} 段状态非法：${state}`)
    }
    const segLen = reader.u32()
    const segment = segLen === 0 ? null : reader.take(segLen)
    entries.push({ state, segment })
  }
  if (reader.pos !== bytes.length) {
    throw new Error('[wall] 归档存在尾部多余字节')
  }
  return { version, meta, entries }
}

/**
 * 从墙归档中零拷贝提取一张卡的单卡快照段（subarray），可直接交给
 * ScratchCard.restore() —— 这是「墙归档单卡段可被单卡恢复」的入口。
 */
export function extractCardSegment(archive, index) {
  const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive)
  if (!isWallArchive(bytes)) throw new Error('[wall] 归档 magic 不合法')
  const reader = new Reader(bytes)
  WALL_MAGIC.forEach(() => reader.u8())
  reader.u8()
  if (reader.u32() !== bytes.length) throw new Error('[wall] 归档长度不一致')
  const cardCount = reader.u16()
  const jsonLen = reader.u32()
  reader.take(jsonLen)
  for (let i = 0; i < cardCount; i++) {
    const state = reader.u8()
    if (state === SEG_DISCARDED) {
      if (i === index) return null
      continue
    }
    const segLen = reader.u32()
    if (i === index) return segLen === 0 ? null : reader.take(segLen)
    reader.pos += segLen
  }
  return null
}

/* ---------------- v3 单卡 -> v4 墙迁移 ---------------- */

/**
 * 把一张 v3 单卡快照（'SC1'，v1/v2 均可）无损迁移为 1 卡墙归档。
 * 纯包封：卡段原样嵌入，不解码、不重编码，因此几何/位图/redo 栈逐字节保留。
 * 迁移后的归档仍可 extractCardSegment(a, 0) 取回与输入完全相同的字节。
 */
export function migrateV3CardToWall(cardSnapshot, meta = {}) {
  const bytes =
    cardSnapshot instanceof Uint8Array ? cardSnapshot : new Uint8Array(cardSnapshot)
  if (bytes.length < 4 || bytes[0] !== 0x53 || bytes[1] !== 0x43 || bytes[2] !== 0x31) {
    throw new Error('[wall] 迁移源不是 v3 单卡快照（magic 应为 SC1）')
  }
  return encodeWall(
    [{ state: SEG_LIVE, segment: bytes }],
    { migratedFrom: 'card-v3', ...meta }
  )
}
