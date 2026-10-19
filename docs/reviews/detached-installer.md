# 独立安装器：从「在 live profile 里跑 pnpm」到「下载 → detached 安装器换目录 → 重启生效」

- 仓库：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`
- 版本：0.2.9（本轮**不升版本**、不改 CHANGELOG / `.github`、不 commit / push / tag / 发布）
- 日期：2026-10-19
- 代码：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/apply-update.mjs`（新增）、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/package.json`
- 测试：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs`、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-contract.mjs`、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/verify-privacy.mjs`
- 测试套件仍是 **9 个**（`verify-all.mjs` 跑 9 个套件 + 1 次构建 = 10 步）。

## 1. 黑屏根因

用户点「安装」后，面板黑屏 / 页面消失。根因不是「pnpm 太慢」，而是**在应用运行中改动了 live profile 的依赖树**：

1. 旧安装路径在宿主进程里执行 `dsh plugin … add` / `pnpm update` / `pnpm add`；
2. pnpm 会重写整个 `<profile>/node_modules`（以及 `package.json` / `pnpm-lock.yaml`）；
3. 正在运行的 DSH 自己也在同一个 `node_modules` 里解析模块；重写过程中，
   正在被加载/被引用的模块文件被替换、裁剪或短暂消失；
4. 页面随后按新/半新依赖树加载失败 → 黑屏。

因此「把 pnpm 放到后台跑」不能解决：**只要还在 live profile 的依赖树上跑包管理器，窗口期就存在**。
本轮的前提是：**应用运行期间绝不修改 live profile 的依赖树**；只替换插件自己的一个目录，装完提示重启。

## 2. 新架构

### 2.1 下载 + 解包（宿主侧，仍是 async）

沿用原有下载的全部护栏：流式读取、32 MiB 上限、sha1（registry 有 `dist.shasum` 时逐字比对）、
落盘回读校验、失败不留半个文件、暂存目录在插件自己的 `$DSH_HOME/worktodo/updates/`。

新增「解包成完整包目录」：

```
$DSH_HOME/worktodo/updates/
  dsh-worktodo-<版本>.tgz      校验过的原始 tarball（安装前复核）
  <版本>.manifest.json         下载清单（artifact / stagedDir / sha1 / bytes / url）
  <版本>/                      解包后的完整包目录（package.json / lib / src / cordis.patch.yml …）
```

解包只用 `node:zlib` + `node:fs` 自己解析 npm 的 gzip + ustar，不调用系统 `tar`：

- 只接受 `package/` 前缀下的普通文件/目录；拒绝绝对路径、`..`、符号链接、硬链接；
- 解包后再次校验 `package.json` 的 `name` 与 `version` 必须等于目标；
- 压缩包 32 MiB 上限之外，解包总量再设 128 MiB 上限（防压缩炸弹）；
- 解包失败会把 tarball、清单、解包目录一起清掉。

### 2.2 独立安装器 `tools/apply-update.mjs`

宿主以 **detached 子进程** 拉起：

```js
spawn(nodeExec, [applyUpdatePath, '--staged', …, '--target', …, '--version', …, '--state', …, '--log', …], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
```

安装器是**单文件**，只 import `node:` 内置模块，不 require 仓库里的其它模块（半更新状态也能独立跑）。
它只做一件事：替换 `<profile>/node_modules/dsh-worktodo` 这一个目录。

1. 校验 `--staged/package.json` 的 `name` / `version` 与 `--version` 一致；
2. `fs.realpath(target)` 解析真实目录（pnpm 下是
   `<profile>/node_modules/.pnpm/dsh-worktodo@x.y.z/node_modules/dsh-worktodo`；
   hoisted/npm 下就是自身）；目标不存在也允许（首次安装）；
3. 幂等：目标里已经是目标版本 → 直接成功，一个文件都不动；
4. 先把新目录 copy 到**同级** `.worktodo-new-<ts>`；
5. 旧目录 rename 成**同级** `.worktodo-backup-<ts>`；
6. `.worktodo-new-<ts>` rename 成目标名（原子替换）；
7. 读目标 `package.json` 校验落盘版本；
8. 成功：保留最近一份备份，清掉更老的备份；
9. 失败：从备份恢复（rename 回目标），恢复成功后再 copy 一份备份保留，供人工回退；
   最终结果写 `apply-result.json`，并合并 `lastApply` 到 `update-state.json`（保留 `attempted` 节流字段）。

全流程写 `--log` 指定的日志：时间戳 + 每一步 + 失败堆栈。日志文件名为
`apply-<YYYYMMDD-HHmmss-SSS>.log`（纯数字/连字符，Windows 文件名合法）。

### 2.3 宿主侧编排（`startInstall`）

`startInstall` 不再构造 pnpm/CLI 步骤，也不再调用 `runUpdateSequence`：

1. 预判 `unsupported`（`link:` / `file:` / `workspace:` / 指向 profile 外的 symlink / 推不出 profile）
   → 一个子进程不起、一个字节不写；
2. 两步流程（`requireDownload`）下复核 tarball + 解包目录都在、包身份对；
3. 读取 profile 清单，拒绝坏 JSON / 没装本包 / 本地协议；
4. 拿跨进程锁（防两个宿主同时替换同一个目录）；
5. 设置 `phase='installing'`，删除旧的结果文件，spawn detached 安装器；
6. **立即**返回 `installing`（实测 <10ms，测试断言 <500ms）；后台轮询
   `<状态文件同目录>/apply-result.json`，上限 120s（`WORKTODO_APPLY_TIMEOUT_MS` 仅测试缝）；
7. 成功 → `installed` + `restartRequired`（落盘版本 > 运行版本）；失败 → `failed`，
   把安装器日志尾部（最后 40 行）放进 `diagnostics.logTail`，并带 `reason` / `target` /
   `previousVersion` / `backup` / `restored` / `rollbackFailed`；
8. 安装器提前退出且没写结果 → `apply-exited`；超时 → `apply-timeout`；
9. 宿主 dispose（插件卸载 / 面板会话结束）**不会杀安装器**：它已经 detached 并 unref，
   测试实测卸载后仍把新版本装完。

`plugin-update` 旧接口仍保留「一次到位」：先下载，下载成功后走同一条安装器路径；
`plugin-update-download` / `plugin-update-install` 两步语义不变。
`off` / `manual` / `auto` 三档语义不变；`auto` 只是自动触发「下载 → 安装」，**不自动重启**。

## 3. 为什么这样不会再黑屏

- 安装路径**不再执行 pnpm / npm / dsh CLI**（测试用绊线 bin 钉死调用数为 0）；
- **不改** `package.json`、**不改** `pnpm-lock.yaml`、**不重写** `node_modules`；
- 只改 `<profile>/node_modules/dsh-worktodo`（pnpm 下是它 realpath 指向的真实目录）一个目录，
  且是先 copy 新目录、再 rename 替换；其它包、`.pnpm` 里别的目录逐字节不变（测试有快照比对）；
- 正在运行的 DSH 已经加载的模块仍在内存里，替换磁盘文件不会让当前页面重新解析模块；
  新版本要等下一次启动才加载 → 面板显示「已更新到 vX，请重启 DSH 生效」；
- 即使替换失败，旧目录还在备份里，安装器会恢复它，不会留下半新半旧的包目录。

## 4. 安全边界（只碰自己的目录）

- 目标必须是 `…/node_modules/dsh-worktodo` 形状；否则 `unsafe-target` 拒绝；
- 暂存包必须 `name=dsh-worktodo` 且 `version` 等于目标版本，否则 `staged-*` 拒绝；
- 安装器不跑任何外部命令；不写 profile 清单/lockfile；不碰 lockfile；
- 备份/临时目录都用 `.worktodo-*` 前缀，且只在目标同级；
- 解包拒绝路径穿越 / 绝对路径 / 链接条目，并有两级体积上限；
- `link:` / 推不出 profile 仍然 `unsupported`（零下载、零安装、零写盘、零子进程）；
- 跨进程锁只在宿主编排期间持有；拿不到锁 → `busy`，零写盘、零子进程。

## 5. 测试（全部加进现有 9 个套件）

`smoke-host.mjs` 现在 **106 通过 / 0 失败**。本轮新增/改写的核心用例：

1. **零 pnpm/CLI**：假 profile + 本地假 tarball 走完整「下载 → 解包 → 安装」；
   绊线 `pnpm` / `npm` / `pnpm.cmd` / `npm.cmd` 与假 `dsh` CLI 的调用记录必须为 **0**；
   安装器结果文件里有独立 pid。
2. **真实文件替换（普通目录 + pnpm symlink 两种布局）**：
   安装后目标 `package.json` 版本变成新版本；profile 里除本包目录外的文件/目录
   （含 `package.json`、`pnpm-lock.yaml`）逐字节未变；symlink 布局下链接本身与 `.pnpm` 里其它内容不变。
3. **回滚**：`WORKTODO_APPLY_FAIL_STEP=rename-target` 注入 rename 失败 →
   目标 `package.json` 与旧文件逐字节恢复、状态 `failed` + `replace-failed` + 「已从备份恢复」、
   备份目录存在且版本是旧的、`steps` 里有 `rollback: ok`。
4. **detached 证据**：
   - 纯函数断言 `buildApplyInstallerSpec` 返回 `options.detached===true`、
     `options.stdio==='ignore'`、`unref===true`；
   - 安装器注入 700ms 延迟时，宿主 POST 安装 <500ms 就返回 `installing`；
   - 宿主 dispose 后安装器继续跑完并写下 `installed`。
5. **日志尾部**：注入失败后 `diagnostics.logTail` 非空、≤40 行、包含
   `injected rename-target`；`--log` 文件存在。
6. **幂等 + Windows rename 退避**：直接跑安装器两次，第二次 `alreadyInstalled:true`
   且目标目录快照不变；注入前 2 次 rename EPERM 后仍成功，日志里有「重试」。
7. 既有的 unsupported / 两步护栏 / 下载失败 / 下载物被删改 / 恢复已下载 / 三档设置 /
   跨重启节流 / 自动更新 / 重启诚实提示全部保留并适配新架构。

### 5.1 反向验证（改坏 → 变红 → 恢复 → 变绿）

| 故意改坏 | 结果 | 关键报错 |
| --- | --- | --- |
| 在安装器里临时 `spawnSync('pnpm', ['update'])` | `smoke-host` 104/106，EXIT=1 | `安装路径必须零 pnpm/npm/CLI 调用（实际 1 次）`；`auto 安装也必须零 pnpm/CLI（实际 1）` |
| 把安装器的回滚分支改成恒不执行（`if (false)`） | `smoke-host` 105/106，EXIT=1 | `错误必须说明已从备份恢复…期望 true，实际 false` |
| 两处均恢复 | `smoke-host` 106/106，EXIT=0 | — |

## 6. 两套门禁

两套都显式检查退出码（没有用管道吞失败）：

```bash
WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs
# EXIT=0，10/10 个步骤通过（含构建）
```

```bash
env -i HOME=/tmp/cihome PATH=<node目录>:/usr/bin:/bin CI=true node tools/verify-all.mjs
# EXIT=0，10/10 个步骤通过（含构建）
```

干净环境先重建 `/tmp/cihome`，不带任何 `WORKTODO_*` / `DSH_*` 变量；
`verify-all.mjs` 自己在子进程环境里设置 `WORKTODO_NO_UPDATE_CHECK=1`，全套测试不联网。

`verify-privacy.mjs` 的发布面边界同步收窄：`tools/` 里**只允许**
`tools/apply-update.mjs`（它是运行时安装器，必须进发布包），其它 `tools/*` 仍然判红。

## 7. 未做 / 不确定

- **真机 Windows 的 rename 占用没有实测**：安装器对 `EPERM` / `EACCES` / `EBUSY` /
  `ENOTEMPTY` 做 10 次指数退避重试（60ms→1s 封顶），仍失败则从备份回滚并如实报
  `replace-failed`。本轮只在 macOS 上用注入 `EPERM` 验证了重试与回滚，没有在真实 Windows
  上验证杀毒/索引器长时间占用目录的极端情况；最坏结果是「本次安装失败、旧版本完好、提示重启后再试」。
- **运行中的进程若在 Windows 上持有目标目录内文件的句柄**，第一次 rename 旧目录可能失败；
  安装器会重试，仍失败则不改目标并回滚。真正安装前是否需要先退出 DSH 没有在真机验证。
- **没有在真实 profile / 真实 DSH 桌面版里点过真实安装**（按约束只使用 `/tmp` 假 profile +
  临时 `DSH_HOME` + 本地假 tarball）。面板显示由 `smoke-client` 真渲染覆盖。
- **备份保留策略**：成功时保留最近一份备份（同级 `.worktodo-backup-*`），并清理更老的；
  失败回滚后同样保留一份。极端情况下会多占一份包目录的磁盘空间。
- **旧的 pnpm/CLI 执行器代码仍作为导出/测试缝保留**（`resolvePnpmUpdater` /
  `buildUpdateSteps` / `runUpdateSequence` 等），但安装路径不再调用它们；
  用例 1 用零调用钉死了这一点。长期可以再删，避免读者误以为它们仍生效。
- **sha1 的信任边界**：只有 registry 元数据带 `shasum` 时逐字比对；注入 latest 的测试环境
  没有对照值，只记录不比对。更严格的签名/来源校验本轮未做。
- 本轮未升版本、未改 CHANGELOG / `.github`、未 commit / push / tag / 发布；
  `package.json` 仍是 0.2.9，只新增了 `files` 里的 `tools/apply-update.mjs`。
