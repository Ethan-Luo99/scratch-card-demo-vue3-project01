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

在 v3 单卡能力**零接口改动**（props/事件/暴露方法语义全部保留，仅新增）
之上，新增「多卡运营墙」：纵向滚动网格最多陈列 50 张卡，长时间挂机下
控制总内存与滚动流畅度，无任何额外运行时依赖。

## 运行

```bash
npm run dev   # 打开后默认就是「多卡墙」页；顶部可切回「v3 单卡」原演示
```

## 新增文件与改动

- `src/components/ScratchCardWall.vue`：墙组件（视口感知、LRU、冷池、saveAll/restore）
- `src/wallCodec.js`：`SCW` 墙容器二进制格式 + v3 单卡→墙迁移 + 单卡段提取
- `src/scratchCodec.js`：单卡格式 v1→v2（仅放开 `solidPresent=1`，布局字节
  完全相同），解码器同时接受 v1/v2；无 solid 时仍写 v1（v3 旧解码器可读）
- `src/components/ScratchCard.vue`：仅**新增** `sleep()/wake()/adoptOffline()`
  等休眠能力与 `startSleeping` prop；v3 接口不变
- `src/components/SingleCardDemo.vue`：原 App.vue 的 v3 单卡演示（内容不变）

## 墙组件 API

- props：`cards`（卡槽数组，经 `#default="{ card, index, state }"` 作用域
  插槽传奖品内容）、`maxCards`（默认 50）、`wallMemoryBudget`（默认 16MB）、
  `coldMemoryBudget`（默认 8MB）、`cardProps`（透传给每张卡的 v3 props）、
  `rootMargin`（视口预唤醒提前量 px，默认 200）
- 事件：`progress`/`finish`（载荷 `{index, value}` / `{index}`）、
  `onCardArchived`→`card-archived` `{index, bytes, lastUsedAt}`、
  `onCardDiscarded`→`card-discarded` `{index, reason, bytes}`、
  `card-state-change` `{index, state}`
- 暴露：`saveAll()`、`restore(archive)`（别名 `restoreAll`）、
  `getCard(index)`、`getCardSnapshot(archive, index)`、`stats`、`cardStates`
- 调试：`__seedCard(index, n)`、`__fastScroll(down?)`、
  `__forceEvict(index?)`、`__enforceBudgets()`、`__stats()`

## 休眠/恢复语义（ScratchCard 新增）

- 滚出视口 → `sleep()`：进行中多指笔迹**就地确认**进撤销栈（刮了就算数，
  不丢笔、不等抬起），生成含两张固化网格的完整快照（v2 段），随后主
  canvas 与两张离屏 mask 的 backing store 全部置 0 尺寸（显存立即释放），
  slots/redo 等 JS 状态清空；DOM/插槽/监听保留
- 滚回视口 → `wake()`：一次同步 `rebuildCanvas(true)`，**1 帧内**恢复完整
  刮痕与进度；solid 加速网格让唤醒退化为位图 drawImage（数千笔也不重栅格化），
  唤醒后首次 undo/redo 跨固化边界才触发矢量精确重建（逐像素等价）
- redo 栈、完成态、阈值/换肤全部随快照带回；DPR/尺寸按唤醒当时的环境取最新值

## 内存预算公式（明确口径，代码注释同文）

```
sleepBudgetBytes = Σ sleeping 卡 sleepBytes.byteLength     （空白卡 = 0）
                 必须 <= wallMemoryBudget（默认 16MB）
coldBudgetBytes  = Σ coldPool 冷档 Uint8Array.byteLength
                 必须 <= coldMemoryBudget（默认 8MB）
```

- 休眠字节**含两张固化位图网格**（solid 加速 + frozen 永久层），按序列化
  后真实字节数记账；活跃卡显存不计入离线预算（面板单独显示 `activeBytes`）
- 超 wallMemoryBudget：在 sleeping 卡中按 `lastUsedAt` 最旧（并列取小索引，
  确定性）LRU 淘汰进冷池，冷段直接复用 `save()` 产物（最紧凑可序列化形式）
- 冷池超 coldMemoryBudget：按入池顺序（天然最旧）丢弃，置 `discarded`
- `lastUsedAt` 只在显式交互（刮擦/undo/redo/seed…）时刷新，**单纯滚回视口
  不算交互**，否则快速来回滚动会让没被玩过的卡永远最新、LRU 失效
- 空白休眠卡 0 字节、不参与预算淘汰（只可能被「立即淘汰」手动丢弃）

## 墙归档格式（`SCW`，单归档 ≤ 8MB，超限抛错）

```
magic 'S''C''W' | u8 version | u32 totalLen | u16 cardCount
u32 jsonLen | 配置 JSON（maxCards/预算/卡数/时间戳）
每卡：u8 state(0=活/休眠 1=冷档 2=丢弃) | state≠2 时 u32 segLen | 单卡 'SC1' 段
      （state=0 且 segLen=0 = 从未刮过的空白活卡）
```

- **段即单卡快照**：`getCardSnapshot(archive, i)`（零拷贝 subarray）取出后
  可直接 `ScratchCard.restore()`；墙段与单卡完全互认
- **v3 单卡 → 墙**：`restore(v3单卡Uint8Array)` 自动经
  `migrateV3CardToWall()` 纯包封成 1 卡墙（不解码不重编码，段字节逐字节保留）
- **旧编码器冷段**：v1（v3）与 v2 段同一字节布局，解码器同时接受，
  冷档激活走同一 restore 路径，即版本迁移路径
- 卡数 vs `maxCards`：`count <= maxCards` 正常恢复（多出当前 cards 的槽位
  建内部记录+占位，等调用方补数据）；`count > maxCards` **直接抛错**——
  静默裁剪是不可察觉的数据丢失，扩容又违反容量契约，要求先调大 maxCards

## 验收/手工验证指引（对照需求逐项）

1. **休眠释放显存、1 帧恢复**：切 50 卡，刮/灌 #0 几笔 → 「滚到底」。
   顶部统计「活跃显存」下降、「休眠离线」上涨；「每卡状态」网格对应卡变
   「休眠」。滚回后刮痕原样、undo/redo 可用。控制台
   `window.__SCRATCH_DEBUG__=true` 可看重放耗时
2. **交织①多指刮擦中滚出**：真实触屏/鼠标按住画一半不松，另一手滚动
   （演示页可直接快速甩滚），卡滚出时进行中笔迹被确认保留，滚回后可逐笔 undo
3. **交织②滚动中 saveAll**：快速滚动途中点「saveAll」不报错，归档可 restore
4. **交织③冷池淘汰与跨固化 undo 同帧**：休眠预算调到 0.1MB、冷池 0.05MB，
   给某卡灌 3000 笔（触发固化），滚动淘汰的同时对在屏卡连点撤销——互不影响
5. **交织④恢复中 DPR 变化**：把浏览器窗口从普通屏拖到高清屏（或 DevTools
   切 DPR）后再 restore；唤醒卡 backing 按新 DPR 重建（代码路径：唤醒读
   实时 devicePixelRatio + 各卡 resolution 监听补迁移）
6. **交织⑤旧版本编码器冷段**：v3 保存的 v1 快照可直接「到单卡页恢复」，
   也可被墙 restore；冷档激活同路径（演示页提取卡段按钮可验）
7. **批量兼容**：墙 saveAll → 「提取 #0」→ 切「v3 单卡」页恢复；
   v3 单卡存档 `wall.restore(bytes)` 变 1 卡墙
8. **预算/LRU**：调小「休眠预算」点「执行预算检查」，事件日志按最旧顺序
   报「进入冷存档」；调小「冷池预算」，超出按入池顺序「冷档被丢弃」
9. **调试辅助**：卡片数量切换（1/6/12/30/50）、向指定卡灌入大量笔迹、
   模拟快速滚动（滚到底/回顶）、强制内存淘汰（指定 # 或自动 LRU）、
   每卡状态+内存量级网格、三级内存统计条、淘汰事件日志
