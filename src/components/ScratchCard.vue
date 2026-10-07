<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { encodeSnapshot, decodeSnapshot } from '../scratchCodec.js'

/**
 * 通用刮刮卡组件（v3 运营级）
 *
 * 在 v2「归一化矢量笔迹 + resize/DPR 无损重放」基础上新增：
 *   1. 笔画粒度 undo/redo（canUndo/canRedo，maxHistory 限制撤销栈深度）
 *   2. 分层缓存：超过 rasterizeAfter 笔的已确认笔迹固化为遮罩位图，
 *      重放 = 固化位图 drawImage + 未固化增量笔迹，与总笔数解耦
 *   3. save()/restore() 手写紧凑二进制快照（<= 2MB，见 scratchCodec.js）
 *   4. 调试开关下用 performance.now() 实测重放耗时（README 有验证方法）
 *
 * ------------------------------------------------------------------
 * 核心数据模型（所有视觉状态都可由它确定性重建）
 * ------------------------------------------------------------------
 * slots：时间线槽位数组，每项 { id, w, pts, alive, block }
 *   - id    单调递增；undo/redo 栈与固化块都只存 id（splice 槽位不失效）
 *   - w/pts 归一化矢量笔迹（w=笔宽/卡宽，pts=[[x/卡宽,y/卡高]…]），同 v2
 *   - alive false 表示已被 undo（redo 可恢复）
 *   - block >=0 表示已并入第 block 个固化块（矢量已栅格化进 solidMask）
 * 不变量：已固化槽位永远是 slots 的连续前缀（固化总是吃最旧的增量，
 * 丢弃也总是丢最旧的），因此快照只需记录 solidTo 一个数即可还原分块。
 *
 * 两张离屏遮罩位图（透明=未刮，不透明=已刮除；按需懒创建以省内存）：
 *   - solidMask「可重建固化层」：矢量仍保留（用于 undo 跨边界回退），
 *     resize 时优先按矢量重栅格化（与全量重放逐像素等价）；
 *     矢量量超过同步预算时先缩放旧位图、再在下一帧异步重建。
 *   - frozenMask「永久固化层」：被 maxHistory 丢弃的最旧笔画，矢量随
 *     丢弃释放（内存控制的关键），resize 只能缩放旧位图。
 *
 * 重放 = 重绘涂层 + destination-out 依次 drawImage(frozenMask, solidMask)
 *        + 重放未固化增量（恒 <= rasterizeAfter + 余量笔）。
 * 前两层是 O(像素) 的 drawImage，与总笔数无关——这就是 5000 笔规模下
 * resize 重放耗时与 50 笔基本持平的原因。
 *
 * ------------------------------------------------------------------
 * undo 跨固化边界为什么逐像素等价
 * ------------------------------------------------------------------
 * 固化块的矢量在被 maxHistory 丢弃前始终保留。undo 命中固化槽位时只
 * 置 alive=false 并标 solidDirty，下一帧合并重建 solidMask：重建用的
 * 是与全量重放完全相同的矢量绘制代码路径，结果逐像素等价。同一帧内
 * 连续多次 undo 只触发一次重建（标志位合并），不会 O(n^2)。
 * 已被 maxHistory 丢弃进 frozenMask 的笔画矢量已释放，不在撤销栈内，
 * 天然不可 undo（栈深语义如此）。
 *
 * ------------------------------------------------------------------
 * redo 栈在换肤（coverColor/coverText 变化）后的语义：保留
 * ------------------------------------------------------------------
 * 换肤只重绘涂层外观，不触碰任何笔迹几何（slots/遮罩都不变），redo
 * 恢复的是几何而非外观，因此 redo 栈原样保留、canRedo 不变。唯一会
 * 清空 redo 栈的动作是「刮出新的一笔」（编辑器标准语义）与 reset。
 *
 * ------------------------------------------------------------------
 * v4 新增：休眠 / 离屏状态（多卡运营墙，接口仅新增不改语义）
 * ------------------------------------------------------------------
 * sleep()：滚出视口时调用。进行中的多指笔迹先按「确认」入撤销栈
 * （不丢笔迹、不等待真实 pointerup），冲刷挂起维护后释放：
 *   - 显示用主 canvas 的 backing store（canvas.width/height 置 0）
 *   - solidMask 可重建层位图（矢量全部在册，wake 从矢量重栅格化）
 * 保留：slots/undoStack/redoStack/blocks 全部矢量与标志、frozenMask
 * 永久层位图（无矢量来源，丢了无法恢复，只能随状态保留）。
 * wake()：滚回视口时一次同步 rebuildCanvas(true) 内完成 frozen 层
 * 尺寸/DPR 迁移 + solid 层矢量重栅格化 + 全量分层重放 + 进度复测，
 * 在调用返回前画面已完整——满足「1 帧内恢复」。
 * 休眠期间 resize/DPR 变化只做离屏 frozen 层迁移与尺寸记录，绝不
 * 重新分配主 backing store（否则休眠失去意义）；矢量是归一化的，
 * solid 层等 wake 时按新尺寸重建，因此 resize、DPR 变化、undo 跨
 * 固化边界在休眠/恢复后仍逐像素正确（同 v3 的既有不变量）。
 * 另有 serializeOffline()（休眠卡存档，不碰主 canvas）、
 * restoreOffline()（直接恢复成休眠态，供墙批量恢复离屏卡）、
 * clearStateOffline()（离线重置）、memoryStats()（预算计量）。
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
   * 撤销栈深度上限（笔，默认 200）。超限后最旧的已确认笔画被烘进
   * frozenMask 永久固化层并释放矢量（内存随之上界封顶），该笔仍显示
   * 为已刮开但不再可 undo。运行中调小会在下一次维护时补丢差额。
   */
  maxHistory: { type: Number, default: 200 },
  /**
   * 未固化增量笔迹上限（笔，默认 500）。超过后最旧的已确认笔迹分批
   * 烘进 solidMask 固化层，重放只花「位图 + 增量」。注意只有
   * maxHistory > rasterizeAfter 时固化层才会真正积累（否则笔画先被
   * 历史上限丢进永久层）；演示页把 maxHistory 调到 5000 即可观察。
   */
  rasterizeAfter: { type: Number, default: 500 },
  /**
   * v4 新增：挂载后立即进入休眠态（不分配主 canvas backing store）。
   * 仅供运营墙使用——墙内离屏卡槽创建时就该零显存，无需先完整渲染
   * 一帧再被 IO 回调释放（那会让 50 张卡同时产生一次性显存峰值）。
   * 尺寸/DPR 只记录不渲染；滚入视口经 wake() 同帧恢复。默认 false，
   * v3 单独使用 ScratchCard 的行为完全不变。
   */
  initSleeping: { type: Boolean, default: false },
})

// v4 新增 'interact'：真实刮擦开始（pointerdown）时派发，
// 供运营墙刷新 LRU「最近交互」时间；v3 的 progress/finish 语义不变。
const emit = defineEmits(['progress', 'finish', 'interact'])

const rootRef = ref(null)
const canvasRef = ref(null)

/** 撤销/重做可用性（defineExpose 经 proxyRefs 解包，父组件直接读布尔值） */
const canUndo = ref(false)
const canRedo = ref(false)

let ctx = null
let dpr = 1
let cssWidth = 0
let cssHeight = 0
let initialized = false
/**
 * v4 休眠标志（见文件头 v4 说明）。休眠期间：
 * - 主 canvas backing store 已释放（ctx 为 null），repaint 直接空转；
 * - scheduleMaintenance / scheduleMeasure 不挂任何 rAF/定时器
 *   （几何维护推迟到 wake，由 rebuildCanvas(true) 统一完成）；
 * - rebuildCanvas 走「离屏分支」：只迁移 frozenMask、记录尺寸/DPR；
 * - 指针事件一律忽略（滚出视口的卡不可能被真实点按）。
 */
let sleeping = false

/** 是否已经完成（达到阈值，正在/已经淡出）；完成后 undo/redo 禁用 */
let finished = false
let fadeTimer = 0
/** 最近一次进度百分比，save 快照直接携带 */
let lastProgress = 0
/**
 * finish 抑制标记。两个用途：
 * 1. restore 恢复「进行中」快照时置位——存档的是刮除几何而非完成态，
 *    恢复后不应被恢复测量立即再次 finish（否则 undo/redo 被禁用，
 *    与「restore 后撤销重做继续工作」的语义冲突）；用户再次刮擦
 *    （pointerdown）时解除抑制，届时测量若仍达阈值会正常 finish。
 * 2. 压测注入（__debug.seed）时置位——注入大量笔迹覆盖率必然越阈，
 *    不抑制则注入后第一次测量就淡出，无法观察 resize 重放耗时。
 * reset 时复位。
 */
let suppressFinish = false

/* ---------- 历史时间线（见文件头数据模型） ---------- */

const slots = []
const slotById = new Map()
const undoStack = [] // slot id，按确认顺序（栈顶=最近一笔）
const redoStack = [] // slot id
const blocks = [] // 固化块：每项是 slot id 数组；已固化槽位恒为 slots 前缀
let nextSlotId = 1
let solidDirty = false // solidMask 相对 slots 失效（undo/redo 跨固化边界）
let frozenDirty = false // frozenMask 是否有内容（save 据此决定是否存位图）

/** 固化维护每帧最多烘的笔数：小批 + rAF 合并，阈值触发不掉帧 */
const BATCH_STROKES = 16
/** 增量重放条数余量：容纳在刮多指笔迹与同帧波动，避免边界抖动反复固化 */
const TAIL_SLACK = 25
/** resize 时 solidMask 同步矢量重建的笔数预算；超出则先缩放位图再异步重建 */
const SOLID_SYNC_BUDGET = 2000

/* ---------- 离屏固化位图（懒创建） ---------- */

let solidMask = null
let solidCtx = null
let frozenMask = null
let frozenCtx = null
/** restore 时暂存的永久层网格画布，rebuildCanvas 消费一次后清空 */
let frozenBaseGrid = null

/* ---------- 指针 ---------- */

const activePointers = new Map()

/* ---------- 进度采样（沿用 v2：降采样小画布 + 节流） ---------- */

const SAMPLE_GRID = 12
let sampleCanvas = null
let sampleCtx = null
let sampleCols = 0
let sampleRows = 0
let sampleTimer = 0
let lastMeasureAt = 0
const MEASURE_INTERVAL = 160

/* ---------- resize / rAF ---------- */

let resizeObserver = null
let dprMediaQuery = null
let rebuildRaf = 0
/** 固化维护（重建/固化/丢弃/重放/测量）合并到下一帧，每帧至多一轮 */
let maintenanceRaf = 0
let pendingRepaint = false
let pendingMeasure = false

/**
 * 调试开关：控制台执行 window.__SCRATCH_DEBUG__ = true 后，
 * 每次重放都会用 performance.now() 打印耗时与分层规模，
 * 配合 __debug.seed(n) 做 50/5000 笔 resize 对比（方法见 README）。
 */
function debugEnabled() {
  return typeof window !== 'undefined' && window.__SCRATCH_DEBUG__ === true
}
let lastReplayMs = 0

/* ================= 尺寸与重建 ================= */

function toCssSize(value) {
  return typeof value === 'number' ? `${value}px` : value
}

const cardStyle = computed(() => {
  if (props.responsive) {
    return { width: '100%', aspectRatio: String(props.aspectRatio) }
  }
  return { width: toCssSize(props.width), height: toCssSize(props.height) }
})

function scheduleRebuild() {
  if (rebuildRaf) return
  rebuildRaf = requestAnimationFrame(() => {
    rebuildRaf = 0
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

/** 新建一张 device-pixel 坐标系的遮罩画布（ctx 已按 dpr 变换到 CSS 坐标） */
function createMaskCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  const maskCtx = canvas.getContext('2d')
  maskCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { canvas, ctx: maskCtx }
}

/** 把旧遮罩位图等比绘制进新尺寸画布（无矢量来源的层只能缩放） */
function scaleMask(oldCanvas) {
  const next = createMaskCanvas()
  next.ctx.drawImage(
    oldCanvas,
    0, 0, oldCanvas.width, oldCanvas.height,
    0, 0, cssWidth, cssHeight
  )
  return next
}

function ensureSolidMask() {
  if (!solidMask) {
    const created = createMaskCanvas()
    solidMask = created.canvas
    solidCtx = created.ctx
  }
}

function ensureFrozenMask() {
  if (!frozenMask) {
    const created = createMaskCanvas()
    frozenMask = created.canvas
    frozenCtx = created.ctx
  }
}

/** 已固化（block >= 0）槽位数量 */
function committedCount() {
  let count = 0
  for (const slot of slots) {
    if (slot.block >= 0) count++
  }
  return count
}

/**
 * 从固化块矢量整体重建 solidMask。
 * 与全量重放走同一套矢量绘制，undo 跨固化边界的结果逐像素等价；
 * 同一帧内多次 undo/redo 通过 solidDirty 标志合并成一次重建。
 */
function rebuildSolidMask() {
  const created = createMaskCanvas()
  solidMask = created.canvas
  solidCtx = created.ctx
  for (const block of blocks) {
    for (const id of block) {
      const slot = slotById.get(id)
      if (slot && slot.alive) drawStrokeOnMask(solidCtx, slot)
    }
  }
  solidDirty = false
}

/**
 * 尺寸变化时迁移两张遮罩：
 * - 永久层无矢量来源，只能缩放旧位图（restore 注入的网格优先消费）；
 * - 固化层矢量仍在：笔数不超限则同步重栅格化（新分辨率下保持矢量
 *   清晰、不累积模糊）；超限则先缩放旧位图保证本帧上屏，再异步重建。
 */
function migrateMasks() {
  if (frozenBaseGrid) {
    ensureFrozenMask()
    frozenCtx.drawImage(
      frozenBaseGrid,
      0, 0, frozenBaseGrid.width, frozenBaseGrid.height,
      0, 0, cssWidth, cssHeight
    )
    frozenBaseGrid = null
  } else if (frozenMask) {
    const scaled = scaleMask(frozenMask)
    frozenMask = scaled.canvas
    frozenCtx = scaled.ctx
  }

  const committed = committedCount()
  if (solidMask || committed > 0) {
    // 无旧位图可缩放时（restore 后）必须走矢量重建，否则固化层丢失
    if (committed <= SOLID_SYNC_BUDGET || !solidMask) {
      rebuildSolidMask()
    } else {
      const scaled = scaleMask(solidMask)
      solidMask = scaled.canvas
      solidCtx = scaled.ctx
      solidDirty = true
      scheduleMaintenance()
    }
  }
}

function rebuildCanvas(force = false) {
  const canvas = canvasRef.value
  if (!canvas) return

  watchDpr()

  const rect = canvas.getBoundingClientRect()
  // 元素不可见（display:none 等）时跳过，可见后 ResizeObserver 会再触发
  if (rect.width <= 0 || rect.height <= 0) return
  const nextDpr = Math.min(window.devicePixelRatio || 1, 3)

  // v4 休眠离屏分支：绝不重新分配主 backing store（休眠的全部意义）。
  // 只更新记录的尺寸/DPR，并把无矢量来源的 frozenMask 做一次等比缩放，
  // 这样「休眠期间跨屏 DPR 变化」也不丢永久层；solidMask 此刻不存在
  // （sleep 时已随主画布一起释放），其矢量是归一化坐标，wake 时按新
  // 尺寸重栅格化即可，天然无缩放模糊。进行中笔迹在 sleep 时已确认入栈。
  if (sleeping) {
    const sizeChanged =
      nextDpr !== dpr ||
      Math.abs(rect.width - cssWidth) >= 0.5 ||
      Math.abs(rect.height - cssHeight) >= 0.5
    cssWidth = rect.width
    cssHeight = rect.height
    dpr = nextDpr
    initialized = true
    if (sizeChanged) {
      // frozenBaseGrid（离线恢复注入的永久层网格）保持原样不动：
      // wake 的 migrateMasks 会优先消费它，且按当时最新尺寸缩放；
      // 只有「旧位图存在且无注入网格」时才需要在这里迁移旧位图。
      if (!frozenBaseGrid && frozenMask) {
        const scaled = scaleMask(frozenMask)
        frozenMask = scaled.canvas
        frozenCtx = scaled.ctx
      }
    }
    return
  }

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

  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  migrateMasks()
  initSampler()
  repaint()

  // 竞态：resize 途中有指针正按着刮，其 prev 还是旧坐标系下的
  // CSS 像素；换算到新坐标系，避免下一段增量线段跨尺寸连接出杂线
  for (const active of activePointers.values()) {
    const last = active.slot.pts[active.slot.pts.length - 1]
    active.prev = { x: last[0] * cssWidth, y: last[1] * cssHeight }
  }

  // 重建后按重放的刮痕重新统计一次：进度在 resize 前后保持一致
  if (!finished && slots.length > 0) measureProgress()
}

/* ================= 涂层绘制与分层重放 ================= */

/** 绘制完整涂层及提示文案（当前变换已缩放到 CSS 像素坐标系） */
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
 * 按归一化几何描出一条笔画（粗线 + 首尾圆点）。
 * 主画布（destination-out 刮除）与遮罩画布（source-over 打标）共用，
 * 保证「即时上屏」「增量重放」「固化栅格化」三者像素一致。
 */
function strokePath(targetCtx, stroke) {
  const lineWidth = stroke.w * cssWidth
  const radius = lineWidth / 2
  targetCtx.lineCap = 'round'
  targetCtx.lineJoin = 'round'
  targetCtx.lineWidth = lineWidth
  targetCtx.beginPath()
  targetCtx.moveTo(stroke.pts[0][0] * cssWidth, stroke.pts[0][1] * cssHeight)
  for (let i = 1; i < stroke.pts.length; i++) {
    targetCtx.lineTo(stroke.pts[i][0] * cssWidth, stroke.pts[i][1] * cssHeight)
  }
  targetCtx.stroke()
  targetCtx.beginPath()
  targetCtx.arc(
    stroke.pts[0][0] * cssWidth,
    stroke.pts[0][1] * cssHeight,
    radius,
    0,
    Math.PI * 2
  )
  targetCtx.fill()
  const last = stroke.pts[stroke.pts.length - 1]
  targetCtx.beginPath()
  targetCtx.arc(last[0] * cssWidth, last[1] * cssHeight, radius, 0, Math.PI * 2)
  targetCtx.fill()
}

/** 在主画布上刮除一条笔画（destination-out） */
function drawStrokeOnMain(stroke) {
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  ctx.strokeStyle = '#000'
  strokePath(ctx, stroke)
}

/** 在遮罩画布上标记一条笔画（source-over 不透明点，仅 alpha 有意义） */
function drawStrokeOnMask(maskCtx, stroke) {
  maskCtx.globalCompositeOperation = 'source-over'
  maskCtx.fillStyle = '#000'
  maskCtx.strokeStyle = '#000'
  strokePath(maskCtx, stroke)
}

/**
 * 重绘涂层并分层重放：永久固化位图 + 可重建固化位图 + 未固化增量。
 * 位图层是 O(像素) 的 drawImage，增量层笔数有硬上界，
 * 因此重放耗时与历史总笔数解耦（5000 笔 ≈ 50 笔）。
 */
function repaint() {
  // v4：休眠后主 canvas backing store 已释放（ctx=null），空转即可；
  // 所有几何状态仍由 slots/遮罩保留，wake 的 rebuildCanvas 会完整重放。
  if (!ctx || sleeping) return
  const timing = debugEnabled()
  const t0 = timing ? performance.now() : 0

  paintCover()
  ctx.globalCompositeOperation = 'destination-out'
  if (frozenMask) ctx.drawImage(frozenMask, 0, 0, cssWidth, cssHeight)
  if (solidMask) ctx.drawImage(solidMask, 0, 0, cssWidth, cssHeight)

  ctx.fillStyle = '#000'
  ctx.strokeStyle = '#000'
  let tail = 0
  for (const slot of slots) {
    if (slot.block === -1 && slot.alive) {
      strokePath(ctx, slot)
      tail++
    }
  }

  if (timing) {
    lastReplayMs = performance.now() - t0
    console.log(
      `[scratch] 重放 ${lastReplayMs.toFixed(2)}ms` +
        `（增量 ${tail} 笔 / 固化 ${committedCount()} 笔 / 永久层 ${frozenDirty ? '有' : '无'}）`
    )
  }
}

/* ================= 历史维护（固化 / 丢弃 / 撤销 / 重做） ================= */

function syncFlags() {
  canUndo.value = !finished && undoStack.length > 0
  canRedo.value = !finished && redoStack.length > 0
}

/**
 * 合并到下一帧的维护任务。undo/redo/换肤/resize 都可能触发，
 * 标志位合并保证每帧至多：一次 solidMask 重建 + 一次重放 + 一次测量。
 */
function scheduleMaintenance() {
  // 休眠期不挂 rAF：sleep() 内部已同步冲刷维护，唤醒时强制重建兜底
  if (sleeping) return
  if (maintenanceRaf) return
  maintenanceRaf = requestAnimationFrame(() => {
    maintenanceRaf = 0
    runMaintenance()
  })
}

function runMaintenance() {
  // 休眠期几何维护全部挂起（evict 需要 frozenMask 离屏绘制，
  // serializeOffline 会在真正需要时同步驱动一轮，见该函数注释）
  if (!initialized || sleeping) return
  // 1) 丢弃超出 maxHistory 的最旧笔画（可能标 solidDirty，须先于重建）
  const limit = Math.max(1, Math.floor(props.maxHistory))
  while (undoStack.length > limit) evictOldest()
  // 2) undo/redo 跨固化边界后，从矢量整体重建固化层（逐像素等价）
  if (solidDirty) rebuildSolidMask()
  // 3) 增量超 rasterizeAfter 时分批固化（每帧一批，不掉帧）
  commitOverflow()
  // 4) 合并的重放与测量
  if (pendingRepaint) {
    pendingRepaint = false
    repaint()
  }
  if (pendingMeasure) {
    pendingMeasure = false
    measureProgress()
  }
  syncFlags()
}

/**
 * 丢弃最旧的可撤销笔画：烘进永久固化层后释放矢量与槽位。
 * 这是内存硬上界的关键——slots 长度被 maxHistory + rasterizeAfter
 * + 余量夹住，长时间高频使用不会无限增长。
 */
function evictOldest() {
  const id = undoStack.shift()
  const slot = slotById.get(id)
  if (!slot) return
  ensureFrozenMask()
  drawStrokeOnMask(frozenCtx, slot)
  frozenDirty = true
  if (slot.block >= 0) solidDirty = true // 固化层要把它剔除，待重建
  const index = slots.indexOf(slot)
  if (index >= 0) slots.splice(index, 1)
  slotById.delete(id)
}

/**
 * 增量固化：未固化槽位超过 rasterizeAfter + 余量时，把最旧的一批
 * 烘进 solidMask（矢量保留，供 undo 跨边界回退）。每帧最多一批
 * BATCH_STROKES 笔，剩余下一帧继续——500 笔阈值触发时单帧开销
 * 亚毫秒，无可感知掉帧；每笔按下时已直接画上屏，固化只是离屏
 * 缓存搬家，不会丢刮痕。死亡（已 undo）槽位也一并标记固化，
 * 不重绘，redo 时经 solidDirty 重建恢复。
 */
function commitOverflow() {
  const cap = Math.max(1, Math.floor(props.rasterizeAfter))
  let uncommitted = 0
  for (const slot of slots) {
    if (slot.block === -1) uncommitted++
  }
  if (uncommitted <= cap + TAIL_SLACK) return

  const excess = uncommitted - cap
  ensureSolidMask()
  const blockIndex = blocks.length
  const ids = []
  for (const slot of slots) {
    if (ids.length >= Math.min(excess, BATCH_STROKES)) break
    if (slot.block !== -1) continue
    slot.block = blockIndex
    if (slot.alive) drawStrokeOnMask(solidCtx, slot)
    ids.push(slot.id)
  }
  if (ids.length) blocks.push(ids)
  // 还有剩余（如一次性注入大量笔迹）则下一帧继续固化
  if (excess > ids.length) scheduleMaintenance()
}

/** 刮出新笔画时清空 redo 栈（编辑器标准语义），并回收死亡槽位的内存 */
function clearRedo() {
  if (!redoStack.length) return
  for (const id of redoStack) {
    const slot = slotById.get(id)
    if (!slot) continue
    const index = slots.indexOf(slot)
    if (index >= 0) slots.splice(index, 1)
    slotById.delete(id)
    // 固化块里残留的 id 在下次重建时因查不到槽位被自然跳过
  }
  redoStack.length = 0
}

/**
 * 撤销最近一笔已确认的笔迹（笔画粒度）。
 * 进行中的多指刮擦不受影响：undo 栈只收录 pointerup 后的笔迹，
 * 进行中的笔画根本不在栈内；重放会带上进行中的笔画，刮擦继续。
 */
function undo() {
  if (finished || !undoStack.length) return
  const id = undoStack.pop()
  const slot = slotById.get(id)
  if (!slot) {
    syncFlags()
    return
  }
  slot.alive = false
  redoStack.push(id)
  // 命中固化层：标脏，下一帧从矢量重建（与全量重放逐像素等价）；
  // 命中增量层：重放时自然跳过。两者都只需一次合并重放。
  if (slot.block >= 0) solidDirty = true
  pendingRepaint = true
  pendingMeasure = true
  scheduleMaintenance()
  syncFlags()
}

/** 重做：与 undo 对称；命中固化层同样只标脏，重建在下一帧合并完成 */
function redo() {
  if (finished || !redoStack.length) return
  const id = redoStack.pop()
  const slot = slotById.get(id)
  if (!slot) {
    syncFlags()
    return
  }
  slot.alive = true
  undoStack.push(id)
  if (slot.block >= 0) solidDirty = true
  pendingRepaint = true
  pendingMeasure = true
  scheduleMaintenance()
  syncFlags()
}

/* ================= 刮除（指针交互） ================= */

/**
 * 在两个点之间刮出连续笔迹（增量绘制，立即上屏）。
 * 矢量记录由调用方维护，这里只画位图。
 */
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
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }
}

function recordPoint(slot, point) {
  slot.pts.push([point.x / cssWidth, point.y / cssHeight])
}

function onPointerDown(event) {
  if (finished || sleeping) return
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  // 新一笔刮擦解除 restore/压测的 finish 抑制：此后测量达阈值正常完成
  suppressFinish = false
  // 新笔画使 redo 失效（标准编辑器语义），死亡槽位一并回收
  clearRedo()
  const point = getPoint(event)
  const slot = {
    id: nextSlotId++,
    w: props.brushSize / cssWidth,
    pts: [],
    alive: true,
    block: -1,
  }
  slots.push(slot)
  slotById.set(slot.id, slot)
  recordPoint(slot, point)
  activePointers.set(event.pointerId, { prev: point, slot })
  scratchSegment(point.x, point.y, point.x, point.y)
  // v4：真实刮擦开始，通知墙刷新 LRU「最近交互」时间
  emit('interact', { at: performance.now() })
  scheduleMeasure(true)
  syncFlags()
}

function onPointerMove(event) {
  const active = activePointers.get(event.pointerId)
  if (finished || sleeping || !active) return
  event.preventDefault()

  const coalesced =
    typeof event.getCoalescedEvents === 'function'
      ? event.getCoalescedEvents()
      : []
  const events = coalesced.length > 0 ? coalesced : [event]
  for (const ev of events) {
    const to = getPoint(ev)
    scratchSegment(active.prev.x, active.prev.y, to.x, to.y)
    recordPoint(active.slot, to)
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
  // 笔画确认：进入撤销栈，并安排固化/丢弃维护（下一帧合并执行）
  undoStack.push(active.slot.id)
  scheduleMaintenance()
  scheduleMeasure(true)
  syncFlags()
}

/* ================= 进度统计（沿用 v2：节流 + 降采样） ================= */

function scheduleMeasure(immediate = false) {
  if (finished || sleeping) return
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
  if (!sampleCtx || finished || sleeping) return

  sampleCtx.clearRect(0, 0, sampleCols, sampleRows)
  sampleCtx.drawImage(canvasRef.value, 0, 0, sampleCols, sampleRows)
  const { data } = sampleCtx.getImageData(0, 0, sampleCols, sampleRows)

  let cleared = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 128) cleared++
  }

  const total = sampleCols * sampleRows
  const percent = Math.round((cleared / total) * 100)
  lastProgress = percent
  emit('progress', percent)

  if (percent >= props.threshold) {
    finish()
  }
}

function initSampler() {
  sampleCols = Math.max(1, Math.round(cssWidth / SAMPLE_GRID))
  sampleRows = Math.max(1, Math.round(cssHeight / SAMPLE_GRID))
  if (!sampleCanvas) sampleCanvas = document.createElement('canvas')
  sampleCanvas.width = sampleCols
  sampleCanvas.height = sampleRows
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })
}

/* ================= 完成与重置 ================= */

function finish() {
  if (finished || suppressFinish) return
  finished = true
  activePointers.clear()
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  canvasRef.value.classList.add('scratch-canvas--fading')
  // 记录定时器句柄：restore/reset 需要取消它，否则旧定时器会在
  // 「restore 后再次 finish」的场景里提前隐藏新涂层（边界场景③）
  fadeTimer = window.setTimeout(() => {
    fadeTimer = 0
    if (finished && canvasRef.value) {
      canvasRef.value.style.visibility = 'hidden'
    }
  }, props.fadeDuration)
  emit('finish')
  syncFlags() // 完成后 undo/redo 禁用
}

function onVisibilityChange() {
  if (document.hidden) activePointers.clear()
}

/** 清空全部历史与固化层（reset / restore 共用） */
function clearHistoryState() {
  slots.length = 0
  slotById.clear()
  undoStack.length = 0
  redoStack.length = 0
  blocks.length = 0
  solidDirty = false
  frozenDirty = false
  frozenBaseGrid = null
  solidMask = null
  solidCtx = null
  frozenMask = null
  frozenCtx = null
  if (maintenanceRaf) {
    cancelAnimationFrame(maintenanceRaf)
    maintenanceRaf = 0
  }
  pendingRepaint = false
  pendingMeasure = false
}

/** 取消淡出并恢复涂层可见（reset / restore 共用） */
function cancelFade() {
  finished = false
  if (fadeTimer) {
    clearTimeout(fadeTimer)
    fadeTimer = 0
  }
  const canvas = canvasRef.value
  canvas.classList.remove('scratch-canvas--fading')
  canvas.style.visibility = ''
  // 先加 instant 类关闭过渡，避免新涂层从 0 透明度"淡入"
  canvas.classList.add('scratch-canvas--instant')
}

/** 对外暴露：恢复完整涂层、进度归零、撤销栈清空，可再次刮开 */
function reset() {
  activePointers.clear()
  clearHistoryState()
  suppressFinish = false
  sleeping = false // v4：无论此前是否休眠/冷档淘汰，reset 后回到在线全新卡
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  cancelFade()
  const canvas = canvasRef.value
  // 强制重建：顺带对齐最新的容器尺寸与 DPR（跨屏拖动后 reset 也清晰）
  rebuildCanvas(true)
  // 强制重排，让 opacity:1 与无过渡状态立即生效后再恢复过渡
  void canvas.offsetHeight
  requestAnimationFrame(() => {
    canvas.classList.remove('scratch-canvas--instant')
  })
  lastProgress = 0
  emit('progress', 0)
  syncFlags()
}

/* ================= 快照：save / restore ================= */

/**
 * 固化层位图 -> alpha 网格。遮罩最长边超过 CAP 时先等比降采样再读取：
 * 快照有 2MB 硬约束，而刮痕遮罩高度稀疏，2048 网格已远超刮痕细节
 * 精度；这也让读取发生在有界小画布上，而非逐像素全图读取主画布
 * （渲染/交互主路径全程零 getImageData，仅 save 这个一次性冷路径
 * 读取固化层位图，这是快照功能的必要组成）。
 */
const MASK_SAVE_MAX_DIM = 2048

function maskToGrid(maskCanvas) {
  const w = maskCanvas.width
  const h = maskCanvas.height
  const scale = Math.min(1, MASK_SAVE_MAX_DIM / Math.max(w, h))
  const cols = Math.max(1, Math.round(w * scale))
  const rows = Math.max(1, Math.round(h * scale))
  const tmp = document.createElement('canvas')
  tmp.width = cols
  tmp.height = rows
  const tmpCtx = tmp.getContext('2d', { willReadFrequently: true })
  tmpCtx.drawImage(maskCanvas, 0, 0, w, h, 0, 0, cols, rows)
  const { data } = tmpCtx.getImageData(0, 0, cols, rows)
  const alpha = new Uint8Array(cols * rows)
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) {
    alpha[i] = data[j]
  }
  return { cell: Math.max(1, Math.round(cssWidth / cols)), cols, rows, alpha }
}

function gridToCanvas(grid) {
  const canvas = document.createElement('canvas')
  canvas.width = grid.cols
  canvas.height = grid.rows
  const gridCtx = canvas.getContext('2d')
  const image = gridCtx.createImageData(grid.cols, grid.rows)
  for (let i = 0, j = 3; i < grid.alpha.length; i++, j += 4) {
    image.data[j] = grid.alpha[i]
  }
  gridCtx.putImageData(image, 0, 0)
  return canvas
}

/**
 * v4：把 gridToCanvas 产出的「alpha 网格画布」读回网格（仅
 * encodeCurrentState 在 frozenBaseGrid 尚未被 wake 消费时使用）。
 * 该画布的 RGB 恒 0、仅 alpha 有意义；网格最长边受
 * MASK_SAVE_MAX_DIM 约束，直接读取即可。
 */
function alphaCanvasToGrid(canvas) {
  if (!canvas) return null
  const cols = canvas.width
  const rows = canvas.height
  const g2d = canvas.getContext('2d', { willReadFrequently: true })
  const { data } = g2d.getImageData(0, 0, cols, rows)
  const alpha = new Uint8Array(cols * rows)
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = data[j]
  return { cell: Math.max(1, Math.round(cssWidth / cols)), cols, rows, alpha }
}

/**
 * 对外暴露：导出可序列化快照（Uint8Array，<= 2MB，超出抛错）。
 * 内容是「全部在册笔迹矢量 + 永久固化层位图 + 进度」，不含涂层外观
 * （换肤状态由调用方自己持有）。固化层（solidMask）不存位图：其矢量
 * 全部在册，restore 时重栅格化即可，比重采样位图更精确。
 *
 * 边界场景（v3 ⑤ / v4 墙场景②）：save / saveAll 发生在 rAF
 * 重建/维护挂起或快速滚动期间——先把挂起的 rebuild 与 maintenance
 * 同步冲刷掉（休眠卡走 serializeOffline，不触碰已释放的主画布），
 * 保证快照是最终一致状态；JS 单线程下序列化期间滚动回调无法插入，
 * saveAll 对 50 张卡看到的必是同一份一致状态。
 */
/** 由当前时间线状态编码单卡快照（save 与 serializeOffline 共用） */
function encodeCurrentState() {
  const strokes = slots.map((slot, index) => ({
    i: index,
    w: slot.w,
    alive: slot.alive,
    pts: slot.pts,
  }))
  // 已固化槽位恒为 slots 前缀，一个 solidTo 即可还原分块
  let solidTo = 0
  while (solidTo < slots.length && slots[solidTo].block >= 0) solidTo++
  const slotIndexById = new Map()
  slots.forEach((slot, index) => slotIndexById.set(slot.id, index))
  const redo = []
  for (const id of redoStack) {
    const index = slotIndexById.get(id)
    if (index !== undefined) redo.push(index)
  }
  return encodeSnapshot({
    cssWidth,
    cssHeight,
    dpr,
    progress: lastProgress,
    finished,
    strokes,
    solidTo,
    solid: null,
    // 交织边界：离屏恢复注入的 frozenBaseGrid 可能尚未被 wake 消费成
    // frozenMask（restoreOffline 后未滚回视口就再次被淘汰进冷档）。
    // 两者择一取永久层来源，保证这条路径上的永久层不丢；frozenBaseGrid
    // 本身就是「alpha 网格画布」（gridToCanvas 产物），直接读 alpha 通道。
    perm: frozenDirty
      ? frozenMask
        ? maskToGrid(frozenMask)
        : alphaCanvasToGrid(frozenBaseGrid)
      : null,
    redo,
  })
}

function save() {
  if (!initialized) throw new Error('[scratch] 组件尚未初始化，无法存档')
  // 休眠卡主画布已释放：走离屏序列化（语义与 save 完全一致）
  if (sleeping) return serializeOffline()
  if (rebuildRaf) {
    cancelAnimationFrame(rebuildRaf)
    rebuildRaf = 0
    rebuildCanvas()
  }
  if (maintenanceRaf) {
    cancelAnimationFrame(maintenanceRaf)
    maintenanceRaf = 0
    runMaintenance()
  }

  return encodeCurrentState()
}

/**
 * 对外暴露：从 save() 的快照无损恢复。
 * 非法快照抛错且不影响当前状态（先解码校验，后改状态）。
 * 恢复后响应式、换肤、resize、undo/redo 全部继续正常工作：
 * 状态全部走统一的 slots/遮罩模型重建，后续路径与正常刮擦无异。
 *
 * 边界场景③：淡出期间 restore——cancelFade 取消淡出动画与隐藏
 * 定时器，finished 复位，涂层立即可见可刮。
 *
 * 完成态语义：快照记录存档时的 finished 标志并原样恢复——
 * 存档自已完成卡片 → 恢复为完成态（涂层隐藏，undo/redo 按规则禁用）；
 * 存档自进行中卡片 → 恢复为可继续编辑态，且抑制恢复测量误触发
 * finish（否则覆盖率饱和的快照恢复后 undo/redo 全部被禁用，违背
 * 「restore 后撤销重做继续工作」的语义）；用户再次刮擦时解除抑制，
 * 届时若仍达阈值会正常 finish。
 */
function restore(snapshot) {
  const data = decodeSnapshot(snapshot) // 非法快照在此抛错，当前状态不受影响
  // 公开 restore 保持 v3 语义「恢复到可视、可继续刮的在线状态」：
  // 即便墙已把卡休眠，也先回到在线态再装载（wake 需要在清状态前做，
  // 它内部只翻转标志，真正重建在下方 rebuildCanvas(true) 完成）。
  sleeping = false
  prepareForStateLoad()
  loadTimelineFromSnapshot(data)

  cancelFade()
  const canvas = canvasRef.value
  if (data.finished) {
    // 存档自已完成卡片：直接落到淡出终态（instant 类已抑制过渡）
    finished = true
    canvas.classList.add('scratch-canvas--fading')
    canvas.style.visibility = 'hidden'
  } else {
    // 存档自进行中卡片：恢复为可编辑态，防止恢复测量立即再次 finish
    suppressFinish = true
  }
  // 先回显存档进度（空快照时没有后续测量，靠它恢复 UI）；
  // rebuildCanvas 末尾会重新测量并 emit 实测值，顺序保证最终显示实测值
  lastProgress = data.progress
  emit('progress', data.progress)
  // 按当前尺寸/DPR 强制重建：遮罩迁移（永久层消费注入网格）、
  // 固化层从矢量重栅格化、重放、重新测量进度
  rebuildCanvas(true)
  void canvas.offsetHeight
  requestAnimationFrame(() => {
    canvas.classList.remove('scratch-canvas--instant')
  })

  syncFlags()
  if (data.finished) emit('finish') // 让调用方同步完成态
}

/**
 * v4 离屏恢复：把快照直接装填成「休眠态」（卡滚出视口时墙批量恢复
 * 走这条路径）。与 restore 的区别：不碰 DOM 样式、不分配主 backing
 * store、不 emit；永久层网格暂存到 frozenBaseGrid，留待 wake 的
 * migrateMasks 消费；solid 层保持已释放，wake 时按当时尺寸/DPR
 * 从矢量重栅格化。redo 栈语义与在线 restore 完全一致（快照自带）。
 */
function restoreOffline(snapshot) {
  const data = decodeSnapshot(snapshot) // 非法快照先抛错，当前状态不受影响
  prepareForStateLoad()
  sleeping = true
  loadTimelineFromSnapshot(data)
  finished = !!data.finished
  // 与在线 restore 同一完成态语义：进行中快照抑制「wake 复测立即
  // finish」，否则覆盖率饱和的冷档卡一滚回视口就被自动完成、undo 被
  // 禁用；用户真实刮擦（pointerdown）时解除。完成态快照无需抑制。
  suppressFinish = !data.finished
  lastProgress = data.progress
  syncFlags()
}

/** restore / restoreOffline 共用：取消挂起任务、清旧状态（幂等安全） */
function prepareForStateLoad() {
  if (rebuildRaf) {
    cancelAnimationFrame(rebuildRaf)
    rebuildRaf = 0
  }
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  activePointers.clear()
  clearHistoryState()
}

/** restore / restoreOffline 共用：由解码数据装填时间线与永久层 */
function loadTimelineFromSnapshot(data) {
  for (const item of data.strokes) {
    const slot = {
      id: nextSlotId++,
      w: item.w,
      pts: item.pts,
      alive: item.alive,
      block: -1,
    }
    slots.push(slot)
    slotById.set(slot.id, slot)
    if (slot.alive) undoStack.push(slot.id)
  }
  // 已固化前缀重新分块（分块边界只影响维护粒度，不影响像素）
  const solidTo = Math.min(data.solidTo, slots.length)
  const RESTORE_BLOCK = 128
  for (let start = 0; start < solidTo; start += RESTORE_BLOCK) {
    const ids = []
    const end = Math.min(start + RESTORE_BLOCK, solidTo)
    for (let i = start; i < end; i++) {
      slots[i].block = blocks.length
      ids.push(slots[i].id)
    }
    blocks.push(ids)
  }
  if (solidTo > 0) solidDirty = true // wake/重建时从矢量重栅格化固化层
  // redo 栈（快照里是槽位下标，映射回新 id）
  for (const index of data.redo) {
    const slot = slots[index]
    if (slot && !slot.alive) redoStack.push(slot.id)
  }
  // 永久固化层位图（无矢量来源，只能以位图恢复）
  if (data.perm) {
    frozenBaseGrid = gridToCanvas(data.perm)
    frozenDirty = true
  }
}

/* ================= v4：休眠 / 唤醒 / 离屏序列化（墙支持） ================= */

/** 释放一块 canvas 的 backing store（置 0 尺寸即归还 GPU/内存） */
function releaseCanvas(canvas) {
  if (!canvas) return
  canvas.width = 0
  canvas.height = 0
}

/**
 * 休眠（滚出视口，幂等）。
 *
 * 交织场景①「多指刮擦中被滚走」：真实 pointerup 在滚走后可能再也
 * 不来（指针被滚动取消），所以这里把每个进行中笔迹按「确认」处理：
 * 推入 undoStack。不主动 releasePointerCapture——元素与监听仍在，
 * 浏览器随后派发的 pointerup/cancel 走正常路径（幂等：Map 里已无此
 * pointerId 直接 return），不阻塞休眠也不产生重复入栈。
 *
 * 顺序（重要）：先在主画布还活着时同步跑一轮维护（固化/丢弃，
 * 丢弃会把最旧笔迹烘进 frozenMask——离屏也能做，但必须在释放主
 * 画布前完成 repaint 一致性没有意义，因为我们要的是矢量/永久层
 * 状态最新），再取消 rAF/定时器，最后释放主 backing store 与
 * solidMask（可由矢量重建）。frozenMask 必须保留（无矢量来源）。
 * 淡出定时器取消：finished 卡休眠期间无需动画计时，wake 直接落到
 * visibility:hidden 终态（fade 已在休眠前完成或本就不需要）。
 */
function sleep() {
  if (sleeping || !initialized) return

  // 1) 进行中笔迹全部确认（不丢、不阻塞）
  for (const active of activePointers.values()) {
    undoStack.push(active.slot.id)
  }
  activePointers.clear()

  // 2) 同步冲刷挂起维护（此时仍可正常分配/绘制离屏 frozen 层）
  if (maintenanceRaf) {
    cancelAnimationFrame(maintenanceRaf)
    maintenanceRaf = 0
  }
  runMaintenance()

  // 3) 取消所有挂起的帧/定时器
  if (rebuildRaf) {
    cancelAnimationFrame(rebuildRaf)
    rebuildRaf = 0
  }
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  if (fadeTimer) {
    clearTimeout(fadeTimer)
    fadeTimer = 0
  }
  pendingRepaint = false
  pendingMeasure = false

  // 4) 释放显示资源
  releaseCanvas(canvasRef.value)
  ctx = null
  releaseCanvas(solidMask)
  solidMask = null
  solidCtx = null
  sleeping = true
}

/**
 * 唤醒（滚回视口，幂等）。一次同步 rebuildCanvas(true) 在本调用返回前
 * 完成全部恢复（满足「1 帧内」）：主 backing store 按当前 DPR 重建、
 * frozenMask 消费暂存网格或按新尺寸缩放、solidMask 从矢量重栅格化、
 * 分层重放、进度复测。最坏情况是大批量矢量的 solid 重栅格化（同步，
 * 墙卡片尺寸小 + maxHistory 有界，实测亚毫秒~数毫秒，见 README 验收）；
 * 不为它做异步分帧——异步恢复的中间帧会出现空白涂层，违反 1 帧语义。
 */
function wake() {
  if (!sleeping) return
  sleeping = false
  const canvas = canvasRef.value
  if (finished) {
    // 完成态：sleep 取消了淡出计时，这里直接落终态，避免重放一帧涂层
    canvas.classList.add('scratch-canvas--instant')
    canvas.classList.add('scratch-canvas--fading')
    canvas.style.visibility = 'hidden'
  }
  rebuildCanvas(true) // 内部 migrateMasks 消费 frozenBaseGrid / 缩放旧位图
  if (finished) {
    void canvas.offsetHeight
    requestAnimationFrame(() => canvas.classList.remove('scratch-canvas--instant'))
  }
}

function isSleeping() {
  return sleeping
}

/** v4：是否有任何需要保留的状态（空卡不进冷池，避免白占冷池预算） */
function hasContent() {
  return slots.length > 0 || frozenDirty || finished
}

/**
 * 休眠卡的紧凑序列化（墙冷存档与 saveAll 共用；与在线 save 同格式，
 * 只是绝不触碰已释放的主画布）。序列化前先同步跑一轮维护，使
 * 「该丢进 frozenMask 的最旧笔迹」到位——这同时是交织场景③
 * 「冷存档淘汰与 undo 跨固化边界同帧」的一致点：undo 只改矢量+
 * solidDirty，evict 只搬永久层，JS 单线程顺序执行，这里取到的必是
 * 两者都落地后的状态，序列化期间任何墙回调都无法插入。
 */
function serializeOffline() {
  if (!initialized) throw new Error('[scratch] 组件尚未初始化，无法存档')
  if (maintenanceRaf) {
    cancelAnimationFrame(maintenanceRaf)
    maintenanceRaf = 0
  }
  // runMaintenance 在 sleeping 下会空转，因此显式驱动维护步骤：
  // 丢弃超 maxHistory 最旧笔迹（烘进永久层）。固化层重建在休眠期
  // 无位图消费者（solidMask 已释放），跳过——快照本来就不存 solid。
  if (sleeping) {
    const limit = Math.max(1, Math.floor(props.maxHistory))
    while (undoStack.length > limit) evictOldest()
  } else {
    runMaintenance()
  }
  return encodeCurrentState()
}

/** v4 离线重置（discarded 卡或 restore 未覆盖的卡槽用），不碰 DOM */
function clearStateOffline() {
  prepareForStateLoad()
  sleeping = true
  finished = false
  suppressFinish = false
  lastProgress = 0
  frozenBaseGrid = null
  syncFlags()
}

/**
 * 离线状态内存计量（墙 wallMemoryBudget 的统一口径，见
 * ScratchCardWall 文件头公式注释）：
 *   vectors  矢量笔迹的保守上界估计（真实序列化通常远小于此，
 *            墙用该上界做预算，宁紧勿松）
 *   frozen   永久层 backing store 字节 = width*height*4
 *   main     显示用主画布 + solidMask：仅在线卡 >0；休眠后必为 0
 */
function memoryStats() {
  let points = 0
  for (const slot of slots) points += slot.pts.length
  // 每点两个归一化数：JS 里以 double 存储（16B），外加小数组与槽位
  // 对象的固定开销（槽位 48B + 点数组头 32B 的均摊近似）
  const vectors = points * 16 + slots.length * 80
  const frozen = frozenMask ? frozenMask.width * frozenMask.height * 4 : 0
  const main = sleeping
    ? 0
    : (canvasRef.value && canvasRef.value.width
        ? canvasRef.value.width * canvasRef.value.height * 4
        : 0) +
      (solidMask ? solidMask.width * solidMask.height * 4 : 0)
  return {
    vectors,
    frozen,
    main,
    offline: vectors + frozen, // 休眠卡实际驻留：主画布/solid 已释放
    total: vectors + frozen + main,
    strokes: slots.length,
    points,
    sleeping,
    hasContent: slots.length > 0 || frozenDirty || finished,
  }
}

/* ================= 调试：压测注入（仅调试开关下使用） ================= */

/**
 * 程序化注入 n 笔已确认笔迹（确定性伪随机），用于 50/5000 笔
 * 重放耗时对比。注入后同步冲刷维护队列，让固化/丢弃立即到位，
 * 再重放一次上屏。不触发进度测量（避免 5000 笔直接越过阈值 finish，
 * 干扰 resize 计时观察）。
 */
function seedStrokes(count) {
  if (!initialized || finished || sleeping) return
  clearRedo()
  suppressFinish = true // 见变量注释：压测覆盖率必然越阈
  let s = 12345 // LCG，可复现
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let k = 0; k < count; k++) {
    const slot = {
      id: nextSlotId++,
      w: props.brushSize / cssWidth,
      pts: [],
      alive: true,
      block: -1,
    }
    let x = rand()
    let y = rand()
    slot.pts.push([x, y])
    const steps = 8 + Math.floor(rand() * 16)
    for (let i = 0; i < steps; i++) {
      x = Math.min(1, Math.max(0, x + (rand() - 0.5) * 0.1))
      y = Math.min(1, Math.max(0, y + (rand() - 0.5) * 0.1))
      slot.pts.push([x, y])
    }
    slots.push(slot)
    slotById.set(slot.id, slot)
    undoStack.push(slot.id)
  }
  // 同步冲刷维护队列（逐帧合并的固化/丢弃在这里一次跑完）
  if (maintenanceRaf) {
    cancelAnimationFrame(maintenanceRaf)
    maintenanceRaf = 0
  }
  let guard = 0
  do {
    runMaintenance()
  } while (maintenanceRaf && guard++ < 10000)
  repaint()
  syncFlags()
}

/* ================= 换肤 / 调参 / 生命周期 ================= */

// 运行中修改 coverColor / coverText：只重绘涂层外观，笔迹几何不变，
// 因此 redo 栈保留（语义见文件头注释④）。多指刮擦中换肤也安全。
watch(
  () => [props.coverColor, props.coverText],
  () => {
    if (initialized) repaint()
  }
)

// 运行中修改 threshold：立即按新阈值复核当前进度
watch(
  () => props.threshold,
  () => {
    if (initialized && !finished) measureProgress()
  }
)

// 运行中修改 maxHistory / rasterizeAfter：下一帧维护时按新上限
// 补丢/补固化（只影响后续，不溯及已释放的矢量）
watch(
  () => [props.maxHistory, props.rasterizeAfter],
  () => {
    if (initialized) scheduleMaintenance()
  }
)

onMounted(() => {
  if (props.initSleeping) {
    // v4 墙路径：直接以休眠态启动。rebuildCanvas 的休眠分支只记录
    // CSS 尺寸/DPR、不分配主 backing store；resize/DPR 监听照常挂载，
    // 休眠期变化走离屏 frozen 迁移，wake 时一次重建到位。
    sleeping = true
  }
  rebuildCanvas(true)
  resizeObserver = new ResizeObserver(scheduleRebuild)
  resizeObserver.observe(rootRef.value)
  window.addEventListener('resize', scheduleRebuild)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  if (sampleTimer) clearTimeout(sampleTimer)
  if (fadeTimer) clearTimeout(fadeTimer)
  if (rebuildRaf) cancelAnimationFrame(rebuildRaf)
  if (maintenanceRaf) cancelAnimationFrame(maintenanceRaf)
  if (resizeObserver) resizeObserver.disconnect()
  if (dprMediaQuery) {
    dprMediaQuery.removeEventListener('change', scheduleRebuild)
  }
  window.removeEventListener('resize', scheduleRebuild)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

defineExpose({
  reset,
  undo,
  redo,
  save,
  restore,
  canUndo,
  canRedo,
  // ---- v4 新增（墙支持，均为纯新增，不改动 v3 语义）----
  sleep,
  wake,
  isSleeping,
  serializeOffline,
  restoreOffline,
  clearStateOffline,
  memoryStats,
  hasContent,
  __debug: {
    seed: seedStrokes,
    replayMs: () => lastReplayMs,
    // v4 墙调试：强制睡眠/唤醒（验收休眠恢复用）
    sleep,
    wake,
    stats: () => memoryStats(),
  },
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
      @pointercancel="onPointerUp"
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
