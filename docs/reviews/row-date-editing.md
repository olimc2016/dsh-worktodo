# 行内编辑日期（row-date-editing）

对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`
本轮只改代码与测试：**未升版本、未改 CHANGELOG / `.github/`、未 commit / push / tag / 发布、未碰真实数据**。
Node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；测试前 `WORKTODO_NO_UPDATE_CHECK=1`。

---

## 1. 交互

### 1.1 有日期的行

- 行内「日期」从纯文本 `<span>` 换成原生 `<button type="button">`，视觉仍是原来的 11px 小字
  （逾期仍用 warn 色，且前缀仍是「逾期」）。
- 日期旁边**显示该行的 `dueTime`**（旧实现只显示日期）；日期与时间一起点。
- hover 反馈：淡品牌色底 + 下划线；`cursor: pointer`；键盘 focus 有 2px focus ring。
- 无障碍：`aria-label="修改日期"` / `"Edit date"`（随语言），`aria-haspopup="dialog"`、
  `aria-expanded` 跟随浮层状态；`title` 同一句话。
- 点击 / 键盘 Tab 聚焦后按 Enter（原生 button 行为）打开浮层：
  - 原生 `<input type="date">`，值为当前 `due`；
  - **该行本来就有时间**时再加一个原生 `<input type="time">`，值为当前 `dueTime`；
  - 底部有「清除日期」与「关闭」两个按钮；Esc 与点击浮层外部都能关。

### 1.2 没有日期的行

- 默认**不渲染**「＋ 日期」入口（DOM 里没有这个节点）。
- 鼠标 hover 该行、或键盘 focus 进入该行（onFocus 冒泡）时，才挂载一个淡色虚线
  「＋ 日期」/「＋ Date」按钮；移开 / 失焦后立即卸载。
- 入口出现时复用 meta 那一行，不新增独立行；`.wt-row` 的 `min-height: 44px`
  兜住单行标题时的行高，所以没有可见的纵向跳动。
- 点击入口打开同一个浮层（date 输入初始为空）。

### 1.3 浮层定位与生命周期

- 浮层**只在打开时挂载**，关闭（Esc / 点外部 / 关闭按钮）即卸载，不常驻 DOM。
- 打开时用日期按钮的 `getBoundingClientRect()` 与 `window.innerHeight` 调
  `chooseDatePopoverPlacement()`：优先向下；下方放不下、上方放得下 → 向上；
  两边都放不下时选空间大的一侧；拿不到几何信息（SSR / 测试替身）默认向下。
- 点外部关闭用 `mousedown`，且只在浮层打开期间注册 document listener，关闭/卸载即移除。
- 没有引入新依赖；没有使用 `innerHTML`；没有改完成动效、勾选框、优先级旗子、
  项目字段与三档更新设置。

---

## 2. 提交的 payload

统一走面板现有的 `runWrite()` → `postJson()`，只发 `POST /worktodo/update`，不整页刷新。

| 用户动作 | 请求体 |
| --- | --- |
| 改日期 | `{ "ref": "wt-…", "due": "YYYY-MM-DD" }` |
| 改时间（该行本来有时间） | `{ "ref": "wt-…", "due": "YYYY-MM-DD", "dueTime": "HH:MM" }` |
| 清空时间 | `{ "ref": "wt-…", "due": "YYYY-MM-DD", "dueTime": null }` |
| 清空日期 | `{ "ref": "wt-…", "due": null }`（宿主 `patchRecord` 会把 `dueTime` 一并清成 null） |

宿主侧无需改动：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`
的 `POST /worktodo/update` 早已把 `{ref, ...patch}` 交给 service.update；
`src/records.mjs` 的 `patchRecord` 已支持 `due` / `dueTime`（含 `null` 清空）。
本轮只消费既有协议。

---

## 3. 乐观更新与回滚

- 改动发生时先把乐观值写进行组件的 `dateOverride`，并绑定**点击那一刻的 `todo` 对象**
  （`dateOverrideFor === todo`）。本地立刻显示新日期/时间。
- 请求成功：保留乐观值；`refresh()` 拿回新对象后 `dateOverrideFor` 不再匹配，
  乐观值自动失效，以服务端真相为准。
- 请求失败：清掉 `dateOverride` / `dateOverrideFor`，本地回到 `row.due`；
  行内显示一句温和提示（`日期没保存上，已恢复原值` / `Couldn't save the date — reverted`）。
- 这条写路径给 `runWrite()` 传 `quietError: true`：**原始异常不贴到顶部错误条**，
  所以 `HTTP 500`、`Error: …`、底层错误串都不会出现在 DOM 里。
- 失败后仍按现有机制 `refresh()`，不留下一个与磁盘不一致的假日期。

---

## 4. 测试与反向验证

### 4.1 新增用例（加进既有客户端套件，测试文件仍是 9 个）

`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`：

1. `日期浮层向上/向下自动避让边界`：纯函数五种几何输入。
2. `行内日期：点日期按钮 → 原生 date 浮层 → 改期立即 POST /worktodo/update`：
   按钮类型/aria-label/class/文案、关闭时浮层不挂载、打开后含 `input[type=date]`、
   改值后 body 精确为 `{ref:'wt-1', due:'2026-11-01'}`，且本地先显示新值。
3. `行内日期：该行有时间就带原生 time 输入，改时间同时发 due + dueTime`：
   时间显示在日期旁、`input[type=time]` 存在、body 精确为
   `{ref:'wt-1', due:'2026-10-20', dueTime:'09:05'}`。
4. `行内日期：清空日期 → POST {ref, due:null}`：body 精确、本地旧日期立即消失。
5. `无日期的行：默认不渲染「＋ 日期」，hover / focus 才出现，点击同样打开浮层`：
   默认 DOM 无入口；hover 出现淡色 `is-add` 按钮；点击打开浮层；Esc 后浮层卸载；
   移开/失焦收回；focus 再出现。
6. `行内日期保存失败（stub 返回 500）：本地回滚 + 温和提示（不含原始异常串）`：
   先看到乐观新值 → 失败后回到原日期 → 行内出现 `[dateSaveFailed]`，
   且行文本不含 `HTTP 500` / `internal boom`。

客户端套件：69 → **75 通过，0 失败**。

### 4.2 反向验证（实测，改源码 → build → 跑客户端套件）

**A. 把日期按钮改回纯文本**

- 改动：把日期渲染从 `React.createElement('button', {…, onClick: openDate})`
  换成纯文本 `React.createElement('span', …)`。
- 结果：`node tools/smoke-client.mjs` → **EXIT=1**，5 条日期用例变红；
  首条失败为「有日期的行必须把日期渲染成可点按钮：期望 true，实际 false」。
- 恢复并重新 build 后 → 75 通过。

**B. 去掉失败回滚**

- 改动：删掉 `commitDate()` 失败分支里的 `setDateOverride(null)` /
  `setDateOverrideFor(null)`，只保留错误提示。
- 结果：`node tools/smoke-client.mjs` → **EXIT=1**；
  失败用例为「保存失败必须回滚到原日期：期望 true，实际 false」。
- 恢复并重新 build 后 → 75 通过。

---

## 5. 两套门禁

命令均在 `~/Documents/deepseek-harness/default-workspace/dsh-worktodo` 下执行，
显式检查退出码：

| 环境 | 命令 | 结果 |
| --- | --- | --- |
| 本机 | `WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` | **10/10，EXIT=0** |
| 干净环境 | `env -i HOME=/tmp/cihome PATH=<node目录>:/usr/bin:/bin CI=true node tools/verify-all.mjs` | **10/10，EXIT=0** |

两套都包含 `build-client.mjs`（先构建再跑），所以 `lib/client.js` / `.map` 与源码一致。

---

## 6. 未做 / 不确定

- **未在真机浏览器量像素**：行高不跳动是靠「入口只在 hover/focus 挂载 + meta 行复用 +
  `.wt-row` 的 44px 下限」保证的，单测覆盖的是「默认不渲染 / 出现 / 收回」，
  没有真实布局测量。多行长标题在极小概率下仍可能让 meta 行把行高撑高一点。
- 浮层定位用的是**估算高度**（`DATE_POPOVER_HEIGHT_PX = 112`），不是渲染后实测；
  极端字号/缩放下可能差几像素，但仍有 8px 余量与「选空间大的一侧」兜底。
- 浮层是 `role="dialog"` 但**没有做焦点陷阱**（Tab 仍可离开浮层到页面其它控件）；
  关闭后焦点回到日期按钮也未显式处理。原生 date/time 输入本身键盘可用。
- 只有**本来就有时间**的行才显示 time 输入；没有时间的行不能在这里「加一个时间」，
  这是按需求「该行有时间就带上」实现的取舍。
- 未改宿主、未新增路由、未改存储 schema、未引入依赖；未升版本、未提交、未发布。
