/**
 * 刮刮卡快照手写二进制编解码（无任何运行时依赖）
 *
 * 格式选型（2MB 体积约束下的取舍，详见 ScratchCard.vue 顶部设计说明）：
 * - 不用 JSON：浮点笔画点 JSON 后每点约 15~25 字节，5000 笔（约 10 万点）
 *   即 2MB 上下，再无空间容纳固化位图，且数字 parse 慢。
 * - 不用 PNG/base64：canvas.toDataURL 对「稀疏 alpha 遮罩」编码效率低，
 *   base64 再膨胀 33%，且编解码走图像压缩，开销不可控。
 * - 采用手写紧凑二进制：
 *     笔画点：归一化坐标量化为 u16（1/65535 卡片尺寸，320px 宽下
 *     量化误差 < 0.005px，远小于像素），相邻点做 zigzag + LEB128 varint
 *     差分（相邻点通常只差 1~3 个量化单位，一字节居多）；笔宽同样 u16
 *     定点。单字节级联，无字段名开销。
 *     位图：只存 alpha 平面（遮罩只有 alpha 有意义，RGB 恒 0），按
 *     行自适应 RLE——刮痕是稀疏笔迹，整行透明的空白行压成 3 字节；
 *     含抗锯齿边缘的噪点行则原样存储，保证 RLE 永不把数据放大。
 *
 * 布局（小端序）：
 *   magic 'S''C''1' | u8 version(=1)
 *   f32 cssWidth | f32 cssHeight | u8 dprFixed1(=round(dpr*10)) | u8 progress | u8 finished
 *   varint strokeCount
 *     每笔：varint slotIndex | u16 widthFixed | u8 flags(bit0=alive)
 *           varint pointCount | 每点 zigzagVarint dx, zigzagVarint dy（相对上一点，初始 prev=0）
 *   varint solidTo
 *   u8 solidPresent  （存在时）u8 cell | u16 cols | u16 rows | u32 len | alpha 网格
 *   u8 permPresent   （存在时）同上
 *   varint redoCount | 每项 varint slotIndex
 *
 * 网格每行：u8 tag（0=原始，后接 cols 字节；1=RLE，后接若干 [varint run,u8 value]）
 */

export const SNAPSHOT_VERSION = 1
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024

const MAGIC = [0x53, 0x43, 0x31] // 'SC1'
const FIXED_ONE = 65535 // 归一化坐标 / 笔宽的定点基数

/* ---------------- varint / zigzag（LEB128 小端） ---------------- */

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
    if (shift > 35) throw new Error('[scratch] snapshot varint 溢出')
  }
  return result >>> 0
}

const zigzagEncode = (n) => ((n << 1) ^ (n >> 31)) >>> 0
const zigzagDecode = (n) => (n >>> 1) ^ -(n & 1)

/* ---------------- 可增长字节缓冲 writer ---------------- */

class ByteWriter {
  constructor() {
    this.buf = new Uint8Array(256)
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

  u8(value) {
    this.ensure(1)
    this.buf[this.len++] = value & 0xff
  }

  u16(value) {
    this.ensure(2)
    this.view.setUint16(this.len, value, true)
    this.len += 2
  }

  u32(value) {
    this.ensure(4)
    this.view.setUint32(this.len, value, true)
    this.len += 4
  }

  f32(value) {
    this.ensure(4)
    this.view.setFloat32(this.len, value, true)
    this.len += 4
  }

  bytes(array) {
    this.ensure(array.length)
    this.buf.set(array, this.len)
    this.len += array.length
  }

  toUint8Array() {
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
    if (this.pos >= this.bytes.length) throw new Error('[scratch] snapshot 意外结尾')
    return this.bytes[this.pos++]
  }

  u16() {
    const value = this.view.getUint16(this.pos, true)
    this.pos += 2
    return value
  }

  u32() {
    const value = this.view.getUint32(this.pos, true)
    this.pos += 4
    return value
  }

  f32() {
    const value = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return value
  }

  take(length) {
    if (this.pos + length > this.bytes.length) {
      throw new Error('[scratch] snapshot 网格数据不完整')
    }
    const slice = this.bytes.subarray(this.pos, this.pos + length)
    this.pos += length
    return slice
  }
}

/* ---------------- alpha 网格：逐行自适应 RLE ---------------- */

function encodeGrid(writer, alpha, cols, rows, cell) {
  writer.u8(cell)
  writer.u16(cols)
  writer.u16(rows)

  // 先在临时缓冲里编码行数据，长度确定后再写 u32 长度前缀
  const payload = new ByteWriter()
  for (let row = 0; row < rows; row++) {
    const offset = row * cols
    // 统计本行 RLE 游程
    const runs = []
    let runStart = 0
    while (runStart < cols) {
      const value = alpha[offset + runStart]
      let end = runStart + 1
      while (end < cols && alpha[offset + end] === value) end++
      runs.push(end - runStart, value)
      runStart = end
    }
    // RLE 开销：每游程 1 字节值 + varint 长度（短游程 1 字节）；
    // 原始开销：cols 字节。取小者，噪点行永不膨胀。
    let rleBytes = 0
    for (let i = 0; i < runs.length; i += 2) {
      rleBytes += 1 + (runs[i] < 0x80 ? 1 : 2)
    }
    if (rleBytes < cols) {
      payload.u8(1)
      for (let i = 0; i < runs.length; i += 2) {
        writeVarint(payload, runs[i])
        payload.u8(runs[i + 1])
      }
    } else {
      payload.u8(0)
      payload.bytes(alpha.subarray(offset, offset + cols))
    }
  }

  writer.u32(payload.len)
  writer.bytes(payload.toUint8Array())
}

function decodeGrid(reader) {
  const cell = reader.u8()
  const cols = reader.u16()
  const rows = reader.u16()
  if (!cols || !rows || cols > 16384 || rows > 16384) {
    throw new Error('[scratch] snapshot 网格尺寸非法')
  }
  const length = reader.u32()
  const body = reader.take(length)
  const gridReader = new ByteReader(body)
  const alpha = new Uint8Array(cols * rows)

  for (let row = 0; row < rows; row++) {
    const tag = gridReader.u8()
    const offset = row * cols
    if (tag === 0) {
      const raw = gridReader.take(cols)
      alpha.set(raw, offset)
    } else if (tag === 1) {
      let filled = 0
      while (filled < cols) {
        const run = readVarint(gridReader)
        const value = gridReader.u8()
        if (!run || filled + run > cols) {
          throw new Error('[scratch] snapshot RLE 游程非法')
        }
        alpha.fill(value, offset + filled, offset + filled + run)
        filled += run
      }
    } else {
      throw new Error('[scratch] snapshot 网格行类型非法')
    }
  }
  return { cell, cols, rows, alpha }
}

/* ---------------- 对外：编码 / 解码 ---------------- */

/**
 * @param {object} data
 *   cssWidth/cssHeight:number（CSS 像素）、dpr:number、progress:number(0-100)
 *   strokes: Array<{ i:slotIndex, w:归一化笔宽, alive:boolean, pts:[[x,y]...] }>
 *   solidTo:number  solid:null|{cell,cols,rows,alpha}  perm: 同 solid
 *   redo:number[]（slotIndex 栈）
 * @returns {Uint8Array}（字节数 <= SNAPSHOT_MAX_BYTES，否则抛错）
 */
export function encodeSnapshot(data) {
  const writer = new ByteWriter()
  MAGIC.forEach((b) => writer.u8(b))
  writer.u8(SNAPSHOT_VERSION)
  writer.f32(data.cssWidth)
  writer.f32(data.cssHeight)
  writer.u8(Math.round(data.dpr * 10))
  writer.u8(Math.max(0, Math.min(100, Math.round(data.progress))))
  writer.u8(data.finished ? 1 : 0)

  writeVarint(writer, data.strokes.length)
  for (const item of data.strokes) {
    writeVarint(writer, item.i)
    writer.u16(Math.max(0, Math.min(FIXED_ONE, Math.round(item.w * FIXED_ONE))))
    writer.u8(item.alive ? 1 : 0)
    writeVarint(writer, item.pts.length)

    let prevX = 0
    let prevY = 0
    for (const [nx, ny] of item.pts) {
      const qx = Math.max(0, Math.min(FIXED_ONE, Math.round(nx * FIXED_ONE)))
      const qy = Math.max(0, Math.min(FIXED_ONE, Math.round(ny * FIXED_ONE)))
      writeVarint(writer, zigzagEncode(qx - prevX))
      writeVarint(writer, zigzagEncode(qy - prevY))
      prevX = qx
      prevY = qy
    }
  }

  writeVarint(writer, data.solidTo)
  if (data.solid) {
    writer.u8(1)
    encodeGrid(writer, data.solid.alpha, data.solid.cols, data.solid.rows, data.solid.cell)
  } else {
    writer.u8(0)
  }
  if (data.perm) {
    writer.u8(1)
    encodeGrid(writer, data.perm.alpha, data.perm.cols, data.perm.rows, data.perm.cell)
  } else {
    writer.u8(0)
  }

  writeVarint(writer, data.redo.length)
  for (const index of data.redo) writeVarint(writer, index)

  const bytes = writer.toUint8Array()
  if (bytes.length > SNAPSHOT_MAX_BYTES) {
    throw new Error(
      `[scratch] 快照体积 ${bytes.length} 字节超过 ${SNAPSHOT_MAX_BYTES} 字节上限；` +
        '请提高存档网格精度参数或减少笔迹规模'
    )
  }
  return bytes
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns 与 encodeSnapshot 入参同构的数据（pts 为普通二维数组）
 */
export function decodeSnapshot(input) {
  let bytes
  if (input instanceof Uint8Array) {
    bytes = input
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input)
  } else {
    throw new Error('[scratch] restore 需要 Uint8Array 或 ArrayBuffer 快照')
  }
  if (bytes.length < 5 || MAGIC.some((b, idx) => bytes[idx] !== b)) {
    throw new Error('[scratch] 快照 magic 不合法，不是刮刮卡存档')
  }
  const reader = new ByteReader(bytes)
  MAGIC.forEach(() => reader.u8())
  const version = reader.u8()
  if (version !== SNAPSHOT_VERSION) {
    throw new Error(`[scratch] 不支持的快照版本：${version}`)
  }

  const cssWidth = reader.f32()
  const cssHeight = reader.f32()
  const dprFixed1 = reader.u8()
  const progress = reader.u8()
  const finished = reader.u8() === 1
  if (!(cssWidth > 0 && cssHeight > 0)) {
    throw new Error('[scratch] 快照尺寸非法')
  }

  const strokeCount = readVarint(reader)
  if (strokeCount > 1_000_000) throw new Error('[scratch] 快照笔数非法')
  const strokes = []
  for (let n = 0; n < strokeCount; n++) {
    const i = readVarint(reader)
    const wFixed = reader.u16()
    const alive = reader.u8() === 1
    const pointCount = readVarint(reader)
    if (pointCount === 0 || pointCount > 1_000_000) {
      throw new Error('[scratch] 快照笔画点数非法')
    }
    const pts = []
    let x = 0
    let y = 0
    for (let p = 0; p < pointCount; p++) {
      x += zigzagDecode(readVarint(reader))
      y += zigzagDecode(readVarint(reader))
      if (x < 0 || x > FIXED_ONE || y < 0 || y > FIXED_ONE) {
        throw new Error('[scratch] 快照笔画坐标越界')
      }
      pts.push([x / FIXED_ONE, y / FIXED_ONE])
    }
    strokes.push({ i, w: wFixed / FIXED_ONE, alive, pts })
  }

  const solidTo = readVarint(reader)
  const solidPresent = reader.u8() === 1
  const solid = solidPresent ? decodeGrid(reader) : null
  const permPresent = reader.u8() === 1
  const perm = permPresent ? decodeGrid(reader) : null

  const redoCount = readVarint(reader)
  if (redoCount > strokeCount) throw new Error('[scratch] 快照 redo 栈非法')
  const redo = []
  for (let n = 0; n < redoCount; n++) redo.push(readVarint(reader))

  return {
    cssWidth,
    cssHeight,
    dpr: dprFixed1 / 10,
    progress,
    finished,
    strokes,
    solidTo,
    solid,
    perm,
    redo,
  }
}
