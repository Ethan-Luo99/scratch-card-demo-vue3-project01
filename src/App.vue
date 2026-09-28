<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import ScratchCard from './components/ScratchCard.vue'

/* ---------- 刮刮卡运行时状态（运营面板可改） ---------- */
const coverText = ref('刮开查看奖品')
const coverColor = ref('#b8bcc6')
const threshold = ref(40)
const responsive = ref(true)

/* ---------- 演示状态 ---------- */
const progress = ref(0)
const finished = ref(false)
const cardRef = ref(null)
/** 验收辅助：实时显示当前 CSS 尺寸与 DPR（resize / 跨屏拖动时可直观确认） */
const envInfo = ref('')

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

function updateEnvInfo() {
  envInfo.value = `DPR ${window.devicePixelRatio || 1}`
}

onMounted(() => {
  updateEnvInfo()
  window.addEventListener('resize', updateEnvInfo)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateEnvInfo)
})
</script>

<template>
  <main class="page">
    <header class="page__head">
      <h1 class="page__title">刮刮乐</h1>
      <p class="page__hint">按住鼠标或手指拖动，刮开涂层查看奖品 · {{ envInfo }}</p>
    </header>

    <!-- 卡片区域：宽度 = min(92vw, 520px)；responsive 时组件撑满此容器 -->
    <section class="stage">
      <!-- 同一个组件动态切换布局：开关切换等同一次容器尺寸变化，
           走内部无损 resize，刮痕与进度同样保留 -->
      <ScratchCard
        ref="cardRef"
        :responsive="responsive"
        :aspect-ratio="320 / 190"
        :width="320"
        :height="190"
        :threshold="threshold"
        :brush-size="30"
        :cover-color="coverColor"
        :cover-text="coverText"
        @progress="handleProgress"
        @finish="handleFinish"
      >
        <div class="prize">
          <span class="prize__label">恭喜获得</span>
          <strong class="prize__value">88 元</strong>
          <span class="prize__name">现金红包</span>
        </div>
      </ScratchCard>
    </section>

    <p class="progress" :class="{ 'progress--done': finished }">
      已刮开 {{ progress }}%
      <template v-if="finished"> · 恭喜中奖 🎉</template>
    </p>

    <!-- 运营控制面板：所有改动运行时立即生效 -->
    <section class="panel">
      <h2 class="panel__title">运营面板</h2>

      <label class="panel__row">
        <span class="panel__label">涂层文案</span>
        <input v-model="coverText" class="panel__input" type="text" maxlength="12" />
      </label>

      <label class="panel__row">
        <span class="panel__label">涂层颜色</span>
        <span class="panel__color">
          <input v-model="coverColor" class="panel__color-input" type="color" />
          <code class="panel__color-code">{{ coverColor }}</code>
        </span>
      </label>

      <label class="panel__row">
        <span class="panel__label">完成阈值</span>
        <span class="panel__range">
          <input v-model.number="threshold" type="range" min="1" max="100" />
          <output class="panel__range-value">{{ threshold }}%</output>
        </span>
      </label>

      <label class="panel__row">
        <span class="panel__label">响应式宽度</span>
        <span class="panel__switch">
          <input v-model="responsive" type="checkbox" />
          <span :class="['panel__switch-state', { 'is-on': responsive }]">
            {{ responsive ? '撑满容器' : '固定 320×190' }}
          </span>
        </span>
      </label>

      <button class="reset-btn" type="button" @click="handleReset">重置刮刮卡</button>
    </section>
  </main>
</template>

<style scoped>
.page {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 24px 16px 40px;
  box-sizing: border-box;
}

.page__head {
  text-align: center;
}

.page__title {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #2b2f38;
}

.page__hint {
  margin: 6px 0 0;
  font-size: 13px;
  color: #8a909c;
}

/* 卡片舞台：min(92vw, 520px)，窄屏留边、宽屏封顶居中 */
.stage {
  width: min(92vw, 520px);
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
  font-size: clamp(32px, 9vw, 44px);
  line-height: 1.1;
  font-weight: 800;
}

.prize__name {
  font-size: 15px;
  color: #9a3412;
}

.progress {
  margin: 0;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  color: #4b5563;
}

.progress--done {
  color: #c2410c;
  font-weight: 600;
}

/* ---------- 运营面板 ---------- */
.panel {
  width: min(92vw, 520px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  box-shadow: 0 4px 18px rgba(17, 24, 39, 0.06);
  box-sizing: border-box;
}

.panel__title {
  margin: 0 0 2px;
  font-size: 15px;
  font-weight: 600;
  color: #374151;
}

.panel__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
}

.panel__label {
  color: #4b5563;
  flex: none;
}

.panel__input {
  width: 180px;
  max-width: 50vw;
  padding: 6px 10px;
  font-size: 14px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  outline: none;
}

.panel__input:focus {
  border-color: #2563eb;
}

.panel__color {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.panel__color-input {
  width: 42px;
  height: 30px;
  padding: 0;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: none;
  cursor: pointer;
}

.panel__color-code {
  font-size: 12px;
  color: #6b7280;
}

.panel__range {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.panel__range input {
  width: 150px;
  max-width: 42vw;
}

.panel__range-value {
  width: 42px;
  text-align: right;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: #374151;
}

.panel__switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.panel__switch-state {
  font-size: 12px;
  color: #9ca3af;
}

.panel__switch-state.is-on {
  color: #2563eb;
  font-weight: 600;
}

.reset-btn {
  margin-top: 4px;
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
</style>
