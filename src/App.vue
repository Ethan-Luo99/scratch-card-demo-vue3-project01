<script setup>
import { ref } from 'vue'
import ScratchCard from './components/ScratchCard.vue'

const progress = ref(0)
const finished = ref(false)
const cardRef = ref(null)

/* ---------- 运营面板配置 ---------- */

const coverText = ref('刮开查看奖品')
const coverColor = ref('#b8bcc6')
const threshold = ref(40)
const responsive = ref(true)
const maxHistory = ref(200)
const rasterizeAfter = ref(500)

const colorPresets = ['#b8bcc6', '#2563eb', '#c2410c', '#0f766e', '#7c3aed']

/* ---------- 存档 ---------- */

const SNAPSHOT_KEY = 'scratch-card-snapshot'
const snapshotSize = ref(0)
const snapshotSaved = ref(false)
const restoreTip = ref('')

function handleProgress(value) {
  progress.value = value
}

function handleFinish() {
  finished.value = true
}

function handleReset() {
  cardRef.value?.reset()
  progress.value = 0
  finished.value = false
  restoreTip.value = ''
}

/* ---------- 撤销 / 重做 ---------- */

function handleUndo() {
  cardRef.value?.undo()
}

function handleRedo() {
  cardRef.value?.redo()
}

/* ---------- 存档 / 恢复 ---------- */

function handleSave() {
  const snapshot = cardRef.value.save()
  const serialized = JSON.stringify(snapshot)
  snapshotSize.value = serialized.length
  snapshotSaved.value = true
  localStorage.setItem(SNAPSHOT_KEY, serialized)
  restoreTip.value = `已存档（${(serialized.length / 1024).toFixed(1)} KB），可刷新页面后恢复`
}

function handleRestore() {
  const raw = localStorage.getItem(SNAPSHOT_KEY)
  if (!raw) {
    restoreTip.value = '本地没有存档，请先「保存快照」'
    return
  }
  const result = cardRef.value?.restore(JSON.parse(raw))
  if (result) {
    finished.value = !!result.finished
    progress.value = result.progress
  }
  restoreTip.value = '已从本地快照恢复'
}

/* ---------- 压测：合成 N 笔笔迹（验证固化 / 永久化 / 跨边界 undo） ---------- */

function fillStrokes(count) {
  cardRef.value?.__fillStrokes(count)
}

function runPerfBench() {
  const result = cardRef.value?.__benchReplay()
  if (result) {
    restoreTip.value = `重放耗时 50笔=${result.t50.toFixed(2)}ms / 5000笔=${result.t5000.toFixed(2)}ms（详见控制台）`
  }
}
</script>

<template>
  <main class="page">
    <h1 class="page__title">刮刮乐</h1>
    <p class="page__hint">
      按住鼠标或手指拖动刮开涂层；支持撤销 / 重做、存档恢复，
      拖动窗口边缘、缩放浏览器或切换下方开关，刮痕与进度都会保留
    </p>

    <div class="stage">
      <ScratchCard
        ref="cardRef"
        class="stage__card"
        :responsive="responsive"
        :width="320"
        :height="190"
        :threshold="threshold"
        :brush-size="30"
        :cover-color="coverColor"
        :cover-text="coverText"
        :max-history="maxHistory"
        :rasterize-after="rasterizeAfter"
        @progress="handleProgress"
        @finish="handleFinish"
      >
        <div class="prize">
          <span class="prize__label">恭喜获得</span>
          <strong class="prize__value">88 元</strong>
          <span class="prize__name">现金红包</span>
        </div>
      </ScratchCard>
    </div>

    <p class="progress" :class="{ 'progress--done': finished }">
      已刮开 {{ progress }}%
      <template v-if="finished"> · 恭喜中奖 🎉</template>
    </p>

    <div class="actions">
      <button type="button" :disabled="!cardRef?.canUndo" @click="handleUndo">
        撤销
      </button>
      <button type="button" :disabled="!cardRef?.canRedo" @click="handleRedo">
        重做
      </button>
      <button type="button" class="primary" @click="handleSave">保存快照</button>
      <button type="button" @click="handleRestore">恢复快照</button>
      <button type="button" @click="handleReset">重置</button>
    </div>

    <p v-if="restoreTip" class="tip">{{ restoreTip }}</p>
    <p v-if="snapshotSaved" class="tip tip--muted">
      最近快照体积：{{ (snapshotSize / 1024).toFixed(2) }} KB（上限 2048 KB）
    </p>

    <section class="panel">
      <h2 class="panel__title">运营面板</h2>

      <label class="field">
        <span class="field__label">涂层文案</span>
        <input v-model="coverText" class="field__input" type="text" placeholder="留空则不显示文案" />
      </label>

      <div class="field">
        <span class="field__label">涂层底色</span>
        <div class="field__colors">
          <input v-model="coverColor" class="field__color" type="color" title="自定义颜色" />
          <button
            v-for="color in colorPresets"
            :key="color"
            type="button"
            class="swatch"
            :class="{ 'swatch--active': coverColor === color }"
            :style="{ background: color }"
            :title="color"
            @click="coverColor = color"
          />
        </div>
      </div>

      <label class="field">
        <span class="field__label">完成阈值：{{ threshold }}%</span>
        <input v-model.number="threshold" class="field__range" type="range" min="1" max="100" />
      </label>

      <label class="field">
        <span class="field__label">撤销栈上限 maxHistory：{{ maxHistory }}</span>
        <input v-model.number="maxHistory" class="field__range" type="range" min="1" max="1000" />
      </label>

      <label class="field">
        <span class="field__label">固化阈值 rasterizeAfter：{{ rasterizeAfter }}</span>
        <input v-model.number="rasterizeAfter" class="field__range" type="range" min="1" max="2000" />
      </label>

      <label class="field field--switch">
        <span class="field__label">响应式模式</span>
        <input v-model="responsive" type="checkbox" class="field__checkbox" />
        <span class="field__desc">
          {{ responsive ? '宽度撑满容器，高宽比 16:9' : '固定 320 × 190' }}
        </span>
      </label>

      <div class="field field--full">
        <span class="field__label">压测（合成笔迹，验证固化 / 永久化 / 跨边界 undo）</span>
        <div class="field__actions">
          <button type="button" @click="fillStrokes(600)">灌入 600 笔</button>
          <button type="button" @click="fillStrokes(5000)">灌入 5000 笔</button>
          <button type="button" @click="runPerfBench">实测重放耗时</button>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.page {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  box-sizing: border-box;
}

.page__title {
  margin: 0;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #2b2f38;
}

.page__hint {
  margin: 0 0 6px;
  max-width: 560px;
  font-size: 14px;
  line-height: 1.6;
  text-align: center;
  color: #8a909c;
}

.stage {
  width: min(92vw, 520px);
  display: flex;
  justify-content: center;
}

.stage__card {
  max-width: 100%;
}

.prize {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #c2410c;
  background: linear-gradient(160deg, #fff7ed 0%, #ffedd5 100%);
}

.prize__label {
  font-size: 14px;
  color: #9a3412;
}

.prize__value {
  font-size: 44px;
  line-height: 1.1;
  font-weight: 800;
}

.prize__name {
  font-size: 15px;
  color: #9a3412;
}

.progress {
  margin: 4px 0 0;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  color: #4b5563;
}

.progress--done {
  color: #c2410c;
  font-weight: 600;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}

.actions button {
  padding: 8px 18px;
  font-size: 14px;
  color: #1f2937;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 0.15s, transform 0.1s;
}

.actions button:hover:not(:disabled) {
  background: #f3f4f6;
}

.actions button:active:not(:disabled) {
  transform: scale(0.96);
}

.actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.actions button.primary {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}

.actions button.primary:hover {
  background: #1d4ed8;
}

.tip {
  margin: 0;
  font-size: 13px;
  color: #2563eb;
}

.tip--muted {
  color: #9ca3af;
}

.panel {
  width: min(92vw, 520px);
  margin-top: 4px;
  padding: 18px 20px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px 20px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  box-sizing: border-box;
}

.panel__title {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #6b7280;
  letter-spacing: 1px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
  color: #374151;
}

.field--full {
  grid-column: 1 / -1;
}

.field__label {
  font-weight: 500;
}

.field__input {
  padding: 8px 10px;
  font-size: 14px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  outline: none;
}

.field__input:focus {
  border-color: #2563eb;
}

.field__colors {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field__color {
  width: 36px;
  height: 28px;
  padding: 0;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: none;
  cursor: pointer;
}

.swatch {
  width: 24px;
  height: 24px;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.1s;
}

.swatch--active {
  border-color: #111827;
  transform: scale(1.1);
}

.field__range {
  accent-color: #2563eb;
}

.field--switch {
  flex-direction: row;
  align-items: center;
  gap: 10px;
}

.field__checkbox {
  width: 18px;
  height: 18px;
  accent-color: #2563eb;
}

.field__desc {
  font-size: 13px;
  color: #6b7280;
}

.field__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.field__actions button {
  padding: 6px 14px;
  font-size: 13px;
  color: #1f2937;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  cursor: pointer;
}

.field__actions button:hover {
  background: #f3f4f6;
}
</style>
