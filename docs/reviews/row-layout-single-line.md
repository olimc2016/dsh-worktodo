# 待办行布局：单行 + 窄屏/长标题自适应换行（row-layout-single-line）

对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（0.2.10，HEAD `e95c2c1`）。
按已批准方案 **B + C** 改行布局：宽屏永远单行，标题会被省略号截断时整行切成两行，小字组落到第二行。
本轮只改代码与测试：**未升版本、未改 CHANGELOG / `.github/`、未 commit / push / tag / 发布、未碰真实数据**。
`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/docs/design/row-layout.html` 工作区里原有的未提交改动（批准预览页）未动。

Node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；测试前 `WORKTODO_NO_UPDATE_CHECK=1`。

---

## 1. DOM 与 CSS 结构

同一份 DOM，靠行上的类切换两种形态（没有第二套渲染分支）：

```
.wt-row (.wt-row--single | .wt-row--wrap)
├─ button.wt-check
├─ div.wt-row-main           ← 标题列；min-width:0，唯一可伸缩的格子
│  ├─ button.wt-title / input.wt-title
│  └─ span.wt-title-error（仅错误时）
├─ div.wt-meta               ← 小字组：旗子 / 日期 / 项目 / 来源 / 行内错误
└─ div.wt-actions            ← 铅笔（整单编辑）+ 删除
```

- **B（默认单行）**：`.wt-row { display:flex; align-items:center; gap:8px; padding:5px 8px; min-height:44px }`。
  标题 `.wt-row-main { flex:1 1 auto; min-width:0 }`；`.wt-title` 永远是
  `display:block; width:100%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis`。
  小字组 `.wt-meta { flex:none }`、操作组 `.wt-actions { flex:none }`。勾选框不再用负 margin 顶对齐，
  由 `align-items:center` 垂直居中。
- **C（换行态）**：`.wt-row--wrap` 改成 grid：
  `grid-template-columns: auto minmax(0,1fr) auto;`
  `grid-template-areas: "check main actions" ". meta .";`
  `align-items:center; column-gap:8px; row-gap:3px`。
  小字组显式 `grid-area:meta`，因此**第二行从标题那一列的起点开始**，与标题左对齐、不缩进到勾选框下；
  勾选框只在第一行（标题行）自己的 `check` 区里垂直居中。
  换行态标题仍是 `nowrap + ellipsis`，不会被撑成两三行高。
- 行高：`.wt-row` 的 `min-height:44px` 不变；换行态因为多一行小字自然更高（`padding-top/bottom` 收到 6px）。
  B1 的命中盒护栏用样式表原文重新算过：44px 行 / 26px 视觉盒 / 40×40 命中盒 / 相邻行间隙 4px、重叠 0px。

## 2. 换行怎么判定、怎么防抖、怎么滞回

判定的是**标题是否会被截断**，不是面板宽度阈值：

```
intrinsic = title.scrollWidth      // 标题固有宽度
available = title.clientWidth      // 当前标题列宽
单行态：intrinsic > available + ROW_WRAP_SLACK_PX(1)  → 换行
```

- 测量点：`titleElRef`（标题 button/input）上的 callback ref + `ResizeObserver`。
  ResizeObserver 挂在**行**（≈ 面板内容宽）和标题元素上：面板拖动、窗口缩放、行尾操作显隐导致标题列变宽/变窄，
  都会触发重量。观察器和定时器都在 ref 置 null / 卸载时断开、清掉。
- 防抖：所有 resize 触发的测量先过 `ROW_WRAP_DEBOUNCE_MS = 120` 的 `setTimeout`，停手后才读布局；
  标题元素挂载（含 button ↔ input 切换）和标题文字变化时立即测一次，避免首帧闪一下。
- 滞回：换行后标题列变宽，直接用「现在没被截断」去解除会立刻来回抖。换行态改为预测单行：
  `predictedSingle = available − metaWidth − ROW_GAP_PX(8)`，
  只有 `predictedSingle ≥ intrinsic + ROW_WRAP_HYSTERESIS_PX(8)` 才解除。
  `metaWidth` 读的是小字组的 `scrollWidth`。也就是说：**一旦换行，必须等单行真的放得下、还多出 8px** 才收回；
  只是「标题暂时不省略了」不够。判定逻辑抽成导出的纯函数 `decideRowWrap()`，可单测。
- 换行态下标题若因编辑/数据更新变得更长，`scrollWidth` 仍会大于列宽（标题始终 nowrap），
  此时更新 `requiredTitleWidthRef`，不会误判成「可以收回了」。
- 标题提交（input → button）会先把换行态复位，新元素挂载时立即重量；短标题收回、长标题马上再换行。

## 3. 行尾操作怎么收

- `.wt-actions { opacity:0; pointer-events:none; transition:opacity .12s }`：平时不可见、不可点。
- `.wt-row:hover .wt-actions` 与 `.wt-row:focus-within .wt-actions` 同时把
  `opacity` 置 1、`pointer-events` 置 auto。`:focus-within` 覆盖键盘 Tab：按钮始终在 DOM / Tab 顺序里，
  聚焦铅笔或删除时整组显形，并各自有 `:focus-visible` 焦点环。
- 刻意不用 `display:none` / `visibility:hidden`（会从 Tab 顺序里摘掉按钮）；测试里也钉住了这一点。
- 删除的二次确认态加 `.wt-actions.is-armed` 常显：鼠标移开不会把「确认删除？」藏掉，仍然点得到。
- 两个按钮的既有行为不变：铅笔开整单编辑表单、删除先二次确认再 `onRemove`。

## 4. 保持不动的部分

- 完成动效（`is-celebrating` / `wt-check-celebrate` / 标题 settle）、勾选框视觉与 40×40 命中区不变。
- 点日期改期、点标题改文字、点项目标签换项目三条行内写路径不变（既有用例全绿）。
- 优先级旗子仍始终渲染（无优先级为 ghost，hover/focus 淡出）；位置从「行首」移到小字组最前面，
  与 B/C 目标顺序一致，旗子按钮、四旗浮层、`aria-expanded`、Esc 行为都不变。
- 三档更新设置、分组/筛选、拖拽（`draggable`）不变。
- 没有 `innerHTML`、没有新依赖；`prefers-reduced-motion` 下没有新增动效（只多了一个 120ms 的透明度过渡，
  已有 `transition:none !important` 降级会一并关掉）。

## 5. 测试与反向验证

`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs` 新增 3 条用例（测试文件仍是 9 个；`tools/verify-all.mjs` 仍 10 步）：

1. **行布局 B（默认单行）**：断言行有 `wt-row--single`；直接子元素顺序 `[check][main][meta][actions]`；
   小字组不在标题容器里；旗子/日期/项目都在小字组；CSS 原文断言 flex + `align-items:center` + 44px +
   标题 `flex:1` / 小字组 `flex:none` / 标题 `nowrap + ellipsis`。
2. **行布局 C（换行 + 滞回）**：注入 `scrollWidth=240 / clientWidth=120`（测试里直接调用标题节点的 ref，
   即「测试渲染里注入几何」）→ 断言 `.wt-row--wrap`、`data-wt-row-wrap="true"`、
   `grid-template-areas: "check main actions" ". meta ."`、meta 的 `grid-area:meta`、标题仍省略；
   把 clientWidth 调到 300（已不截断，但单行塞回 100px 小字组后只剩 192）→ 仍必须换行；
   再调到 360（预测 252 ≥ 240+8）→ 解除回 `wt-row--single`；并断言 ResizeObserver 被创建、观察行、
   卸载时 `disconnect()`。另有一条纯函数用例覆盖 1px slack 与 8px 滞回阈值。
3. **行尾操作**：断言 `.wt-actions` 默认 `opacity:0` + `pointer-events:none`、没有 `display:none` /
   `visibility:hidden`、hover 与 `:focus-within` 两条规则都在、`is-armed` 常显；DOM 里两个按钮始终存在、
   没有 `tabIndex:-1` / `disabled`（Tab 可达）。
4. **回归**：既有「行内日期 / 行内标题 / 行内项目」三条用例原样保留、全绿（含失败回滚、Esc、空白拒绝）。

反向验证（每次都重新 `build-client.mjs`，只看结论行）：

| 故意破坏 | 结果 |
| --- | --- |
| 把 `measureRow()` 的判定换成 `const next = rowWrapRef.current`（去掉换行判定） | `行布局 C` 红：`标题会被截断时必须换行：wt-row wt-row--single期望 true，实际 false`；81 通过 / 1 失败，EXIT=1 |
| 把 `.wt-actions` 的 `opacity:0; pointer-events:none` 改成常驻 `opacity:1; pointer-events:auto` | `行尾操作` 红：`行尾操作平时必须不可见：期望 true，实际 false`；81 通过 / 1 失败，EXIT=1 |
| 把 `ROW_WRAP_HYSTERESIS_PX` 改成 0（去掉滞回） | `行布局判定` 红：`预测宽度 240 < 240+8 → 仍然保持换行：期望 true，实际 false`；81 通过 / 1 失败，EXIT=1 |

三次破坏后都已恢复，最终工作区里没有临时代码。

## 6. 两套门禁

- 本机：`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` → **10/10 个步骤通过（含构建），EXIT=0**
  （`smoke-client` 82 通过 / 0 失败）。
- 干净环境：`env -i HOME=/tmp/cihome PATH=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:/usr/bin:/bin CI=true node tools/verify-all.mjs`
  → **10/10 个步骤通过（含构建），EXIT=0**。

## 7. 与预览页 B/C 的对应关系

- **B**：预览是 `check / title / end(flag + date + project + actions)` 的 flex 单行、44px、勾选框垂直居中；
  实现同构，只是把 `end` 拆成 `.wt-meta` 与 `.wt-actions` 两组（为了单独收起操作按钮 / 单独换行小字）。
- **C**：预览用 grid，换行时把整个 `end`（含操作按钮）落到第二行；本轮批准的方案要求**操作按钮留在第一行尾部、
  第二行只有小字组**，所以 grid 区域写成 `"check main actions" ". meta ."`，而不是 `.is-wrapped .end`。
  另外预览 C 换行后标题改成 `white-space:normal`（允许折行），本轮要求「换行态仍省略号」，因此标题保持
  `nowrap + ellipsis`，这是与预览页唯一的刻意差异。
- 视觉基准（44px、26px 勾选框、11px 日期、#项目胶囊、22px 旗子/图标按钮、红/琥珀/灰旗）与预览页保持一致。

## 8. 未做 / 不确定

- **没做真机逐像素截图比对**：本机只有 Safari，没有可脚本化的 Chromium/Playwright，无法自动截屏；
  布局正确性由 DOM/CSS 结构断言 + 样式表原文断言兜底，建议在真实面板里再目视一次宽/窄两档。
- 高/低优先级的**文字**标签（旧的两行布局里与旗子并存的「高」「低」胶囊）已移除：B/C 的目标行只有旗子，
  旗子颜色 + 高优先级红色左缘仍完整表达优先级。若希望保留文字标签，可以再加回小字组。
- 小字组在极窄面板下允许**组内**换行（`.wt-row--wrap .wt-meta { flex-wrap:wrap }`），
  极端长项目名时第二行内部可能再折一行；标题本身始终只有一行。
- 字体加载完成导致文字变宽但元素盒宽不变的场景没有监听 `document.fonts.ready`；面板/窗口尺寸变化会触发重量，
  单纯字体替换后的首次布局可能要到下一次 resize 才纠正。
- 外部刷新把已换行行的标题**改短**（不是用户自己编辑，而是 agent/其他端改了同一条）时，
  因为换行态下标题列变宽、`scrollWidth` 已回落到列宽，拿不到新的「固有宽度」，这一行可能保持两行，
  直到下一次 resize 或用户编辑标题。用户自己编辑标题的路径会先复位再立即重量，不受影响。
- 测试里的 hover/focus 是样式表规则断言 + DOM 可达性断言，没有真实 CSS 引擎；`:focus-within` 的实际渲染
  仍建议真机 Tab 一遍确认。
