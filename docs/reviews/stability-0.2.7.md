# dsh-worktodo 0.2.7 稳定性审查

> 审查对象：`HEAD=90975af`、tag `v0.2.7`、工作区干净。
> 审查范围：`git diff v0.2.6..v0.2.7`（`lib/index.js` 626 行、`src/client/index.js` 73 行，其余为文档/测试）。
> 约束：未改仓库源码；所有实验在 `/tmp` 假 profile / 临时 `DSH_HOME` / `HOME` 下完成；未联网（本地假 registry、假 CLI、假 pnpm）；未读写真实 `~/.dsh/profiles/*`。

**一句话结论：0.2.7 的 Windows 修复方向是对的（自带 pnpm 路径、CLI 定位、node+ELECTRON_RUN_AS_NODE 都已在本机用真实 DSH 安装目录验证可执行；只验证到 `--version`，没跑真实安装），但这一版不能原样发布：新加的 win32 `unlink → rename` 回退在二次 rename 失败时会把目标文件（可能是 profile 的 `package.json`）彻底删掉；同时 0.2.7 让 pnpm 兜底第一次真正可执行，把原本「点不动」的启动期自动安装、孤儿进程、并发写 profile、回滚只回 `package.json` 不回 `pnpm-lock.yaml` 这几条旧风险全部激活了。建议先修第 1 节表里「必须先修」的 6 条再发。**

---

## 0. 先纠正一个前提

`autoUpdate` 默认 `true`、`autoInstall` 默认 `true` **不是 0.2.7 引入的**：

```
$ git show v0.2.6:lib/index.js | grep -n "autoUpdate = \|autoInstall = "
311:  const autoUpdate = config?.autoUpdate !== false;
312:  const autoInstall = config?.autoInstall !== false;
```

0.2.7 没有改这两行。0.2.7 改的是**执行器**：`resolvePnpmUpdater` 原来只找
`<resources>/runtime/pnpm/bin/pnpm.mjs`（真机上不存在），于是永远退回 PATH 上的裸 `pnpm`；
0.2.7 改成 `<resources>/runtime/<runtime-name>/dependencies/pnpm/bin/pnpm.mjs`。

所以风险性质变了：

- 0.2.6：Windows 上自动安装**根本起不来**（`spawn('pnpm')` → `ENOENT`），是「点不动」；
  macOS 上 pnpm 兜底只是「PATH 上碰运气」（dev 机器可能恰好有 pnpm）；
- 0.2.7：同一个自动安装**第一次真的会跑 pnpm/CLI、真的改 profile**，是「会执行」；
  尤其是 Windows：CLI 若 no-op/失败，pnpm 兜底从必失败变成必定能起（自带 pnpm.mjs）。

因此下面 A/B/C 里凡是标了「0.2.7 激活」的条目，机制是旧的，但**可触发性是 0.2.7 新给的**。

---

## 1. 结论与发布建议

### 必须先修（发布阻断）

| # | 条 | 一句话 |
|---|---|---|
| 1 | §3.3 C1 | win32 原子写回退「先删目标、二次 rename 失败」→ 原文件（含 profile `package.json`）**直接消失** |
| 2 | §3.2 B1 | 超时只 `child.kill()`，孙进程存活并继续写 profile；进程树没有被杀 |
| 3 | §3.2 B2 | dispose/卸载不取消在飞的检查/下载/安装；实测**卸载后仍会起子进程并改 profile** |
| 4 | §3.2 B3/B4 | 没有跨进程锁；CLI 的 active-run/兼容性拒绝被当成「这一步失败」，随后**降级为直接 pnpm 写 profile** |
| 5 | §3.3 C2 | 失败回滚只逐字节还原 `package.json`，`pnpm-lock.yaml` 留在新规格 → profile 三方不一致 |
| 6 | §3.1 A1/A2 | 启动期自动安装（默认 `autoInstall:true`）在 apply 返回后约 50ms 起子进程；首次无 `update-state.json` 也会尝试。建议默认只下载 + 延后检查 |

### 同批建议修（不阻断，但成本很低）

- 失败诊断 `diagnostics` 已经做了上限，没问题；但两处 `void refreshUpdate()`（`lib/index.js:1642`、`:2791`）没有 `.catch`，属于后台 unhandled rejection 的潜在入口。
- `profileDirFromModuleUrl` 从 `lastIndexOf` 改成 `exec`（第一个匹配），在「嵌套 `node_modules/dsh-worktodo/.../node_modules/dsh-worktodo`」路径上会把外层目录当成 profile（实测见 §3.3 C6）。
- 下载暂存区只增不删（每个版本留一个 `manifest.json`；失败安装会留整包），没有 GC。

### 可以确认没有问题的

- apply 本身不阻塞：无更新检查时中位 **0.08ms**（0.2.6 为 0.07ms）；有启动检查时 **20–35ms**，慢 registry 1.5s 也只让后台阶段停在 `checking`，apply 早已返回。
- 子进程没有 inherit 宿主 stdout/stderr（`stdio: ['ignore','pipe','pipe']`），`windowsHide: true`，超时定时器 `unref`。
- 32MiB 上限覆盖「声明了」和「没声明 content-length」的流式下载；5 种失败路径都做到「暂存区零残留」。
- Electron 下 `process.execPath + ELECTRON_RUN_AS_NODE=1` 不会误起第二个 GUI：本机用真实 DSH 二进制跑自带 pnpm 得到 `11.28.5`、退出码 0，无多余 GUI 进程；DSH 自己的 `runDesktopCli` 用的就是同一形状。
- `/list` 每次同步读 `node_modules/dsh-worktodo/package.json` 的实测成本 **0.0176ms/次**，1000 次 17.6ms；1000 条待办时 `/list` 4.54ms/次、载荷 704KB，瓶颈在 JSON 序列化/存储读取，不在这次同步读盘。
- 全量门禁 **10/10**，包括 0.2.6 之前修过的宿主不变量。

---

## 2. 改动面（只列与稳定性有关的）

```
 .github/pull_request_template.md         |  13 +
 AGENTS.md                                |  52 +
 CHANGELOG.md                             |  19 +
 docs/process/development-standard.md     | 299 +
 docs/reviews/version-fixture-refactor.md | 135 +
 docs/reviews/windows-update-fix.md       | 153 +
 docs/specs/_template.md                  |  37 +
 lib/client.js                            |  59 +-
 lib/client.js.map                        |   4 +-
 lib/index.js                             | 626 ++++++++++++++++++++++++---
 package.json                             |   2 +-
 src/client/index.js                      |  73 +-
 tools/smoke-client.mjs                   | 105 +
 tools/smoke-host.mjs                     | 440 +++++++++++++++++++++++++---
```

`lib/index.js` 的 626 行里，大部分是 `diagnostics`（失败诊断）和平台形状函数；
**真正会改变宿主行为的只有四块**：

1. `writeFileAtomicSync` 的 win32 `unlink → rename` 回退（新）；
2. `resolvePnpmUpdater` / `bundledPnpmCandidates` / `resolveCliUpdater` 的路径与执行器（新）；
3. `runUpdateStep` 的 `shell:true` 分支与 argv 引号（新）；
4. `diagnostics` 载荷（新，只影响响应体大小与面板文案）。

`maybeAutoUpdate`、`downloadUpdate`、`startInstall`、`runUpdateSequence` 的主体**没有改**；
0.2.7 只是把这些旧路径变得「在 Windows 上真的能走通」。

---

## 3. 逐条风险

### 3.1 A. 启动期影响

#### A1（高）默认 `autoInstall:true`：apply 返回后约 50ms 就起子进程、改 profile，无需用户操作

- 位置：`lib/index.js:315-316`（默认值）、`:2519-2565`（`maybeAutoUpdate`）、`:2650`（启动 tick）。
- 现象：`apply()` 末尾 `void refreshUpdate().then(restoreDownloaded, () => {})`；`refreshUpdate` 查到新版后
  `maybeAutoUpdate()` 依次 `downloadUpdate()` → `startInstall({requireDownload:true})` → `runUpdateSequence()` → `spawn`。
  整个过程不 await，apply 正常返回，但**子进程会在宿主继续启动期间跑**。
- 对 DSH 的影响：启动阶段 profile 的 `package.json` / `pnpm-lock.yaml` / `node_modules` 被官方 CLI 或 pnpm 改写；
  如果这次安装失败/被杀，DSH 下次启动会看到不完整状态。不是「启动变慢」，是「启动期间后台在改插件目录」。
- 证据（实跑，全 `/tmp`）：
  - 默认配置、无 `update-state.json`、注入 latest=`99.0.0`、假 CLI、假 tarball：
    `apply` 返回 **26.9ms**，返回时 `update-state.json` 已存在、子进程**尚未**起；
    约 **50ms** 后捕获到 `INVOKE ... dsh plugin --profile profile add dsh-worktodo@latest --registry ...`；
    ~**320ms** 后 `phase:installed`、`state:done`、profile 规格变成 `99.0.0`。
  - 慢 registry（1.5s 才返回元数据）：`apply` **20ms** 返回，100ms 时 `phase=checking`，
    检查在 **1.58s** 后完成；即 apply 不等网络，但后台会接着走完整条链。
- 最小修复：
  1. 默认 `autoInstall:false`（后台只下到 `downloaded`，等用户点「安装并重启」）；这与 DSH 自己的
     `autoDownload=false` / 用户点才安装的节奏一致，也和「启动期不写 profile」直接冲突最小。
  2. 启动检查延后到宿主 idle（例如 `setTimeout(..., 5000).unref()`），或等面板第一次打开再查；
     现在是在 `apply` 最后一行立刻发起。
  3. 如果坚持 `autoInstall:true`，至少在「本进程启动后 N 秒内」不安装，只下载。

#### A2（中高）自动安装会与宿主读 profile / 其它安装事务并发；pnpm 兜底完全绕开 DSH 的安装事务

- 位置：`lib/index.js:2438-2440`（无条件 `resolveUpdater()` + `resolvePnpmUpdater()`）、
  `:1730-1979`（序列直接跑 CLI/pnpm）、`:1097-1146`（回滚只包 `package.json`）。
- 现象：
  - 第一步 CLI 是 `dsh plugin --profile <name> add ...`，走 DSH 自己的 `createProfilePnpm`：
    它会保存/还原 `package.json`、`pnpm-lock.yaml`、`node_modules/<pkg>/package.json`，并且有
    `activeRecordedRun(dir)` 的 active-run 锁；这是一条**有事务**的路径。
  - 但 `startInstall` 不看 CLI 为什么失败：spawn 失败、退出码非 0、**active-run 拒绝**、**兼容性预检拒绝**，
    都只是 `lastFailure = ...; continue;` → 继续跑 `pnpm update` / `pnpm add`（`:1920-1934`）。
    这条 pnpm 兜底没有锁、没有事务、没有兼容性检查，直接写同一个 profile。
  - DSH 的安装指引明确写着：不要写 profile 的 `package.json`、不要在 profile 目录跑 pnpm，
    应由 `install_bundle` 完成（证据：`$APP/Contents/Resources/app.asar` 内
    “Do not write the profile's `package.json` … or run pnpm in the profile directory: `install_bundle` performs those steps”）。
  - 半写清单本身概率低：pnpm 用 `write-file-atomic`，CLI 的 restore 也用原子写；**真正的问题是三件套不同步**
    （见 C2）以及和 active-run 的安装互相覆盖。
- 证据（静态 + 实跑）：
  - app.asar 内 `createProfilePnpm` 的 `savedFiles = ["package.json", "pnpm-lock.yaml"]`、
    `activeRecordedRun(dir)`、`registryFlags = args.filter(a => a.startsWith("--registry="))` 均可见；
  - 本仓库的 `--registry` 是两段式（`'--registry', registry`），CLI 用 Commander 把余下参数转发给 pnpm，
    两段式能工作；CLI 本身在本机实测 `--version` 退出码 0（`0.2.1-rc.2`）。
- 最小修复：
  1. CLI 失败原因里区分「另一个安装正在进行 / 兼容性拒绝」：这两种**必须停止序列并报 failed**，
     绝不降级到 pnpm。
  2. 能在桌面端走 CLI 就不走 pnpm；pnpm 兜底加 `--config.lockfile=false` 之外的 profile 级锁，
     并在写盘前确认没有 active-run 记录。
  3. 长期：改用/对齐 `install_bundle`，不要在插件里自己跑 pnpm。

#### A3（已通过）`apply` 不被后台网络/下载/安装阻塞

- 位置：`:2650`（`void refreshUpdate()`）、`:2615-2624`（`await resolveDshHome()`）。
- 证据：见 A1 的两组数字；apply 中位 0.08ms、有检查时 20–35ms。唯一可能拖慢 apply 的是
  `openWorkTodoStore`（有 3s 上限，`S1-2` 用例已覆盖）和 `resolveDshHome()` 的首次动态 import（毫秒级）。
- 结论：没有「启动卡住」的新问题。

#### A4（低）两处后台 `void refreshUpdate()` 没有 `.catch`

- 位置：`:1642`（`finishRun('done')` 里 `void refreshUpdate({force:true})`）、`:2791`（`/list` 的 TTL 刷新）。
- 现象：`refreshUpdate` 目前所有网络/JSON 异常都在内部 catch，正常不会 reject；但任何后续改动
  （比如 `maybeAutoUpdate` 或 `setPhase` 抛错）都会变成 unhandled rejection。Node 15+ 默认
  `--unhandled-rejections=throw`，在宿主进程里等于一次未捕获异常。启动那次有 `.then(..., () => {})` 兜底，
  这两处没有。
- 最小修复：统一 `.catch((error) => logger?.warn?.(...))`，或把 `void refreshUpdate()` 收口到一个
  `safeRefresh()`。

#### A5（已通过）apply 期间没有新增同步重活

- 位置：`:1252-2650`。新增的 `resolveCliUpdater`/`bundledPnpmCandidates` 只在 `startInstall` 调用；
  其中唯一的 `readdirSync(runtimeRoot)`（`:851`）有 try/catch，实测 1000 次 `resolvePnpmUpdater`
  108ms（0.108ms/次），且不在 `/list` 热路径。
- 证据：0.2.7 vs 0.2.6 的 25 轮 apply（无更新检查，假 ctx + 假 profile）：
  中位 0.08ms vs 0.07ms，均值 0.85ms vs 0.79ms，最大 15.3–18.5ms vs 14.4–15.4ms；
  模块 import 8.0–10.5ms vs 7.9–9.7ms。差异在噪声范围内。

---

### 3.2 B. 子进程

#### B1（高）180s 超时只杀直接子进程；孙进程存活并继续写，POSIX/Windows 都成立

- 位置：`lib/index.js:1677-1714`，关键行 `:1705 try { child.kill('SIGKILL'); }`；
  `spawn` 参数 `:1682-1688`（没有 `detached`、没有 process group）。
- 现象：`node pnpm.mjs` 或 `pnpm.cmd` 自己会再 spawn（lifecycle script、node-gyp、postinstall）。
  `child.kill()` 只对直接子进程 `TerminateProcess`/`SIGKILL`，孙进程被 reparent 后继续跑；
  Windows 的 `shell:true` 兜底还多一层 `cmd.exe`，`kill` 只杀 `cmd.exe`。
- 对 DSH 的影响：面板已报 `failed`、事务已回滚，但后台的 pnpm 还在写 `node_modules` / 锁文件；
  下一次启动看到的不是回滚后的状态。若宿主退出，孤儿进程继续写到 profile，直接造成「上次安装一半」。
- 证据（实跑，600ms 超时，假 CLI 派生一个每 50ms 追加心跳的孙进程）：
  - 610ms 判定 `reason=timeout`；
  - 判定后孙进程 `alive=true`，心跳文件 50 字节 → 1.2s 后 165 字节（**仍在增长**）；
  - 手动 `SIGKILL` 孙进程后测试才退出。
- 最小修复：
  - POSIX：`spawn(..., { detached: true })`，超时 `process.kill(-child.pid, 'SIGKILL')`；
  - Windows：`taskkill /pid <pid> /t /f`（`shell:true` 时更要 `/t`）；
  - 保留 `stdio` pipe + 日志，但超时后对 stdout/stderr 也 `destroy()`，避免孙进程持有管道拖住宿主退出。

#### B2（高）dispose / 插件卸载不取消在飞的检查、下载、安装；卸载后仍会起子进程改 profile

- 位置：`lib/index.js:2650`（启动 tick）、`:2519-2565`（自动链）、`:1994-2128`（下载）、
  `:1730-1979`（安装）。整个更新子系统**没有 `ctx.effect` 清理**，也没有 `AbortController`；
  `grep AbortController` 只有两处 `AbortSignal.timeout`。
- 现象：`refreshUpdate` 的 fetch、`downloadUpdate` 的 fetch、`runUpdateStep` 的 child 都不受
  dispose 约束。cordis 卸载只会清掉路由/存储/工具；后台 promise 继续跑，跑完照样 `setPhase`、
  照样 `startInstall`、照样写 profile。
- 对 DSH 的影响：插件重载（配置变更）或 DSH 退出时，一个「已经不存在」的插件实例仍能启动安装、
  改写 profile。这是比「超时孤儿」更直接的宿主生命周期 bug。
- 证据（实跑）：
  - 卸载场景：`apply` 后 100ms 把该实例所有 effect dispose；启动检查在 800ms 返回，
    随后仍然 **spawn 了 CLI**（capture 有 INVOKE），profile 规格从 `^0.2.7` 变成 `99.0.0`，
    最终 `phase=installed`、`state=done`。
  - 在飞安装场景：apply → 等子进程起来 → dispose；100ms 后子进程仍存活，1.5s 后写出 profile
    （`WROTE_PROFILE`），规格变成 `99.0.0`。
- 最小修复：
  - 模块/实例级 `let disposed = false`，所有异步收口前检查；dispose 时置位并 abort 所有 fetch；
  - `ctx.effect(() => () => { disposed = true; abort(); killTree(child); }, 'worktodo: updater lifecycle')`；
  - `spawn` 的 child 记录在实例上，dispose 时统一杀。

#### B3（高）没有跨进程锁；连续 apply/dispose 实测会累积多个安装子进程

- 位置：`lib/index.js:2293`（只有实例内 `phase` 守卫）、`:1730-1979`（无锁文件）。
  0.2.6 的复审已经记录过「多实例无跨进程锁」，0.2.7 没修，而且让 pnpm 兜底能真正跑起来。
- 现象：同一进程里每次 `apply` 都新建一个闭包，`updateRun.phase` 不共享；两次挂载/重载可以各跑一条序列。
  两个宿主进程（或一个宿主 + 一个手工 `dsh plugin add`）也没有互斥。
- 证据（实跑）：5 轮「apply → 启动自动安装 → 等子进程起来 → dispose」，每轮残留 1 个 slow-CLI 子进程：
  `aliveChildren: 1 → 2 → 3 → 4 → 5`（PID 76618/76620/76622/76624/76626），1.8s 后自然退出归零。
  真实的 pnpm 不会 1.5s 退出，这就是 5 个 pnpm 同时写同一个 profile。
- 最小修复：
  - profile 级锁文件（`<profile>/.plugin-manager/` 已有 DSH 的 active-run 记录语义，可复用/只读判断）；
  - 或模块级单例 `let activeRun = null`，跨 apply 共享；
  - 拿不到锁就 `failed(reason:'busy')`，**不要重试**。

#### B4（高/中）CLI 的「active-run / 兼容性拒绝」被当成步骤失败 → 降级 pnpm 绕过宿主保护

- 位置：`lib/index.js:1920-1934`（`spawnFailed` / `code !== 0` 一律 `continue`）、
  `:1170-1196`（CLI → pnpm update → pnpm add 三步）。
- 现象：DSH 的 CLI 在「另一个 install_bundle 正在进行」或「兼容性预检拒绝」时返回 exit 1。
  本插件不解析原因，继续用 pnpm 写同一个 profile。前者会与正在进行的安装打架；后者会把
  DSH 明确拒绝的版本硬装进去，下次启动由宿主承担后果。
- 证据（静态，来自 `$APP/Contents/Resources/app.asar`）：
  `createProfilePnpm` 里 `if (active !== void 0) { ... return { exitCode: 1, ... } }`；
  `evaluatePluginCompatibility(...)` → `incompatible.push(...)` → `exitCode: 1`。
  本插件的 `runUpdateStep` 只看 `result.code !== 0`，不看 stderr 语义。
- 最小修复：当 CLI 步骤失败且 stderr 命中「already running / in progress / incompatible / rejected」时，
  直接 `pendingFailure` 收口；只有「命令不存在 / 路径不对」才允许降级 pnpm。

#### B5（已排除）Electron 下不会误起第二个 GUI 应用

- 证据（实跑 + 宿主源码）：
  - `$APP/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs` 存在；
  - `ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" --expose-internals <pnpm.mjs> --version`
    → `11.28.5`、退出码 0、耗时 629ms，ps 没有多出 GUI 进程；
  - `$APP/Contents/Resources/app.asar` 内 DSH 自己的 `runDesktopCli` 就是
    `command: process.execPath, args: ["--expose-internals", .../pnpm.mjs], env: { ELECTRON_RUN_AS_NODE: "1", DSH_DESKTOP_NODE_EXECUTABLE: process.execPath, PATH: ... }`。
    这说明 RunAsNode fuse 在该构建里是开的，DSH 自己也依赖它。
- 唯一残留：插件没像 DSH 那样把 `<runtime>/bin` 加进子进程 `PATH`（`:1684` 只 merge `process.env`）。
  pnpm 自身不需要，但 lifecycle script 里若调 `node` 可能找不到。dsh-worktodo 没有 install script，影响低。

#### B6（已通过）stdio / windowsHide / 超时定时器

- `:1685` `stdio: ['ignore', 'pipe', 'pipe']`：没有 inherit 宿主 stdout，不会卡宿主管道。
- `:1686` `windowsHide: true`；`:1687` 只有 `pnpm.cmd` 兜底才 `shell: true`。
- `:1701-1708` 超时定时器 `unref()`，不会单独挂住事件循环。
- 注意：child 本身没有 `unref()`。宿主若靠「等事件循环清空」退出，在飞的 pnpm 会拖到 180s 上限；
  这与 B2 的 dispose 不杀 child 是同一件事。

#### B7（低）日志尾部对超大 chunk 的瞬时内存

- `:1507-1520` `pushUpdateLog` 把一个 chunk 按行拆开、逐行 push 后再裁到 40 行/4000 字符。
  正常 pnpm 输出是行缓冲；若子进程一次吐一个几十 MB、含大量换行的 chunk，会先构造一个大数组
  再裁掉。不是当前行为，但可以在 push 前先截断 chunk 长度。

---

### 3.3 C. 文件系统

#### C1（严重，Windows）`writeFileAtomicSync` 的 win32 回退会**删掉目标文件**；两次 rename 失败时原文件彻底丢失

- 位置：`lib/index.js:472-533`，关键 `:498-525`：
  ```
  rename(tmp, file) 失败（EPERM/EBUSY/...）
    → unlink(file)            // 原文件被删除
    → rename(tmp, file) 再失败
    → 外层 catch unlink(tmp)  // 临时文件也被删除
  ```
- 现象：错误文案是「Windows 原子写失败」，但磁盘上**既没有旧文件，也没有新文件**。
  这条路径用在 `journal.rollback()`（`:1137`）时，目标就是 profile 的 `package.json`。
  也就是说：一次失败的自动升级 + Windows 上两次 rename 失败 → 用户的 profile 清单消失。
- 对 DSH 的影响：`$APP/Contents/Resources/app.asar` 里存在会抛错的
  `readProfileManifest(binName, dir)`（`throw new Error(\`${binName}: failed to read profile manifest ${path}\`)`）。
  至少会让该 profile 的清单读取失败；是否整体起不来取决于调用点（`readOptionalProfileManifest`
  对 ENOENT 有容忍，但不是所有路径都走它）。这是不可接受的失败模式。
- 证据（实跑，macOS 上注入 win32 的 `rename`，其余用真实 fs）：
  - 第一次 rename EPERM、第二次成功：最终内容 `NEW-1`，但**第二次 rename 前目标已不存在**
    （`targetExistedAtRetry=false`）——即存在「清单短暂不存在」的窗口。
  - 两次 rename 都 EPERM：`targetExists=false`，`targetContent=null`，临时文件已清空。
    错误：`Windows 原子写失败：无法替换 ...（rename: EPERM；删除目标后重试: EPERM）`。
  - `unlink` 失败：原文件保持 `OLD-3`（这条是安全的）。
  - POSIX rename 失败：原文件保持 `OLD-5`（不回退、不删目标）。
- 为什么说这个回退收益存疑：Node/libuv 在 Windows 用 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`
  覆盖已存在目标（按 libuv 实现推断，未在 Windows 实机验证）；失败通常是因为目标被占用/只读，
  而这两种情况下 `unlink` 往往也会失败。也就是说，回退主要新增的是「删掉目标但重试失败」的风险。
- 最小修复（按优先级）：
  1. **不要 unlink 目标**：先 `rename(file, file + '.bak')`（同目录、原子），再 `rename(tmp, file)`；
     成功后再删 `.bak`；失败则把 `.bak` rename 回去。这样任何时刻至少有一个完整文件。
  2. 或者保留 `package.json.bak` 兜底，并在 DSH 启动前恢复（需要宿主配合，成本高）。
  3. 至少在二次失败时**不要删临时文件**，并把临时文件路径写进错误，给用户手工恢复的机会。
- 测试缺口：`tools/smoke-host.mjs:2351-2412` 的用例只覆盖「unlink 失败 → 原文件不动」，
  **没有覆盖「unlink 成功 + 第二次 rename 失败」**，所以这条数据丢失路径是绿的。

#### C2（中高）失败回滚只还原 `package.json`，`pnpm-lock.yaml` 留在新规格

- 位置：`lib/index.js:1097-1146`（`createProfileJournal` 只保存/还原 `package.json`）、
  `:1137`（回滚写盘）、`:1786-1813`（诊断）。
- 现象：`pnpm update` / `pnpm add` 会同时改写 `package.json` 和 `pnpm-lock.yaml`。序列判定
  「版本没变」后，`journal.rollback()` 把 `package.json` 逐字节还原，但 lockfile 保持新内容。
- 对 DSH 的影响：profile 出现「清单说 `^0.2.7`、lockfile 锁 99.0.0、node_modules 是 0.2.7」。
  DSH 的安装器在修复路径会用 `pnpm install --frozen-lockfile`（app.asar 内可见）；这种不一致会让
  下一次安装/修复失败或试图装一个 registry 上不存在的版本。是否直接卡启动取决于宿主，但
  「profile 三方不一致」本身就是插件不该留下的状态。
- 证据（实跑，假 pnpm 同时写 package.json + lockfile、但不动 node_modules）：
  ```
  state=failed reason=version-unchanged
  profileManifestAfter: {"dsh-worktodo":"^0.2.7"}
  lockfileAfter:        specifier: 99.0.0 / version: 99.0.0
  installedNodeModules: 0.2.7
  ```
- 最小修复：journal 同时保存/还原 `pnpm-lock.yaml`（和 `node_modules/dsh-worktodo/package.json`）；
  或直接用 DSH 的安装事务（它会保存这三样，证据见 app.asar 的 `savedFiles`）。注意这是 0.2.6 就有的
  旧问题，但 0.2.7 让 Windows 上的安装第一次真的执行，所以现在必须一起修。

#### C3（已通过）32MiB 上限、缺失 content-length、失败清理

- 位置：`lib/index.js:293`（上限）、`:2042-2051`（声明大小 + 流式累计双保险）、
  `:2082-2088`（落盘后回读校验）、`:2102-2127`（失败收口）。
- 证据（实跑，本地 HTTP，5 个场景）：

  | 场景 | 结果 | 用时 | 暂存区残留 |
  |---|---|---|---|
  | 无 content-length，2KB | ok，`.tgz` + `manifest.json` | 24ms | 2 个文件（正常） |
  | 无 content-length，40MiB | failed「下载内容超过上限」 | 66ms | **0** |
  | 声明 100MiB | failed「声明大小超过上限」 | 2ms | **0** |
  | HTTP 500 | failed | 3ms | **0** |
  | 声明 4096、只发 1024 后断 | failed | 24ms | **0** |

  40MiB 场景服务端实际写出 34,603,008 字节（约 33MiB）后被客户端停掉，说明 cap 在流式里生效。
- 结论：不会无限写、不会留半个文件、不会因缺 content-length 无限增长。
- 补充：插件**不解压** tarball（`:2082` 只写 `.tgz`），安装由 pnpm/CLI 自己再拉一次；所以不存在
  「解压炸弹」，但这份下载产物并不参与实际安装，只是 `requireDownload` 的门禁（以及重启后恢复
  「已下载」的 UI 状态）。这也意味着 32MiB 上限只覆盖「下载 + 内存 + 落盘」，覆盖不到 pnpm 自己
  在安装时拉的那个包——那部分由 pnpm 的磁盘占用负责。
- 残留：tarball 在内存里攒齐（最多 32MiB），`Buffer.concat` 再复制 32MiB，`verifyStagedArtifact`
  再读 32MiB；峰值约 64–96MiB。桌面端可接受，但不是零成本。

#### C4（低）暂存区/状态文件只增不删，没有 GC

- 位置：`:1015-1021`（暂存目录）、`:2079-2099`（每版本一个目录）、`:1635-1639`（成功安装只删 `.tgz`，
  保留 `manifest.json`）。
- 现象：每个更新过的版本留一个 `updates/<version>/manifest.json`（~300B）；失败安装会把整包
  （≤32MiB）留在 `updates/<version>/`；同一版本重下会覆盖，不同版本累积。崩溃/断电还会留
  `.dsh-worktodo-*.tgz.worktodo-tmp-*` 临时文件。
- 实测：一次成功安装后 `~/.dsh/worktodo/updates/99.0.0/manifest.json` 仍在，`.tgz` 已删；
  `du -sh` 8KB。不是当前问题，但长期用户可能累积几十 MB。
- 最小修复：成功/失败收口时清掉旧版本目录（保留当前版本），或给 `updates/` 一个总量上限；
  启动时清掉 N 天前的临时文件。
- 备份：待办存储的 `.bak-` 已限 `MAX_BACKUPS = 2`（`src/store.mjs`，0.2.7 没改），不会无限增长；
  会无限增长的是 `updates/<version>/`（每个更新过的版本一份，无 GC）。
- 写入范围：只写 `$DSH_HOME/worktodo/{update-state.json,updates/}` 和本实例 profile；
  没有写到 `$DSH_HOME` / profile 之外（`resolveUpdateStatePath`/`resolveUpdateStageDir` 都可被
  `WORKTODO_*` 覆盖，这是测试缝，不是生产路径）。

#### C5（已通过）失败清理与临时文件

- 下载失败 5 个场景暂存区都为空；原子写成功/失败路径都清临时文件（C1 的二次失败也清，问题正是清掉了唯一副本）。
- 崩溃窗口内可能留一个 `.<name>.worktodo-tmp-<pid>-<ts>`；名字带 pid+时间戳，不会互相覆盖，
  但也没有启动清理。低。

#### C6（低）`profileDirFromModuleUrl` 从「最后一个匹配」改成「第一个匹配」，嵌套路径会指错 profile

- 位置：`lib/index.js:653-673`，关键 `:661`
  `const marker = /(?:^|[\\/])node_modules[\\/]dsh-worktodo[\\/]/i;` + `marker.exec(filePath)`。
- 现象：0.2.6 用 `lastIndexOf(marker)`（最靠近 `lib/index.js` 的那一段），0.2.7 用 `exec`（最左边的一段）。
  在「外层目录本身也有一层 `node_modules/dsh-worktodo`」时，0.2.7 会切到外层。
- 证据（实跑）：

  ```
  输入: .../nested/node_modules/dsh-worktodo/x/node_modules/dsh-worktodo/lib/index.js
  0.2.7 -> /tmp/wt-audit/nested            (外层有 package.json)
  0.2.6 -> null                            (内层 x 没有 package.json，安全失败)
  ```

- 对 DSH 的影响：**低**。即便指到外层，`startInstall` 随后会读外层 `package.json` 的
  `dsh-worktodo` 依赖；没有就 `not-installed`，零写盘、零子进程。只有「外层恰好也依赖
  dsh-worktodo」时才会误改。正常 registry 安装路径只有一层 `node_modules/dsh-worktodo/`，不受影响。
- 最小修复：用 `matchAll` 取**最后**一个匹配（或对两种分隔符各做一次 `lastIndexOf` 再取较大者），
  再做 `exists(join(dir, 'package.json'))` 校验。

---

### 3.4 D. 运行时开销

#### D1（信息/通过）`/list` 每次同步读 `node_modules/dsh-worktodo/package.json`

- 位置：`lib/index.js:2579-2609`（`updatePayload`）、`:2582`（每次 `readInstalledVersion`）、
  `:624-632`（读 + `JSON.parse` + 吞异常）、`:686-699`（`resolveOwnProfileDir`）。
- 实测（假 profile，`WORKTODO_NO_UPDATE_CHECK=1`，1000 次）：
  - 空列表：`/list` 总计 **43.4ms**，**0.043ms/次**，载荷 1007 字节；
  - 单独隔离「resolveOwnProfileDir + readFileSync + JSON.parse」：**17.6ms/1000 = 0.0176ms/次**；
  - 1000 条待办：`/list` 总计 4537.7ms，**4.538ms/次**，载荷 **704,453 字节**；
    大头是 1000 条 JSON 序列化和 store 读取，不是这次读盘。
- 结论：热路径上的同步读盘本身不是问题；长会话/多窗口下真正放大的是 704KB 载荷和 30s 变更轮询，
  这是旧行为。0.2.7 没有让它更糟。
- 可选优化：在 `installedVersion` 上加 mtime/size 缓存；但收益只有 0.018ms/次，不急。

#### D2（通过）diagnostics 载荷有上限

- 位置：`:1451-1501`（完整/摘要）、`:1791-1813`（`buildDiagnostics`）、`:1498-1500`（`/list` 只带 8 行）。
- 实测（假 CLI 输出 200 行 × ~400 字符后 exit 1）：
  - `GET /worktodo/update`：**10,423 字节**；`diagnostics` **4,576 字节**；
    `logTail` 9 行 / 3,689 字符（`UPDATE_LOG_TAIL_LINES=40`、`UPDATE_LOG_TAIL_CHARS=4000` 生效）；
  - `GET /worktodo/list`：**5,381 字节**，其中 `update.run` 4,601 字节，`diagnostics.logTail` 8 行。
- 结论：不会把整包安装日志塞进轮询响应；上限工作正常。

#### D3（通过）面板 2s 轮询只在 busy 时存在

- 位置：`src/client/index.js:2359-2372`：`if (!busy) return undefined;`，`busy = isUpdateBusy(run)`；
  后台窗口 `isWindowHidden()` 直接跳过；离开 busy 时 `clearInterval`。
- 另有 `CHANGE_POLL_MS = 30000`（`:56`、`:2323-2326`）。
- 结论：不是常驻 2s 定时器，多窗口下每个可见面板各一份，符合「只在 busy 时轮询」。

#### D4（通过）apply 里没有新的同步重活

- 见 A5 的实测数字。`apply` 里唯一新增的同步逻辑是归一化配置与两个纯函数，成本可忽略。
- `startInstall` 里的 `resolvePnpmUpdater` 会做一次 `readdirSync(<resources>/runtime)`（`:851`），
  实测 0.108ms/次（1000 次 108ms），且只在安装时发生，不在每次 `/list`。

---

### 3.5 E. 回归

#### E1（通过）全量门禁 10/10

```
$ WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs
  ✓ 客户端 bundle 构建（build-client.mjs）
  ✓ 数据模型（verify-records.mjs）
  ✓ 服务层（verify-service.mjs）
  ✓ 存储层（verify-store.mjs）
  ✓ 宿主接线与工具（smoke-host.mjs）
  ✓ 客户端↔宿主契约（smoke-contract.mjs）
  ✓ 客户端 bundle（smoke-client.mjs）
  ✓ CI workflow 契约（verify-workflows.mjs）
  ✓ 发布面审计（verify-privacy.mjs）
  ✓ 收录提交门禁（verify-submission.mjs）
10/10 个步骤通过（含构建）
```

跑完 `git status --porcelain` 为空（构建产物与入库一致，没有改源码）。

#### E2（通过）0.2.6 之前修过的宿主不变量仍绿

从 smoke-host 的用例名可逐条对应：

- 存储不静默降级：`apply 两次（同一 storageDomain）不降级、不丢数据`、
  `卸载后立刻重载：清理可 await，新句柄仍是 domain`；
- `updateOrder` 一次：`POST /reorder 落盘手动顺序，并在 manual 模式下生效` + verify-service；
- 路由注册兜底：`S1-1：第 N 条路由注册抛错 → apply 不 reject、其余路由照常且卸载时清干净`；
- 挂载超时：`S1-2：storageDomain.open 永不 resolve → 超时后 apply 仍然返回并完整挂载`；
- shapes：`S3-3：/list?shapes=todos 只回一份…缺省仍是三份`；
- 写盘失败不截断：`A1（严重）：写盘失败（ulimit -f）时 profile 仍是合法 JSON`；
- 回滚：`A2/A3` 三条；
- 无更新检查：`WORKTODO_NO_UPDATE_CHECK` 在调用时读取（0.2.6 的 CI 修复）。

#### E3（部分通过）`apply → dispose → apply` 10 轮：基线零增长，但更新在飞时不是

- 基线（无更新检查、无在飞任务）：10 轮 `_getActiveHandles()` 都只剩测试自己的 `Server`（已过滤），
  `Timeout/Immediate` 每轮 **0**；没有增长。
- 更新在飞：见 B2/B3——不是句柄表增长，而是**子进程没有被 dispose 杀掉**；5 轮残留 1→5 个。
  所以「10 轮零增长」只对存储/路由/定时器成立；0.2.7 新增的下载/子进程资源**没有 dispose 清理**。

#### E4（测试缺口）

- `tools/smoke-host.mjs:2351-2412` 没有测「unlink 成功 + 第二次 rename 失败」，因此 C1 的数据丢失是绿的；
- 没有测超时后的进程树（孙进程）、没有测 dispose 时在飞的下载/安装、没有测 lockfile 回滚；
- Windows 相关测试全部是 `platform:'win32'` 的**形状**测试 + 注入 `rename/unlink`，
  没有真机 Windows 文件系统/杀软/`pnpm.cmd` 行为。这不是说测试不好，而是说「绿」不等于「Windows 上安全」。

---

## 4. 最严重的 3 条（如果只看三条）

1. **C1（严重，Windows）**：win32 原子写回退在二次 rename 失败时删除目标，profile `package.json`
   可能消失；现有测试恰好没有覆盖这条分支。
2. **B1+B2（高）**：超时只杀直接子进程、dispose 不取消在飞任务；实测卸载后仍会 spawn 安装并改 profile，
   孙进程在超时后继续写。
3. **A1+A2（高）**：默认 `autoInstall:true`，启动后约 50ms 起子进程安装；首次无状态文件也会尝试；
   官方 CLI 的 active-run/兼容性拒绝还会被降级成直接 pnpm 写 profile（绕开宿主的安装事务与锁）。

---

## 5. 实跑 vs 推断

| 结论 | 性质 |
|---|---|
| 10/10 门禁、git 干净 | 实跑 |
| apply 0.08ms / 20–35ms、慢 registry 不阻塞 | 实跑（假 ctx + 假 profile） |
| 启动自动下载+安装、首次无状态也尝试 | 实跑（假 CLI/假 registry/假 tarball） |
| 卸载后仍 spawn 安装并改 profile | 实跑 |
| 5 轮重载累积 5 个子进程 | 实跑（`ps` + pgrep 精确匹配） |
| 600ms 超时后孙进程存活、心跳增长 | 实跑 |
| 两次 rename 失败 → 目标消失 | 实跑（注入 win32 rename，真实 fs） |
| lockfile 回滚缺口 | 实跑（假 pnpm 写 package.json+lockfile） |
| 下载 32MiB cap / 5 场景零残留 | 实跑（本地 HTTP） |
| 真实 DSH 的 pnpm 路径、CLI 可执行、无第二个 GUI | 实跑（真实 app 目录，只跑 `--version`） |
| DSH 的 install_bundle 事务/active-run/兼容性拒绝 | 静态（app.asar 字符串与代码片段） |
| 缺 `package.json` 会让 DSH 起不来 | 推断（app.asar 有抛错的 `readProfileManifest`；是否整体失败取决于调用点） |
| Windows 杀软/索引器导致两次 rename 失败的概率 | 推断（无 Windows 实机；按 libuv/MoveFileEx 语义分析） |
| `%` 未在 `shellQuoteArg` 中处理（`cmd.exe` 变量展开） | 静态推断（低，仅 `pnpm.cmd+shell` 兜底路径） |

---

## 6. 上一轮没审到的稳定性问题

1. **win32 原子写的「删目标后二次失败」分支**：`docs/reviews/windows-update-fix.md` 把回退写成
   「二次失败转成明确错误 / 任何失败都清临时文件」，但没有意识到 `unlink` 已经把原文件删了；
   测试也只覆盖了「unlink 失败」，没覆盖「unlink 成功、rename 再失败」。这是本轮最严重的发现。
2. **卸载/重载后仍在跑更新**：上一轮的 `apply → dispose → apply` 只覆盖存储/路由/定时器，没有覆盖
   0.2.6 新增的下载/子进程；本轮证明 dispose 后仍能 spawn 安装。
3. **回滚只回 `package.json`、不回 `pnpm-lock.yaml`**：上一轮聚焦「清单逐字节还原」，没检查
   lockfile/node_modules 的三方一致性。
4. **启动期自动安装的时序**：`docs/review-auto-update.md` 只说「不阻塞挂载」，没有测
   「apply 返回后多久起子进程」「首次无 update-state 是否尝试」「和宿主启动重叠」。
5. **`profileDirFromModuleUrl` 从 last 改 first**：嵌套路径上行为变了（低，但有可复现差异）。
6. **pnpm 兜底绕过 DSH 的 install_bundle / active-run / 兼容性**：上一轮把 pnpm 兜底当「补救」，
   没有把它放到宿主安装事务的上下文里看。

---

## 7. 最小修复顺序（建议）

1. **C1**：改写 win32 回退为 bak-swap；补两条用例（二次失败后原文件仍在；重试瞬间目标存在）。
2. **B1/B2**：`detached` + `kill(-pid)` / `taskkill /T`；`AbortController`；`ctx.effect` 里 dispose
   时置 `disposed`、abort、杀 child；补「卸载后在飞任务不再 spawn」用例。
3. **A1**：`autoInstall` 默认改成 `false`；启动检查延后 5–10s 或等面板打开；补「首次启动不写 profile」用例。
4. **B3/B4**：模块级单例/锁；CLI 的 active-run/兼容性拒绝直接停，不降级 pnpm。
5. **C2**：journal 同时保存/还原 lockfile 与 installed package.json；或改用官方安装事务。
6. **低优先**：`void refreshUpdate` 加 `.catch`；暂存 GC；`profileDirFromModuleUrl` 用 last 匹配；
   `shellQuoteArg` 处理 `%`；给子进程补 `<runtime>/bin` 到 PATH。

---

## 8. 复现命令（全部在 `/tmp`，不碰真实 profile）

```bash
# 0) 假 profile / 假 HOME
mkdir -p /tmp/wt-audit/fake/profile/node_modules/dsh-worktodo/lib
printf '{"name":"p","private":true,"dependencies":{"dsh-worktodo":"^0.2.7"}}\n' \
  > /tmp/wt-audit/fake/profile/package.json
printf '{"name":"dsh-worktodo","version":"0.2.7"}\n' \
  > /tmp/wt-audit/fake/profile/node_modules/dsh-worktodo/package.json

# 1) 全量门禁
cd ~/Documents/deepseek-harness/default-workspace/dsh-worktodo
WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs     # 10/10

# 2) 启动自动安装（假 CLI / 假 registry / 假 tarball）
env -i HOME=/tmp/wt-audit/fake/home DSH_HOME=/tmp/wt-audit/fake/home/.dsh \
  PATH=/usr/bin:/bin WORKTODO_PROFILE_DIR=/tmp/wt-audit/fake/profile \
  node /tmp/wt-audit/startup-auto.mjs <repo>

# 3) 卸载后在飞安装仍继续
#    同 startup-auto，但在 100ms 处 dispose 所有 effect
node /tmp/wt-audit/post-dispose3.mjs

# 4) 超时只杀直接子进程（孙进程存活）
node /tmp/wt-audit/timeout-tree.mjs <repo>

# 5) win32 原子写：两次 rename 失败后目标消失
node /tmp/wt-audit/atomic-test.mjs

# 6) 回滚后 lockfile 仍是新规格
node /tmp/wt-audit/lockfile-test.mjs

# 7) /list 热路径
node /tmp/wt-audit/list-bench.mjs <repo>
node /tmp/wt-audit/list-big.mjs <repo> 1000

# 8) 真实 DSH 执行器（只跑 --version，不联网、不写 profile）
node /tmp/wt-audit/spawn-pnpm.mjs
node /tmp/wt-audit/cli-version.mjs
```

（`/tmp/wt-audit/*.mjs` 是本轮临时脚本，不在仓库里。）

---

## 9. 边界与未验证

- **没有真机 Windows**：C1 的「两次 rename 失败」是在 macOS 上注入 `platform:'win32'` + 假 `rename`
  复现的分支；真实 Windows 上杀软/索引器的占用概率、`MoveFileEx` 的具体错误码仍需一次实机验证。
  但「代码在二次失败时会删掉目标」是读代码 + 注入实验共同确认的，不依赖 Windows 概率。
- **没有跑真实 pnpm 安装**（约束禁止联网）：pnpm 的写入行为、CLI 的 active-run/兼容性拒绝来自
  app.asar 字符串与 DSH 自身实现，未在真机触发。
- **没有碰真实 profile / `~/.dsh` 数据**：所有 profile、`DSH_HOME`、`HOME` 都在 `/tmp`。
- 本报告只审稳定性，不重复数据模型/UI 的结论；`src/client/index.js` 的改动（失败详情一行小字）
  是纯展示，未发现会崩的路径（`badge.detail` 是普通对象字段，React 文本节点，无 `innerHTML`）。

---

## 修复状态（1–6）

> 本轮只改 `lib/index.js` 与 `tools/smoke-host.mjs`（测试文件仍 9 个），未改版本号 / CHANGELOG / `.github`，未 commit / tag / 发布。
> 所有实验仍在 `/tmp` 假 profile + 临时 `DSH_HOME`/`HOME` 下，未联网。路径均以 `~/...` 表示仓库或用户目录。

### 1【致命】win32 原子写：目标文件任何时刻都不会「消失且没有备份」

**修法**（`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`，`writeFileAtomicSync`）
- **首选仍然直接 `rename(tmp, target)`**：Windows 上 libuv 用 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` 本来就能覆盖，绝大多数情况目标全程不动，不产生任何备份。
- 只有直接 rename 抛 `EPERM/EBUSY/EACCES/EEXIST/ENOTEMPTY/EISDIR` 才进回退：
  1. 先把目标原文读进内存，并**用 `wx` + 写循环 + `fsync` 落一份同目录 `.worktodo-bak-*`**；
  2. 才 `unlink(target)`；
  3. 再 `rename(tmp,target)`；
  4. 第二次 rename 仍失败 → **先用与 rename 无关的 `open('w')` + 写循环 + `fsync` 从内存备份恢复目标**（失败再试 `rename(bak,target)`）；恢复成功才删 `.bak`，恢复失败则**保留 `.bak` 并把路径写进错误**。
- 目标原本不存在（`ENOENT`）时无需备份，删/rename 不会丢任何内容。
- 收口清理：成功或恢复成功都删临时文件与 `.bak`；只有「恢复失败」才留下 `.bak` 供手工恢复。
- 外层不再无条件删临时文件（旧实现的临时文件是唯一完整副本，删了就没救了）。

**测试**（`tools/smoke-host.mjs`）
- `C1（严重）：win32 二次 rename 失败 → 目标仍存在且内容等于原值（从备份恢复，绝不消失）`：注入 rename 永远 EPERM、真实 unlink；断言删目标前同目录已有 `.bak`、最终目标仍存在且逐字节等于原值、错误里写明「已从备份恢复」、目录只剩 `package.json`。
- 既有 `Windows 原子写` 用例扩展为只允许 `.worktodo-*` 内部文件零残留（同时覆盖临时文件与 `.bak`）。

**反向验证**：把回退里的 `backup = readFileSync(file)` 改成 `backup = null`（等价「先删再 rename 不备份」）→ `smoke-host` 退出码 1，**只有** `C1（严重）…` 变红（目标 `existsSync=false`）。恢复后全绿。

---

### 2【高】超时/卸载杀进程树 + dispose 取消在飞更新 + 跨进程锁

**修法**
- **进程树**：POSIX spawn 时 `detached: true` 建独立进程组，超时走 `killProcessTree()` → `process.kill(-pid,'SIGKILL')`（失败退回 `child.kill`），并销毁 stdout/stderr；Windows 走 `taskkill /pid <pid> /T /F`（`windowsHide`），失败退回 `child.kill`。
- **dispose 取消**：实例级 `lifecycle` 登记在飞子进程 / 定时器 / `AbortController` / 持有的锁；`ctx.effect(..., 'worktodo: updater lifecycle')` 的清理里置 `disposed`、abort 所有 fetch、清定时器、杀整棵子树、释放锁。所有异步收口（refresh / download / maybeAutoUpdate / startInstall / sequence 循环 / onSettled / settleTransaction）都先看 `disposed`：不 spawn、不改状态文件、**不写 profile**（连回滚也不写，状态里记 `skipped:'disposed'`）。
- **跨进程锁**：`$DSH_HOME/worktodo/update.lock`（`WORKTODO_UPDATE_LOCK_PATH` / 与状态文件同目录是测试缝），内容 `{pid,host,at,token}`；`open(...,'wx')` 原子创建。拿不到 → `failed(reason:'busy')`，零 profile 写盘、零子进程；stale（>10min / 同主机进程已死 / 内容损坏）回收一次；release 只删自己 token 的锁，并在序列 `.finally` 与 dispose 两处释放。
- **启动检查延后**：不再在 `apply` 最后立刻 `void refreshUpdate()`，改为 `resolveStartupCheckDelayMs()` 定时器（默认 25000ms，测试缝 `WORKTODO_STARTUP_CHECK_DELAY_MS`），登记进 lifecycle，dispose 时清掉。

**测试**
- `B1（严重）：超时杀整棵进程树 —— 孙进程不再存活、心跳停止增长`：假 pnpm 用 `.cjs` 派生一个每 50ms 写心跳的孙进程；1500ms 超时后断言孙 pid 已不存在、心跳字节数不再增长。
- `B2（高）：dispose 取消在飞安装 —— 子进程被杀、之后零 spawn、零写盘`：autoInstall:true 起子进程后 dispose 全部 effect，断言子进程死亡、1.7s 后无新 spawn、`WROTE` 标记不存在、manifest 逐字节不变、锁已释放。
- `B3（高）：两个实例并发 → 只有一个拿到跨进程锁，另一个 busy 且零 pnpm 写盘`：两个 apply 实例，第二个得到 `busy` 且说明「未做任何写操作」，全程只有 1 个子进程。
- `B3：跨进程锁纯函数`：第二次 busy、错误 token 不删别人的锁、>10min 可回收。
- `B1/B3：killProcessTree 在 POSIX 用独立进程组`：真实 spawn 后断言 `mode='process-group'` 且子进程真的退出。

**反向验证**：把超时里的 `killProcessTree(child)` 改回 `child.kill('SIGKILL')` → `smoke-host` 退出码 1，**只有** `B1（严重）…` 变红（孙进程仍存活/心跳继续涨）。恢复后全绿。

---

### 3【高】启动期不自动安装 + CLI 拒绝不降级 pnpm

**修法**
- `normalizeUpdateConfig` 的 `autoInstall` 默认改为 **false**（只有字面量 `true` 才打开）；默认配置后台最多下载到 `downloaded`。
- 启动检查延后 25s（见第 2 条），不再在 `apply` 返回后约 50ms 抢跑。
- **CLI 失败分类**（新增纯函数 `classifyCliFailure`）：
  - `spawnFailed` 或 stderr 命中 `ENOENT / Cannot find module` → `cli-unavailable`，**只有这种**允许继续走 pnpm；
  - `active-run`（另一个安装/更新正在进行）、`incompatible`（兼容性预检拒绝）、`unconfirmed`、其它 `rejected` → **立刻 failed 并停止序列**，后面的 pnpm 步骤一步都不跑，错误里明确写「不会降级到 pnpm」；
  - CLI 退出码 0 但落盘版本没变（真机已知的 no-op）仍按原设计继续尝试 pnpm（不属于「明确拒绝」）。
- 顺带修掉一个被新增用例暴露的旧 bug：`runUpdateStep` 原来对**所有**步骤都用 `updater`（CLI 优先），CLI 失败降级后 pnpm 步会变成 `node update …`（MODULE_NOT_FOUND）。现在每一步自带 `executor`（CLI 步用 CLI、pnpm 步用 pnpm），降级路径才真的可执行。

**测试**
- `A1：启动检查默认延后 20–30s…`（纯函数：默认 25000、0 可覆盖、非法值回落）。
- `A1/A2（高）：默认配置启动 —— 不自动安装、不写 profile（后台最多下载）`：默认配置 apply 后停在 `downloaded`、`autoInstall:false`、0 个子进程、manifest 字节与 mtime 均不变、状态文件结论 `downloaded`。
- `A1/A2：启动检查确实延后`：延时窗口内 phase 仍 `idle`，延时到后才 `available`。
- 既有 auto 用例显式传 `autoInstall:true`（测试的是旧行为，不再依赖默认值）。
- `B4（高）：CLI 明确拒绝（active-run / 兼容性）→ failed，且绝不降级 pnpm（零 pnpm 写盘）`：两种 stderr 各跑一遍，断言 `reason` 精确、无 pnpm 子进程、无 pnpm 步骤、manifest 逐字节不变。
- `B4：只有 CLI 不可用（找不到脚本）才允许降级 pnpm —— 正对照`：CLI 指向不存在的脚本 → 降级 pnpm 并 `done`。

**反向验证**
- 把 `autoInstall` 改回 `!== false`（默认 true）→ 退出码 1，`配置默认值…` 与 `默认配置启动 —— 不自动安装…` 两条变红。
- 把 CLI 分类条件改成 `false && …`（CLI 失败一律降级）→ 退出码 1，**只有** `B4（高）…` 变红（pnpm 起子进程并改写清单）。恢复后全绿。

---

### 4【中】回滚把 `package.json` + `pnpm-lock.yaml` 当同一事务

**修法**（`createProfileJournal`）
- 同一时刻同步快照两个文件：`package.json`（必须可读/可解析）+ `pnpm-lock.yaml`（`tryReadFile`，不存在记 `null`）。
- `dirty()` 任一变化即 dirty；`rollback()` 对每个变化的文件逐字节还原：原本存在 → `writeFileAtomicSync` + 写后自检；原本不存在但 pnpm 新建了 → 删除它（恢复「原本没有」）。
- 回滚说明会列出实际还原了哪些文件（`逐字节还原 package.json、pnpm-lock.yaml` / `删除本次新建的 pnpm-lock.yaml`）。

**测试**
- `C2（中）：失败回滚把 package.json + pnpm-lock.yaml 当同一事务 —— 两者都逐字节还原`：假 pnpm 同时改写两文件但不动 node_modules → failed/version-unchanged，断言两者都等于原字节、lockfile 无新版本残留、回滚步骤 note 提到 `pnpm-lock.yaml`。
- `C2：原本没有 pnpm-lock.yaml，pnpm 新建后失败 → 回滚把它删掉（恢复原状）`。

**未做**：`node_modules/dsh-worktodo/package.json` 未纳入快照（本条要求只点名 `package.json` + lockfile；该文件损坏由下一次安装修复，且加入快照会把事务扩大到 node_modules 整树，风险更大）。

---

### 5【中】`profileDirFromModuleUrl` 取最后一个 `profiles`/包段

**修法**：`marker.exec()`（第一个匹配）改回 `matchAll` 取**最后一个** `node_modules/dsh-worktodo/` 段；`index <= 0` 仍返回 `null`；切出的目录必须有 `package.json`，否则 `null`。嵌套布局下要么命中内层（正确），要么内层无清单 → `null`（上层零写盘失败），**绝不指到外层 profile**。

**测试**：`C6：嵌套 node_modules/dsh-worktodo 取最后一段 —— 推不出就 null，绝不指到外层 profile`：外层有 `package.json`、内层没有 → `null`；内层有 → 返回内层；删掉外层清单不影响内层判定。

**反向验证**：改回 `marker.exec(filePath)`（第一个匹配）→ 退出码 1，**只有** `C6…` 变红（返回外层目录）。恢复后全绿。

---

### 6【低】其它

- 两处后台 `void refreshUpdate()`（安装成功后的强制重算、`/list` 的 TTL 刷新）都补了 `.catch(...)`，不再有 unhandled rejection 入口；启动检查同样带 `.catch`。
- `dispose` 时除子进程/定时器/fetch 外，下载只在内存攒包、通过 `writeFileAtomicSync` 落盘，abort 后不会留下半包；下载中的临时文件由原子写自身清理。
- `/list` 的 busy 轮询仍只在 `isUpdateBusy` 时存在（`src/client` 本轮未改）；`diagnostics`/`/list` 载荷上限未改（既有测试仍绿）。
- 未做（与本轮 6 条无关，保留在复审建议里）：暂存区 `updates/<version>/` 的 GC；`shellQuoteArg` 对 `%` 的处理；把 `<runtime>/bin` 加进子进程 PATH；把 `node_modules/dsh-worktodo/package.json` 纳入事务快照。

---

### 全量门禁与剩余不确定

- 本机：`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` → 退出码 0，**10/10**。
- 干净环境：`env -i HOME=/tmp/cihome PATH=<node bin>:/usr/bin:/bin CI=true node tools/verify-all.mjs` → 退出码 0，**10/10**。
- 反向验证 5 次（第 1、2、3 两条、5 条）均按预期变红并已全部恢复；恢复后 118 条 smoke-host 用例全绿。
- 剩余不确定：
  - **没有真机 Windows**：`MoveFileEx` 覆盖、`taskkill /T /F`、杀软/索引器占用导致二次 rename 失败都是形状测试 + 注入失败模拟，未在 Windows 实机跑。
  - 没有对真实 DSH CLI 触发 `active-run` / 兼容性拒绝（离线约束，用假 CLI 的 stderr 语义覆盖）；真实 stderr 措辞若与分类正则不符，会落到安全侧 `cli-refused`（仍然 failed、不降级）。
  - 跨进程锁的 stale 回收在极端并发下依赖第二次 `open('wx')` 竞态兜底（已有纯函数用例，未做多进程压力测试）。
  - dispose 若发生在 pnpm **已经改写** profile 之后，本实现选择「不再写盘（不回滚）」，因此那次运行可能留下被改写的规格；这是按「卸载后零写盘」要求做的取舍，已在状态里记 `skipped:'disposed'`。
