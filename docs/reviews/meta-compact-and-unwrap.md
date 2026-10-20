# 小字组紧凑 chip + 双向换行（meta-compact-and-unwrap）

对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（0.2.13，HEAD `9efad76`，进工作区时干净）。
本轮只改 `src/client/index.js` 与 `tools/smoke-client.mjs`（测试文件仍是 **9 个**），外加这份报告；
`lib/client.js` + `.map` 是 `tools/build-client.mjs` 的构建产物，随源码一起重新生成，没有手改。
**未升版本、未改 CHANGELOG / `.github/`、未 commit / push / tag / 发布、未碰真实数据。**

Node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；测试前 `WORKTODO_NO_UPDATE_CHECK=1`。

---

## 0. 改动前基线与两个问题的根因

改动前 `node tools/smoke-client.mjs` 是 **88 通过 / 0 失败**，但用户看到的两件事都是真的 ——
旧测试对第二个问题的模拟不真实（见 §2.1），所以没有抓住。

### 问题 1：三项隔着大片留白

`.wt-meta` 是 `grid-template-columns: 96px 44px 44px 96px` 的四列固定网格，四只槽**无条件渲染**。
内容只有「AI」（2 字）或项目名（3 字）时，槽里剩下的几十像素就是空白；三样东西看起来被
96/44/44/96 的空槽隔开了。

### 问题 2：收窄换行后放宽不回来 —— 两个叠加的根因

1. **换行态把「被撑满的 scrollWidth」当成了标题固有宽度。**
   标题没被截断时，块级标题的 `scrollWidth` 等于它的 `clientWidth`（被变宽的标题列撑满），
   而不是文字内容宽。旧实现 `Math.max(requiredTitleWidth, intrinsic)` 会把这个大值当固有宽度：
   于是「单行预测宽度」永远小于「需要的宽度」，条件恒为「继续换行」，怎么放宽都解不开。
2. **滞回加在了错误的一侧。**
   旧解除条件是 ` predictedSingle >= intrinsic + 8`：标题明明已经放得下，只要余量小于 8px
   就永远不解除。用户把面板放宽回原来的宽度时，只要那条标题当初是「刚好放下」，就会卡在换行态。

旧测试用 `title.props.ref({ scrollWidth: 240, clientWidth: 300 })` 注入几何 —— 真 DOM 里
`clientWidth = 300` 且没截断时 `scrollWidth` 必然是 **300**，不是 240。测试替身比真实浏览器「更理想」，
所以旧代码一直是绿的。

---

## 1. 紧凑方案：按内容定宽的 chip 组，有内容才占位

```
.wt-meta（flex，gap:6px，margin-left:auto，justify-content:flex-end）
├─ 日期/时间 chip   .wt-meta-date    ← 日期 + 时间整体 nowrap，宽度按内容
├─ 来源 chip        .wt-meta-source  ← AI / 会话，没有来源就整颗不渲染
├─ 已过期 chip      .wt-meta-overdue ← 未过期就整颗不渲染
└─ 项目 chip        .wt-meta-project ← max-width:96px（≈8 汉字）+ ellipsis + title 全名
```

- **有内容才占位**：四颗 chip 都是条件 push；没有来源 / 未过期 / 没有项目时，
  对应 chip 与占位一起消失（测试断言：无内容行的小字组直接是 0 个子节点）。
- **只隔一个 gap**：`.wt-meta { gap: 6px }`（`META_CHIP_GAP_PX`），chip 上没有任何额外
  margin / padding 堆叠；样式表里没有固定空槽，也没有 `grid-template-columns`。
- **整组右对齐**：标题列 `flex:1` 吃掉剩余宽度 + `.wt-meta { margin-left:auto }` 双保险；
  换行态沿用 `.wt-row--wrap .wt-meta { justify-self:end }`。标题长短变化时整组右边缘固定。
- **顺序不变**：`META_CHIP_ORDER = ['date','source','overdue','project']`，DOM 顺序 = 视觉顺序。
- **项目名**：`META_PROJECT_MAX_PX = 96`（`max-width` 语义，不是固定槽宽）；按钮
  `overflow:hidden + nowrap + text-overflow:ellipsis`，完整名字在 `title` 里。
- **日期/来源/已过期**：各自 `nowrap`；日期 chip 不再有 96px 宽度，也去掉了 `text-align:right`
  （整组已右对齐，chip 内部按内容左起即可）。
- **删除的常量**：`META_DATE_SLOT_PX` / `META_SOURCE_SLOT_PX` / `META_OVERDUE_SLOT_PX` /
  `META_PROJECT_SLOT_PX` / `META_SLOT_GAP_PX` / `META_SLOT_ORDER` / `META_SLOT_TOTAL_PX`。
  新常量为 `META_CHIP_GAP_PX` / `META_CHIP_ORDER` / `META_PROJECT_MAX_PX`；
  测试显式断言旧常量已经是 `undefined`，防止有人把固定空槽加回来。
- 行内错误（`.wt-date-error` / `.wt-project-error`）改为 `flex:0 0 100%`，仍各自单独一行。

## 2. 双向换行与死区

### 2.1 判定规则（`decideRowWrap`）

| 状态 | 条件 | 结果 |
|---|---|---|
| 单行 | `intrinsic > available + 8` | 换行 |
| 单行 | 只截断 ≤8px | 保持单行（单行侧死区） |
| 换行 | `available − (metaWidth + 8) < intrinsic + 1` | 保持换行 |
| 换行 | 单行预测宽度 ≥ `intrinsic + 1` | **解除换行** |

- 换行点是单行可用宽 `intrinsic − 8`，解除点是 `intrinsic + 1` → **死区 9–10px**（落在要求的 8–12px 内）。
- 关键差别：解除阈值是「**真的放得下**」，不是「比换行点再宽 8px」。后者在标题当初只余 0–7px
  时永远解不开；现在只要放宽到放得下就一定解除。
- 代价（刻意接受）：标题被省略号截断 ≤8px 时先留在单行，不换行。这是要拿到 8px 死区的数学必然。

### 2.2 换行态的真实固有宽度

- 换行那一刻把 `intrinsic = 标题 scrollWidth` 记进 `requiredTitleWidthRef`；
- 换行态的固有宽度**优先用这个记录值**；只有「换行态下标题仍被截断」时，
  `scrollWidth` 才是真实内容宽，可以更新记录值；
- 标题文字变了（编辑提交 / 服务端刷新）且当前是换行态：先回单行、清空记录，再重新测量
  （否则会拿旧标题的宽度判断新标题）。
- `scheduleMeasure` 到点后重新读 `titleElRef.current`，不再用调用时捕获的元素：
  button ↔ input 换元素时，捕获旧元素会量到已卸载的几何。
- 换行 ↔ 单行切换后（`[rowWrap]` layout effect）再防抖测量一次，确认「解除后不会又省略 → 再换行」。

### 2.3 ResizeObserver

观察行元素 + 标题元素（`attachRowEl` 里 `observe(el)` 与 `observe(titleElRef.current)`），
行宽变化（面板拖动 / 窗口缩放）会触发防抖测量；测试断言 `observed.includes(rowEl)`。
标题文字变化由 `useLayoutEffect` 补触发。

## 3. 测试（89 通过 / 0 失败；测试文件仍是 9 个）

客户端套件新增 / 重写：

1. **紧凑（用例 1）**：插入「三项都有 / 只有日期 / 只有项目 / 8 汉字项目名」四行 →
   - 断言 chip 顺序为 `[date, source, project]` / `[date]` / `[project]`；无来源 / 未过期 /
     无项目时**对应 chip 不存在**（不是空槽）；
   - 小字组的直接子节点全部有 `data-wt-meta-chip`、全部有文案（0 个空壳节点）；
   - `.wt-meta` 是 `display:flex`、`gap:6px`、`margin-left:auto`、没有 `grid-template-columns`；
   - 旧的四个槽宽常量与整组恒宽常量必须 `undefined`；
   - 日期 chip 没有 `width:96px`、没有固定宽度 data 属性；日期/来源/已过期 `nowrap`；
   - 项目 chip 只有 `max-width:96px`（没有 `width:96px`）+ ellipsis + 单行；
     8 汉字项目名仍渲染、`title` 带完整名字；
   - chip 没有额外 margin，日期/项目 chip 规则里没有额外 padding。
2. **双向换行（用例 2）**：注入**符合真 DOM 语义**的几何
  （`scrollWidth = max(内容宽, clientWidth)`）：
   - 窄（内容 240 / 列宽 120）→ 加 `.wt-row--wrap`；
   - 稍宽（内容 240 / 列宽 300，此时 scrollWidth = 300）→ 仍换行；
   - 刚好放得下（列宽 349 → 预测 241 = 240+1）→ **必须解除**；旧实现会卡死在这里；
   - 再等一个防抖窗口仍单行（解除后不抖回换行）；
   - 再收窄 → 再次换行（双向，不是单向锁死）；
   - 卸载时 `disconnect`。
3. **死区（纯函数）**：单行侧 231 换行 / 232–240 不换；换行态预测 232–240 不解除 / 241 解除；
   常量 8px、解除余量 1px、防抖窗口 ≥80ms。
4. **标题编辑变短**：先换行 → 原地改成短标题并 Enter → 立刻回到单行，注入新几何后重量仍是单行，
   且仍发 `{ref,title}`。
5. **占位语义**：无日期/无项目/无来源的行默认 **0 颗 chip**；hover 才出现「＋日期」「＋项目」
   两颗入口 chip，移开又收回。
6. **已过期**：独立 chip，顺序严格为 `[date, source, overdue, project]`；日期 chip 里不再有
   「已过期」前缀，warn 色保留。
7. **换行态复用**：换行前后 chip 种类/顺序/gap 不变；`.wt-row--wrap .wt-meta` 不写列宽、不写 gap，
   只 `grid-area:meta` + `justify-self:end`。

## 4. 反向验证（真实跑过）

| 故意改坏 | 结果 | 恢复后 |
|---|---|---|
| `.wt-meta` 改回 `display:grid; grid-template-columns:96px 44px 44px 96px`，并给日期/项目 chip 加 `width:96px` | 用例 1 红（「小字组必须是按内容排布的 flex」）；`smoke-client` EXIT=1 | 89/89 绿 |
| `decideRowWrap` 换行态直接 `return true`（去掉解除逻辑） | 用例 2 红（「放宽到放得下后必须解除换行」）、纯函数死区用例红；EXIT=1 | 89/89 绿 |
| 额外一组：换行态改回 `Math.max(required, scrollWidth)` 旧口径 | 用例 2 红（复现「被撑满的 scrollWidth 导致永不解除」）；EXIT=1 | 89/89 绿 |

## 5. 两套门禁（均显式检查退出码）

- 本机：`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` → **10/10 个步骤通过（含构建），EXIT=0**
- 干净环境：`env -i HOME=/tmp/cihome PATH=<node 目录>:/usr/bin:/bin CI=true node tools/verify-all.mjs`
  → **10/10 个步骤通过（含构建），EXIT=0**
- 客户端套件单独跑：**89 通过，0 失败**（改前 88）。

## 6. 未做 / 不确定

- **没有在真实浏览器里目测**（本环境没有截图/真机）。紧凑效果按 CSS 与 DOM 断言验证；
  11px 字号下的视觉留白、日期+时间整体宽度没有再拿真实字体量一遍。
- 单行侧 8px 死区的代价：标题被省略号截断 ≤8px 时**不会换行**（只显示省略号）。
  这是为了「阈值附近不抖 + 放宽一定解除」刻意换来的；若更在意「一截断就换行」，
  必须接受滞回只能放在解除侧，而那样又会回到「刚放得下却解不开」的老问题。
- 没有日期 / 项目的行在 hover 时会出现「＋日期」「＋项目」chip，小字组宽度会临时变大；
  在极窄面板上这可能让标题当场换行（hover 引起一次 reflow）。旧固定槽没有这个问题，
  是新规格「没有内容就不占位」的直接代价，暂按可接受处理。
- 标题在**外部**（服务端刷新）变短且当前是换行态时，会先回单行再重量；最坏有一个防抖窗口
  （120ms）的「单行省略」中间态。本地编辑标题不受影响（`commitTitle` 本来就会先回单行）。
- 没有动版本号 / CHANGELOG / `.github/`，没有 commit/push/tag/发布；
  `lib/client.js` + `.map` 与源码一起留在工作区，待下一次提交一并带上。
