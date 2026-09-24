<script setup>
import { ref } from 'vue'
import ScratchCard from './components/ScratchCard.vue'

// 刮开面积百分比（0-100），由 ScratchCard 的 progress 事件实时更新
const progress = ref(0)
// 是否已刮达阈值并触发完成回调
const finished = ref(false)
const cardRef = ref(null)

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
    <p class="page__hint">按住鼠标或手指拖动，刮开涂层查看奖品</p>

    <ScratchCard
      ref="cardRef"
      :width="320"
      :height="190"
      :threshold="40"
      :brush-size="30"
      cover-text="刮开查看奖品"
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

    <p class="progress" :class="{ 'progress--done': finished }">
      已刮开 {{ progress }}%
      <template v-if="finished"> · 恭喜中奖 🎉</template>
    </p>

    <button class="reset-btn" type="button" @click="handleReset">
      重置
    </button>
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
  font-size: 14px;
  color: #8a909c;
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
</style>
