# Windows 自更新修复（dsh-worktodo，未升版本）

> 范围：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`。
> 本轮**不升版本、不提交、不打 tag、不发布**；测试只用 `/tmp` 假 profile 与临时 `DSH_HOME`。
> 结论先行：**最可能的真因不是「版本校验坏了」，而是 Windows 上 pnpm 兜底根本起不来**——
> 自带 `pnpm.mjs` 的路径写错，退回 `spawn('pnpm')` 后 Windows 只认 `pnpm.cmd`，子进程直接
> `spawnFailed`；CLI 那一步若也没真正装上（历史上真机出现过 `dsh plugin add` 退出码 0 但
> `added 0`），整条序列就没有任何一步能改 `node_modules`，版本当然一直是 0.2.5。

## 0. 先看官方桌面版和隔壁插件怎么做的

这一步很值：官方入口的形状和我们原来的猜测有出入。

- 官方 CLI 启动器 `~/.../DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`：
  `ELECTRON_RUN_AS_NODE=1 exec "<MacOS>/DeepSeek Harness" --expose-internals "<Resources>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"`。
- 官方 Windows 节点启动器 `runtime/bin/node.cmd`：
  `set ELECTRON_RUN_AS_NODE=1` + `"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals %*`。
- 隔壁插件 `dsh-token-meter-panel` 的 `resolveUpdateCommand()`：
  - 用 `process.env.DSH_DESKTOP_NODE_EXECUTABLE || process.execPath`；
  - 候选 resources 目录是 `dirname(nodeExec)/../Resources`、`dirname(nodeExec)/resources`、`dirname(nodeExec)/../resources`；
  - **检查 `app.asar` 归档文件是否存在**，而不是检查 asar 内部的 `cli.js`（普通 fs 看不见 asar 内部）；
  - 同时兼容 `app`、`app.asar.unpacked`；
  - 只有回退到 PATH 上的 `dsh` 且 `win32` 时才 `shell: true`。

本轮据此把 CLI/pnpm 的定位改成「官方同款形状」，而不是继续维护自己的猜测。

**macOS 真实布局核对**（不是 Windows，但确认形状与官方一致）：
- `resolveCliUpdater` 用 `.../Contents/Resources` + 官方 execPath 时，得到的 CLI 是
  `.../Resources/app.asar/dsh/node_modules/.../cli.js`；`app.asar` 归档本身存在（asar 内部路径普通 fs 不可见）。
- `resolvePnpmUpdater` 命中 `.../Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`；
  用 `ELECTRON_RUN_AS_NODE=1 "<app 可执行文件>" "<pnpm.mjs>" --version` 实测输出 `11.28.5`、退出码 0。

## 1. 根因候选清单（逐条判断）

| # | 候选 | 是不是真因 | 证据 / 推断 |
|---|---|---|---|
| 1 | 自带 pnpm 路径写错 → 退回裸 `spawn('pnpm')` | **是，最高置信** | 旧代码只找 `<resources>/runtime/pnpm/bin/pnpm.mjs`；本机实际是 `<resources>/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`（Windows 打包同布局）。该路径不存在 → 永远走 PATH 上的裸 `pnpm`。Node 在 `shell:false` 下用 CreateProcess，**不会按 PATHEXT 找 `pnpm.cmd`**，所以 Windows 上直接 `ENOENT` / spawnFailed。 |
| 2 | CLI 定位用了 asar 内部路径 / `process.execPath` | **可能是次因** | 桌面 Electron 有 asar fs 支持，旧写法可能碰巧可用；但非 Electron 宿主（`dsh web`、纯 node）看不到 asar 内部，CLI 直接判定不存在。官方与隔壁插件都改成「`app.asar` 归档存在即用」，并优先 `DSH_DESKTOP_NODE_EXECUTABLE`。 |
| 3 | `profileDirFromModuleUrl` 只用 `sep` | **不是本 bug 真因，但确实脆弱** | 真 Windows 的 `fileURLToPath` 返回反斜杠，`sep` 也是反斜杠，marker 能命中；所以它单独不会造成「版本不变」。但 junction/混合分隔符会让它失配，且无法在 macOS 上模拟验证。已改为同时认 `/` 与 `\`、盘符大小写不敏感、`%20`/UNC 覆盖。 |
| 4 | Windows `rename` 覆盖已存在目标失败 | **不是版本不变的真因；是真实 Windows 风险** | `writeFileAtomicSync` 只写状态文件/下载暂存/回滚清单，不改 `node_modules`，所以它不会直接导致「0.2.5 不变」。但被杀软/索引器占用时 `rename` 可能 `EPERM/EBUSY`，会造成状态文件写不进、回滚失败或半写。已加「先删目标再 rename」回退，并把二次失败转成明确错误。 |
| 5 | `$DSH_HOME` 路径拼接硬编码 `/` | **不是** | 现有代码已用 `path.join`；`resolveUpdateStatePath`/`resolveUpdateStageDir` 也都是 join。 |
| 6 | `--registry` 参数被 Windows shell 拆开 / 引号错误 | **不是主因** | 首选路径（node + argv 数组、无 shell）不会拆；本轮仍补了 shell 分支的逐参数引号，并把「无 shell」保持为默认。 |
| 7 | 升级序列「假成功」：命令退出码 0 就报 done | **不是**（现有代码已读落盘版本） | 代码已有 `installedVersionChanged(before, after)`，读不到版本也判失败。本轮用端到端测试把这条在 Windows 模拟下钉死，防止以后回退。 |
| 8 | CLI `@latest` 退出码 0 但 `added 0` | **是已知旧问题，也是本 bug 的放大器** | `docs/reviews/self-update.md` 已记录真机 `dsh plugin add` 退出码 0 却没换版本；所以 pnpm 兜底是必需的，而它正好在 Windows 上坏了。 |
| 9 | profile pin 死/镜像缓存/registry | **可能，但非 Windows 特有** | 现在失败诊断会直接显示目标版本、当前落盘版本、命令、退出码与日志尾部，能区分「命令没跑」与「跑了但装到旧包」。 |

**一句话根因链**：自带 pnpm 路径错 → 退回裸 `pnpm` → Windows `ENOENT` → pnpm 两步全跳过 →
CLI 若 no-op 或不可用 → 落盘版本不变 → 状态如实地报 failed，但用户只看到「版本还是 0.2.5」。

## 2. 修法

### 2.1 跨平台路径（`lib/index.js`）

- 新增 `platformOf()`（测试缝 `WORKTODO_PLATFORM`，只影响命令/路径形状，不改真实 fs 语义）、
  `joinPath()`、`dirnamePath()`、`fileUrlToPathFor()`、`isWindowsPathLike()`。
- `profileDirFromModuleUrl`：
  - 生产用 `fileURLToPath`（`%20`、盘符、UNC 交给官方）；
  - marker 改成 `/(?:^|[\\/])node_modules[\\/]dsh-worktodo[\\/]/i`，同时认 `/` 与 `\`，大小写不敏感；
  - 返回 `path.win32.normalize` 的 `C:\...` 形状；
  - `exists` 可注入，macOS 上也能验证「目录里必须有 package.json」。
- `resolveOwnProfileDir`：注入的 `C:\...`/`C:/...` 用 `path.win32.resolve`；posix 临时目录仍用原生
  `resolve`（模拟 win32 时不把 `/tmp` 解析成 `\tmp`）。

### 2.2 CLI（对齐官方启动器与隔壁插件）

- `nodeExec = DSH_DESKTOP_NODE_EXECUTABLE || process.execPath`；
- resources 候选：`process.resourcesPath` → `dirname(nodeExec)/../Resources` →
  `dirname(nodeExec)/resources` → 反大小写兄弟目录；
- **只检查 `app.asar` 归档文件是否存在**，命中后拼
  `app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`；兼容 `app` 与 `app.asar.unpacked`；
- 执行环境带 `ELECTRON_RUN_AS_NODE=1` 与 `DSH_DESKTOP_NODE_EXECUTABLE`，参数走数组（无 shell）。

### 2.3 pnpm（Windows 的核心修复）

`resolvePnpmUpdater()` 现在按优先级返回：

1. **同进程 node + 自带 `pnpm.mjs`**：`command = nodeExec`、`args = [pnpm.mjs, ...]`、无 shell；
   自带路径覆盖 `runtime/<name>/dependencies/pnpm/bin/pnpm.mjs`、`runtime/<name>/pnpm/bin/pnpm.mjs`、
   `runtime/dependencies/...`，并用 `readdir` 补充未知 runtime 目录名。
2. 找不到自带 pnpm：Windows 返回 `pnpm.cmd` + `shell: true`（并逐个参数加引号）；POSIX 保持 `pnpm` 无 shell。
3. 所有执行器都带 `windowsHide: true`；`runUpdateStep` 也统一传 `windowsHide: true`。

这样 Windows 上**正常路径完全无 shell**，不存在「路径带空格被拆开」或「`.cmd` 不能被 CreateProcess 解析」。

### 2.4 原子写（`writeFileAtomicSync`）

- 保留临时文件 + 循环写入 + `fsync` + `rename` 的既有保证；
- Windows 下 `rename` 失败（`EPERM/EACCES/EBUSY/EEXIST/ENOTEMPTY/EISDIR`）→ 先 `unlink` 目标、再
  `rename`；第二次仍失败则抛 `Windows 原子写失败：无法替换 ...（rename: ...；删除目标后重试: ...）`；
- 任何失败都清临时文件；测试注入 `platform/rename/unlink` 覆盖「先删后成功」「删不掉」「POSIX 不吞错」三条分支。

### 2.5 诊断可见（GET /worktodo/update + 面板）

- 状态新增 `diagnostics`（失败时）：
  `step`、`command`、`executable`、`argv`、`exitCode`、`signal`、`timedOut`、`spawnError`、
  `shell`、`windowsHide`、`target`、`currentVersion`、`installedVersion`、`profileDir`、
  `platform`、`updater`、`pnpm`（command/args/shell/source）、`attemptedSteps`、`logTail`。
- `/list` 摘要也带 `diagnostics`（日志尾部只留 8 行），页面刷新后仍能看到失败步骤。
- 面板失败徽标下方新增一行小字「详情」：步骤 / 命令 / 退出码 / 版本 / 日志尾部；
  `title` 里是全文；只用文本节点（无 `innerHTML`）；中英文案键都补齐。

## 3. 测试与反向验证

新增/加强（仍是 **9 个测试文件**）：

- 宿主 `tools/smoke-host.mjs`（103 通过）：
  - Windows `file:///C:/...` → `C:\...\profiles\desktop`；反斜杠注入、盘符大小写、`%20`、UNC、缺 `package.json`；
  - Windows pnpm：`node + pnpm.mjs` 优先（路径含空格仍是一个 argv）、`pnpm.cmd + shell` 兜底、POSIX 回归；
  - Windows CLI：`app.asar\...\cli.js` 形状、`ELECTRON_RUN_AS_NODE`、`DSH_DESKTOP_NODE_EXECUTABLE` 优先；
  - `rename` 失败回退三态；
  - `installedVersionChanged` 假成功护栏；
  - **Windows 模拟端到端**：`WORKTODO_PLATFORM=win32` + 假 `pnpm.mjs`，命令成功但版本不变 → `failed/version-unchanged`，
    诊断含 step/命令/退出码/版本/日志；正对照假 pnpm 真换版本 → `done`。
- 客户端 `tools/smoke-client.mjs`（63 通过）：
  - 失败详情包含步骤/命令/退出码/版本/日志尾部（中英双语键）；
  - 页脚渲染一行详情、`title` 全文、无 `dangerouslySetInnerHTML`。

反向验证（临时改坏 → 跑 `smoke-host` → 必须变红 → 恢复；文件已按 hash 校验还原）：

| 故意破坏 | 结果 |
|---|---|
| profile marker 改回只认 `/` | `102 通过，1 失败`：`Windows 路径...期望 "C:\Users\u\...\desktop"，实际 null` |
| Windows 兜底改回裸 `pnpm` | `102 通过，1 失败`：`Windows 兜底命令必须是 pnpm.cmd：期望 "pnpm.cmd"，实际 "pnpm"` |
| `doneIfChanged` 改成「能读到落盘版本就 done」 | `89 通过，14 失败`，其中目标用例：`版本没变绝不能报 done（实际 done）` |

全量：`node tools/verify-all.mjs`（含 build）→ **10/10 个步骤通过**。

## 4. 仍无法验证的部分（真机 Windows 限制）

1. 没有真机 Windows，无法验证 CreateProcess 对 `pnpm.cmd`/`node.exe`/Electron 的真实解析，也无法验证杀软/索引器对 `rename` 的占用行为。
2. 无法验证 Windows 安装包内真实的 `process.resourcesPath`、`app.asar` 布局、`DSH_DESKTOP_NODE_EXECUTABLE` 的实际值；代码按官方启动器与隔壁插件的形状对齐，但未在 Windows 上执行。
3. 无法验证 Windows 上 `dsh plugin add` 本身是否仍 `added 0`（历史记录是 macOS 真机）；本轮只保证「CLI 不可用/ no-op 时 pnpm 兜底能跑，且跑没跑由落盘版本判定」。
4. 未做真实升级（约束要求不碰真实 profile/数据）；端到端只用 `/tmp` 假 profile + 假 pnpm。
5. `rename` 的 `EPERM/EBUSY` 错误码是常见集合，不排除 Windows 上出现其它错误码（未知码会保持原样抛出，不会半写）。

## 5. 如果 Windows 上还失败，请提供这些

1. 面板失败徽标下方「详情」那一行，或 `GET /worktodo/update` 返回里的 `diagnostics`：
   - `step`（失败步骤）、`command` / `argv`、`exitCode`、`target` / `currentVersion` / `installedVersion`、`logTail`。
2. 同一份状态里的 `platform`、`pnpm.command` / `pnpm.shell` / `pnpm.source`，用来确认走的是 `node pnpm.mjs` 还是 `pnpm.cmd`。
3. Windows 上这几条命令的输出：
   - `where pnpm`、`where node`、`pnpm --version`；
   - `Get-ChildItem "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime"`（看 runtime 目录名）；
   - `Get-ChildItem "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin"`；
   - `$env:DSH_DESKTOP_NODE_EXECUTABLE`。
4. `$env:DSH_HOME\worktodo\update-state.json`（跨重启节流状态；不包含待办内容）。
5. 如果方便，手工在 profile 目录跑一次失败诊断里给出的那条命令，把完整 stderr 贴出来。

## 6. 本轮未做

- 未升 `package.json` 版本、未改 CHANGELOG / `.github`；
- 未 commit / push / tag / 发布；
- 未触碰真实 profile 或真实待办数据。
