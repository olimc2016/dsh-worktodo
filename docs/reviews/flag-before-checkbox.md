# 优先级旗子挪到勾选框之前（flag-before-checkbox）

对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（0.2.11，HEAD `f04f35c`，工作区带着
前两轮未提交改动）。本轮只做一处布局微调：**优先级旗子从小字组之前、勾选框之后，挪到勾选框之前（整行最左）**。
**未升版本、未改 CHANGELOG / `.github/`、未 commit / push / tag / 发布、未碰真实数据**；
`lib/client.js` 与 `.map` 是 `~/…/dsh-worktodo/tools/build-client.mjs` 的构建产物，随源码重新生成，没有手改。

Node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；测试前 `WORKTODO_NO_UPDATE_CHECK=1`。

---

## 1. 新行顺序

同一份 DOM，行的直接子元素顺序固定为：

```
.wt-row
├─ span.wt-flag-slot        ← 行首旗子槽（固定 18px，永远占位；四档旗子浮层在槽内）
├─ button.wt-check          ← 勾选框（视觉 26px / 命中盒 40×40，未动）
├─ div.wt-row-main          ← 标题列（标题 + 「已过期」/来源胶囊 + 行内标题错误）
├─ div.wt-meta              ← 小字组：日期 96px 槽 + 项目 72px 槽（固定两列）
└─ div.wt-actions           ← 铅笔 + 删除（hover/focus 显形，未动）
```

`priorityNode` 在 `TodoRow` 的子节点数组里被放到 `wt-check` 之前；旗子按钮、四旗浮层、
`aria-expanded` / `aria-haspopup`、Esc 行为全部沿用原实现，点击仍走
`POST /worktodo/update { ref, priority }`，没有新增/修改协议。

## 2. 槽位与视觉节奏

- `.wt-flag-slot { flex: 0 0 18px; width: 18px; height: 22px; }`：**有没有优先级都渲染**，
  宽度只由 `FLAG_SLOT_PX = 18` 驱动，不随 `priority` / hover / 展开变化。
- `none`：旗子 `opacity: 0` + `.is-ghost { pointer-events: none }`，**仍在 DOM 与布局里**；
  行 hover / 行内聚焦时淡到 `opacity: 0.55` 的淡色空心旗（可点、可展开）。没有
  `display:none` / `visibility:hidden`，hover 前后槽宽不变，标题不会被推动。
- **不贴边**：行的左内边距仍是 `padding: 5px 8px` 的 8px，旗子槽是行内第一个内容盒，
  与后面的勾选、标题共享同一个 `gap: 8px`；高优先级行有 2px 红左缘时 `paddingLeft` 收到 6px，
  `2 + 6 = 8`，内容起点与其他行一致。
- 旗子浮层从槽的 `left: 0` 向右展开；槽到了行首以后，浮层不会再盖住标题右侧。

## 3. 换行态（`.wt-row--wrap`）对齐

同一份 DOM 换成四列网格：

```
grid-template-columns: auto auto minmax(0, 1fr) auto;
grid-template-areas: "flag check main actions" ". . meta .";
```

- 第一行：`[旗子槽][勾选框][标题][行尾操作]`。
- 第二行：小字组落进 `meta` 区 —— 它在**第 3 列（标题列）**，前两列 `auto auto` 就是
  「旗子 18px + 勾选 26px」的固定宽度，所以 meta 的起始 x 严格等于标题的起始 x，
  不会缩进到旗子/勾选下面。
- `.wt-row--wrap .wt-meta { grid-area: meta; justify-self: start; }`：**左对齐到标题左边缘**。
  小字组不重定义列宽，沿用 `.wt-meta` 的 `96px 72px` 两列（同一布局内所有行的日期列仍对齐）。
- 换行判定（`decideRowWrap`）、120ms 防抖、8px 滞回、ResizeObserver 生命周期均未改；
  标题仍 `nowrap + ellipsis`，不会把行撑成两三行。
- 已知取舍：`justify-self: start` 让换行行的日期块从标题列左缘开始，而单行态它在标题列右端，
  **跨「单行↔换行」时日期 x 会变**；这是「与标题左对齐」的直接代价（本任务明确要求左对齐）。
  同一布局内（所有单行行 / 所有换行行）日期列仍严格对齐。若改回 `end`，就是另一种取舍：
  日期 x 跨换行不变，但 meta 右对齐、左边缘不再与标题对齐。

## 4. 高优先级红左缘

保留 2px 红色左边缘；`paddingLeft: 6px` 的补偿不变，因此旗子/勾选框不被挤歪、
标题左边缘仍与其他行严格对齐（`2px 边框 + 6px 内边距 = 其他行 8px 内边距`）。

## 5. 保持不动的部分

日期/项目固定列（96px / 72px、空槽也占位）、行内改日期/标题/项目、单行省略号、
完成动效、行尾铅笔/删除 hover 显隐、拖拽重排、换行滞回，全部沿用上一版；测试文件仍是 9 个。

## 6. 测试（客户端套件）

`~/…/dsh-worktodo/tools/smoke-client.mjs`：

1. **行布局 B**：直接子元素顺序断言改为 `[wt-flag-slot][wt-check][wt-row-main][wt-meta][wt-actions]`
   （index 0/1/2/3/4），并额外断言 `flag < check < main`；旗子仍在槽内、不在 `wt-meta` 里。
2. **行首旗子槽**：新增「槽必须是整行第一个直接子元素」「旗子在勾选之前」断言；保留
   `none` 行仍渲染、`data-wt-flag-slot-width === 18`、样式表 `width:18px` + `flex:0 0 18px`、
   无 `display:none`、hover 前后槽宽一致、ghost 从 `opacity:0` 到 `0<opacity<1`；
   另断言行样式保留 `padding: 5px 8px` 与 `gap: 8px`（旗子不贴边、与左内边距同节奏）。
3. **行布局 C（换行）**：断言 `grid-template-columns: auto auto minmax(0, 1fr) auto`、
   `grid-template-areas: "flag check main actions" ". . meta ."`、旗子槽是第一行直接子元素，
   且 `.wt-row--wrap .wt-meta` 为 `grid-area: meta` + `justify-self: start`。
4. **固定列换行用例**：日期/项目槽仍是 96/72px、换行态不另写列宽；对齐断言由 `end` 改为
   `start`（与标题左对齐），并显式断言不许是 `end`。
5. **固定列回归**：三个入口（日期/标题/项目）仍各自提交；旗子槽 index 改为 0、勾选为 1。

客户端最终：**88 通过 / 0 失败**。

## 7. 反向验证（破坏 → 必须变红）

| 故意破坏 | 结果 |
| --- | --- |
| 把 `priorityNode` 放回勾选框之后 | `行布局 B` 红（`第一个直接子元素必须是行首旗子槽…期望 0，实际 1`）、`行首旗子槽` 红、`小字组固定列回归` 红；**85 通过 / 3 失败，EXIT=1** |
| 换行态 `justify-self` 从 `start` 改回 `end` | `行布局 C` 红、`小字组换行态` 红（左对齐断言失败）；**86 通过 / 2 失败，EXIT=1** |

两次破坏后都已还原源码并重新 `build-client.mjs`；最终工作区没有临时代码，
`smoke-client` 回到 **88 通过 / 0 失败**，`cmp` 校验恢复文件与破坏前逐字节一致。

## 8. 两套门禁（均在最终字节上重跑）

| 环境 | 命令 | 结果 |
|---|---|---|
| 本机 | `WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` | **10/10，EXIT=0** |
| 干净环境 | `env -i HOME=/tmp/cihome PATH=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:/usr/bin:/bin CI=true node tools/verify-all.mjs` | **10/10，EXIT=0** |

两次都显式检查了退出码（`EXIT=0`），不是只看日志里的通过数。

## 9. 上一位的改动现状（含一处并发冲突说明）

日期/项目固定列那套改动**完整在位**（96px/72px 两列、空槽占位、状态/来源胶囊挪到标题列右端、
高优先级 2px 红缘补偿都在）。写这一轮时，那位 agent 仍在并发改同一个文件，并且在 13:37 也写过
`docs/reviews/flag-before-checkbox.md`（结论是 `justify-self:end`）。本报告与最终代码按本任务书
（两处都要求「小字组与标题左对齐」）采用 `start`；它是唯一被我覆盖的点，其余它的实现与测试原样保留。
若产品口径改成「日期 x 跨换行不变」，只需把这一行改回 `end`、同步 §6.3/§6.4 的断言即可（反向验证会立刻提醒）。

## 10. 未做 / 不确定

- **没有真机逐像素截图**：本机没有可脚本化的 Chromium/Playwright；对齐靠 DOM 顺序、
  固定槽宽/列宽常量、样式表原文与 grid 区域断言兜底。建议在真实面板里目视一次
  「全部 none」「高/中/低混排」「长标题换行」三档。
- 「换行态 meta 左对齐」与「日期 x 跨换行不变」不可兼得（见 §3），当前按任务书选左对齐。
- 行首旗子与勾选框之间沿用统一 `gap: 8px`；若真机觉得旗子离勾选框偏远，可只调 `.wt-row` 的
  gap 或给槽加负 margin，测试会跟着 DOM/样式断言走。
- 按约束未做：不升版本、不改 CHANGELOG / `.github/`、不 commit / push / tag / 发布；
  没有读写 `~/.dsh/storages/worktodo.json` 或 `~/.dsh/worktodo/*`。
- `docs/reviews/priority-flag-leading.md`、`docs/reviews/fixed-meta-columns.md` 是工作区里既有的
  未跟踪历史报告，本轮未改动。
