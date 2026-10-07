<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ScratchCard from './ScratchCard.vue'
import {
  WALL_ARCHIVE_MAX_BYTES,
  decodeWallArchive,
  detectArchiveKind,
  encodeWallArchive,
  migrateSingleToWall,
} from '../wallCodec.js'

/**
 * 多卡运营墙（v4）
 *
 * 三级卡片状态（cardMeta[i].state）：
 *   active    视口内：主 canvas + solidMask + frozenMask 全部驻留，可交互
 *   sleeping  滚出视口：主 backing store 与 solidMask 已释放，驻留
 *             「矢量时间线 + frozenMask 永久层位图」，计入离线内存预算
 *   archived  LRU 淘汰：连矢量/位图都已释放，只在 wall 级冷存档池保留
 *             一份 save() 同格式的紧凑快照（Uint8Array），计入冷池预算
 *   discarded 冷池再超限被丢弃：只剩空占位，滚回视口恢复为全新空卡
 *
 * ---------------- 内存预算计量口径（公式） ----------------
 * 休眠离线总量（wallMemoryBudget，默认 16MB）：
 *   S_sleep = Σ_sleeping ( V_i + F_i )
 *   V_i = 矢量驻留保守上界 = points_i*16 + slots_i*80 字节
 *        （points 以 double 存，8B/数 × 2 坐标；槽位对象均摊 80B；
 *         该口径是真实 JS 占用的上界估计，宁紧勿松——
 *         实际 save() 差分编码后通常只有其 1/10~1/20）
 *   F_i = frozenMask backing store 字节 = w_px * h_px * 4
 *        （RGBA 每像素 4 字节，canvas 实际尺寸=CSS尺寸×DPR，
 *         宽度高度取 round(css*dpr)，与 ScratchCard 建画布一致）
 *   注意：主显示 canvas 与 solidMask 明确【不计入】——休眠语义保证
 *   它们已释放（为 0）；在线卡的显存/内存不计入离线预算（在线卡数量
 *   由视口大小物理限定，通常只有几张）。采样小画布（~几十 px 宽）与
 *   JS 引擎对象头属于引擎级开销，同样不计入，忽略不计对预算无实质影响。
 *
 * 冷存档池（coldArchiveBudget，默认 8MB）：
 *   S_cold = Σ_archived  cold[i].bytes.length   （快照精确字节数）
 *   这是 save() 同格式紧凑二进制的实际长度，无需估计。
 *
 * ---------------- LRU 淘汰顺序 ----------------
 * 每卡维护 lastUse（真实刮擦 interact 事件刷新；其余动作不刷新——
 * undo/redo/save 不改「最近被刮」这一运营语义；新卡初始 lastUse 取
 * 建卡序号（同秒内也严格有序）。淘汰时只在 sleeping 卡中选 lastUse
 * 最小者（active 卡正在显示，永不直接淘汰）；archived 卡不参与
 * （它们已不占离线预算）。
 *
 * 冷池再超限时的丢弃：archived 卡按「冷档进入冷池的顺序」FIFO 丢弃
 * 最旧（coldOrder 序号），即「最久未交互」在更早一轮已排过序的结果，
 * 与 LRU 目标一致且实现确定、无二次排序歧义。
 *
 * ---------------- 休眠触发时机与 1 帧恢复 ----------------
 * IntersectionObserver root=墙滚动容器、rootMargin=±预取边距：
 * - 离开「视口∪预取带」→ 同步 sleep()（释放 backing store）；
 * - 进入带内 → 同步 wake()，wake 在返回前完成全部重放（同帧上屏）。
 * 预取带让快速滚动时临近视口的卡提前唤醒（用少量内存换流畅度，
 * 取舍见 PROXIMITY 常量注释）。
 *
 * ---------------- redo 栈在休眠/恢复/淘汰后的语义 ----------------
 * 休眠只缓存几何，redo 栈随矢量完整保留，wake 后 canRedo 不变；
 * 淘汰走 save()（redo 栈本就是快照一部分），冷档恢复后 redo 语义与
 * ScratchCard.restore 完全一致。唯一清空 redo 的仍是「刮新一笔/reset」。
 */

const props = defineProps({
  /** 卡槽数据数组（每项是任意结构的奖品描述，经默认作用域插槽回传） */
  cards: { type: Array, default: () => [] },
  /** 最大卡实例数（超过部分不渲染；默认 50） */
  maxCards: { type: Number, default: 50 },
  /** 休眠离线状态总预算（字节，默认 16MB） */
  wallMemoryBudget: { type: Number, default: 16 * 1024 * 1024 },
  /** 冷存档池总大小上限（字节，默认 8MB） */
  coldArchiveBudget: { type: Number, default: 8 * 1024 * 1024 },
  /** IO 预取边距（px）：提前唤醒/延迟休眠的缓冲带，牺牲少量内存 */
  proximity: { type: Number, default: 120 },
  /** 墙滚动区高度（CSS 尺寸字符串，如 '70vh' / '600px'） */
  wallHeight: { type: String, default: '72vh' },
  /** 以下为下发给每张 ScratchCard 的默认 props（可被 cards[i] 覆盖） */
  threshold: { type: Number, default: 40 },
  brushSize: { type: Number, default: 28 },
  coverColor: { type: String, default: '#b8bcc6' },
  coverText: { type: String, default: '刮开查看奖品' },
  fadeDuration: { type: Number, default: 500 },
  maxHistory: { type: Number, default: 200 },
  rasterizeAfter: { type: Number, default: 500 },
  aspectRatio: { type: [Number, String], default: 16 / 9 },
  /** 调试：在每卡右上角显示 状态/内存 徽标（验收用，非生产接口） */
  debugOverlay: { type: Boolean, default: false },
})

const emit = defineEmits([
  'cardProgress',
  'cardFinish',
  // LRU 淘汰：笔迹转入冷存档池（payload: {index, bytes}）
  'cardArchived',
  // 冷池再超限丢弃（payload: {index, bytes}）
  'cardDiscarded',
  // 整墙恢复时把每卡覆盖配置交还给宿主（墙不负责渲染奖品外观）
  'cardConfigRestored',
])

const scrollerRef = ref(null)
const cardRefs = []
const cellRefs = []
let io = null

/** 实际渲染卡槽数 = min(cards.length, maxCards) */
const renderCount = computed(() =>
  Math.min(props.cards.length, Math.max(0, Math.floor(props.maxCards)))
)

/**
 * 每卡槽运行时元数据（下标与 cards 对齐）：
 *   state       active|sleeping|archived|discarded
 *   lastUse     LRU 时间戳（interact 刷新；初值 = index - 1e9）
 *   offline     最近一次 memoryStats 的离线字节（sleeping 卡精确，
 *               active 卡为最近测量，archived/discarded 为 0）
 *   coldBytes   archived 卡冷档字节，其余为 0
 *   progress    0-100
 *   inView      是否在 IO 视口（含预取带）内
 */
const meta = reactive([])
/** 冷存档池：index -> Uint8Array（仅 archived 卡持有） */
const cold = new Map()
/** 冷档进入次序（FIFO 丢弃用）：每项 index，push 入列 */
const coldOrder = []
/** 冷档次序单调序号 + 初始 lastUse 序号 */
/** 冷档进入次序由 coldOrder 数组维护（FIFO 丢弃直接 shift） */

function ensureMeta(length) {
  while (meta.length < length) {
    meta.push({
      state: 'sleeping',
      // 从未交互的卡按下标建卡次序排序：index 0 最旧（最先被淘汰），
      // 用大负基数保证永远早于 performance.now() 量级的真实交互时间
      lastUse: meta.length - 1e9,
      offline: 0,
      coldBytes: 0,
      progress: 0,
      inView: false,
    })
  }
  if (meta.length > length) meta.splice(length)
}
ensureMeta(renderCount.value)
watch(renderCount, (n) => ensureMeta(n))

/* ---------------- 每卡 props 解析 ---------------- */

/** 卡片默认 props 与 cards[i] 上的逐卡覆盖合并（覆盖字段为白名单子集） */
function cardProps(index) {
  const item = props.cards[index] || {}
  const override = item.scratch || {}
  return {
    responsive: true, // 墙内统一响应式撑满卡槽，外观比例由 aspectRatio 控制
    initSleeping: true, // 离屏卡槽零显存启动，由 IO 唤醒（见 ScratchCard 注释）
    aspectRatio: override.aspectRatio ?? props.aspectRatio,
    threshold: override.threshold ?? props.threshold,
    brushSize: override.brushSize ?? props.brushSize,
    coverColor: override.coverColor ?? props.coverColor,
    coverText: override.coverText ?? props.coverText,
    fadeDuration: override.fadeDuration ?? props.fadeDuration,
    maxHistory: override.maxHistory ?? props.maxHistory,
    rasterizeAfter: override.rasterizeAfter ?? props.rasterizeAfter,
  }
}

/** 归档时要写进容器的逐卡覆盖配置（与墙 props 默认值不同才记录） */
function cardConfigRecord(index) {
  const item = props.cards[index] || {}
  const o = item.scratch
  if (!o) return null
  return {
    coverText: o.coverText ?? cardProps(index).coverText,
    coverColor: o.coverColor ?? cardProps(index).coverColor,
    responsive: true,
    aspectRatio: Number(o.aspectRatio ?? cardProps(index).aspectRatio),
    threshold: o.threshold ?? cardProps(index).threshold,
    brushSize: o.brushSize ?? cardProps(index).brushSize,
    fadeDuration: o.fadeDuration ?? cardProps(index).fadeDuration,
    maxHistory: o.maxHistory ?? cardProps(index).maxHistory,
    rasterizeAfter: o.rasterizeAfter ?? cardProps(index).rasterizeAfter,
  }
}

function setCardRef(index, el) {
  // 按下标定点赋值（卸载置 null）：不用 splice，否则相邻槽位的
  // 收缩会把 ref 整体移位、与卡槽下标错位
  cardRefs[index] = el || null
}
function setCellRef(index, el) {
  cellRefs[index] = el || null
}

/* ---------------- 视口感知：sleep / wake ---------------- */

function cardAt(index) {
  return cardRefs[index] || null
}

/**
 * 滚出视口：active/sleeping 均可重复进入（幂等）。sleep 内部完成
 * 进行中笔迹确认与 backing store 释放（见 ScratchCard.sleep 注释）。
 */
function sleepCard(index) {
  const card = cardAt(index)
  const m = meta[index]
  if (!card || !m) return
  // 已在冷池/已丢弃的卡不允许被重复的 IO 离场回调降级：它们的实例
  // 是清空后的休眠态，状态机只能由 wakeCard（滚回视口）推进。
  if (m.state === 'archived' || m.state === 'discarded') return
  if (m.state === 'active' || (m.state === 'sleeping' && !card.isSleeping())) {
    card.sleep()
  }
  m.state = 'sleeping'
  m.inView = false
  refreshOffline(index)
  enforceBudget()
}

/**
 * 滚回视口（同步，1 帧内恢复）：
 * - archived：从冷池取快照 → restoreOffline 装填休眠态 → wake 重建；
 *   冷档移除（其字节随即从冷池计量中消失）。冷档可能来自旧版本
 *   编码器：restoreOffline → decodeSnapshot 走注册的迁移路径。
 * - discarded：清空离线状态后 wake，呈现全新空卡（数据已被丢弃，
 *   语义就是「不可恢复」）。
 * - active：幂等，仅同步状态。
 */
function wakeCard(index) {
  const card = cardAt(index)
  const m = meta[index]
  if (!card || !m) return
  m.inView = true

  if (m.state === 'archived') {
    const bytes = cold.get(index)
    cold.delete(index)
    const at = coldOrder.indexOf(index)
    if (at >= 0) coldOrder.splice(at, 1)
    m.coldBytes = 0
    if (bytes) {
      card.restoreOffline(bytes) // 旧版本快照在此经迁移路径解码
    } else {
      card.clearStateOffline()
    }
  } else if (m.state === 'discarded') {
    card.clearStateOffline()
  }
  // 注意：wake 不刷新 lastUse——「被动滚回视口」不是用户交互，
  // 否则快速来回滚动会把所有卡都「洗」成最近使用，LRU 失效。
  if (card.isSleeping()) card.wake()
  m.state = 'active'
  refreshOffline(index)
}

function handleIntersection(entries) {
  for (const entry of entries) {
    const index = Number(entry.target.dataset.cardIndex)
    if (!Number.isInteger(index)) continue
    if (entry.isIntersecting) wakeCard(index)
    else sleepCard(index)
  }
}

/* ---------------- 预算计量与 LRU 淘汰 ---------------- */

function refreshOffline(index) {
  const card = cardAt(index)
  const m = meta[index]
  if (!card || !m) return
  if (m.state === 'archived') {
    m.offline = 0
    return
  }
  const stats = card.memoryStats()
  m.offline = stats.offline
}

/** 墙当前离线总量 / 冷池总量（见文件头公式） */
const offlineTotal = computed(() =>
  meta.reduce((sum, m) => sum + (m.state === 'sleeping' ? m.offline : 0), 0)
)
const coldTotal = computed(() =>
  meta.reduce((sum, m) => sum + m.coldBytes, 0)
)

/**
 * 离线预算超限 → LRU 淘汰最久未交互的【休眠卡】为冷档。
 * 触发点：每次 sleepCard 之后（休眠改变离线总量）。单线程下本函数
 * 与某卡 undo（即使 undo 导致 evictOldest 跨固化边界）不可能真正
 * 「同时」执行：它们要么在同一 IO/事件回调里顺序完成、要么分属
 * 不同任务——serializeOffline 自己还会先冲刷该卡维护，因此交织
 * 场景③（淘汰与 undo 跨固化边界同帧）取到的恒为一致状态。
 */
function enforceBudget() {
  let guard = 0
  while (offlineTotal.value > props.wallMemoryBudget && guard++ < props.maxCards + 1) {
    // 只选 sleeping 卡：active 卡在屏上不能淘汰（会造成可视状态丢失）；
    // archived/discarded 已不占离线预算。
    let victim = -1
    let oldest = Infinity
    for (let i = 0; i < meta.length; i++) {
      if (meta[i].state === 'sleeping' && meta[i].lastUse < oldest) {
        oldest = meta[i].lastUse
        victim = i
      }
    }
    if (victim < 0) break
    archiveCard(victim)
  }
}

/** 把一张休眠卡序列化进冷池，释放其矢量/位图驻留（→ archived） */
function archiveCard(index) {
  const card = cardAt(index)
  const m = meta[index]
  if (!card || !m || m.state !== 'sleeping') return
  // 从未刮过的空卡无几何可存：不消耗冷池预算，直接转 discarded 语义
  // 等价（滚回视口本来就该是全新空卡）；状态记 discarded 而非 archived。
  if (!card.hasContent()) {
    card.clearStateOffline()
    m.state = 'discarded'
    m.offline = 0
    return
  }
  const bytes = card.serializeOffline()
  card.clearStateOffline() // 释放矢量/frozenMask 驻留（清成空休眠态）
  cold.set(index, bytes)
  coldOrder.push(index)
  m.state = 'archived'
  m.coldBytes = bytes.length
  m.offline = 0
  emit('cardArchived', { index, bytes, size: bytes.length })
  enforceColdPool()
}

/**
 * 冷池超限时 FIFO 丢弃最旧冷档（进入冷池次序 = 更早一轮 LRU 结论）。
 * 丢弃后该卡为 discarded：滚回视口恢复为全新空卡。
 */
function enforceColdPool() {
  let guard = 0
  while (coldTotal.value > props.coldArchiveBudget && coldOrder.length && guard++ < 1000) {
    const index = coldOrder.shift()
    const bytes = cold.get(index)
    cold.delete(index)
    const m = meta[index]
    const size = bytes ? bytes.length : 0
    if (m) m.coldBytes = 0
    if (m) m.state = 'discarded'
    emit('cardDiscarded', { index, bytes, size })
  }
}

/* ---------------- 批量存档 / 整墙恢复 ---------------- */

/**
 * 保存整墙为单一 Uint8Array 归档（<= 8MB，超限抛错）。
 * 状态来源：active/sleeping 卡即时序列化（save 同格式；sleeping 走
 * serializeOffline 不碰主画布）；archived 卡直接复用冷池里的现成
 * 冷档（无需重新构造，几何完全等价）；discarded 与空卡不出段。
 * 交织场景②（滚动中 saveAll）：IO 回调与本函数同属事件循环任务，
 * 序列化全程同步、不 await，期间任何 sleep/wake 都无法插入，
 * 50 张卡取到的是同一时刻的一致快照。
 */
function saveAll() {
  const entries = []
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i]
    let snapshot = null
    if (m.state === 'archived') {
      snapshot = cold.get(i) || null
    } else if (m.state === 'discarded') {
      snapshot = null
    } else {
      const card = cardAt(i)
      // 空卡不产生几何段（restore 时未覆盖卡槽天然回出厂态）
      if (card && card.hasContent()) snapshot = card.save()
    }
    const config = cardConfigRecord(i)
    // snapshot 是 'SC1' 单卡快照（空卡也含完整头部）；空卡 + 无覆盖
    // 配置则不出段，由 restore 侧「未覆盖卡槽回出厂态」覆盖其语义
    if (snapshot || config) {
      entries.push({ index: i, snapshot: snapshot || null, config })
    }
  }
  return encodeWallArchive({ capacity: meta.length, entries })
}

/**
 * 整墙恢复。同时接受：
 *   1) 墙容器（'SCWL'）：按段恢复；
 *   2) v3 单卡快照（'SC1'）：自动经 migrateSingleToWall 迁移成
 *      capacity=1 的墙（交织场景⑤的 v3→wall 迁移演示入口）。
 *
 * 卡数与当前卡槽不一致的语义（有意如此，理由附后）：
 *   - 段下标 >= 现有卡槽数（归档容量更大）：裁剪忽略该段，记入
 *     返回值 truncated，不抛错。理由：奖品内容由宿主的 cards 数组
 *     决定，墙不能凭空造出品卡槽位；「保留数据但没有位置可放」在
 *     UI 上无法表达，静默裁剪比整包失败更可运营，且返回值明确告知。
 *   - 现有卡槽多于归档段：未覆盖的卡槽【全部重置为全新空卡】。
 *     理由：restore 的直觉语义是「墙变成归档时的样子」，保留旧卡
 *     刮痕会制造半新半旧的困惑状态；全新空卡即刮刮卡的出厂状态。
 *
 * 分帧执行（每帧最多 CHUNK 张）避免 50 张卡同帧恢复卡死滚动；
 * 交织场景④（恢复进行中 DPR 变化）：目标尺寸在每张卡实际恢复时
 * 才读取——视口内卡走在线 restore（用当时 DPR 重建），离屏卡走
 * restoreOffline 只存矢量，wake 时再按最新 DPR 重建；恢复期间
 * 已有的 matchMedia 监听照常工作，因此 DPR 在中途变化不会产生
 * 任何按旧 DPR 固化的位图（frozen 层以归一化网格存储，与 DPR 无关）。
 *
 * @returns Promise<{restored:number, truncated:number, reset:number,
 *                    migrated:'single'|'none'}>
 */
function wallRestore(archive) {
  return new Promise((resolve, reject) => {
    let decoded
    let migrated = 'none'
    try {
      const kind = detectArchiveKind(archive)
      if (kind === 'single') {
        decoded = decodeWallArchive(migrateSingleToWall(archive))
        migrated = 'single'
      } else if (kind === 'wall') {
        decoded = decodeWallArchive(archive)
      } else {
        throw new Error('[wall] restore 输入既不是墙归档也不是单卡快照')
      }
    } catch (err) {
      reject(err)
      return
    }

    const capacity = meta.length
    const usable = decoded.entries.filter((e) => e.index < capacity)
    const truncated = decoded.entries.length - usable.length
    const covered = new Set(usable.map((e) => e.index))

    // 未覆盖卡槽全部回出厂态（不等待分帧，先把整墙置为确定状态，
    // 恢复期间用户滚到未处理的卡槽也只会看到全新空卡而非旧状态）
    for (let i = 0; i < capacity; i++) {
      if (!covered.has(i)) resetCardToBlank(i)
    }

    const CHUNK = 6
    let cursor = 0
    let restored = 0

    const restoreChunk = () => {
      const end = Math.min(cursor + CHUNK, usable.length)
      for (; cursor < end; cursor++) {
        const entry = usable[cursor]
        const i = entry.index
        const m = meta[i]
        const card = cardAt(i)
        if (!card || !m) continue

        // 该卡此前若为 archived，旧冷档已被「恢复动作」取代：
        // 必须从冷池移除并清零计量，否则同一份几何会被重复计入冷池，
        // 且 state 停在 archived 与已装载的实例状态不一致。
        if (cold.has(i)) {
          cold.delete(i)
          const at = coldOrder.indexOf(i)
          if (at >= 0) coldOrder.splice(at, 1)
          m.coldBytes = 0
        }

        // 几何恢复：按卡片此刻是否在视口选择在线/离屏路径。
        // 恢复中途滚入/滚出也安全——两条路径装载的是同一份时间线。
        if (entry.snapshot) {
          if (m.inView && m.state === 'active' && !card.isSleeping()) {
            card.restore(entry.snapshot)
            m.state = 'active'
          } else {
            card.restoreOffline(entry.snapshot)
            if (m.inView) {
              card.wake()
              m.state = 'active'
            } else {
              m.state = 'sleeping'
            }
          }
        } else if (m.state === 'archived' || m.state === 'discarded') {
          // 只有配置段、没有几何段：回出厂空卡
          resetCardToBlank(i)
        }
        if (entry.config) {
          // 外观配置交还给宿主：墙不知道奖品数据，但可以把 scratch
          // 覆盖项回传，宿主可选择写回 cards[i].scratch
          emit('cardConfigRestored', { index: i, config: entry.config })
        }
        refreshOffline(i)
        restored++
      }

      if (cursor < usable.length) {
        requestAnimationFrame(restoreChunk)
      } else {
        resolve({
          restored,
          truncated,
          reset: capacity - covered.size,
          migrated,
        })
      }
    }
    restoreChunk()
  })
}

/** 把一张卡重置为全新空卡（保持其当前在/离屏状态，不强制唤醒） */
function resetCardToBlank(index) {
  const card = cardAt(index)
  const m = meta[index]
  if (!card || !m) return
  if (cold.has(index)) {
    cold.delete(index)
    const at = coldOrder.indexOf(index)
    if (at >= 0) coldOrder.splice(at, 1)
  }
  if (card.isSleeping()) {
    card.clearStateOffline()
  } else {
    card.reset()
  }
  m.state = m.inView ? 'active' : 'sleeping'
  m.coldBytes = 0
  m.progress = 0
  refreshOffline(index)
}

function resetAll() {
  for (let i = 0; i < meta.length; i++) resetCardToBlank(i)
}

/* ---------------- 事件转发 / LRU ---------------- */

function onInteract(index) {
  if (meta[index]) meta[index].lastUse = performance.now()
}
function onCardProgress(index, value) {
  if (meta[index]) meta[index].progress = value
  emit('cardProgress', { index, progress: value })
}
function onCardFinish(index) {
  emit('cardFinish', { index })
}

/* ---------------- 生命周期 ---------------- */

onMounted(() => {
  io = new IntersectionObserver(handleIntersection, {
    root: scrollerRef.value,
    rootMargin: `${props.proximity}px 0px`,
    threshold: 0,
  })
  // v-for 的 ref 可能在 onMounted 之后才全部回填，下一帧统一观察一次，
  // watch(renderCount) 里靠 __wallObserved 幂等去重，新增槽位只挂一次
  requestAnimationFrame(observeAllCells)
})

function observeAllCells() {
  for (const el of cellRefs) {
    if (el && !el.__wallObserved) {
      el.__wallObserved = true
      io?.observe(el)
    }
  }
}

watch(renderCount, (n, old) => {
  // 卡槽增减：观察新元素；缩容时冷池/元数据由 ensureMeta 截断，
  // 被裁掉下标的冷档同步释放（它们已没有对应卡槽，无法再被取回）
  if (n < old) {
    for (let i = n; i < (old || 0); i++) {
      cold.delete(i)
      const at = coldOrder.indexOf(i)
      if (at >= 0) coldOrder.splice(at, 1)
    }
  }
  requestAnimationFrame(() => {
    for (const el of cellRefs) {
      if (el && !el.__wallObserved) {
        el.__wallObserved = true
        io?.observe(el)
      }
    }
  })
})

onBeforeUnmount(() => {
  io?.disconnect()
  io = null
})

/* ---------------- 暴露给父级 / 调试面板 ---------------- */

function getMeta() {
  return meta
}
function getTotals() {
  return {
    offline: offlineTotal.value,
    cold: coldTotal.value,
    offlineBudget: props.wallMemoryBudget,
    coldBudget: props.coldArchiveBudget,
    cards: meta.length,
    active: meta.filter((m) => m.state === 'active').length,
    sleeping: meta.filter((m) => m.state === 'sleeping').length,
    archived: meta.filter((m) => m.state === 'archived').length,
    discarded: meta.filter((m) => m.state === 'discarded').length,
  }
}

/** 调试：强制把一张在屏卡立即休眠/唤醒（验收休眠恢复） */
function __sleepAt(index) {
  sleepCard(index)
}
function __wakeAt(index) {
  wakeCard(index)
}
/** 调试：强制淘汰一张休眠卡（不经过预算判定） */
function __archiveAt(index) {
  const m = meta[index]
  if (!m || m.state === 'archived' || m.state === 'discarded') return
  if (!cardAt(index)?.isSleeping()) sleepCard(index)
  archiveCard(index)
}
/** 调试：向指定卡灌入大量笔迹（会先唤醒） */
function __seedAt(index, count) {
  const card = cardAt(index)
  const m = meta[index]
  if (!card || !m) return
  if (card.isSleeping()) wakeCard(index)
  card.__debug.seed(count)
  onInteract(index)
  refreshOffline(index)
}
/** 调试：模拟快速滚动（programmatic，往返若干屏） */
function __fastScroll(times = 6) {
  const el = scrollerRef.value
  if (!el) return Promise.resolve()
  const max = el.scrollHeight - el.clientHeight
  let n = 0
  return new Promise((resolve) => {
    const step = () => {
      el.scrollTo({ top: n % 2 === 0 ? max : 0 })
      n++
      if (n < times * 2) setTimeout(step, 120)
      else resolve()
    }
    step()
  })
}

defineExpose({
  saveAll,
  wallRestore,
  resetAll,
  getMeta,
  getTotals,
  cardAt,
  __sleepAt,
  __wakeAt,
  __archiveAt,
  __seedAt,
  __fastScroll,
})
</script>

<template>
  <div ref="scrollerRef" class="scratch-wall" :style="{ height: wallHeight }">
    <div class="scratch-wall__grid">
      <div
        v-for="index in renderCount"
        :key="index - 1"
        :ref="(el) => setCellRef(index - 1, el)"
        :data-card-index="index - 1"
        class="scratch-wall__cell"
      >
        <ScratchCard
          :ref="(el) => setCardRef(index - 1, el)"
          class="scratch-wall__card"
          v-bind="cardProps(index - 1)"
          @interact="onInteract(index - 1)"
          @progress="(v) => onCardProgress(index - 1, v)"
          @finish="onCardFinish(index - 1)"
        >
          <!-- 作用域插槽：把奖品内容与索引回传给宿主 -->
          <slot :card="cards[index - 1]" :index="index - 1">
            <div class="scratch-wall__default-prize">
              <strong>奖品 {{ index }}</strong>
            </div>
          </slot>
        </ScratchCard>

        <!--
          休眠占位层：initSleeping 卡的主 canvas backing store 为 0，
          wake 之前底层奖品会裸露（剧透）；用与涂层同色的轻量 div 盖住。
          纯 CSS 无 canvas，离屏卡的显存占用仍为 0。pointer-events:none
          保证不挡 IO/滚动；卡片一 active 即移除，与 wake 同帧切换。
        -->
        <div
          v-if="meta[index - 1].state !== 'active'"
          class="scratch-wall__cover"
          :style="{ background: cardProps(index - 1).coverColor }"
        />

        <!-- 调试徽标（非生产接口） -->
        <div v-if="debugOverlay" class="scratch-wall__badge" :data-state="meta[index - 1].state">
          <span>{{ index - 1 }} · {{ meta[index - 1].state }}</span>
          <span>
            {{
              meta[index - 1].state === 'archived'
                ? (meta[index - 1].coldBytes / 1024).toFixed(1) + 'KB冷'
                : (meta[index - 1].offline / 1024).toFixed(1) + 'KB'
            }}
          </span>
          <span>{{ meta[index - 1].progress }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scratch-wall {
  overflow-y: auto;
  overflow-x: hidden;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #f8fafc;
  /* 滚动惯性 + 滚动容器自身作为 IO root */
  -webkit-overflow-scrolling: touch;
}

.scratch-wall__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
  padding: 14px;
  box-sizing: border-box;
}

.scratch-wall__cell {
  position: relative;
  border-radius: 12px;
}

.scratch-wall__card {
  width: 100%;
  display: block;
}

/* 休眠占位：absolute 覆盖整格、圆角与卡一致；纯 CSS，零 canvas 显存 */
.scratch-wall__cover {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: 12px;
  pointer-events: none;
  transition: opacity 120ms ease;
}

.scratch-wall__default-prize {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #c2410c;
  background: linear-gradient(160deg, #fff7ed 0%, #ffedd5 100%);
}

.scratch-wall__badge {
  position: absolute;
  top: 4px;
  left: 4px;
  z-index: 2;
  display: flex;
  gap: 6px;
  padding: 2px 6px;
  font-size: 10px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  color: #fff;
  background: rgba(17, 24, 39, 0.62);
  border-radius: 6px;
  pointer-events: none;
}

.scratch-wall__badge[data-state='active'] {
  background: rgba(22, 101, 52, 0.72);
}
.scratch-wall__badge[data-state='sleeping'] {
  background: rgba(37, 99, 235, 0.72);
}
.scratch-wall__badge[data-state='archived'] {
  background: rgba(124, 58, 237, 0.78);
}
.scratch-wall__badge[data-state='discarded'] {
  background: rgba(185, 28, 28, 0.78);
}
</style>
