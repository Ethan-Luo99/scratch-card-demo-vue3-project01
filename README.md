# 刮刮卡演示（Vue 3 + Vite）

基于 Vue 3 组合式 API + Canvas 实现的刮刮卡演示页面，无任何额外运行时依赖。

## 运行

```bash
npm install
npm run dev
```

## 功能

- 鼠标拖动 / 手指触摸刮开灰色涂层，底层为写死的中奖内容（88 元现金红包）
- 实时显示刮开面积百分比，达到阈值（默认 40%）后涂层整体淡出并触发完成回调
- 支持重置后再次刮开
- 通用组件 `src/components/ScratchCard.vue`：
  - props：`width`、`height`、`threshold`、`brushSize`、`coverColor`、
    `coverText`、`fadeDuration`
  - 默认插槽：底层中奖内容
  - 事件：`progress`（0-100）、`finish`
  - 暴露方法：`reset()`

## 实现说明

- 高清屏：canvas backing store 按 `devicePixelRatio` 放大并做坐标缩放，
  2x/3x 设备上刮痕清晰、位置无偏移。
- 触控：Pointer Events 按 `pointerId` 维护各自轨迹，支持多指同时刮；
  `touch-action: none` 禁止页面滚动与缩放。
- 性能：不做每次 move 的全图 `getImageData`，而是降采样到约 12px 网格的
  离屏小画布（几百个像素），配合约 160ms 节流统计透明点占比；pointerup 立即补测。
- 快速甩动：相邻采样点用粗线段（round cap/join）连接，并消费
  `getCoalescedEvents()` 补点，笔迹连续不漏刮。
- 标签页切换：`visibilitychange` 时清理悬挂的指针状态，切回后正常使用。
