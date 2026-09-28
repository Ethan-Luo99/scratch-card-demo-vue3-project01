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
- 响应式模式：卡片宽度撑满父容器、按宽高比推导高度，容器尺寸变化自动跟随
- 无损 resize：容器尺寸变化 / 浏览器缩放 / 跨屏拖动（DPR 变化）时刮痕与
  进度完整保留，刮痕等比缩放且边缘清晰
- 运行时换肤：coverColor / coverText / threshold 修改立即生效，不抹掉刮痕
- 演示页内置运营面板，可实时调整文案、底色、阈值与响应式开关
- 通用组件 `src/components/ScratchCard.vue`：
  - props：`width`、`height`、`responsive`、`aspectRatio`、`threshold`、
    `brushSize`、`coverColor`、`coverText`、`fadeDuration`
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
- 无损重建：刮痕同时以归一化坐标记录为矢量笔画，尺寸 / DPR 变化时
  「重绘涂层 + 等比重放笔画」，任意次重建都不降质，且零 getImageData。
- 尺寸监听：ResizeObserver 监听容器，matchMedia(resolution) 监听 DPR，
  统一用 rAF 合并重建（每帧最多一次），刮擦进行中画布始终跟手。
