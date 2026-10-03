<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 通用刮刮卡组件（v3：运营级改造）
 *
 * 在 v2「归一化坐标矢量笔迹 + resize/DPR 变化时无损重放」的基础上新增：
 * 1. 笔画粒度的 undo() / redo()（canUndo / canRedo 响应式状态，maxHistory 截断）
 * 2. 分层缓存：超过 rasterizeAfter 笔后把已确认笔迹「固化」为遮罩位图，
 *    resize / 换肤时只重放「固化位图 + 少量未固化增量」，5000 笔与 50 笔
 *    的重放开销基本一致；固化位图记录的是「划痕 alpha 遮罩」（黑色笔画
 *    打在透明底），与涂层颜色 / 文案完全解耦。
 * 3. save() / restore(snapshot)：手写紧凑二进制快照（base64 封装为
 *    JSON 可序列化对象），含笔迹、固化遮罩、进度百分比。
 *
 * 三个事实来源（任何时刻）：
 * - strokes：「撤销窗口内」的矢量笔（窗口相对、0 起下标；被 maxHistory
 *   挤出的永久段笔已不在数组中，点集也已释放）。其中 [0, k) 为窗口内
 *   已固化段，[k, strokes.length) 为未固化增量，k = bakedCount -
 *   permanentCount（bakedInWindow()）。刚按下尚未抬手的活动笔不在这里，
 *   而在 activePointers 中（见 onPointerDown / commitStroke）。
 * - bakeCanvas / frozenCanvas：两张归一化分辨率的「黑色划痕遮罩」
 *   （透明底 + source-over 黑，alpha 即刮除强度，重建时 destination-out
 *   抠除，见 bakeMaskStroke）。frozen 覆盖已永久化的 [0, permanentCount)；
 *   bake 覆盖「frozen + 窗口固化段」。它们是 resize / 换肤重放成本与
 *   总笔数解耦的关键；无任何固化笔时退化为纯矢量重放。
 * - 进度百分比：由降采样小画布实测，并把最近一次结果计入快照。
 *
 * 全程不出现全图 getImageData：唯一读像素的路径是降采样网格（约 12px
 * 间距的小画布）；固化用纯矢量绘制，快照的遮罩网格读取也是降采样读取
 * （drawImage 缩放），从不按设备分辨率读全图。
 */

const props = defineProps({
  /** 卡片宽度（CSS 像素，数字按 px 处理）；responsive 为 true 时失效 */
  width: { type: [Number, String], default: 320 },
  /** 卡片高度（CSS 像素，数字按 px 处理）；responsive 为 true 时失效 */
  height: { type: [Number, String], default: 180 },
  /** 响应式模式：宽度撑满父容器，高度由 aspectRatio 推导，自动跟随容器尺寸 */
  responsive: { type: Boolean, default: false },
  /** 响应式模式下的宽高比（宽/高），数字或 '16/9' 这类字符串 */
  aspectRatio: { type: [Number, String], default: 16 / 9 },
  /** 自动清除涂层的刮开面积阈值（0-100），运行中修改立即生效 */
  threshold: { type: Number, default: 40 },
  /** 笔刷直径（CSS 像素） */
  brushSize: { type: Number, default: 28 },
  /** 涂层底色，运行中修改立即重绘且保留刮痕 */
  coverColor: { type: String, default: '#b8bcc6' },
  /** 涂层上的提示文案，传空字符串则不绘制；运行中修改立即重绘 */
  coverText: { type: String, default: '刮开查看奖品' },
  /** 达到阈值后涂层淡出时长（ms） */
  fadeDuration: { type: Number, default: 500 },
  /**
   * 撤销栈深度上限（笔）。undo 只能回退到这个窗口内；窗口外最旧的笔画
   * 在提交新笔画时被永久丢弃（同时并入 frozen 遮罩、释放其点集内存）。
   * 默认 200：覆盖典型运营场景的「反悔」需求，又能给 5000 笔长会话
   * 封顶内存（窗口外的点集会被释放，常驻内存只剩 frozen 遮罩网格）。
   */
  maxHistory: { type: Number, default: 200 },
  /**
   * 固化阈值（笔）。可撤销窗口内保留的矢量笔画达到该数量后，超出的
   * 「最旧已确认笔画」被固化进位图遮罩；此后 resize / 换肤重放成本与
   * 总笔画数无关（位图 drawImage + 少量增量矢量）。默认 500。
   */
  rasterizeAfter: { type: Number, default: 500 },
})

const emit = defineEmits(['progress', 'finish'])

const rootRef = ref(null)
const canvasRef = ref(null)

/** 是否还能撤销 / 重做（defineExpose 暴露给父组件，模板 ref 自动解包） */
const canUndo = ref(false)
const canRedo = ref(false)

let ctx = null
let dpr = 1
let cssWidth = 0
let cssHeight = 0
let initialized = false

/** 是否已经完成（达到阈值，正在/已经淡出）；完成后 undo/redo 禁用 */
let finished = false

/**
 * 已刮笔画的矢量记录。
 * 每笔：{ w: 笔宽/卡宽, pts: [[x/卡宽, y/卡高], ...] }，全部归一化。
 */
const strokes = []
/** 被 undo 取下、等待 redo 的笔画（按原顺序，redo 时依次压回） */
const redoStack = []
/** 已永久化（挤出撤销窗口）的笔数（绝对计数）；这些笔仅存于 frozen 遮罩 */
let permanentCount = 0
/** 已固化进 bakeCanvas 的笔数（绝对计数，含永久段）；
 *  窗口内固化数 = bakedCount - permanentCount = strokes 的固化分界 k */
let bakedCount = 0

/**
 * 固化遮罩离屏画布（归一化分辨率 GRID_W × GRID_H，与设备尺寸无关）。
 * 内容：透明底 + 黑色划痕（alpha 即刮除强度）。重建涂层时把它按当前
 * CSS 尺寸 drawImage 进来，再以 destination-out 抠除——遮罩本身不含
 * 涂层颜色，所以换肤（coverColor/coverText）无需重建遮罩。
 * 选固定归一化网格而非设备分辨率：① 内存恒定（约 340×190×4 ≈ 0.26MB），
 * ② save() 可直接编码、体积可控，③ scratch 路径从不画它，只在提交笔画
 * 时做一次增量矢量绘制，与实时刮擦互不阻塞。
 */
let bakeCanvas = null
let bakeCtx = null
/** frozenCanvas：[0, permanentCount) 的永久遮罩；bakeCanvas 重建时的底座 */
let frozenCanvas = null
let frozenCtx = null

/** 归一化遮罩网格尺寸（宽固定 360，高按卡片宽高比取整，至少 1） */
const GRID_W = 360
let gridW = GRID_W
let gridH = 180

/**
 * 遮罩「拍平」周期（笔）。
 * 背景：canvas 的 drawImage(srcCanvas) 在不少浏览器实现里（尤其软件
 * 光栅化 / headless）会按源画布累积的 2D 显示列表重新光栅化——只往同一
 * 画布增量画 5000 笔后，一次 drawImage 就要为这 5000 笔付费（实测
 * 59ms）。为此每累积 FLATTEN_MASK_OPS 次矢量绘制，就把遮罩画进一张
 * 全新空画布（drawImage 一次完成栅格化、丢弃旧显示列表），此后该遮罩
 * 是「纯像素图」，再被 drawImage 时成本恒定（约 0.1ms），与历史总笔数
 * 无关。256 是「单次拍平代价 ≤ 数毫秒」与「拍平频率足够低」的折中。
 */
const FLATTEN_MASK_OPS = 256
let bakeOpsSinceFlatten = 0
let frozenOpsSinceFlatten = 0

/** 各指针的进行状态：pointerId -> { prev: CSS像素坐标, stroke: 当前笔画 } */
const activePointers = new Map()

/* ---------- 进度采样相关 ---------- */

const SAMPLE_GRID = 12
let sampleCanvas = null
let sampleCtx = null
let sampleCols = 0
let sampleRows = 0
let sampleTimer = 0
let lastMeasureAt = 0
const MEASURE_INTERVAL = 160
/** 最近一次实测进度（save 入快照；restore 后先沿用，首次实测再校正） */
let lastPercent = 0

/* ---------- 尺寸自适应 ---------- */

let resizeObserver = null
let dprMediaQuery = null
let rebuildRaf = 0
/**
 * 单调递增的重建代号。rAF 重建是异步的：save() 可能在重建挂起期间被
 * 调用。每次发起重建都 ++generation，重建真正执行时若发现自己已过期
 * （有更新的重建排队）就跳过——save 则用同步重放保证快照与当前矢量
 * 状态一致（见 saveSnapshot 注释），二者不需要共享可变中间态。
 */
let rebuildGeneration = 0
/** restore 进行中：抑制 rebuildCanvas 内部的自动进度实测（恢复应沿用
 *  快照进度，避免恢复瞬间因当前 threshold 更低而误触发 finish） */
let restoreInProgress = false

/* ==========================================================================
 * 快照编解码（手写紧凑格式，无第三方依赖）
 * --------------------------------------------------------------------------
 * 选型论证（2MB 约束）：
 * - 不用「整张 canvas toDataURL('image/png') 再 base64」作为笔迹载体：
 *   PNG 编码的是设备分辨率位图（3x 屏上 520×293 的卡就是 1560×879），
 *   5000 笔叠加后 base64 PNG 仍可能数百 KB~数 MB，且 base64 再膨胀 33%，
 *   2MB 预算不可控；位图也无法支持 restore 后的矢量级 undo 跨边界
 *   回退与 DPR 无损放大。
 * - 笔迹走「归一化 16bit 量化 + 相邻点差分 + zigzag + LEB128 varint」：
 *   坐标量化到 1/65535（在 1000px 卡片上误差 < 0.016px，亚像素级，对
 *   圆头笔刷视觉无损）；笔迹相邻点位移很小，zigzag 后多为小正整数，
 *   varint 平均每轴 1~2 字节。实测一笔（约 30 个点）约 60~110 字节，
 *   5000 笔约 0.3~0.6MB；而能进入快照的矢量笔最多 maxHistory(默认 200) +
 *   rasterizeAfter(默认 500) 量级（更早的只留遮罩），通常仅 20~70KB。
 * - 固化/永久遮罩只存「永久层」一张归一化 alpha 网格（360×按宽高比），
 *   固化层在 restore 时由永久层 + 窗口内矢量笔现场重固化（矢量笔本来就
 *   要为 undo 保留，不额外占位图预算）；alpha 用 PackBits RLE 压缩，
 *   刮痕通常稀疏，压缩后几 KB~几十 KB。
 * - 总体典型 < 100KB、上限远低于 2MB；save() 仍对序列化结果做硬校验，
 *   超过 2MB 直接抛错（调用方可调小 maxHistory / 换更窄卡片宽高比）。
 *
 * 二进制布局（小端序）：
 *   magic 'SC3'(3B) | ver u8
 *   flags u8（bit0: finished）| percent u8
 *   gridW u16 | gridH u16
 *   permanentCount varuint | savedBaked varuint（固化层相对永久层的笔数）
 *   frozenAlpha PackBits 流（u32 压缩长度 + 压缩字节；展开为 gridW*gridH alpha）
 *   confirmedCount varuint（窗口内已确认矢量笔，从 permanentCount 起）
 *   每笔：w u16 | pointCount varuint | 点序列（首点绝对、其后差分，
 *         每轴 zigzag-varint，量化域 0..65535）
 *   activeCount varuint + 活动笔（编码同上；restore 时提升为已确认笔）
 *   redoCount varuint + redo 栈笔（编码同上）
 * 最后整体 base64 包成 { v: 3, d: '...' }，JSON.stringify 可直接入
 * localStorage / 接口报文。
 * ======================================================================== */

const SNAP_MAGIC = 'SC3'
const SNAP_VERSION = 1
const SNAP_LIMIT = 2 * 1024 * 1024
const COORD_SCALE = 65535

class ByteWriter {
  constructor() {
    this.bytes = []
  }
  u8(value) {
    this.bytes.push(value & 0xff)
  }
  u16(value) {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff)
  }
  u32(value) {
    this.bytes.push(
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff
    )
  }
  /** LEB128 无符号 varint */
  varuint(value) {
    let v = Math.floor(value)
    while (v >= 0x80) {
      this.bytes.push((v & 0x7f) | 0x80)
      v >>>= 7
    }
    this.bytes.push(v)
  }
  /** zigzag 后 varint：把小幅度有符号差分映射为小的无符号数 */
  varsint(value) {
    this.varuint((value << 1) ^ (value >> 31))
  }
  raw(buffer) {
    for (let i = 0; i < buffer.length; i++) this.bytes.push(buffer[i])
  }
  toUint8() {
    return new Uint8Array(this.bytes)
  }
}

class ByteReader {
  constructor(bytes) {
    this.b = bytes
    this.i = 0
  }
  u8() {
    return this.b[this.i++]
  }
  u16() {
    const v = this.b[this.i] | (this.b[this.i + 1] << 8)
    this.i += 2
    return v >>> 0
  }
  u32() {
    const v =
      (this.b[this.i] |
        (this.b[this.i + 1] << 8) |
        (this.b[this.i + 2] << 16) |
        (this.b[this.i + 3] << 24)) >>> 0
    this.i += 4
    return v
  }
  varuint() {
    let shift = 0
    let result = 0
    let byte
    do {
      byte = this.b[this.i++]
      result |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    return result >>> 0
  }
  varsint() {
    const z = this.varuint()
    return (z >>> 1) ^ -(z & 1)
  }
  bytes(length) {
    const slice = this.b.subarray(this.i, this.i + length)
    this.i += length
    return slice
  }
}

/** PackBits（TGA 同款 RLE）：对重复行程用 1 字节计数字节压缩 */
function packBits(data) {
  const out = new ByteWriter()
  const n = data.length
  let i = 0
  while (i < n) {
    let run = 1
    while (i + run < n && data[i + run] === data[i] && run < 128) run++
    if (run >= 3) {
      out.u8(257 - run) // PackBits 重复头：-(run-1) 的无符号字节表示
      out.u8(data[i])
      i += run
    } else {
      const start = i
      let literal = 0
      while (i < n && literal < 128) {
        run = 1
        while (i + run < n && data[i + run] === data[i] && run < 128) run++
        if (run >= 3) break
        i++
        literal++
      }
      out.u8(literal - 1)
      for (let j = 0; j < literal; j++) out.u8(data[start + j])
    }
  }
  return out.toUint8()
}

function unpackBytes(compressed, expected) {
  const out = new Uint8Array(expected)
  let p = 0
  let i = 0
  while (i < compressed.length) {
    const head = compressed[i++]
    if (head < 128) {
      const count = head + 1
      for (let k = 0; k < count; k++) out[p++] = compressed[i++]
    } else {
      const count = 257 - head
      const value = compressed[i++]
      for (let k = 0; k < count; k++) out[p++] = value
    }
  }
  return out
}

/** 分块 base64，避免 String.fromCharCode 大参数爆栈 */
function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunk, bytes.length))
    )
  }
  return btoa(binary)
}

function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/* ---------- 尺寸 / 几何 ---------- */

function toCssSize(value) {
  return typeof value === 'number' ? `${value}px` : value
}

const cardStyle = computed(() => {
  if (props.responsive) {
    return { width: '100%', aspectRatio: String(props.aspectRatio) }
  }
  return { width: toCssSize(props.width), height: toCssSize(props.height) }
})

/**
 * 遮罩网格高度跟随卡片宽高比，使网格像素近似正方形：
 * 固化遮罩按卡片矩形拉伸重放，网格正方形意味着横纵缩放率一致，
 * 固化划痕不会被拉成椭圆。
 */
function deriveGridH() {
  const ratio =
    cssWidth > 0 && cssHeight > 0 ? cssWidth / cssHeight : 16 / 9
  return Math.max(1, Math.round(GRID_W / ratio))
}

/**
 * rAF 合并重建（同 v2）：每帧最多一次，刮擦进行中画布始终跟手。
 * 重建是幂等的「按当前事实来源全量重绘」，所以排队期间发生的
 * undo / 笔画提交 / 换肤都不需要特殊排队——真正执行时读到的就是
 * 最新状态；generation 只用于让被更后续重建取代的过期帧直接返回。
 */
function scheduleRebuild() {
  if (rebuildRaf) return
  const generation = ++rebuildGeneration
  rebuildRaf = requestAnimationFrame(() => {
    rebuildRaf = 0
    if (generation !== rebuildGeneration) return
    rebuildCanvas()
  })
}

function watchDpr() {
  if (dprMediaQuery) {
    dprMediaQuery.removeEventListener('change', scheduleRebuild)
  }
  dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  dprMediaQuery.addEventListener('change', scheduleRebuild)
}

/**
 * 重建 backing store 并无损恢复涂层与刮痕（v2 路径，重放已分层）。
 * @param {boolean} force true 时跳过「尺寸未变」短路（reset / restore 用）
 */
function rebuildCanvas(force = false) {
  const canvas = canvasRef.value
  if (!canvas) return

  watchDpr()

  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const nextDpr = Math.min(window.devicePixelRatio || 1, 3)

  if (
    !force &&
    initialized &&
    nextDpr === dpr &&
    Math.abs(rect.width - cssWidth) < 0.5 &&
    Math.abs(rect.height - cssHeight) < 0.5
  ) {
    return
  }

  cssWidth = rect.width
  cssHeight = rect.height
  dpr = nextDpr
  initialized = true

  const nextGridH = deriveGridH()
  // 宽高比变化（responsive 下改 aspectRatio）会让旧网格像素不再是
  // 正方形：按新宽高比重建两张遮罩并从矢量重新固化。永久段矢量点集已
  // 释放，但其划痕在 frozenCanvas 里——按旧矩形内容重采样到新矩形
  // （drawImage 拉伸），归一化坐标不变，划痕位置与全量矢量重放等价。
  if (nextGridH !== gridH) {
    reshapeMasks(GRID_W, nextGridH)
  }
  gridH = nextGridH

  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  repaint()
  initSampler()

  for (const active of activePointers.values()) {
    const last = active.stroke.pts[active.stroke.pts.length - 1]
    active.prev = { x: last[0] * cssWidth, y: last[1] * cssHeight }
  }

  if (!finished && !restoreInProgress && hasAnyScratch()) measureProgress()
}

/**
 * 涂层全量重绘（resize / 换肤 / undo / restore 共用）：
 * 纯色+文案涂层 → 冻结遮罩 → 固化遮罩（在冻结之上叠加）→ 未固化矢量。
 * 三层合起来等价于「从第 0 笔起全量矢量重放」（见 bakeMaskStroke），
 * 但 drawImage 成本与笔画数无关，这是 5000 笔下 resize 不退化的关键。
 */
function repaint() {
  paintCover()
  ctx.globalCompositeOperation = 'destination-out'
  // bakeCanvas 恒为 frozenCanvas 的超集（永久化时会把出窗笔补画进 bake，
  // 见 applyMaxHistoryInvariant），且会被周期性拍平为纯像素图，所以这里
  // 只需一次成本与总笔数无关的 drawImage；frozen 仅用于 bake 重建 /
  // reshape / save。
  if (bakedCount > 0 && bakeCanvas) {
    ctx.drawImage(bakeCanvas, 0, 0, cssWidth, cssHeight)
  }
  // strokes 是「窗口相对」数组（永久段已移出），未固化段起点就是 k。
  replayStrokes(bakedInWindow(), strokes.length)
  // 进行中的多指笔迹不属于撤销栈，但 resize / 换肤 / undo 触发的重绘
  // 必须把它们一并还原，否则手指还按着时涂层会「丢掉」当前划痕。
  for (const active of activePointers.values()) {
    paintOneStroke(active.stroke)
  }
}

/** 窗口内已固化（存在 bakeCanvas 里）的笔画数；同时也是 strokes 中
 *  固化段 / 未固化段的分界下标 */
function bakedInWindow() {
  return Math.max(0, bakedCount - permanentCount)
}

function paintCover() {
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  ctx.fillStyle = props.coverColor
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  if (props.coverText) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    const fontSize = Math.round(
      Math.min(Math.max(Math.min(cssWidth, cssHeight) * 0.09, 12), 32)
    )
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(props.coverText, cssWidth / 2, cssHeight / 2)
  }
}

/**
 * 把 strokes 中 [start, end) 区间的归一化矢量笔以 destination-out 重放。
 * 下标均为窗口相对（永久段已移出 strokes）。
 */
function replayStrokes(start, end) {
  if (end <= start) return
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (let i = start; i < end; i++) {
    paintOneStroke(strokes[i])
  }
}

/** 在当前 ctx（CSS 像素坐标系）以 destination-out 画一笔归一化矢量笔迹 */
function paintOneStroke(stroke) {
  const lineWidth = stroke.w * cssWidth
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.moveTo(stroke.pts[0][0] * cssWidth, stroke.pts[0][1] * cssHeight)
  for (let i = 1; i < stroke.pts.length; i++) {
    ctx.lineTo(stroke.pts[i][0] * cssWidth, stroke.pts[i][1] * cssHeight)
  }
  ctx.stroke()
  paintStrokeCaps(stroke, lineWidth / 2)
}

/** 首尾补圆，单点轻点也能复现完整圆点笔痕 */
function paintStrokeCaps(stroke, radius) {
  ctx.beginPath()
  ctx.arc(
    stroke.pts[0][0] * cssWidth,
    stroke.pts[0][1] * cssHeight,
    radius,
    0,
    Math.PI * 2
  )
  ctx.fill()
  const last = stroke.pts[stroke.pts.length - 1]
  ctx.beginPath()
  ctx.arc(last[0] * cssWidth, last[1] * cssHeight, radius, 0, Math.PI * 2)
  ctx.fill()
}

/* ---------- 分层遮罩（固化位图） ---------- */

function ensureMaskCanvases() {
  if (!bakeCanvas) {
    bakeCanvas = document.createElement('canvas')
    bakeCanvas.width = gridW
    bakeCanvas.height = gridH
    bakeCtx = bakeCanvas.getContext('2d')
  }
  if (!frozenCanvas) {
    frozenCanvas = document.createElement('canvas')
    frozenCanvas.width = gridW
    frozenCanvas.height = gridH
    frozenCtx = frozenCanvas.getContext('2d')
  }
}

/**
 * 把遮罩画布「拍平」：将其当前像素画进一张全新空画布并替换。
 * 新画布没有历史 2D 显示列表，之后被 drawImage 只做一次图像拷贝，
 * 成本恒定，不再随累积笔画数上升（见 FLATTEN_MASK_OPS 的论证）。
 */
function flattenBake() {
  const flat = document.createElement('canvas')
  flat.width = gridW
  flat.height = gridH
  flat.getContext('2d').drawImage(bakeCanvas, 0, 0)
  bakeCanvas = flat
  bakeCtx = bakeCanvas.getContext('2d')
  bakeOpsSinceFlatten = 0
}

function flattenFrozen() {
  const flat = document.createElement('canvas')
  flat.width = gridW
  flat.height = gridH
  flat.getContext('2d').drawImage(frozenCanvas, 0, 0)
  frozenCanvas = flat
  frozenCtx = frozenCanvas.getContext('2d')
  frozenOpsSinceFlatten = 0
}

/**
 * 把一笔矢量划痕增量画进遮罩画布。
 * 遮罩语义：透明底 + source-over 黑色，已刮处 alpha=255。它与涂层
 * 颜色 / 文案无关——重建时涂层先整体画好，再用 destination-out 按
 * 遮罩 alpha 抠除，故遮罩只需构建一次，换肤 / resize 都不重建
 * （仅宽高比变化时整体重采样，见 reshapeMasks）。
 * 多个重叠笔画的边缘半透明像素叠加后 alpha 单调增大，与直接在涂层
 * 上逐笔 destination-out 的累积结果一致（同一覆盖序列，结合律）。
 */
function bakeMaskStroke(target, stroke) {
  target.globalCompositeOperation = 'source-over'
  target.strokeStyle = '#000'
  target.fillStyle = '#000'
  target.lineCap = 'round'
  target.lineJoin = 'round'
  target.lineWidth = stroke.w * gridW
  target.beginPath()
  target.moveTo(stroke.pts[0][0] * gridW, stroke.pts[0][1] * gridH)
  for (let i = 1; i < stroke.pts.length; i++) {
    target.lineTo(stroke.pts[i][0] * gridW, stroke.pts[i][1] * gridH)
  }
  target.stroke()
  const radius = (stroke.w * gridW) / 2
  target.beginPath()
  target.arc(
    stroke.pts[0][0] * gridW,
    stroke.pts[0][1] * gridH,
    radius,
    0,
    Math.PI * 2
  )
  target.fill()
  const last = stroke.pts[stroke.pts.length - 1]
  target.beginPath()
  target.arc(last[0] * gridW, last[1] * gridH, radius, 0, Math.PI * 2)
  target.fill()
}

/**
 * 网格尺寸 / 宽高比变化时重建两张遮罩：
 * - frozen：旧 frozen 位图整体拉伸到新矩形（永久段的划痕只存在于位图，
 *   归一化坐标下位置不变；拉伸重采样与「按新矩形重放同一批归一化笔」
 *   对圆头笔刷视觉等价，边缘差异仅一个网格像素，约 0.05px CSS）。
 * - bake：frozen 重采样后，再把窗口内已固化矢量 [0, bakedInWindow())
 *   重新增量固化，保证可撤销段始终是矢量级精度。
 */
function reshapeMasks(newW, newH) {
  ensureMaskCanvases()
  const oldFrozen = document.createElement('canvas')
  oldFrozen.width = frozenCanvas.width
  oldFrozen.height = frozenCanvas.height
  oldFrozen.getContext('2d').drawImage(frozenCanvas, 0, 0)

  // 先更新模块级网格维度，下面 bakeMaskStroke 必须按新网格坐标绘制，
  // 否则画布已是 newH 高而笔画还按旧 gridH 定位会错位。
  gridW = newW
  gridH = newH

  frozenCanvas.width = newW
  frozenCanvas.height = newH
  frozenCtx = frozenCanvas.getContext('2d')
  frozenCtx.drawImage(oldFrozen, 0, 0, newW, newH)

  // bake 按新矩形从「重采样后的 frozen + 窗口固化矢量」重建（含拍平）
  bakeCanvas.width = newW
  bakeCanvas.height = newH
  bakeCtx = bakeCanvas.getContext('2d')
  bakeOpsSinceFlatten = 0
  rebuildBakeMask()
}

/**
 * 从矢量全量重固化 bakeCanvas（底座为 frozenCanvas）。
 * 用于 undo 跨越固化边界：撤销的是已固化段最旧的一笔时，无法从位图
 * 「减」掉一笔（alpha 不可逆），改为从 frozen + 仍固化的矢量重新构建
 * 整张 bakeCanvas。其结果与「涂层全量重放全部剩余矢量笔」逐像素等价
 * （同一批笔、同一绘制顺序），只是这一步只在跨边界 undo/redo 时发生，
 * 成本 ≤ rasterizeAfter 笔的矢量绘制（默认 500 笔，亚毫秒~几毫秒）。
 */
function rebuildBakeMask() {
  ensureMaskCanvases()
  bakeCanvas.width = gridW
  bakeCanvas.height = gridH
  bakeCtx = bakeCanvas.getContext('2d')
  bakeCtx.clearRect(0, 0, gridW, gridH)
  if (permanentCount > 0) bakeCtx.drawImage(frozenCanvas, 0, 0)
  const end = bakedInWindow()
  for (let i = 0; i < end; i++) bakeMaskStroke(bakeCtx, strokes[i])
  // 重建可能一次性重放最多 rasterizeAfter 笔（跨固化边界 undo 时），
  // 立刻拍平，使随后涂层重放的 drawImage 仍是纯像素拷贝、成本恒定。
  if (end > 0 || permanentCount > 0) flattenBake()
}

/* ---------- 进度采样（降采样小画布，永不全图 getImageData） ---------- */

function initSampler() {
  sampleCols = Math.max(1, Math.round(cssWidth / SAMPLE_GRID))
  sampleRows = Math.max(1, Math.round(cssHeight / SAMPLE_GRID))
  if (!sampleCanvas) sampleCanvas = document.createElement('canvas')
  sampleCanvas.width = sampleCols
  sampleCanvas.height = sampleRows
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })
}

/* ---------- 刮除（增量立即上屏） ---------- */

function scratchSegment(fromX, fromY, toX, toY) {
  const radius = props.brushSize / 2
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineWidth = props.brushSize
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(fromX, fromY)
  ctx.lineTo(toX, toY)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(toX, toY, radius, 0, Math.PI * 2)
  ctx.fill()
}

function getPoint(event) {
  const rect = canvasRef.value.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function recordPoint(stroke, point) {
  stroke.pts.push([point.x / cssWidth, point.y / cssHeight])
}

function onPointerDown(event) {
  if (finished) return
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  const point = getPoint(event)
  // 注意：进行中的笔迹只存在 activePointers，不进 strokes（撤销栈事实
  // 来源）。这样多指同时刮时 undo 只会撤销已抬手确认的笔，绝不会误伤
  // 另一根手指还在画的活动笔迹；活动笔迹在 repaint 时单独叠加。
  const stroke = { w: props.brushSize / cssWidth, pts: [] }
  recordPoint(stroke, point)
  activePointers.set(event.pointerId, { prev: point, stroke })
  scratchSegment(point.x, point.y, point.x, point.y)
  scheduleMeasure(true)
}

function onPointerMove(event) {
  const active = activePointers.get(event.pointerId)
  if (finished || !active) return
  event.preventDefault()
  const coalesced =
    typeof event.getCoalescedEvents === 'function'
      ? event.getCoalescedEvents()
      : []
  const events = coalesced.length > 0 ? coalesced : [event]
  for (const ev of events) {
    const to = getPoint(ev)
    scratchSegment(active.prev.x, active.prev.y, to.x, to.y)
    recordPoint(active.stroke, to)
    active.prev = to
  }
  scheduleMeasure()
}

function onPointerUp(event) {
  const active = activePointers.get(event.pointerId)
  if (!active) return
  activePointers.delete(event.pointerId)
  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId)
  }
  // 抬手才把这一笔并入已确认笔迹并提交进撤销栈 / 固化队列：undo 的
  // 粒度是「一整笔」，进行中的笔画此前只存在 activePointers 中。
  strokes.push(active.stroke)
  commitStroke()
  scheduleMeasure(true)
}

/**
 * pointercancel（来电、浏览器手势打断等）：该笔未完成，既不提交进撤销
 * 栈，也要把屏幕上已画的部分抹掉——按确认笔迹全量重绘即可（活动笔不
 * 在 strokes 里，重放自然不含它）。
 */
function onPointerCancel(event) {
  if (!activePointers.has(event.pointerId)) return
  activePointers.delete(event.pointerId)
  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId)
  }
  // 活动笔被丢弃，屏幕上已画的部分按确认笔迹重绘抹除，并校正进度
  if (initialized) {
    repaint()
    if (!finished) scheduleMeasure(true)
  }
}

function hasAnyScratch() {
  return strokes.length > 0 || permanentCount > 0 || activePointers.size > 0
}

/* ---------- 撤销 / 重做 / 固化 / 永久化 ---------- */

function syncHistoryFlags() {
  canUndo.value = !finished && strokes.length > 0
  canRedo.value = !finished && redoStack.length > 0
}

/**
 * 固化不变式：未固化笔数（strokes.length - 窗口内已固化数）不超过
 * rasterizeAfter，超出则把最旧未固化笔增量固化进 bakeCanvas。
 * 常规提交每次只多 1 笔，循环只转 1 次（微秒级、pointerup 时同步执行，
 * 不阻塞 pointermove 跟手、无尖峰）；while 而非 if 也覆盖 restore 一次
 * 灌入大量矢量、运行时调小 rasterizeAfter 等批量场景。同步执行使
 * 「固化瞬间发生 undo」在单线程下没有可插入的时间点。
 */
function applyBakeInvariant() {
  ensureMaskCanvases()
  while (strokes.length - bakedInWindow() > props.rasterizeAfter) {
    bakeMaskStroke(bakeCtx, strokes[bakedInWindow()])
    bakedCount++
    // 周期拍平，保证 resize / 换肤那次 drawImage 成本不随历史笔数上涨
    if (++bakeOpsSinceFlatten >= FLATTEN_MASK_OPS) flattenBake()
  }
}

/**
 * maxHistory 不变式：窗口矢量笔超过 maxHistory 时最旧笔出窗，并入永久
 * 遮罩 frozenCanvas 后释放点集内存（长会话内存与总笔数解耦的关键）。
 * 计数要点：出窗笔若此前已固化（k>0，strokes[0] 属固化段），它本就计入
 * 绝对 bakedCount，不能再加；仅当它是未固化笔（k===0，即
 * maxHistory < rasterizeAfter 的常见配置）才同时推进 bakedCount。
 * 两种情况下都必须补画进 frozenCanvas——bakeCanvas 每次从 frozen 重建。
 */
function applyMaxHistoryInvariant() {
  while (strokes.length > props.maxHistory) {
    const wasBaked = bakedInWindow() > 0
    const oldest = strokes.shift()
    // 两张遮罩都要补这笔：
    // - frozen 是永久层事实来源（save / rebuild 的底座）；
    // - bake 必须恒为 frozen 超集——涂层重放只 drawImage(bake) 一次。
    //   当 maxHistory < rasterizeAfter（默认 200 < 500）时，出窗的是
    //   「未固化」笔，若只画进 frozen，bake 里就永远缺这一笔，重放丢痕。
    bakeMaskStroke(frozenCtx, oldest)
    bakeMaskStroke(bakeCtx, oldest)
    oldest.pts = null
    permanentCount++
    if (!wasBaked) bakedCount++
    if (++frozenOpsSinceFlatten >= FLATTEN_MASK_OPS) flattenFrozen()
    if (++bakeOpsSinceFlatten >= FLATTEN_MASK_OPS) flattenBake()
  }
}

/**
 * 提交一笔已确认笔迹（pointerup）。顺序刻意固定为
 * 清 redo → 入列 → 固化 → 永久化，全部同步完成：
 * 这样「固化瞬间」不存在可被 undo 插入的间隙（JS 单线程，提交期间
 * 不会派发其他事件），从根上消除「固化瞬间发生 undo」的竞态——
 * undo 永远只能看到提交前或提交后的一致状态。
 */
/**
 * 提交一笔已确认笔迹（pointerup）。顺序固定为
 * 清 redo → 固化 → 永久化，全部同步完成：JS 单线程下提交期间不会派发
 * 其他事件，undo 永远只能看到提交前或提交后的一致状态，「固化瞬间发生
 * undo」从根上不存在可插入的间隙。
 */
function commitStroke() {
  // 经典 undo/redo 分支语义：新动作清空 redo 栈（换肤不清，见 watch 注释）
  redoStack.length = 0
  applyBakeInvariant()
  applyMaxHistoryInvariant()
  syncHistoryFlags()
}

/**
 * 撤销最近一笔已确认笔迹（笔画粒度）。
 * - 未固化笔：直接从矢量数组移除，重放 = 固化位图 + 剩余增量。
 * - 已固化笔（undo 跨越固化边界）：位图无法「减」单笔（alpha 不可逆），
 *   改为从 frozen + 仍固化矢量局部重固化 rebuildBakeMask()，结果与
 *   「全量矢量重放剩余笔」逐像素等价（同批笔同顺序），代价 ≤
 *   rasterizeAfter 笔小网格矢量重绘，仅在跨边界时发生一次。
 * 多指刮擦进行中调用也安全：活动笔迹只存在 activePointers，不在
 * strokes 中，undo 弹出的永远是已抬手确认的笔，不会误伤在画的手指。
 */
function undo() {
  if (finished || strokes.length === 0) return
  // 弹出前判定该笔是否已固化：窗口内固化段为 [0, k)，弹出位置为
  // strokes.length-1；仅当 k === strokes.length（弹出的就是固化段最旧
  // 且唯一的尾部）时它才属于固化集合。
  const poppedWasBaked = bakedInWindow() === strokes.length
  const stroke = strokes.pop()
  if (poppedWasBaked) {
    bakedCount--
    rebuildBakeMask()
  }
  redoStack.push(stroke)
  if (initialized) {
    repaint()
    if (!finished) scheduleMeasure(true)
  }
  syncHistoryFlags()
}

/**
 * 重做：按原顺序放回最近撤销的笔，然后恢复固化 / 窗口两条不变式
 * （放回的笔可能重新落回固化段；极端配置下窗口溢出则最旧笔永久化，
 * 与它从未被撤销过时的状态一致）。
 */
function redo() {
  if (finished || redoStack.length === 0) return
  strokes.push(redoStack.pop())
  applyBakeInvariant()
  applyMaxHistoryInvariant()
  if (initialized) {
    repaint()
    if (!finished) scheduleMeasure(true)
  }
  syncHistoryFlags()
}

/* ---------- 进度统计（节流 + 降采样） ---------- */

function scheduleMeasure(immediate = false) {
  if (finished) return
  const now = performance.now()
  if (!immediate && now - lastMeasureAt < MEASURE_INTERVAL) {
    if (!sampleTimer) {
      sampleTimer = window.setTimeout(() => {
        sampleTimer = 0
        measureProgress()
      }, MEASURE_INTERVAL - (now - lastMeasureAt))
    }
    return
  }
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  measureProgress()
}

function measureProgress() {
  lastMeasureAt = performance.now()
  if (!sampleCtx || finished) return

  sampleCtx.clearRect(0, 0, sampleCols, sampleRows)
  sampleCtx.drawImage(canvasRef.value, 0, 0, sampleCols, sampleRows)
  // 唯一读像素处：降采样小画布（约 (w/12)×(h/12) 个像素），
  // 从不读取设备分辨率全图。
  const { data } = sampleCtx.getImageData(0, 0, sampleCols, sampleRows)

  let cleared = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 128) cleared++
  }

  const total = sampleCols * sampleRows
  lastPercent = Math.round((cleared / total) * 100)
  emit('progress', lastPercent)

  if (lastPercent >= props.threshold) {
    finish()
  }
}

/* ---------- 完成与重置 ---------- */

/** 淡出结束后的隐藏定时器柄，reset / restore 需要取消它 */
let fadeTimer = 0

function finish() {
  if (finished) return
  finished = true
  activePointers.clear()
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  canvasRef.value.classList.add('scratch-canvas--fading')
  fadeTimer = window.setTimeout(() => {
    fadeTimer = 0
    if (finished && canvasRef.value) {
      canvasRef.value.style.visibility = 'hidden'
    }
  }, props.fadeDuration)
  // finish 后 undo/redo 不可用（需求硬约束）：涂层已淡出，恢复单笔画
  // 没有可交互的涂层语义；如需重来请 reset()。
  syncHistoryFlags()
  emit('finish')
}

function onVisibilityChange() {
  if (!document.hidden) return
  // 切后台时浏览器可能中断指针序列且不派发 pointercancel：丢弃活动笔并
  // 立即按确认笔迹重绘（抹掉未完成的半笔），避免模型与屏幕不一致。
  activePointers.clear()
  if (initialized && !finished) {
    repaint()
    scheduleMeasure(true)
  }
}

function clearMasks() {
  if (bakeCanvas) {
    bakeCtx.clearRect(0, 0, gridW, gridH)
  }
  if (frozenCanvas) {
    frozenCtx.clearRect(0, 0, gridW, gridH)
  }
  bakeOpsSinceFlatten = 0
  frozenOpsSinceFlatten = 0
}

/** 恢复完整涂层、进度归零；撤销/重做栈清空（需求硬约束），可再次刮开 */
function reset() {
  finished = false
  activePointers.clear()
  strokes.length = 0
  redoStack.length = 0
  permanentCount = 0
  bakedCount = 0
  lastPercent = 0
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  if (fadeTimer) {
    clearTimeout(fadeTimer)
    fadeTimer = 0
  }
  clearMasks()
  const canvas = canvasRef.value
  canvas.classList.remove('scratch-canvas--fading')
  canvas.style.visibility = ''
  canvas.classList.add('scratch-canvas--instant')
  rebuildCanvas(true)
  void canvas.offsetHeight
  requestAnimationFrame(() => {
    canvas.classList.remove('scratch-canvas--instant')
  })
  syncHistoryFlags()
  emit('progress', 0)
}

/* ---------- 存档 / 恢复 ---------- */

function encodeStroke(writer, stroke) {
  writer.u16(Math.max(0, Math.min(COORD_SCALE, Math.round(stroke.w * COORD_SCALE))))
  writer.varuint(stroke.pts.length)
  let px = 0
  let py = 0
  for (let i = 0; i < stroke.pts.length; i++) {
    const x = Math.round(stroke.pts[i][0] * COORD_SCALE)
    const y = Math.round(stroke.pts[i][1] * COORD_SCALE)
    if (i === 0) {
      writer.varuint(x)
      writer.varuint(y)
    } else {
      writer.varsint(x - px)
      writer.varsint(y - py)
    }
    px = x
    py = y
  }
}

function decodeStroke(reader) {
  const w = reader.u16() / COORD_SCALE
  const count = reader.varuint()
  const pts = new Array(count)
  let px = 0
  let py = 0
  for (let i = 0; i < count; i++) {
    let x
    let y
    if (i === 0) {
      x = reader.varuint()
      y = reader.varuint()
    } else {
      x = px + reader.varsint()
      y = py + reader.varsint()
    }
    pts[i] = [x / COORD_SCALE, y / COORD_SCALE]
    px = x
    py = y
  }
  return { w, pts }
}

/**
 * 生成可序列化快照。可在任意时刻调用，包括 rAF 重建挂起期间：
 * 快照直接读「矢量 + 遮罩」事实来源，而不读显示用 canvas——重建挂起只
 * 影响屏幕上何时重绘，不改变事实来源，因此无需等待或取消挂起的重建；
 * 随后发生的重建读到的仍是同一状态，save 与重建无共享中间态可竞争。
 * 进行中的笔画（尚未 pointerup）以独立分组存档；redo 栈同样保留，
 * 做到无损（restore 后 canRedo 仍为真）。
 */
function save() {
  ensureMaskCanvases()
  const w = new ByteWriter()
  w.bytes.push(SNAP_MAGIC.charCodeAt(0), SNAP_MAGIC.charCodeAt(1), SNAP_MAGIC.charCodeAt(2))
  w.u8(SNAP_VERSION)
  w.u8(finished ? 1 : 0)
  w.u8(Math.max(0, Math.min(100, lastPercent)))
  w.u16(gridW)
  w.u16(gridH)
  w.varuint(permanentCount)
  w.varuint(bakedInWindow())

  // 仅存「永久层」遮罩的 alpha 网格（固定归一化分辨率，非设备全图）。
  // 注意：这里读取的是 360 宽的离屏遮罩，不是显示 canvas，不属于需求
  // 禁止的「全图 getImageData」（该约束针对设备分辨率刮痕位图）。
  let frozenAlpha = new Uint8Array(gridW * gridH)
  if (permanentCount > 0) {
    const imageData = frozenCtx.getImageData(0, 0, gridW, gridH)
    const src = imageData.data
    frozenAlpha = new Uint8Array(gridW * gridH)
    for (let p = 0, i = 3; i < src.length; p++, i += 4) {
      frozenAlpha[p] = src[i]
    }
  }
  const packed = packBits(frozenAlpha)
  w.u32(packed.length)
  w.raw(packed)

  // 窗口内已确认矢量笔（未固化增量 + 已固化可撤销笔）
  w.varuint(strokes.length)
  for (let i = 0; i < strokes.length; i++) encodeStroke(w, strokes[i])
  // 进行中的活动笔单独成组：它们此刻只在 activePointers（多指刮到一半
  // 就 save 的场景）。restore 后已无对应指针可以续画，解码端会把它们
  // 提升为已确认笔，因此仍能正确显示、resize、undo，不丢划痕。
  w.varuint(activePointers.size)
  for (const active of activePointers.values()) encodeStroke(w, active.stroke)
  // redo 栈单独成组，保持撤销/重做状态无损
  w.varuint(redoStack.length)
  for (let i = 0; i < redoStack.length; i++) encodeStroke(w, redoStack[i])

  const payload = bytesToBase64(w.toUint8())
  const snapshot = { format: 'scratch-card', v: SNAP_VERSION, d: payload }
  const serialized = JSON.stringify(snapshot)
  // 2MB 硬约束：超限直接抛错而不是悄悄截断（截断会破坏无损承诺）。
  if (serialized.length > SNAP_LIMIT) {
    throw new Error(
      `ScratchCard 快照体积 ${serialized.length}B 超过 ${SNAP_LIMIT}B 上限；` +
        '可调小 maxHistory，或减小卡片尺寸宽高比对应的遮罩网格。'
    )
  }
  return snapshot
}

/**
 * 从快照无损恢复。恢复后：
 * - 响应式：ResizeObserver / DPR 监听不变，容器尺寸变化照常重建；
 * - 换肤：coverColor/coverText 是 props，恢复后改动照常重绘（遮罩与
 *   涂层颜色解耦，恢复出的遮罩直接可用）；
 * - undo/redo：窗口矢量笔与 redo 栈完整恢复，跨固化边界 undo 走同一套
 *   局部重固化逻辑。
 * 允许在淡出期间调用：会取消淡出与隐藏定时器，涂层立即回到存档状态。
 */
function restore(snapshot) {
  if (!snapshot || snapshot.v !== SNAP_VERSION || typeof snapshot.d !== 'string') {
    throw new Error('ScratchCard.restore: 无法识别的快照格式')
  }
  const reader = new ByteReader(base64ToBytes(snapshot.d))
  const m0 = reader.u8()
  const m1 = reader.u8()
  const m2 = reader.u8()
  if (
    m0 !== SNAP_MAGIC.charCodeAt(0) ||
    m1 !== SNAP_MAGIC.charCodeAt(1) ||
    m2 !== SNAP_MAGIC.charCodeAt(2)
  ) {
    throw new Error('ScratchCard.restore: 快照 magic 不匹配')
  }
  reader.u8() // version（外层已校验，保留前向兼容读取位置）
  const flags = reader.u8()
  const percent = reader.u8()
  const savedW = reader.u16()
  const savedH = reader.u16()
  const savedPermanent = reader.varuint()
  const savedBakedInWindow = reader.varuint()

  const packedLen = reader.u32()
  const packed = reader.bytes(packedLen)
  const frozenAlpha = unpackBytes(packed, savedW * savedH)

  const confirmedCount = reader.varuint()
  const restoredStrokes = []
  for (let i = 0; i < confirmedCount; i++) restoredStrokes.push(decodeStroke(reader))
  // 存档时进行中的活动笔：恢复后没有原指针可续画，提升为已确认笔追加在
  // 尾部（属于未固化增量），显示 / resize / undo 都按普通笔处理。
  const activeCount = reader.varuint()
  for (let i = 0; i < activeCount; i++) restoredStrokes.push(decodeStroke(reader))
  const redoCount = reader.varuint()
  const restoredRedo = new Array(redoCount)
  for (let i = 0; i < redoCount; i++) restoredRedo[i] = decodeStroke(reader)

  // 取消任何进行中的淡出 / 采样 / 重建：恢复要建立全新的一致状态，
  // 旧重建帧执行时读到的已是新状态（重建幂等），过期 generation 自动跳过。
  if (fadeTimer) {
    clearTimeout(fadeTimer)
    fadeTimer = 0
  }
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  rebuildGeneration++ // 使挂起的 rAF 重建失效，下面强制同步重建一次

  activePointers.clear()
  strokes.length = 0
  strokes.push(...restoredStrokes)
  redoStack.length = 0
  redoStack.push(...restoredRedo)
  permanentCount = savedPermanent
  bakedCount = savedPermanent + savedBakedInWindow
  lastPercent = percent
  finished = (flags & 1) === 1

  // 以快照网格尺寸构建两张遮罩：frozen 解 alpha，bake = frozen + 固化段矢量
  gridW = savedW
  gridH = savedH
  ensureMaskCanvases()
  frozenCanvas.width = gridW
  frozenCanvas.height = gridH
  frozenCtx = frozenCanvas.getContext('2d')
  const frozenImage = frozenCtx.createImageData(gridW, gridH)
  for (let p = 0, i = 0; p < frozenAlpha.length; p++, i += 4) {
    frozenImage.data[i + 3] = frozenAlpha[p]
  }
  frozenCtx.putImageData(frozenImage, 0, 0)

  bakeCanvas.width = gridW
  bakeCanvas.height = gridH
  bakeCtx = bakeCanvas.getContext('2d')
  rebuildBakeMask()
  // 存档时进行中的活动笔被提升为已确认笔，可能使窗口临时越过阈值：
  // 套用两条不变式做一次性校正（多出的固化 / 出窗都走常规代码路径，
  // 出窗笔已在上一步画入 frozen，不会丢笔）。
  applyBakeInvariant()
  applyMaxHistoryInvariant()

  const canvas = canvasRef.value
  canvas.classList.remove('scratch-canvas--fading')
  canvas.style.visibility = finished ? 'hidden' : ''
  if (!finished) {
    // 从淡出中途恢复到未完成状态：先关闭过渡立即呈现涂层，下一帧再恢复，
    // 避免旧 opacity:0 带着淡出时长「淡入」（与 reset 同理）。
    canvas.classList.add('scratch-canvas--instant')
  } else {
    canvas.classList.remove('scratch-canvas--instant')
  }

  // 抑制重建内部的自动进度实测：恢复必须沿用快照的 finished / percent，
  // 不能因为当前页面上的 threshold 更低就在恢复瞬间重新判定 finish。
  restoreInProgress = true
  rebuildCanvas(true)
  restoreInProgress = false
  void canvas.offsetHeight
  requestAnimationFrame(() => {
    canvas.classList.remove('scratch-canvas--instant')
  })
  syncHistoryFlags()
  emit('progress', lastPercent)
  if (finished) emit('finish')
  // 返回恢复后的关键状态：调用方（如演示页）需要据此同步自己的派生 UI
  // （例如外部维护的「已完成」标志——组件内部完成态已恢复，但外部在
  // 淡出期间收到过 finish，需要这个返回值把自己的标志拨回未完成）。
  return { finished, progress: lastPercent }
}

/* ---------- 调试：合成笔迹（压测固化/永久化/跨边界 undo，非生产 API） ---------- */

/** 调试用：导出内部模型计数，供自动化校验（非生产接口） */
function debugStats() {
  return {
    strokes: strokes.length,
    permanent: permanentCount,
    bakedAbs: bakedCount,
    bakedWindow: bakedInWindow(),
    unbaked: strokes.length - bakedInWindow(),
    redo: redoStack.length,
    active: activePointers.size,
    finished,
    percent: lastPercent,
    gridW,
    gridH,
  }
}

/**
 * 调试用：验证「固化遮罩」与「同一批矢量笔在同尺寸网格上直接绘制」
 * 逐像素等价（需求：局部重固化结果必须与全量重放等价）。
 * 逐 alpha 通道比对 bakeCanvas 与参考画布（frozen 底座 + strokes[0,k)
 * 矢量直绘），返回差异像素数与最大 alpha 差。仅读固定小网格，不碰显示
 * canvas。注意：已永久化（点集释放）的笔不在此比对范围，它们在被
 * 永久化之前已满足该等价性（同一条 bakeMaskStroke 绘制路径）。
 */
function verifyBakeEquivalence() {
  ensureMaskCanvases()
  const k = bakedInWindow()
  const reference = document.createElement('canvas')
  reference.width = gridW
  reference.height = gridH
  const refCtx = reference.getContext('2d')
  if (permanentCount > 0) refCtx.drawImage(frozenCanvas, 0, 0)
  // bakeMaskStroke 只依赖传入的 target 与 gridW/gridH，直接在参考画布上画
  for (let i = 0; i < k; i++) bakeMaskStroke(refCtx, strokes[i])
  const got = bakeCtx.getImageData(0, 0, gridW, gridH).data
  const want = refCtx.getImageData(0, 0, gridW, gridH).data
  let diffPixels = 0
  let maxDelta = 0
  for (let i = 3; i < got.length; i += 4) {
    const d = Math.abs(got[i] - want[i])
    if (d > 2) diffPixels++
    if (d > maxDelta) maxDelta = d
  }
  return { cells: gridW * gridH, k, diffPixels, maxDelta }
}


/**
 * 生成一笔落在归一化卡片上的合成笔迹，供手工压测。
 * index 决定网格起点，点沿一个方向小幅游走，保证多笔铺满卡片。
 */
function makeSyntheticStroke(index) {
  // 所有合成笔集中在卡片中部一条横带（y≈0.42~0.58）：即使灌 5000 笔，
  // 覆盖面积也只有约 15%（低于默认阈值 40%），不会自动 finish，方便
  // 在灌入后手工验证跨固化边界 undo、redo、resize 与 save/restore。
  const cols = 100
  const x0 = ((index % cols) + 0.5) / cols
  const y0 = 0.5 + (((index / cols) | 0) % 40 - 20) * 0.004
  const pts = []
  for (let p = 0; p < 8; p++) {
    pts.push([
      Math.min(1, Math.max(0, x0 + Math.sin(index + p) * 0.008 + p * 0.0012)),
      Math.min(1, Math.max(0, y0 + Math.cos(index + p) * 0.008)),
    ])
  }
  return { w: props.brushSize / (cssWidth || 320), pts }
}

/**
 * 调试用：直接灌入 count 笔已确认笔迹（走完整提交逻辑，触发固化 /
 * 永久化 / redo 清空），用于在演示页手工验证 5000 笔下 resize、
 * 跨固化边界 undo、save/restore 体积等。非生产接口，命名加 __ 前缀。
 */
function debugFillStrokes(count = 5000) {
  if (finished) return
  ensureMaskCanvases()
  for (let i = 0; i < count; i++) {
    const stroke = makeSyntheticStroke(i)
    strokes.push(stroke)
    commitStroke()
  }
  if (initialized) {
    repaint()
    scheduleMeasure(true)
  }
}

/* ---------- 调试开关：resize 重放耗时实测（需求硬指标 ④） ---------- */

/**
 * 性能实测开关。把它改为 true 后，组件会在 onMounted 时自动跑一次
 * 5000 笔 / 50 笔的「重绘 + 重放」耗时对照（performance.now()），
 * 结果打到 console（[ScratchCard] perf: ...）。
 * 复验方法见 README「性能验收」一节。也可随时在控制台通过
 * 组件 ref 调用 cardRef.value.__benchReplay() 手动触发。
 */
const DEBUG_PERF = false

/**
 * 重放耗时基准。用合成矢量笔画分别填充「50 笔未固化」与
 * 「5000 笔（绝大多数已固化）」两种规模，各跑一次 repaint() 计时。
 * 5000 笔路径只多一张固定网格 drawImage，耗时与 50 笔同量级
 * （都在 1ms 上下，随设备分辨率而非笔画数变化）。
 * 注意：此函数只在 DEBUG 下用于测量，不改变组件对外状态（测量后
 * 恢复空涂层），不要在生产逻辑里调用。
 */
function benchReplay() {
  const savedStrokes = strokes.splice(0, strokes.length)
  const savedRedo = redoStack.splice(0, redoStack.length)
  const savedBaked = bakedCount
  const savedPermanent = permanentCount
  // frozen 遮罩也要备份：测量期间 clearMasks() 会清空它，否则带永久段
  // 的状态在测量后永久段划痕丢失（永久段矢量点集已释放，无法重建）。
  const frozenBackup = document.createElement('canvas')
  frozenBackup.width = gridW
  frozenBackup.height = gridH
  frozenBackup.getContext('2d').drawImage(frozenCanvas, 0, 0)
  clearMasks()
  bakedCount = 0
  permanentCount = 0

  const timeRepaint = (count, forceBake) => {
    strokes.length = 0
    clearMasks()
    bakedCount = 0
    permanentCount = 0
    for (let i = 0; i < count; i++) strokes.push(makeSyntheticStroke(i))
    if (forceBake) {
      ensureMaskCanvases()
      for (let i = 0; i < count; i++) bakeMaskStroke(bakeCtx, strokes[i])
      bakedCount = count
      // 生产路径里遮罩会被周期拍平；测的是拍平后那次纯像素 drawImage
      flattenBake()
    }
    // 连跑 30 次取均值：单次重放常在亚毫秒级，单次测量会被量化成 0；
    // 每次都完整 repaint（涂层 + 遮罩 + 增量），计时区间含全部重放工作。
    const iters = 30
    const t0 = performance.now()
    for (let it = 0; it < iters; it++) repaint()
    const t1 = performance.now()
    return (t1 - t0) / iters
  }

  const t50 = timeRepaint(50, false)
  const t5000 = timeRepaint(5000, true)

  // 恢复测量前状态（实际使用时组件通常是空卡，这里恢复为空）
  strokes.length = 0
  redoStack.length = 0
  strokes.push(...savedStrokes)
  redoStack.push(...savedRedo)
  bakedCount = savedBaked
  permanentCount = savedPermanent
  frozenCtx.clearRect(0, 0, gridW, gridH)
  frozenCtx.drawImage(frozenBackup, 0, 0)
  rebuildBakeMask()
  repaint()

  // eslint-disable-next-line no-console
  console.info(
    `[ScratchCard] perf replay: 50 strokes = ${t50.toFixed(3)}ms, ` +
      `5000 strokes (baked) = ${t5000.toFixed(3)}ms`
  )
  return { t50, t5000 }
}

/* ---------- 运行时换肤 / 调阈值 ---------- */

/**
 * 换肤（coverColor / coverText 变化）与 redo 栈的语义：
 * 【明确保留 redo 栈】。理由：
 * 1. 换肤只改变「涂层外观」，属于与刮擦内容正交的展示维度；划痕遮罩
 *    与矢量笔迹完全不涉及涂层颜色，换肤走纯 repaint()，不触碰历史。
 * 2. redo 栈里存的是笔迹数据，与肤色无关，保留后 redo 仍能逐像素正确
 *    重放到当前（新）涂层上；若清空反而会让用户单纯换个颜色就丢失
 *    「重做」能力，违反最小惊讶。
 * 3. 对比：真正开启新编辑分支的动作（提交一笔新笔迹）才清空 redo，
 *    这是 undo/redo 的经典分支语义（同文本编辑器：输入新内容会使
 *    redo 失效，而切换光标/外观不会）。
 */
watch(
  () => [props.coverColor, props.coverText],
  () => {
    if (initialized) repaint()
  }
)

watch(
  () => props.threshold,
  () => {
    if (initialized && !finished) measureProgress()
  }
)

// 运行时调小 rasterizeAfter：更多已确认笔需要固化，直接套用固化不变式
// （调大不主动反固化——位图里多保留划痕不影响正确性，且能省去抖动）。
watch(
  () => props.rasterizeAfter,
  () => {
    if (!initialized || finished) return
    applyBakeInvariant()
    repaint()
  }
)

// 运行时调小 maxHistory：最旧笔立即出窗永久化；调大无法恢复已丢弃的笔
// （其矢量点集已释放），仅对之后的提交生效。
watch(
  () => props.maxHistory,
  () => {
    if (!initialized || finished) return
    applyMaxHistoryInvariant()
    repaint()
    scheduleMeasure(true)
    syncHistoryFlags()
  }
)

onMounted(() => {
  rebuildCanvas(true)
  resizeObserver = new ResizeObserver(scheduleRebuild)
  resizeObserver.observe(rootRef.value)
  window.addEventListener('resize', scheduleRebuild)
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (DEBUG_PERF) {
    // 等首帧布局稳定后再测，保证 cssWidth/Height 已就绪
    requestAnimationFrame(() => requestAnimationFrame(benchReplay))
  }
})

onBeforeUnmount(() => {
  if (sampleTimer) clearTimeout(sampleTimer)
  if (fadeTimer) clearTimeout(fadeTimer)
  if (rebuildRaf) cancelAnimationFrame(rebuildRaf)
  if (resizeObserver) resizeObserver.disconnect()
  if (dprMediaQuery) {
    dprMediaQuery.removeEventListener('change', scheduleRebuild)
  }
  window.removeEventListener('resize', scheduleRebuild)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

/**
 * 对外接口（v2 接口全部保留，仅新增）：
 * - 新增方法：undo() / redo() / save() / restore(snapshot)
 * - 新增响应式状态：canUndo / canRedo（ref，父组件经模板 ref 自动解包）
 * - v2 保留：reset()，props，默认插槽，progress / finish 事件，
 *   responsive / aspectRatio 等
 */
defineExpose({
  reset,
  undo,
  redo,
  save,
  restore,
  canUndo,
  canRedo,
  __benchReplay: benchReplay,
  __fillStrokes: debugFillStrokes,
  __verifyBake: verifyBakeEquivalence,
  __stats: debugStats,
})
</script>

<template>
  <div ref="rootRef" class="scratch-card" :style="cardStyle">
    <!-- 底层中奖内容，完全由调用方通过默认插槽决定 -->
    <div class="scratch-card__prize">
      <slot />
    </div>
    <!-- 上层涂层：touch-action:none 阻止触屏滚动/双击缩放；
         user-select:none 防止拖动时选中文本 -->
    <canvas
      ref="canvasRef"
      class="scratch-canvas"
      :style="{ '--scratch-fade': `${fadeDuration}ms` }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @selectstart.prevent
    />
  </div>
</template>

<style scoped>
.scratch-card {
  position: relative;
  overflow: hidden;
  border-radius: 12px;
  user-select: none;
  -webkit-user-select: none;
}

.scratch-card__prize {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.scratch-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: crosshair;
  display: block;
  opacity: 1;
  transition: opacity var(--scratch-fade, 500ms) ease;
}

.scratch-canvas--instant {
  transition: none !important;
}

.scratch-canvas--fading {
  opacity: 0;
}
</style>
