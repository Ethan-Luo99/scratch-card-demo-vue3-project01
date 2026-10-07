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

---

# v4：多卡运营墙（ScratchCardWall）

在 v3 单卡能力（接口全部保留、仅新增）之上新增「多卡运营墙」：一张页面
纵向滚动陈列最多 `maxCards`（默认 50）张刮刮卡，长时间挂机下控制总内存
与滚动流畅度。**不引入任何运行时依赖。**

## 运行

```bash
npm run dev      # 打开演示页即「运营墙 + 调试面板」
```

## 新增文件 / 改动

- `src/components/ScratchCardWall.vue`：墙组件（视口感知、LRU、冷池、批量存档）
- `src/wallCodec.js`：整墙容器格式 `SCWL` + v3 单卡 → 墙容器迁移
- `src/scratchCodec.js`：仅新增（magic 识别、版本号读取、迁移分发表）
- `src/components/ScratchCard.vue`：仅新增休眠/离屏接口（见下），v3 语义不变
- `src/App.vue`：v4 运营墙演示 + 调试面板

## ScratchCard v4 新增暴露（v3 接口一字未改）

`sleep()` / `wake()` / `isSleeping()` / `serializeOffline()` /
`restoreOffline(snapshot)` / `clearStateOffline()` / `memoryStats()` /
`hasContent()`；新增事件 `interact`（真实刮擦 pointerdown 时派发）。
`save()`/`restore()` 本身也已休眠感知（休眠卡 save 走离屏序列化、
restore 自动回在线态）。

墙给每卡传入新增的 `initSleeping` prop：所有卡槽**挂载时即为休眠态**，
离屏卡从一开始就不分配主 canvas backing store（避免 50 张卡首帧同时
分配的一次性显存峰值）；卡槽上另有一个与涂层同色的纯 CSS 占位层
（`.scratch-wall__cover`，`pointer-events:none`）遮盖尚未建立涂层时的
底层奖品，卡片一进入视口与 `wake()` 同帧移除。该 prop 默认 false，
v3 单独使用 ScratchCard 时行为不变。

**休眠释放口径**：`sleep()` 释放主显示 canvas 的 backing store 与
`solidMask`（都可确定性重建），保留归一化矢量时间线（slots/undo/redo/
blocks）与 `frozenMask` 永久层位图（无矢量来源，不可重建）。`wake()` 在
一次同步调用内完成「永久层尺寸/DPR 迁移 + solid 层矢量重栅格化 + 分层
重放 + 进度复测」，调用返回时画面已完整——滚回视口同帧恢复。

## 三级状态与内存预算（公式见组件文件头注释）

- `active` 视口内；`sleeping` 滚出视口（释放两个 backing store，驻留
  矢量 + 永久层）；`archived` LRU 淘汰（只剩冷池里的 save() 快照）；
  `discarded` 冷池再超限丢弃（滚回为全新空卡）。
- 离线预算 `wallMemoryBudget`（默认 **16MB**）：
  `S = Σ_sleeping ( points×16 + slots×80 + frozenW×frozenH×4 )`，
  即矢量驻留保守上界 + 永久层 RGBA 字节；**主画布与 solidMask 不计入**
  （休眠后保证为 0）。
- 冷池预算 `coldArchiveBudget`（默认 **8MB**）：`Σ 冷档快照精确字节`。
- LRU：真实刮擦（`interact`）刷新时间；仅在 sleeping 卡中选最久未交互者
  淘汰；冷池超限按入池次序 FIFO 丢弃，触发 `onCardArchived` /
  `onCardDiscarded`。

## 整墙归档格式（wallCodec.js，硬上限 8MB）

`SCWL` 信封内每段 payload 原样就是 v3 `SC1` 单卡快照：

- `wall.saveAll()` → 单一 `Uint8Array`（稀疏：空卡不出段），> 8MB 抛错；
- `wall.wallRestore(archive)` 异步分帧（每帧 6 张，不卡滚动），同时接受
  墙归档与 **v3 单卡快照**（自动 `migrateSingleToWall` 迁移成容量 1 的墙）；
- `extractCardSnapshot(archive, i)` 零拷贝取出单卡段，可直接
  `ScratchCard.restore(seg)` 单独恢复；
- 卡数不一致语义：段下标超出现有卡槽 → **裁剪忽略**并在返回值
  `truncated` 告知（墙不能凭空造出品卡槽位，静默裁剪优于整包失败）；
  现有卡槽多于归档段 → 未覆盖卡槽**重置为全新空卡**（restore 即
  「墙变回归档时的样子」，避免半新半旧）。理由写在 wallRestore 注释里。

## 交织场景的处理（全部在代码注释中有取舍说明）

1. **多指刮擦中滚出视口**：`sleep()` 把每个进行中笔迹先确认入撤销栈
   （不丢、不等真实 pointerup），随后的 pointerup/cancel 幂等空转；
2. **滚动中 saveAll**：序列化全程同步不 await，IO 回调无法插入，50 张卡
   取到的是同一时刻一致状态；
3. **冷档淘汰与 undo 跨固化边界同帧**：JS 单线程顺序执行，淘汰序列化前
   先冲刷该卡维护（evict 烘永久层 / solid 仅标脏），快照必为落地后状态；
4. **批量恢复中 DPR 变化**：几何以归一化坐标 + alpha 网格存储、与 DPR
   无关；每张卡在实际恢复的那一帧才读尺寸——在线卡用当时 DPR 重建，
   离屏卡只装矢量、wake 时再按最新 DPR 栅格化；
5. **旧编码器冷档**：单卡版本迁移挂在 `registerSnapshotMigration`
   分发表，容器版本挂 `registerWallMigration`；演示路径
   `migrateSingleToWall` 实现 v3 单卡 → wall 容器。

redo 栈在休眠/淘汰/恢复后的语义不变（随矢量/快照完整保留；仅刮新一笔
或 reset 清空）。

## 验收 / 手工验证清单（演示页操作）

准备：`npm run dev`，页面从上到下为「内存总览 → 墙 → 调试面板 →
每卡状态表 → 事件日志 → v3 单卡兼容区」。徽标颜色：绿=active、
蓝=sleeping、紫=archived、红=discarded。

1. **休眠释放与 1 帧恢复**：刮几张卡 → 向下滚动 → 观察徽标变
   `sleeping`（内存总览「休眠」计数上升、离线已用变化）；快速滚回，
   刮痕与进度完整、无空白帧。控制台可配合 `window.__SCRATCH_DEBUG__=true`
   看 wake 重放耗时日志（墙内为小卡，通常亚毫秒）。
2. **休眠后 resize / DPR 无损**：让卡休眠后拖动窗口宽度 / 跨屏改变 DPR，
   再滚回——刮痕按新尺寸正确重放；恢复后连点「撤销」跨固化边界
   （先灌 3000+ 笔形成固化层）仍然逐笔正确。
3. **场景①多指刮擦滚走**：在某卡上按住拖动（多指）不松手直接滚动页面，
   该卡滚出视口后松手，再滚回——进行中笔迹已作为最后一笔保留，可撤销。
4. **强制 LRU 淘汰**：调试面板把「离线预算」滑到 1MB，向若干卡
   「灌入笔迹」后滚动使其休眠，观察状态变 `archived`、事件日志输出
   `cardArchived`、冷池用量上升；把冷池预算也调小（如 1MB）继续淘汰，
   最旧冷档变 `discarded`（日志 `cardDiscarded`）。
5. **冷档滚回恢复**：被淘汰卡滚回视口时徽标先紫后绿，刮痕完整恢复；
   被丢弃卡滚回为全新空卡。
6. **场景②滚动中 saveAll**：点「往返快速滚动」后立刻（或滚动期间多点
   几次）`wall.saveAll()`，再 `wallRestore`，整墙刮痕一致；「解析归档」
   可查看容量/段数/每段字节。
7. **批量恢复 + 场景④ DPR**：`saveAll` 后点 `wallRestore`，恢复动画
   分帧进行（观察徽标分批变绿）；恢复进行中拖动窗口改变宽度，恢复结束
   后滚动检查各卡刮痕与尺寸均正确。
8. **场景⑤旧格式迁移**：在「v3 单卡兼容区」刮几笔，点
   「存下方案例单卡并迁移/恢复」——日志显示 `SC1 → SCWL` 容量 1、
   段类型 `single`（可直接单卡 restore），整墙 #0 恢复为该卡、其余卡槽
   回出厂态。也可用控制台：
   ```js
   const seg = extractCardSnapshot(archive, 0) // 从零拷贝取 #0 段
   singleCardRef.restore(seg) // 墙内单卡段可被 v3 接口单独恢复
   ```
9. **卡数裁剪语义**：`saveAll` 后把「卡片数量」调小/调大再 `wallRestore`：
   多出的段被裁剪（返回值 `truncated`，日志可见），不足的卡槽回空卡。
10. **8MB 上限**：持续大量灌笔使归档逼近上限时，`saveAll` 抛明确错误且
    不产生截断数据（错误显示在调试面板）。
11. **v3 兼容**：页面底部单卡兼容区验证旧 props/事件/`undo/redo/save/
    restore/reset/__debug.seed` 全部照常工作。
