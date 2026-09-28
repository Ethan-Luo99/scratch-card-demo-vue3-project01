<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 通用刮刮卡组件
 *
 * 本轮在不增加任何运行时依赖的前提下扩展了三件事：
 *   1) responsive 模式下宽度撑满父容器、高度按 aspectRatio 计算并随容器自适应；
 *   2) 容器尺寸 / devicePixelRatio 变化时无损重建（刮痕等比保留、进度不丢）；
 *   3) 运行时换肤（coverColor / coverText）与阈值（threshold）即时生效。
 *
 * 画布分层（后两者为离屏 canvas，不产生 DOM）：
 * - 显示层 visibleCanvas：实际显示，初始内容 = 涂层层 覆盖 遮罩层（mask 刮空处
 *   让涂层层像素透到下层，再被 destination-out 清掉）。
 * - 涂层层 coverLayer：纯 coverColor 底 + 提示文案。只在首次、换肤、resize 时
 *   按当前 CSS 尺寸整幅重绘（文字始终按新尺寸重新排版，不会被拉伸变糊）。
 * - 遮罩层 maskLayer：记录刮痕的 alpha 通道。刮写时与显示层同步 destination-out；
 *   resize 时把旧遮罩整体等比缩放到新尺寸，因此已刮区域只随卡片等比缩放，
 *   形状与面积占比均保持。
 *
 * 为什么 resize 不用「把显示层直接 drawImage 拉伸」：那样颜色底和文字也会被
 * 插值放大/缩小，跨屏 DPR 2→3 后文字明显发虚。分层后涂层每次按新分辨率重绘，
 * 只有刮痕（本来就是软边笔刷）经历一次缩放，观感无损且边缘依旧清晰。
 *
 * 高清适配：三层 backing store 一律按 devicePixelRatio 放大，上下文统一
 * setTransform(dpr,...)，绘图 API 全部使用 CSS 像素坐标，刮除位置与指针无偏移。
 * 指针输入：Pointer Events + 每 pointerId 独立轨迹，支持鼠标与多指触控；
 * touch-action:none 阻止触屏滚动/缩放。
 * 进度统计：降采样到 SAMPLE_GRID 网格的小离屏画布读取 alpha（几百像素），
 * 配合 ~160ms 节流；指针 move 与 resize 路径上都不做全图 getImageData。
 */

const props = defineProps({
  /** 卡片宽度（CSS 像素，数字按 px 处理）；responsive=true 时失效 */
  width: { type: [Number, String], default: 320 },
  /** 卡片高度（CSS 像素，数字按 px 处理）；responsive=true 时失效 */
  height: { type: [Number, String], default: 180 },
  /** 响应式模式：宽度撑满父容器，高度由 aspectRatio 决定 */
  responsive: { type: Boolean, default: false },
  /** 响应式模式下的宽高比（宽/高），默认 16:9 */
  aspectRatio: { type: Number, default: 16 / 9 },
  /** 自动清除涂层的刮开面积阈值（0-100），运行时修改立即影响后续判定 */
  threshold: { type: Number, default: 40 },
  /** 笔刷直径（CSS 像素） */
  brushSize: { type: Number, default: 28 },
  /** 涂层底色，运行时修改立即重绘且保留刮痕 */
  coverColor: { type: String, default: '#b8bcc6' },
  /** 涂层上的提示文案，传空字符串则不绘制；运行时修改立即重绘且保留刮痕 */
  coverText: { type: String, default: '刮开查看奖品' },
  /** 达到阈值后涂层淡出时长（ms） */
  fadeDuration: { type: Number, default: 500 },
})

const emit = defineEmits(['progress', 'finish'])

const rootRef = ref(null)
const canvasRef = ref(null)

/* ---------- 三层画布与坐标状态 ---------- */

let visibleCtx = null
let coverCanvas = null
let coverCtx = null
let maskCanvas = null
let maskCtx = null

let dpr = 1
let cssWidth = 0
let cssHeight = 0
/** 组件是否已完成首次构建（watch 早于 mounted 触发时需据此忽略） */
let ready = false

/** 是否已经完成（达到阈值，正在/已经淡出） */
let finished = false
/** 各指针上一次所在位置（CSS 像素），key 为 pointerId */
const activePointers = new Map()

/* ---------- 进度采样 ---------- */

/** 降采样离屏画布，网格间距 12 CSS 像素 */
const SAMPLE_GRID = 12
let sampleCanvas = null
let sampleCtx = null
let sampleCols = 0
let sampleRows = 0
let sampleTimer = 0
let lastMeasureAt = 0
const MEASURE_INTERVAL = 160

/* ---------- resize 调度 ---------- */

let resizeObserver = null
let resizeFrame = 0
/** 连续 resize 静止后的收尾定时器（见 scheduleRebuild 的取舍说明） */
let settleTimer = 0
const SETTLE_DELAY = 180
let lastDpr = 1

/**
 * 连续拖动 resize 时的遮罩「基准快照」。
 * 每一帧重建若都从「上一帧已缩放的遮罩」再次缩放到新尺寸，会产生级联插值，
 * 刮痕软边越拖越糊。改为：resize 序列开始时保存一次原始遮罩，之后每帧都从
 * 该快照做一次线性缩放到当前尺寸，插值永远只有一级；resize 期间用户继续刮，
 * 新笔迹按同一组缩放参数同步写进快照（见 scratchSegment），静止收尾后清空。
 */
let resizeSnapshot = null


/* ---------- 尺寸读取 / DPR 监听 ---------- */

function toCssSize(value) {
  return typeof value === 'number' ? `${value}px` : value
}

/** 根节点样式：响应式模式宽度撑满父容器，高度交给 CSS aspect-ratio */
function rootStyle() {
  if (props.responsive) {
    const ratio = props.aspectRatio > 0 ? props.aspectRatio : 16 / 9
    return { width: '100%', height: 'auto', aspectRatio: String(ratio) }
  }
  return { width: toCssSize(props.width), height: toCssSize(props.height) }
}

/** 当前设备 DPR（封顶 3 倍，防止个别设备上报过大值撑爆内存与填充开销） */
function readDpr() {
  return Math.min(window.devicePixelRatio || 1, 3)
}

let dprMql = null
function onDprChange() {
  // 精确分辨率查询失配即说明 DPR 已变（跨屏拖动 / 浏览器缩放都会触发）
  scheduleRebuild()
}
/** 按当前 DPR 重新登记精确匹配查询，使下一次 DPR 变化能被捕获 */
function armDprWatcher() {
  dprMql?.removeEventListener('change', onDprChange)
  dprMql = window.matchMedia(`(resolution: ${dpr}dppx)`)
  dprMql.addEventListener('change', onDprChange)
}

/* ---------- 三层画布构建 / 合成 ---------- */

function makeContext() {
  const canvas = document.createElement('canvas')
  return { canvas, ctx: canvas.getContext('2d') }
}

/**
 * 把三层 backing store 调整到指定 CSS 尺寸与 DPR。
 * 注意：修改 canvas.width/height 会清空位图并重置上下文状态，
 * 因此每次都要重新 setTransform。
 */
function allocateLayers(w, h, newDpr) {
  dpr = newDpr
  cssWidth = w
  cssHeight = h
  for (const layer of [
    { canvas: canvasRef.value, ctx: visibleCtx },
    coverCanvas,
    maskCanvas,
  ]) {
    layer.canvas.width = Math.round(w * dpr)
    layer.canvas.height = Math.round(h * dpr)
    layer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
}

/** 在指定上下文上绘制完整涂层（底色 + 文案），始终按最新尺寸重新排版 */
function paintCoverInto(target) {
  target.globalCompositeOperation = 'source-over'
  target.clearRect(0, 0, cssWidth, cssHeight)
  target.fillStyle = props.coverColor
  target.fillRect(0, 0, cssWidth, cssHeight)

  if (props.coverText) {
    // 字号随高度小幅伸缩（约 8.5% 高），响应式缩到很窄时文案仍协调不溢出
    const fontSize = Math.max(13, Math.min(22, cssHeight * 0.085))
    target.fillStyle = 'rgba(255, 255, 255, 0.85)'
    target.font =
      `600 ${fontSize}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`
    target.textAlign = 'center'
    target.textBaseline = 'middle'
    target.fillText(props.coverText, cssWidth / 2, cssHeight / 2)
  }
}

/**
 * 合成显示层：先铺涂层，再用遮罩层 destination-out 抠出已刮区域。
 * 遮罩层透明 = 未刮（不抠除）；遮罩层不透明白 = 已刮（对应位置被抠透明）。
 */
function compositeVisible() {
  visibleCtx.globalCompositeOperation = 'source-over'
  visibleCtx.clearRect(0, 0, cssWidth, cssHeight)
  visibleCtx.drawImage(coverCanvas, 0, 0, cssWidth, cssHeight)
  visibleCtx.globalCompositeOperation = 'destination-out'
  visibleCtx.drawImage(maskCanvas, 0, 0, cssWidth, cssHeight)
}

/** resize 序列开始时冻结当前遮罩，之后每帧都从它做一级插值缩放 */
function createSnapshot() {
  const snapshot = document.createElement('canvas')
  snapshot.width = maskCanvas.width
  snapshot.height = maskCanvas.height
  const snapshotCtx = snapshot.getContext('2d')
  snapshotCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  snapshotCtx.drawImage(maskCanvas, 0, 0, cssWidth, cssHeight)
  resizeSnapshot = { canvas: snapshot, ctx: snapshotCtx, cssWidth, cssHeight }
}

/**
 * 按容器最新尺寸无损重建三层画布。
 * @returns {boolean} 是否真的发生了尺寸/DPR 变化
 */
function rebuildPreserving() {
  const root = rootRef.value
  if (!root || !coverCanvas) return false

  const rect = root.getBoundingClientRect()
  const newWidth = rect.width
  const newHeight = rect.height
  // display:none 等零尺寸场景跳过本次，待 ResizeObserver 再次回调时重建
  if (newWidth <= 0 || newHeight <= 0) return false

  const newDpr = readDpr()
  if (newWidth === cssWidth && newHeight === cssHeight && newDpr === dpr) {
    return false
  }

  // 首帧变化前冻结旧遮罩（此时 cssWidth/cssHeight 仍是上一次的尺寸）
  if (cssWidth > 0 && cssHeight > 0 && !resizeSnapshot) {
    createSnapshot()
  }

  allocateLayers(newWidth, newHeight, newDpr)
  paintCoverInto(coverCtx)

  // 遮罩层已被 allocate 清空；有快照时等比搬移历史刮痕（始终只一级插值）
  if (resizeSnapshot) {
    maskCtx.globalCompositeOperation = 'source-over'
    // 九参数 drawImage 的源矩形按源位图（设备像素）计，必须用快照实际像素尺寸
    maskCtx.drawImage(
      resizeSnapshot.canvas,
      0, 0, resizeSnapshot.canvas.width, resizeSnapshot.canvas.height,
      0, 0, cssWidth, cssHeight,
    )
  }

  compositeVisible()
  initSampler()
  if (newDpr !== lastDpr) {
    lastDpr = newDpr
    armDprWatcher()
  }

  // 连续拖动期间逐帧重置静止计时；180ms 内没有新尺寸即视为 resize 结束
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => {
    settleTimer = 0
    // 序列结束后释放快照，后续刮痕不再承担坐标映射，直接写当前遮罩
    resizeSnapshot = null
    // 等比缩放后占比理论不变，补测一次以校正取整误差
    scheduleMeasure(true)
  }, SETTLE_DELAY)

  return true
}

/**
 * 合并一帧内的所有 resize 信号（ResizeObserver、window resize、DPR 查询失配、
 * 布局 prop 变化都会触发）。取舍：
 * - 用 rAF 合帧而非纯防抖延迟重建：拖窗期间画面要逐帧跟手，不能等停顿；
 * - 再叠加 180ms 静止收尾，用来释放快照并补测进度；
 * - 整段过程不在指针 move / resize 路径上做任何全图 getImageData。
 */
function scheduleRebuild() {
  if (!ready || resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    rebuildPreserving()
  })
}

/* ---------- 运行时换肤 ---------- */

/**
 * 换肤：只重绘涂层层并重新合成，遮罩层（刮痕）完全不触碰，
 * 已刮区域换肤后依旧露出。JS 单线程，重绘与指针事件不会交错，
 * 多指刮擦进行中换肤也不会丢笔迹（后续 move 事件照常写入两层）。
 */
function reSkin() {
  if (!ready) return
  paintCoverInto(coverCtx)
  compositeVisible()
}


/* ---------- 刮除 ---------- */

/**
 * 在单个上下文上的两点之间刮出连续笔迹。
 * 粗线段连接相邻点并在端点补圆点，快速甩动（单次位移远大于笔宽）时
 * 线段本身覆盖整条路径，不会出现断点或漏刮。
 */
function eraseSegmentOn(target, fromX, fromY, toX, toY, radius) {
  target.globalCompositeOperation = 'destination-out'
  target.lineWidth = props.brushSize
  target.lineCap = 'round'
  target.lineJoin = 'round'
  target.beginPath()
  target.moveTo(fromX, fromY)
  target.lineTo(toX, toY)
  target.stroke()
  // 线段端点补圆，保证单击/轻点也能刮出完整圆形笔痕
  target.beginPath()
  target.arc(toX, toY, radius, 0, Math.PI * 2)
  target.fill()
}

/**
 * 在两个点之间刮除：显示层与遮罩层同步写入。
 * 若正处于 resize 序列（存在快照），刮痕还要按当前尺寸→快照尺寸的比例
 * 回写到快照——这样下一帧重建从快照缩放时，resize 期间新刮的笔迹不会丢；
 * activePointers 始终存当前坐标系的点，帧间重建无需迁移指针状态。
 */
function scratchSegment(fromX, fromY, toX, toY) {
  const radius = props.brushSize / 2
  eraseSegmentOn(visibleCtx, fromX, fromY, toX, toY, radius)
  eraseSegmentOn(maskCtx, fromX, fromY, toX, toY, radius)

  if (resizeSnapshot) {
    const sx = resizeSnapshot.cssWidth / cssWidth
    const sy = resizeSnapshot.cssHeight / cssHeight
    eraseSegmentOn(
      resizeSnapshot.ctx,
      fromX * sx, fromY * sy, toX * sx, toY * sy,
      radius * ((sx + sy) / 2),
    )
  }
}

/** 指针坐标 -> 相对 canvas 的 CSS 像素坐标（getBoundingClientRect 已扣除缩放/偏移） */
function getPoint(event) {
  const rect = canvasRef.value.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
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

/** 按固定网格构建离屏采样画布；网格点透明度即涂层覆盖情况 */
function initSampler() {
  sampleCols = Math.max(1, Math.round(cssWidth / SAMPLE_GRID))
  sampleRows = Math.max(1, Math.round(cssHeight / SAMPLE_GRID))
  if (!sampleCanvas) sampleCanvas = document.createElement('canvas')
  sampleCanvas.width = sampleCols
  sampleCanvas.height = sampleRows
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })
}

/**
 * 安排一次面积统计。
 * @param {boolean} immediate true 时无视节流间隔立即执行（按下/抬手/resize 收尾）
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

/** 降采样后统计透明采样点占比，得到刮开面积百分比（不读全图像素） */
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

  // threshold 为响应式读取，运行时调小阈值后下一次采样即可触发完成
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
  fadeTimer = window.setTimeout(() => {
    // finished 为 false 说明淡出期间已被 reset，不再隐藏新涂层
    if (finished && canvasRef.value) {
      canvasRef.value.style.visibility = 'hidden'
    }
  }, props.fadeDuration)
  emit('finish')
}

let fadeTimer = 0

/** 取消全部 resize 调度状态（reset 时调用，避免旧序列的收尾回调污染新涂层） */
function cancelResizeCycle() {
  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = 0
  }
  if (settleTimer) {
    clearTimeout(settleTimer)
    settleTimer = 0
  }
  resizeSnapshot = null
}

/** 按当前容器尺寸做一次全新（无刮痕）构建，首次挂载与 reset 共用 */
function buildFresh() {
  const rect = rootRef.value.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  lastDpr = readDpr()
  allocateLayers(rect.width, rect.height, lastDpr)
  paintCoverInto(coverCtx)
  // allocateLayers 已清空遮罩层，无需额外擦除
  compositeVisible()
  initSampler()
  armDprWatcher()
}

/**
 * 对外暴露：恢复完整涂层、进度归零，可再次刮开。
 * 即使 resize 正在进行（可能有挂起的 rAF / 静止收尾 / 快照），也先全部取消，
 * 保证 reset 后不会被一次迟到的重建带入旧刮痕。
 */
function reset() {
  finished = false
  activePointers.clear()
  if (sampleTimer) {
    clearTimeout(sampleTimer)
    sampleTimer = 0
  }
  if (fadeTimer) {
    clearTimeout(fadeTimer)
    fadeTimer = 0
  }
  cancelResizeCycle()

  const canvas = canvasRef.value
  canvas.classList.remove('scratch-canvas--fading')
  canvas.style.visibility = ''
  // 先加 instant 类关闭过渡，避免新涂层从 0 透明度“淡入”
  canvas.classList.add('scratch-canvas--instant')
  buildFresh()
  // 强制重排，让 opacity:1 与无过渡状态立即生效后再恢复过渡
  void canvas.offsetHeight
  requestAnimationFrame(() => {
    canvas.classList.remove('scratch-canvas--instant')
  })
  emit('progress', 0)
}

defineExpose({ reset })

/* ---------- prop 响应：布局变化重建，皮肤变化重绘 ---------- */

watch(
  () => [props.responsive, props.aspectRatio, props.width, props.height],
  () => {
    // pre watcher 触发时 DOM 尚未 patch，但内部的 rAF 回调一定在
    // Vue 完成 DOM 更新之后才执行，届时读到的就是新布局尺寸；
    // 同一轮多个 prop 变化也只会安排一帧（resizeFrame 合并）。
    scheduleRebuild()
  },
)
watch(
  () => [props.coverColor, props.coverText],
  () => reSkin(),
)
// threshold 无需 watch：measureProgress 内直接读取 props.threshold，
// 运行时调大/调小立即作用于后续每次采样判定。

/* ---------- 挂载 / 卸载 ---------- */

onMounted(() => {
  visibleCtx = canvasRef.value.getContext('2d')
  ;({ canvas: coverCanvas, ctx: coverCtx } = makeContext())
  ;({ canvas: maskCanvas, ctx: maskCtx } = makeContext())

  ready = true
  buildFresh()

  // 容器尺寸变化（响应式宽度、布局变动、字体加载等）逐帧无损跟随
  resizeObserver = new ResizeObserver(() => scheduleRebuild())
  resizeObserver.observe(rootRef.value)
  // 兜底：个别场景 RO 回调可能与布局帧错开，window resize 再提示一次（rAF 会合并）
  window.addEventListener('resize', scheduleRebuild)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

/** 标签页切到后台时浏览器可能中断指针序列；清空悬挂状态，
 *  切回后重新按下即可正常刮（同时规避极少数不派发 pointercancel 的情况） */
function onVisibilityChange() {
  if (document.hidden) activePointers.clear()
}

onBeforeUnmount(() => {
  if (sampleTimer) clearTimeout(sampleTimer)
  if (fadeTimer) clearTimeout(fadeTimer)
  cancelResizeCycle()
  resizeObserver?.disconnect()
  window.removeEventListener('resize', scheduleRebuild)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  dprMql?.removeEventListener('change', onDprChange)
})
</script>

<template>
  <div ref="rootRef" class="scratch-card" :style="rootStyle()">
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
