# 行内旗子改优先级 / 勾选完成动效 / 勾选框放大（feature-row-priority-and-celebration）

对象：仓库 `dsh-worktodo`（本次改动只碰代码与测试；**未升版本、未改 CHANGELOG 版本段、未动 `.github/`、未 commit/push/tag/发布**）。
复现环境：仓库根 `~/Documents/deepseek-harness/default-workspace/dsh-worktodo`，
Node 用 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`，
跑测试前 `export WORKTODO_NO_UPDATE_CHECK=1`，全量 `node tools/verify-all.mjs`（会先构建客户端 bundle）。

三件事：已创建的行**点旗子就能改优先级**、勾选完成时**一段克制的庆祝动效**、勾选框**放大且更好点**。

---

## 1. 已创建待办：点旗子改优先级

### 1.1 设计

| 维度 | 决定 |
| --- | --- |
| 触发 | 行首的旗子本身就是一个 `<button>`（原来只是一个不可点的 `<span>` 图标） |
| 弹层 | 四旗：**无 / 高 / 中 / 低**，顺序、文案、配色与快速添加行完全一致（共用同一个组件，见 §4） |
| 协议 | `POST /worktodo/update`，body 恰好 `{ ref: <该条 id>, priority: 'high' \| 'normal' \| 'low' \| 'none' }`；**没有新增宿主协议**：`/update` 路由与 `src/records.mjs` 的 `patchRecord` 早就支持 `none` |
| 落库路径 | 走面板统一的 `runWrite()`：失败进顶部错误条，成功/失败最后都 `refresh()`；**不整页刷新** |
| 关闭 | 选中即收弹层；弹层上按 Esc 关；旗子按钮上按 Esc 也关；`aria-expanded` / `aria-haspopup` 全程跟随 |
| 无障碍 | 旗子按钮带 `aria-label="优先级：高/普通/低/无"` 与 `title`；四旗各有 `aria-pressed`（当前档位） |

### 1.2 「无」优先级的行怎么办（本轮的取舍）

默认**仍然不常显旗子**（保持已定稿的「默认档不制造噪音」），但做法不是「不渲染」：

- **始终渲染**这个旗子按钮，只是 `opacity: 0`（类名 `is-ghost`）。占住左侧那一列，
  各行左缘因此**对齐稳定**；更重要的是按钮留在 DOM 里，**纯键盘 Tab 依然能聚焦到它**。
- 鼠标**悬停该行**（`onMouseEnter`）或**聚焦该行**（`onFocus` 冒泡自子元素）时，
  旗子淡出来，`opacity: 0.55`（淡色空心旗），可点。
- 有优先级的行：旗子常显（`opacity: 1`），高＝红＋红色左缘、中＝琥珀、低＝灰，与改动前一致。
- 可见性由**组件状态**（`flagPeek` / `flagOpen`）计算，而不是只靠 CSS `:hover`——
  这也是测试能直接断言的那一层；CSS 只负责过渡与 `pointer-events`。

副作用（刻意接受）：无优先级的行左侧多了一个 22px 的旗子位，勾选框相对改动前右移约 30px，
换来的是**所有行的旗子/勾选框列对齐一致**（改动前高优先级行比普通行多一个图标，本来就错位）。

---

## 2. 勾选完成时的动效

### 2.1 参数（全部 ≤600ms，纯 CSS，不改布局）

| 段 | 实现 | 参数 |
| --- | --- | --- |
| 勾选框弹跳/放大回弹 | `@keyframes wt-check-pop` → `.wt-check-celebrate` | **320ms**，`cubic-bezier(.34, 1.56, .64, 1)`，`scale 1 → 1.32 → .94 → 1` |
| 对勾描边出现 | `@keyframes wt-mark-draw` → `.wt-check-celebrate .wt-check-mark path` | **300ms** `ease-out`，**延迟 80ms**；`stroke-dasharray: 14`（略大于路径实际长度 ≈11.6），`stroke-dashoffset 14 → 0` |
| 整行轻微高亮再淡出 | `@keyframes wt-row-celebrate` → `.wt-row.is-celebrating` | **560ms** `ease-out`：成功色 26% → 12% → `transparent`（只动 `background`） |

- 动效总时长常量 `CELEBRATE_MS = 560`，测试断言 `≤600`。
- 只用 `transform` / `background`，**没有会触发重排的属性**（宽度、高度、margin、padding 一律不动）；
  对勾的 `stroke-dashoffset` 只影响绘制，不影响布局。因此没有布局跳动。
- **没有粒子/星点迸发**（见 §6 的取舍说明）。
- 类的摘除走 DOM 的 `animationend`（`onAnimationEnd`）：**不需要 JS 定时器，更没有任何逐帧 setState**。
- 为了看得到「对勾描边」，勾上时立刻进入**乐观勾选态**（`optimisticDone`）：这一行马上按已完成渲染，
  数据回来后仍以数据为准；写失败立刻退回，不留假的勾。

### 2.2 降级策略（三层）

1. **配置开关** `config.celebrate`（宿主）→ 随 `/list` 载荷下发为 `data.panel.celebrate` →
   面板 `shouldCelebrate(data.panel)`。只有显式 `false` 才关；缺省/非法值一律**开**。
   关掉时连乐观勾选态都不挂，行为与改动前**完全一致**。
2. **`@media (prefers-reduced-motion: reduce)`**：CSS 里把三段动画 `animation: none !important`
   并把对勾复位（`stroke-dasharray: none; stroke-dashoffset: 0`），只做状态切换。
3. **JS 守卫** `prefersReducedMotion()`（`matchMedia`，包 try）：命中时**连动效类都不挂**，
   避免任何残留 keyframes/transition。两层都留着是刻意的：CSS 是兜底，JS 是干净路径。
4. **取消完成**（completed → pending）走另一个分支，**绝不**挂庆祝类。

---

## 3. 勾选框放大

| 维度 | 决定 |
| --- | --- |
| 视觉尺寸 | **26px**（原 17px），圆角 8px，`CHECK_SIZE_PX = 26` |
| 实际可点区域 | **40×40px**：`.wt-check::before { inset: -7px }`（26 + 7×2 = 40），`CHECK_HIT_PX = 40`、`CHECK_HIT_INSET_PX = 7` |
| 不撑高整行 | 伪元素向外扩、不占布局盒；勾选框 `margin-top: -3px`，行高只增加约 5px（每行一致） |
| 横向布局 | 勾选框 `flex: none` 固定宽，旗子列也固定 22px，左侧内容不会被挤变形 |
| 无障碍 | 仍是原生 `<button>`，保留 `aria-label`（标为完成/取消完成）；新增 `.wt-check:focus-visible` 可见 focus ring |
| 可断言性 | 渲染出来的 `data-wt-check-size="26"` / `data-wt-check-hit="40"` 与样式表取**同一组常量**，测试不会与实现漂移 |

---

## 4. 共享组件抽取情况

**抽出来了**（这是本轮唯一的结构性重构）：

- `priorityFlagOptions(t)`：四档优先级的**唯一**权威定义（顺序 无/高/中/低、文案 key、语义色、虚线空心）。
- `priorityColor(value)`：某一档的语义色。
- `PriorityFlagsPopover({ t, value, onPick, onClose })`：四旗弹层的**唯一**实现
  （`data-wt-priority-pop`、`role="group"` + `aria-label`、Esc 关闭、`aria-pressed`）。
- 两个调用点：快速添加第二行的「优先级」chip、行内旗子按钮。快速添加原来内联的那份四旗数组与弹层已删除。
- 防漂移断言：`data-wt-priority-pop` 在源码里**只允许出现 1 次**，
  `React.createElement(PriorityFlagsPopover` **恰好 2 次**（两处调用）。

弹层样式（定位/底色/圆角/阴影）也随组件一起共享，两处的视觉不会各自演化。

---

## 5. 测试覆盖（9 个文件不变，用例加进现有文件）

| 文件 | 新增/改动 |
| --- | --- |
| `tools/smoke-client.mjs` | **+8 条**：①四旗 UI 只有一份（源码级防漂移 + 纯函数）；②无优先级行默认 ghost、hover/focus 由组件状态驱动才现身、点开四旗、两种 Esc 关闭；③选「高」/「无」发出 `POST /worktodo/update`，body 精确等于 `{ref:'wt-1',priority:'high'}` / `{...,priority:'none'}`，选中后弹层关闭、`aria-expanded` 回 false；④勾选框 `data-wt-check-size=26` / `data-wt-check-hit=40`、样式表用上 26px 与 `inset:-7px`、有 focus ring、点击仍触发 onToggle（`POST /status {ref,toggle:true}`）；⑤勾选完成挂 `is-celebrating`/`wt-check-celebrate`/`wt-check-mark`（对勾描边）、动画结束自己摘类；⑥取消完成**不挂**任何庆祝类；⑦`config.celebrate===false` 时不挂动效且无乐观态；⑧reduced-motion（JS 守卫不挂类 + CSS 文本含 `@media (prefers-reduced-motion: reduce)` 与 `animation: none !important` + 时长 ≤600ms + `stroke-dashoffset/dasharray` 存在） |
| `tools/smoke-host.mjs` | **+2 条**：`normalizePanelConfig` 默认 true / 仅显式 false 才关 / 非法值回落；用两个独立宿主验证 `/list` 载荷里 `panel.celebrate` 分别为 `true` 与 `false`，且新增字段不挤掉既有字段 |
| `tools/smoke-contract.mjs` | 扩展现有的「list 返回面板首屏需要的全部字段」：字段清单加入 `panel` 并断言默认 `celebrate === true` |

计数：客户端 41 → **49**，宿主 59 → **61**，契约保持 18（扩展既有用例）。共 9 个测试文件，数量未变。

---

## 6. 反向验证（回退修复 → 测试必须变红）

两条都实测过：改 `src/client/index.js` → `node tools/build-client.mjs` → `node tools/smoke-client.mjs`。

### 6.1 第 1 条（行内旗子 → 调接口）

- **回退**：把行内弹层的 `onPick` 里那行 `Promise.resolve(onPriority?.(row.id, value))` 删掉（只关弹层、不发请求）。
- **结果**：`✗ 行内旗子选「高」/「无」：发出 POST /worktodo/update，body 恰好是 {ref, priority}`
  —— `必须 POST 到 /worktodo/update（不能整页刷新）：期望 "/worktodo/update"，实际 ""`。
  48 通过 / **1 失败**。
- **恢复**：`src/client/index.js` 还原 + 重新 build → 该用例回到绿。

### 6.2 第 3 条（勾选完成 → 挂动效）

- **回退**：把 `handleCheck` 里的 `setCelebrating(true)` 删掉（勾选仍完成，但没有动效类）。
- **结果**：`✗ 勾选完成的动效：挂 is-celebrating / wt-check-celebrate / 对勾描边，动画结束自己摘掉`
  —— `勾选完成时行上必须挂 is-celebrating：期望 true，实际 false`。
  48 通过 / **1 失败**。
- **恢复**：还原 + 重新 build → 该用例回到绿，客户端 **49/49**。

### 6.3 全量

恢复后重跑 `node tools/verify-all.mjs`：**10/10 个步骤通过（含构建）**。

---

## 7. 未做 / 不确定

1. **粒子/星点迸发省略了**。原因：要 ≤10 个小点就得为每一行额外挂 DOM 节点，并在动画结束后清理——
   要么引入每行一个定时器，要么引入额外的动画结束状态，成本明显高于收益，而且与
   「纯 CSS、不跑 JS 动画循环、不逐帧 setState」的硬约束冲突。勾选框回弹 + 对勾描边 + 整行高亮
   三段已经足够有「完成感」。
2. **`prefers-reduced-motion` 是「挂类那一刻」判断一次**：面板打开期间用户改系统设置不会立刻生效，
   下次勾选会重新判断（CSS 那层则始终生效）。这是刻意的，避免为一个开关挂 `matchMedia` 监听。
3. **乐观勾选态**：写请求成功但随后的列表刷新失败时，这一行会短暂显示为已完成（顶部错误条会
   给出原因；下一次 `refresh()` 或轮询会纠正）。
4. **「无优先级」行的 ghost 旗子占位**：如 §1.2 所述，无优先级的行勾选框相对改动前右移约 30px。
   选择了「各行左缘对齐」而不是「零位移」，如果后续觉得位移不可接受，可以改成绝对定位的 ghost。
5. **没有真实浏览器/触屏实测**：本环境没有浏览器，40×40 的可点区域是 CSS 伪元素算出来的
   （26 + 7×2），只做了渲染层与样式文本级断言，没有做设备上的像素/命中测试。
6. **宿主 `panel` 字段是新增载荷字段**：老面板忽略它、新面板在字段缺失时回落到「开」，
   双向兼容；但这是**面板↔宿主契约**上的一个新增键，只有 `smoke-contract.mjs` 与
   `smoke-host.mjs` 覆盖，没有跨版本的端到端验证。
7. 未做（按任务要求）：不改版本号 / CHANGELOG / `.github/`，不 commit / push / tag / 发布；
   没有触碰 `~/.dsh/storages/worktodo.json` 与 `~/.dsh/worktodo/*`（测试与实验都在 `/tmp`）。
