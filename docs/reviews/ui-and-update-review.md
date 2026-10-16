# 独立审查：面板体验（旗子/动效/勾选框）+ 自更新序列（两轮未提交改动）

> 审查对象：工作区未提交的两轮改动（第一轮 `docs/feature-row-priority-and-celebration.md`，
> 第二轮 `docs/review-auto-update.md`）。仓库根 = `~/Documents/deepseek-harness/default-workspace/dsh-worktodo`，
> 下文代码位置都是仓库内相对路径。本次审查**没有改动仓库源码**（审查前后 6 个被改文件的 sha256 逐一核对一致，
> `lib/client.js` 重新构建后字节未变），也没有触碰真实 `~/.dsh/profiles/*` 与用户数据：
> 所有实跑都在 `/tmp` 的假 profile / 假 pnpm / 假 `DSH_HOME` 上完成（另在 `/tmp` 整树副本里做回退验证）。
> Node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`（v24.21.0），
> 全程 `WORKTODO_NO_UPDATE_CHECK=1`。

**一句话结论：不能放行。** 第一轮（面板）可以放行（2 条中低优先级的 UI 缺陷 + 测试缺口）；
**第二轮必须先修 A1/A2/A3 三条**——profile `package.json` 的改写既不原子、超时又不回滚，
实测能在真实写失败下把用户的 profile 清单截断成**非法 JSON**，这正是「比不升级更糟」的那类事故。

| # | 级别 | 位置 | 一句话 |
| --- | --- | --- | --- |
| A1 | **严重（必须先修）** | `lib/index.js:471-489` | 非原子改写真实 profile `package.json`；写失败（ENOSPC/被杀）会把它截断成非法 JSON，DSH 起不来 |
| A2 | **高（必须先修）** | `lib/index.js:932`、`952-960` | 第 3 步 `pnpm install` 超时 → 精确规格**不回滚**，留在用户 profile 里 |
| A3 | **高（必须先修）** | `lib/index.js:471-489`、`284-292`、`953-959` | 回滚把「第一个字段的规格」写回**所有**字段；`devDependencies` 里的 `link:` 被静默冲掉 |
| A4 | 中高 | `lib/index.js:1035-1056`、`257` | 节流只在内存：**每次 DSH 启动**都重跑整条序列并重写真实 profile 两次，失败重试无上限 |
| A5 | 中 | `lib/index.js:334-364` | 反推不出 profile 时会改写**别的** profile（多 profile 实测） |
| B1 | 中 | `src/client/index.js:443-460`、`1507-1525` | 40px 命中盒纵向压进邻行，邻行在上层：点偏 1-7px → **改错条目** |
| B2 | 中低 | `src/client/index.js:1285`、`1326-1337` | 乐观完成态写成功后**永不回收**；数据变回 pending 时 UI 与真实状态反向 |
| B3 | 中低 | `src/client/index.js:1523`、`455-460` | 子元素 `animationend` 冒泡 → 行提前摘类，560ms 高亮/300ms 描边都被截断 |
| B4 | 低 | `src/client/index.js:1486-1502`、`1535-1548` | 拖拽行里的按钮：**与改动前同型，不是本轮回归**，风险低但无覆盖 |
| B5 | 低（提示） | `src/client/index.js:448`、`1543` | 横向 1px 余量（不盖标题）；`aria-haspopup="true"` 语义不精确 |

---

## A. 自更新（第二轮）

### A1【严重，必须先修】profile `package.json` 是非原子改写；写失败会把用户 profile 变成非法 JSON

- 位置：`lib/index.js:471-489`（写盘只此一处：`:488` `writeFileSync(file, ...)`，全仓库宿主半侧再无别的写入）。
- 现象：整个「改写规格」是 `readFileSync → JSON.parse → writeFileSync(同一路径)`：
  1. **没有临时文件 + rename**，也没有备份、没有 fsync；
  2. `writeFileSync` 先 `O_TRUNC` 截断再写，**任何中途失败/被杀都留下半个文件**；
  3. 出错时 `prepare()` 抛给 `runUpdateSequence`（`lib/index.js:915-920`）只记 `skipped:'pin-failed'`，
     **不会**把文件恢复（此刻 `pinned` 仍是 false，回滚分支根本不进）。
- 证据（实跑，`/tmp` 假 profile，非打桩的真实写失败）：用 `ulimit -f 1` 制造写失败
  （本机 node 得到 `EFBIG`，与磁盘写满 `ENOSPC` 是同一条 `write(2)` 失败路径）：

  ```
  ORIGINAL_BYTES=2183
    child: state=failed reason=pin-failed
  AFTER_BYTES=1024
  TAIL="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  JSON=INVALID -> Unterminated string in JSON at position 1024 (line 9 column 863)
  ```

  即：插件把「写失败」如实报进了一个没人会看的 `reason` 字段，而**用户的 profile 清单已经被截断**；
  下一次 DSH 启动解析该 profile 会直接失败。加上 A4（每次启动都重写两次），这个窗口是反复出现的。
- 最小修复建议（任一，建议 1+3）：
  1. 原子写：写 `package.json.worktodo-tmp` → `renameSync(tmp, file)`（同目录 rename 原子），
     失败时删 tmp；保留原文件 mode（`writeFileSync(tmp, text, { mode: st.mode })`）。
  2. 写前把原文件字节留一份内存/临时副本，写后立刻 `JSON.parse(readFileSync(file))` 自检，不合法就回填。
  3. 最好干脆**不写用户的 profile**：第 3 步改成 `pnpm install dsh-worktodo@<精确版本> --registry <源>`
     （或 `pnpm add --save-exact`），让包管理器自己维护清单——doc 里「写死成精确版本再 install」并不是唯一解。
- 备注：报告 `docs/review-auto-update.md` §4.3 只写了「存在覆盖风险（极小）」；实测后果比这句严重得多：
  不是「覆盖别人的改动」，而是**把这份清单写成语法非法的文件**。

### A2【高，必须先修】第 3 步 `pnpm install` 超时 → 精确规格不回滚

- 位置：`lib/index.js:932`（`if (result.timedOut) return;` 早退）与 `lib/index.js:952-960`（回滚分支）。
- 现象：`prepare()`（改写规格）在起子进程**之前**已完成；一旦这条命令超时被杀，
  `runUpdateStep` 的定时器已把状态收口成 `failed/timeout`，序列在 `:932` 直接 `return`，
  **永远走不到 952 行那段回滚**。error 文案也完全不提「规格已被改写」。
- 证据（实跑，假 pnpm 在 `install` 上 `sleep 5`，`updateTimeoutMs=700`，注入 latest=0.2.7）：

  ```
  state=failed reason=timeout
  error=升级超时（700ms）已终止
  steps=[..., {kind:'pin-exact-then-install', exitCode:null, timedOut:true}]
  ★ 超时后 profile 规格 = 0.2.7   ✗ 未回滚，留下了精确版本
  磁盘上 node_modules 版本 = 0.2.0
  ```

  同一早退也发生在「deadline 已耗尽」时（`Math.max(1, deadline - Date.now())` → 1ms 定时器），
  而 `prepare()` 仍会先把盘写掉。于是：镜像里没有 0.2.7 时，用户**下一次** DSH 启动的安装直接失败
  ——正是报告 §2.2 那句「比不升级更糟」想防的事，被最可能发生的路径（慢 install）绕过了。
- 最小修复建议：把「是否需要回滚」这件事从正常流程里拆出来，统一收尾：
  `try { ... } finally { if (updateRun.state !== 'done' && pinned && originalSpec) rollback(); }`
  （或把 `finishRun` 变成唯一出口、由它负责回滚；并把回滚结果写进 `steps`/error，超时路径也要带 `rollbackNote`）。

### A3【高，必须先修】回滚会把 `devDependencies` 里的 `link:` 冲成 registry 范围（数据损失）

- 位置：`lib/index.js:471-489`（`for (const field of ['dependencies','devDependencies'])` 同写）、
  `lib/index.js:284-292`（`readProfileDependency` 只取**第一个**命中的字段）、`lib/index.js:953-959`（回滚只用一个 `originalSpec`）。
- 现象：前进阶段会把两个字段一起钉成精确版本；回滚阶段又把两个字段一起写回「第一个字段的原值」。
  于是 `devDependencies.dsh-worktodo = "link:..."` 被改写成 `"^0.2.0"`——**用户本地的 link: 开发规格被静默改成 registry 范围**。
  而 `startUpdate` 的 linked 守卫（`lib/index.js:999-1004`）只看 `readProfileDependency` 返回的那一个（`dependencies` 优先），
  `devDependencies` 里的 `link:` 根本不会被拦住。
- 证据（实跑，`dependencies=^0.2.0` + `devDependencies=link:../../default-workspace/dsh-worktodo`，假 pnpm no-op）：

  ```
  初始:   deps=^0.2.0  dev=link:../../default-workspace/dsh-worktodo
  结束:   deps=^0.2.0  dev=^0.2.0
  devDependencies 里的 link: 是否被冲成 registry 范围: true
  ```

- 最小修复建议：pin/回滚都只作用于「真正决定本次安装的那个字段」（deps 优先，记录每个被改字段的**原值**分别回滚）；
  或任一字段是 `link:` 就整体跳过改写（与 linked 守卫同口径），并把这个事实写进 `reason`。

### A4【中高】节流只在内存：每次 DSH 启动都重跑序列并重写真实 profile 两次

- 位置：`lib/index.js:1035-1056`（`autoAttempted` 是 `apply()` 的闭包变量）、`:257`（本轮把 `autoUpdate` 默认改成 true）。
- 现象：报告说的「同一个新版只试一次」只覆盖**同一个进程生命周期**。内存状态一重启就没了：
  只要 registry 上仍比落盘版本新、而升级始终失败（镜像/规格原因），**每次 DSH 启动**都会：
  查一次 registry → 跑 `pnpm update` → 写 profile（pin）→ 跑 `pnpm install` → 再写 profile（回滚）。
  等于每次启动给 A1/A2 各开两个窗口，且重试次数无上限。
- 证据（实跑，两个进程模拟两次重启，同一份注入 latest=9.9.9，假 pnpm no-op）：

  ```
  第 1 次启动: state=failed reason=version-unchanged 累计子进程=2
      ★ 这次启动是否又写了 profile package.json: true（规格回到 ^0.2.0）
  第 2 次启动: state=failed reason=version-unchanged 累计子进程=4
      ★ 这次启动是否又写了 profile package.json: true（规格回到 ^0.2.0）
  ```

- 多实例/并发：写盘没有任何跨进程锁（宿主半侧除 `:488` 外无写文件操作），
  两个 DSH 实例同时自动升级会并发 `writeFileSync` 同一个 profile + 并发 `pnpm install` 同一份 `node_modules`。
  静态确认，未构造多实例实跑（会动到真实运行环境）。
- 最小修复建议：把「已试过的 latest + 结论」持久化（复用 store 或一个小状态文件），失败后指数退避；
  或至少**失败过就不再自动改盘**（只提示）。默认开（`autoUpdate: true`）本身是产品决定，可接受；
  但默认开 + 无跨重启节流 + 非原子写，是这次最危险的组合。

### A5【中】反推不出 profile 时会改写「别的」profile

- 位置：`lib/index.js:334-364`（`findProfileDir`：`WORKTODO_PROFILE_DIR` → 模块 URL → `$DSH_HOME/profiles/*` 取字典序第一个有依赖的）。
- 现象：`link:` 安装时模块 URL 反推不出 profile（既有设计），于是扫描兜底会挑到**字典序第一个**含本包依赖的 profile；
  本轮之前最坏是往那个目录跑一条 `add`，现在会**改写那个 profile 的 `package.json` 并 `pnpm install`**。
- 证据（实跑，`$DSH_HOME/profiles/{aaa:^0.2.0, zzz:link:...}`，运行的是仓库里的 link 安装，未设 `WORKTODO_PROFILE_DIR`）：

  ```
  子进程记录: INVOKE cwd=.../fakehome/profiles/aaa / update / dsh-worktodo / --registry ... 
             INVOKE cwd=.../fakehome/profiles/aaa / install / --registry ...
  ★ 被改写的 profile: aaa=true zzz=false
  ```

- 最小修复建议：反推不出 profile 时**不自动升级**（只提示），或至少让「需要写盘」的步骤要求用户显式触发；
  别把「跑一条 add」的旧兜底直接升级成「改一份别人的清单」。

### A6【已核实为安全】这几条是本轮做对的地方

- **原 profile 不是合法 JSON（含 `//` 注释）**：实跑 → `POST /update` 得到 `ok:false reason:not-installed`
  （`startUpdate` 先读规格，读不到就不进序列），**零子进程、文件字节与 mtime 完全未变**。安全。
- **profile `package.json` 只读（0444）**：实跑 → `failed/pin-failed`，error 明确写
  `改写 profile 规格失败：EACCES...`，文件字节未变、mode 未变，只跑了 1 个子进程。安全。
- **`link:` 安装零子进程、零写盘**：实跑（默认 `autoUpdate: true` + 注入 latest=9.9.9）→
  `reason=linked`、子进程数 0、profile 字节与 mtime 完全未变。安全（doc 的承诺成立）。
- **不误动用户数据**：宿主半侧唯一的写操作就是 `lib/index.js:488` 的 profile 改写，
  不碰 `$DSH_HOME/storages/worktodo.json`、`~/.dsh/worktodo/*`，也不碰其它 profile 的数据（A5 只涉及 `package.json`）。
- **其它依赖与键序保留**：实跑里 `other-dep`、键名恰好是 `"//"` 的注释式字段、`dsh` 嵌套块都原样保留（见 A7 的边界）。

### A7【低】「保留原缩进」只在缩进这一维成立

- 位置：`lib/index.js:480-488`（缩进用 `/\n([ \t]+)"/` 探测，其余交给 `JSON.stringify`）。
- 证据（实跑 5 种格式，走完整条序列后对比字节）：

  | 原格式 | 结果 |
  | --- | --- |
  | tab 缩进 | 71 → 71 字节，**完全一致** |
  | 3 空格缩进 | 80 → 80 字节，**完全一致** |
  | CRLF（Windows profile） | 83 → **77** 字节（行尾被换成 LF） |
  | 单行 JSON | 58 → **76** 字节（整份被展开成多行） |
  | 无尾换行 | 76 → **77** 字节（被补了一个 `\n`） |
- 影响：语义等价（键序、其它依赖都保留），但「回滚」并不是字节还原，而是按当前格式重新序列化；
  对 Windows 用户或单行清单是一次全文件改写。低危，配合 A1 一起修（定点文本替换）即可。

---

## B. 面板（第一轮）

### B1【中】勾选框 40px 命中盒纵向压进邻行，且邻行在上层 → 点偏就改错条目

- 位置：`src/client/index.js:443`（`width/height: 26px; margin: -3px 0 0`）、`:448`（`.wt-check::before { inset: -7px }`）、
  `:461`（`.wt-row { gap: 8px; padding: 5px 8px }`）。
- 现象（几何静态推断，本机无浏览器，未做像素命中测试）：
  - 勾选框对行高的贡献 = 26 + (−3) = 23px；只有标题的行（标题 ~16px，不决定行高）行高 = 23 + 10 = **33px**（旧版 28px，+5px，与 doc 一致）；
  - 命中盒 y = **[−5, 35]**（相对本行上沿），而下一行的命中盒上沿 = 33 − 5 = **28** → **重叠 7px**；
  - 两行的勾选框都是普通流内 `position: relative` 的按钮伪元素，按绘制顺序**后绘制的下一行在上层**，
    所以这 7px 的点击归**下一行**的勾选框；
  - 结论：**不是**「盖住标题」（横向 7px < 8px gap，右边距标题正好差 1px，见 B5），
    而是「本来点空白的误点」变成了「静默改错条目」——用户想勾第 N 条，点偏到勾选框下沿以下几像素，完成的是第 N+1 条。
    旧版 17px 无伪元素，同样误点只是空操作，所以这是本轮引入的行为变化。
  - 只要行高 < 40px 就有重叠（带 meta/备注的高行不重叠），而「只有标题」的行很常见。
- 证据：上面的数值来自 `CHECK_SIZE_PX/CHECK_HIT_PX/PADDING/GAP` 的算式（脚本输出：
  `视觉盒 y=[2,28]；命中盒 y=[-5,35]；下一行命中盒上沿=28 → 重叠 7px（HIT-row=7）`）。
- 最小修复建议：保证行距 ≥ 命中盒高度，再做 −7px 外扩——例如 `.wt-row { min-height: 40px }`
  （或 padding 改 `5px 8px` → `9px 8px`）；若不想改行高，就把纵向外扩收到 −3px（32×40 的目标）
  并保留横向 −7px；同时给伪元素加一层「不能越过行盒」的约束（`clip-path`/父级 `isolation`）以防未来再叠。
  **补一条真正的护栏测试**：断言行高（或其 CSS 常量）≥ `CHECK_HIT_PX`。

### B2【中低】乐观完成态写成功后永不回收 → 与真实状态反向时可被反向操作

- 位置：`src/client/index.js:1285`（`optimisticDone` 初值 null）、`:1295`（`done = optimisticDone ?? row.status === 'completed'`）、
  `:1326-1337`（只在 `ok===false`/reject 时 `setOptimisticDone(null)`）。
- 现象（静态确认，`setOptimisticDone` 全部出现处已逐一核对）：
  写成功路径**没有任何**清除乐观态的分支，于是这一行在这一组件实例存活期间恒渲染为「已完成」，
  无视后续 `refresh()`/轮询拿回来的 `status:'pending'`。用户看到勾是打上的，去点它想「取消完成」，
  `handleCheck` 会按 `done=true` 走 toggle → **服务端反而被置为 completed**：显示与真实状态反向。
  refresh 失败只会让这个窗口更久（doc §7.3 只承认「短暂显示为已完成」，实际不止短暂）。
- 最小修复建议：数据回来即回收（`React.useEffect(() => setOptimisticDone(null), [row.status, row.updatedAt])`
  或在 `runWrite` 的 refresh 完成后清），或给乐观态加一个 RTT 级别的自动过期；
  并在「乐观完成 + 数据为 pending」时不要把它当成取消操作。
- 顺带（同处）：`celebrate === false` 或 `prefers-reduced-motion` 命中时**连乐观态都不挂**，
  这两类用户点击后勾选框要等一个 RTT 才有反馈——与改动前一致，属刻意取舍，记录备查。

### B3【中低】子元素 `animationend` 冒泡，行提前摘庆祝类（560ms 高亮 / 300ms 描边都被截断）

- 位置：`src/client/index.js:1523`（行 `onAnimationEnd: () => setCelebrating(false)`）、
  `:455-460`（勾选框 320ms、描边 300ms + 80ms 延迟、行高亮 560ms）。
- 现象：`animationend` 是**冒泡**事件，React 的 `onAnimationEnd` 走同一套委托；行内勾选框的
  `wt-check-pop`（320ms）与描边（80→380ms）结束时事件都会冒到行 div，行的处理器在 **320ms**
  就把 `is-celebrating` / `wt-check-celebrate` 一起摘掉 →
  行高亮只跑到 320/560 = 57% 就被切成透明（视觉跳变），描边也在 320ms 被切断后瞬间吸附到完成态。
  这与 doc §2.1「整行高亮 560ms」「对勾描边 300ms」的承诺不符，也与 §2.1「没有布局跳动」之外的
  「观感就是设计的那样」不符。
- 证据：静态推断（事件冒泡语义 + 时间轴；本机无浏览器，未实测）。**测试无法区分**：
  现有用例是直接手调行自己的处理器（`tools/smoke-client.mjs:1719`），
  我在 `/tmp` 副本里把处理器改成只认 `currentTarget` 后客户端仍是 **49/49 全绿**（说明这条行为完全没被覆盖）。
- 最小修复建议：`onAnimationEnd: (e) => { if (e?.target === e?.currentTarget) setCelebrating(false); }`，
  或给行高亮单独包一层元素只监听它的 `animationend`；顺手补一条「子元素动画结束不得摘行类」的用例。

### B4【低】拖拽行里的旗子按钮：不是本轮回归，风险低，但无任何覆盖

- 位置：`src/client/index.js:1486-1502`（`draggable: true` + `onDragStart`，`sort` 默认 `'manual'`（`:1923`、`:794`）→ **默认可拖**）、
  `:1535-1548`（新的旗子 `<button>`）、`:1562-1572`（既有勾选框按钮）、`:1592-1603`（既有删除按钮）。
- 结论（静态确认 + 常识推断，本机无浏览器，未实测）：
  - 本轮**没有**新增或改坏任何 DnD 代码：旗子按钮与勾选框/删除按钮同型，它们**改动前就在** `draggable` 行里；
    行相关的 `draggable`/`onDragStart`/`onDragOver`/`onDrop` 一字未改；
  - 纯点击（按下即抬，不移动）仍会派发 `click` → 开四旗弹层，这条路径没问题；
  - 风险在于「按下后移动超过浏览器拖拽阈值」：HTML5 DnD 由最近的 `draggable` 祖先发起，
    此时 `click` 不派发、弹层不开，用户看到的是整行被拖动。**这是改动前就存在的行为**（勾选框/删除按钮同理），
    不是本轮引入的回归；误拖的后果可恢复（再点一次即可），所以定级「低」。
  - 另外确认：`dragAttrs` 里的 `style: dragging ? {opacity:.45} : undefined`（`:1500`）被后面的
    `style: rowStyle`（`:1507`、`:1525`）覆盖，而 `rowStyle` 已包含同样的 `opacity`，**没有丢样式**（这不是 bug）。
- 最小修复建议（可选，与本次放行无关）：给排序做 dedicated drag handle，或在 `mousedown` 记录起点、
  起点落在 `button/interactive` 上时在 `dragstart` 里 `preventDefault()`；无论修不修，
  都建议补一条真机（浏览器）手测记录，因为现有测试**完全没有**覆盖这个交互。

### B5【低 / 已核实】横向余量、键盘可达性、a11y

- **不盖标题（实测算式）**：命中盒左沿 23px vs 左侧旗子按钮右沿 22px（不重叠）；
  命中盒右沿 63px vs 标题左沿 64px（**恰好差 1px，不重叠**）。所以「点标题却切换完成」在横向上不成立；
  真正的误点风险是 B1 的纵向邻行重叠。
- **键盘可达性成立**：ghost 旗子 `opacity: 0` + `.is-ghost { pointer-events: none }`（`:497`）仍在 tab 序里；
  聚焦时行的 `onFocus` 冒泡把 `flagPeek` 置真 → 重新渲染去掉 `is-ghost`，按钮可见可点。
  客户端用例已覆盖「hover / focus 两条路都能现身」「点开四旗」「Esc 两条路都能关」「`aria-expanded` 跟随」。
- **`aria-pressed` 用对了**（四旗是 toggle）；**`aria-haspopup="true"`（等价 `menu`）语义不精确**——
  弹层是 `role="group"` 的一组按钮，建议省略或改 `aria-haspopup="dialog"`、或按 APG 用 `listbox`/`radiogroup`。低危 nit。
- **布局/降级核实**：三段动画只动 `transform`/`background`/`stroke-*`，行高只 +5px 且各行一致（无跳动）；
  `prefers-reduced-motion` 命中时 JS 连类都不挂，CSS 另有一层 `animation: none !important` 兜底；
  `celebrate === false` 时连乐观态都不挂，`done` 立即为 false（与改动前一致）——三条都实测/断言到位。
- **新功能真的能用（实跑）**：`POST /worktodo/update {ref, priority:'none'|'high'|'normal'|'low'}` 全部 `ok:true`
  且落库正确（`records.mjs` 的 `normalizePriority` 把 `'none'` 归一成 `'none'`，`PRIORITY_WEIGHT` 有 `none: 3`，
  排序权重生效）；`isPluginUpdateRequest({ref,priority})` 判为「改待办」，**不会被升级劫持**。

---

## C. 回归与测试牙齿

### C1 全量 + 既有宿主不变量

- `node tools/verify-all.mjs` → **10/10 通过（含构建）**；分项：客户端 49 通过 / 0 失败，
  宿主 67 通过 / 0 失败，契约 18 通过 / 0 失败。
- 抽查上一轮修过的宿主不变量用例，逐个确认仍在且绿（都在 9 个 suite 里，随全量一起跑）：
  - 存储不静默降级：`tools/verify-store.mjs:629`（二次挂载不降级、不丢数据）、`:960`（`open` 永不 resolve → 3s 超时降级并告警）；
  - `updateOrder` 只写一次：`tools/verify-service.mjs:486`（断言 `calls.updateOrder === 1`，校验失败时为 0）；
  - 路由注册兜底与挂载超时：`tools/smoke-host.mjs:931`（第 N 条路由注册抛错 → `apply` 不 reject、卸载清干净、可再挂载）、`:974`（`storageDomain.open` 永不 resolve → 超时后仍完整挂载）；
  - `shapes` 语义与 `projects` 随形状下发：`tools/smoke-client.mjs:927`、`tools/smoke-contract.mjs:414-429`；
  - 既有自升级用例（link / 并发 / 非 0 退出 / 超时 / 不阻塞 / 空体 / CLI argv / 模块路径反推 / `ref` 改待办）全部保留且绿。
  → **未见回归**。
- 两次报告里的计数与结论核对无误（客户端 41→49、宿主 59→61→67、契约 18、10/10）。

### C2 反向验证（在 `/tmp` 整树副本里做，副本已恢复；真实仓库 sha256 未变）

有牙齿的部分：

| 回退 | 结果 | 变红的用例 |
| --- | --- | --- |
| 删掉失败后的规格回滚（`lib/index.js:952-960`） | 66 通过 / **1 失败** | 正是「no-op → failed + 已回滚」核心用例 |
| 把每步校验退化成 `installedVersionChanged = Boolean(after)` | 64 通过 / **3 失败** | 三条核心升级用例（no-op 会被错报 `done`） |
| 删掉客户端 `setCelebrating(true)` | 48 通过 / **1 失败** | 「勾选完成的动效」用例 |

**牙齿缺口（实测，这是本节最重要的结论）**——把本轮最严重的三条分别修好，测试**一条都不红**：

| 修复尝试 | 结果 |
| --- | --- |
| 把 `pinProfileDependency` 改成原子写（临时文件 + rename，即修 A1） | 宿主仍 **67 通过 / 0 失败** |
| 给超时路径补上规格回滚（即修 A2） | 宿主仍 **67 通过 / 0 失败** |
| 行 `onAnimationEnd` 只认 `currentTarget`（即修 B3） | 客户端仍 **49 通过 / 0 失败** |

也就是说：**本轮最危险的三条行为（写坏真实 profile / 超时留精确规格 / 动画被截断），现有测试完全没有牙齿。**
建议补的用例（按优先级）：① 写失败后 profile 必须仍可 `JSON.parse`（可用只读/写失败注入）；
② 第 3 步超时后规格必须回到原值；③ `dependencies` + `devDependencies` 同时存在（含 `link:`）不得被冲掉；
④ 不设 `WORKTODO_PROFILE_DIR` 的多 profile 不得改写非运行 profile；⑤ 子元素 `animationend` 不得摘行类；
⑥ 行高/命中盒几何 ≥40px（需要浏览器或布局引擎，至少先把常量关系断言住）。

### C3 恒真断言检查

- 没有发现「永远为真」的断言。新用例里的弱断言是「存在性/常量复述」类：
  `eq(typeof mod.priorityColor, 'function')`、`eq(Array.isArray(defaults.steps), true)`、
  `eq(report.hit >= 40, true)`（与 `CHECK_HIT_PX` 同源，只能证明常量 ≥40）、
  `eq(mod.STYLE_TEXT.includes('320ms') && ...)`（样式文本存在性）。
  它们不制造假绿，但也挡不住行为回归——真正的问题是 C2 列的覆盖缺口，不是假绿。
- 另外记录一处**反向脆弱**：若干断言把错误文案钉成字面串（`'镜像缓存'`、`'版本未变'`、`'回滚'`），
  以后改文案会红；这是刻意的「文案契约」，可以接受。

---

## D. 结论与放行建议

1. **第一轮（面板）可以放行**：核心交互与协议都实测通过（四旗写库、`none` 往返、键盘可达、三层降级、
   勾选框尺寸/焦点环），问题只有 B1（点偏改错条目，中）与 B2/B3（中低，观感/一致性），建议 B1 在同批修掉。
2. **第二轮（自更新）必须先修 A1/A2/A3 再放行**：
   - A1：把「改写用户 profile」变成原子写（临时文件 + rename）并自检，或干脆不写文件（命令行传精确版本）；
   - A2：超时/任何早退路径都必须走统一收尾并回滚规格；
   - A3：只改真正生效的那一个字段，或遇 `link:` 整体跳过；
   - A4/A5 建议同批处理（跨重启节流、反推不出 profile 就别动盘）。
3. **文档口径需要更新**：`docs/review-auto-update.md` §2.2 的「额外安全阀」只在
   `exit-nonzero` / `version-unchanged` 两条路径成立，超时与写失败两条路径绕过了它（A1/A2 实测）；
   §4.3 对非原子写的后果低估了（实测是「profile 变非法 JSON」，不是「极小覆盖风险」）。

---

# 修复状态（A1–A5 / B1–B3）

> 修复轮次：本轮。改动文件：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`、
> `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`（+ 重建 `lib/client.js`）、
> `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs`、
> `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`。
> 测试套件仍是 **9 个**（没有新增测试文件）。
> **未改**版本号 / `CHANGELOG.md` / `.github`；**未** commit / push / tag / 发布。
> 全部实验都在 `/tmp` 的假 profile + 假 pnpm + 临时 `DSH_HOME` 上完成；
> 真实 `~/.dsh/profiles/*` 与真实待办数据未被读写（见文末「真实环境核对」）。

## 0. 一句话

**A1 按审查给出的首选方案修掉了**：插件**不再手写任何 profile JSON** —— 升级第 3 步改成
`pnpm add dsh-worktodo@<精确版本> --save-exact --registry <源>`，规格改写与格式维护交给 pnpm；
插件对 profile 只剩**一处**写操作：失败时把原清单**逐字节还原**（原子写：同目录临时文件 → `fsync` → `rename`，
且自己循环 `write(2)` 并校验进度）。A2/A3 由同一个「事务收尾」保证，A4/A5 各自独立。

| # | 状态 | 一句话结果 |
| --- | --- | --- |
| A1 | ✅ 已修（首选方案 + 残留写路径加固） | 不再手写 profile；还原走原子写；写失败**不再可能**留下非法 JSON（实测 ulimit -f 1） |
| A2 | ✅ 已修 | `finally` 统一收尾：超时/异常/非 0 退出/版本未变，全部回滚并在 `error`+`steps[]` 写明 |
| A3 | ✅ 已修 | 回滚是「原始字节」，段位/协议值/缩进/键序原样；任一段位 `link:`/`file:`/`workspace:` 整体跳过 |
| A4 | ✅ 已修 | `$DSH_HOME/worktodo/update-state.json` 持久化「已试过的 latest」，第二次启动零子进程零写盘 |
| A5 | ✅ 已修 | 只认「本实例自己所在的 profile」；反推不出 → `profile-not-found` + 零写盘 |
| A6 | ✅ 保持 | 既有安全行为未回退（非 JSON profile / 只读 profile / `link:` 都仍零子进程零写盘） |
| A7 | ✅ 顺带解决 | 插件不再序列化 profile，格式由 pnpm 自己维护；回滚是字节还原 |
| B1 | ✅ 已修 | 行高 44px、命中盒 40×40、**零重叠**（4px 间隙）；护栏从样式表原文解析数值 |
| B2 | ✅ 已修 | 乐观态绑定「点击那一刻的数据对象」，数据一换新引用即回收；方向不再反向 |
| B3 | ✅ 已修 | 只处理 `event.target === event.currentTarget`（并校验 `animationName`） |
| B4/B5 | ⏸ 未做 | B4 不是本轮回归、需真机浏览器手测；B5 是 nit。见「未做项」 |

---

## A1【严重】不再手写 profile JSON；残留的还原路径是原子写

**修法（首选方案，`lib/index.js`）**

1. 第 3 步从「自己改写规格 + `pnpm install`」改成 **`pnpm add dsh-worktodo@<target> --save-exact --registry <源>`**
   （`buildUpdateSteps` 的 `kind` 由 `pin-exact-then-install` 变为 `pnpm-add-exact`，`prepare` 副作用整个删掉）。
   不再有「把猜测出来的 JSON 写回用户 profile」这条路径，A1/A3 的整类事故从根上消失。
2. 插件唯一剩下的 profile 写操作是**还原**（`createProfileJournal().rollback()`），它走新的
   `writeFileAtomicSync(file, text, {mode})`：同目录临时文件（`wx`，保留原 mode）→ 循环 `write(2)` 并校验进度 →
   `fsync` → `rename`。任何失败只会影响临时文件并把它清掉，**目标文件一个字节都不动**。
3. **诊断先于写盘**：`readProfileManifest()` 读不到或 `JSON.parse` 失败时 `ok=false`，调用方立刻
   `failed/not-installed` 返回，**零写盘**（旧实现会在解析失败后继续走到写路径）。
4. **写后自检**：还原后重新读回并与原始字节比对，不一致就报「回滚失败，请人工检查 <path>」。
5. 顺带解决的隐蔽坑（实现过程中被新用例抓住）：`fs.writeSync(fd, string)` 只做**一次** `write(2)`，
   超出 `RLIMIT_FSIZE` / 磁盘满时它会**成功地只写一半**（本机 `ulimit -f 1` 实测返回 `1024/2003` 且不抛错）。
   第一版原子写因此把「被截断的临时文件」rename 了上去 —— 改成循环 + 进度校验后才真正安全。

**测试（`tools/smoke-host.mjs`）**

- ① `A1（严重）：写盘失败（ulimit -f，等价 ENOSPC）时 profile 仍是合法 JSON…`：把整条序列放进
  `sh -c 'ulimit -f 1; exec node tools/smoke-host.mjs --selfupdate-writefail-child'` 子进程（**真实 fs 失败**，
  不是打桩）。假 pnpm 在 `add` 时把清单换成一份小的合法 JSON → 序列失败 → 事务收尾要还原 2KB 原文 → `EFBIG`。
  断言：盘上文件**仍是合法 JSON**、逐字节等于 pnpm 写下的内容（插件没有截断它）、`state=failed`、
  `error` 含「回滚失败，请人工检查」、`steps` 里有 `ok:false` 的 `rollback-profile-spec`。
- ② `A1：pnpm 把清单写成非法 JSON 且版本已换 → 插件逐字节还原原清单`：外部把文件写坏时也要自愈。
- ③ `A1：writeFileAtomicSync 失败不动原文件 / 成功无残留 / 保留权限`：成功路径无临时文件残留、mode 保留；
  **目标目录只读**时 `openSync(tmp,'wx')` 失败 → 原文件必须原样（裸 `writeFileSync` 会改写它，因为写已存在文件不需要目录写权限）。

**反向验证（`/tmp` 整树副本，脚本把 `writeFileAtomicSync` 整个换回裸 `writeFileSync(file, text)`）**

```
反向验证 A1：原子写改回裸 writeFileSync（临时文件 + 循环写 + rename 全去掉）
  exit=1  变红 2 条：
  ✗ A1（严重）：写盘失败（ulimit -f…）时 profile 仍是合法 JSON、绝不被截断；状态 failed 且明说回滚失败
  ✗ A1：writeFileAtomicSync 失败不动原文件 / 成功无残留 / 保留权限
```
即：**这条用例对「裸 writeFileSync」有牙齿**（旧实现在此留下 1024 字节的非法 JSON）。

## A2【高】统一收尾：任何终止路径都回滚，并写进 `error`/`steps[]`

**修法**：把整个序列包进 `try { … } finally { settleTransaction(); }`，`settleTransaction` 是**唯一出口**：

- `updateRun.state !== 'running'` 早退（超时路径由定时器提前收口）→ `finally` 仍然执行 → 回滚；
- 正常失败（`version-unchanged` / `exit-nonzero` / `spawn-failed` / 内部异常）→ 回滚；
- 只有 `state === 'done'` **且**清单仍是合法 JSON 时才保留 pnpm 写下的新规格（并记一步
  `profile-manifest`：「规格由 pnpm 原子改写并保留（版本已真的换掉）」）；
- 未改动盘时记 `rollback-profile-spec` + `skipped:'not-modified'` + 「未改写 profile 规格，无需回滚」（显式说明，而不是沉默）；
- 回滚成功 → `error` 追加「已回滚 profile 规格（逐字节还原 package.json）」；失败 → 「回滚失败，请人工检查 <path>：<原因>」，
  且若此前已 `done` 则降级为 `failed/rollback-failed`。

**测试**：`A2：第 3 步 pnpm add 挂起到超时 → 规格逐字节回滚，error/steps 明确写「已回滚」`
（假 pnpm 在 `add` 里先把规格写成 `0.2.7`、再 `sleep 5`；`updateTimeoutMs=800`）。断言超时后
规格回到 `^0.2.0`、文件**逐字节等于**改动前、`error` 含「回滚」、`steps` 有 `ok:true` 的回滚步骤、node_modules 仍是 `0.2.0`。

**反向验证**：把 `finally { settleTransaction(); }` 换成空实现 →

```
反向验证 A2：去掉统一收尾的 finally（超时/早退路径不回滚）   exit=1  变红 6 条
  ✗ A2：第 3 步 pnpm add 挂起到超时 → 规格逐字节回滚…（+ 5 条依赖回滚的用例）
```

## A3【高】按原键位/原字节还原；任一段位是本地协议就整体跳过

**修法**

1. 事务只记**原始字节**（`createProfileJournal().original`），还原即原始文件本身 —— 比审查建议的
   `{section, key, rawValue}` 三元组更强：段位、`link:`/`file:`/`workspace:` 协议值、缩进、CRLF、键序全部原样回来。
   `readProfileSpecEntries()` 仍保留（导出、供诊断与守卫），但回滚不再「按字段重写」。
2. `startUpdate` 的守卫改成「**任一**段位命中本地协议就整体 `linked`」（旧守卫 `readProfileDependency` 只看第一个命中的字段），
   `error` 里明确写出是哪个段位、原值是什么。

**测试**

- `A3：dependencies 与 devDependencies 同名不同值 → 回滚逐字节还原原文件`：`dependencies=^0.2.0` +
  `devDependencies=~0.1.0`，假 pnpm 把两段都改成 `0.2.7` → 断言回滚后**逐字节等于原文件**、
  `devDependencies` 仍是 `~0.1.0`（旧实现会把 `^0.2.0` 写进去）。
- `A3：任一段位是 link:/file:/workspace: 就整体跳过`：`dependencies=^0.2.0` + `devDependencies=link:…` →
  `reason=linked`、零子进程、文件逐字节不变、`error` 里出现 `devDependencies`。

**反向验证**：把回滚改回「第一个命中的原值写进所有段位」（并 `JSON.stringify` 重写）→ `exit=1`，4 条变红（含两条 A3）。

## A4【中】跨重启节流：把「已试过的 latest」原子写进插件自己的状态文件

**修法**

- 状态文件默认 `$DSH_HOME/worktodo/update-state.json`（`resolveUpdateStatePath()`，纯函数、导出供单测），
  可用 `WORKTODO_UPDATE_STATE_PATH` 覆盖（测试缝）。**不写**用户待办数据文件（`storages/worktodo.json` / `worktodo/todos.json` 都不碰）。
- `maybeAutoUpdate` 里 `attempted = autoAttempted ?? persistState.attempted`；命中后**先原子落盘**（`result:'started'`）
  再 `startUpdate()`，结束后回写 `result`。这样进程被杀/崩溃也不会在下次启动重试同一个版本。
- 读取在 `apply()` 中 `void refreshUpdate()` **之前** `await`，否则启动那次 tick 看不到上次记录、又会重跑一遍。
- 文件缺失/损坏 → `readPersistedAttempt` 返回 `null`（安全地当作「没试过」）。

**测试（3 条）**

- `A4：跨重启节流 —— 第二次「启动」同一 latest 时零子进程、零写盘`：同一个状态文件路径上跑**两次** `apply()`
  （= 两个进程生命周期），第一次 2 个子进程 + 写入 `attempted=9.9.9`，第二次断言**子进程数不变、清单字节与 mtime 都不变**、状态停在 `idle`。
- `A4：节流状态文件损坏/缺失时安全地当作「未尝试过」`：先写一份坏 JSON → 仍然照常升级（2 次），且状态文件被修好。
- `A4：节流状态文件默认落在 $DSH_HOME/worktodo/update-state.json`（不是待办数据文件）。

**反向验证**：`attempted` 只看内存（去掉 `persistState.attempted`）→ `exit=1`，`A4：跨重启节流…` 变红。

**测试隔离踩坑记录**：A4 第一版实现后跑 `smoke-host`，自动升级用例把节流状态写进了**真实** `~/.dsh/worktodo/update-state.json`
（因为这个路径来自 `resolveDshHome()`，而多数更新用例并没有把 `DSH_HOME` 指到临时目录）。
已删除该文件（恢复原状：该目录只剩用户原有的 `todos.json.bak-*` / `todos.json.migrated-*`），并在
`tools/smoke-host.mjs` 顶部把 `WORKTODO_UPDATE_STATE_PATH` 全局指到一个临时文件做兜底，再在需要持久化的用例里逐例覆盖。

## A5【中】只改「本实例自己所在的 profile」

**修法**：`findProfileDir()` 现在只认两条精确信号 —— `WORKTODO_PROFILE_DIR`（显式覆盖/测试缝）→
本模块自身路径 `…/profiles/<name>/node_modules/dsh-worktodo/lib/index.js`。
**删掉**了「扫 `$DSH_HOME/profiles/*` 取字典序第一个依赖了本包的目录」与 `desktop` 兜底（`readdirSync` 导入一并移除）。
反推不出 → 返回 `null` → `startUpdate` 以 `profile-not-found` 收口，`error` 明确写「为避免改写别的 profile，已放弃升级且未做任何写操作」。

**测试**：`A5：反推不出本实例 profile 时零写盘 —— 绝不改写 $DSH_HOME/profiles 里别的 profile`
（`$DSH_HOME/profiles/{aaa:^0.2.0, zzz:link:…}`、不设 `WORKTODO_PROFILE_DIR`、注入 latest=9.9.9）→
断言 `reason=profile-not-found`、**零子进程**、两个 profile 的 `package.json` 逐字节不变、`aaa` 的 mtime 不变。

**反向验证**：恢复旧的扫描兜底 → `exit=1`，该用例变红（复现审查里「`aaa` 被改写」的结果）。

## B1【中】命中盒不再压进邻行

**最终几何**（由 `checkHitGeometry()` 计算，并由测试**从 `STYLE_TEXT` 原文解析数值**后重算）：

| 量 | 值 |
| --- | --- |
| 行高下限 `.wt-row { min-height }` | **44px**（旧 33px） |
| 勾选框视觉盒 | 26×26px，相对本行上沿 y = **[2, 28]** |
| 命中盒（`::before inset: -7px`） | 40×40px，相对本行上沿 y = **[−5, 35]** |
| 下一行命中盒上沿 | 44 − 5 = **39** |
| 纵向重叠 | **0px**（间隙 4px） |

为什么取 44 而不是审查建议的 40：40 时下一行命中盒上沿 = 35，与本行命中盒下沿**正好贴边**，
边界那 1px 仍会被后绘制的下一行吃掉；44 同时对齐常见的 44px 触控目标。横向不变（`-7px`，命中盒宽 40px）。

**测试**：`B1（护栏）：行高 ≥ 命中盒高度，相邻两行的勾选框命中盒零重叠 —— 数值从样式表原文解析`。
不是复述常量：它从 `.wt-row { … }` / `.wt-check { … }` / `.wt-check::before { … }` 抠出
`min-height` / `padding` / `margin` / `width` / `inset` 再算一遍，并断言与 `checkHitGeometry()` 一致。
运行输出：`行高 44px / 视觉盒 26px / 命中盒 40×40px（y=[-5,35]）/ 下一行命中盒上沿 39 / 重叠 0px / 间隙 4px`。

**反向验证**：`ROW_MIN_HEIGHT_PX = 33` → `exit=1`，该用例变红（overlap = 7px）。

## B2【中低】乐观完成态在数据回来后回收，方向不再反向

**修法**：乐观态绑定**点击那一刻的数据对象**：

```js
const [optimisticDone, setOptimisticDone] = React.useState(null);
const [optimisticFor, setOptimisticFor] = React.useState(null);
const optimisticActive = optimisticDone !== null && optimisticFor === todo;
const done = (optimisticActive ? optimisticDone : null) ?? row.status === 'completed';
```

`handleCheck` 挂乐观态时 `setOptimisticFor(todo)`；写失败/reject 时两者一起清。`refresh()`/轮询拿回新对象后
引用不再相等 → 乐观态自动失效、以服务端数据为准（数据为 `pending` 时 `done=false`，
勾选框语义回到「标记完成」，点击方向就是 completed —— 不再出现「显示已完成，点一下反而把它完成」）。
只认**引用**而不是比较 `status/updatedAt` 的值，是为了覆盖「服务端把状态改回 `pending` 但 `updatedAt` 恰好没变」这种最坏情况。
写成功到 refresh 落地之间（一个 RTT）乐观态仍然有效，所以不会闪一下未完成。

**测试**：`B2：乐观完成态在服务端数据回来后必须回收（引用一变即失效），数据为 pending 时点击方向是「完成」` ——
点击后立刻是已完成（挂 `wt-check-done` + 弹跳类）→ 换成新的 pending 数据对象重渲染 →
断言不再 `wt-check-done`、`aria-label` 回到「标记完成」、再次点击的报文是 `{ref:'wt-1', toggle:true}`。
同时断言短动效可以跑完（B3：不因数据回来被提前摘类），并由 `onAnimationEnd` 自己摘掉。

**反向验证**：`const done = optimisticDone ?? row.status === 'completed'`（永不回收）→ `exit=1`，该用例变红。

## B3【低】`animationend` 只认 `currentTarget`

**修法**：

```js
onAnimationEnd: (event) => {
  if (!event || !event.currentTarget || event.target !== event.currentTarget) return;
  if (typeof event.animationName === 'string' && event.animationName && event.animationName !== 'wt-row-celebrate') return;
  if (celebrating) setCelebrating(false);
},
```

**测试**：`勾选完成的动效…` 用例现有断言全部保留，并新增两条 —— 子元素事件
（`{target: 勾选框, currentTarget: 行, animationName:'wt-check-pop'}`）不得摘掉行高亮；无事件对象的裸调用也不得摘。
之后再断言行自己的 `wt-row-celebrate` 事件才摘类。

**反向验证**：改回 `onAnimationEnd: () => { if (celebrating) setCelebrating(false); }` → `exit=1`，该用例变红。

---

## 反向验证汇总（在 `/tmp` 整树副本里做；真实仓库未参与）

副本基线先跑一遍确认全绿，然后逐条把修复改回旧行为，要求对应套件**非 0 退出**且目标用例出现在 `✗` 列表：

| 反向改动 | 套件 | 结果 | 命中 |
| --- | --- | --- | --- |
| A1：`writeFileAtomicSync` 换回裸 `writeFileSync` | smoke-host | exit 1，2 条红 | ulimit 写失败用例 + 只读目录单测 |
| A2：`finally` 不再调用 `settleTransaction` | smoke-host | exit 1，6 条红 | A2 超时回滚用例 |
| A3：回滚改回「第一个原值写所有段位」 | smoke-host | exit 1，4 条红 | A3 逐字节还原用例 |
| A4：`attempted` 只看内存 | smoke-host | exit 1，1 条红 | A4 跨重启节流用例 |
| A5：恢复 profiles 扫描兜底 | smoke-host | exit 1，1 条红 | A5 零写盘用例 |
| B1：行高改回 33px | smoke-client | exit 1，1 条红 | B1 几何护栏 |
| B2：乐观态永不回收 | smoke-client | exit 1，1 条红 | B2 用例 |
| B3：不校验 `currentTarget` | smoke-client | exit 1，1 条红 | 勾选完成的动效用例 |

**9/9 全部按预期变红** —— 审查 C2 里「修了 A1/A2/B3 仍全绿」的牙齿缺口已补齐。

## 测试与全量结果

- `node tools/verify-all.mjs`（会先 build）→ **10/10 个步骤通过（含构建）**。
- 分项：宿主 **77 通过 / 0 失败**（审查基线 67）、客户端 **51 通过 / 0 失败**（审查基线 49）、契约 18、
  数据模型 35、服务层 31、存储层 37、CI workflow 11、发布面审计 17。
- 测试套件数不变（9 个）；没有联网（全程 `WORKTODO_NO_UPDATE_CHECK=1` + 假 pnpm/假 CLI）。

## 未做项与剩余不确定

1. **B4（拖拽行里的按钮）**：确认不是本轮回归（同型按钮改动前就有），需要真机浏览器手测才能定论 —— 本轮未做。
2. **B5（`aria-haspopup="true"` 语义）**：nit，未做。
3. **真机像素命中测试**：B1 是**静态几何断言**（从样式表原文解析数值），没有浏览器布局引擎参与；
   「行高 44px / 命中盒 40×40 / 重叠 0」是算式结论，仍建议真机点一遍确认。
4. **多实例并发没有跨进程锁**：两个 DSH 实例同时自动升级同一 profile 时，A 实例的「失败回滚」理论上可能
   盖掉 B 实例刚写下的成功规格（B 实例随后会看到版本已变、一般不会回滚）。窗口比旧实现小得多
   （插件不再手写规格，`pnpm add` 自带并发处理），但**没有**加锁；要彻底解决需要 profile 级锁文件，本轮未做。
5. **宿主进程被 SIGKILL**：进程内任何方案都无法在那一刻回滚（本轮能捕获的是超时、异常、非 0 退出、版本未变、spawn 失败）。
   缓解：A4 的持久化保证**不会在下次启动重试同一个版本**，且 pnpm 自己的清单写入是原子的（不会留下非法 JSON）。
6. **`docs/review-auto-update.md` 的口径**：§2.2/§4.3 的描述已被本轮实现取代（第 3 步不再是 `pnpm install`、
   也不再手写规格）。按「不改 CHANGELOG」的要求本轮没有改它，建议随发布一并更新。
7. **真实环境核对**：`~/.dsh/worktodo/` 只剩用户原有的 `todos.json.bak-20261013-*` 与 `todos.json.migrated-20261013-*`；
   `~/.dsh/profiles/desktop` 未被访问（mtime 仍是本轮之前）；本轮所有 profile/DSH_HOME 实验都在 `/tmp`。
