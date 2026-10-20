# 小字组固定列：日期 / 项目不再跟着标题跑（fixed-meta-columns）

对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（0.2.11，HEAD `f04f35c`，工作区有未提交改动）。
本轮只改 `src/client/index.js` 与 `tools/smoke-client.mjs`（测试文件仍是 9 个），外加这份报告。
**未升版本、未改 CHANGELOG / `.github/`、未 commit / push / tag / 发布、未碰真实数据。**
`lib/client.js` 与 `.map` 是 `tools/build-client.mjs` 的构建产物（随源码一起重新生成，没有手改）。

Node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；测试前 `WORKTODO_NO_UPDATE_CHECK=1`。

---

## 0. 先核对上一轮「旗子回行首」（收尾）

进工作区时改动已在、且**在我动任何代码之前跑过一次全量门禁：10/10 EXIT=0**，所以按「绿就保留」处理，没有回退：

- 行内直接子元素顺序：`[勾选][旗子槽][标题列][小字组][行尾操作]`；旗子槽在勾选框之后、标题之前。
- 槽位 `.wt-flag-slot` 固定 `flex: 0 0 18px` + `width: 18px`，**有没有优先级都占位**；
  ghost 旗子只改 `opacity`（平时 0，hover/focus 淡出），没有 `display:none`，也没有退回小字组。
- 高优先级行的红色左缘把 `paddingLeft` 收到 6（2px 边框 + 6 = 8），标题左边缘仍与普通行对齐。
- 本轮新增的用例继续钉住「旗子槽在第 1 位、标题列第 2 位、不在小字组里」。

> 上一轮的评审记录 `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/docs/reviews/priority-flag-leading.md`
> 是并行产生的文件，本轮**未改动**。

## 1. 列宽方案：`.wt-meta` 改成两列固定网格

```
.wt-meta { display:grid; grid-template-columns: 96px 72px; column-gap:6px; flex:none; }
├─ .wt-meta-date     ← 96px，justify-content:flex-end（内容右对齐）
└─ .wt-meta-project  ← 72px，nowrap + text-overflow:ellipsis
```

- **日期槽 96px**（`META_DATE_SLOT_PX`）：内容是日期 + 可选时间，右对齐 →
  所有行日期文本的**右边缘**落在同一条竖线上。96px 的来历：11px 字号下
  `2026-10-20 14:30` ≈ 87–93px，日期按钮左右 padding 收到 2px 后放得下；
  真放不下时由按钮自己的 `overflow:hidden + ellipsis` 收尾，完整值在 `title` 里。
- **项目槽 72px**（`META_PROJECT_SLOT_PX`）：`.wt-project-btn` 改成 `display:block`
  （`text-overflow` 只对块级/行内块生效）+ `nowrap` + 省略号；`title` 里带完整项目名。
- **标题列不动**：`.wt-row-main { flex:1 1 auto; min-width:0 }`、`.wt-title`
  仍是 `nowrap + ellipsis`；换行判定/滞回逻辑一行没改。
- **没有** `margin-left:auto`（测试里显式断言样式表不含它），日期也不再是自由排布的 flex 项。

## 2. 占位：两只槽恒渲染，空槽也占满列宽

- `dateSlot` / `projectSlot` 是**无条件渲染**的 `<div>`，各自带
  `data-wt-meta-date-slot` / `data-wt-meta-project-slot` 与宽度 data 属性（值和常量同一来源）。
- 无日期的行：日期槽在、里面**平时是空的**；「＋ 日期」入口仍是 hover/focus 才出现
  （旧行为保留），入口出现前后槽宽不变。
- 无项目的行：项目槽同样恒占位；「＋ 项目」入口也是 hover/focus 才出现。
- 行内错误（`.wt-date-error` / `.wt-project-error`）`grid-column: 1 / -1` 另起一行，
  不会把日期/项目两列挤歪。

## 3. 「已过期」与「来源」不再挤动日期列

旧结构里这两样都在小字组：

- `已过期 ` 是日期文案的前缀，`已过期 2026-10-20 14:30` ≈ 126px，固定 96px 根本放不下；
- 来源胶囊（`AI` / `会话`）排在项目之后，有来源的行会把**整只小字组往左推** 30–36px，日期跟着左移。

现在两样都挪到**标题列右端**（`.wt-row-main` 内、标题之后）：

```
.wt-row-main { display:flex; flex-wrap:wrap; gap:6px; }
├─ .wt-title（flex:1 1 0, min-width:0，可省略）
├─ .wt-tag.wt-overdue-tag（已过期，warn 色 + 文字都保留）    ← data-wt-overdue-chip
├─ .wt-tag（来源：AI / 会话，仅 agent/session 行）           ← data-wt-source-chip
└─ .wt-title-error（flex-basis:100%，仍单独一行）
```

- 胶囊贴在标题列的右端，x 坐标固定，**不参与小字组的 96/72 两列**；
  它们占的宽度和旧实现占小字组的宽度基本相当，所以整体宽度成本没有增加。
- 日期按钮仍用 warn 色表示已过期；完整日期/时间在 `title` 里，96px 槽内只放日期（+时间）。
- 术语没有回退：胶囊文案仍是「已过期」。

## 4. 换行态：复用同一套列定义，日期不换 x

- `.wt-row--wrap` 仍是 `[勾选][旗子][标题列][行尾操作] / 第二行 meta 落在标题列`；
  小字组**不重定义 `grid-template-columns`**（测试断言 wrap 规则里没有这一项），
  直接复用 `.wt-meta` 的 `96px 72px`。
- `.wt-row--wrap .wt-meta` 用 `justify-self: end`：meta 右边缘与单行态完全重合
  （两者都等于「标题列右边缘」），所以**同一行的日期不会因为换行而左移 ~100px** ——
  这正是「日期固定列」要的效果。
- 代价（刻意接受）：第二行小字靠右，左边留白；上一轮「第二行与标题左对齐」这个细节被替换。
  若坚持左对齐，标题一跨过换行阈值日期就会跳一个 x，等于把这次修的毛病换个地方复发。
- 滞回判定没改：`metaWidth` 现在恒为 174（96 + 6 + 72）；换行后标题变宽仍按原有
  `predictedSingle = available − (metaWidth + gap)` 决定何时收回。

## 5. 测试（客户端套件 83 → 88 通过）

新增/更新的用例（都在 `tools/smoke-client.mjs`，测试文件数不变）：

1. **固定列**：临时插入一条「超长标题 + 有日期/项目/来源」的行，与短标题行并排 →
   两行日期槽宽度相同、都等于 `META_DATE_SLOT_PX`；`.wt-meta` 是 `display:grid`，
   列定义 `96px 72px`；日期槽是网格第 1 个头节点、项目槽第 2 个；
   有 `offsetLeft` 的真实 DOM 还会断言两行日期槽 `offsetLeft` 相等（测试替身没有几何信息则跳过）。
2. **占位**：把 wt-1 临时改成「无日期、无项目」，再放一条有内容的对照行 →
   两只槽都存在且同宽；空槽里默认没有「＋日期/＋项目」按钮；hover 后按钮出现、槽宽不变。
3. **换行态**：用假 `ResizeObserver` + 注入 `scrollWidth > clientWidth` 真把行切到
   `.wt-row--wrap` → 日期槽仍是网格第 1 列、槽宽与换行前一致；wrap 规则不写列宽，只 `grid-area` + `justify-self:end`。
4. **回归**：旗子槽仍在第 1 位（勾选之后、标题之前）；点日期 / 点标题 / 点项目标签
   仍然分别发出 `{ref,due}` / `{ref,title}` / `{ref,project}`。
5. **补充**：已过期行渲染 `data-wt-overdue-chip` 胶囊（在标题列、不在小字组），
   日期槽里不再有「已过期」前缀、日期仍在、warn 色仍在；有来源的行来源胶囊在标题列、
   不在小字组，且日期槽宽度不变。

旧用例的措辞同步更新：以前写的「无日期/无项目时平时不占位」改成「空槽占位、入口 hover 才出现」
（断言本身仍然成立：默认不渲染入口按钮）。

## 6. 反向验证（真实跑过，不是口头声明）

| 故意改坏 | 结果 | 恢复后 |
|---|---|---|
| `.wt-meta` 第一列改 `auto` + `.wt-meta-date { width:auto; flex:1 1 auto }` | 用例 1 红（`auto 72px` ≠ `96px 72px`）+ 用例 3 红；`node tools/smoke-client.mjs` EXIT=1 | 88/88 通过 |
| 无日期时**不渲染**日期槽（`dateSlot` 条件化） | 用例 2 红（「无日期的行也必须渲染日期槽」）；EXIT=1 | 88/88 通过 |

## 7. 门禁

- 本机：`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` → **10/10 个步骤通过（含构建），EXIT=0**
- 干净环境：`env -i HOME=/tmp/cihome PATH=<node 目录>:/usr/bin:/bin CI=true node tools/verify-all.mjs`
  → **10/10 个步骤通过（含构建），EXIT=0**
- 客户端套件单独跑：**88 通过，0 失败**。

## 8. 未做 / 不确定

- 没有在真实浏览器里目测（没有可用的截图环境）：列宽是按 11px 字号下
  `2026-10-20 14:30 ≈ 87–93px` 估的。若宿主换成更宽的数字字体，日期+时间可能被省略号截断
  （有 `title` 兜底）；届时把 `META_DATE_SLOT_PX` 调到 104 即可，列定义只有一处。
- 占位的代价：小字组现在恒定 174px，**空行也一样**，所以窄面板会更早触发换行
  （设计稿里的 320px 档，空行标题宽度本来就不多）。这是「无日期也占位」的必然成本。
- 面板宽度 < ~300px 时，换行态第二行的 meta（174px）可能从左侧溢出；设计稿最小档是 320px，暂按可接受处理。
- 换行态第二行改成右对齐（`justify-self:end`），与上一轮的「第二行与标题左对齐」不同；
  「已过期」也从日期文案里挪成标题列右端的胶囊 —— 这两处是有意的视觉调整，理由见 §3、§4。
- 没有动版本号 / CHANGELOG / `.github/`，没有 commit/push/tag/发布；`lib/client.js` + `.map`
  与源码一起留在工作区，待下一次提交一并带上。
