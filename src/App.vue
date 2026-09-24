<script setup>
import { ref } from 'vue'
import ScratchCard from './components/ScratchCard.vue'

// 刮开进度（0~1）与完成状态，由 ScratchCard 事件驱动
const progress = ref(0)
const finished = ref(false)
const cardRef = ref(null)

function onProgress(value) {
  progress.value = value
}

function onFinish() {
  finished.value = true
}

function reset() {
  finished.value = false
  progress.value = 0
  cardRef.value?.reset()
}
</script>

<template>
  <main class="page">
    <h1 class="page__title">刮刮卡演示</h1>
    <p class="page__tip">按住鼠标或手指拖动，刮开灰色涂层查看奖品</p>

    <ScratchCard
      ref="cardRef"
      :width="320"
      :height="200"
      :threshold="0.4"
      :brush-size="30"
      cover-text="刮开查看奖品"
      @progress="onProgress"
      @finish="onFinish"
    >
      <div class="prize">
        <span class="prize__label">恭喜中奖</span>
        <strong class="prize__amount">88 元</strong>
        <span class="prize__name">现金红包</span>
      </div>
    </ScratchCard>

    <p class="progress" :class="{ 'is-done': finished }">
      已刮开 {{ (progress * 100).toFixed(0) }}%
      <template v-if="finished"> —— 已全部揭开 🎉</template>
    </p>

    <button type="button" class="reset-btn" @click="reset">重置</button>
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
  font-size: 28px;
  font-weight: 600;
  color: #1f2430;
}

.page__tip {
  margin: 0 0 6px;
  font-size: 14px;
  color: #6b7280;
}

.prize {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #fff;
  background: linear-gradient(135deg, #ff6b4a 0%, #e23a3a 100%);
}

.prize__label {
  font-size: 14px;
  letter-spacing: 2px;
  opacity: 0.9;
}

.prize__amount {
  font-size: 44px;
  line-height: 1.1;
  font-weight: 800;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
}

.prize__name {
  font-size: 15px;
  opacity: 0.92;
}

.progress {
  margin: 0;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  color: #374151;
}

.progress.is-done {
  color: #e23a3a;
  font-weight: 600;
}

.reset-btn {
  padding: 10px 32px;
  font-size: 15px;
  color: #fff;
  background: #1f2430;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease;
}

.reset-btn:hover {
  background: #323a4d;
}

.reset-btn:active {
  transform: scale(0.96);
}
</style>
