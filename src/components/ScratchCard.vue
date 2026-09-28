<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 通用刮刮卡组件
 *
 * 本轮新增：响应式尺寸（responsive / aspectRatio）、无损 resize、运行时换肤。
 *
 * 核心设计：笔迹矢量化重放
 * - 刮痕不只是一次性画进位图，而是同时以归一化坐标（x/卡宽、y/卡高、
 *   笔宽/卡宽）记录为笔画序列 strokes：位图负责即时上屏，矢量负责重建。
 * - 容器尺寸变化、浏览器缩放、跨屏拖动（devicePixelRatio 变化）时，按新
 *   尺寸重建 backing store 后「重绘涂层 + 等比重放全部笔画」。刮痕整体
 *   等比缩放、边缘始终是新分辨率下的矢量绘制，不会模糊累积，且重建全程
 *   零 getImageData（move/resize 路径无任何像素读取）。
 * - 运行时换肤（coverColor / coverText 变化）走同一条「重绘 + 重放」
 *   路径，已刮区域在新涂层下保持露出；多指刮擦进行中换肤也安全——
 *   进行中的笔画对象已在 strokes 里，重放会带上它，后续 move 继续在新
 *   涂层上增量绘制。
 *
 * 继承上一轮的要点：
 * - 坐标一律 CSS 像素，backing store 按 DPR 放大 + ctx.setTransform(dpr)。
 * - Pointer Events 按 pointerId 维护各自轨迹，多指同时刮互不干扰。
 * - 进度统计用降采样小画布 + ~160ms 节流，不做每次 move 的全图 getImageData。
 * - 快速甩动用粗线段连接相邻点 + getCoalescedEvents() 补点，笔迹连续。
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
})

const emit = defineEmits(['progress', 'finish'])

const rootRef = ref(null)
const canvasRef = ref(null)

let ctx = null
let dpr = 1
let cssWidth = 0
let cssHeight = 0
let initialized = false

/** 是否已经完成（达到阈值，正在/已经淡出） */
let finished = false

/**
 * 已刮笔画的矢量记录（无损重建的唯一事实来源）。
 * 每笔：{ w: 笔宽/卡宽, pts: [[x/卡宽, y/卡高], ...] }，全部归一化，
 * 因此 resize 后按新尺寸等比重放即可，刮痕与进度天然保留。
 * 取舍：长时间刮擦点集线性增长（一场演示通常几千点，重放为亚毫秒级
 * 矢量绘制），不为此引入位图快照压缩，换来任意次 resize / DPR 切换
 * 都不降质。
 */
const strokes = []

/** 各指针的进行状态：pointerId -> { prev: CSS像素坐标, stroke: 当前笔画 } */
const activePointers = new Map()

/* ---------- 进度采样相关 ---------- */

/** 降采样离屏画布，网格间距 12 CSS 像素 */
const SAMPLE_GRID = 12
let sampleCanvas = null
let sampleCtx = null
let sampleCols = 0
let sampleRows = 0
let sampleTimer = 0
let lastMeasureAt = 0
const MEASURE_INTERVAL = 160

/* ---------- 尺寸自适应 ---------- */

let resizeObserver = null
let dprMediaQuery = null
let rebuildRaf = 0

function toCssSize(value) {
  return typeof value === 'number' ? `${value}px` : value
}

/** 根元素样式：响应式模式下宽度 100%，高度交给 CSS aspect-ratio */
const cardStyle = computed(() => {
  if (props.responsive) {
    return { width: '100%', aspectRatio: String(props.aspectRatio) }
  }
  return { width: toCssSize(props.width), height: toCssSize(props.height) }
})

/**
 * 合并触发一次画布重建。
 * 取舍：用 rAF 合并而非「停止变化后再防抖」——拖动窗口边缘 / 旋转屏幕时
 * ResizeObserver 会高频触发，rAF 保证每帧最多重建一次（同帧多次触发自动
 * 去重），且刮擦进行中画布始终跟手；若等防抖结束才重建，过程中画布会被
 * CSS 拉伸模糊、新刮痕落点与指针错位。重建本身（重绘 + 重放）是亚毫秒级
 * 矢量绘制，每帧一次完全可承受。
 */
function scheduleRebuild() {
  if (rebuildRaf) return
  rebuildRaf = requestAnimationFrame(() => {
    rebuildRaf = 0
    rebuildCanvas()
  })
}

/**
 * 监听 DPR 变化（浏览器缩放、跨屏拖动窗口）。
 * matchMedia 的查询条件是一次性的：DPR 变化触发后即失效，
 * 因此每次重建都按当前 DPR 重新注册。
 */
function watchDpr() {
  if (dprMediaQuery) {
    dprMediaQuery.removeEventListener('change', scheduleRebuild)
  }
  dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  dprMediaQuery.addEventListener('change', scheduleRebuild)
}

/**
 * 按当前元素尺寸与 DPR 重建 backing store，并无损恢复涂层与刮痕。
 * @param {boolean} force true 时跳过「尺寸未变」短路（reset 用）
 */
function rebuildCanvas(force = false) {
  const canvas = canvasRef.value
  if (!canvas) return

  watchDpr()

  const rect = canvas.getBoundingClientRect()
  // 元素不可见（display:none 等）时跳过，可见后 ResizeObserver 会再触发
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

  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  repaint()
  initSampler()

  // 竞态处理：resize 途中可能有指针正按着刮，其 prev 还是旧坐标系下的
  // CSS 像素；换算到新坐标系，避免下一段增量线段跨尺寸连接出杂线
  for (const active of activePointers.values()) {
    const last = active.stroke.pts[active.stroke.pts.length - 1]
    active.prev = { x: last[0] * cssWidth, y: last[1] * cssHeight }
  }

  // 重建后按重放的刮痕重新统计一次：进度百分比在 resize 前后保持一致
  // （不会清零）；无刮痕（如刚 reset）或 finished 状态下不再统计，
  // 避免多余的 emit 与极端阈值（0）下的误触发
  if (!finished && strokes.length > 0) measureProgress()
}

/** 重绘完整涂层并等比重放全部刮痕（resize / 换肤 / reset 共用） */
function repaint() {
  paintCover()
  replayStrokes()
}

/** 绘制完整涂层及提示文案（当前变换已缩放到 CSS 像素坐标系） */
function paintCover() {
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  ctx.fillStyle = props.coverColor
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  if (props.coverText) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    // 字号随卡片短边缩放，响应式大尺寸下文案不会显得过小
    const fontSize = Math.round(
      Math.min(Math.max(Math.min(cssWidth, cssHeight) * 0.09, 12), 32)
    )
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(props.coverText, cssWidth / 2, cssHeight / 2)
  }
}

/** 把 strokes 里的归一化笔画按当前尺寸等比重放到涂层上 */
function replayStrokes() {
  if (!strokes.length) return
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    const lineWidth = stroke.w * cssWidth
    const radius = lineWidth / 2
    ctx.lineWidth = lineWidth
    ctx.beginPath()
    ctx.moveTo(stroke.pts[0][0] * cssWidth, stroke.pts[0][1] * cssHeight)
    for (let i = 1; i < stroke.pts.length; i++) {
      ctx.lineTo(stroke.pts[i][0] * cssWidth, stroke.pts[i][1] * cssHeight)
    }
    ctx.stroke()
    // 首尾补圆：单点轻点（pts 只有一个点）也能复现完整圆点笔痕
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
}

/** 按固定网格构建离屏采样画布；网格点透明度即涂层覆盖情况 */
function initSampler() {
  sampleCols = Math.max(1, Math.round(cssWidth / SAMPLE_GRID))
  sampleRows = Math.max(1, Math.round(cssHeight / SAMPLE_GRID))
  if (!sampleCanvas) sampleCanvas = document.createElement('canvas')
  sampleCanvas.width = sampleCols
  sampleCanvas.height = sampleRows
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })
}

/* ---------- 刮除 ---------- */

/**
 * 在两个点之间刮出连续笔迹（增量绘制，立即上屏）。
 * 矢量记录由调用方维护，这里只画位图。
 * 用粗线段连接相邻点并在端点补圆点，快速甩动（单次位移远大于笔宽）时
 * 线段本身覆盖整条路径，不会出现断点或漏刮。
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

/** 指针坐标 -> 相对 canvas 的 CSS 像素坐标（getBoundingClientRect 已扣除缩放/偏移） */
function getPoint(event) {
  const rect = canvasRef.value.getBoundingClientRect()
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }
}

/** 把 CSS 像素坐标追加到当前笔画的归一化记录里 */
function recordPoint(stroke, point) {
  stroke.pts.push([point.x / cssWidth, point.y / cssHeight])
}

function onPointerDown(event) {
  if (finished) return
  event.preventDefault()
  // 多手指：每个 pointerId 独立 setPointerCapture 与轨迹状态
  event.currentTarget.setPointerCapture(event.pointerId)
  const point = getPoint(event)
  // 笔宽同样归一化（相对卡宽），resize 后整笔等比缩放
  const stroke = { w: props.brushSize / cssWidth, pts: [] }
  strokes.push(stroke)
  recordPoint(stroke, point)
  activePointers.set(event.pointerId, { prev: point, stroke })
  scratchSegment(point.x, point.y, point.x, point.y)
  scheduleMeasure(true)
}

function onPointerMove(event) {
  const active = activePointers.get(event.pointerId)
  if (finished || !active) return
  event.preventDefault()

  // 高刷新率设备上浏览器可能合并了多段事件，逐段补画使快速移动时笔迹更平滑
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
  if (!activePointers.has(event.pointerId)) return
  activePointers.delete(event.pointerId)
  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId)
  }
  // 抬手立即统计一次，保证最终进度准确且能及时触发完成
  scheduleMeasure(true)
}

/* ---------- 进度统计（节流 + 降采样） ---------- */

/**
 * 安排一次面积统计。
 * @param {boolean} immediate true 时无视节流间隔立即执行（按下/抬手时使用）
 */
function scheduleMeasure(immediate = false) {
  if (finished) return
  const now = performance.now()
  if (!immediate && now - lastMeasureAt < MEASURE_INTERVAL) {
    // 节流窗口内没有挂起的定时器才安排，避免每帧都挂一个
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

/** 降采样后统计透明采样点占比，得到刮开面积百分比 */
function measureProgress() {
  lastMeasureAt = performance.now()
  if (!sampleCtx || finished) return

  sampleCtx.clearRect(0, 0, sampleCols, sampleRows)
  sampleCtx.drawImage(canvasRef.value, 0, 0, sampleCols, sampleRows)
  const { data } = sampleCtx.getImageData(0, 0, sampleCols, sampleRows)

  let cleared = 0
  // alpha < 128 视为已刮开（半透明边缘按未刮开计，进度只会略微保守）
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 128) cleared++
  }

  const total = sampleCols * sampleRows
  const percent = Math.round((cleared / total) * 100)
  emit('progress', percent)

  if (percent >= props.threshold) {
    finish()
  }
}

/* ---------- 完成与重置 ---------- */

function finish() {
  if (finished) return
  finished = true
  activePointers.clear()
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  // 给 canvas 加透明度过渡类，由 CSS 负责整体淡出
  canvasRef.value.classList.add('scratch-canvas--fading')
  window.setTimeout(() => {
    // finished 为 false 说明淡出期间已被 reset，不再隐藏新涂层
    if (finished && canvasRef.value) {
      canvasRef.value.style.visibility = 'hidden'
    }
  }, props.fadeDuration)
  emit('finish')
}

/** 标签页切到后台时，浏览器可能中断指针序列；清空悬挂状态，
 *  切回后重新按下即可正常刮（规避极少数不派发 pointercancel 的情况） */
function onVisibilityChange() {
  if (document.hidden) activePointers.clear()
}

/** 对外暴露：恢复完整涂层、进度归零，可再次刮开 */
function reset() {
  finished = false
  activePointers.clear()
  strokes.length = 0
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  const canvas = canvasRef.value
  canvas.classList.remove('scratch-canvas--fading')
  canvas.style.visibility = ''
  // 先加 instant 类关闭过渡，避免新涂层从 0 透明度"淡入"
  canvas.classList.add('scratch-canvas--instant')
  // 强制重建：顺带对齐最新的容器尺寸与 DPR（跨屏拖动后 reset 也清晰）。
  // 若此时仍有挂起的 rAF 重建，它会基于空 strokes 再重建一次，结果一致。
  rebuildCanvas(true)
  // 强制重排，让 opacity:1 与无过渡状态立即生效后再恢复过渡
  void canvas.offsetHeight
  requestAnimationFrame(() => {
    canvas.classList.remove('scratch-canvas--instant')
  })
  emit('progress', 0)
}

defineExpose({ reset })

/* ---------- 运行时换肤 / 调阈值 ---------- */

// 运行中修改 coverColor / coverText：重绘涂层 + 重放刮痕，已刮区域保持露出。
// 多指刮擦进行中换肤也安全：重放包含进行中的笔画，后续 move 继续增量绘制。
watch(
  () => [props.coverColor, props.coverText],
  () => {
    if (initialized) repaint()
  }
)

// 运行中修改 threshold：立即按新阈值复核当前进度
// （例如运营把阈值调到已刮开比例以下，应立刻触发完成）
watch(
  () => props.threshold,
  () => {
    if (initialized && !finished) measureProgress()
  }
)

// width / height / responsive / aspectRatio 变更都会引起根元素尺寸变化，
// 由 ResizeObserver 统一捕获并重建，无需逐个 watch。

onMounted(() => {
  rebuildCanvas(true)
  // 容器尺寸变化（响应式跟随父容器、prop 尺寸变更、窗口缩放）统一走这里
  resizeObserver = new ResizeObserver(scheduleRebuild)
  resizeObserver.observe(rootRef.value)
  // 浏览器缩放 / 跨屏拖动时 DPR 变化由 matchMedia 捕获，window resize 兜底
  window.addEventListener('resize', scheduleRebuild)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  if (sampleTimer) clearTimeout(sampleTimer)
  if (rebuildRaf) cancelAnimationFrame(rebuildRaf)
  if (resizeObserver) resizeObserver.disconnect()
  if (dprMediaQuery) {
    dprMediaQuery.removeEventListener('change', scheduleRebuild)
  }
  window.removeEventListener('resize', scheduleRebuild)
  document.removeEventListener('visibilitychange', onVisibilityChange)
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
