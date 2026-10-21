# 子待办 / 备注展开后收不回去（dsh-worktodo 0.2.16，未升版本）

> 仓库：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（HEAD `70f144d`，干净基线）
> 写域：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`、
> `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`；
> `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/client.js` + `.map` 是重新构建的产物，随源码同批改动。
> 本轮**不升版本、不改 CHANGELOG / `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/.github`、不 commit / push / tag / 发布**。
> 结论先行：真正卡住用户的是**行尾两个轻入口只会「打开」没有「收起」分支**，以及展开区没有
> 可见的「收起」；进度 chip 与备注图标在 HEAD 上本来就有 `(open) => !open`，但我用临时用例
> 实测确认它们能双向切换，因此把它们一并纳入回归与视觉状态提示，不再只靠入口路径。

## 1. 复现与根因

从代码与用例两条线核对后，HEAD 上的展开状态其实分成两套入口，行为并不一致：

| 入口 | HEAD 行为 | 结果 |
|---|---|---|
| 进度 chip `2/3` | `setSubtasksOpen((open) => !open)` | 能开能收（已有实现；无收起用例、无视觉暗示） |
| 备注图标 | `setInlineNotesOpen((open) => !open)` | 能开能收（已有实现；旧用例已有一条收起断言） |
| 行尾「＋子待办」 | `setSubtasksOpen(true)` + 进入新增态 | **只能开不能收**；空清单时这是唯一可见入口，用户就卡在这里 |
| 行尾「添加备注」 | `startNotesEdit()`（内部 `setInlineNotesOpen(true)`） | **只能开不能收**；空备注时这是唯一可见入口 |
| 展开区底部 | 无「收起」；备注区只有一个 X 图标 | 收不起时没有第二出口，只能猜 Esc |

根因可以落成三条：

1. **开关不完整**：两个行尾轻入口只写了展开分支，没有「已展开 → 收起」的反向分支；
   其中「＋子待办」在空清单、「添加备注」在空备注时一直留在行尾，用户自然会反复点它。
2. **缺少显式收起**：子待办清单底部完全没有收起控件；备注区只有图标按钮，没有文字「收起」。
   于是用户不知道「再点一次同一入口」应该是收起（而实际它也不是）。
3. **状态不可见 / 无测试守**：chip 只有 `aria-expanded`，没有 ▾/▴ 或高亮；旧用例只给备注图标
   补了「再点收起」，subtask chip 没有任何收起断言，入口的只开不收一直没被门禁抓到。

另外确认了两件容易误判的事：

- **与 hover 无关**：`.wt-row-expand` 的挂载只看 `subtasksOpen` / `inlineNotesOpen` 两个 state，
  不在 `.wt-actions` 里，也不受 `onMouseLeave` 影响；鼠标移出行，展开区不会消失。
- **两区本来就独立**：`subtasksOpen` 与 `inlineNotesOpen` 是两个 state，收一个不会动另一个；
  本轮只是补上「显式收起」路径，并把这个性质写成用例。

## 2. 开关实现

改动都在 `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js` 的 `TodoRow` 内：

- `toggleSubtasks(event, { startAdding })`：chip 与「＋子待办」共用。
  - `subtasksOpen === true` → `collapseSubtasks()`；否则打开，入口路径顺手进入新增态。
  - 一律 `event.stopPropagation()`，不让点击冒泡到行。
- `toggleNotes(event)`：备注图标用；已展开再点 → `collapseNotes()`。
- `toggleNotesEntry(event)`：「添加备注」入口用；已展开再点 → 收起；否则 `startNotesEdit()`。
- `collapseSubtasks()` / `collapseNotes()`：只改自己的 state；收起时同时结束进行中的
  新增 / 改名 / 编辑，避免半截草稿留到下一次展开。
- chip 视觉：展开时加 `is-open` 高亮，并在 `2/3` 后渲染 `▾`（收起）/ `▴`（展开）的
  `aria-hidden` 提示；入口与备注图标展开时同样加 `is-open` 高亮。
- `aria-expanded` / `aria-controls`：chip、备注图标、两个入口、两个收起按钮全部带；
  `aria-controls` 分别指向 `wt-sub-<rowId>` / `wt-notes-<rowId>`。

## 3. 显式「收起」

- 子待办清单**底部**新增 `收起` 按钮（`data-wt-subtask-collapse`），**空清单也渲染**。
- 备注展开区**底部**同样新增 `收起`（`data-wt-notes-collapse`）；右上角 X 保留，两者走
  同一个 `closeNotes` 路径。
- 文案键 `collapsePanel`：中文 `收起`、英文 `Collapse`，两份客户端字典同步。
- 两个控件都是原生 `<button type="button">`，因此 Enter / Space 天然可切换，并带
  `aria-controls`。

## 4. 状态独立与不误触

- **独立**：子待办开 / 备注开可以同时成立；`collapseSubtasks` 只动 `subtasksOpen` 及其
  子状态，`collapseNotes` 只动 `inlineNotesOpen` / `notesEditing`，互不调用。
- **不误触**：所有开关与收起入口在事件入口先 `stopPropagation`；行本身没有 click，
  勾选与标题编辑分别是独立按钮，开关不会触发它们。用例断言：点 chip / 图标 / 入口 / 收起
  期间没有任何 `/worktodo/status` 或 `/worktodo/update` 请求，也没有出现标题编辑输入框。
- **与 hover 解耦**：只用 state 控制挂载，没有把展开区放进 hover 才显形的操作区。

## 5. 测试与反向验证

新增 5 条客户端用例（`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`，仍是 9 个测试文件，没有新增文件）：

| 用例 | 覆盖 |
|---|---|
| 展开/收起开关（双向） | chip 点开 → aria true + `is-open` + `▴`；再点 → 收起 + aria false + `▾`；备注图标同样双向 |
| 行尾入口也是开关；空清单可收 | 「＋子待办」点开进入新增态、再点收起；空清单底部「收起」可收；「添加备注」同样双向，备注区「收起」 |
| 子待办与备注互不干扰 | 同时展开，收备注不动子待办；再收子待办不动备注，两个 aria 各自正确 |
| 开关不误触 | 点 chip / 图标 / 收起不发 `/status`、`/update`，不进标题编辑，`stopPropagation` 被调用 |
| 无障碍 | chip / 图标 / 两个入口 / 两个收起都是原生 button，`aria-controls` 与展开区 `id` 一致 |

客户端套件从 98 条增至 **103 条，0 失败**。

### 反向验证（都实际跑过，确认变红后再恢复）

1. **把子待办开关改回「只展开」**：`if (false && subtasksOpen) ...` → `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`
   **EXIT=1**，双向用例红在「再点 chip 必须收起」，「入口也是开关」用例也红；恢复后 103/103 绿。
2. **把 `collapseSubtasks` 里的 `setSubtasksOpen(false)` 去掉**：显式收起失效 →
   `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs` **EXIT=1**，双向 / 入口 / 独立三条红；恢复后 103/103 绿。

## 6. 两套门禁

| 环境 | 命令 | 结果 |
|---|---|---|
| 本机 | `WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` | **12/12，EXIT=0** |
| 干净环境 | `env -i HOME=/tmp/cihome PATH=<node-bin>:/usr/bin:/bin CI=true node tools/verify-all.mjs` | **12/12，EXIT=0** |

构建产物 `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/client.js` / `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/client.js.map` 已随源码重新生成；门禁步骤数仍是 12（构建 + 11 个 suite）。

## 7. 未做 / 不确定

- **HEAD 的事实要写清楚**：进度 chip 与备注图标在 HEAD 上已经能双向切换；本轮不是把它们从
  「只开」修成「可收」，而是修好两个行尾入口、补显式收起与视觉提示，并用用例把 chip / 图标
  的收起行为锁住。若用户的现场版本来自更早的构建，升级到本构建后 chip 也不会再出现只开不收。
- 没有在真实浏览器 / 320px 视口目测；只做了结构、aria 与样式断言。
- 标题进入编辑态时备注图标仍然隐藏（原设计如此）；此时可用展开区底部「收起」或 Esc 收备注。
- 展开区关闭时 `aria-controls` 指向的 id 不在 DOM 中（面板关闭即卸载）；这是现有实现的取舍，
  未改成常驻隐藏容器。
- 显式「收起」会放弃正在输入的子待办 / 备注草稿（与 Esc 同一口径），没有二次确认。
- 未改版本号、CHANGELOG、`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/.github`；未提交、未打 tag、未发布。
