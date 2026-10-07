<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue'
import ScratchCardWall from './components/ScratchCardWall.vue'
import SingleCardDemo from './components/SingleCardDemo.vue'

/* ================= 视图切换：v3 单卡 demo / v4 多卡墙 ================= */

const tab = ref('wall')

/* ================= 墙配置与奖品数据 ================= */

const PRIZE_POOL = [
  { label: '现金红包', value: '88 元', color: '#c2410c', bg: 'linear-gradient(160deg,#fff7ed,#ffedd5)' },
  { label: '优惠券', value: '20 元', color: '#2563eb', bg: 'linear-gradient(160deg,#eff6ff,#dbeafe)' },
  { label: '视频会员', value: '7 天', color: '#7c3aed', bg: 'linear-gradient(160deg,#f5f3ff,#ede9fe)' },
  { label: '积分奖励', value: '500', color: '#0f766e', bg: 'linear-gradient(160deg,#f0fdfa,#ccfbf1)' },
  { label: '神秘大奖', value: '???', color: '#be123c', bg: 'linear-gradient(160deg,#fff1f2,#ffe4e6)' },
]

function prizeAt(index) {
  return PRIZE_POOL[index % PRIZE_POOL.length]
}

function makeCards(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index,
    ...prizeAt(index),
  }))
}

const cardCount = ref(12)
const cards = ref(makeCards(cardCount.value))

function setCardCount(count) {
  cardCount.value = count
  cards.value = makeCards(count)
}

/* 透传给每张卡的 v3 props（换肤/阈值演示：改一张=改整墙） */
const wallCardProps = reactive({
  threshold: 45,
  brushSize: 24,
  coverColor: '#b8bcc6',
  coverText: '刮开有奖',
  maxHistory: 3000,
  rasterizeAfter: 400,
})

const wallRef = ref(null)

/* ================= 预算配置（便于强制触发淘汰） ================= */

const MB = 1024 * 1024
const wallBudgetMB = ref(16)
const coldBudgetMB = ref(8)
const maxCards = ref(50)
const wallMemoryBudget = computed(() => wallBudgetMB.value * MB)
const coldMemoryBudget = computed(() => coldBudgetMB.value * MB)

/* ================= 状态面板（0.5s 轮询墙 stats，仅调试用） ================= */

const wallStats = ref(null)
let statsTimer = 0
function refreshStats() {
  wallStats.value = wallRef.value?.stats ?? null
}

function startStatsTimer() {
  if (statsTimer) return
  statsTimer = window.setInterval(refreshStats, 500)
}
function stopStatsTimer() {
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = 0
}

/* 面板里的每卡状态列表（直接取 __stats 的快照） */
const cardStatuses = computed(() => {
  const s = wallStats.value
  if (!s) return []
  return s
})

function formatKB(bytes) {
  if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/* 逐卡状态网格（直接读墙实例 cardStates；0.5s 轮询触发更新） */
const perCard = computed(() => wallRef.value?.cardStates ?? [])

function cardStateLabel(state) {
  return { active: '视口内', sleeping: '休眠', archived: '冷档', discarded: '丢弃' }[state] || state
}

function cardBytesText(item) {
  if (item.state === 'discarded') return '—'
  if (!item.bytes) return '0'
  return item.bytes >= MB ? `${(item.bytes / MB).toFixed(1)}M` : `${Math.round(item.bytes / 1024)}K`
}

/* ================= 调试动作 ================= */

const seedIndex = ref(0)
const seedCount = ref(2000)
const evictIndex = ref(-1)
const message = ref('')
const busy = ref(false)

function flash(text) {
  message.value = text
}

async function handleSeedCard() {
  busy.value = true
  const ok = await wallRef.value?.__seedCard(seedIndex.value, seedCount.value)
  busy.value = false
  refreshStats()
  flash(ok ? `已向 #${seedIndex.value} 灌入 ${seedCount.value} 笔` : '卡槽不存在')
}

function handleFastScroll(down = true) {
  wallRef.value?.__fastScroll(down)
  flash(down ? '快速滚到底（观察休眠/唤醒）…' : '快速滚回顶部…')
}

function handleForceEvict() {
  const idx = wallRef.value?.__forceEvict(
    evictIndex.value >= 0 ? evictIndex.value : undefined
  )
  refreshStats()
  flash(idx >= 0 ? `已强制淘汰 #${idx}` : '没有可淘汰的卡')
}

function handleEnforce() {
  wallRef.value?.__enforceBudgets()
  refreshStats()
  flash('已强制执行预算检查')
}

/* ---- 整墙存档 / 恢复 / 单卡段提取 / v3->wall 迁移演示 ---- */

let wallArchive = null
const archiveSize = ref(0)
const archiveError = ref('')
const hasArchive = ref(false)

function handleSaveAll() {
  archiveError.value = ''
  try {
    wallArchive = wallRef.value?.saveAll() ?? null
    archiveSize.value = wallArchive?.length || 0
    hasArchive.value = !!wallArchive
    flash(`整墙归档 ${formatKB(archiveSize.value)}（硬上限 8 MB）`)
  } catch (err) {
    archiveError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleRestoreAll() {
  if (!wallArchive) return
  archiveError.value = ''
  busy.value = true
  try {
    const result = await wallRef.value?.restore(wallArchive)
    if (result) flash(`已恢复整墙：${result.count} 张卡`)
  } catch (err) {
    archiveError.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
    refreshStats()
  }
}

/** 演示：墙归档中的单卡段交给 ScratchCard.restore（切到单卡页恢复） */
let extractedSegment = null
const extractedSize = ref(0)
function handleExtractCard(index) {
  if (!wallArchive) {
    flash('请先整墙存档')
    return
  }
  extractedSegment = wallRef.value?.getCardSnapshot(wallArchive, index)
  extractedSize.value = extractedSegment?.length || 0
  flash(
    extractedSegment
      ? `已提取 #${index} 单卡段（${formatKB(extractedSize.value)}），到「v3 单卡」页点恢复`
      : `#${index} 是空白/丢弃段，无单卡快照`
  )
}

/* 暴露给单卡 demo 页的恢复按钮：用提取出的墙段调用 ScratchCard.restore */
const singleRef = ref(null)
function restoreExtractedInSingle() {
  if (!extractedSegment) {
    flash('请先在墙页提取一个单卡段')
    tab.value = 'single'
    return
  }
  tab.value = 'single'
  // 等单卡组件挂载后恢复
  requestAnimationFrame(() => {
    singleRef.value?.restore?.(extractedSegment)
  })
}

/* ---- 墙事件：观察淘汰/丢弃实际发生时机 ---- */

const eventLog = ref([])
function pushEvent(text) {
  eventLog.value.unshift(`${new Date().toLocaleTimeString()} ${text}`)
  if (eventLog.value.length > 30) eventLog.value.length = 30
}
function onCardArchived({ index, bytes }) {
  pushEvent(`#${index} 进入冷存档（${formatKB(bytes)}）`)
  refreshStats()
}
function onCardDiscarded({ index, reason }) {
  pushEvent(`#${index} 冷档被丢弃（${reason}）`)
  refreshStats()
}
function onCardStateChange({ index, state }) {
  refreshStats()
}

onMounted(startStatsTimer)
onBeforeUnmount(stopStatsTimer)
</script>

<template>
  <main class="app">
    <header class="app__header">
      <h1 class="app__title">刮刮卡 v4 · 多卡运营墙</h1>
      <nav class="tabs">
        <button
          type="button"
          class="tab"
          :class="{ 'tab--active': tab === 'wall' }"
          @click="tab = 'wall'"
        >
          多卡墙
        </button>
        <button
          type="button"
          class="tab"
          :class="{ 'tab--active': tab === 'single' }"
          @click="tab = 'single'; refreshStats()"
        >
          v3 单卡
        </button>
      </nav>
    </header>

    <!-- ================= 多卡墙页 ================= -->
    <section v-if="tab === 'wall'" class="wall-page">
      <div class="debug">
        <div class="debug__row">
          <span class="debug__label">卡片数量</span>
          <button
            v-for="n in [1, 6, 12, 30, 50]"
            :key="n"
            type="button"
            class="chip"
            :class="{ 'chip--active': cardCount === n }"
            @click="setCardCount(n)"
          >
            {{ n }}
          </button>
        </div>

        <div class="debug__row">
          <span class="debug__label">休眠预算</span>
          <label class="budget">
            <input v-model.number="wallBudgetMB" type="number" min="0" step="0.5" />
            MB
          </label>
          <span class="debug__label">冷池预算</span>
          <label class="budget">
            <input v-model.number="coldBudgetMB" type="number" min="0" step="0.5" />
            MB
          </label>
          <span class="debug__label">maxCards</span>
          <label class="budget">
            <input v-model.number="maxCards" type="number" min="1" max="50" />
          </label>
          <button type="button" class="btn" @click="handleEnforce">执行预算检查</button>
        </div>

        <div class="debug__row">
          <span class="debug__label">灌入笔迹</span>
          <label class="budget">
            #<input v-model.number="seedIndex" type="number" min="0" />
          </label>
          <label class="budget">
            <input v-model.number="seedCount" type="number" min="1" />
            笔
          </label>
          <button type="button" class="btn" :disabled="busy" @click="handleSeedCard">
            灌入
          </button>

          <span class="debug__label">快速滚动</span>
          <button type="button" class="btn" @click="handleFastScroll(true)">滚到底</button>
          <button type="button" class="btn" @click="handleFastScroll(false)">滚回顶</button>
        </div>

        <div class="debug__row">
          <span class="debug__label">强制淘汰</span>
          <label class="budget">
            #<input v-model.number="evictIndex" type="number" min="-1" placeholder="自动LRU" />
          </label>
          <button type="button" class="btn btn--warn" @click="handleForceEvict">
            立即淘汰
          </button>

          <span class="debug__label">整墙归档</span>
          <button type="button" class="btn" @click="handleSaveAll">saveAll</button>
          <button type="button" class="btn" :disabled="!hasArchive" @click="handleRestoreAll">
            restore
          </button>
        </div>

        <p v-if="message" class="debug__msg">{{ message }}</p>
        <p v-if="archiveError" class="debug__error">{{ archiveError }}</p>
        <p v-if="hasArchive" class="debug__sub">
          上次归档 {{ formatKB(archiveSize) }}；可提取任意卡段到「v3 单卡」页验证兼容：
          <button type="button" class="btn btn--mini" @click="handleExtractCard(0)">
            提取 #0
          </button>
          <button
            type="button"
            class="btn btn--mini"
            :disabled="seedIndex >= cardCount"
            @click="handleExtractCard(seedIndex)"
          >
            提取 #{{ seedIndex }}
          </button>
          <button
            type="button"
            class="btn btn--mini"
            :disabled="!extractedSize"
            @click="restoreExtractedInSingle"
          >
            到单卡页恢复（{{ extractedSize ? formatKB(extractedSize) : '未提取' }}）
          </button>
        </p>
      </div>

      <!-- 内存统计条 -->
      <div class="meters" v-if="wallStats">
        <div class="meter">
          <span class="meter__label">活跃显存</span>
          <span class="meter__value">{{ formatKB(wallStats.activeBytes) }}</span>
          <span class="meter__sub">{{ wallStats.active }} 张在屏</span>
        </div>
        <div
          class="meter"
          :class="{ 'meter--over': wallStats.sleepBytes > wallStats.sleepBudget }"
        >
          <span class="meter__label">休眠离线</span>
          <span class="meter__value">{{ formatKB(wallStats.sleepBytes) }}</span>
          <span class="meter__sub">
            / {{ formatKB(wallStats.sleepBudget) }} · {{ wallStats.sleeping }} 张
          </span>
        </div>
        <div
          class="meter"
          :class="{ 'meter--over': wallStats.coldBytes > wallStats.coldBudget }"
        >
          <span class="meter__label">冷存档池</span>
          <span class="meter__value">{{ formatKB(wallStats.coldBytes) }}</span>
          <span class="meter__sub">
            / {{ formatKB(wallStats.coldBudget) }} · {{ wallStats.archived }} 张
            <template v-if="wallStats.discarded"> · {{ wallStats.discarded }} 张丢弃</template>
          </span>
        </div>
      </div>

      <ScratchCardWall
        ref="wallRef"
        :cards="cards"
        :max-cards="maxCards"
        :wall-memory-budget="wallMemoryBudget"
        :cold-memory-budget="coldMemoryBudget"
        :card-props="wallCardProps"
        @card-archived="onCardArchived"
        @card-discarded="onCardDiscarded"
        @card-state-change="onCardStateChange"
      >
        <template #default="{ card, index, state }">
          <div class="prize" :style="{ background: card.bg, color: card.color }">
            <span class="prize__idx">#{{ index }}</span>
            <span class="prize__label">{{ card.label }}</span>
            <strong class="prize__value">{{ card.value }}</strong>
          </div>
        </template>
      </ScratchCardWall>
    </section>

    <!-- ================= v3 单卡页 ================= -->
    <section v-else class="single-wrap">
      <p class="single-tip">
        v3 原演示页，接口零改动。从墙页「提取卡段」后可用下方按钮直接恢复墙归档中的单卡段。
        <button
          type="button"
          class="btn btn--mini"
          :disabled="!extractedSize"
          @click="restoreExtractedInSingle"
        >
          恢复墙归档单卡段
        </button>
      </p>
      <SingleCardDemo ref="singleRef" />
    </section>

    <!-- 事件日志 -->
    <!-- 逐卡状态与内存量级（验收辅助） -->
    <section v-if="tab === 'wall'" class="log">
      <h2>每卡状态与内存量级
        <span class="log__hint">（active=显存；sleeping/archived=离线字节；空白卡 0）</span>
      </h2>
      <div class="cardgrid">
        <div
          v-for="item in perCard"
          :key="item.index"
          class="cardchip"
          :class="`cardchip--${item.state}`"
          :title="`#${item.index} ${cardStateLabel(item.state)} ${formatKB(item.bytes)}`"
        >
          <span class="cardchip__idx">#{{ item.index }}</span>
          <span class="cardchip__state">{{ cardStateLabel(item.state) }}</span>
          <span class="cardchip__bytes">{{ cardBytesText(item) }}</span>
        </div>
      </div>
    </section>

    <!-- 事件日志 -->
    <section v-if="tab === 'wall'" class="log">
      <h2>淘汰/丢弃事件</h2>
      <p v-if="!eventLog.length" class="log__empty">
        暂无事件：刮几笔后滚出视口、调小预算或点「立即淘汰」即可观察
      </p>
      <ul v-else>
        <li v-for="(line, i) in eventLog" :key="i">{{ line }}</li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.app {
  max-width: 1080px;
  margin: 0 auto;
  padding: 18px 20px 60px;
}

.app__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.app__title {
  margin: 0;
  font-size: 22px;
  color: #111827;
}

.tabs {
  display: flex;
  gap: 8px;
}

.tab {
  padding: 7px 18px;
  font-size: 14px;
  border: 1px solid #d1d5db;
  border-radius: 999px;
  background: #fff;
  color: #4b5563;
  cursor: pointer;
}

.tab--active {
  border-color: #2563eb;
  color: #2563eb;
  background: #eff6ff;
}

/* ---------- 调试面板 ---------- */

.debug {
  padding: 12px 14px;
  margin-bottom: 12px;
  background: #fff;
  border: 1px dashed #9ca3af;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.debug__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.debug__label {
  font-size: 13px;
  font-weight: 600;
  color: #374151;
}

.chip {
  padding: 4px 12px;
  font-size: 13px;
  border: 1px solid #d1d5db;
  border-radius: 999px;
  background: #fff;
  cursor: pointer;
}

.chip--active {
  border-color: #2563eb;
  color: #2563eb;
  background: #eff6ff;
}

.budget {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #4b5563;
}

.budget input {
  width: 64px;
  padding: 4px 6px;
  font-size: 13px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
}

.btn {
  padding: 5px 14px;
  font-size: 13px;
  color: #2563eb;
  background: #fff;
  border: 1px solid #2563eb;
  border-radius: 999px;
  cursor: pointer;
}

.btn:disabled {
  color: #9ca3af;
  border-color: #d1d5db;
  cursor: not-allowed;
}

.btn--warn {
  color: #b45309;
  border-color: #b45309;
}

.btn--mini {
  padding: 2px 10px;
  font-size: 12px;
}

.debug__msg {
  margin: 0;
  font-size: 13px;
  color: #1d4ed8;
}

.debug__error {
  margin: 0;
  font-size: 13px;
  color: #dc2626;
}

.debug__sub {
  margin: 0;
  font-size: 12px;
  color: #6b7280;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* ---------- 统计条 ---------- */

.meters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.meter {
  padding: 10px 14px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.meter--over {
  border-color: #dc2626;
  background: #fef2f2;
}

.meter__label {
  font-size: 13px;
  color: #6b7280;
}

.meter__value {
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.meter__sub {
  font-size: 12px;
  color: #9ca3af;
}

/* ---------- 奖品槽 ---------- */

.prize {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

.prize__idx {
  position: absolute;
  top: 6px;
  left: 8px;
  font-size: 11px;
  opacity: 0.6;
}

.prize__label {
  font-size: 12px;
}

.prize__value {
  font-size: 26px;
  font-weight: 800;
}

/* ---------- 单卡页 / 日志 ---------- */

.single-wrap {
  background: #fff;
  border-radius: 12px;
  padding: 18px;
  border: 1px solid #e5e7eb;
}

.single-tip {
  margin: 0 0 14px;
  font-size: 13px;
  color: #6b7280;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.log {
  margin-top: 16px;
  padding: 12px 16px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  font-size: 13px;
}

.log h2 {
  margin: 0 0 8px;
  font-size: 14px;
  color: #374151;
}

.log ul {
  margin: 0;
  padding-left: 18px;
  color: #4b5563;
}

.log__empty {
  margin: 0;
  color: #9ca3af;
}
</style>

.log__hint {
  font-size: 12px;
  font-weight: 400;
  color: #9ca3af;
  margin-left: 8px;
}

.cardgrid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
}

.cardchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #f9fafb;
  color: #4b5563;
}

.cardchip__idx {
  font-weight: 700;
}

.cardchip__state {
  color: #6b7280;
}

.cardchip--active {
  border-color: #93c5fd;
  background: #eff6ff;
}

.cardchip--sleeping {
  border-color: #d1d5db;
  background: #f3f4f6;
}

.cardchip--archived {
  border-color: #f59e0b;
  background: #fffbeb;
  color: #92400e;
}

.cardchip--discarded {
  border-color: #ef4444;
  background: #fef2f2;
  color: #b91c1c;
}
