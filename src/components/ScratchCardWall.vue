<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ScratchCard from './ScratchCard.vue'
import {
  decodeWall,
  encodeWall,
  extractCardSegment,
  isWallArchive,
  migrateV3CardToWall,
  SEG_ARCHIVED,
  SEG_DISCARDED,
  SEG_LIVE,
} from '../wallCodec.js'
import { isCardSnapshot } from '../scratchCodec.js'

/**
 * 多卡运营墙（v4 新增，不改 ScratchCard 任何 v3 对外接口）
 *
 * 卡槽模型：props.cards 是奖品数据数组，索引即卡槽号；卡片数量变化时
 * 按索引对齐（见 watch(cards) 注释）。每张卡是一个 ScratchCard 实例，
 * v3 全部能力（undo/redo/save/restore/换肤/阈值）经 cardProps 透传。
 *
 * 每卡生命周期状态机（record.state）：
 *   'active'    视口内：持有 canvas backing store，可交互
 *   'sleeping'  滚出视口：backing store 已释放，仅持 sleepBytes 离线快照
 *   'archived'  LRU 淘汰：在册状态已释放，笔迹在冷存档池 coldPool
 *   'discarded' 冷池也放不下：冷档已丢弃（槽位保留，恢复为空白卡）
 *
 * ------------------------------------------------------------------
 * 全局内存预算口径（验收要求的明确公式）
 * ------------------------------------------------------------------
 * 活跃卡不占「离线预算」：其成本是 canvas backing store 显存，大小由
 * 视口内卡数（有自然上限，取决于网格列数）与单卡分辨率决定，属于 GPU
 * 预算而非 JS 堆预算；面板会单独显示显存量级（gpuBytes）。
 *
 *   sleepBudgetBytes = Σ sleeping 卡 sleepBytes.byteLength
 *                      （空白卡 = 0，不产生快照）
 *     必须 <= wallMemoryBudget（默认 16MB）
 *
 *   coldBudgetBytes  = Σ coldPool 中冷档 Uint8Array.byteLength
 *     必须 <= coldMemoryBudget（默认 8MB）
 *
 * 为什么休眠字节「含两张固化位图」：sleepBytes 是唤醒后逐像素恢复的
 * 唯一依据，solid 加速网格保证 1 帧出图，frozen 网格是无矢量来源的
 * 永久层，两者都不可省；预算因此按序列化后的真实字节数（而非矢量
 * 条数）记账——这正是调用方设预算时关心的堆占用，公式无隐藏项。
 *
 * ------------------------------------------------------------------
 * LRU 淘汰顺序
 * ------------------------------------------------------------------
 * 1. sleepBudget 超 wallMemoryBudget 时，在 sleeping 卡中按 lastUsedAt
 *    最旧优先（并列取卡槽索引更小者，保证确定性）淘汰，转入冷池；
 * 2. 冷池放入后超 coldMemoryBudget 时，按入池顺序（天然即最旧）丢弃，
 *    被丢卡置 'discarded' 并 emit onCardDiscarded。
 *
 * lastUsedAt 的更新口径（设计取舍：滚回视口本身不算「交互」）：
 *   - 指针按下刮出新笔迹（progress 事件）；
 *   - undo/redo/save/restore/seed 等显式操作该卡；
 *   单纯滚出/滚入只改变可见性，不刷新 LRU——否则快速来回滚动会让
 *   一张从未被玩的卡永远最「新」，LRU 退化为 FIFO by visibility。
 *
 * ------------------------------------------------------------------
 * redo 栈在休眠/淘汰后的语义
 * ------------------------------------------------------------------
 * sleepBytes 是 ScratchCard.save() 的完整产物，redo 栈逐字在内；
 * 唤醒后 redo 可继续。冷档同一份字节，重新激活（activateArchived）
 * 后 redo 栈同样恢复。唯一清空 redo 的仍是 v3 语义（刮新笔/reset）。
 */

const props = defineProps({
  /** 卡槽数组：每项是该卡奖品数据，经默认插槽 #default="{ card, index }" 传出 */
  cards: { type: Array, default: () => [] },
  /** 墙内最多卡实例数（超出的 cards 不渲染；saveAll 也不含它们） */
  maxCards: { type: Number, default: 50 },
  /** 全部休眠卡离线状态总预算（字节，默认 16MB），超出触发 LRU 淘汰 */
  wallMemoryBudget: { type: Number, default: 16 * 1024 * 1024 },
  /** 冷存档池总预算（字节，默认 8MB） */
  coldMemoryBudget: { type: Number, default: 8 * 1024 * 1024 },
  /** 透传给每张 ScratchCard 的 props（threshold/brushSize/coverColor…） */
  cardProps: { type: Object, default: () => ({}) },
  /** 视口判定提前量（px）：rootMargin 上下扩展，实现预唤醒减少滚动白屏 */
  rootMargin: { type: Number, default: 200 },
})

const emit = defineEmits([
  // 单卡事件原样转发，index 标识来源
  'progress',
  'finish',
  // 卡进入冷存档池（状态仍在册，显示为「冷档」）
  'cardArchived',
  // 冷档被丢弃（槽位保留，数据不再可恢复）
  'cardDiscarded',
  // 卡休眠/唤醒/状态变化（调试面板与外部监听用）
  'cardStateChange',
])

const rootRef = ref(null)
const cardRefs = new Map() // index -> ScratchCard 组件实例（defineExpose 对象）
/** 卡槽根元素（IntersectionObserver 的观察目标） */
const cellEls = new Map()

/**
 * 每卡运行期记录（非响应式主数据，避免大字节进 Vue 响应式系统）；
 * 数组本身是 reactive（模板的 data-state/遮罩 v-if 要逐卡跟随状态），
 * 但内部的 sleepBytes/Uint8Array 字节不做深响应式开销——Vue 对
 * Uint8Array 不会逐索引代理，状态切换只改 state 字段。
 * 面板通过 stats computed（依赖各 state 字段）读取派生展示值。
 * state: 'active' | 'sleeping' | 'archived' | 'discarded'
 */
const records = reactive([])
/** index -> 冷档字节（仅 archived 卡有条目） */
const coldPool = new Map()
/** 冷池顺序队列（index 入池次序，丢弃从队首取） */
const coldOrder = []
let clockSeq = 1
let intersectionObserver = null
/** restore 期间的 DPR 变化处理：见批恢复代码处注释 */
let restoreGeneration = 0

/** 面板触发用的版本号：任何状态/预算变化 bump 一次 */
const statsVersion = ref(0)
function bump() {
  statsVersion.value++
  // 状态变化时立即重算每卡 lastBytes（不等面板轮询），让「每卡状态」
  // 网格在休眠/淘汰的当拍就显示最新字节量级
  for (const record of records) {
    if (record.state === 'active') {
      record.lastBytes = cardRefs.get(record.index)?.gpuBytes?.() || 0
    } else if (record.state === 'sleeping') {
      record.lastBytes = record.sleepBytes?.byteLength || 0
    } else if (record.state === 'archived') {
      record.lastBytes = coldPool.get(record.index)?.byteLength || 0
    } else {
      record.lastBytes = 0
    }
  }
}

/* ================= 卡槽记录 ================= */

function makeRecord(index) {
  return {
    index,
    state: 'sleeping', // 初始统一休眠，observer 首轮回调唤醒可见卡
    sleepBytes: null,
    lastUsedAt: 0, // 0 表示从未交互；天然排在 LRU 最旧
    lastBytes: 0, // 最近一次记账的状态字节（供面板显示内存量级）
  }
}

function ensureRecords(count) {
  while (records.length < count) records.push(makeRecord(records.length))
}

function setRecordState(record, state) {
  if (record.state === state) return
  record.state = state
  emit('cardStateChange', { index: record.index, state })
  bump()
}

/** 调试/外部读取：当前各卡状态与字节占用快照（响应式：statsVersion） */
const stats = computed(() => {
  // eslint-disable-next-line no-unused-expressions
  statsVersion.value
  let sleepBytes = 0
  let coldBytes = 0
  let active = 0
  let sleeping = 0
  let archived = 0
  let discarded = 0
  for (const record of records) {
    if (record.state === 'sleeping') {
      sleeping++
      const n = record.sleepBytes?.byteLength || 0
      record.lastBytes = n
      sleepBytes += n
    } else if (record.state === 'archived') {
      archived++
      record.lastBytes = coldPool.get(record.index)?.byteLength || 0
      coldBytes += record.lastBytes
    } else if (record.state === 'discarded') {
      discarded++
      record.lastBytes = 0
    } else {
      active++
      record.lastBytes = cardRefs.get(record.index)?.gpuBytes?.() || 0
    }
  }
  return {
    total: records.length,
    active,
    sleeping,
    archived,
    discarded,
    sleepBytes,
    coldBytes,
    activeBytes: records.reduce(
      (sum, record) =>
        record.state === 'active'
          ? sum + (cardRefs.get(record.index)?.gpuBytes?.() || 0)
          : sum,
      0
    ),
    sleepBudget: props.wallMemoryBudget,
    coldBudget: props.coldMemoryBudget,
  }
})

/* ================= 休眠 / 唤醒切换 ================= */

function getCard(index) {
  return cardRefs.get(index) || null
}

/** 标记某卡刚被交互（刷新 LRU），随后做预算维护 */
function touch(record) {
  record.lastUsedAt = clockSeq++
}

/**
 * 让一张卡进入休眠。已是休眠/冷档/丢弃则不动。
 * 进行中笔迹的处理在 ScratchCard.sleep() 内（就地确认，见其注释），
 * 因此本函数不会因多指刮擦而阻塞或丢笔（交织场景①）。
 */
function sleepCard(record) {
  if (record.state !== 'active') return
  const card = getCard(record.index)
  if (!card) return
  record.sleepBytes = card.sleep()
  setRecordState(record, 'sleeping')
}

/** 唤醒一张休眠卡：1 帧同步恢复（ScratchCard.wake） */
function wakeCard(record) {
  if (record.state !== 'sleeping') return
  const card = getCard(record.index)
  if (!card) return
  card.wake()
  setRecordState(record, 'active')
}

/**
 * 重新激活一张冷档卡（滚动回到视口）：冷段写回 ScratchCard，
 * 从冷池移除，状态变 active。旧版本编码器产生的冷段由 ScratchCard
 * 的 decodeSnapshot 版本兼容路径直接吃下（v1/v2 均接受）。
 */
function activateArchived(record) {
  const bytes = coldPool.get(record.index)
  if (!bytes) {
    // 理论不可达（状态与池子不一致时按丢弃处理）
    setRecordState(record, 'discarded')
    return
  }
  const card = getCard(record.index)
  coldPool.delete(record.index)
  const orderAt = coldOrder.indexOf(record.index)
  if (orderAt >= 0) coldOrder.splice(orderAt, 1)
  card.restore(bytes)
  record.sleepBytes = null
  setRecordState(record, 'active')
}

/** 唤醒丢弃卡：冷段已不存在，恢复为一张空白新卡（槽位/索引保留） */
function activateDiscarded(record) {
  const card = getCard(record.index)
  card.reset()
  setRecordState(record, 'active')
  touch(record)
}

/* ================= 预算执行：LRU -> 冷池 -> 丢弃 ================= */

/** 当前休眠字节合计（记账公式见文件头；空白卡 0） */
function totalSleepBytes() {
  let total = 0
  for (const record of records) {
    if (record.state === 'sleeping') total += record.sleepBytes?.byteLength || 0
  }
  return total
}

function totalColdBytes() {
  let total = 0
  for (const bytes of coldPool.values()) total += bytes.byteLength
  return total
}

/**
 * 把一张休眠卡淘汰进冷存档池。
 * 冷段直接复用 sleepBytes——它本身就是「最紧凑可序列化形式」
 * （scratchCodec 量化矢量 + 差分 + 位图 RLE），无需再转码。
 * 调用方必须保证 record.sleepBytes 非空：空白休眠卡不占任何预算，
 * LRU 预算淘汰应直接跳过它们（否则会把从未刮过的卡错标成丢弃）。
 */
function archiveCard(record) {
  if (!record.sleepBytes) return
  const bytes = record.sleepBytes
  coldPool.set(record.index, bytes)
  coldOrder.push(record.index)
  record.sleepBytes = null
  setRecordState(record, 'archived')
  emit('cardArchived', {
    index: record.index,
    bytes: bytes.byteLength,
    lastUsedAt: record.lastUsedAt,
  })
}

/** 冷池超预算：从最旧入池者开始丢弃，直到回到预算内 */
function enforceColdBudget() {
  while (coldOrder.length && totalColdBytes() > props.coldMemoryBudget) {
    const index = coldOrder.shift()
    const bytes = coldPool.get(index)
    coldPool.delete(index)
    const record = records[index]
    if (record && record.state === 'archived') {
      setRecordState(record, 'discarded')
    }
    emit('cardDiscarded', {
      index,
      reason: 'cold-budget',
      bytes: bytes?.byteLength || 0,
    })
  }
}

/**
 * 执行两级预算。休眠后、淘汰后、预算 prop 调小时都应调用。
 *
 * 交织场景③「冷池淘汰与某卡 undo 跨固化边界同一帧」：预算维护只
 * 触碰 sleeping 卡的已成型快照字节与冷池，从不访问 active 卡内部；
 * 该 active 卡的 undo 重建跑在它自己的 rAF 维护里，两条路径无共享
 * 可变状态（只有 cardRefs/记录对象，且单线程事件循环内不存在真正
 * 的同帧竞态），因此互不影响。
 */
function enforceBudgets() {
  let guard = 0
  while (records.length && totalSleepBytes() > props.wallMemoryBudget) {
    // LRU：lastUsedAt 最小（0=从未交互），并列取索引最小
    let victim = null
    for (const record of records) {
      // 只淘汰有离线字节的休眠卡：空白卡 0 预算、且无数据需要冷存
      if (record.state !== 'sleeping' || !record.sleepBytes) continue
      if (
        !victim ||
        record.lastUsedAt < victim.lastUsedAt ||
        (record.lastUsedAt === victim.lastUsedAt && record.index < victim.index)
      ) {
        victim = record
      }
    }
    if (!victim) break // 没有休眠卡可淘汰（活跃卡显存不计入离线预算）
    archiveCard(victim)
    if (++guard > 100000) break
  }
  enforceColdBudget()
  bump()
}

/**
 * 调试/运营强制淘汰：把一张 active 卡先休眠（就地确认进行中笔迹、
 * 产生快照）再立刻按 LRU 口径处理，用于手动触发「内存淘汰」验收。
 * 返回被淘汰的卡槽索引，没有可淘汰卡时返回 -1。
 */
function forceEvict(index) {
  let target
  if (Number.isInteger(index)) {
    target = records[index]
    if (!target) return -1
  } else {
    // 自动选择：优先休眠 LRU，其次活跃卡中 LRU
    target = [...records]
      .filter((r) => r.state === 'sleeping' || r.state === 'active')
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.index - b.index)[0]
  }
  if (!target) return -1
  if (target.state === 'active') sleepCard(target)
  if (target.state === 'sleeping') {
    if (target.sleepBytes) archiveCard(target)
    else {
      // 显式强制淘汰空白卡：没有可存档数据，直接置丢弃（演示冷池满
      // 之外的手动淘汰路径）；滚回时按空白新卡激活
      setRecordState(target, 'discarded')
      emit('cardDiscarded', { index: target.index, reason: 'force-empty' })
    }
  }
  enforceColdBudget()
  bump()
  return target.index
}

/* ================= 视口感知：IntersectionObserver ================= */

/** 当前可见卡槽索引集合（observer 回调维护） */
const visibleSet = new Set()
/** 待处理的可见性变更（合并到微任务/同一轮处理，避免滚动风暴逐卡休眠） */
let applyQueued = false
let applyRaf = 0

function applyVisibility() {
  applyQueued = false
  for (const record of records) {
    const inView = visibleSet.has(record.index)
    if (inView) {
      // 滚入：三种离线状态分别唤醒（active 不动）
      if (record.state === 'sleeping') wakeCard(record)
      else if (record.state === 'archived') activateArchived(record)
      else if (record.state === 'discarded') activateDiscarded(record)
    } else if (record.state === 'active') {
      // 滚出：休眠释放 backing store，随后统一执行预算
      sleepCard(record)
    }
  }
  enforceBudgets()
}

function scheduleApply() {
  if (applyQueued) return
  applyQueued = true
  // 微任务不够（同帧多次 IO 回调），用 rAF 合并：一轮滚动最多切换一次
  applyRaf = requestAnimationFrame(() => {
    applyRaf = 0
    applyVisibility()
  })
}

/**
 * 交织场景④「DPR 变化发生在批量恢复进行中」的处理：
 * 卡片的唤醒统一经 ScratchCard.wake -> rebuildCanvas(true)，它总是读
 * 取当前 window.devicePixelRatio；批量恢复只是顺序调用同一函数序列，
 * 中途 DPR 变化后唤醒的卡自然取新值，已唤醒卡则由各自的
 * matchMedia(resolution) 监听触发一次迁移重建。restoreGeneration
 * 用于让恢复后补做的可见性对账失效旧结果（见 restoreAll）。
 */
function handleIntersection(entries) {
  for (const entry of entries) {
    const index = Number(entry.target.dataset.cardIndex)
    if (Number.isNaN(index)) continue
    if (entry.isIntersecting) visibleSet.add(index)
    else visibleSet.delete(index)
  }
  scheduleApply()
}

function observeCell(element, index) {
  if (!intersectionObserver || !element) return
  element.dataset.cardIndex = String(index)
  intersectionObserver.observe(element)
}

function unobserveCell(element) {
  if (!intersectionObserver || !element) return
  intersectionObserver.unobserve(element)
}

/* ================= 卡片事件转发 + LRU 更新 ================= */

function onCardProgress(index, value) {
  const record = records[index]
  if (record && record.state === 'active') touch(record)
  emit('progress', { index, value })
}

function onCardFinish(index) {
  const record = records[index]
  if (record) touch(record)
  emit('finish', { index })
}

/* ================= 批量存档 / 恢复 ================= */

/**
 * 收集某一张卡的当前快照段。
 * - active：ScratchCard.save({includeSolid:true})（内部先冲刷挂起 rAF，
 *   因此交织场景②「滚动过程中 saveAll」拿到的是最终一致状态）；
 * - sleeping：直接用 sleepBytes（零拷贝、与唤醒内容一致）；
 * - archived：冷池字节；
 * - discarded/空白活卡：null（SEG_LIVE + segLen=0，空白槽位）。
 */
function collectSegment(record) {
  if (record.state === 'archived') {
    const cold = coldPool.get(record.index)
    // 状态与冷池不一致（理论不可达）：降级为丢弃段，不让 saveAll 抛错
    return cold
      ? { state: SEG_ARCHIVED, segment: cold }
      : { state: SEG_DISCARDED, segment: null }
  }
  if (record.state === 'discarded') {
    return { state: SEG_DISCARDED, segment: null }
  }
  if (record.state === 'sleeping') {
    return { state: SEG_LIVE, segment: record.sleepBytes }
  }
  const card = getCard(record.index)
  if (!card || !card.hasContent()) {
    return { state: SEG_LIVE, segment: null }
  }
  // 活跃卡：强制 includeSolid 以携带唤醒加速网格；体积超限时
  // ScratchCard.save 内部自动降级为 v1（仍无损，只是唤醒改矢量重建）
  return { state: SEG_LIVE, segment: card.save({ includeSolid: true }) }
}

/**
 * 整墙存档：返回单一 Uint8Array（SCW 容器，<= 8MB，超限抛错）。
 * 滚动中调用也安全：活跃卡的 save 同步冲刷该卡的挂起维护；本函数
 * 不改变任何卡的生命周期状态（存完继续滚、继续刮都不受影响）。
 */
function saveAll() {
  const entries = records.map((record) => collectSegment(record))
  return encodeWall(entries, {
    version: 1,
    maxCards: props.maxCards,
    cardCount: records.length,
    savedAt: Date.now(),
  })
}

/**
 * 整墙恢复。入参兼容三种（需求中的向前/向后兼容）：
 *   a) SCW 墙归档 -> decodeWall；
 *   b) v3 裸单卡快照 'SC1' -> migrateV3CardToWall 升级为 1 卡墙；
 *   c) ArrayBuffer 包装的上述任一种。
 *
 * 卡数与当前 maxCards 不一致的语义（明确取舍，不静默截断）：
 *   - count <= maxCards：允许。count 小于当前 cards 长度时，前 count
 *     槽恢复内容，其余槽为空白（归档本身不包含它们）；count 大于
 *     当前 cards 长度时，多出的槽无奖品数据可渲染，内部记录仍建立
 *     （saveAll/面板可见），模板按空占位渲染，等调用方补齐 cards；
 *   - count > maxCards：直接抛错。maxCards 是墙容量契约，静默裁剪
 *     会造成不可察觉的数据丢失（用户以为全量恢复），而继续扩容又
 *     违反调用方设置的实例上限——故要求调用方先调大 maxCards 再恢复。
 *
 * 交织场景④：恢复期间 DPR 变化。恢复循环只把数据装填到「当前应可见」
 * 的卡（active），其余一律以 sleeping 落位（带 sleepBytes、零显存）；
 * 唤醒走 rebuildCanvas(true) 读实时 DPR，恢复中变化的 DPR 对已唤醒
 * 卡由其 resolution 监听补迁移，对未唤醒卡下次唤醒自然取新值。
 */
function restoreAll(archive) {
  const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive)
  const wall = isWallArchive(bytes)
    ? decodeWall(bytes)
    : isCardSnapshot(bytes)
      ? decodeWall(migrateV3CardToWall(bytes))
      : null
  if (!wall) throw new Error('[wall] restore 需要 SCW 墙归档或 SC1 单卡快照')

  const count = wall.entries.length
  if (count > props.maxCards) {
    throw new Error(
      `[wall] 归档含 ${count} 张卡，超过当前 maxCards=${props.maxCards}；` +
        '请先调大 maxCards 再恢复（避免静默裁剪导致数据丢失）'
    )
  }

  const generation = ++restoreGeneration
  // 先抓拍当前可见卡槽（清集合前），恢复后据此决定哪些卡立即唤醒
  const viewportIndexes = new Set(visibleSet)
  // 原地重建记录（reactive 数组保持同一引用）：全部先落 sleeping，
  // 可见性对账后再唤醒视口内的卡
  records.length = 0
  coldPool.clear()
  coldOrder.length = 0
  visibleSet.clear()
  ensureRecords(count)
  for (let i = 0; i < count; i++) {
    const entry = wall.entries[i]
    const record = records[i]
    if (entry.state === SEG_DISCARDED) {
      record.state = 'discarded'
      record.sleepBytes = null
    } else if (entry.state === SEG_ARCHIVED && entry.segment) {
      record.state = 'archived'
      coldPool.set(i, entry.segment)
      coldOrder.push(i)
      record.sleepBytes = null
    } else {
      record.state = 'sleeping'
      record.sleepBytes = entry.segment // 可能为 null（空白活卡）
    }
  }

  // 等模板把卡实例（按新 key/index）渲染出来，再逐卡装填
  return nextTick().then(() => {
    if (generation !== restoreGeneration) return // 恢复期间又被新恢复取代
    for (let i = 0; i < count; i++) {
      const record = records[i]
      const card = getCard(i)
      if (!card) continue
      if (record.state === 'sleeping') {
        if (viewportIndexes.has(i)) {
          // 视口内：直接装填并同步唤醒（内部读当前 DPR），1 帧出图
          card.adoptOffline(record.sleepBytes)
          card.wake()
          record.state = 'active'
        } else {
          // 视口外：挂起为离线态，零显存，sleepBytes 已就位
          card.adoptOffline(record.sleepBytes)
        }
      } else if (record.state === 'archived') {
        // 冷档默认不激活（保持预算语义）；视口内则立即取回
        if (viewportIndexes.has(i)) activateArchived(record)
      } else if (record.state === 'discarded' && viewportIndexes.has(i)) {
        activateDiscarded(record)
      }
    }
    // 再做一次可见性对账：恢复中若发生滚动/DPR 变化，由下一轮 IO
    // 回调（rAF 合并）自然修正，这里先保证预算成立
    enforceBudgets()
    bump()
    return { count, meta: wall.meta }
  })
}

/** 取出墙归档中指定卡的单卡快照段（可直接 ScratchCard.restore） */
function getCardSnapshot(archive, index) {
  const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive)
  if (isCardSnapshot(bytes)) {
    return index === 0 ? bytes : null
  }
  return extractCardSegment(bytes, index)
}

/* ================= cards 对账 / 预算 prop 变化 ================= */

/**
 * cards 数组变化的按索引对齐语义（取舍：索引稳定优先）：
 * - 数量不变：内容变化只影响插槽奖品展示，刮痕状态完全保留；
 * - 变长：保留的索引上的状态保留；新增索引为空白休眠卡；缩短时
 *   超出的记录与冷档一并清除（卡槽已不存在，数据无意义）。
 * - 始终不超过 maxCards（模板与 saveAll 只取前 maxCards 个）。
 */
watch(
  () => props.cards.length,
  (length) => {
    const count = Math.min(length, props.maxCards)
    ensureRecords(count)
    if (records.length > count) {
      for (let i = count; i < records.length; i++) {
        coldPool.delete(i)
        const orderAt = coldOrder.indexOf(i)
        if (orderAt >= 0) coldOrder.splice(orderAt, 1)
        visibleSet.delete(i)
      }
      records.length = count
    }
    bump()
  }
)

watch(
  () => [props.wallMemoryBudget, props.coldMemoryBudget],
  () => enforceBudgets()
)

/* ================= 生命周期 ================= */

function setCardRef(index, instance) {
  if (instance) cardRefs.set(index, instance)
  else cardRefs.delete(index)
}

const renderCount = computed(() =>
  Math.min(props.cards.length, props.maxCards)
)

/**
 * 逐卡状态与内存量级（调试面板「每卡状态」网格）。响应式依赖
 * records[i].state（reactive）；字节取最近一次记账值 lastBytes，
 * 面板 0.5s 刷新时随 stats 一起更新，避免把大字节本身做成响应式。
 */
const cardStates = computed(() =>
  records.map((record) => ({
    index: record.index,
    state: record.state,
    bytes: record.lastBytes || 0,
  }))
)

onMounted(() => {
  ensureRecords(renderCount.value)
  intersectionObserver = new IntersectionObserver(handleIntersection, {
    // 墙滚动容器为根；不传 root 时相对浏览器视口也可，这里显式取墙根
    root: rootRef.value,
    rootMargin: `${props.rootMargin}px 0px`,
    threshold: 0,
  })
  nextTick(() => {
    for (let i = 0; i < records.length; i++) {
      const el = cellEls.get(i)
      if (el) observeCell(el, i)
    }
    // 初始没有 IO 回调历史时，主动判定一次可见性（部分浏览器首轮回调
    // 在下一帧才来；这里两帧后做兜底对账，保证首屏卡一定被唤醒）
    requestAnimationFrame(() => requestAnimationFrame(reconcileFromObserver))
  })
})

/** 兜底/恢复后对账：按元素实际位置重新唤醒应可见的卡 */
function reconcileFromObserver() {
  if (!rootRef.value) return
  // IO 会在 observe 后自行派发首轮回调；此函数只在怀疑漏唤醒时用：
  // 直接对每个 cell 触发 unobserve/observe 不可靠，改为信任 IO 的同时
  // 把仍在 sleeping 的首屏卡用元素包围盒主动判一次
  const rootRect = rootRef.value.getBoundingClientRect()
  for (const record of records) {
    const el = cellEls.get(record.index)
    if (!el || record.state !== 'sleeping') continue
    const rect = el.getBoundingClientRect()
    const inView =
      rect.bottom > rootRect.top - props.rootMargin &&
      rect.top < rootRect.bottom + props.rootMargin
    if (inView) {
      visibleSet.add(record.index)
      wakeCard(record)
    }
  }
  enforceBudgets()
}

onBeforeUnmount(() => {
  if (intersectionObserver) intersectionObserver.disconnect()
  if (applyRaf) cancelAnimationFrame(applyRaf)
})

/* ================= 调试辅助（__ 前缀，非生产接口） ================= */

/**
 * 向指定卡灌入大量笔迹（验收：模拟某卡占用大量预算触发淘汰）。
 * 卡若在休眠/冷档先恢复到可交互态，注入后立即重新休眠（若不在视口），
 * 并按「发生过交互」刷新 LRU。
 */
async function __seedCard(index, count = 2000) {
  const record = records[index]
  const card = getCard(index)
  if (!record || !card) return false
  if (record.state === 'archived') activateArchived(record)
  else if (record.state === 'discarded') activateDiscarded(record)
  else if (record.state === 'sleeping') wakeCard(record)
  await nextTick()
  card.__debug.seed(count)
  touch(record)
  if (!visibleSet.has(index)) {
    await nextTick()
    sleepCard(record)
    enforceBudgets()
  }
  bump()
  return true
}

/** 模拟快速滚动：在墙滚动容器内快速往返（默认滚到底再回顶） */
function __fastScroll(targetBottom = true) {
  const root = rootRef.value
  if (!root) return
  const start = root.scrollTop
  const end = targetBottom ? root.scrollHeight - root.clientHeight : 0
  const duration = 500
  const t0 = performance.now()
  function step(now) {
    const p = Math.min(1, (now - t0) / duration)
    const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
    root.scrollTop = start + (end - start) * eased
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function __forceEvict(index) {
  const target = forceEvict(index)
  return target
}

function __stats() {
  return stats.value
}

defineExpose({
  saveAll,
  restore: restoreAll,
  restoreAll,
  getCard,
  getCardSnapshot,
  extractCardSegment: (archive, index) => getCardSnapshot(archive, index),
  stats,
  cardStates,
  // 调试辅助
  __seedCard,
  __fastScroll,
  __forceEvict,
  __stats,
  __enforceBudgets: enforceBudgets,
})

/* 合并 cardProps 到每张卡（responsive 默认开启，单卡自身 v3 默认值兜底） */
const mergedCardProps = computed(() => ({
  responsive: true,
  startSleeping: true,
  ...props.cardProps,
}))
</script>

<template>
  <div ref="rootRef" class="scratch-wall">
    <div class="scratch-wall__grid">
      <div
        v-for="index in renderCount"
        :key="index - 1"
        class="scratch-wall__cell"
        :ref="
          (el) => {
            if (el) {
              cellEls.set(index - 1, el)
              // observer 在 onMounted 的 nextTick 后才创建；挂载阶段
              // 元素只登记，观察由统一的 observe 遍历负责（避免重复）
              if (intersectionObserver) observeCell(el, index - 1)
            } else {
              cellEls.delete(index - 1)
            }
          }
        "
        :data-state="records[index - 1]?.state"
      >
        <ScratchCard
          :ref="(instance) => setCardRef(index - 1, instance)"
          v-bind="mergedCardProps"
          @progress="(value) => onCardProgress(index - 1, value)"
          @finish="() => onCardFinish(index - 1)"
        >
          <!-- slot 作用域：奖品内容与索引交给运营页面 -->
          <slot
            :card="cards[index - 1]"
            :index="index - 1"
            :state="records[index - 1]?.state"
          />
        </ScratchCard>
        <!-- 非活跃态遮罩与角标（纯展示，调试/运营可见休眠状态） -->
        <div
          v-if="
            records[index - 1]?.state === 'sleeping' ||
            records[index - 1]?.state === 'archived' ||
            records[index - 1]?.state === 'discarded'
          "
          class="scratch-wall__veil"
        >
          <span class="scratch-wall__badge">
            {{
              records[index - 1]?.state === 'sleeping'
                ? '休眠'
                : records[index - 1]?.state === 'archived'
                  ? '冷档'
                  : '已丢弃'
            }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scratch-wall {
  position: relative;
  height: 72vh;
  overflow-y: auto;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #f9fafb;
  overscroll-behavior: contain;
}

.scratch-wall__grid {
  display: grid;
  /* 自动填充：窄屏 1~2 列，宽屏可到 5 列；卡宽 160~240px */
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 14px;
  padding: 16px;
}

.scratch-wall__cell {
  position: relative;
  border-radius: 12px;
  min-height: 120px;
  background: #fff;
}

.scratch-wall__veil {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(243, 244, 246, 0.92);
  border-radius: 12px;
  pointer-events: none;
  z-index: 2;
}

.scratch-wall__badge {
  padding: 3px 12px;
  font-size: 12px;
  font-weight: 600;
  color: #4b5563;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 999px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

/* 冷档/丢弃着色，验收时一眼区分三种离线状态 */
.scratch-wall__cell[data-state='archived'] .scratch-wall__badge {
  color: #b45309;
  border-color: #f59e0b;
  background: #fffbeb;
}

.scratch-wall__cell[data-state='discarded'] .scratch-wall__badge {
  color: #b91c1c;
  border-color: #ef4444;
  background: #fef2f2;
}
</style>
