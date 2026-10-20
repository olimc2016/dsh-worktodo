# 行内编辑标题 / 项目（row-title-project-editing）

对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（0.2.10，在**未提交**的
「行内改日期」成果之上继续）。
本轮只改代码与测试：**未升版本、未改 CHANGELOG / `.github/`、未 commit / push / tag / 发布、未碰真实数据**；
未回退行内改日期、完成动效、勾选框、优先级旗子、三档更新设置。

Node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；测试前 `WORKTODO_NO_UPDATE_CHECK=1`。

---

## 1. 交互

### 1.1 点标题 → 行内编辑

- 行里的标题从纯文本 `<div>` 换成原生 `<button type="button">`（`.wt-title-btn`，`data-wt-title-btn="true"`）：
  - `cursor: text`，hover 出现虚线下划线（可编辑暗示），键盘 focus 有 2px focus ring；
  - `aria-label="编辑标题"` / `"Edit title"`，tooltip 仍是「点击标题可编辑」。
- 点击（或 Tab 聚焦后 Enter）→ **同一位置**换成 `<input>`（`.wt-title-input`）：
  - `font: inherit; line-height: inherit; padding: 0; border: 0`，与标题同字号/行高/颜色；
    0 内边距 0 边框保证行高不跳（`.wt-row` 本身还有 44px 下限兜底）；
  - `autoFocus`；`onFocus` 主动 `select()`，进入即全选；
  - 拖动、完成态的删除线与高优先级字重都照旧。
- 保存：`Enter` 或失焦。空白标题 → **不发请求**，收起编辑、还原原文，行内给一句温和提示
  （`标题不能为空，已还原` / `A title can't be empty — reverted`）。
- 取消：`Escape` → 收起并还原，**不发请求**（`titleCommittedRef` 挡住 Esc 后紧跟的 blur 重复提交）。
- 标题未改动 → 静默收起，不发空 patch。
- 标题单击改成行内编辑后，原来「点标题进完整表单」的入口改到行尾的铅笔按钮
  （`.wt-icon-btn`，`data-wt-edit-details`，`aria-label="编辑详情"`），备注/日期/优先级/项目仍可整单编辑。

### 1.2 点项目标签 → 改项目

- 有项目：`#项目` 从 `<span>` 换成 `<button class="wt-tag wt-project-btn" data-wt-project-btn>`，
  `aria-label="修改项目"`、`aria-haspopup`、`aria-expanded`，hover 有淡品牌底。
- 没有项目：默认**不渲染**入口；鼠标 hover 或键盘 focus 该行时才挂一个淡色虚线
  「＋ 项目」/「＋ Project」（`data-wt-project-add`，与「＋ 日期」同一种 `projectPeek` 状态驱动），
  移开/失焦立刻卸载，平时不占位。
- 点标签 / 「＋ 项目」→ 打开项目选择浮层，**与 QuickAdd 共用同一个 `ProjectPopover` 组件**：
  可选已有项目（按 `/list` 的 `projects` 顺序）、输入新建（重名忽略大小写/首尾空白，对齐到已有原名）、
  「未归类」清除（= `project: null`）。
- 浮层只在打开时挂载；`Escape` 关闭、点击浮层外部关闭（`mousedown` 监听只在打开期间注册）；
  浮层与触发按钮都是 `<button>`，Tab/Enter 可达。没有 `innerHTML`，没有新依赖。

### 1.3 与既有行为的关系

- 日期浮层、完成动效、勾选框、优先级旗子、更新设置一行未动；新增的标题/项目入口只在行内。
- 行尾多了一个铅笔按钮（完整表单入口），删除按钮位置与行为不变。

---

## 2. 提交的 payload

统一走面板现有的 `runWrite()` → `postJson()`，只发 `POST /worktodo/update`，不整页刷新。

| 用户动作 | 请求体 |
| --- | --- |
| 改标题 | `{ "ref": "wt-…", "title": "新标题" }`（客户端已 trim，非空） |
| 选已有 / 新建项目 | `{ "ref": "wt-…", "project": "alpha" }` |
| 清除项目（未归类） | `{ "ref": "wt-…", "project": null }` |

标题/项目两条写路径都传 `quietError: true`：失败不把 `HTTP 500` / `Error: …` 贴到顶部错误条。

---

## 3. 宿主是否补字段 / 校验

**不需要补**：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/records.mjs` 的
`patchRecord` 早就会处理 `title` 与 `project`：

- `title`：`normalizeTitle()`——`trim()` 后非空，长度上限 `TITLE_MAX = 200`（与 `createRecord` 同一个常量/函数）。
- `project`：`normalizeProject()`——`null`/`undefined` → `null`；非字符串 → `bad-project`；
  `trim()` 后为空 → `null`；长度上限 `PROJECT_MAX = 60`。

`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js` 的
`POST /worktodo/update` 只是把 `{ref, ...patch}` 交给 `service.update`；非法值在 `patchRecord`
里抛 `WorkTodoError`，`store.put` 不会执行，记录不变。**未改 `lib/index.js`。**

注意口径：该路由沿用仓库既有约定——业务校验失败回 **HTTP 200 + `{ok:false, reason, error}`**
（`reply()`，与 `/create` 空标题一致），不是 400。客户端 `postJson()` 对 `ok:false` 同样按失败处理。
如果未来要求「非法输入必须 400」，那是跨所有写路由的统一改动，不在本轮范围。

另外 `service.update` 对 `project` 会做**已有的**大小写对齐（`alignProject`）：新建 `Beta` 时若
已有 `beta` 会落到 `beta`。客户端选择器也先用 `matchExistingProject()` 对齐，两条路径一致。

---

## 4. 乐观更新与回滚

- 标题：提交时先把新标题写进 `titleOverride`，并绑定**点击那一刻的 `todo` 对象**
  （`titleOverrideFor === todo`），本地立刻显示新标题；失败清掉 override → 回到 `row.title`，
  行内显示 `标题没保存上，已恢复原文` / `Couldn't save the title — reverted`。
- 项目：同一套机制（`projectOverride` 用 `undefined` 表示「无乐观值」，因为 `null` 是合法的「清除」）；
  失败回到 `row.project`，行内显示 `项目没保存上，已恢复原值` / `Couldn't save the project — reverted`。
- 成功后 `refresh()` 拿回新对象，引用一变乐观值自动失效，以服务端真相为准（沿用行内日期的 B2 口径）。
- 失败后仍会 `refresh()`，不留下与磁盘不一致的假标题/假项目。
- 两条失败提示都只含温和文案，不含原始异常串/状态码。

---

## 5. 测试与反向验证

### 5.1 新增用例（客户端套件仍是 9 个测试文件）

`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`：

1. **行内标题**：按钮类型/aria-label/样式类；点标题出现 `<input>`、值正确、`autoFocus`、
   focus 全选；改文字 + Enter 后 `POST /worktodo/update` body 恰好
   `{ref:'wt-1', title:'写周报'}` 且本地先显示新值；Esc 不发请求且还原；
   空白 → 不发请求、还原、出现 `[titleEmptyHint]`；并断言样式表里
   `cursor:text` / `font:inherit` / `line-height:inherit` / `padding:0` / `border:0`。
2. **行内项目**：点 `#项目` 打开浮层、列出已有项目/清除/新建；选 `alpha` → body
   `{ref:'wt-1', project:'alpha'}`；清除 → `{ref:'wt-1', project:null}`；
   无项目行默认不渲染「＋ 项目」，hover 出现（`data-wt-project-add`、文案、aria-label），
   Esc 关闭浮层，移开/失焦收回、focus 再出现。
3. **失败回滚**：stub 对 `/worktodo/update` 回 500 → 标题先乐观显示后回滚原文、
   项目先乐观显示 `#alpha` 后回滚原项目；两条温和提示都在；行文本不含
   `HTTP 500` / `internal boom`。

客户端套件：75 → **78 通过，0 失败**。

`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs`：

4. **宿主校验**（既有 `patchRecord` 行为，证明无需补字段且有牙齿）：空标题 / 201 字标题 /
   非字符串标题 → `empty-title` / `title-too-long` / `empty-title`；61 字项目 → `project-too-long`、
   非字符串项目 → `bad-project`；每种都断言 HTTP 200 + `ok:false` 且**记录标题/项目不变**；
   最后合法值 trim 后落库。宿主套件 **107 通过，0 失败**。

### 5.2 反向验证（实测：改源码 → build → 跑客户端套件 → 恢复并重新 build）

**A. 把标题改回纯文本**

- 改动：标题渲染的 `React.createElement('button', …)` 换成 `'span'`。
- 结果：`node tools/smoke-client.mjs` → **EXIT=1**，1 条红：
  `标题必须是 <button>（键盘可达）：期望 "button"，实际 "span"`。
- 恢复并 build → 78 通过。

**B. 去掉项目选择浮层**

- 改动：把行内 `projectOpen ? React.createElement(ProjectPopover, …)` 改成 `false ? …`。
- 结果：**EXIT=1**，2 条红；首条为
  `点项目标签必须打开选择浮层：期望 true，实际 false`（失败回滚用例也因打不开浮层而红）。
- 恢复并 build → 78 通过。

**C. 去掉失败回滚**

- 改动：删掉标题/项目失败分支里的 `setTitleOverride(null)` / `setTitleOverrideFor(null)` 与
  `setProjectOverride(undefined)` / `setProjectOverrideFor(null)`，只保留提示。
- 结果：**EXIT=1**，1 条红：
  `标题保存失败必须回滚原文：期望 "写 README"，实际 "会失败的标题"`。
- 恢复并 build → 78 通过。

---

## 6. 两套门禁

命令均在 `~/Documents/deepseek-harness/default-workspace/dsh-worktodo` 下执行，显式检查退出码：

| 环境 | 命令 | 结果 |
| --- | --- | --- |
| 本机 | `WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` | **10/10，EXIT=0** |
| 干净环境 | `env -i HOME=/tmp/cihome PATH=<node目录>:/usr/bin:/bin CI=true node tools/verify-all.mjs` | **10/10，EXIT=0** |

两套都包含 `build-client.mjs`，所以 `lib/client.js` / `.map` 与 `src/client/index.js` 一致。

---

## 7. 未做 / 不确定

- **未在真机浏览器量像素**：行高不跳靠 `font/line-height: inherit` + 0 padding/0 border +
  `.wt-row` 44px 下限；单测覆盖了样式表原文与交互，但没有真实布局测量。极端字号/缩放仍可能有 1px 级差异。
- **完整表单入口换了位置**：标题单击现在必须进标题编辑，所以进入备注/完整字段改走行尾铅笔按钮。
  这是需求带来的必然取舍；如果希望保留「点标题进完整表单」，需要再定义第二个手势（如双击）。
- **项目浮层没有上下避让**：与 QuickAdd 的浮层一样固定向下；行靠近视口底部时可能被裁。日期浮层有
  `chooseDatePopoverPlacement()`，项目浮层本轮未接（避免改变 QuickAdd 既有行为）。
- **宿主校验回 200 + `ok:false` 而不是 400**：沿用仓库既有约定（`/create` 空标题也是 200）；
  若产品要求 4xx，应统一改所有写路由，不在本轮。
- **测试替身的 refresh 返回同一批对象**：所以「成功后乐观值随 refresh 失效」在替身里不会自然发生；
  标题测试用「保存路径」与「Esc/空白路径」两个稳定窗口隔离，失败回滚用 500 stub 直接验证。
- 未改版本号、CHANGELOG、`.github/`；未提交、未打 tag、未发布。
