# 照抄 DSH 自己的更新交互：调研 + `dsh-worktodo` 自更新改造

本轮目标：把 **DSH 桌面版（DeepSeek Harness）自己的更新交互**——「点一下下载，然后可以点『安装并重启』」——
照着实现到本插件的自更新上。本轮**不升版本、不提交、不打 tag、不发布**，也不真的重启 DSH。

---

## 0. 结论摘要（先看这段）

1. **DSH 的更新是「严格两步」**：检查（后台自动）→ 用户点 **Download update** → 显示 `正在下载 xx%…` →
   `正在校验更新文件…` → 就绪 → 用户点 **安装并重启** → `quitAndInstall(true, true)` 静默安装并**自动重启**。
   `autoDownload = false`、`autoInstallOnAppQuit = false` —— **后台只做「检查」，下载与安装都必须由用户点**。
2. **状态机**（源码里就是这几个字符串）：
   `idle → available → downloading(percent) → verifying → ready → installing`，任一步失败进 `error`
   （带 `failedOperation: check | download | install` + 失败种类 + 技术细节）。
3. **重启被 Electron 主进程垄断**：只有 `quitAndInstall(true, true)` 和 `app.relaunch()`（开发菜单 / 致命错误恢复）两条路径；
   暴露给网页侧的桥**只有** `updates.status / open / subscribe` 三个方法（`open` 只是开对话框）。
   Host 进程只提供 `update-tasks`（inspect/lock）控制协议。**插件没有任何重启入口**。
4. **所以我们能照抄交互，不能照抄「重启」**：
   - 照抄：两步、阶段机、进度、校验、失败分类与重试、「安装并重启」是一次点击。
   - 不照抄（诚实）：重启。默认显示 **「已安装 vX，请手动重启 DSH」**+原因；
     新增**显式 opt-in** 的 `restartCommand` / `WORKTODO_RESTART_COMMAND`，只有用户自己写了重启命令，「重启」才是真的。
5. 全量 `node tools/verify-all.mjs`：**10/10**（含 build）。新增用例 96（宿主）/ 55（客户端）/ 22（契约）；
   5 项反向验证（回退 → 变红 → 恢复 → 变绿）全部确认。

---

## 1. 调研方法（可复现）

桌面版应用是一个 Electron asar 归档，**harness 代码与更新器都在里面**：

| 路径 | 内容 |
| --- | --- |
| `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` | 全部代码（`lib/` `renderer/` `dsh/` `node_modules/`） |
| `/Applications/DeepSeek Harness.app/Contents/Resources/app-update.yml` | electron-updater 的源配置 |
| `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/` | 原生产物（`dsh/`） |

解包：`/tmp/asarx.mjs` 不在，按 asar 格式自己写了一个最小解包器（约 40 行，`node asarx.mjs <asar> <outdir> [innerpath]`）：

- 头 8 字节：`u32 = 4`、`u32 = headerSize`；随后 `headerSize` 字节的头区里是 `{"files":{…}}` 的 JSON（前面可能有 pickle 填充，
  所以按「第一个 `{`」定位，再用尾部 `\0` 裁掉 padding）；
- 每个文件条目是 `{offset, size}`（相对 `8 + headerSize`），`files` 表示目录。

解到 `/tmp/mirror/app` 与 `/tmp/mirror/dsh-root/dsh`（本轮全部证据都在这两处，**没有改动应用本体**）。

`app-update.yml` 说明它用的就是 electron-builder 的 electron-updater generic 源：

```yaml
provider: generic
url: https://download.deepseek.com/dsh-desk/feeds/mac-arm64/
channel: nightly
updaterCacheDirName: '@deepseek-aidsh-desktop-updater'
```

---

## 2. 源码地图（谁负责什么）

| 文件（解包后） | 职责 |
| --- | --- |
| `app/lib/main.js` | Electron 主进程：更新协调器 `DesktopUpdateCoordinator`、轮询调度 `DesktopUpdateSchedule`、原生更新对话框 `DesktopUpdateDialog`、状态投影 `presentDesktopUpdate`、失败摘要、菜单/IPC |
| `app/lib/preload-app.cjs` | 给网页侧的**只读**桥：`updates.status / open / subscribe` |
| `app/lib/preload-update-dialog.cjs` | 给更新对话框文档的隔离桥：`status / respond / subscribe`（只有它能「回应」，且带 revision） |
| `app/renderer/update-dialog.{html,js,css}` | 原生更新对话框（标题/正文/技术详情/按钮） |
| `app/renderer/mandatory-update.{html,js}` | 「必须更新」的强制升级页 |
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js` | **网页侧**的更新指示器：`DesktopUpdateIndicator` / `DesktopUpdateBadge` / `DesktopUpdateSource` |
| `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` | Host 进程的 `update-tasks` 控制协议（inspect / lock / unlock） |
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js` | 插件安装后的「下次启动生效」文案（我们「请手动重启」的同类先例） |

---

## 3. 状态机：`DesktopUpdateCoordinator`（`app/lib/main.js:6946-7149`）

```js
// main.js:6949-6956
var DesktopUpdateCoordinator = class {
	publish; beforeRestart; updater; enabled; currentVersion; downloadResult;
	current = { phase: "idle" };
	candidate; downloaded = false; …

// main.js:7000-7007  关键三行：后台不下载、退出不自动装、订阅进度
	this.updater.autoDownload = false;
	this.updater.autoInstallOnAppQuit = false;
	this.updater.channel = "nightly";
	this.updater.allowPrerelease = true;
	this.updater.allowDowngrade = false;
	this.updater.on("download-progress", this.onProgress);
	this.updater.on("update-downloaded", this.onDownloaded);
	this.updater.on("error", this.onError);
```

阶段迁移（同一文件）：

- **`check()` → `doCheck()`**（`7018-7028` / `7132-7148`）：`checkForUpdates()`，`candidate` 只在
  `isUpdateAvailable && gt(version, currentVersion)` 时才有；有 → `{phase:"available", version}`，无 → `{phase:"idle"}`，
  抛错 → `failure(error, "check")`。手动检查失败必须可见，自动检查失败静默（`7017-7027`）。
- **`download(version)`**（`7033-7062`）：
  ```js
  this.setState({ phase: "downloading", version, percent: 0 });
  await this.updater.downloadUpdate();
  if (!this.downloaded) throw new Error("desktop update: platform preparation did not report readiness");
  return this.setState({ phase: "ready", version });
  ```
  版本必须等于用户确认时的 `candidate`，否则 `"desktop update: download confirmation is stale"` —— **面板不能指定 URL/版本**。
- **进度**（`6963-6971`）：
  ```js
  const percent = Math.min(100, Math.max(0, progress.percent));
  this.setState({ phase: percent >= 100 ? "verifying" : "downloading", ...this.target(), percent });
  ```
  ≥100 先进入 `verifying`（校验/平台准备），`update-downloaded` 事件才算 `downloaded = true`。
- **`install(version)`**（`7069-7093`）：
  ```js
  if (!this.downloaded || this.downloadOperation !== void 0 || version !== this.candidate)
    throw new Error("desktop update: confirmed target is not ready");     // ← 「没下完不能装」
  this.setState({ phase: "installing", version });
  if (!await this.beforeRestart()) return this.setState({ phase: "ready", version }); // 用户取消 → 退回就绪
  this.updater.quitAndInstall(true, true);                               // ← 静默安装 + 自动重启
  ```
- **失败**（`7117-7127`）：`{phase:"error", version, failedOperation, message, preparationFailure?, technicalDetails?}`，
  种类映射在 `desktopUpdateFailureKind`（`8413-8417`）：
  `check` / `check-network` / `download` / `download-network` / `install` / `install-network` /
  `stop-failed` / `tasks-changed` / `tasks-unavailable`。

### 3.1 后台只「检查」

```js
// main.js:8311-8328 —— 默认 10 分钟一次、±20% 抖动、失败指数退避到 1 小时
const intervalMs = resolveDurationMs(env, "DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS", 6e5);
const maxBackoffMs = resolveDurationMs(env, "DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS", Math.max(intervalMs, 36e5));
```

`updateSchedule.check()` 只调用 `updates.check()`（`8360-8378`），**不会**自己开始下载；
`main.js:11835` 的启动/恢复钩子也只做 `updateSchedule.check()`。

---

## 4. 下载与安装：一次点击的两个动作

### 4.1 用户点「下载」

```js
// main.js:11740-11753（openUpdatePrompt，manual=true）
if ((await ordinaryMessageBox({
	title: locale.messages.updateCheckTitle,
	message: formatDesktopMessage(locale.messages.updateAvailable, { version: state.version ?? "" }),
	detail: locale.messages.updateDetail,          // 「下载完成后，可安装并重启应用。」
	buttons: [locale.messages.updateDownload],     // 「下载更新」/「Download update」
	cancelId: 1
})).response !== 0) return;
…
await showUpdateFailure(await downloadUpdate(state.version));
```

### 4.2 下完立刻「问要不要装」——但安装仍然是**第二次用户确认**

```js
// main.js:11520-11528
const downloadUpdate = async (version) => {
	track("desktop_upgrade_click", {});
	updateJournal?.action("download-requested");
	const state = await updates.download(version);
	if (state.phase !== "ready" || quitting) return state;
	if (!isMandatory()) await windowShown();
	if (quitting) return state;
	return updates.install(version);            // ← 进 beforeRestart，那里弹「安装并重启」
};
```

```js
// main.js:11470-11489（安装前的准备 + 确认对话框）
const active = await host.updateTasks("inspect");                 // 有活动任务？
const ready = desktopUpdateReadyConfirmation(locale.messages, updates.state.version ?? "", process.platform);
const confirmation = {
	type: active ? "warning" : "info",
	title: locale.messages.updateTitle,
	message: active ? locale.messages.updateActiveTasks : ready.message,   // 「新版本 X 已准备就绪」
	detail: active ? locale.messages.updateActiveTasksDetail : ready.detail, // 「更新时应用会关闭，完成后自动打开」
	buttons: active ? [locale.messages.updateStopTasks, locale.messages.updateLater]
	                : [locale.messages.installAndRestart],                 // 「安装并重启」
	defaultId: 1, cancelId: 1
};
```

### 4.3 真正的安装 = 收尾 + 交棒

```js
// main.js:11489-11503
await track("desktop_upgrade_install_restart_click", {});
const stillActive = await host.updateTasks("lock");        // 关闸：拒绝新请求、排空进行中的
if (stillActive && !active) throw new DesktopUpdatePreparationError("tasks-changed", …);
await platformView.closeAndWait();
await backend.stop();                                      // 优雅停掉 Host（不杀子进程）
if (stopFailure !== void 0) throw new DesktopUpdatePreparationError("stop-failed", …);
updateJournal?.action("install-confirmed");
shellInstallerOwnsQuit = true;                             // 之后由安装器接管退出
```

然后 `quitAndInstall(true, true)`：第一个参数 `isSilent`（静默安装），第二个 `isForceRunAfter`
（安装完**自动重新启动应用**）——「安装并重启」在 DSH 里是**一次点击、自动重启**。

### 4.4 失败与回滚

```js
// main.js:11411-11442（publishUpdate）
if (state.phase === "error" && state.failedOperation !== "check") {
	const restoreHost = state.failedOperation === "install" && updateStoppedHost && !quitting;
	shellInstallerOwnsQuit = false; updateStoppedHost = false;
	if (restoreHost) { /* 重新 start Host + 重新导航回工作区 */ }
	showUpdateFailure(state)…;   // 原生错误框 + 「查看技术详情」
}
```

即：**安装失败 = 把已经停掉的 Host 重新拉起来**，用户回到可用状态，状态机留在 `error` 里可重试。
超时/断网由 `DesktopUpdateHttpExecutor`（`6882-6926`）用一个 **idle 超时**（默认 60s，
`DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS`）兜住「连接不响」，而不是给整个下载设总时限。

---

## 5. UI：文案、进度、按钮怎么变

### 5.1 原生对话框（`app/renderer/update-dialog.*`）

- 结构：`<main role="dialog" aria-modal aria-labelledby aria-describedby>` + `h1#title` + `p#detail` +
  `<details><summary>查看技术详情</summary><pre>` + `#actions`（按钮容器）。
- **只用 `textContent`**，没有 `innerHTML`；关闭按钮有 `aria-label`（`state.closeLabel`）。
- **Escape = 取消，绝不当成接受**；Tab 被劫持成在「按钮 / 详情 / 关闭」里循环（焦点不跑丢）。
- 每个响应都带 `revision`：`respond(revision, index)`，主进程校验
  `revision !== active.view.revision → "desktop update: stale dialog response"`（`main.js:9503-9506`）。
- 按钮顺序即语义：第一个是 primary（如「安装并重启」），取消 id 通常是最后一个（「稍后」）。

### 5.2 网页侧指示器（`dsh-client-ui-settings-general/lib/client.js:112-225`）

```js
// client.js:114-130
const BUSY_PHASES = new Set(["checking", "downloading", "verifying", "installing"]);
function updateCopy(state, t) {
	const label = { idle:"", checking:t("desktop.update.checking"),
		available:t("desktop.update.available"),
		downloading:t("desktop.update.progress", { percent: state.percent ?? 0 }),
		verifying:t("desktop.update.verifying"),
		installing:t("desktop.update.installing"),
		ready:t("desktop.update.ready"),            // ← 「安装并重启」
		error:t("desktop.update.retry") }[state.phase];
	…
```

- 忙时按钮 `aria-disabled`、图标换成 spinner；错误时换成小圆点；空闲时是下载图标。
- 点击只调 `bridge.open()`（开**原生**对话框），不做任何下载/安装；连续点击由 `opening` 与
  `BUSY_PHASES` 拦住（`client.js:538-562`）——**动作永远由主进程执行**。
- 文案（zh，`client.js:863-880`）：

| key | 中文 |
| --- | --- |
| `desktop.update.checking` | 正在检查更新… |
| `desktop.update.available` | 新版本 |
| `desktop.update.progress` | `{percent}%` |
| `desktop.update.verifying` | 正在校验更新文件… |
| `desktop.update.installing` | 正在准备重启… |
| `desktop.update.ready` | **安装并重启** |
| `desktop.update.retry` | 重试更新 |
| `desktop.update.downloadDetail` | 正在下载更新：{percent}% / 目标版本：{version} |
| `desktop.update.*Failed` | 检查/下载/安装失败（分网络与非网络两种） |

主进程侧同一批文案（`main.js:6585-6620` en / `6770-6790` zh）：`updateDownloading: "正在下载 {percent}%…"`、
`updateVerifying: "正在校验更新文件…"`、`updateInstalling: "正在准备重启…"`、`installAndRestart: "安装并重启"`、
`updateLater: "稍后更新"`、`updateRetry: "重试更新"`、`updateTechnicalDetails: "查看技术详情"`。

### 5.3 「稍后提醒」

DSH 提供的是 **「稍后」/「稍后更新」**（每次弹窗都能取消），**没有**「跳过此版本 / 不再提醒」；
取消后状态仍在 `available`，下次点指示器还会再问。

---

## 6. 重启：DSH 到底给插件留了什么？（逐条证据）

| 面 | 证据 | 能否重启 |
| --- | --- | --- |
| 网页侧 preload 桥 | `app/lib/preload-app.cjs:829-840`：`updates: { status(), open(), subscribe() }` 三个方法 | ✗ 只有读和「开对话框」 |
| 更新对话框 preload | `app/lib/preload-update-dialog.cjs`：仅 `status/respond/subscribe`，且只对 `dsh-app://shell/update-dialog.html` 暴露 | ✗ |
| 主进程 | `quitAndInstall(true, true)`（`main.js:7083`）；`app.relaunch()` 只在**开发菜单**（`11905-11912`，`...development ?`）与**致命错误恢复**（`10983-10986`）里 | ✗ 插件够不到 |
| Host 进程 | `dsh-desktop-host/lib/index.js:294-324`：只有 shell→host 的 `{type:"update-tasks", action:"inspect"|"lock"|"unlock"}` 控制协议 | ✗ 反向控制不存在 |
| CLI | `dsh/lib/plugin-BGnVfe_D.js`：`requireDesktopProfile` 明说 *"fully quit it before running `dsh plugin --profile desktop`"* | ✗ 明确要求先退出 Desktop |
| 插件安装后 | `dsh-client-ui-plugin-manager/lib/client.js:91,234`：`restartNotice: "更改将在下次启动生效"` / `installDoneRestart: "已安装，下次启动后加载。"` | 只能提示手动重启 |

**结论：找不到任何「让插件触发优雅重启」的能力。** 因此本插件**不假装能重启**（见 §9.4）。

---

## 7. 我们照抄了哪些 / 哪些没法照抄

| DSH 的做法 | 我们的做法 | 说明 |
| --- | --- | --- |
| 两步：下载 → 安装并重启 | ✅ 照抄，`plugin-update-download` / `plugin-update-install` | 旧接口 `plugin-update` 保留「一次到位」，老面板不坏 |
| 阶段机 `idle→available→downloading→verifying→ready→installing→error` | ✅ 对齐为 `idle/checking/available/downloading/verifying/downloaded/installing/installed/restarting/failed` | 多了 `installed`（装好待重启）与 `restarting`；`state` 老字段由映射表保持兼容 |
| `download-progress` → percent | ✅ `percent` 0–99 递增，校验通过才 100 | 无 `content-length` 时只报已收字节数，**不编造百分比** |
| 下完先 `verifying` 再就绪 | ✅ 先算 sha1（有 registry `shasum` 就逐字比对）+ 回读落盘校验，再进 `downloaded` | 注入 latest 的测试环境没有对照值 → 只记录不比对，并在状态里标出来 |
| `install()` 拒绝未就绪目标 | ✅ `requireDownload` 时 `phase !== 'downloaded'` → `not-downloaded`；下载物被删/写坏 → `download-missing` / `download-corrupt` | 与 DSH 的 *"confirmed target is not ready"* 同义 |
| 失败分类 + 重试 | ✅ `failedOperation` + `failure`（`download` / `download-network` / `install` / `restart-unavailable` / `linked` …），面板按「失败在哪一步」决定重试哪一步 | 下载失败的重试**回到下载**，不会去点安装 |
| 后台只检查（`autoDownload=false`） | ⚠️ 部分照抄：后台**先下载**，`autoInstall` 决定要不要顺手装 | 见 §8 的差异说明 |
| 安装 = 应用已下载的本地产物 | ❌ 做不到（npm 插件没有「从 tarball 安装」协议） | 见 §8 |
| 安装并重启一次点击 → 自动重启 | ❌ 只做到「安装 + **请求**重启」 | 见 §8 / §9.4 |
| 有活动任务时先停止再更新 | ❌ 未做 | 待办列表没有「运行中的任务」，没有等价物 |
| 原生模态对话框 + revision 防陈旧点击 | ⚠️ 改用侧栏面板页脚的状态格（插件只有面板这一个 UI 面）；防连点用 `busy` + `updatePending` | 我们没有独立窗口，也没有跨进程 revision 语义 |

---

## 8. 两处「没法照抄」的诚实说明

### 8.1 「安装」并没有真的从暂存区拿 tarball 去装

- DSH 是 Electron 应用，`electron-updater` 下载的就是**安装器本体**（NSIS/zip），`quitAndInstall` 直接执行它。
- 本插件是 npm 包，只能通过 profile 的包管理器落地。`pnpm add <本地 tgz>` 会把 profile 里的规格写成
  `file:…`，那会**永久破坏**用户的 profile（以后再也装不到 registry 版本），也正是本仓库历史上
  A1/A3 事故要防的那类改写。而 `pnpm add dsh-worktodo@<精确版本>` 会重新从 registry 取包。
- 因此我们的「下载」是**真实的、带进度与校验的 tarball 下载**，用途是：
  1. 让「下载」与「安装」在时间上真的分开（用户能先下、后装）；
  2. 作为**安装的准入凭证与完整性守卫**：没下完不能装；下完被删/被改 → 当场拒绝；
  3. 重启后仍能认回「已下载」，不用重下。
  安装动作本身仍是「CLI → `pnpm update` → `pnpm add @<精确版本>`，每步校验落盘版本」那条老链路。
- 这是本轮**最明确的一处偏离**，写在这里而不是藏在代码注释里。

### 8.2 后台策略与 DSH 不同（按需求沿用旧行为）

- DSH：后台**只检查**，从不下自动下载。
- 本插件：`autoUpdate` 默认 `true`（后台自动更新，用户明确要求过），本轮把它拆成
  「后台**只下载**」+ `autoInstall`（**默认 `true` = 沿用改造前的行为**：后台下完就直接装，下次重启生效）。
  `autoInstall: false` 时后台停在 `downloaded`，等用户点「安装并重启」——**这才是 DSH 的节奏**。
- 两种取值都有用例覆盖（`smoke-host` 的 `config.autoInstall 两种取值`）。
- 后台自动安装**绝不**自己请求重启：重启永远由用户点击触发。

---

## 9. 实现

### 9.1 宿主半侧（`lib/index.js`）

| 新增/改动 | 说明 |
| --- | --- |
| `normalizeUpdateConfig()` | 新增 `autoInstall`（默认 `true`，只有字面 `false` 才关）、`restartCommand`（默认 `''`） |
| `resolveUpdateStageDir()` | 暂存区：`WORKTODO_UPDATE_STAGE_DIR` → 状态文件同级的 `updates/` → `$DSH_HOME/worktodo/updates`。**测试永远落在临时目录** |
| `buildTarballUrl()` | 按 npm 约定拼 `<registry>/dsh-worktodo/-/dsh-worktodo-<ver>.tgz`；`WORKTODO_UPDATE_TARBALL_BASE` 可整体换源（离线测试用） |
| `resolveRestartRequester()` | 重启能力探测：默认 `{available:false, reason:'no-plugin-restart-ipc'}`；显式 `restartCommand` / `WORKTODO_RESTART_COMMAND` 才 `available:true` |
| `UPDATE_PHASES` / `COMPAT_STATE` / `setPhase()` | 阶段唯一写入口；同时维护 `phase`（新）与 `state`（旧面板兼容） |
| `downloadUpdate()` | 流式下载 + 进度 + sha1 + 体积上限（32 MiB）+ 落盘回读校验 + 原子写清单；失败不落半个文件 |
| `verifyStagedArtifact()` | 安装前复核：文件在、大小对、sha1 对 |
| `attemptRestart()` | 不可用 → 只记录 `restart:{supported:false,reason,error}`；可用 → `phase:'restarting'` + `spawn(command,{shell:true,detached:true})`，失败退回 `installed` 并说明原因 |
| `startInstall()` | `requireDownload`（新面板）时检查下载物 → 老链路安装 → 装成功清掉暂存物；`requestRestart` 时串上 `attemptRestart()` |
| `maybeAutoUpdate()` | 后台：先 `downloadUpdate()`，`autoInstall` 才 `startInstall({requireDownload:true})` |
| `/update` 路由 | `action` 白名单：`plugin-update`（旧，一次到位）/`-check`/`-download`/`-install`/`-restart`；带待办字段仍走老语义 |
| `GET /update` 载荷 | 新增 `phase/percent/version/failedOperation/failure/download/restart/autoInstall/restartSupported` |
| `updatePayload()`（`/list`） | 新增 `phase/percent/version/autoInstall/restartSupported`，`run` 里也带阶段 |

### 9.2 客户端（`src/client/index.js`）

- `updateBadgeState(run, update, t)` 重写为**阶段驱动**，返回 `{text, title, tone, action, disabled, phase}`，
  `action ∈ download | install | restart | retry | update | null`。
- 新增 `isUpdateBusy(run)`（轮询与禁用判断共用）与 `failureBadge()`（失败分类 → 重试哪一步）。
- 页脚渲染：可点才渲染 `<button>`，纯状态渲染 `<span role="status" aria-live="polite">`；
  下载中额外给 `role="progressbar" aria-valuemin/max/now`。
- 轮询：`busy` 时才存在 2s 轮询，一离开 busy 立刻停（`UPDATE_POLL_MS` 仍是既有常量）。
- 文案：zh/en 两套键一一对应（`updateChecking/updateDownload/updateDownloading/updateDownloadingBytes/
  updateVerifying/updateInstallRestart/updateInstalling/updateInstalledManual(+Hint)/updateRestarting/
  updateRestart/updateDownloadFailed/updateDownloadedState …`）。

### 9.3 对外接口（面板/脚本可用）

| 请求 | 语义 |
| --- | --- |
| `GET /worktodo/update` | 阶段 + 进度百分比 + 目标版本 + 失败原因 + 下载物信息 + 重启能力 |
| `POST {action:'plugin-update-check'}` | 只检查（强制刷新） |
| `POST {action:'plugin-update-download'}` | 只下载（带进度），不动已安装版本 |
| `POST {action:'plugin-update-install'}` | 安装并**请求**重启（**要求已下载**） |
| `POST {action:'plugin-update-restart'}` | 装好之后单独请求重启 |
| `POST {action:'plugin-update'}` / `POST {}` | 旧语义：一次到位（下载不要求） |

### 9.4 「重启」最终怎么处理（取舍）

- **默认**：安装成功 → `phase:'installed'` + `restart:{supported:false, reason:'no-plugin-restart-ipc', ok:false, error:"…请手动重启 DSH…"}`；
  面板显示 **「已安装 vX，请手动重启 DSH」**（只读，`title` 里给完整原因），**不出现**任何可点的「重启」按钮。
- **显式 opt-in**：`config.restartCommand` 或 `WORKTODO_RESTART_COMMAND` 指向用户自己的重启命令时，
  `restartSupported:true`，面板才出现「重启 DSH」；「安装并重启」会真的执行那条命令（`phase:'restarting'`）。
  命令失败/起不来 → 退回 `installed` 并把原因写进 `restart.error`，绝不谎报成功。
- 测试里用 `node <临时脚本>` 作为重启命令（写 marker 文件），**没有**真的重启 DSH。

---

## 10. 测试

新增/改写的用例（全部离线，`WORKTODO_NO_UPDATE_CHECK=1`，假 profile + 临时 `DSH_HOME` 式目录）：

**`tools/smoke-host.mjs`（96 通过）**
- 两步主干：`available`（`percent` 必须 `null`）→ 下载（真的 HTTP 流、分片 40ms）→ 采样到 `0<percent<100` 且单调不减
  → `downloaded`（`percent:100`、`bytes`/`totalBytes`/`artifact` 对、**只下载不安装：0 个子进程**）
  → `plugin-update-install` → `installed` + 落盘版本真的换了 + 暂存物被清掉 + **诚实重启记录**（`supported:false`、
  `ok:false`、原因码、文案含「手动」、阶段绝不进 `restarting`）。
- 下载失败（源 503）：`failed` + `failedOperation:'download'` + `percent:null` + `download:null` + **暂存区里没有半个文件**；
  换好源后重试成功。
- 护栏①：没下载就 `install` → `not-downloaded`，0 子进程，阶段不变。
- 护栏②：下载物被删 → `download-missing`；内容被改坏 → `download-corrupt`（并说明「校验不通过/大小不对」），都不起子进程。
- 护栏③（新增）：下好未安装就「重启」→ 新实例直接认回 `downloaded`，0 子进程，随后能正常安装。
- `config.autoInstall`：`false` → 后台停在 `downloaded`、0 子进程、`state:'idle'`，用户点后才装；
  默认 `true` → 一路装到 `installed` 且**不自动请求重启**（`restart === null`）。
- 重启：不可用时单独点 `plugin-update-restart` 也如实失败（`restart-unavailable`）且不改阶段；
  配了 `restartCommand` 时真的执行了那条命令（marker 落盘）、`supported:true`、`kind:'command'`。
- 纯函数：`buildTarballUrl` / `resolveUpdateStageDir`（含「状态文件指到临时目录时暂存区必须跟着走」）/
  `resolveRestartRequester`（默认不可用）。
- 原有的 `state` 断言（`smoke-host` 里 20 余处）与「A4 跨重启节流」「link: 零子进程」等用例**全部保持通过**（旧字段兼容）。

**`tools/smoke-client.mjs`（55 通过）**
- `updateBadgeState` 逐阶段：`available→download`、`downloading`（不可点、含百分比、无 length 时报字节数）、
  `verifying`、`downloaded→install`、`installing`、`installed`（重启不可用=只读诚实文案；配了命令才给「重启 DSH」）、
  `restarting`、下载失败→`download`（且写明「下载失败」）、安装失败（下载物还在）→`retry`、`download-corrupt`→`download`、`linked`→无重试。
- 页脚渲染：下载中是 `<span role="progressbar" aria-valuenow=37>`；已下载是可点按钮且 `aria-label` 说清「安装并重启」；
  已安装待重启时**全页 0 个**可点更新按钮。
- 轮询：空闲 0 个 2s 轮询；下载中恰好 1 个；收口后 0 个；卸载时全部 `clearInterval`。
- 既有断言改成新契约（`updateNow` → `updateDownload` 等）。

**`tools/smoke-contract.mjs`（22 通过）**
- 客户端真的会发的 action 都按「升级」处理（不是「改待办」）；`plugin-update` 旧兜底仍保留。
- 护栏：没下载就 `plugin-update-install` → `not-downloaded`，阶段不被改成 `installing/installed`。
- `GET /update` 带齐 `phase/percent/version/failedOperation/failure/download/restart/autoInstall/restartSupported/…`；
  没在下载时 `percent === null`；`restartSupported === false`。
- `/list` 的 `update` 块与 `update.run.phase` 一致。

**全量**：`node tools/verify-all.mjs` → **10/10**（含 build），
`smoke-host` 96、`smoke-client` 55、`smoke-contract` 22，其余 7 个套件照旧。

### 10.1 反向验证（回退 → 变红 → 恢复 → 变绿）

| # | 回退的改动 | 变红的用例 | 恢复后 |
| --- | --- | --- | --- |
| 1 | 删掉「下载未完成不能安装」护栏（`requireDownload` 分支短路） | `smoke-host` 护栏用例 + `smoke-contract` 两条（阶段被改成 failed） | ✅ 绿 |
| 2 | 重启不可用时**假装成功**（`phase:'restarting'` + `ok:true`） | `smoke-host` 主干 / autoInstall / 重启 三条 | ✅ 绿 |
| 3 | 无视 `autoInstall`（后台永远连安装一起做） | `smoke-host` `config.autoInstall 两种取值` | ✅ 绿 |
| 4 | 下载不再上报 `percent` | `smoke-host` 主干（进度采样） | ✅ 绿 |
| 5 | `installed` 阶段改回「已更新到…重启生效」（不加「请手动」） | `smoke-client` 逐阶段 + 页脚渲染 | ✅ 绿 |

每次回退都只改一处；恢复后重跑全套（宿主 96 / 客户端 55 / 契约 22 全绿）。

---

## 11. 未做 / 不确定

1. **没有真机安装验证**：本轮只在「假 profile + 本地假 registry + 假 pnpm」下跑通；`autoInstall`
   默认 `true` 的行为与改造前一致，但真机上 tarball 地址、registry 元数据（`shasum`）与 pnpm 的交互**没有实跑**。
2. **安装不消费 tarball**（§8.1）：安装仍由 pnpm 从 registry 取包。想让「下载」真正喂给安装，
   需要对 profile 规格协议做改造（例如 pnpm store 预热 + `--offline`），风险与收益都超出本轮，未做。
3. **重启只在配置了 `restartCommand` 时可用**，且该命令的真实效果（会不会优雅退出当前会话）**没有验证**——按约束不能真重启。
4. **没有「稍后提醒 / 跳过此版本」**：DSH 只有「稍后」，我们连「稍后」都没有（面板是常驻状态格，不存在模态打断）。
5. **进度依赖 `content-length`**：拿不到时只报字节数，`percent` 保持 `null`（不编造）。
6. **没有差分下载 / blockmap / nightly 频道 / 强制更新（mandatory）**：DSH 有 `channel: "nightly"`、
   `mandatory-update` 页与策略鉴权，这些与 npm 插件的发行方式无关，未做。
7. **没有 SSE/推送**：DSH 用 IPC 把状态推给所有窗口；我们仍是 2s 轮询（仅进行中），面板关掉就看不到实时进度。
8. **`percent` 的粒度**：按整数百分比变化才写状态，极小包可能只看到 0→100 两跳（测试里用分片+延时才能采样到中间值）。
9. **版本号/CHANGELOG/.github 未改**（按约束）；`lib/client.js` 是构建产物，已随 `src/client/index.js` 重建。
10. **`dsh plugin` 在 Desktop 运行时被明确拒绝**（§6）：所以「装完自动重启」即使有了重启命令，
    也要求目标环境的包管理器能安全并发；本轮不在实现里绕开这条。

---

## 12. 一句话复盘

DSH 的更新是「用户点一下下载 → 进度 → 用户点安装并重启 → 应用自动重启」，重启被锁在 Electron 主进程里；
我们照抄了**前面的交互与状态机**，把**最后那一步**换成了诚实的「请手动重启 DSH」（可显式 opt-in 一条重启命令），
并把整件事做成了 DSH 同构的阶段机 + 进度 + 校验 + 失败重试，全部有测试与反向验证兜着。
