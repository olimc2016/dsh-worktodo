# 行首优先级旗子（priority-flag-leading）

对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（0.2.11，HEAD `f04f35c`）。
本轮只把小改布局落地：优先级旗子从「小字组（meta）」挪回**行首**——勾选框之后、标题之前。
**未升版本、未改 CHANGELOG / `.github/`、未 commit / push / tag / 发布、未碰真实数据**；
`lib/client.js` 与 `.map` 是 `tools/build-client.mjs` 的构建产物，随源码一起重新生成，没有手改。

Node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；测试前 `WORKTODO_NO_UPDATE_CHECK=1`。

---

## 1. 新行结构

同一份 DOM，行内直接子元素顺序固定为：

```
.wt-row
├─ button.wt-check              ← 勾选框（视觉 26px / 命中盒 40×40，未动）
├─ span.wt-flag-slot            ← 新增：行首旗子槽（固定 18px，永远占位）
│  ├─ button.wt-flag-btn        ← 旗子按钮（四档；none = 淡色空心 ghost）
│  └─ PriorityFlagsPopover      ← 仅展开时挂载（高/中/低/无）
├─ div.wt-row-main              ← 标题列（flex:1，单行省略号）
├─ div.wt-meta                  ← 小字组：日期/时间、项目、来源、行内错误
└─ div.wt-actions               ← 铅笔 + 删除（hover/focus 显形，未动）
```

- 旗子**不再**放进 `.wt-meta`；`const meta = []` 起步，只 push 日期、项目、来源与错误。
- 旗子按钮、四旗浮层、`aria-expanded` / `aria-haspopup`、Esc 行为全部沿用原实现；
  点击选中仍走 `POST /worktodo/update`，body 仍是 `{ ref, priority }`，没有新增/修改协议。
- 高优先级行仍有 2px 红色左缘；为了标题左边缘**严格对齐**，该分支的 `paddingLeft` 由 8 收到 6
  （2px 边框 + 6px 内边距 = 其他行的 8px 内边距），内容起点不变。

## 2. 固定槽位与 hover 显隐

- `FLAG_SLOT_PX = 18`：`.wt-flag-slot { flex: 0 0 18px; width: 18px; height: 22px; }`。
  槽内居中放 13px 旗子图标，左右各约 2.5px；按钮自身宽度也改为 18px。
- **有没有优先级都渲染槽**：槽的宽度只由常量驱动，不随 `priority` / hover / 展开变化，
  因此各行标题左边缘严格对齐，hover 不会把标题推开。
- `none`：旗子 `opacity: 0` + `.is-ghost { pointer-events: none }`，但**仍在 DOM 与布局里**；
  行 `onMouseEnter` / `onFocus`（含键盘 Tab 冒泡）把 `flagPeek` 置真，旗子淡到 `opacity: 0.55`
  的淡色空心旗，可点、可展开。没有 `display:none` / `visibility:hidden`。
- `high` / `normal` / `low`：常显彩色旗（红 / 橙 / 蓝灰，沿用 `priorityColor`）。
- 聚焦与鼠标共用同一套组件状态（`flagPeek` / `flagOpen`），与以前的设计一致。

## 3. 小字组

`.wt-meta` 只剩**日期/时间**与**项目**（以及原有的 `source` 来源标记、行内错误文本），
顺序保持现状：日期 → 项目 → 来源。旗子不在其中。

## 4. 换行态（`.wt-row--wrap`）

同一份 DOM 换成四列网格：

```
grid-template-columns: auto auto minmax(0, 1fr) auto;
grid-template-areas: "check flag main actions" ". . meta .";
```

- 第一行：`[勾选框][旗子槽][标题][行尾操作]`；旗子仍与勾选框、标题同在第一行。
- 第二行：小字组落在**标题那一列**（`grid-area: meta`），与标题左对齐，不缩进到勾选框下面。
- `.wt-row--wrap .wt-flag-slot { grid-area: flag }` 显式钉住旗子区；标题仍 `nowrap + ellipsis`。
- 换行判定、120ms 防抖、8px 滞回、ResizeObserver 生命周期均未改。

## 5. 保持不动的部分

完成动效、勾选框视觉/命中区、行内改日期/标题/项目、单行省略号、行尾铅笔/删除 hover 显隐、
三档更新设置、拖拽与滞回换行，全部沿用上一版；本轮只改旗子的 DOM 位置、槽位样式与换行网格列。

## 6. 测试（客户端套件，测试文件仍是 9 个）

`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`：

1. **DOM 顺序**：行布局 B 断言直接子元素为 `[wt-check][wt-flag-slot][wt-row-main][wt-meta][wt-actions]`，
   旗子按钮在槽内、**不在 meta 内**；同时保留标题在 `wt-row-main`、日期/项目在 meta 的断言。
2. **占位与对齐**：新增「行首旗子槽」用例，把 `wt-1` 临时降为 `none`，断言槽仍渲染、
   `data-wt-flag-slot-width === FLAG_SLOT_PX === 18`、样式表 `.wt-flag-slot` 为 `width:18px` +
   `flex:0 0 18px`、无 `display:none`、无内联 `display:none`；hover 前后槽宽一致，
   ghost 从 `opacity:0` 变为 `0<opacity<1`。
3. **交互回归**：既有「选高 / 选无」用例保留并通过——点旗子开浮层，选「高」发
   `POST /worktodo/update {ref:'wt-1',priority:'high'}`，选「无」发 `{...,priority:'none'}`，
   选中后浮层关闭、`aria-expanded=false`。
4. **换行态**：行布局 C 注入 `scrollWidth=240 / clientWidth=120` 后，断言 `grid-template-areas`
   为 `"check flag main actions" ". . meta ."`、旗子槽仍是行的直接子元素、旗子不在 meta 里，
   并断言 `.wt-row--wrap .wt-flag-slot { grid-area: flag }` 与 meta 的 `grid-area: meta`。
5. **反向验证**：见下一节（两处故意破坏都先重新 build，再只看失败结论行）。

客户端用例数：82 → **83 通过 / 0 失败**（本机最终态）。

## 7. 反向验证（破坏 → 必须变红）

| 故意破坏 | 结果 |
| --- | --- |
| 把旗子塞回小字组：`const meta = [priorityNode]`，并从行子节点里删掉槽 | `行布局 B` 红：`第二个是行首旗子槽（勾选之后、标题之前）：期望 1，实际 -1`；`行首旗子槽` 红：`none 行也必须渲染旗子槽…期望 true，实际 false`；`行布局 C` 红：`换行态的旗子槽仍必须是行的直接子元素…期望 true，实际 false`；**80 通过 / 3 失败，EXIT=1** |
| `none` 行的槽加内联 `style:{display:'none'}`（占位消失） | `行首旗子槽` 红：`none 行的槽也不许用 display:none 隐藏…期望 undefined，实际 "none"`；**82 通过 / 1 失败，EXIT=1** |

两次破坏后都已还原源码并重新 `build-client.mjs`；最终工作区没有临时代码，
客户端套件回到 **83 通过 / 0 失败**。

## 8. 两套门禁

- 本机：`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs`
  → **10/10 个步骤通过（含构建），EXIT=0**。
- 干净环境：
  `env -i HOME=/tmp/cihome PATH=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:/usr/bin:/bin CI=true node tools/verify-all.mjs`
  → **10/10 个步骤通过（含构建），EXIT=0**。

两次都显式检查了退出码（`EXIT=0`），不是只看日志里的通过数。

## 9. 未做 / 不确定

- **没有真机逐像素截图**：本机没有可脚本化的 Chromium/Playwright，对齐与 hover 显隐靠
  DOM 顺序、固定槽宽常量、样式表原文与组件状态断言兜底；建议在真实面板里目视一次
  「全部 none」「高/中/低混排」两档，确认 18px 槽的视觉轻重合适。
- 18px 是任务给定的约数：当前实现槽 18px、图标 13px，左右各 2.5px；若真机上觉得旗子偏挤，
  可只调 `FLAG_SLOT_PX` 与 `.wt-flag-btn` 的宽度（测试会跟着常量走）。
- 高优先级 2px 红色左缘与 `paddingLeft: 6px` 的补偿是纯 CSS/内联样式断言，没有像素级截图；
  若后续把左缘改成 `box-shadow` 或伪元素，可去掉这条补偿。
- 浮层仍从 18px 槽的左侧展开（`left:0`），在极窄面板里会盖住标题右侧；
  这是既有弹层定位行为，本轮没有改。
- 按约束未做：不升版本、不改 CHANGELOG / `.github/`、不 commit / push / tag / 发布；
  没有读写 `~/.dsh/storages/worktodo.json` 或 `~/.dsh/worktodo/*`。
