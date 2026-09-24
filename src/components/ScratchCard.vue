<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 通用刮刮卡组件
 *
 * 实现要点：
 * 1. 涂层使用单张 canvas，backing store 按 devicePixelRatio 放大，绘制坐标
 *    统一换算到物理像素空间，因此 DPR=2/3 的屏幕上刮痕边缘依旧清晰，
 *    刮除点与指针点严格对齐、无偏移。
 * 2. 鼠标 / 触屏统一走 Pointer Events，并通过 setPointerCapture 保证指针
 *    移出卡片甚至窗口后仍持续收事件；多根手指以 pointerId 分别记录，
 *    互不干扰。配合 CSS touch-action:none，触屏刮卡不会引发滚动 / 缩放。
 * 3. 快速甩动时用 round 端点 / 圆角连接的线段连接相邻两次采样点，单次
 *    位移远大于笔刷宽度也连续不漏刮。
 * 4. 进度统计不在每次 move 中 getImageData 全图扫描：把卡片划分成网格
 *    （默认格边长 16px），每个 rAF（一帧内多次 move 合并）先用 drawImage
 *    把整卡 GPU 降采样到一张 cols×rows 的离屏小画布，再做一次小画布
 *    getImageData —— 每帧仅一次几百像素级别的读回，增量累加已刮开格子。
 *    取舍：进度以格子为最小粒度（约 16px 的量化误差），对百分比展示与
 *    阈值判定完全够用；换来无全图像素扫描、无逐点多次读回，统计耗时与
 *    刮卡面积无关。
 * 5. window blur 时清掉活动指针，标签页切走再切回不会残留「卡住」的触点。
 */

const props = defineProps({
  // 卡片 CSS 尺寸（数字按 px 处理，也可传 '100%' 等字符串）
  width: { type: [Number, String], default: 320 },
  height: { type: [Number, String], default: 200 },
  // 自动清除涂层的刮开比例阈值（0~1），可配置
  threshold: { type: Number, default: 0.4 },
  // 笔刷直径（CSS px）
  brushSize: { type: Number, default: 28 },
  // 涂层上的引导文案
  coverText: { type: String, default: '刮开查看奖品' },
})

const emit = defineEmits(['progress', 'finish'])

const rootEl = ref(null)
const canvasEl = ref(null)

// 涂层正在整体淡出；finished 后不再响应刮擦
const fading = ref(false)
const finished = ref(false)

let ctx = null
let sampleCanvas = null
let sampleCtx = null
let dpr = 1

// ---- 增量进度统计：网格抽样 ---------------------------------------------
// 目标格子边长（CSS px），实际列数取整以铺满整卡
const CELL = 16
let cols = 0
let rows = 0
let clearedCount = 0
// 每个格子是否已计入「已刮开」，避免重复统计
let cellCleared = []

// 本帧是否已有擦除；rAF 合并同一帧内的多次 move，只统计一次
let dirty = false
let rafId = 0

// 多指针状态：pointerId -> {x, y}（物理像素坐标）
const pointers = new Map()

const toCssSize = (v) => (typeof v === 'number' ? `${v}px` : v)

/**
 * 按当前容器尺寸与 DPR（重新）建立 canvas。
 * @param {boolean} fullReset 是否同时清空刮擦进度（挂载、重置、尺寸变化）
 */
function initCanvas(fullReset = false) {
  const canvas = canvasEl.value
  if (!canvas) return

  const rect = canvas.getBoundingClientRect()
  const nextDpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3))
  const sameSize =
    canvas.width === Math.round(rect.width * nextDpr) &&
    canvas.height === Math.round(rect.height * nextDpr)
  if (sameSize && !fullReset) return

  dpr = nextDpr
  canvas.width = Math.round(rect.width * dpr)
  canvas.height = Math.round(rect.height * dpr)
  ctx = canvas.getContext('2d')

  cols = Math.max(1, Math.round(rect.width / CELL))
  rows = Math.max(1, Math.round(rect.height / CELL))

  // 离屏采样画布：每格对应一个像素，GPU 降采样后只需一次极小读回
  sampleCanvas = document.createElement('canvas')
  sampleCanvas.width = cols
  sampleCanvas.height = rows
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })

  if (fullReset) resetState()
  paintCover()
}

/** 绘制完整灰色涂层（渐变 + 斜纹质感 + 引导文案） */
function paintCover() {
  const w = canvasEl.value.width
  const h = canvasEl.value.height
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, w, h)

  const grad = ctx.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, '#bdbdc4')
  grad.addColorStop(0.5, '#a6a6af')
  grad.addColorStop(1, '#92929c')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  // 斜纹，让涂层更像银漆
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 2 * dpr
  const step = 18 * dpr
  ctx.beginPath()
  for (let x = -h; x < w + h; x += step) {
    ctx.moveTo(x, 0)
    ctx.lineTo(x + h, h)
  }
  ctx.stroke()
  ctx.restore()

  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = `600 ${16 * dpr}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(props.coverText, w / 2, h / 2)
}

/** 清空刮擦相关状态（涂层重绘由调用方负责） */
function resetState() {
  pointers.clear()
  clearedCount = 0
  cellCleared = new Array(cols * rows).fill(false)
  dirty = false
  cancelAnimationFrame(rafId)
  rafId = 0
  fading.value = false
  finished.value = false
}

/** 对外暴露的重置方法：恢复涂层、进度归零、可再次刮开 */
function reset() {
  for (const id of pointers.keys()) {
    try {
      canvasEl.value.releasePointerCapture(id)
    } catch {
      /* 指针已释放 */
    }
  }
  resetState()
  paintCover()
  emit('progress', 0)
}

defineExpose({ reset })

// ---- 指针输入 -----------------------------------------------------------
function getPos(event) {
  // 每次实时取 rect：刮卡过程中页面发生滚动也不会产生偏移
  const rect = canvasEl.value.getBoundingClientRect()
  // 直接按 backing store 比例换算，规避 DPR 取整引入的边缘误差
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvasEl.value.width,
    y: ((event.clientY - rect.top) / rect.height) * canvasEl.value.height,
  }
}

function onPointerDown(event) {
  if (finished.value || fading.value) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  try {
    canvasEl.value.setPointerCapture(event.pointerId)
  } catch {
    /* 个别环境不支持 capture，事件仍会直接派发到元素 */
  }
  const pos = getPos(event)
  pointers.set(event.pointerId, pos)
  eraseDot(pos)
  scheduleScan()
}

function onPointerMove(event) {
  const prev = pointers.get(event.pointerId)
  if (!prev) return
  const pos = getPos(event)
  pointers.set(event.pointerId, pos)
  eraseSegment(prev, pos)
  scheduleScan()
}

function endPointer(event) {
  if (!pointers.has(event.pointerId)) return
  pointers.delete(event.pointerId)
  try {
    canvasEl.value.releasePointerCapture(event.pointerId)
  } catch {
    /* 已释放 */
  }
}

// ---- 擦除 ---------------------------------------------------------------
function eraseDot(pos) {
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = 'rgba(0,0,0,1)'
  ctx.beginPath()
  ctx.arc(pos.x, pos.y, (props.brushSize * dpr) / 2, 0, Math.PI * 2)
  ctx.fill()
}

function eraseSegment(from, to) {
  // round 端点 + round 连接：快速甩动的长线段与点按的圆点视觉一致、无断点
  ctx.globalCompositeOperation = 'destination-out'
  ctx.strokeStyle = 'rgba(0,0,0,1)'
  ctx.lineWidth = props.brushSize * dpr
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
}

// ---- 增量进度统计 -------------------------------------------------------
function scheduleScan() {
  dirty = true
  if (!rafId) rafId = requestAnimationFrame(flushScan)
}

function flushScan() {
  rafId = 0
  if (!dirty || finished.value) {
    dirty = false
    return
  }
  dirty = false

  // GPU 端降采样到 cols×rows，再一次读回这张极小画布：
  // 不扫描全图像素，也避免逐点 getImageData 的数百次同步读回。
  sampleCtx.clearRect(0, 0, cols, rows)
  sampleCtx.drawImage(canvasEl.value, 0, 0, cols, rows)
  const { data } = sampleCtx.getImageData(0, 0, cols, rows)

  for (let i = 0; i < cols * rows; i++) {
    if (cellCleared[i]) continue
    // 降采样后 alpha 低于 128 视为该格已刮开
    if (data[i * 4 + 3] < 128) {
      cellCleared[i] = true
      clearedCount++
    }
  }

  const progress = clearedCount / (cols * rows)
  emit('progress', Math.min(1, progress))
  if (progress >= props.threshold) finish()
}

function finish() {
  if (finished.value) return
  finished.value = true
  pointers.clear()
  requestAnimationFrame(() => {
    fading.value = true
  })
  emit('finish')
}

// 窗口失焦（含标签页切到后台）时收尾活动指针，切回后重新起笔即可正常刮
function onWindowBlur() {
  pointers.clear()
}

let resizeObserver = null
onMounted(() => {
  initCanvas(true)
  emit('progress', 0)

  // 容器尺寸变化（旋转、布局变动）时重建涂层并归零
  resizeObserver = new ResizeObserver(() => initCanvas(true))
  resizeObserver.observe(rootEl.value)
  // 跨屏拖动 / 浏览器缩放导致 DPR 变化时同样重建（尺寸未必变，RO 不一定触发）
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('blur', onWindowBlur)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('blur', onWindowBlur)
})

function onWindowResize() {
  initCanvas(true)
}
</script>

<template>
  <div
    ref="rootEl"
    class="scratch-card"
    :style="{ width: toCssSize(width), height: toCssSize(height) }"
  >
    <!-- 底层：中奖内容，由使用方通过默认插槽传入 -->
    <div class="scratch-card__prize">
      <slot />
    </div>
    <!-- 上层：可刮涂层 -->
    <canvas
      ref="canvasEl"
      class="scratch-card__canvas"
      :class="{ 'is-fading': fading }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endPointer"
      @pointercancel="endPointer"
      @lostpointercapture="endPointer"
    />
  </div>
</template>

<style scoped>
.scratch-card {
  position: relative;
  overflow: hidden;
  border-radius: 16px;
  user-select: none;
  -webkit-user-select: none;
  /* 关键：触屏刮卡不触发页面滚动 / 缩放手势 */
  touch-action: none;
  -webkit-touch-callout: none;
  box-shadow:
    0 10px 30px rgba(0, 0, 0, 0.12),
    0 2px 8px rgba(0, 0, 0, 0.08);
}

.scratch-card__prize {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.scratch-card__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: grab;
  transition: opacity 0.5s ease;
}

.scratch-card__canvas:active {
  cursor: grabbing;
}

.scratch-card__canvas.is-fading {
  opacity: 0;
  pointer-events: none;
}
</style>
