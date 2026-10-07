<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import ScratchCardWall from './components/ScratchCardWall.vue'
import ScratchCard from './components/ScratchCard.vue'
import {
  WALL_ARCHIVE_MAX_BYTES,
  decodeWallArchive,
  detectArchiveKind,
  extractCardSnapshot,
  migrateSingleToWall,
} from './wallCodec.js'

/* ================= 运营墙演示（v4） ================= */

const wallRef = ref(null)
const cardCount = ref(24)
const maxCards = ref(50)
const budgetMB = ref(16)
const coldMB = ref(8)
const debugOverlay = ref(true)

// 奖品卡槽内容（任意结构，经作用域插槽渲染；数量由 cardCount 驱动）
const prizes = [
  { name: '现金红包', value: '88 元', tone: '#c2410c' },
  { name: '优惠券', value: '¥20', tone: '#2563eb' },
  { name: '免单卡', value: '1 次', tone: '#0f766e' },
  { name: '积分', value: '500', tone: '#7c3aed' },
  { name: '神秘大奖', value: '???', tone: '#be185d' },
]
const cards = computed(() =>
  Array.from({ length: cardCount.value }, (_, i) => ({
    id: i,
    ...prizes[i % prizes.length],
  }))
)

/* ---------------- 墙状态轮询（调试面板展示） ---------------- */

const totals = ref({
  offline: 0,
  cold: 0,
  offlineBudget: budgetMB.value * 1024 * 1024,
  coldBudget: coldMB.value * 1024 * 1024,
  cards: 0,
  active: 0,
  sleeping: 0,
  archived: 0,
  discarded: 0,
})
const tickMs = ref(0)
let pollTimer = 0
function pollTotals() {
  if (wallRef.value) totals.value = wallRef.value.getTotals()
  tickMs.value++
}
pollTimer = window.setInterval(pollTotals, 600)
onBeforeUnmount(() => clearInterval(pollTimer))

const metaRows = computed(() => {
  if (!wallRef.value) return []
  return wallRef.value.getMeta().map((m, i) => ({ i, ...m }))
})

function fmtKB(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + 'MB'
  return (bytes / 1024).toFixed(1) + 'KB'
}

/* ---------------- 调试操作 ---------------- */

const seedIndex = ref(0)
const seedCount = ref(300)
const targetIndex = ref(0)
const log = ref([])

function pushLog(text) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  log.value.unshift(`[${time}] ${text}`)
  if (log.value.length > 12) log.value.pop()
}

function seedTarget() {
  wallRef.value?.__seedAt(seedIndex.value, seedCount.value)
  pushLog(`已向 #${seedIndex.value} 灌入 ${seedCount.value} 笔笔迹`)
}

function sleepTarget() {
  wallRef.value?.__sleepAt(targetIndex.value)
  pushLog(`强制休眠 #${targetIndex.value}`)
}
function wakeTarget() {
  wallRef.value?.__wakeAt(targetIndex.value)
  pushLog(`强制唤醒 #${targetIndex.value}`)
}
function archiveTarget() {
  wallRef.value?.__archiveAt(targetIndex.value)
  pushLog(`强制淘汰 #${targetIndex.value} → 冷存档池`)
}

let scrolling = false
async function fastScroll() {
  if (scrolling) return
  scrolling = true
  pushLog('开始模拟快速滚动…')
  await wallRef.value?.__fastScroll(8)
  scrolling = false
  pushLog('快速滚动结束')
}

function onCardArchived(e) {
  pushLog(`#${e.index} 笔迹转入冷档（${fmtKB(e.size)}）`)
}
function onCardDiscarded(e) {
  pushLog(`#${e.index} 冷档超限被丢弃（${fmtKB(e.size)}）`)
}
function onCardConfigRestored(e) {
  pushLog(`#${e.index} 覆盖配置随归档恢复（宿主可写回 cards）`)
}

/* ---------------- 批量存档 / 恢复 / 迁移演示 ---------------- */

let wallArchive = null
const wallArchiveSize = ref(0)
const archiveError = ref('')

function handleSaveAll() {
  archiveError.value = ''
  try {
    wallArchive = wallRef.value?.saveAll() ?? null
    wallArchiveSize.value = wallArchive ? wallArchive.length : 0
    pushLog(`saveAll 完成（${fmtKB(wallArchiveSize.value)}）`)
  } catch (err) {
    archiveError.value = err instanceof Error ? err.message : String(err)
    pushLog('saveAll 失败：' + archiveError.value)
  }
}

async function handleWallRestore() {
  if (!wallArchive) return
  archiveError.value = ''
  try {
    const r = await wallRef.value?.wallRestore(wallArchive)
    pushLog(
      `整墙恢复：恢复 ${r.restored} 张 / 重置 ${r.reset} 张 / 裁剪 ${r.truncated} 张` +
        (r.migrated === 'single' ? '（由单卡快照迁移）' : '')
    )
  } catch (err) {
    archiveError.value = err instanceof Error ? err.message : String(err)
    pushLog('wallRestore 失败：' + archiveError.value)
  }
}

/* v3 单卡 → wall 容器迁移演示（交织场景⑤） */
const singleRef = ref(null)
let singleSnapshot = null
function saveSingleAndMigrate() {
  archiveError.value = ''
  try {
    singleSnapshot = singleRef.value?.save() ?? null
    if (!singleSnapshot) return
    const wall1 = migrateSingleToWall(singleSnapshot)
    const decoded = decodeWallArchive(wall1)
    // 再验证：容器里的单卡段可被 ScratchCard.restore 单独恢复
    const seg0 = extractCardSnapshot(wall1, 0)
    const kind = detectArchiveKind(seg0)
    pushLog(
      `迁移演示：单卡 ${fmtKB(singleSnapshot.length)} → 墙容器 ${fmtKB(wall1.length)}` +
        `（容量 ${decoded.capacity}，段类型 ${kind}，可单卡 restore）`
    )
    // 直接用迁移产物整墙恢复（恢复为 1 张有数据的墙 + 其余全新空卡）
    wallRef.value?.wallRestore(wall1).then((r) => {
      pushLog(`迁移产物 wallRestore：恢复 ${r.restored} / 重置 ${r.reset}`)
    })
  } catch (err) {
    archiveError.value = err instanceof Error ? err.message : String(err)
  }
}

function dumpAnalysis() {
  if (!wallArchive) {
    pushLog('请先 saveAll')
    return
  }
  const d = decodeWallArchive(wallArchive)
  pushLog(
    `归档分析：容量 ${d.capacity} / 段数 ${d.entries.length} / ` +
      d.entries.map((e) => `#${e.index}${e.snapshot ? `(${fmtKB(e.snapshot.length)})` : '(配置)'})`).join(' ')
  )
}

/* 单卡 v3 兼容区用到的响应式 */
const singleProgress = ref(0)
const singleFinished = ref(false)
function onSingleProgress(v) {
  singleProgress.value = v
}
</script>

<template>
  <main class="page">
    <h1 class="page__title">刮刮卡 · 多卡运营墙 v4</h1>
    <p class="page__hint">
      纵向滚动陈列最多 {{ maxCards }} 张卡；滚出视口自动休眠（释放 canvas backing
      store），滚回 1 帧内恢复；离线状态超 LRU 预算转冷档，冷池超限丢弃最旧冷档。
    </p>

    <!-- 内存总览 -->
    <section class="panel">
      <div class="stat-row">
        <div class="stat">
          <span class="stat__label">在线 active</span>
          <strong>{{ totals.active }}</strong>
        </div>
        <div class="stat stat--sleep">
          <span class="stat__label">休眠 sleeping</span>
          <strong>{{ totals.sleeping }}</strong>
        </div>
        <div class="stat stat--cold">
          <span class="stat__label">冷档 archived</span>
          <strong>{{ totals.archived }}</strong>
        </div>
        <div class="stat stat--discard">
          <span class="stat__label">丢弃 discarded</span>
          <strong>{{ totals.discarded }}</strong>
        </div>
      </div>
      <div class="budget">
        <label>
          离线预算 {{ budgetMB }}MB · 已用
          <b :class="{ over: totals.offline > totals.offlineBudget }">
            {{ fmtKB(totals.offline) }}
          </b>
        </label>
        <div class="budget__bar">
          <div
            class="budget__fill budget__fill--off"
            :style="{ width: Math.min(100, (totals.offline / totals.offlineBudget) * 100) + '%' }"
          />
        </div>
      </div>
      <div class="budget">
        <label>
          冷存档池 {{ coldMB }}MB · 已用
          <b :class="{ over: totals.cold > totals.coldBudget }">{{ fmtKB(totals.cold) }}</b>
        </label>
        <div class="budget__bar">
          <div
            class="budget__fill budget__fill--cold"
            :style="{ width: Math.min(100, (totals.cold / totals.coldBudget) * 100) + '%' }"
          />
        </div>
      </div>
    </section>

    <!-- 运营墙 -->
    <ScratchCardWall
      ref="wallRef"
      class="wall"
      :cards="cards"
      :max-cards="maxCards"
      :wall-memory-budget="budgetMB * 1024 * 1024"
      :cold-archive-budget="coldMB * 1024 * 1024"
      :debug-overlay="debugOverlay"
      :wall-height="'62vh'"
      @card-archived="onCardArchived"
      @card-discarded="onCardDiscarded"
      @card-config-restored="onCardConfigRestored"
    >
      <template #default="{ card, index }">
        <div class="prize" :style="{ background: `linear-gradient(160deg,#fff,#f1f5f9)`, color: card.tone }">
          <span class="prize__idx">#{{ index }}</span>
          <strong class="prize__value">{{ card.value }}</strong>
          <span class="prize__name">{{ card.name }}</span>
        </div>
      </template>
    </ScratchCardWall>

    <!-- 调试面板 -->
    <section class="panel panel--debug">
      <h2 class="panel__title">调试面板（验收辅助，__debug 非生产接口）</h2>

      <div class="debug-grid">
        <label class="field">
          <span class="field__label">卡片数量（1-{{ maxCards }}）</span>
          <input v-model.number="cardCount" type="range" min="1" :max="maxCards" />
          <span class="field__desc">当前 {{ cardCount }} 张</span>
        </label>
        <label class="field">
          <span class="field__label">离线预算 {{ budgetMB }} MB</span>
          <input v-model.number="budgetMB" type="range" min="1" max="32" />
          <span class="field__desc">调小到 1MB 滚动后即触发 LRU 淘汰</span>
        </label>
        <label class="field">
          <span class="field__label">冷池预算 {{ coldMB }} MB</span>
          <input v-model.number="coldMB" type="range" min="1" max="16" />
          <span class="field__desc">继续淘汰使冷池超限即丢弃最旧冷档</span>
        </label>
        <label class="field field--switch">
          <span class="field__label">状态徽标</span>
          <input v-model="debugOverlay" type="checkbox" />
        </label>
      </div>

      <div class="debug-grid">
        <div class="field">
          <span class="field__label">向指定卡灌入大量笔迹</span>
          <div class="inline">
            <label>#<input v-model.number="seedIndex" type="number" min="0" class="num" /></label>
            <label>
              <input v-model.number="seedCount" type="number" min="1" class="num" /> 笔
            </label>
            <button class="tool-btn" type="button" @click="seedTarget">灌入笔迹</button>
          </div>
        </div>
        <div class="field">
          <span class="field__label">模拟快速滚动</span>
          <button class="tool-btn" type="button" :disabled="scrolling" @click="fastScroll">
            {{ scrolling ? '滚动中…' : '往返快速滚动' }}
          </button>
        </div>
        <div class="field">
          <span class="field__label">强制休眠 / 唤醒 / 淘汰</span>
          <div class="inline">
            <label>#<input v-model.number="targetIndex" type="number" min="0" class="num" /></label>
            <button class="tool-btn" type="button" @click="sleepTarget">休眠</button>
            <button class="tool-btn" type="button" @click="wakeTarget">唤醒</button>
            <button class="tool-btn tool-btn--warn" type="button" @click="archiveTarget">淘汰</button>
          </div>
        </div>
      </div>

      <div class="debug-grid">
        <div class="field">
          <span class="field__label">整墙批量存档（≤ {{ (WALL_ARCHIVE_MAX_BYTES / 1024 / 1024).toFixed(0) }}MB）</span>
          <div class="inline">
            <button class="tool-btn" type="button" @click="handleSaveAll">wall.saveAll()</button>
            <button class="tool-btn" type="button" :disabled="!wallArchive" @click="handleWallRestore">
              wallRestore
            </button>
            <button class="tool-btn" type="button" :disabled="!wallArchive" @click="dumpAnalysis">
              解析归档
            </button>
            <span v-if="wallArchive" class="field__desc">{{ fmtKB(wallArchiveSize) }}</span>
          </div>
        </div>
        <div class="field">
          <span class="field__label">v3 单卡快照 → wall 容器迁移（场景⑤）</span>
          <div class="inline">
            <button class="tool-btn" type="button" @click="saveSingleAndMigrate">
              存下方案例单卡并迁移/恢复
            </button>
          </div>
          <span class="field__desc">
            先在下方「单卡兼容区」刮几笔；迁移后整墙 #0 恢复为该卡，其余回出厂态
          </span>
        </div>
      </div>
      <p v-if="archiveError" class="snapshot-error">{{ archiveError }}</p>
    </section>

    <!-- 每卡状态表 -->
    <section class="panel">
      <h2 class="panel__title">每卡状态与内存量级（{{ metaRows.length }}）</h2>
      <div class="chip-grid">
        <span
          v-for="row in metaRows"
          :key="row.i"
          class="chip"
          :data-state="row.state"
          :title="`#${row.i} ${row.state} 离线 ${fmtKB(row.offline)} 冷档 ${fmtKB(row.coldBytes)} 进度 ${row.progress}%`"
        >
          {{ row.i }}:{{ row.state.slice(0, 4) }}
        </span>
      </div>
    </section>

    <!-- 事件日志 -->
    <section class="panel">
      <h2 class="panel__title">淘汰 / 恢复事件日志</h2>
      <ul class="log">
        <li v-for="(line, i) in log" :key="i">{{ line }}</li>
        <li v-if="!log.length" class="log__empty">（操作后在此输出 onCardArchived / onCardDiscarded 等事件）</li>
      </ul>
    </section>

    <!-- v3 单卡兼容区：证明对外接口未破坏，且单卡快照可迁移 -->
    <section class="panel">
      <h2 class="panel__title">v3 单卡兼容区（接口未改动 / 单卡快照来源）</h2>
      <div class="single-wrap">
        <ScratchCard
          ref="singleRef"
          :width="300"
          :height="168"
          :max-history="5000"
          @progress="onSingleProgress"
          @finish="singleFinished = true"
        >
          <div class="prize prize--mini">
            <strong>88 元</strong>
            <span>迁移用红包</span>
          </div>
        </ScratchCard>
        <span class="field__desc">已刮开 {{ singleProgress }}%{{ singleFinished ? ' · 已完成' : '' }}</span>
      </div>
    </section>
  </main>
</template>

<style scoped>
.page {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  box-sizing: border-box;
  max-width: 1100px;
  margin: 0 auto;
}

.page__title {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  color: #1f2937;
}

.page__hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: #6b7280;
}

.wall {
  flex: none;
}

.panel {
  padding: 14px 16px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.panel--debug {
  border-style: dashed;
}

.panel__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #6b7280;
  letter-spacing: 1px;
}

.stat-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.stat {
  flex: 1 1 110px;
  padding: 8px 12px;
  border-radius: 10px;
  background: #ecfdf5;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat strong {
  font-size: 22px;
  color: #065f46;
}

.stat--sleep {
  background: #eff6ff;
}
.stat--sleep strong {
  color: #1d4ed8;
}
.stat--cold {
  background: #f5f3ff;
}
.stat--cold strong {
  color: #6d28d9;
}
.stat--discard {
  background: #fef2f2;
}
.stat--discard strong {
  color: #b91c1c;
}

.stat__label {
  font-size: 12px;
  color: #6b7280;
}

.budget label {
  font-size: 12px;
  color: #4b5563;
}

.budget b {
  font-variant-numeric: tabular-nums;
}

.budget b.over {
  color: #dc2626;
}

.budget__bar {
  margin-top: 4px;
  height: 8px;
  border-radius: 999px;
  background: #e5e7eb;
  overflow: hidden;
}

.budget__fill {
  height: 100%;
  transition: width 0.25s ease;
}

.budget__fill--off {
  background: #2563eb;
}

.budget__fill--cold {
  background: #7c3aed;
}

.debug-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: #374151;
}

.field--switch {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.field__label {
  font-weight: 500;
}

.field__desc {
  font-size: 12px;
  color: #9ca3af;
}

.inline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.num {
  width: 64px;
  padding: 5px 6px;
  font-size: 13px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
}

.tool-btn {
  padding: 7px 14px;
  font-size: 13px;
  color: #2563eb;
  background: #fff;
  border: 1px solid #2563eb;
  border-radius: 999px;
  cursor: pointer;
}

.tool-btn:disabled {
  color: #9ca3af;
  border-color: #d1d5db;
  cursor: not-allowed;
}

.tool-btn--warn {
  color: #b91c1c;
  border-color: #b91c1c;
}

.snapshot-error {
  margin: 0;
  font-size: 13px;
  color: #dc2626;
}

.chip-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 3px 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  border-radius: 999px;
  background: #d1fae5;
  color: #065f46;
}

.chip[data-state='sleeping'] {
  background: #dbeafe;
  color: #1e40af;
}
.chip[data-state='archived'] {
  background: #ede9fe;
  color: #5b21b6;
}
.chip[data-state='discarded'] {
  background: #fee2e2;
  color: #991b1b;
}

.log {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
  color: #4b5563;
  max-height: 160px;
  overflow-y: auto;
}

.log__empty {
  color: #9ca3af;
  list-style: none;
  margin-left: -18px;
}

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
  top: 8px;
  right: 10px;
  font-size: 11px;
  color: #9ca3af;
}

.prize__value {
  font-size: 30px;
  font-weight: 800;
}

.prize__name {
  font-size: 13px;
}

.prize--mini {
  gap: 4px;
  color: #c2410c;
  background: linear-gradient(160deg, #fff7ed, #ffedd5);
}

.single-wrap {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
</style>
