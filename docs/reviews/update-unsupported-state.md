# 更新不适用（unsupported）：link:/推不出 profile 不再报「更新失败」

- 仓库：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`
- 版本：0.2.9（本轮不升版本、不改 CHANGELOG/.github、不 commit/push/tag/发布）
- 日期：2026-10-19
- 代码改动：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`
- 测试改动：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs`、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`
- 构建产物：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/client.js` 与
  `.map` 由 `tools/build-client.mjs` 重新生成；测试文件仍是 9 个套件。

## 1. 现状为什么报 failed

`resolveOwnProfileDir()` 只有两条精确信号：显式 `WORKTODO_PROFILE_DIR`，或从
`import.meta.url` 反推 `.../profiles/<name>/node_modules/dsh-worktodo/lib/index.js`。

`link:` 本地开发安装时，Node 的 ESM 默认把软链接解析成**仓库真实路径**，路径里没有
`node_modules/dsh-worktodo` 段，于是 `resolveOwnProfileDir()` 返回 `null`。`startInstall()`
随后走到：

```
if (!profileDir) {
  setPhase('failed', {
    failedOperation: 'install',
    failure: 'profile-not-found',
    error: '反推不出本实例自己所在的 profile 目录（link: 装载或非标准布局）…',
  });
}
```

面板的 `failureBadge()` 按 `failed` 渲染成红色 `更新失败：<原始错误>`，并给一个「重试」。
更关键的是：原来的 `isLocalSpec()` / `linked` 守卫在**定位 profile 之后**才执行，所以
link 安装往往根本走不到那条守卫，先以 `profile-not-found` 失败收口。

安全行为一直是对的：没有猜 `$DSH_HOME/profiles/*`、没有写 profile、没有起子进程；错的只是
**状态分类和文案**——把「预期内的不适用」说成了「更新失败」。

## 2. 新分类与文案

### 2.1 状态

新增 `phase: 'unsupported'`，并同时给出稳定种类：

- `updateUnsupported: 'link-install'`：本地链接安装（开发模式）。
- `updateUnsupported: 'profile-undetermined'`：推不出本实例的 profile。

兼容层保持不变：

- `state` 映射回 `idle`（老面板不会亮红色 failed 徽标）；
- `failure` / `failedOperation` 都是 `null`（不是失败）；
- `reason` 是稳定种类（`link-install` / `profile-undetermined`）；
- `hasUpdate` 仍按「registry latest vs **运行版本**」计算，语义不变；
- 技术细节只进 `diagnostics`：`step: 'preflight-unsupported'`、`kind`、`evidence`、
  `profileDir`、`target`、`currentVersion`、`installedVersion`、`platform`、`logTail`。

### 2.2 文案

| 种类 | 中文 | English |
|---|---|---|
| `link-install` | 当前是本地链接安装（开发模式），面板不能自更新；请用 git/pnpm 工作流更新 | Local link install (dev mode) — panel self-update doesn't apply; update via your git/pnpm workflow |
| `profile-undetermined` | 无法确定当前 profile 位置，为安全起见未执行升级（未改动任何文件） | Couldn't determine the profile location; upgrade skipped for safety (no files changed) |

面板在 `updateBadgeState()` 里对 `phase === 'unsupported'` 单独分支：

- `tone: 'muted'`（与已有的 `check-failed` 同风格，不亮红）；
- `action: null`、`disabled: true`（没有「重试」/「下载」/「安装」按钮）；
- 只显示上表文案，不显示 `诊断 detail`，也不显示「反推不出…」原始异常串；
- `isUpdateBusy()` 不把 `unsupported` 算作进行中，因此不会常驻轮询。

### 2.3 提前判定

新增只读预判 `detectUnsupportedInstall()`，在两条路径的**最前面**调用：

- `downloadUpdate()`：在决定目标版本、打网络、创建暂存区之前；
- `startInstall()`：在 `requireDownload` 护栏、跨进程锁、任何子进程之前。

判定顺序（任一命中即 `link-install`）：

1. profile 清单里本包依赖是 `link:` / `file:` / `workspace:`（`dependencies` 或
   `devDependencies` 任一段位，复用 `isLocalSpec()`）；
2. `node_modules/dsh-worktodo` 是符号链接，且 `realpath` 后的目标落在 profile 自己的
   `node_modules` **之外**（指向源码仓库）。

第 2 条刻意排除了 pnpm 的正常安装：pnpm 的 registry 安装本来就会把
`node_modules/dsh-worktodo` 链到 `<profile>/node_modules/.pnpm/...`，目标在 profile 的
`node_modules` 内，因此不会被误判成开发安装（有专门用例钉住）。

反推不出 profile 时返回 `profile-undetermined`。如果 profile 清单**读不到或不是合法 JSON**，
预判返回 `null`，仍走原有 `profile-manifest-*` 失败路径（那是真的需要人工检查，不属于
「预期内的不适用」）。

安装序列里原有的 `linked` / `profile-not-found` 兜底分支也改成同一个 `markUnsupported()`；
`restoreDownloaded()` 不会把已经判定的 `unsupported` 重新覆盖成「已下载」。

## 3. 零写盘、零子进程证据

测试里的 `snapshotTree()` 对目录做逐文件快照：文件内容按 base64 记录原始字节、权限位、
符号链接目标；前后用 `eq()` 深比较，不是看 mtime。

- **`link:` 安装**：假 profile 的 `dependencies.dsh-worktodo = "link:…"`。
  - 先发「下载」再发旧接口「一次到位」，两次都 `ok:false`、`reason:'link-install'`；
  - `GET /worktodo/update` 读到 `phase:'unsupported'`、`updateUnsupported:'link-install'`、
    `state:'idle'`、`failure:null`、`failedOperation:null`；
  - 暂存目录 `existsSync(stageDir) === false`（判定发生在下载之前）；
  - 假 pnpm 的 capture 文件不存在，`invokeCount === 0`；
  - profile 目录快照前后完全相等。
- **symlink 安装**：`node_modules/dsh-worktodo` 指向 profile 外的源码目录。
  - 判定 `link-install`，`diagnostics.evidence === 'node-modules-symlink'`；
  - profile 快照（含链接本身）与链接目标仓库快照都逐字节不变；
  - 零子进程、暂存区不存在。
- **推不出 profile**：不设 `WORKTODO_PROFILE_DIR`，`$DSH_HOME/profiles/{aaa,zzz}` 里同时
  放 registry 安装与 link 安装。
  - `phase:'unsupported'`、`updateUnsupported:'profile-undetermined'`；
  - 整个 `$DSH_HOME` 快照逐字节不变（没有新文件），`aaa/package.json` 的 mtime 也不变；
  - 零子进程。
- 手动下载/安装路径没有 `attempt`，因此连插件的 `update-state.json` 也不写。自动更新路径会写
  插件自己的状态文件（`result:'unsupported'`，用于跨重启节流），但**不碰 profile、暂存区或
  待办数据**。

## 4. 测试

全部加进现有 9 个套件（没有新增测试文件）：

- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs`
  - 新增「link: 安装 → unsupported/link-install」完整用例（下载 + 旧接口 + `hasUpdate` 兼容）；
  - 新增「symlink 指向仓库 → unsupported/link-install」用例；
  - 新增 `link:` / `file:` / `workspace:` 预判用例，以及「pnpm `.pnpm` 内部 symlink 不算」
    的反向保护用例；
  - 更新 A3（任一段位本地协议）、A5（推不出 profile）、自动更新 link 场景、检查在飞场景的断言；
  - 顺手修了 dispose 用例的 pid 文件竞态：原来只等 capture 文件就读取 pid，偶发 ENOENT 并
    残留跨进程锁，导致下一条 B3 连环红；现在等 pid 文件存在，并在 finally 回收锁。
- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`
  - 新增 `updateBadgeState：unsupported 是温和态（muted）…`：两种 kind × 中英，
    断言文案、`muted`、无 action、无 detail、无「失败/failed/原始异常串」，并检查双语文案键。

本机结果：`smoke-host.mjs` 124 通过 / 0 失败；`smoke-client.mjs` 65 通过 / 0 失败。

## 5. 反向验证（测试有牙齿）

1. **去掉 link: 判定**：临时把 `if (local.length)` 与 `if (linked?.external)` 改成永不命中，
   重跑 `smoke-host.mjs` → **119 通过 / 5 失败**。其中直接变红的是：
   - `自升级：link: 安装 → unsupported/link-install…`
   - `自升级：node_modules/dsh-worktodo 指向仓库的 symlink…`
   - `预判：link:/file:/workspace: 都算本地链接安装…`

   另 2 条是被前一条失败用例残留的跨进程锁/暂存物连带（busy、downloaded）；恢复判定后
   124 / 0 全绿，证明不是测试本身依赖这些连带失败。
2. **把 unsupported 映射回 failed**：临时把面板 unsupported 分支的
   `return view(t(key), t(key), 'muted', null, true)` 换成 `return failureBadge(run, t, view)`，
   rebuild 后跑 `smoke-client.mjs` → **64 通过 / 1 失败**，失败信息正是要避免的形态：
   `期望 "当前是本地链接安装…" / 实际 "更新失败：当前是本地链接安装…"`。恢复后 65 / 0。
   两次恢复都用文件校验和确认与破坏前一致。

## 6. 两套门禁

1. 本机：

   ```
   WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs
   ```

   → **10/10 个步骤通过（含构建），EXIT=0**。

2. 干净环境（`env -i`，HOME 指到临时目录，不带任何 `WORKTODO_*` / `DSH_*`）：

   ```
   env -i HOME=/tmp/cihome PATH=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:/usr/bin:/bin \
     CI=true node tools/verify-all.mjs
   ```

   → **10/10 个步骤通过（含构建），EXIT=0**。

## 7. 未做 / 不确定

- **真实 `link:` 安装且没有 `WORKTODO_PROFILE_DIR` 时**：模块 URL 已被 ESM realpath 成仓库
  路径，推不出 profile，本实现会报 `profile-undetermined`，而不是 `link-install`。两者都是
  `unsupported`、都零写盘，但文案是「无法确定 profile」而不是「本地链接安装」。没有为此加
  宿主 `process.argv` / `DSH_PROFILE_DIR` 之类的额外启发式（宿主进程环境并不可靠地携带
  `DSH_PROFILE_DIR`），以免猜错 profile 或引入新的误判。
- pnpm 若把 virtual store 配到 profile 之外，`node_modules/dsh-worktodo` 的外部 symlink 会被
  判成 `link-install`。这仍然是安全方向（不写盘、不升级），但会让这类用户看不到自更新；
  目前没有为「外部 store 的正常安装」做额外区分。
- 老面板兼容：`state` 仍是 `idle`，因此老面板可能继续显示「有新版本」入口；点下去会得到
  `ok:false + reason:'link-install'` 的温和原因（不会被新面板渲染成红色 failed）。
- 没有在真实 DSH 里点真实 profile 的面板（按约束不碰真实 profile/数据）；面板行为由
  `updateBadgeState()` 单测与 footer 渲染烟测覆盖。
- 本轮没有升版本、没有改 CHANGELOG/.github、没有 commit/push/tag/发布。
