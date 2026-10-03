# 刮刮卡演示（Vue 3 + Vite，运营级 v3）

基于 Vue 3 组合式 API + Canvas 实现的刮刮卡，无任何额外运行时依赖。
v3 在 v2「归一化矢量笔迹 + 无损 resize」基础上新增：**笔画粒度撤销/重做、
分层固化缓存、紧凑二进制存档/恢复**，面向长时间高频使用的运营场景。

## 运行

```bash
npm install
npm run dev
```

## 功能

- 鼠标拖动 / 手指触摸（多指）刮开涂层，实时进度，达阈值淡出完成
- **撤销/重做**：笔画粒度，`undo()`/`redo()` + `canUndo`/`canRedo`，
  栈深上限 `maxHistory`（默认 200），超限丢弃最旧笔画（刮痕保留、不可撤销）
- **分层缓存**：超过 `rasterizeAfter`（默认 500）笔后已确认笔迹固化为
  遮罩位图，重放只花「位图 drawImage + 有界增量」，与总笔数解耦
- **存档/恢复**：`save()` 返回 `Uint8Array` 紧凑快照（笔迹差分编码 +
  固化位图 RLE + 进度 + 完成态标志，硬上限 2MB），`restore(snapshot)` 无损恢复
- 响应式 / 固定尺寸、无损 resize（尺寸、DPR 变化刮痕进度全保留）
- 运行时换肤（coverColor / coverText / threshold 即时生效）
- 演示页内置运营面板 + 调试面板（压测注入 50/5000 笔）

## 组件 API（`src/components/ScratchCard.vue`）

- props：`width`、`height`、`responsive`、`aspectRatio`、`threshold`、
  `brushSize`、`coverColor`、`coverText`、`fadeDuration`（v2 全部保留）、
  新增 `maxHistory`（撤销栈深，默认 200）、`rasterizeAfter`（固化阈值，默认 500）
- 默认插槽：底层中奖内容；事件：`progress`（0-100）、`finish`
- 暴露方法/状态：`reset()`、`undo()`、`redo()`、`save()`、`restore(snapshot)`、
  `canUndo` / `canRedo`（响应式布尔）
- 调试：`__debug.seed(n)` 注入压测笔迹，`__debug.replayMs()` 最近重放耗时

## 核心设计与取舍

### 数据模型（唯一事实来源）

`slots` 时间线槽位 `{ id, w, pts, alive, block }`：归一化矢量笔迹 + 存活标记 +
固化块号。undo/redo 栈只存槽位 id。已固化槽位恒为时间线**连续前缀**
（固化与丢弃都只吃最旧的），因此快照只需一个 `solidTo` 计数即可还原分块。

### 两级固化位图（为什么不是一级）

- `solidMask` 可重建固化层：矢量保留（供 undo 回退），超 `rasterizeAfter`
  时分批烘入（每帧一批 16 笔，亚毫秒，不掉帧、不丢刮痕）；
- `frozenMask` 永久固化层：超 `maxHistory` 被丢弃的笔画，矢量随丢弃释放
  ——这是**内存硬上界**的关键（在册槽位 ≤ maxHistory + rasterizeAfter + 余量）。
- 单级位图无法同时满足「超阈值要固化（重放快）」与「栈内笔画可撤销
  （位图必须能重建）」；两级叠加（先 frozen 后 solid）即完整固化遮罩。
- 默认 maxHistory(200) < rasterizeAfter(500) 时笔画先被历史上限丢弃，
  固化层不积累；把 maxHistory 调大（演示页为 5000）即可观察到固化层工作。

### undo 跨固化边界：逐像素等价的依据

固化块的矢量在被 maxHistory 丢弃前始终保留。undo 命中固化槽位时只置
`alive=false` 并标脏，下一帧**合并**为一次整层重栅格化——与全量重放走
同一套矢量绘制代码路径，结果逐像素等价；同帧连续 undo 只重建一次，
不会 O(n²)。redo 对称。已被丢弃进永久层的笔画无矢量、不在撤销栈内，
天然不可撤销（栈深语义）。

### redo 栈与换肤的语义：保留

换肤（coverColor/coverText）只重绘涂层外观，不触碰任何笔迹几何，
redo 恢复的是几何而非外观，因此 redo 栈原样保留（注释见组件文件头）。
只有「刮出新的一笔」与 `reset` 会清空 redo 栈。

### restore 的完成态语义

快照记录存档时的 `finished` 标志并原样恢复：存档自已完成卡片 →
恢复为完成态（涂层隐藏，undo/redo 按规则禁用，并重新 emit `finish`
便于调用方同步）；存档自进行中卡片 → 恢复为可继续编辑态，且**抑制**
恢复时的测量误触发 finish（否则覆盖率饱和的快照恢复后 undo/redo
会被全部禁用）。用户再次刮擦时解除抑制，届时若仍达阈值正常 finish。

### 快照格式与 2MB 编码选型（`src/scratchCodec.js`）

- 不用 JSON：浮点笔画点每点约 15~25 字节，5000 笔（约 10 万点）即逼近
  2MB，再无空间放位图，且 parse 慢；
- 不用 base64 PNG：稀疏 alpha 遮罩走图像压缩效率低，base64 再膨胀 33%，
  且编解码开销不可控（需求明确禁止）；
- 采用手写紧凑二进制：笔画坐标/笔宽量化 u16（320px 宽下误差 < 0.005px，
  亚像素、肉眼不可辨），相邻点 zigzag + varint 差分（通常 1 字节/点）；
  位图只存 alpha 平面，逐行自适应 RLE（空白行 3 字节，噪点行原样存储
  保证不膨胀）。快照体积与 **maxHistory** 挂钩天然有界；
  编码后硬校验 > 2MB 直接抛错，绝不静默截断。
- 实测：5000 笔 + 永久层位图 ≈ 384KB，50 笔 ≈ 3.6KB，3 笔 ≈ 0.2KB。
- `save()` 返回 `Uint8Array`：可直接结构化克隆存 IndexedDB；如需
  localStorage 需自行 base64（仅作容器传输，与「禁 base64 PNG」无关）。
- 固化层（solidMask）不存位图：其矢量全部在册，restore 重栅格化更精确；
  快照中的位图数据是无矢量来源的永久固化层（必需）。

### getImageData 使用边界

渲染/交互主路径（move/resize/replay/undo/redo）全程零 getImageData；
进度统计沿用 v2 的降采样小画布（约 12px 网格、几百像素）；仅 `save()`
这个一次性冷路径读取固化层位图（最长边限 2048 的有界画布），
这是快照功能的必要组成。

## 性能验证（硬指标复测方法）

控制台执行 `window.__SCRATCH_DEBUG__ = true` 开启重放计时（每次重放
用 `performance.now()` 打印耗时与分层规模），然后：

1. 点「注入 50 笔」，拖动窗口边缘触发 resize，记录重放耗时；
2. 点「注入 5000 笔」，再次拖动窗口边缘，对比耗时。

无头 Chromium（软件渲染）实测：

| 规模 | 稳态重放耗时 | 说明 |
| --- | --- | --- |
| 50 笔 | 0.1 ~ 0.2 ms | 纯增量重放 |
| 5000 笔 | 0.4 ~ 1.4 ms | 2 次位图 drawImage + 520 笔增量 |

两者同量级、均远低于 16ms 帧预算——重放耗时与总笔数解耦。
（首次重放约 8ms/170ms 为软件渲染下文字与位图的冷启动光栅化，非稳态。）
另实测：同帧连续 600 次跨固化边界 undo 只触发一次重固化（标志位合并）。

## 边界场景手工复验清单

1. **固化瞬间发生 undo**：注入 5000 笔（固化层形成）后立刻连点「撤销」
   ——刮痕逐笔回退，无闪烁无丢失（同帧合并为一次重固化）。
2. **resize 过程中连续 undo**：注入 5000 笔，拖动窗口边缘的同时连点
   「撤销」——重放与重固化经 rAF 合并，每帧至多一轮，刮痕始终正确。
3. **淡出期间 restore**：刮到达阈值触发淡出，淡出动画进行中点「恢复」
   ——淡出取消、涂层立即恢复为存档状态（旧隐藏定时器已取消）。
4. **换肤后 redo 栈保留**：刮几笔 → 撤销 → 运营面板换底色/文案 →
   「重做」仍可用（语义：换肤不改几何，见上文设计说明）。
5. **save 发生在 rAF 重建挂起期间**：开启调试开关，拖动窗口边缘的
   同时点「存档」——save 内部先同步冲刷挂起的 rebuild/维护再序列化，
   快照必为最终一致状态（恢复后刮痕与进度正确）。
6. **多指刮擦中 undo**：两指同时刮，另一手点「撤销」——只撤销最近
   一笔**已确认**笔迹，进行中的两笔不受影响，可继续刮。
7. **reset 后撤销栈清空**：任意刮擦后「重置」——`canUndo`/`canRedo`
   均变 false，进度归零。
8. **完成后 undo/redo 禁用**：刮到达阈值后，撤销/重做按钮置灰。
9. **存档体积**：注入 5000 笔后「存档」，快照约 384KB（远低于 2MB）；
   「恢复」后 undo/redo、resize、换肤、响应式全部继续正常。
10. **历史上限丢弃**：把 `maxHistory` 调小（如 50）刮超过 50 笔——
    最旧笔画仍显示为已刮开（已烘入永久层），但不可再撤销。

## 继承自 v2 的实现要点

- backing store 按 DPR 放大 + 坐标缩放，高清屏刮痕清晰；
- Pointer Events 按 pointerId 维护多指轨迹，`touch-action: none`；
- 进度统计用降采样小画布 + 约 160ms 节流，pointerup 立即补测；
- 快速甩动粗线段连接 + `getCoalescedEvents()` 补点，笔迹连续；
- ResizeObserver + matchMedia(resolution) 监听尺寸/DPR，rAF 合并重建；
- `visibilitychange` 清理悬挂指针状态。
