<script setup>
import { ref } from 'vue'
import ScratchCard from './components/ScratchCard.vue'

// 刮开面积百分比（0-100），由 ScratchCard 的 progress 事件实时更新
const progress = ref(0)
// 是否已刮达阈值并触发完成回调
const finished = ref(false)
const cardRef = ref(null)

/* ---------- 运营面板：运行时换肤 / 调阈值 / 切换响应式 ---------- */

const coverText = ref('刮开查看奖品')
const coverColor = ref('#b8bcc6')
const threshold = ref(40)
const responsive = ref(true)

const colorPresets = ['#b8bcc6', '#2563eb', '#c2410c', '#0f766e', '#7c3aed']

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
}
</script>

<template>
  <main class="page">
    <h1 class="page__title">刮刮乐</h1>
    <p class="page__hint">
      按住鼠标或手指拖动刮开涂层；拖动窗口边缘、缩放浏览器或切换下方开关，
      刮痕与进度都会保留
    </p>

    <!-- 卡片容器：宽度 min(92vw, 520px)，响应式模式下卡片撑满并自动跟随 -->
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
        @progress="handleProgress"
        @finish="handleFinish"
      >
        <!-- 底层中奖内容由默认插槽传入，可任意自定义 -->
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

    <button class="reset-btn" type="button" @click="handleReset">
      重置
    </button>

    <!-- 运营面板：所有修改运行时立即生效，不影响已有刮痕 -->
    <section class="panel">
      <h2 class="panel__title">运营面板</h2>

      <label class="field">
        <span class="field__label">涂层文案</span>
        <input
          v-model="coverText"
          class="field__input"
          type="text"
          placeholder="留空则不显示文案"
        />
      </label>

      <div class="field">
        <span class="field__label">涂层底色</span>
        <div class="field__colors">
          <input
            v-model="coverColor"
            class="field__color"
            type="color"
            title="自定义颜色"
          />
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
        <input
          v-model.number="threshold"
          class="field__range"
          type="range"
          min="1"
          max="100"
        />
      </label>

      <label class="field field--switch">
        <span class="field__label">响应式模式</span>
        <input v-model="responsive" type="checkbox" class="field__checkbox" />
        <span class="field__desc">
          {{ responsive ? '宽度撑满容器，高宽比 16:9' : '固定 320 × 190' }}
        </span>
      </label>
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
  gap: 18px;
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
  max-width: 520px;
  font-size: 14px;
  line-height: 1.6;
  text-align: center;
  color: #8a909c;
}

/* 卡片容器：宽度 = min(92vw, 520px) */
.stage {
  width: min(92vw, 520px);
  display: flex;
  justify-content: center;
}

/* 卡片自身内联样式决定宽度（响应式 100% / 固定 320px），
   这里只兜底不超出容器，固定尺寸时由 stage 居中 */
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
  margin: 6px 0 0;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  color: #4b5563;
}

.progress--done {
  color: #c2410c;
  font-weight: 600;
}

.reset-btn {
  padding: 9px 34px;
  font-size: 15px;
  color: #fff;
  background: #2563eb;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 0.2s, transform 0.1s;
}

.reset-btn:hover {
  background: #1d4ed8;
}

.reset-btn:active {
  transform: scale(0.96);
}

/* ---------- 运营面板 ---------- */

.panel {
  width: min(92vw, 520px);
  margin-top: 6px;
  padding: 18px 20px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
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
  color: #8a909c;
}
</style>
