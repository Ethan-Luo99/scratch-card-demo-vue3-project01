<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 通用刮刮卡组件
 *
 * 实现要点：
 * - 涂层只有一层 <canvas>，刮除使用 globalCompositeOperation = 'destination-out'，
 *   被擦除的像素直接变透明，露出下面 slot 渲染的中奖内容。
 * - 坐标与尺寸一律使用 CSS 像素；canvas backing store 按 devicePixelRatio 放大，
 *   再通过 ctx.scale(dpr, dpr) 让绘图 API 仍使用 CSS 像素，从而在 2x/3x 屏上
 *   刮痕边缘清晰，且刮除位置与指针位置无偏移。
 * - 指针输入统一走 Pointer Events，每个 pointerId 维护各自的上一个点，
 *   因此多根手指可以同时刮且轨迹互不干扰；touch-action: none 阻止触屏滚动/缩放。
 * - 进度统计不在每次 move 时全图 getImageData（320x180x9 的像素量在高频 move
 *   下开销不可忽视），而是：
 *     1) 把整张涂层降采样绘制到一个很小的离屏 canvas（约 30x17），
 *        每次只读几百个像素的 alpha，和读取全分辨率相比代价极低；
 *     2) 读取再做 ~160ms 节流，刮动期间定时采样，pointerup 时立即补一次。
 *   取舍：以固定网格采样点的透明度估算面积，误差约一个网格（默认网格 12px，
 *   对 40% 阈值的触发时机影响远小于一次节流间隔），换来稳定的 O(几百) 开销，
 *   涂层尺寸变大时成本也几乎不增长。
 */

const props = defineProps({
  /** 卡片宽度（CSS 像素，数字按 px 处理） */
  width: { type: [Number, String], default: 320 },
  /** 卡片高度（CSS 像素，数字按 px 处理） */
  height: { type: [Number, String], default: 180 },
  /** 自动清除涂层的刮开面积阈值（0-100） */
  threshold: { type: Number, default: 40 },
  /** 笔刷直径（CSS 像素） */
  brushSize: { type: Number, default: 28 },
  /** 涂层底色 */
  coverColor: { type: String, default: '#b8bcc6' },
  /** 涂层上的提示文案，传空字符串则不绘制 */
  coverText: { type: String, default: '刮开查看奖品' },
  /** 达到阈值后涂层淡出时长（ms） */
  fadeDuration: { type: Number, default: 500 },
})

const emit = defineEmits(['progress', 'finish'])

const canvasRef = ref(null)

let ctx = null
let dpr = 1
let cssWidth = 0
let cssHeight = 0

/** 是否已经完成（达到阈值，正在/已经淡出） */
let finished = false
/** 各指针上一次所在位置（CSS 像素），key 为 pointerId */
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

/* ---------- 尺寸与涂层绘制 ---------- */

function toCssSize(value) {
  return typeof value === 'number' ? `${value}px` : value
}

/**
 * 初始化（或按当前视口 DPR 重建）canvas backing store 并重绘完整涂层。
 * 重建会清空刮痕，因此同时承担 reset 的画布复位工作。
 */
function setupCanvas() {
  const canvas = canvasRef.value
  if (!canvas) return

  const rect = canvas.getBoundingClientRect()
  cssWidth = rect.width
  cssHeight = rect.height
  // 限制最高 3 倍，避免个别设备报告过大 DPR 导致内存与填充成本激增
  dpr = Math.min(window.devicePixelRatio || 1, 3)

  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)

  ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  paintCover()
  initSampler()
}

/** 绘制完整灰色涂层及提示文案（当前变换已缩放到 CSS 像素坐标系） */
function paintCover() {
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  ctx.fillStyle = props.coverColor
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  if (props.coverText) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.font =
      "600 16px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(props.coverText, cssWidth / 2, cssHeight / 2)
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
 * 在两个点之间刮出连续笔迹。
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
  // 线段端点补圆，保证单击/轻点也能刮出一个完整圆形笔痕
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

function onPointerDown(event) {
  if (finished) return
  event.preventDefault()
  // 多手指：每个 pointerId 独立 setPointerCapture 与轨迹起点
  event.currentTarget.setPointerCapture(event.pointerId)
  const point = getPoint(event)
  activePointers.set(event.pointerId, point)
  scratchSegment(point.x, point.y, point.x, point.y)
  scheduleMeasure(true)
}

function onPointerMove(event) {
  if (finished || !activePointers.has(event.pointerId)) return
  event.preventDefault()

  const prev = activePointers.get(event.pointerId)

  // 高刷新率设备上浏览器可能合并了多段事件，逐段补画使快速移动时笔迹更平滑
  const coalesced =
    typeof event.getCoalescedEvents === 'function'
      ? event.getCoalescedEvents()
      : []
  if (coalesced.length > 0) {
    let from = prev
    for (const ev of coalesced) {
      const to = getPoint(ev)
      scratchSegment(from.x, from.y, to.x, to.y)
      from = to
    }
    activePointers.set(event.pointerId, from)
  } else {
    const to = getPoint(event)
    scratchSegment(prev.x, prev.y, to.x, to.y)
    activePointers.set(event.pointerId, to)
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
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  const canvas = canvasRef.value
  canvas.classList.remove('scratch-canvas--fading')
  canvas.style.visibility = ''
  // 先加 instant 类关闭过渡，避免新涂层从 0 透明度"淡入"
  canvas.classList.add('scratch-canvas--instant')
  // DPR 可能在用户跨屏拖动窗口后变化，重建时顺便按当前 DPR 对齐
  setupCanvas()
  // 强制重排，让 opacity:1 与无过渡状态立即生效后再恢复过渡
  void canvas.offsetHeight
  requestAnimationFrame(() => {
    canvas.classList.remove('scratch-canvas--instant')
  })
  emit('progress', 0)
}

defineExpose({ reset })

onMounted(() => {
  setupCanvas()
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  if (sampleTimer) clearTimeout(sampleTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div
    class="scratch-card"
    :style="{ width: toCssSize(width), height: toCssSize(height) }"
  >
    <!-- 底层中奖内容，完全由调用方通过默认插槽决定 -->
    <div class="scratch-card__prize">
      <slot />
    </div>
    <!-- 上层灰色涂层：touch-action:none 阻止触屏滚动/双击缩放；
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
