import React from 'react';
// 与宿主共用同一份解析器：人机一致，且零依赖（会被 esbuild 内联进 bundle）
import { parseNaturalDue } from '../parse-due.mjs';

/**
 * worktodo 浏览器半侧：DSH 侧栏入口 + 中栏「工作待办」面板。
 *
 * 数据来源只有一处：同源的 /worktodo/* 路由（宿主半侧 lib/index.js 注册）。
 * 所有路由都返回 HTTP 200，成功与否看 body 里的 `ok` 字段——所以判定条件写在
 * `!body.ok` 上，而不是 `response.ok`：只看 HTTP 状态码会把「标题为空」这类
 * 业务失败当成网络故障，用户就看不到真正的原因了。
 *
 * 为什么会话待办要单独拆一个子组件：
 * 官方会话 todos 来自 `props.useProjection('todos')`，而 useProjection 是 hook——
 * 面板注册在 root scope，某些组合下 props 里根本没有它。hook 的调用次数在组件实例
 * 生命周期内必须恒定，所以「有没有 useProjection」这个条件只能决定**整块要不要挂载**，
 * 不能写在同一个组件内部。见 SessionAdopt。
 *
 * 样式：只用 DSH 自己的 --dsw-* 主题变量（不写任何颜色字面量），
 * 所以深浅主题、以及以后换主题皮肤时都天然跟着走。类名统一 wt- 前缀，
 * 样式表跟着面板一起渲染（挂在面板自己那棵 DOM 里的 style 节点，不碰面板之外的页面）。
 */

const PKG_NAME = typeof __DSH_PLUGIN_NAME__ === 'string' ? __DSH_PLUGIN_NAME__ : 'dsh-worktodo';
/**
 * 宿主半侧的 name / 路由前缀是写死的 'worktodo'（lib/index.js），而侧栏 slot id 又必须与
 * main 面板的 key 同名，否则点了侧栏打不开面板。所以短名以包名派生为主，
 * 但一旦派生值不是宿主认的那个名字就退回 'worktodo'——包名带后缀时宁可面板能开。
 */
const DERIVED_NAME = PKG_NAME.replace(/^dsh-/, '');
const SHORT_NAME = DERIVED_NAME === 'worktodo' ? DERIVED_NAME : 'worktodo';
const SLOT_ID = SHORT_NAME;
const ROUTE_BASE = `/${SHORT_NAME}`;
const LOCALE_NS = SHORT_NAME;
const ROUTE_LIST = `${ROUTE_BASE}/list`;

/**
 * 拿不到宿主注入的 t 时的兜底字典。
 * 必须是**模块级常量**：写成组件里的箭头函数会让每次渲染都换一个函数身份，
 * 面板传给每一行的 `t` 就不再浅相等 —— `React.memo` 会因此永远不生效（S3-3）。
 */
const FALLBACK_T = (key) => zh[key] ?? key;

/**
 * 面板自动刷新间隔：agent 通过 worktodo_* 工具改了列表时宿主不会推送，
 * 面板只能自己定期拉一次（以及窗口重新获得焦点时拉一次），否则用户得手点刷新才看得到。
 *
 * 复审 R4：从 10 秒放宽到 30 秒 —— 每次轮询都是一次全量 `load()`（domain 路径要遍历整张表），
 * 10 秒一次在待办多起来时是纯浪费；用户重新聚焦窗口时那条路径会立刻补上新鲜度。
 * 卸载时定时器与监听都会被清掉。
 *
 * S3-3（第四轮审计，客户端侧）：窗口不可见（`document.visibilityState === 'hidden'`）时
 * **一次请求都不打** —— 多窗口/切到后台的场景下，原来的定时器每 30 秒仍然全量拉一次。
 * 重新可见时由 `visibilitychange` 那条路径立刻补一次新鲜度。
 */
export const CHANGE_POLL_MS = 30000;

/**
 * 自升级进行中的状态轮询间隔（2 秒）。
 *
 * 关键约束：**只在升级进行中轮询** —— 面板挂载本身不注册这个定时器；点了「立即更新」、
 * 或者宿主报告 `state === 'running'` 时才注册，一旦状态不再是 running 立刻清掉。
 * 常驻一个 2 秒的定时器会让「省着打宿主」这件事前功尽弃（见 CHANGE_POLL_MS 的说明）。
 */
export const UPDATE_POLL_MS = 2000;

/**
 * 窗口是否不可见。
 *
 * 抽成纯函数有两个原因：SSR/无 document 环境（测试）里要安全；以及行为可以直接单测。
 * `document` 缺失时按「可见」处理：没有浏览器上下文就没有「后台窗口」这回事。
 * @param {Document|undefined} [doc]
 * @returns {boolean}
 */
export function isWindowHidden(doc = typeof document !== 'undefined' ? document : undefined) {
  return Boolean(doc && doc.visibilityState === 'hidden');
}

/**
 * 编辑表单的优先级档位。`none` 必须在里面：它代表「不设优先级」这个真实状态，
 * 缺了它（或把 `none` 兜底成 `normal`）会让用户打开编辑器、什么都不改、点保存
 * 就把这条记录永久改成「普通」（审计 F6，且宿主工具侧曾无法改回 none）。
 */
export const EDIT_PRIORITY_OPTIONS = ['high', 'normal', 'low', 'none'];

/**
 * 面板配置：是否播放「勾选完成」的庆祝动效（宿主 config.celebrate，默认 **开**）。
 *
 * 只认显式的 `false`：字段缺失（老宿主 / 老面板 / 测试里的精简载荷）一律按开处理，
 * 这样新增的开关不会因为「没传」而把行为悄悄关掉。
 * @param {{celebrate?: unknown}|null|undefined} panel /list 载荷里的 panel 字段
 * @returns {boolean}
 */
export function shouldCelebrate(panel) {
  return panel?.celebrate !== false;
}

/** 优先级 → 文案 key。 */
const PRIORITY_LABEL_KEYS = {
  high: 'prioHigh', normal: 'prioNormal', low: 'prioLow', none: 'prioNone',
};

/**
 * 从一行待办构造编辑草稿。
 *
 * 抽成纯函数有两个原因：面板与测试用同一份逻辑（不是测试里再抄一遍），
 * 以及 `none` 必须**原样保留**而不是被 `|| 'normal'` 之类兜底改掉。
 * @param {object} row
 * @returns {{title: string, due: string, priority: string, project: string, dueTime: string, notes: string}}
 */
export function buildEditDraft(row = {}) {
  return {
    title: typeof row.title === 'string' ? row.title : '',
    due: typeof row.due === 'string' ? row.due : '',
    priority: EDIT_PRIORITY_OPTIONS.includes(row.priority) ? row.priority : 'normal',
    project: typeof row.project === 'string' ? row.project : '',
    dueTime: typeof row.dueTime === 'string' ? row.dueTime : '',
    notes: typeof row.notes === 'string' ? row.notes : '',
  };
}

/* ------------------------------------------------------------------ *
 * 文案：zh / en 两份 key 必须一一对应（宿主按 key 取词，缺 key 会显示 key 本身）
 * ------------------------------------------------------------------ */
const zh = {
  'nav': '待办',
  'title': '工作待办',
  'panelCrashTitle': '工作待办面板出错了',
  'panelCrashHint': '渲染这块面板时抛了异常，已在这里兜住，待办数据本身没丢。点「重试」可以重新挂载，无需重启 DSH；若反复出现，请把控制台里的完整报错发出来。',
  'statOpen': '未完成',
  'statOverdue': '逾期',
  'statToday': '今天',
  'statDoing': '进行中',
  'statDoneToday': '今日完成',
  'refresh': '刷新',
  'loading': '读取待办…',
  'failed': '读取失败',
  'retry': '重试',
  'dismiss': '关闭',
  'storeAt': '存储位置',
  'storeDomain': '官方 storage',
  'storeFile': 'JSON 文件',
  'storeMismatch': '存储后端不一致',
  'storeSplit': '两处数据不一致',
  'storeError': '存储读写失败',
  'storeRetired': '回退文件已迁移并退役',
  'storeRetiredArchive': '退役档案',
  'storeUnavailable': '不可用',
  'storeRetiredUnavailable': '官方存储不可用，且回退文件已退役',
  'storeRetiredUnavailableHint': '回退文件已于 {when} 退役，本次读不到待办；档案：{archive}。请在带 storage 的组合里启动，或手动恢复该文件',
  'storeRetiredFailed': '回退文件退役失败（文件仍在，已被排除在合并源之外）',
  'storeRetiredFailedHint': '文件仍在 {path}：请手动改名或删除，否则它可能让已删除的待办复活',
  'storeMergeAborted': '合并两处数据失败（已回滚，未留下半截数据）',
  'storeMergeNote': '已按 id 合并两处数据：{merged} 条（同 id 冲突 {conflicts}，补入 {added}）',
  'addPlaceholder': '加一件要做的事，回车保存',
  'add': '添加',
  'dueLabel': '截止',
  'priorityLabel': '优先级',
  'prioHigh': '高',
  'prioNormal': '普通',
  'prioLow': '低',
  'groupOverdue': '逾期',
  'groupToday': '今天',
  'groupWeek': '本周',
  'groupLater': '以后',
  'groupCompleted': '已完成',
  'viewDue': '按截止',
  'viewProject': '按项目',
  'noProject': '未归类',
  'sortLabel': '排序',
  'sortManual': '手动',
  'sortPriority': '优先级',
  'sortCreated': '创建时间',
  'dragHint': '拖动调整顺序（会自动切到手动排序）',
  'versionLabel': '版本',
  'versionHint': '当前安装的 dsh-worktodo 版本',
  'updateAvailable': '有新版本',
  'updateHint': '点「下载」把新版本取到本地，下好后再点「安装并重启」',
  'updateNow': '立即更新',
  'updateDownload': '下载',
  'updateDownloadHint': '下载新版本到本地（这一步不改动已安装的版本）',
  'updateChecking': '正在检查更新…',
  // 检查失败是温和态，不是插件故障：不出现「失败」字样，也不展示原始网络错误。
  'updateCheckFailed': '暂时无法检查更新，稍后自动重试',
  'updateCheckFailedHint': '更新服务暂时连不上；待办列表与编辑不受影响，后台会自动重试。',
  'updateDownloading': '下载中 {percent}%',
  'updateDownloadingBytes': '下载中 · 已收到 {bytes}',
  'updateVerifying': '正在校验更新文件…',
  'updateDownloadedState': '已下载 {version}',
  'updateInstallRestart': '安装并重启',
  'updateInstallHint': '应用已下载的 {version}，然后请求重启 DSH',
  'updateInstalling': '正在安装（后台）…',
  'updateInstalledManual': '已安装 {version}，请手动重启 DSH',
  'updateInstalledManualHint': 'DSH 没有向插件暴露重启入口（重启由 Electron 主进程独占），所以需要你手动退出并重新打开 DSH 才会加载新版本。',
  'updateRestarting': '重启中…',
  'updateRestart': '重启 DSH',
  'updateRestartHint2': '用已配置的重启命令重启 DSH',
  'updating': '正在更新…',
  'updatedRestart': '已更新到 {version}，重启 DSH 生效',
  'updateRestartHint': '已更新完成，重启 DSH 生效',
  'updateFailed': '更新失败',
  'updateDownloadFailed': '下载失败',
  'updateLinked': '这是本地链接安装（link:），请在仓库里用 git/pnpm 工作流更新',
  // 预期内的不适用（不是失败）：淡色提示、不亮红、不出现「失败」、不给重试。
  'updateUnsupportedLink': '当前是本地链接安装（开发模式），面板不能自更新；请用 git/pnpm 工作流更新',
  'updateUnsupportedProfile': '无法确定当前 profile 位置，为安全起见未执行升级（未改动任何文件）',
  'updateRetry': '重试',
  'updateRetryHint': '点击重试',
  'updateFailureDetail': '详情',
  'updateDetailStep': '步骤',
  'updateDetailCommand': '命令',
  'updateDetailExit': '退出码',
  'updateDetailSpawn': '启动错误',
  'updateDetailVersion': '版本',
  'updateDetailLog': '日志尾部',
  // 更新方式（三档）+ 设置小浮层 + 重启提醒条
  'updateSettings': '更新设置',
  'updateSettingsTitle': '更新方式',
  'updateSettingsHint': '选择插件如何检查与安装新版本；这个设置优先于插件配置。',
  'updateSettingsCurrentVersion': '当前版本 {version}',
  'updateModeOff': '禁用更新',
  'updateModeOffHint': '完全不检查更新，也不发任何网络请求；面板只显示当前版本。',
  'updateModeManual': '仅提示新版本',
  'updateModeManualHint': '后台只检查；发现有新版本时由你决定是否下载、安装。',
  'updateModeAuto': '自动更新',
  'updateModeAutoHint': '后台自动下载并安装；装好后提示你重启 DSH，不会自动重启。',
  'updateModeLabel': '更新方式',
  'updateCheckNow': '检查更新',
  'updateCheckNowHint': '立即在后台检查一次新版本',
  'updateCheckDisabledOff': '已禁用更新，不会检查。',
  'updateSettingsSaving': '保存中…',
  'updateSettingsFailed': '设置保存失败',
  'updateRestartBanner': '已更新到 {version}，请重启 DSH 生效',
  'updateRestartBannerNoVersion': '更新已安装，请重启 DSH 生效',
  'updateRestartBannerHint': '新版本已经装好但还没生效；DSH 没有向插件提供重启入口，所以不会自动重启。',
  'addOpen': '新增待办',
  'addCancel': '取消',
  'prioNone': '无',
  'dateUnset': '日期 · 未设',
  'timeUnset': '时间 · 未设',
  'todayWord': '今天',
  'fromParsed': '识别',
  'dueTimeLabel': '时间',
  // 行内日期编辑：日期本身就是按钮（有日期＝修改，没日期＝添加）
  'editDate': '修改日期',
  'addDate': '＋ 日期',
  'addDateLabel': '添加日期',
  'datePopover': '修改截止日期',
  'clearDate': '清除日期',
  // 保存失败的温和提示：不出现原始异常/状态码，也不说「读取失败」
  'dateSaveFailed': '日期没保存上，已恢复原值',
  'expand': '展开',
  'collapse': '收起',
  'empty': '还没有待办',
  'emptyHint': '在上面输入框加第一件事',
  'overdueTag': '逾期',
  'sourceAgent': 'AI',
  'sourceSession': '会话',
  'markDone': '标为完成',
  'unmarkDone': '取消完成',
  'editHint': '点击标题可编辑',
  'editTitle': '编辑标题',
  'titleSaveFailed': '标题没保存上，已恢复原文',
  'titleEmptyHint': '标题不能为空，已还原',
  'deleteBtn': '删除',
  'confirmDelete': '确认删除？',
  'editDetails': '编辑详情',
  'save': '保存',
  'cancel': '取消',
  'projectLabel': '项目',
  'editProject': '修改项目',
  'addProject': '＋ 项目',
  'addProjectLabel': '添加项目',
  'projectSaveFailed': '项目没保存上，已恢复原值',
  'projectPlaceholder': '项目名（可选）',
  'projectNew': '新建',
  'projectNewPlaceholder': '新项目名',
  'projectListTruncated': '项目较多，只显示最常用的 {count} 个',
  'titlePlaceholder': '待办标题',
  'notesLabel': '备注',
  'notesPlaceholder': '备注（可选）',
  'notesAdd': '加备注',
  'notesHide': '收起备注',
  'adoptPre': '把本会话的',
  'adoptPost': '条待办提升为工作待办',
  'adoptHint': '这是模型在本会话里列的待办。提升后归你所有：跨会话保留，还能加优先级和截止日期。',
  'adoptPending': '待完成',
  'adoptDone': '已提升',
  'adoptSkipped': '跳过',
  'titleEmpty': '请先写点什么',
  'untitled': '（无标题）',
};

const en = {
  'nav': 'To-dos',
  'title': 'Work to-dos',
  'panelCrashTitle': 'Work to-dos panel crashed',
  'panelCrashHint': 'Rendering this panel threw an exception; it is caught here and your to-dos are safe. Click Retry to remount it without restarting DSH — if it keeps happening, please share the full console error.',
  'statOpen': 'Open',
  'statOverdue': 'Overdue',
  'statToday': 'Today',
  'statDoing': 'In progress',
  'statDoneToday': 'Done today',
  'refresh': 'Refresh',
  'loading': 'Loading to-dos…',
  'failed': 'Failed to load',
  'retry': 'Retry',
  'dismiss': 'Dismiss',
  'storeAt': 'Stored at',
  'storeDomain': 'official storage',
  'storeFile': 'JSON file',
  'storeMismatch': 'Storage backend mismatch',
  'storeSplit': 'Data split across two locations',
  'storeError': 'Storage read/write failed',
  'storeRetired': 'Legacy file migrated and retired',
  'storeRetiredArchive': 'archive',
  'storeUnavailable': 'unavailable',
  'storeRetiredUnavailable': 'Official storage unavailable and the legacy file was retired',
  'storeRetiredUnavailableHint': 'the legacy file was retired at {when}, so to-dos cannot be read now; archive: {archive}. Start with the storage service, or restore that file manually',
  'storeRetiredFailed': 'Retiring the legacy file failed (it still exists and is excluded as a merge source)',
  'storeRetiredFailedHint': 'the file is still at {path}: rename or delete it manually, otherwise it may resurrect deleted to-dos',
  'storeMergeAborted': 'Merging the two copies failed (rolled back, nothing half-written)',
  'storeMergeNote': 'Merged both copies by id: {merged} items ({conflicts} id conflicts, {added} added)',
  'addPlaceholder': 'Add something to do — Enter saves',
  'add': 'Add',
  'dueLabel': 'Due',
  'priorityLabel': 'Priority',
  'prioHigh': 'High',
  'prioNormal': 'Normal',
  'prioLow': 'Low',
  'groupOverdue': 'Overdue',
  'groupToday': 'Today',
  'groupWeek': 'This week',
  'groupLater': 'Later',
  'groupCompleted': 'Completed',
  'viewDue': 'By due',
  'viewProject': 'By project',
  'noProject': 'Uncategorized',
  'sortLabel': 'Sort',
  'sortManual': 'Manual',
  'sortPriority': 'Priority',
  'sortCreated': 'Created',
  'dragHint': 'Drag to reorder (switches to manual sort)',
  'versionLabel': 'Version',
  'versionHint': 'Installed dsh-worktodo version',
  'updateAvailable': 'Update available',
  'updateHint': 'Download the new version first, then click "Install and restart"',
  'updateNow': 'Update now',
  'updateDownload': 'Download',
  'updateDownloadHint': 'Download the new version; the installed version is untouched',
  'updateChecking': 'Checking for updates…',
  // 温和态：不出现 raw error / “timeout” / “aborted”，也不说插件坏了。
  'updateCheckFailed': "Couldn't check for updates right now, will retry automatically",
  'updateCheckFailedHint': 'The update service is temporarily unreachable. Your list is unaffected; it will retry automatically in the background.',
  'updateDownloading': 'Downloading {percent}%',
  'updateDownloadingBytes': 'Downloading · {bytes} received',
  'updateVerifying': 'Verifying update files…',
  'updateDownloadedState': 'Downloaded {version}',
  'updateInstallRestart': 'Install and restart',
  'updateInstallHint': 'Apply the downloaded {version}, then request a DSH restart',
  'updateInstalling': 'Installing in the background…',
  'updateInstalledManual': 'Installed {version} — restart DSH manually',
  'updateInstalledManualHint': 'DSH exposes no restart entry point to plugins (restarting is owned by the Electron main process), so quit and reopen DSH to load the new version.',
  'updateRestarting': 'Restarting…',
  'updateRestart': 'Restart DSH',
  'updateRestartHint2': 'Restart DSH with the configured restart command',
  'updating': 'Updating…',
  'updatedRestart': 'Updated to {version} — restart DSH to apply',
  'updateRestartHint': 'Update finished — restart DSH to apply',
  'updateFailed': 'Update failed',
  'updateDownloadFailed': 'Download failed',
  'updateLinked': 'This is a local link: install — update it with the git/pnpm workflow',
  // Expected non-applicability (not a failure): muted, no red, no "failed", no retry.
  'updateUnsupportedLink': "Local link install (dev mode) — panel self-update doesn't apply; update via your git/pnpm workflow",
  'updateUnsupportedProfile': "Couldn't determine the profile location; upgrade skipped for safety (no files changed)",
  'updateRetry': 'Retry',
  'updateRetryHint': 'Click to retry',
  'updateFailureDetail': 'Details',
  'updateDetailStep': 'step',
  'updateDetailCommand': 'command',
  'updateDetailExit': 'exit code',
  'updateDetailSpawn': 'spawn error',
  'updateDetailVersion': 'version',
  'updateDetailLog': 'log tail',
  // Update mode (three options) + settings popover + restart banner
  'updateSettings': 'Update settings',
  'updateSettingsTitle': 'Update mode',
  'updateSettingsHint': 'Choose how the plugin checks for and installs updates. This setting wins over plugin config.',
  'updateSettingsCurrentVersion': 'Current version {version}',
  'updateModeOff': 'Updates off',
  'updateModeOffHint': 'No update checks and no network requests at all; the panel only shows the current version.',
  'updateModeManual': 'Only notify me',
  'updateModeManualHint': 'Checks in the background; when a new version exists, you decide whether to download and install it.',
  'updateModeAuto': 'Auto-update',
  'updateModeAutoHint': 'Downloads and installs automatically in the background; when done it asks you to restart DSH (it never restarts on its own).',
  'updateModeLabel': 'Update mode',
  'updateCheckNow': 'Check for updates',
  'updateCheckNowHint': 'Run an update check in the background now',
  'updateCheckDisabledOff': 'Updates are off, so nothing will be checked.',
  'updateSettingsSaving': 'Saving…',
  'updateSettingsFailed': "Couldn't save settings",
  'updateRestartBanner': 'Updated to {version} — restart DSH to apply',
  'updateRestartBannerNoVersion': 'Update installed — restart DSH to apply',
  'updateRestartBannerHint': 'The new version is installed but not active yet. DSH exposes no restart entry point to plugins, so it will not restart automatically.',
  'addOpen': 'New todo',
  'addCancel': 'Cancel',
  'prioNone': 'None',
  'dateUnset': 'Date · unset',
  'timeUnset': 'Time · unset',
  'todayWord': 'Today',
  'fromParsed': 'parsed',
  'dueTimeLabel': 'Time',
  // Inline date editing: the date itself is a button (edit when set, add when unset)
  'editDate': 'Edit date',
  'addDate': '＋ Date',
  'addDateLabel': 'Add date',
  'datePopover': 'Edit due date',
  'clearDate': 'Clear date',
  // Gentle failure copy: no raw exception/status code, no "read failed" wording
  'dateSaveFailed': "Couldn't save the date — reverted",
  'expand': 'Expand',
  'collapse': 'Collapse',
  'empty': 'No to-dos yet',
  'emptyHint': 'Add your first one in the box above',
  'overdueTag': 'overdue',
  'sourceAgent': 'AI',
  'sourceSession': 'Session',
  'markDone': 'Mark as done',
  'unmarkDone': 'Mark as not done',
  'editHint': 'Click the title to edit',
  'editTitle': 'Edit title',
  'titleSaveFailed': "Couldn't save the title — reverted",
  'titleEmptyHint': "A title can't be empty — reverted",
  'deleteBtn': 'Delete',
  'confirmDelete': 'Delete?',
  'editDetails': 'Edit details',
  'save': 'Save',
  'cancel': 'Cancel',
  'projectLabel': 'Project',
  'editProject': 'Edit project',
  'addProject': '＋ Project',
  'addProjectLabel': 'Add project',
  'projectSaveFailed': "Couldn't save the project — reverted",
  'projectPlaceholder': 'project (optional)',
  'projectNew': 'Create',
  'projectNewPlaceholder': 'New project name',
  'projectListTruncated': 'Many projects — showing the {count} most used',
  'titlePlaceholder': 'To-do title',
  'notesLabel': 'Notes',
  'notesPlaceholder': 'Notes (optional)',
  'notesAdd': 'Add notes',
  'notesHide': 'Hide notes',
  'adoptPre': "Promote this session's ",
  'adoptPost': ' to-dos into your work list',
  'adoptHint': 'These are the to-dos the model listed in this session. Promoting makes them yours: they survive across sessions and take priorities and due dates.',
  'adoptPending': 'open',
  'adoptDone': 'Promoted',
  'adoptSkipped': 'skipped',
  'titleEmpty': 'Type something first',
  'untitled': '(untitled)',
};

/* ------------------------------------------------------------------ *
 * 颜色：只取 DSH 主题变量。
 * 不写任何颜色字面量兜底——兜底值等于写死某一种主题下的颜色，另一套主题就花了。
 * 需要「淡淡的底色」时用 color-mix 把语义色混进 transparent，仍然是变量驱动。
 * ------------------------------------------------------------------ */
/** 本地时区的 YYYY-MM-DD（面板里判断"今天 / 逾期"用；与宿主 records.mjs 的 dayKey 同语义）。 */
function dayKey(stamp) {
  const d = new Date(stamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 行内日期浮层的估算高度（px）：日期输入（~30）+ 可选时间输入（~30）+ 清除按钮（~24）+ 内边距。
 * 只用于「向下开还是向上开」的判断；不需要精确 —— 留出 8px 余量就够避免贴边。
 */
export const DATE_POPOVER_HEIGHT_PX = 112;

/**
 * 浮层向上/向下自动避让边界（纯函数，导出供单测）。
 *
 * 规则：优先向下（与日期所在行同方向展开）；下方放不下、上方放得下时向上；
 * 两边都放不下时选空间大的一侧。拿不到几何信息（SSR / 测试替身）时默认向下。
 * @param {{top?: number, bottom?: number}|null|undefined} rect 日期按钮的 getBoundingClientRect()
 * @param {number} viewportHeight 视口高度（window.innerHeight）
 * @param {number} [popHeight] 浮层估算高度
 * @returns {'up'|'down'}
 */
export function chooseDatePopoverPlacement(rect, viewportHeight, popHeight = DATE_POPOVER_HEIGHT_PX) {
  const bottom = Number(rect?.bottom);
  const height = Number(viewportHeight);
  const wanted = Number(popHeight);
  if (!Number.isFinite(bottom) || !Number.isFinite(height) || height <= 0) return 'down';
  const pad = Number.isFinite(wanted) && wanted > 0 ? wanted : DATE_POPOVER_HEIGHT_PX;
  const spaceBelow = height - bottom;
  const spaceAbove = Number.isFinite(Number(rect?.top)) ? Number(rect.top) : 0;
  if (spaceBelow >= pad + 8) return 'down';
  if (spaceAbove >= pad + 8) return 'up';
  return spaceAbove > spaceBelow ? 'up' : 'down';
}

const C = {
  label: 'var(--dsw-alias-label-primary)',
  label2: 'var(--dsw-alias-label-secondary)',
  label3: 'var(--dsw-alias-label-tertiary)',
  border: 'var(--dsw-alias-border-l2)',
  border1: 'var(--dsw-alias-border-l1)',
  layer1: 'var(--dsw-alias-bg-layer-1)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
  brand: 'var(--dsw-alias-brand-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  ok: 'var(--dsw-alias-state-success-primary)',
};
/** 语义色的淡底/淡边：pct 是混入比例 */
const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** 页面底部「自升级」那一格的配色（走主题变量，不写死颜色）。 */
const UPDATE_TONE_STYLE = {
  ok: { color: C.ok, borderColor: tint(C.ok, 50), background: tint(C.ok, 12) },
  busy: { color: C.label2, borderColor: tint(C.label2, 40), background: tint(C.label2, 10) },
  warn: { color: C.warn, borderColor: tint(C.warn, 50), background: tint(C.warn, 12) },
  // 检查更新失败专用：比 warn 更淡，明确「不是故障」，也不占用错误色。
  muted: { color: C.label3, borderColor: tint(C.label3, 35), background: tint(C.label3, 8) },
  error: { color: C.error, borderColor: tint(C.error, 50), background: tint(C.error, 12) },
};

/**
 * 勾选框的**视觉尺寸**与**实际可点区域**（px）。
 *
 * 两个数字都由这里的常量驱动：样式表与渲染出来的节点属性（data-wt-check-size /
 * data-wt-check-hit）取的是同一个值，所以测试断言不会与实现漂移。
 * 26px 的视觉尺寸配 40×40 的可点区域：手指/触控板容易点中，又不把整行的横向布局挤变形
 * （伪元素向外扩，不占布局盒）。
 */
export const CHECK_SIZE_PX = 26;
export const CHECK_HIT_PX = 40;
/** 伪元素向外扩的尺寸：(40 − 26) / 2 = 7px，26 + 7×2 = 40。 */
const CHECK_HIT_INSET_PX = (CHECK_HIT_PX - CHECK_SIZE_PX) / 2;
/**
 * 行高下限（B1）。**必须 ≥ 命中盒高度**，否则相邻两行的命中盒会纵向重叠，
 * 而 DOM 里后绘制的下一行在上层 —— 点偏几像素就变成「静默改错条目」。
 *
 * 几何（相对本行上沿，含 padding 5px 与勾选框 margin-top −3px）：
 *   视觉盒 y = [2, 28]；命中盒 y = [−5, 35]（40×40）；
 *   下一行命中盒上沿 = 44 − 5 = 39 ⇒ **重叠 0px、留 4px 间隙**。
 * 为什么不取刚好 40：40 时下一行命中盒上沿 = 35，与本行命中盒下沿正好贴边，
 * 边界那 1px 仍会被后绘制的下一行吃掉；44 同时对齐常见的 44px 触控目标。
 */
export const ROW_MIN_HEIGHT_PX = 44;
/** 行的纵向 padding（几何算式与样式表共用，测试会解析样式表核对）。 */
const ROW_PADDING_Y_PX = 5;
/** 勾选框的 margin-top（让它与首行文字视觉居中对齐）。 */
const CHECK_MARGIN_TOP_PX = -3;

/**
 * 勾选框命中盒的几何（B1 的护栏，导出供单测）。
 *
 * 纯计算：命中盒不得越过邻行的命中盒（相邻行的命中盒都属于「点这条」的意图区）。
 * 测试会**从 STYLE_TEXT 里解析出真实 CSS 数值**再算一遍，所以把 min-height 改回 33px 会立刻变红。
 * @returns {{rowHeight: number, hitWidth: number, hitHeight: number, hitTop: number, hitBottom: number, nextHitTop: number, gap: number, overlap: number}}
 */
export function checkHitGeometry() {
  const visualTop = ROW_PADDING_Y_PX + CHECK_MARGIN_TOP_PX;
  const visualBottom = visualTop + CHECK_SIZE_PX;
  const hitTop = visualTop - CHECK_HIT_INSET_PX;
  const hitBottom = visualBottom + CHECK_HIT_INSET_PX;
  const nextHitTop = ROW_MIN_HEIGHT_PX + hitTop;
  return {
    rowHeight: ROW_MIN_HEIGHT_PX,
    hitWidth: CHECK_SIZE_PX + 2 * CHECK_HIT_INSET_PX,
    hitHeight: CHECK_SIZE_PX + 2 * CHECK_HIT_INSET_PX,
    hitTop,
    hitBottom,
    nextHitTop,
    gap: nextHitTop - hitBottom,
    overlap: Math.max(0, hitBottom - nextHitTop),
  };
}
/**
 * 对勾描边动画的虚线段长。取值略大于路径实际长度（≈11.6），
 * 这样 stroke-dashoffset 从 14 动画到 0 时，起始帧对勾完全不可见、结束时完整画出。
 */
const CHECK_DASH = 14;

/*
 * 「勾选完成」动效的节拍（纯 CSS，主机只负责挂/摘类）。
 *
 * 设计目标：从容、有层次、克制优雅 —— 不是「一闪而过」。
 * 顺序是「勾选框轻轻呼吸 → 对勾被写出来 → 整行慢慢落定」，
 * 三段有明确先后（各段 delay 是刻意留的），总时长约 1.2s。
 * 缓动全部选 ease-out 一类「起步快、收尾慢」的曲线，**不用带回弹的过冲曲线**
 * （旧的 .34,1.56,.64,1 会弹一下，看起来廉价）。
 */
/** 勾选框：620ms，scale 1 → 1.06 → 1（很轻的呼吸感，不弹跳）+ 极轻的背景淡入。 */
export const CHECK_POP_MS = 620;
/** 对勾描边：520ms，等勾选框先起来一点（delay 140ms）再「写出来」。 */
export const MARK_DRAW_MS = 520;
export const MARK_DRAW_DELAY_MS = 140;
/** 整行：1150ms 的柔和过渡（delay 80ms）——背景淡出 + 标题在 560ms 内变灰。 */
export const ROW_CELEBRATE_MS = 1150;
export const ROW_CELEBRATE_DELAY_MS = 80;
/** 标题颜色过渡：560ms（整行过渡的前半段；只动 color，不碰布局）。 */
export const TITLE_SETTLE_MS = 560;
/** 从勾上到完全落定的总时长：行动画的 delay + duration = 1230ms。 */
export const CELEBRATE_MS = ROW_CELEBRATE_DELAY_MS + ROW_CELEBRATE_MS;
/**
 * 「动效播完**再**刷新」的延迟。
 *
 * 比 CELEBRATE_MS 多留 30ms 余量：刷新会把行按新数据重新归组，
 * 提前哪怕一帧也会把最后一帧切掉（旧实现就是这样「落位」得太早，看起来一闪而过）。
 */
export const CELEBRATE_REFRESH_MS = CELEBRATE_MS + 30;

/** 面板自带样式表：几何字面量（间距/字号/圆角）写死，颜色全部走变量。 */
export const STYLE_TEXT = `
@keyframes wt-spin { to { transform: rotate(360deg); } }
/* 勾选完成的庆祝动效：轻柔呼吸 / 描边写出 / 整行落定。
   只动 transform / background / color / opacity，绝不改布局（零布局跳动）。 */
@keyframes wt-check-pop {
  0% { transform: scale(1); background: transparent; }
  40% { transform: scale(1.06); background: ${tint(C.ok, 10)}; }
  100% { transform: scale(1); background: ${tint(C.ok, 14)}; }
}
@keyframes wt-mark-draw { from { stroke-dashoffset: ${CHECK_DASH}; } to { stroke-dashoffset: 0; } }
@keyframes wt-row-celebrate {
  0% { background: ${tint(C.ok, 26)}; }
  40% { background: ${tint(C.ok, 16)}; }
  75% { background: ${tint(C.ok, 6)}; }
  100% { background: transparent; }
}
@keyframes wt-title-settle {
  from { color: ${C.label}; }
  to { color: ${C.label3}; }
}
.wt-root {
  height: 100%; overflow: auto; padding: 16px 18px 40px; box-sizing: border-box;
  color: ${C.label}; font-family: var(--dsw-font-family, system-ui, sans-serif); font-size: 13px;
}
.wt-input {
  min-width: 0; font-family: inherit; font-size: 12px; line-height: 1.5; padding: 4px 8px;
  border-radius: 8px; border: 1px solid ${C.border}; background: transparent; color: ${C.label};
  color-scheme: light dark;
}
.wt-input::placeholder { color: ${C.label3}; }
.wt-input:focus {
  outline: none; border-color: ${C.brand};
  box-shadow: 0 0 0 2px ${tint(C.brand, 22)};
}
.wt-btn {
  display: inline-flex; align-items: center; gap: 4px; font-family: inherit; font-size: 12px;
  line-height: 1.6; padding: 3px 10px; border-radius: 8px; cursor: pointer; user-select: none;
  border: 1px solid ${C.border}; background: transparent; color: ${C.label2}; white-space: nowrap;
}
.wt-btn:hover { background: ${C.hover}; color: ${C.label}; }
.wt-btn:disabled { opacity: .55; cursor: default; }
.wt-btn:disabled:hover { background: transparent; color: ${C.label2}; }
.wt-btn-primary {
  border-color: ${tint(C.brand, 50)}; color: ${C.brand}; background: ${tint(C.brand, 10)};
}
.wt-btn-primary:hover { background: ${tint(C.brand, 18)}; color: ${C.brand}; }
.wt-btn-primary:disabled:hover { background: ${tint(C.brand, 10)}; color: ${C.brand}; }
.wt-btn-danger { color: ${C.error}; border-color: ${tint(C.error, 45)}; }
.wt-btn-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: ${C.error}; }
.wt-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: ${C.label3}; cursor: pointer;
}
.wt-icon-btn:hover { background: ${C.hover}; color: ${C.label}; }
.wt-icon-btn-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: ${C.error}; }
.wt-check {
  position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: ${CHECK_SIZE_PX}px; height: ${CHECK_SIZE_PX}px; margin: ${CHECK_MARGIN_TOP_PX}px 0 0; padding: 0; border-radius: 8px;
  border: 1px solid ${C.border}; background: transparent; color: transparent; cursor: pointer;
}
/* 可点区域 ≥ ${CHECK_HIT_PX}×${CHECK_HIT_PX}px：伪元素向外扩 ${CHECK_HIT_INSET_PX}px，
   不占布局盒、不会推开旁边的旗子/标题 */
.wt-check::before { content: ''; position: absolute; inset: -${CHECK_HIT_INSET_PX}px; border-radius: 12px; }
.wt-check:hover { border-color: ${C.brand}; }
.wt-check:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 2px; }
.wt-check-done {
  border-color: ${tint(C.ok, 55)}; background: ${tint(C.ok, 14)}; color: ${C.ok};
}
/* 勾选完成的动效：勾选框轻呼吸 → 对勾描边写出 → 整行柔和落定（见 wt-row-celebrate）。
   三段各有 delay，先后关系是刻意的；缓动一律柔和 ease-out，不带过冲回弹。 */
.wt-check-celebrate { animation: wt-check-pop ${CHECK_POP_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1) both; }
.wt-check-celebrate .wt-check-mark path {
  stroke-dasharray: ${CHECK_DASH}; stroke-dashoffset: ${CHECK_DASH};
  animation: wt-mark-draw ${MARK_DRAW_MS}ms ease-out ${MARK_DRAW_DELAY_MS}ms both;
}
.wt-row.is-celebrating { animation: wt-row-celebrate ${ROW_CELEBRATE_MS}ms ease-out ${ROW_CELEBRATE_DELAY_MS}ms both; }
/* 标题在整行淡出的前半段慢慢变成「已完成」的柔和灰（只动 color） */
.wt-row.is-celebrating .wt-title {
  animation: wt-title-settle ${TITLE_SETTLE_MS}ms ease-out ${ROW_CELEBRATE_DELAY_MS}ms both;
}
/* B1：min-height 必须 ≥ 命中盒高度（见 checkHitGeometry / ROW_MIN_HEIGHT_PX） */
.wt-row { display: flex; align-items: flex-start; gap: 8px; padding: ${ROW_PADDING_Y_PX}px 8px; min-height: ${ROW_MIN_HEIGHT_PX}px; border-radius: 10px; }
.wt-row:hover { background: ${C.hover}; }
.wt-row-edit {
  flex-direction: column; align-items: stretch; gap: 6px;
  border: 1px solid ${C.border1}; background: ${C.layer1};
}
.wt-seg {
  display: inline-flex; align-items: center; border-radius: 8px; overflow: hidden;
  border: 1px solid ${C.border}; background: ${C.bg2};
}
.wt-seg-btn {
  appearance: none; border: 0; background: transparent; color: ${C.label2};
  font: inherit; font-size: 11.5px; line-height: 1; padding: 5px 9px; cursor: pointer;
}
.wt-seg-btn.is-on { background: ${C.hover}; color: ${C.label}; font-weight: 600; }
.wt-seg-btn:hover { color: ${C.label}; }
.wt-row[draggable="true"] { cursor: grab; }
.wt-row[draggable="true"]:active { cursor: grabbing; }
.wt-plus {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 12px 14px; margin-bottom: 10px; cursor: pointer; font: inherit; font-size: 13.5px; font-weight: 600;
  color: ${C.label2}; background: ${C.layer1};
  border: 1px dashed ${C.border}; border-radius: 12px;
}
.wt-plus:hover { color: ${C.label}; border-color: ${C.brand}; background: ${tint(C.brand, 8)}; }
.wt-plus-mark { font-size: 24px; line-height: 1; font-weight: 400; color: ${C.brand}; }
.wt-flag-btn {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 22px; height: 22px; padding: 0; border-radius: 6px; cursor: pointer;
  background: transparent; border: 1px solid transparent; color: ${C.label2};
  transition: opacity .12s ease, background .12s ease;
}
.wt-flag-btn:hover { background: ${C.hover}; }
.wt-flag-btn:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 1px; }
/* 无优先级的行：旗子默认不占视线（opacity:0），悬停/聚焦该行或点开时才淡出来。
   仍然留在 DOM/布局里（占住那一列，各行左侧对齐稳定），也保证纯键盘 Tab 能到达。 */
.wt-flag-btn.is-ghost { pointer-events: none; }
.wt-group-head {
  display: flex; align-items: center; gap: 7px; padding: 3px 8px; border-radius: 8px;
  cursor: pointer; user-select: none; color: ${C.label2};
}
.wt-group-head:hover { background: ${C.hover}; }
.wt-chip {
  display: inline-flex; align-items: baseline; gap: 4px; font-size: 11px; line-height: 1.7;
  padding: 0 8px; border-radius: 999px; border: 1px solid ${C.border1}; color: ${C.label3};
  white-space: nowrap;
}
/* 行内日期：外观仍是那行小字，但它是真按钮（hover 有底色+下划线，键盘有 focus ring） */
.wt-date-btn {
  appearance: none; display: inline-flex; align-items: baseline; gap: 4px;
  font: inherit; font-size: 11px; line-height: 1.7; padding: 0 4px; margin: 0;
  color: inherit; background: transparent; border: 1px solid transparent; border-radius: 6px;
  cursor: pointer; white-space: nowrap; text-align: left;
}
.wt-date-btn:hover { background: ${tint(C.brand, 10)}; text-decoration: underline; text-underline-offset: 2px; }
.wt-date-btn:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 1px; }
/* 无日期的行：悬停/聚焦时才出现的淡色「＋ 日期」入口（与行首 ghost 旗子同一种做法） */
.wt-date-btn.is-add { opacity: .7; border-style: dashed; border-color: ${C.border1}; }
.wt-date-btn.is-add:hover { opacity: 1; color: ${C.label2}; }
/* 浮层：挂载时才存在；默认向下，空间不够时由 is-up 改向上（见 chooseDatePopoverPlacement） */
.wt-date-pop {
  position: absolute; left: 0; z-index: 6; min-width: 188px; padding: 8px;
  display: flex; flex-direction: column; gap: 6px; text-align: left;
  background: ${C.layer1}; border: 1px solid ${C.border}; border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
}
.wt-date-pop.is-down { top: calc(100% + 4px); }
.wt-date-pop.is-up { bottom: calc(100% + 4px); }
.wt-date-field { display: flex; align-items: center; gap: 6px; font-size: 11px; color: ${C.label3}; }
.wt-date-field .wt-input { flex: 1 1 auto; min-width: 0; }
.wt-date-pop-foot { display: flex; align-items: center; gap: 6px; }
.wt-date-error { font-size: 10.5px; color: ${C.warn}; }
/* 行内项目选择浮层：QuickAdd 与行内项目标签共用同一份组件与样式。
   挂载时才存在；定位基准是持有它的那个 position:relative 的小盒子。 */
.wt-project-pop {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 6; padding: 6px;
  display: flex; flex-direction: column; gap: 4px; min-width: 176px; max-width: 260px;
  text-align: left; background: ${C.layer1}; border: 1px solid ${C.border};
  border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
}
/* 行内项目标签：外观仍是那颗 #项目 小胶囊，但它是真按钮。 */
.wt-project-btn {
  appearance: none; font-family: inherit; cursor: pointer; color: inherit;
  background: transparent;
}
.wt-project-btn:hover { background: ${tint(C.brand, 10)}; color: ${C.label}; }
.wt-project-btn:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 1px; }
/* 没有项目的行：hover / 键盘聚焦时才出现的淡色「＋ 项目」（与＋日期同一种做法）。 */
.wt-project-btn.is-add { opacity: .7; border-style: dashed; }
.wt-project-btn.is-add:hover { opacity: 1; color: ${C.label2}; }
.wt-project-error, .wt-title-error { font-size: 10.5px; color: ${C.warn}; }
.wt-tag {
  display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; line-height: 1.6;
  padding: 0 6px; border-radius: 999px; border: 1px solid ${C.border1}; color: ${C.label3};
  white-space: nowrap;
}
.wt-link { cursor: pointer; user-select: none; color: var(--dsw-alias-link); font-size: 11px; }
.wt-link:hover { text-decoration: underline; }
/* 自升级那一格：可点时是 <button>，外观必须与旁边的 chip 一致 */
.wt-update { font: inherit; cursor: pointer; background: transparent; appearance: none; }
.wt-update:hover { text-decoration: underline; }
.wt-update:disabled { cursor: default; opacity: .7; }
.wt-update:disabled:hover { text-decoration: none; }
/* 纯状态（正在更新 / 已装好待重启 / linked）：不是按钮，别给可点的暗示 */
.wt-update.is-state { cursor: default; }
.wt-update.is-state:hover { text-decoration: none; }
/* 更新设置入口 + 小浮层：只用主题变量，不写颜色字面量。
   入口在页脚版本号旁边，所以浮层**向上**弹（bottom 贴入口上沿、left 对齐页脚行），
   贴底时不会越出面板；刻意不用 top，浮层永远朝面板内部展开。 */
.wt-settings-wrap { display: inline-flex; align-items: center; }
.wt-settings-btn { width: 20px; height: 20px; padding: 0; }
/* 页脚「版本号 + 齿轮」这一行是浮层的定位基准（见 .wt-settings-pop 的 left/bottom） */
.wt-ver-row { position: relative; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 2px; }
.wt-settings-pop {
  position: absolute; bottom: calc(100% + 6px); left: 0; right: auto; z-index: 20;
  width: 268px; max-width: 100%;
  padding: 10px 11px; border-radius: 10px; text-align: left;
  border: 1px solid ${C.border}; background: ${C.layer1}; color: ${C.label};
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
  font-size: 11.5px; line-height: 1.55;
}
.wt-settings-pop-title { font-weight: 650; font-size: 12px; margin-bottom: 2px; }
.wt-settings-pop-hint { color: ${C.label3}; margin-bottom: 8px; }
.wt-settings-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.wt-settings-option {
  appearance: none; text-align: left; font: inherit; cursor: pointer;
  display: flex; flex-direction: column; gap: 1px; width: 100%;
  padding: 6px 8px; border-radius: 8px; color: ${C.label2};
  border: 1px solid ${C.border1}; background: transparent;
}
.wt-settings-option:hover { background: ${C.hover}; color: ${C.label}; }
.wt-settings-option:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 1px; }
.wt-settings-option.is-on { border-color: ${tint(C.brand, 55)}; background: ${tint(C.brand, 10)}; color: ${C.label}; }
.wt-settings-option-label { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.wt-settings-radio {
  width: 10px; height: 10px; border-radius: 50%; flex: none;
  border: 1px solid ${C.border}; background: transparent;
}
.wt-settings-option.is-on .wt-settings-radio { border-color: ${C.brand}; background: ${C.brand}; }
.wt-settings-option-hint { color: ${C.label3}; font-size: 10.5px; }
.wt-settings-foot {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  border-top: 1px solid ${C.border1}; padding-top: 8px; color: ${C.label3};
}
.wt-settings-error { color: ${C.error}; margin-top: 6px; }
/* 重启提醒条：醒目但不打扰（不是错误红），没有假重启按钮 */
.wt-restart-banner {
  display: flex; align-items: flex-start; gap: 7px; margin-bottom: 10px;
  padding: 7px 10px; border-radius: 9px; font-size: 12px; line-height: 1.55;
  color: ${C.label}; border: 1px solid ${tint(C.ok, 45)}; background: ${tint(C.ok, 10)};
}
.wt-restart-banner-mark { flex: none; color: ${C.ok}; font-weight: 700; }
.wt-restart-banner-text { flex: 1; min-width: 0; word-break: break-word; }
/* 行内标题：视觉上就是原来那行字（同字号/行高/颜色），但它是真按钮。
   cursor:text 是「点进去改文字」的暗示；hover 只加一条虚线下划线，不改任何布局。 */
.wt-title { word-break: break-word; }
.wt-title-btn {
  appearance: none; display: block; width: 100%; margin: 0; padding: 0;
  border: 0; background: transparent; font: inherit; line-height: inherit;
  text-align: left; cursor: text;
}
.wt-title-btn:hover { text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
.wt-title-btn:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 2px; border-radius: 4px; }
/* 原地编辑用的输入：与标题同一套字体/行高，0 边框 0 内边距 → 行高不跳。 */
.wt-title-input {
  display: block; width: 100%; min-width: 0; box-sizing: border-box;
  margin: 0; padding: 0; border: 0; background: transparent;
  font: inherit; line-height: inherit; color: inherit;
}
.wt-title-input:focus { outline: 2px solid ${C.brand}; outline-offset: 2px; border-radius: 4px; }
.wt-spin {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid ${C.border}; border-top-color: ${C.brand}; animation: wt-spin .8s linear infinite;
}
/*
 * 降级：系统要求「减少动态效果」时全部跳过动画，只做状态切换（勾上/取消仍然是即时的）。
 * 这是纯 CSS 的第二道保险——JS 侧 prefersReducedMotion() 已经会直接不挂 .is-celebrating。
 */
@media (prefers-reduced-motion: reduce) {
  .wt-check-celebrate,
  .wt-row.is-celebrating,
  .wt-row.is-celebrating .wt-title,
  .wt-check-celebrate .wt-check-mark path { animation: none !important; }
  .wt-check-celebrate .wt-check-mark path { stroke-dasharray: none; stroke-dashoffset: 0; }
  .wt-check, .wt-flag-btn { transition: none !important; }
}
`;

/* ------------------------------------------------------------------ *
 * 错误边界
 *
 * 为什么必须补：slot entry 在渲染期抛异常 = 整块面板白屏/黑屏，用户只会以为插件坏了
 * （0.2.x 就出过一次：面板里调了当时还不存在的 dayKey）。React 的错误边界是唯一能在
 * 运行期兜住**子组件渲染抛错**的机制，所以这里加一个类组件：
 *   - getDerivedStateFromError：把 error 收进 state，下一帧渲染兜底 UI；
 *   - componentDidCatch：把**原始 error 和组件栈**照原样打到 console，绝不吞错（不能因为
 *     兜了底就把真实 bug 藏起来）；
 *   - 「重试」：清掉 error 并把 attempt+1，keyed Fragment 换 key → 子树整体重新挂载，
 *     用户不必重启 DSH。
 * DOM 里只放 error.message（纯文本子节点，React 负责转义；**绝不用 innerHTML**），
 * 堆栈只进控制台。样式全部走 --dsw-alias-* 变量，且不依赖面板那张样式表 ——
 * 面板自己崩掉时 STYLE_TEXT 很可能根本没渲染出来。
 * ------------------------------------------------------------------ */
export class WorkTodoErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, attempt: 0 };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 不掩盖 bug：原始 error（含 stack）与组件栈原样输出，排查时一眼能看到真凶
    console.error(`[${SHORT_NAME}] 面板渲染出错（已兜底，未白屏）：`, error, info?.componentStack ?? '');
  }

  /** 清掉错误状态 + 换 key：把子树整个重新挂载一次。 */
  handleRetry() {
    this.setState((prev) => ({ error: null, attempt: (prev?.attempt ?? 0) + 1 }));
  }

  render() {
    const state = this.state ?? {};
    if (!state.error) {
      // key 变化 → React 卸载旧子树、按新实例挂载（重试走的就是这条路）
      return React.createElement(
        React.Fragment,
        { key: `wt-eb-${state.attempt ?? 0}` },
        this.props?.children ?? null,
      );
    }
    // 拿不到宿主注入的 t 时退回本模块的 zh 字典（同一份文案），再不行才显示 key 本身
    const injected = typeof this.props?.t === 'function' ? this.props.t : null;
    const t = injected ?? ((key) => zh[key] ?? key);
    // 只取摘要：error 可能是任何东西，message 缺失就留空，绝不 String(error) 把堆栈带进 DOM
    const detail = state.error?.message
      ? String(state.error.message)
      : (typeof state.error === 'string' ? state.error : '');
    return React.createElement('div', {
      className: 'wt-root wt-crash',
      role: 'alert',
      style: {
        height: '100%', overflow: 'auto', boxSizing: 'border-box',
        padding: '18px 18px 32px', color: C.label, fontSize: 13, lineHeight: 1.7,
        fontFamily: 'var(--dsw-font-family, system-ui, sans-serif)',
      },
    }, [
      React.createElement('div', {
        key: 'title',
        style: { fontWeight: 650, fontSize: 14, color: C.error, wordBreak: 'break-word' },
      }, t('panelCrashTitle')),
      detail
        ? React.createElement('div', {
          key: 'detail',
          style: {
            marginTop: 8, padding: '6px 9px', borderRadius: 8, fontSize: 12,
            color: C.label2, wordBreak: 'break-word',
            border: `1px solid ${tint(C.error, 45)}`, background: tint(C.error, 12),
          },
        }, detail)
        : null,
      React.createElement('div', {
        key: 'hint',
        style: { marginTop: 8, fontSize: 11.5, color: C.label3 },
      }, t('panelCrashHint')),
      injected
        ? null
        : React.createElement('div', {
          key: 'en',
          style: { marginTop: 4, fontSize: 11, color: C.label3 },
        }, 'Work to-dos panel crashed — click Retry to remount it.'),
      React.createElement('button', {
        key: 'retry',
        type: 'button',
        className: 'wt-btn wt-btn-primary',
        style: {
          marginTop: 12, font: 'inherit', fontSize: 12, lineHeight: 1.6, padding: '4px 12px',
          borderRadius: 8, cursor: 'pointer',
          border: `1px solid ${tint(C.brand, 50)}`, color: C.brand, background: tint(C.brand, 10),
        },
        onClick: this.handleRetry,
      }, t('retry')),
    ]);
  }
}

/**
 * 把一个 slot 组件包进错误边界。
 *
 * 选在 `apply()` 注册处包（而不是改组件内部）：面板与侧栏两个入口一处收口，
 * 组件本体保持纯净、不新增嵌套层级，测试里也还能直接拿到「未包的组件」做反向验证；
 * 这是侵入最小的做法。`t` 从 slot props 透传给边界，让兜底文案跟随宿主语言。
 */
function withErrorBoundary(Component) {
  return function WorkTodoEntry(props) {
    return React.createElement(WorkTodoErrorBoundary, { t: props?.t }, React.createElement(Component, props));
  };
}

/* ------------------------------------------------------------------ *
 * 图标：纯 React.createElement('svg', ...) 自绘，颜色一律 currentColor，
 * 这样同一个图标在勾选框里是绿色、在按钮里是次级文字色，不需要第二套画法。
 * ------------------------------------------------------------------ */
function WorkTodoIcon({ size = 16, active }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { opacity: active ? 1 : 0.82 },
  }, [
    React.createElement('rect', { key: 'a', x: '2.7', y: '3.1', width: '10.6', height: '10.4', rx: '2' }),
    React.createElement('path', { key: 'b', d: 'M5.6 1.7h4.8v2.7H5.6z' }),
    React.createElement('path', { key: 'c', d: 'M5.7 9.3l1.7 1.7 3.1-3.5' }),
  ]);
}

function IconCheck({ size = 11, className }) {
  return React.createElement('svg', {
    className, width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, React.createElement('path', { d: 'M2 6.3 4.6 8.9 10 3.1' }));
}

function IconChevron({ open, size = 10 }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 14 14', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    // 收起时把「向下」的箭头转成「向右」：比画两个图标便宜，也不会因为尺寸不同而跳一下
    style: { flex: 'none', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s ease' },
  }, React.createElement('path', { d: 'm3.4 5.2 3.6 3.6 3.6-3.6' }));
}

function IconTrash({ size = 13 }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('path', { key: 'a', d: 'M2.8 4.4h10.4' }),
    React.createElement('path', { key: 'b', d: 'M6.4 4.4V2.9h3.2v1.5' }),
    React.createElement('path', { key: 'c', d: 'M4.5 4.4l.7 8.4h5.6l.7-8.4' }),
    React.createElement('path', { key: 'd', d: 'M6.9 6.8v3.9M9.1 6.8v3.9' }),
  ]);
}

function IconClose({ size = 11 }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
  }, [
    React.createElement('path', { key: 'a', d: 'M3 3l6 6' }),
    React.createElement('path', { key: 'b', d: 'M9 3l-6 6' }),
  ]);
}

function IconRefresh({ size = 12 }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('path', { key: 'a', d: 'M2.6 8a5.4 5.4 0 0 1 9.1-3.9' }),
    React.createElement('path', { key: 'b', d: 'M13.4 8a5.4 5.4 0 0 1-9.1 3.9' }),
    React.createElement('path', { key: 'c', d: 'M12.3 1.9v2.6H9.7' }),
    React.createElement('path', { key: 'd', d: 'M3.7 14.1v-2.6h2.6' }),
  ]);
}

/**
 * 齿轮轮廓：8 个均匀的梯形齿（齿顶外弧 R6.05、齿根内弧 R4.65），
 * 每个齿 = 两条直边 + 一段外弧，齿间用一段内弧连起来。逐齿写开，
 * 保证「均匀」是肉眼与测试都能数出来的（8 × 'A' 外弧 + 8 × 'A' 内弧）。
 * 用 <path> 描边而不是文字符号（☀/⚙）—— 字形在不同平台/字体下大小与形状不一致。
 */
const GEAR_PATH = [
  'M6.1 2.44 L6.1 1.02 A6.05 6.05 0 0 1 7.9 1.02 L7.9 2.44 A4.65 4.65 0 0 1 9.59 3.14',
  'L10.59 2.13 A6.05 6.05 0 0 1 11.87 3.41 L10.86 4.41 A4.65 4.65 0 0 1 11.56 6.1',
  'L12.98 6.1 A6.05 6.05 0 0 1 12.98 7.9 L11.56 7.9 A4.65 4.65 0 0 1 10.86 9.59',
  'L11.87 10.59 A6.05 6.05 0 0 1 10.59 11.87 L9.59 10.86 A4.65 4.65 0 0 1 7.9 11.56',
  'L7.9 12.98 A6.05 6.05 0 0 1 6.1 12.98 L6.1 11.56 A4.65 4.65 0 0 1 4.41 10.86',
  'L3.41 11.87 A6.05 6.05 0 0 1 2.13 10.59 L3.14 9.59 A4.65 4.65 0 0 1 2.44 7.9',
  'L1.02 7.9 A6.05 6.05 0 0 1 1.02 6.1 L2.44 6.1 A4.65 4.65 0 0 1 3.14 4.41',
  'L2.13 3.41 A6.05 6.05 0 0 1 3.41 2.13 L4.41 3.14 A4.65 4.65 0 0 1 6.1 2.44 Z',
].join(' ');

/** 小齿轮（14×14）：齿圈轮廓 + 中心圆孔，纯描边 currentColor。
 * 纯装饰，可读名由按钮的 aria-label/title 提供。 */
function IconSettings({ size = 14 }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 14 14', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', focusable: 'false',
  }, [
    React.createElement('path', { key: 'gear', d: GEAR_PATH }),
    React.createElement('circle', { key: 'hole', cx: 7, cy: 7, r: 1.7 }),
  ]);
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
/** 本地「今天」。只在该字段缺失时兜底（宿主的 today 是权威值，且与本机时区一致）。 */
function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * 面板上的写操作统一走这里。
 * 约定：宿主所有路由都回 200，成败看 `ok`；失败时把宿主的 error 原文抛出去，
 * 由面板顶部的错误条原样显示——绝不吞掉原因（用户要看到「标题过长」这种具体话）。
 *
 * `reason` 会**挂在 Error 上**一起抛出去：有些失败的原因码本身就是给用户看的分类
 *（自升级的 `linked` 要换成「本地链接安装」的专门文案），只有 message 是分不出来的。
 * @param {string} path 相对路由前缀的路径，如 '/create'
 * @param {object} body
 * @returns {Promise<object>} 成功时返回 data
 */
async function postJson(path, body) {
  const response = await fetch(`${ROUTE_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    // S4-3：宿主对请求体超时/超限回的是 4xx + `{reason, error}`（以前直接掐断连接，
    // 客户端只能看到 ECONNRESET）。这里优先把宿主的原文取出来，用户才看得到「请求体过大」。
    const detail = await response.json().catch(() => null);
    const error = new Error(detail?.error ?? detail?.reason ?? `HTTP ${response.status}`);
    if (detail?.reason) error.reason = detail.reason;
    throw error;
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed) throw new Error('响应不是 JSON');
  if (!parsed.ok) {
    const error = new Error(parsed.error ?? parsed.reason ?? '未知错误');
    if (parsed.reason) error.reason = parsed.reason;
    throw error;
  }
  return parsed.data ?? {};
}

/**
 * GET /worktodo/update：自升级进度。
 * 只在 `state === 'running'` 时被轮询调用（见 UPDATE_POLL_MS），不做任何缓存。
 * @returns {Promise<object|null>} 宿主的升级状态
 */
async function fetchUpdateRun() {
  const response = await fetch(`${ROUTE_BASE}/update`, { cache: 'no-store', credentials: 'same-origin' });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.ok) {
    throw new Error(parsed?.error ?? parsed?.reason ?? `HTTP ${response.status}`);
  }
  return parsed.data ?? null;
}

/* ------------------------------------------------------------------ *
 * 数据获取
 * ------------------------------------------------------------------ */
/**
 * 模块级缓存：面板被切走再切回来时 React 会重新挂载，有上次结果就先渲染、后台再刷新
 * （stale-while-revalidate）。侧栏来回点的时候不该每次都转圈。
 *
 * S3-3：缓存必须**按形状分开**。面板现在只请求当前视图需要的那一种形状（见 shapesForView），
 * 如果还共用一份缓存，切到「按项目」时会先拿「按截止」的旧载荷去渲染 → 短暂显示空列表。
 */
const lastListByShapes = new Map();
// 排序模式跨「切走再切回」保持；manual = 尊重拖动顺序
let lastSort = 'manual';

function useList(sort, shapes) {
  const [state, setState] = React.useState(() => {
    const cached = lastListByShapes.get(shapes);
    return cached
      ? { status: 'ready', data: cached, error: null }
      : { status: 'loading', data: null, error: null };
  });
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    /**
     * filter=all 而不是 open：面板是「按分组展示」的，宿主的分组是在**筛选后的子集**上算的，
     * 用 open 时 groups.completed 恒为空，「已完成」那一组就永远出不来（也就没法折叠/展开）。
     * 统计 stats 不受 filter 影响（宿主按全量算），所以顶部数字仍然是全局口径。
     *
     * S3-3：shapes 明确只取当前视图需要的一种 —— 缺省（不发 shapes）宿主会回三份同样大小的数据
     *（5000 条 = 4.28 MiB/次），而面板一次只用得上其中一份。
     */
    fetch(`${ROUTE_LIST}?filter=all&sort=${encodeURIComponent(sort || 'manual')}&shapes=${encodeURIComponent(shapes)}`, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json().catch(() => null);
        if (!body?.ok) throw new Error(body?.error ?? body?.reason ?? '未知错误');
        lastListByShapes.set(shapes, body.data);
        if (alive) setState({ status: 'ready', data: body.data, error: null });
      })
      .catch((error) => {
        // 已经有数据时只标记错误，不清空面板：一次抖动不该让人看不到自己的待办
        if (alive) {
          setState((prev) => ({
            ...prev,
            status: prev.data ? 'ready' : 'failed',
            error: String(error?.message ?? error),
          }));
        }
      });
    return () => { alive = false; };
  }, [tick, sort, shapes]);

  const refresh = React.useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refresh };
}

/**
 * 「完成动效播完再刷新」的调度器（导出供单测；面板里由 useMemo 持有一个实例）。
 *
 * 为什么需要它：刷新会拿回服务端真相并把行**按新分组重排**。旧实现在写成功的
 * `finally` 里立刻 refresh，于是勾选后 ~1 个 RTT 行就滑进「已完成」，
 * 三段动画被拦腰切断 —— 这正是「太快、一闪而过」的根因。
 *
 * 约束：
 *   - 只用**一个**定时器，绝不做逐帧 JS 动画（动画本身全是 CSS）；
 *   - `schedule` 先取消上一个待刷新（连续点击/连续完成时由最后一次接管，不会补两次）；
 *   - `cancel` 幂等：卸载、写失败、取消完成都直接调它，不会留下悬空回调。
 *
 * @param {() => void} refresh 真正触发列表重取的回调
 * @param {{setTimeout?: Function, clearTimeout?: Function}} [timers] 测试可注入假定时器
 * @returns {{schedule: (ms?: number) => any, cancel: () => boolean, isPending: () => boolean}}
 */
export function createCelebrationRefresh(refresh, timers = {}) {
  const setTimer = typeof timers.setTimeout === 'function'
    ? timers.setTimeout
    : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof timers.clearTimeout === 'function'
    ? timers.clearTimeout
    : (handle) => clearTimeout(handle);
  let timer = null;

  const cancel = () => {
    if (timer === null) return false;
    try { clearTimer(timer); } catch { /* 已触发 / 环境不支持 clearTimeout，忽略 */ }
    timer = null;
    return true;
  };

  const schedule = (ms = CELEBRATE_REFRESH_MS) => {
    cancel();
    const delay = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : CELEBRATE_REFRESH_MS;
    timer = setTimer(() => {
      timer = null;
      refresh();
    }, delay);
    // Node（测试环境）里不要因为这个定时器挂住事件循环；浏览器返回的 number 没有 unref
    timer?.unref?.();
    return timer;
  };

  return { schedule, cancel, isPending: () => timer !== null };
}

/* ------------------------------------------------------------------ *
 * 快速添加
 * ------------------------------------------------------------------ */
/** 小红旗图标：填充与描边都用 currentColor，颜色由按钮的 color 决定。 */

/**
 * 新增待办：平时只是一个**大加号**，点开才展开表单。
 * 日期用原生日历（`type=date`）、时间用原生时钟（`type=time`），
 * 优先级用三个不同颜色的**小红旗**表示（高=红、普通=琥珀、低=灰）。
 */

/** 小红旗图标：颜色由父级 color 决定；filled=选中档位。 */
function IconFlag({ filled, dashed }) {
  return React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [
    React.createElement('path', {
      key: 'pole', d: 'M3.6 1.6v13', stroke: 'currentColor', strokeWidth: 1.6,
      strokeLinecap: 'round', fill: 'none', strokeDasharray: dashed ? '1.5 1.5' : undefined,
    }),
    React.createElement('path', {
      key: 'cloth', d: 'M5.2 2.4h7.4L11 5.2l1.6 2.8H5.2z',
      fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.3,
      strokeLinejoin: 'round', strokeDasharray: dashed ? '1.5 1.5' : undefined,
    }),
  ]);
}

/*
 * 四档优先级的**唯一**权威定义：快速添加的优先级 chip 与每一行的旗子按钮共用这一份。
 * 为什么必须抽出来：两份四旗 UI 各写一遍，文案/颜色/顺序/aria 迟早会漂移
 * （设计稿 v5 定的是 高=红、中=琥珀、低=灰、无=虚线空心）。
 * @param {(key: string) => string} t 文案函数
 * @returns {{value: string, label: string, color: string, dashed?: boolean}[]}
 */
export function priorityFlagOptions(t) {
  return [
    { value: 'none', label: t('prioNone'), color: C.label3, dashed: true },
    { value: 'high', label: t('prioHigh'), color: C.error },
    { value: 'normal', label: t('prioNormal'), color: C.warn },
    { value: 'low', label: t('prioLow'), color: C.label3 },
  ];
}

/** 某一档优先级的语义色（高=红、中=琥珀、低/无=三级文字色）。 */
export function priorityColor(value) {
  if (value === 'high') return C.error;
  if (value === 'normal') return C.warn;
  return C.label3;
}

/**
 * 四旗选择弹层：快速添加的优先级 chip 与行内旗子按钮**共用这一个组件**。
 * 样式与文案只有这一份（这是「两份四旗 UI 漂移」的唯一防线）；点选后由调用方负责关闭。
 * @param {{t: Function, value: string, onPick: Function, onClose: Function}} props
 */
function PriorityFlagsPopover({ t, value, onPick, onClose }) {
  return React.createElement('div', {
    role: 'group',
    'aria-label': t('priorityLabel'),
    'data-wt-priority-pop': 'true',
    // Esc 关闭：挂在弹层上，焦点在任意一个旗子按钮上按 Esc 都能关
    onKeyDown: (event) => { if (event?.key === 'Escape') onClose?.(); },
    style: {
      position: 'absolute', top: '100%', left: 0, zIndex: 5, marginTop: 4, padding: 6, display: 'flex', gap: 4,
      background: C.layer1, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.12)',
    },
  }, priorityFlagOptions(t).map((flag) => React.createElement('button', {
    key: flag.value, type: 'button', className: 'wt-chip',
    'data-wt-priority': flag.value,
    'aria-pressed': value === flag.value,
    style: {
      color: flag.color, font: 'inherit', fontSize: 11.5, cursor: 'pointer',
      borderColor: value === flag.value ? flag.color : undefined,
    },
    title: flag.label,
    onClick: () => onPick?.(flag.value),
  }, [
    React.createElement(IconFlag, { key: 'f', filled: value === flag.value, dashed: flag.value === 'none' }),
    React.createElement('span', { key: 'v' }, flag.label),
  ])));
}

/**
 * 系统是否要求「减少动态效果」。
 *
 * CSS 里已经有 @media (prefers-reduced-motion: reduce) 兜底；这里再守一道 JS：
 * 开启减少动效时**连动效类都不挂**，避免任何残留的 keyframes/transition。
 * matchMedia 在极少数环境（旧内核 / 测试替身）里可能不存在，所以整段包在 try 里。
 * @param {Window|undefined} [win]
 * @returns {boolean}
 */
export function prefersReducedMotion(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    return Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

const IconCal = () => React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' }, [
  React.createElement('rect', { key: 'r', x: 2.2, y: 3.4, width: 11.6, height: 10.4, rx: 2 }),
  React.createElement('path', { key: 'p', d: 'M2.2 6.6h11.6M5.4 2.2v2.4M10.6 2.2v2.4' }),
]);
const IconClock = () => React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' }, [
  React.createElement('circle', { key: 'c', cx: 8, cy: 8, r: 5.8 }),
  React.createElement('path', { key: 'p', d: 'M8 4.9V8l2.2 1.4' }),
]);
/** 文件夹：第二行「项目」那一项的前缀图标（与日期/时间/优先级同一种画法）。 */
const IconFolder = () => React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' }, [
  React.createElement('path', { key: 'f', d: 'M1.8 4.4a1.4 1.4 0 0 1 1.4-1.4h2.6l1.4 1.7h5a1.4 1.4 0 0 1 1.4 1.4v5.5a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4z' }),
]);
/** 铅笔：行尾「编辑详情」入口（标题单击改成行内编辑后，备注/日期等完整表单从这里进）。 */
const IconPencil = () => React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' }, [
  React.createElement('path', { key: 'p', d: 'M10.4 2.8 13.2 5.6 5.8 13H3v-2.8z' }),
  React.createElement('path', { key: 'l', d: 'M8.9 4.3 11.7 7.1' }),
]);

/**
 * 「项目」选择器弹层里的查重：把用户输入对齐到已有项目。
 *
 * 重名不能报错、也不能造一个只差大小写/首尾空白的第二份（那会让「按项目」视图
 * 立刻裂成两个桶）。命中已有项目时返回**它在清单里的原名**，否则返回 null。
 * @param {string[]} options 已知项目（宿主 /list 的 projects）
 * @param {string} input 用户输入
 * @returns {string|null}
 */
export function matchExistingProject(options, input) {
  const name = String(input ?? '').trim();
  if (!name) return null;
  const key = name.toLowerCase();
  const found = asArray(options).find((option) => typeof option === 'string' && option.trim().toLowerCase() === key);
  return found ? found.trim() : null;
}

/**
 * 项目选择浮层：**QuickAdd 与行内项目标签共用这一份**（需求要求复用，不复制两份）。
 *
 * 内容与顺序：已有项目（点选）→「未归类」（清除 = null）→ 新建（输入 + 新建）。
 * 只在打开时挂载；Esc 关闭由浮层与触发按钮共同保证，点外部关闭由调用方注册。
 * 不使用 innerHTML；没有引入新依赖。
 *
 * @param {object} props
 * @param {(key: string) => string} props.t 文案
 * @param {string|null} props.value 当前项目（null = 未归类）
 * @param {string[]} props.options 宿主 /list 给的已有项目
 * @param {boolean} [props.truncated] 项目太多、列表被截断
 * @param {(project: string|null) => void} props.onPick 选中/清除/新建
 * @param {() => void} props.onClose 关闭
 */
function ProjectPopover({ t, value, options, truncated, onPick, onClose }) {
  const [draft, setDraft] = React.useState('');
  const names = asArray(options)
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter(Boolean);
  /** 新建：重名（忽略大小写与首尾空白）直接选中已有项目；空输入什么都不做。 */
  const create = () => {
    const name = String(draft ?? '').trim();
    if (!name) return;
    onPick?.(matchExistingProject(names, name) ?? name);
  };
  /** Esc 关闭：浮层与内部输入都能触发（键盘从哪儿进来都关得掉）。 */
  const closeOnEscape = (event) => {
    if (event?.key === 'Escape') {
      event.preventDefault?.();
      onClose?.();
    }
  };
  return React.createElement('div', {
    role: 'group',
    className: 'wt-project-pop',
    'aria-label': t('projectLabel'),
    'data-wt-project-pop': 'true',
    onKeyDown: closeOnEscape,
  }, [
    ...names.map((name) => React.createElement('button', {
      key: `p:${name}`, type: 'button', className: 'wt-chip', 'data-wt-project': name,
      title: name, 'aria-pressed': value === name,
      style: {
        color: value === name ? C.label : C.label2, font: 'inherit', fontSize: 11.5,
        cursor: 'pointer', justifyContent: 'flex-start',
        borderColor: value === name ? C.brand : undefined,
      },
      onClick: () => onPick?.(name),
    }, React.createElement('span', { key: 'v' }, name))),
    // 未归类：一键清除（等价 project = null）
    React.createElement('button', {
      key: 'none', type: 'button', className: 'wt-chip', 'data-wt-project-clear': 'true',
      title: t('noProject'), 'aria-pressed': value === null,
      style: {
        color: value === null ? C.label : C.label3, font: 'inherit', fontSize: 11.5,
        cursor: 'pointer', justifyContent: 'flex-start',
        borderColor: value === null ? C.brand : undefined,
      },
      onClick: () => onPick?.(null),
    }, React.createElement('span', { key: 'v' }, t('noProject'))),
    // 新建：文本输入 + 「新建」（回车即新建）
    React.createElement('div', {
      key: 'new', style: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 },
    }, [
      React.createElement('input', {
        key: 'in', className: 'wt-input', value: draft,
        placeholder: t('projectNewPlaceholder'),
        'aria-label': t('projectNewPlaceholder'),
        onChange: (event) => setDraft(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') create();
          else if (event.key === 'Escape') closeOnEscape(event);
        },
        style: { flex: '1 1 auto', minWidth: 0, fontSize: 11.5 },
      }),
      React.createElement('button', {
        key: 'go', type: 'button', className: 'wt-btn', 'data-wt-project-create': 'true',
        title: t('projectNew'), onClick: create,
      }, t('projectNew')),
    ]),
    truncated
      ? React.createElement('div', {
        key: 'more', style: { fontSize: 10.5, color: C.label3 },
      }, fillTemplate(t('projectListTruncated'), { count: names.length }))
      : null,
  ]);
}


/**
 * 快速添加：两行布局（设计稿 v5）。
 *   第一行：待办内容 + 添加；
 *   第二行（更小）：日期 / 时间 / 优先级——显示**当前值**，点开才选。
 * 标题里写了「明天下午3点」这类说法会被实时解析：第二行自动点亮并标"· 识别"，
 * 且日期词会从标题里摘掉。**手动改过就不再被自动覆盖**（手动优先）。
 */
function QuickAdd({ t, onAdd, busy, projects, projectsTruncated }) {
  const [title, setTitle] = React.useState('');
  const [due, setDue] = React.useState('');
  const [dueTime, setDueTime] = React.useState('');
  const [priority, setPriority] = React.useState('none');
  // 项目：null = 未归类。它是**纯手动**字段（标题里没有"项目词"可解析），
  // 所以不存在"自动识别覆盖手动选择"的问题，只要求改标题不动它。
  const [project, setProject] = React.useState(null);
  const [parsed, setParsed] = React.useState(null);
  const [manual, setManual] = React.useState(false); // 用户手动改过日期/时间
  const [flagOpen, setFlagOpen] = React.useState(false);
  const [projectOpen, setProjectOpen] = React.useState(false);
  // 点"整块胶囊"都要弹出选择器：Safari 里带值的 date/time 输入光靠点击只会聚焦，
  // 所以统一主动调 showPicker()（不可用时退回 focus+click）
  const dateRef = React.useRef(null);
  const timeRef = React.useRef(null);
  const openPicker = (ref) => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try { el.showPicker(); return; } catch { /* 某些环境不允许，走下面的兜底 */ }
    }
    el.focus();
    try { el.click(); } catch { /* 忽略 */ }
  };

  // 输入防抖 300ms 再解析（每按一键就解析会闪烁）
  React.useEffect(() => {
    if (manual) return undefined;
    const text = title;
    if (!text || !text.trim()) { setParsed(null); return undefined; }
    const timer = setTimeout(() => {
      const result = parseNaturalDue(text, Date.now());
      if (result.matched.length) {
        setParsed(result);
        setDue(result.due ?? '');
        setDueTime(result.dueTime ?? '');
      } else {
        setParsed(null);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [title, manual]);

  const submit = () => {
    if (busy) return;
    let payloadTitle = title;
    if (!manual) {
      const result = parseNaturalDue(title, Date.now());
      if (result.matched.length) payloadTitle = result.title; // 日期词摘掉
    }
    Promise.resolve(onAdd({
      title: payloadTitle,
      due: due || null,
      dueTime: dueTime || null,
      priority,
      // 空值显式给 null（不是 undefined）：宿主对请求体做「无损 JSON」校验，
      // undefined 会被当成缺键，甚至让整次调用被拒（与 due/dueTime 同一条约定）。
      project: project ?? null,
    })).then((ok) => {
      if (ok !== false) {
        setTitle('');
        setParsed(null);
        setManual(false);
        setFlagOpen(false);
        setProjectOpen(false);
        // 日期/时间/优先级/项目保留：连着录同一批事（同项目、同一天）不用重设
      }
    }).catch(() => { /* onAdd 内部已显示错误 */ });
  };

  const today = dayKey(Date.now());
  const dateLabel = due
    ? (due === today ? t('todayWord') : `${due.slice(5).replace('-', '-')}`)
    : t('dateUnset');
  const timeLabel = dueTime || t('timeUnset');
  const prioLabel = priority === 'high' ? t('prioHigh') : priority === 'normal' ? t('prioNormal') : priority === 'low' ? t('prioLow') : t('prioNone');
  const prioColor = priorityColor(priority);

  const setDate = (value) => {
    setManual(true);
    setDue(value);
    if (!value) setDueTime(''); // 没日期就没时间
    setFlagOpen(false);
  };
  const setTime = (value) => {
    setManual(true);
    if (value && !due) setDue(dayKey(Date.now())); // 只选时间＝今天
    setDueTime(value);
  };

  /** 已知项目（宿主 /list 的 projects 字段，任何 shapes 下都有）。 */
  const projectOptions = asArray(projects)
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter(Boolean);

  /** Esc 关闭项目弹层（chip 与弹层都挂，键盘从哪儿进来都能关）。 */
  const closeProjectOnEscape = (event) => {
    if (event?.key === 'Escape') setProjectOpen(false);
  };

  /**
   * 弹层里的「新建」逻辑现在收在共用的 ProjectPopover 里（重名对齐到已有项目）。
   */
  return React.createElement('div', { key: 'qa', style: { marginBottom: 12 } }, [
    // ---- 第一行：内容 + 添加 ----
    React.createElement('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
      React.createElement('input', {
        key: 'ti',
        className: 'wt-input',
        style: { flex: '1 1 auto', fontSize: 13, padding: '7px 10px' },
        value: title,
        placeholder: t('addPlaceholder'),
        'aria-label': t('addPlaceholder'),
        onChange: (event) => {
          const next = event.target.value;
          setTitle(next);
          // 手动优先，但把标题清空＝重新开始：交回给自动识别
          if (!next.trim()) { setManual(false); setParsed(null); }
        },
        onKeyDown: (event) => { if (event.key === 'Enter') submit(); },
      }),
      React.createElement('button', {
        key: 'add', type: 'button', className: 'wt-btn wt-btn-primary',
        disabled: Boolean(busy), onClick: submit,
      }, t('add')),
    ]),

    // ---- 第二行（更小）：日期 / 时间 / 优先级 / 项目 ----
    React.createElement('div', { key: 'l2', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 11.5, flexWrap: 'wrap' } }, [
      // 日期：label 里套一个透明的原生 date 输入，点它即弹系统日历
      React.createElement('label', {
        key: 'due',
        className: `wt-chip${parsed && parsed.due ? ' is-parsed' : ''}`,
        'data-wt-field': 'due',
        title: t('dueLabel'),
        onClick: (event) => { event.preventDefault(); openPicker(dateRef); },
        style: { position: 'relative', cursor: 'pointer', color: due ? C.label : C.label3, borderColor: parsed && parsed.due ? C.brand : undefined },
      }, [
        React.createElement(IconCal, { key: 'i' }),
        React.createElement('span', { key: 'v' }, due ? `${today === due ? t('todayWord') : due}${parsed && parsed.due ? ` · ${t('fromParsed')}` : ''}` : t('dateUnset')),
        React.createElement('input', {
          key: 'in', ref: dateRef, type: 'date', value: due, 'aria-label': t('dueLabel'),
          style: { position: 'absolute', inset: 0, opacity: 0, border: 0, padding: 0, width: '100%', height: '100%', cursor: 'pointer' },
          onChange: (event) => setDate(event.target.value),
        }),
      ]),
      // 时间：同样用原生 time 输入；只选时间时自动补今天
      React.createElement('label', {
        key: 'time',
        className: `wt-chip${parsed && parsed.dueTime ? ' is-parsed' : ''}`,
        'data-wt-field': 'time',
        title: t('dueTimeLabel'),
        onClick: (event) => { event.preventDefault(); openPicker(timeRef); },
        style: { position: 'relative', cursor: 'pointer', color: dueTime ? C.label : C.label3, borderColor: parsed && parsed.dueTime ? C.brand : undefined },
      }, [
        React.createElement(IconClock, { key: 'i' }),
        React.createElement('span', { key: 'v' }, `${timeLabel}${parsed && parsed.dueTime ? ` · ${t('fromParsed')}` : ''}`),
        React.createElement('input', {
          key: 'in', ref: timeRef, type: 'time', value: dueTime, lang: 'zh-CN', 'aria-label': t('dueTimeLabel'),
          style: { position: 'absolute', inset: 0, opacity: 0, border: 0, padding: 0, width: '100%', height: '100%', cursor: 'pointer' },
          onChange: (event) => setTime(event.target.value),
        }),
      ]),
      // 优先级：点开四个小旗（弹层与行内旗子按钮共用 PriorityFlagsPopover，见上）
      React.createElement('span', { key: 'prio', style: { position: 'relative' } }, [
        React.createElement('button', {
          key: 'btn', type: 'button', className: 'wt-chip', 'data-wt-field': 'priority',
          style: { color: prioColor, cursor: 'pointer', font: 'inherit', fontSize: 11.5 },
          title: t('priorityLabel'), 'aria-label': t('priorityLabel'), 'aria-expanded': flagOpen,
          onClick: () => setFlagOpen((open) => !open),
          onKeyDown: (event) => { if (event?.key === 'Escape') setFlagOpen(false); },
        }, [
          React.createElement(IconFlag, { key: 'f', dashed: priority === 'none', filled: priority !== 'none' }),
          React.createElement('span', { key: 'v' }, `${t('priorityLabel')} · ${prioLabel}`),
        ]),
        flagOpen ? React.createElement(PriorityFlagsPopover, {
          key: 'pop',
          t,
          value: priority,
          onPick: (value) => { setPriority(value); setFlagOpen(false); },
          onClose: () => setFlagOpen(false),
        }) : null,
      ]),
      // 项目：**排在优先级之后**（顺序：日期 → 时间 → 优先级 → 项目）。
      // 点开一个与优先级同风格的小弹层：已有项目（点选）→ 新建（输入 + 新建）→ 未归类（清除）。
      React.createElement('span', { key: 'project', style: { position: 'relative' } }, [
        React.createElement('button', {
          key: 'btn', type: 'button', className: 'wt-chip', 'data-wt-field': 'project',
          style: { color: project ? C.label : C.label3, cursor: 'pointer', font: 'inherit', fontSize: 11.5 },
          title: t('projectLabel'),
          'aria-label': t('projectLabel'),
          'aria-expanded': projectOpen,
          'aria-haspopup': 'true',
          onClick: () => setProjectOpen((open) => !open),
          onKeyDown: closeProjectOnEscape,
        }, [
          React.createElement(IconFolder, { key: 'i' }),
          React.createElement('span', { key: 'v' }, project ? project : `${t('projectLabel')} · ${t('noProject')}`),
        ]),
        projectOpen ? React.createElement(ProjectPopover, {
          key: 'pop',
          t,
          value: project,
          options: projectOptions,
          truncated: projectsTruncated,
          onPick: (name) => { setProject(name); setProjectOpen(false); },
          onClose: () => setProjectOpen(false),
        }) : null,
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * 单行：查看 / 行内编辑 / 二次确认删除
 * 状态都留在这一行内部，所以在别的行上敲字、或者列表刷新，都不会把正在编辑的内容冲掉。
 *
 * S3-3（客户端侧）：外面包一层 `React.memo`（默认浅比较）。5000 条时每一次
 * 「与数据无关」的父级重渲染（折叠分组、错误条、pending 计数、拖动开始/结束…）
 * 都会把整张列表 reconcile 一遍；memo 让只有 props 真的变了的那些行重渲染。
 * 为了让浅比较真的起作用，父级传下来的必须是稳定引用：
 *   - `t`：拿不到宿主注入时用模块级 FALLBACK_T，不再是每次渲染新建的箭头函数；
 *   - `onToggle/onRemove/onSave`：useCallback（面板里已保证）；
 *   - `drag`：共享的 dragHandlers 对象（useMemo），每一行不再各造一个新对象；
 *     每一行与拖动相关的差异只有布尔 `dragging`。
 * ------------------------------------------------------------------ */
const TodoRow = React.memo(function TodoRow({ todo, today, t, onToggle, onRemove, onSave, onPriority, onDue, onTitle, onProject, projects, projectsTruncated, celebrate, drag, dragging }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(null);
  const [notesOpen, setNotesOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  /** 四旗弹层是否打开。 */
  const [flagOpen, setFlagOpen] = React.useState(false);
  /**
   * 「无优先级」的行默认不常显旗子（设计定稿：默认档不制造噪音）。
   * 可见性用**组件状态**表达（而不是纯 CSS :hover），hover / focus 两条路都走同一份状态，
   * 键盘 Tab 进这一行时（onFocus 冒泡）旗子同样会淡出来，所以纯键盘也够得着。
   */
  const [flagPeek, setFlagPeek] = React.useState(false);
  /**
   * 行内日期编辑（本轮新增）：
   *   - `dateOpen`：浮层是否挂载（关闭即卸载，绝不常驻）；
   *   - `datePeek`：无日期的行在 hover/focus 时才显示「＋ 日期」入口（与 ghost 旗子同一种状态驱动）；
   *   - `datePlacement`：浮层向下/向上（见 chooseDatePopoverPlacement）；
   *   - `dateOverride` + `dateOverrideFor`：乐观值，只对「点击那一刻的数据对象」有效，
   *     refresh 拿回新对象后自动失效，以服务端真相为准；
   *   - `dateError`：保存失败的行内温和提示（不把原始异常带进 DOM）。
   */
  const [dateOpen, setDateOpen] = React.useState(false);
  const [datePeek, setDatePeek] = React.useState(false);
  const [datePlacement, setDatePlacement] = React.useState('down');
  const [dateOverride, setDateOverride] = React.useState(null);
  const [dateOverrideFor, setDateOverrideFor] = React.useState(null);
  const [dateError, setDateError] = React.useState(null);
  const dateWrapRef = React.useRef(null);
  /** 勾选完成时挂上的动效类（纯 CSS 动画，见 STYLE_TEXT 的 wt-check-pop / wt-row-celebrate）。 */
  const [celebrating, setCelebrating] = React.useState(false);
  /**
   * 乐观的「已完成」态：勾上时立刻把这一行按已完成渲染，对勾才看得到描边动画
   * （否则要等一次 RTT 数据回来，那时行通常已经滑进「已完成」分组了）。
   * `null` = 完全跟随数据。
   *
   * B2：乐观态**只对「点击那一刻的那份数据」有效**（`optimisticFor === todo`）。
   * 写成功后的 `refresh()` 会拿回**新对象**，引用一变乐观态立刻失效、以服务端数据为准 ——
   * 旧实现没有任何清除分支，数据回到 `pending` 时这一行仍渲染成已完成，
   * 用户去点它想「取消完成」，切换的是服务端真实状态（pending → completed），
   * 显示与真实状态反向。只认引用（而不是比较 status/updatedAt 的值）是为了覆盖
   * 「服务端把状态改回 pending 但 updatedAt 恰好没变」这种最坏情况。
   */
  const [optimisticDone, setOptimisticDone] = React.useState(null);
  const [optimisticFor, setOptimisticFor] = React.useState(null);
  /**
   * 行内标题编辑：
   *   - `titleEditing`：标题是否原地变成 input（同一位置，不换行）；
   *   - `titleOverride` + `titleOverrideFor`：乐观值（只对点击那一刻的 todo 有效，refresh 后失效）；
   *   - `titleError`：空白被拒 / 保存失败的温和提示（不含原始异常串）；
   *   - `titleCommittedRef`：Enter 或失焦只能提交一次（Esc 提交后用 ref 挡住随后的 blur）。
   */
  const [titleEditing, setTitleEditing] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const [titleOverride, setTitleOverride] = React.useState(null);
  const [titleOverrideFor, setTitleOverrideFor] = React.useState(null);
  const [titleError, setTitleError] = React.useState(null);
  const titleCommittedRef = React.useRef(false);
  /**
   * 行内项目编辑：
   *   - `projectOpen`：选择浮层是否挂载（与 QuickAdd 共用 ProjectPopover）；
   *   - `projectPeek`：没有项目的行 hover / focus 时才出现「＋ 项目」（与日期入口同一做法）；
   *   - `projectOverride`：`undefined` = 没有乐观值（注意 null 是合法值 = 清除项目）。
   */
  const [projectOpen, setProjectOpen] = React.useState(false);
  const [projectPeek, setProjectPeek] = React.useState(false);
  const [projectOverride, setProjectOverride] = React.useState(undefined);
  const [projectOverrideFor, setProjectOverrideFor] = React.useState(null);
  const [projectError, setProjectError] = React.useState(null);
  const projectWrapRef = React.useRef(null);

  // 二次确认要能自己失效：点了删除又改主意的人，不该在几分钟后误触一次就真删掉
  React.useEffect(() => {
    if (!confirming) return undefined;
    const id = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(id);
  }, [confirming]);

  const row = todo ?? {};
  // B2：数据换了新对象（refresh/轮询拿回来的服务端真相）→ 乐观态失效
  const optimisticActive = optimisticDone !== null && optimisticFor === todo;
  const done = (optimisticActive ? optimisticDone : null) ?? row.status === 'completed';
  const due = typeof row.due === 'string' ? row.due : '';
  const dueTime = typeof row.dueTime === 'string' ? row.dueTime : '';
  // 乐观日期只对「点击那一刻的数据对象」有效（B2 的同一条口径）：refresh 拿回新对象即失效
  const dateOverrideActive = dateOverride !== null && dateOverrideFor === todo;
  const shownDue = dateOverrideActive ? (dateOverride.due ?? '') : due;
  const shownDueTime = dateOverrideActive ? (dateOverride.dueTime ?? '') : dueTime;
  const overdue = !done && Boolean(shownDue) && Boolean(today) && shownDue < today;
  // 标题 / 项目也遵循同一条乐观值口径：只认「点击那一刻的数据对象」
  const baseTitle = typeof row.title === 'string' ? row.title : '';
  const titleOverrideActive = titleOverride !== null && titleOverrideFor === todo;
  const shownTitle = titleOverrideActive ? titleOverride : baseTitle;
  const baseProject = typeof row.project === 'string' && row.project ? row.project : null;
  const projectOverrideActive = projectOverride !== undefined && projectOverrideFor === todo;
  const shownProject = projectOverrideActive ? projectOverride : baseProject;

  /**
   * 打开/关闭日期浮层。
   *
   * 打开时才计算一次「向下还是向上」：拿日期按钮的视口位置与浮层估算高度比一下，
   * 下方放不下就翻到上方。拿不到几何信息（测试替身/SSR）时默认向下。
   */
  const openDate = () => {
    const el = dateWrapRef.current;
    let rect = null;
    try { rect = el?.getBoundingClientRect?.() ?? null; } catch { rect = null; }
    const viewportHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight)
      ? window.innerHeight
      : 0;
    setDatePlacement(chooseDatePopoverPlacement(rect, viewportHeight));
    setDateError(null);
    setDateOpen(true);
  };
  const closeDate = () => setDateOpen(false);

  /**
   * 提交一次日期/时间改动：**先改本地**（乐观），再打 `POST /worktodo/update`；
   * 失败时把乐观值清掉（回到 row.due），并显示一行温和提示。
   *
   * @param {object} patch 发给宿主的 patch（due / dueTime），不含 ref
   * @param {{due: string, dueTime: string}} local 乐观本地值
   */
  const commitDate = (patch, local) => {
    setDateOverride(local);
    setDateOverrideFor(todo);
    setDateError(null);
    const fail = () => {
      setDateOverride(null);
      setDateOverrideFor(null);
      setDateError(t('dateSaveFailed'));
    };
    Promise.resolve(onDue?.(row.id, patch)).then(
      (result) => { if (result && result.ok === false) fail(); },
      fail,
    );
  };

  /** 日期变了：日期字符串（YYYY-MM-DD）→ due；清空（''）→ due:null（时间由宿主一并清掉）。 */
  const changeDate = (value) => {
    if (!value) {
      commitDate({ due: null }, { due: '', dueTime: '' });
      return;
    }
    // 时间改动才带 dueTime；改日期时保留行上已有的时间（宿主 patch 不会动它）
    commitDate({ due: value }, { due: value, dueTime: shownDueTime });
  };

  /** 时间变了：同时带 due 与 dueTime（清空时间＝dueTime:null）。 */
  const changeTime = (value) => {
    const nextTime = value || '';
    commitDate({ due: shownDue, dueTime: nextTime || null }, { due: shownDue, dueTime: nextTime });
  };

  /* ---------------- 行内标题：点标题 → 原地 input ---------------- */

  /** 进入标题编辑：草稿从「当前显示值」起，自动聚焦并全选由 input 自己的 autoFocus/onFocus 完成。 */
  const startTitleEdit = () => {
    titleCommittedRef.current = false;
    setTitleDraft(shownTitle);
    setTitleError(null);
    setTitleEditing(true);
  };

  /**
   * 提交标题：Enter 或失焦各触发一次，用 ref 保证只提交一次（Esc 之后紧跟的 blur 不会再保存）。
   * - 空白：不发请求，关掉编辑并给一句温和提示（内容还原）；
   * - 没改：静默关闭，不发空 patch；
   * - 改了：先乐观显示新标题，再 POST；失败回滚原文 + 温和提示。
   */
  const commitTitle = () => {
    if (titleCommittedRef.current) return;
    titleCommittedRef.current = true;
    const next = String(titleDraft ?? '').trim();
    setTitleEditing(false);
    setTitleDraft('');
    if (!next) {
      setTitleError(t('titleEmptyHint'));
      return;
    }
    if (next === baseTitle) {
      setTitleError(null);
      return;
    }
    setTitleOverride(next);
    setTitleOverrideFor(todo);
    setTitleError(null);
    const fail = () => {
      setTitleOverride(null);
      setTitleOverrideFor(null);
      setTitleError(t('titleSaveFailed'));
    };
    Promise.resolve(onTitle?.(row.id, next)).then(
      (result) => { if (result && result.ok === false) fail(); },
      fail,
    );
  };

  /** Esc / 取消：关掉编辑、丢掉草稿，绝不发请求；标记已收口，挡住随后的 blur。 */
  const cancelTitle = () => {
    titleCommittedRef.current = true;
    setTitleEditing(false);
    setTitleDraft('');
  };

  /* ---------------- 行内项目：点标签 → 选择浮层 ---------------- */

  /** 已知项目（宿主 /list 的 projects 字段；与 QuickAdd 用同一份数据与同一个浮层）。 */
  const projectOptions = asArray(projects)
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter(Boolean);

  const openProject = () => {
    setProjectError(null);
    setProjectOpen(true);
  };

  /**
   * 选中一个项目（null = 清除）。
   * 与当前值相同就只关浮层，不发空 patch；否则先乐观更新，再 POST；失败回滚原值 + 温和提示。
   * @param {string|null} next
   */
  const commitProject = (next) => {
    setProjectOpen(false);
    const value = next === null || next === undefined
      ? null
      : (String(next).trim() || null);
    if (value === baseProject) return;
    setProjectOverride(value);
    setProjectOverrideFor(todo);
    setProjectError(null);
    const fail = () => {
      setProjectOverride(undefined);
      setProjectOverrideFor(null);
      setProjectError(t('projectSaveFailed'));
    };
    Promise.resolve(onProject?.(row.id, value)).then(
      (result) => { if (result && result.ok === false) fail(); },
      fail,
    );
  };

  /**
   * 点外部关闭：只在浮层打开时挂 listener，关闭/卸载立刻移除。
   * 用 mousedown 而不是 click，避免「点了项目标签 → 冒泡到 document 又立刻关掉」。
   */
  React.useEffect(() => {
    if (!projectOpen) return undefined;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
    const onPointerDown = (event) => {
      const wrap = projectWrapRef.current;
      if (wrap && typeof wrap.contains === 'function' && event?.target && wrap.contains(event.target)) return;
      setProjectOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [projectOpen]);

  /**
   * 点外部关闭：只在浮层打开时挂 listener，关闭/卸载立刻移除。
   * 用 mousedown 而不是 click，避免「点了日期按钮 → 冒泡到 document 又立刻关掉」。
   */
  React.useEffect(() => {
    if (!dateOpen) return undefined;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
    const onPointerDown = (event) => {
      const wrap = dateWrapRef.current;
      if (wrap && typeof wrap.contains === 'function' && event?.target && wrap.contains(event.target)) return;
      setDateOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [dateOpen]);
  // 优先级档位：非法/缺省一律按「无」处理（与宿主 records.mjs 的归一化口径一致）
  const flagValue = EDIT_PRIORITY_OPTIONS.includes(row.priority) ? row.priority : 'none';
  const flagLabel = t(PRIORITY_LABEL_KEYS[flagValue]);
  const flagVisible = flagValue !== 'none' || flagPeek || flagOpen;
  // 无优先级时淡一点（「淡色空心旗」），展开弹层时回到实色
  const flagOpacity = !flagVisible ? 0 : (flagValue === 'none' && !flagOpen ? 0.55 : 1);

  const beginEdit = () => {
    setDraft(buildEditDraft(row));
    setNotesOpen(Boolean(row.notes));
    setEditing(true);
  };

  const stopEdit = () => { setEditing(false); setDraft(null); };

  /**
   * 勾选框：变为完成时挂上庆祝动效，取消完成时**绝不**播。
   *
   * 三层降级：
   *   1. `celebrate === false`（config.celebrate）→ 与改动前完全一致，连乐观态都不挂；
   *   2. 系统要求减少动效（prefersReducedMotion）→ 同样只做状态切换；
   *   3. 写失败 → 立刻退回，不留一个假的「已完成」勾。
   * 动效本身是纯 CSS（.is-celebrating / .wt-check-celebrate），这里只挂类，不跑任何动画循环。
   */
  const handleCheck = () => {
    const willComplete = !done;
    const canCelebrate = willComplete && celebrate !== false && !prefersReducedMotion();
    if (canCelebrate) {
      setOptimisticDone(true);
      setOptimisticFor(todo); // B2：乐观态绑定点击那一刻的数据对象
      setCelebrating(true);
    } else if (done) {
      // 取消完成：只是状态切换，把乐观态交回给数据
      setOptimisticDone(null);
      setOptimisticFor(null);
      setCelebrating(false);
    }
    // 把「这次要播动效」告诉面板：刷新会推迟到动画播完，别让行在半路重排。
    const job = Promise.resolve(onToggle(row.id, { celebrate: canCelebrate }));
    job.then(
      (result) => {
        if (result && result.ok === false) {
          setOptimisticDone(null);
          setOptimisticFor(null);
          setCelebrating(false);
        }
      },
      () => {
        setOptimisticDone(null);
        setOptimisticFor(null);
        setCelebrating(false);
      },
    );
  };

  /**
   * 保存时只发改动过的字段：宿主对空 patch 会回 empty-patch 错误，
   * 而「打开又原样关掉」显然不该报错，所以这里先自己比对一遍。
   */
  const submit = () => {
    if (!draft) return;
    const patch = {};
    const title = String(draft.title ?? '').trim();
    if (title !== (row.title ?? '')) patch.title = title;
    const nextDue = draft.due || '';
    if (nextDue !== due) {
      patch.due = nextDue; // 空串 = 清空截止日期
      if (!nextDue) patch.dueTime = 'none'; // 没有日期就没有时间
    }
    const nextDueTime = String(draft.dueTime ?? '').trim();
    if (nextDue && nextDueTime !== (row.dueTime ?? '')) patch.dueTime = nextDueTime === '' ? 'none' : nextDueTime;
    const priority = draft.priority || row.priority || 'none';
    if (priority !== (row.priority ?? 'none')) patch.priority = priority;
    const project = String(draft.project ?? '').trim();
    if (project !== (row.project ?? '')) patch.project = project; // 空串 = 去掉项目
    const notes = String(draft.notes ?? '').trim();
    if (notes !== (row.notes ?? '')) patch.notes = notes;
    stopEdit();
    if (!Object.keys(patch).length) return;
    Promise.resolve(onSave(row.id, patch)).catch(() => { /* 已在错误条上显示 */ });
  };

  const inputStyle = { fontSize: 12, padding: '3px 7px' };

  if (editing && draft) {
    const field = (key, label, control) => React.createElement('label', {
      key,
      style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.label3 },
    }, [label, control]);

    return React.createElement('div', { className: 'wt-row wt-row-edit' }, [
      React.createElement('div', { key: 'top', style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
        React.createElement('input', {
          key: 'ti',
          className: 'wt-input',
          style: { ...inputStyle, flex: 1, minWidth: 0 },
          value: draft.title,
          autoFocus: true,
          placeholder: t('titlePlaceholder'),
          'aria-label': t('titlePlaceholder'),
          onChange: (event) => setDraft((prev) => ({ ...prev, title: event.target.value })),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit();
            if (event.key === 'Escape') stopEdit();
          },
        }),
        React.createElement('button', {
          key: 'save', type: 'button', className: 'wt-btn wt-btn-primary', onClick: submit,
        }, t('save')),
        React.createElement('button', {
          key: 'cancel', type: 'button', className: 'wt-btn', onClick: stopEdit,
        }, t('cancel')),
      ]),
      React.createElement('div', {
        key: 'fields',
        style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
      }, [
        field('due', t('dueLabel'), React.createElement('input', {
          className: 'wt-input', style: inputStyle, type: 'date', value: draft.due,
          'aria-label': t('dueLabel'),
          onChange: (event) => setDraft((prev) => ({ ...prev, due: event.target.value })),
        })),
        field('tm', t('dueTimeLabel'), React.createElement('input', {
          className: 'wt-input', style: inputStyle, type: 'time', value: draft.dueTime, disabled: !draft.due,
          'aria-label': t('dueTimeLabel'),
          onChange: (event) => setDraft((prev) => ({ ...prev, dueTime: event.target.value })),
        })),
        field('prio', t('priorityLabel'), React.createElement('select', {
          className: 'wt-input', style: inputStyle, value: draft.priority,
          'aria-label': t('priorityLabel'),
          onChange: (event) => setDraft((prev) => ({ ...prev, priority: event.target.value })),
        }, EDIT_PRIORITY_OPTIONS.map((value) => React.createElement(
          'option',
          { key: value, value },
          t(PRIORITY_LABEL_KEYS[value]),
        )))),
        field('project', t('projectLabel'), React.createElement('input', {
          className: 'wt-input', style: { ...inputStyle, width: 130 }, value: draft.project,
          placeholder: t('projectPlaceholder'),
          'aria-label': t('projectPlaceholder'),
          onChange: (event) => setDraft((prev) => ({ ...prev, project: event.target.value })),
        })),
      ]),
      React.createElement('div', { key: 'notes' }, [
        notesOpen
          ? React.createElement('div', { key: 'box', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
            React.createElement('textarea', {
              key: 'ta',
              className: 'wt-input',
              style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 54 },
              rows: 3,
              value: draft.notes,
              placeholder: t('notesPlaceholder'),
              'aria-label': t('notesLabel'),
              onChange: (event) => setDraft((prev) => ({ ...prev, notes: event.target.value })),
              // textarea 里回车要换行，所以保存用 Ctrl/Cmd+Enter
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
                if (event.key === 'Escape') stopEdit();
              },
            }),
            React.createElement('span', {
              key: 'hide', className: 'wt-link', onClick: () => setNotesOpen(false),
            }, t('notesHide')),
          ])
          : React.createElement('span', {
            key: 'add', className: 'wt-link', onClick: () => setNotesOpen(true),
          }, t('notesAdd')),
      ]),
    ]);
  }

  const meta = [];
  if (row.priority === 'high') {
    meta.push(React.createElement('span', {
      key: 'p',
      className: 'wt-tag',
      style: { color: C.warn, borderColor: tint(C.warn, 50), background: tint(C.warn, 12), fontWeight: 600 },
    }, t('prioHigh')));
  } else if (row.priority === 'low') {
    meta.push(React.createElement('span', { key: 'p', className: 'wt-tag' }, t('prioLow')));
  }

  /**
   * 行内日期控件：已设日期＝一直显示的按钮（点一下改日期）；
   * 未设日期＝只在 hover/focus 时才出现（`datePeek`）的淡色「＋ 日期」。
   * 浮层只在打开时挂载，关闭即卸载；时间是原生 input（该行有时间才出现）。
   */
  const dateText = shownDue
    ? `${overdue ? `${t('overdueTag')} ` : ''}${shownDue}${shownDueTime ? ` ${shownDueTime}` : ''}`
    : '';
  const hasTimeField = Boolean(dueTime || shownDueTime);
  const dateNode = React.createElement('span', {
    key: 'd',
    ref: dateWrapRef,
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 },
  }, [
    React.createElement('button', {
      key: 'btn',
      type: 'button',
      className: `wt-date-btn${shownDue ? '' : ' is-add'}`,
      ...(shownDue ? { 'data-wt-date-btn': 'true' } : { 'data-wt-date-add': 'true' }),
      'aria-label': shownDue ? t('editDate') : t('addDateLabel'),
      'aria-haspopup': 'dialog',
      'aria-expanded': dateOpen,
      title: shownDue ? t('editDate') : t('addDateLabel'),
      // 视觉与旧文案一致（11px 小字）；逾期仍用 warn 色
      style: { color: overdue ? C.warn : C.label3 },
      onClick: openDate,
      onKeyDown: (event) => { if (event?.key === 'Escape') closeDate(); },
    }, shownDue ? dateText : t('addDate')),
    dateOpen ? React.createElement('div', {
      key: 'pop',
      className: `wt-date-pop is-${datePlacement}`,
      role: 'dialog',
      'aria-label': t('datePopover'),
      'data-wt-date-pop': 'true',
      onKeyDown: (event) => {
        if (event?.key === 'Escape') {
          event.preventDefault?.();
          closeDate();
        }
      },
    }, [
      React.createElement('label', { key: 'd', className: 'wt-date-field' }, [
        React.createElement('span', { key: 'l' }, t('dueLabel')),
        React.createElement('input', {
          key: 'in',
          className: 'wt-input',
          type: 'date',
          value: shownDue,
          autoFocus: true,
          'aria-label': t('dueLabel'),
          onChange: (event) => changeDate(String(event?.target?.value ?? '')),
        }),
      ]),
      hasTimeField
        ? React.createElement('label', { key: 't', className: 'wt-date-field' }, [
          React.createElement('span', { key: 'l' }, t('dueTimeLabel')),
          React.createElement('input', {
            key: 'in',
            className: 'wt-input',
            type: 'time',
            value: shownDueTime,
            'aria-label': t('dueTimeLabel'),
            onChange: (event) => changeTime(String(event?.target?.value ?? '')),
          }),
        ])
        : null,
      React.createElement('div', { key: 'f', className: 'wt-date-pop-foot' }, [
        shownDue
          ? React.createElement('button', {
            key: 'clear',
            type: 'button',
            className: 'wt-btn',
            'data-wt-date-clear': 'true',
            onClick: () => changeDate(''),
          }, t('clearDate'))
          : null,
        React.createElement('span', { key: 'sp', style: { flex: 1 } }),
        React.createElement('button', {
          key: 'done',
          type: 'button',
          className: 'wt-btn',
          'data-wt-date-done': 'true',
          onClick: closeDate,
        }, t('dismiss')),
      ]),
    ]) : null,
  ]);
  if (shownDue || datePeek || dateOpen || dateError) meta.push(dateNode);
  if (dateError) {
    meta.push(React.createElement('span', {
      key: 'de',
      className: 'wt-date-error',
      role: 'status',
    }, dateError));
  }

  /**
   * 行内项目标签：已设项目＝一直显示的 `#项目` 按钮（点一下改）；
   * 未设项目＝只在 hover/focus 时才出现的淡色「＋ 项目」。
   * 浮层复用 QuickAdd 的 ProjectPopover（已有 / 新建 / 未归类），关闭即卸载。
   */
  const projectNode = React.createElement('span', {
    key: 'j',
    ref: projectWrapRef,
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
  }, [
    React.createElement('button', {
      key: 'btn',
      type: 'button',
      className: `wt-tag wt-project-btn${shownProject ? '' : ' is-add'}`,
      ...(shownProject ? { 'data-wt-project-btn': 'true' } : { 'data-wt-project-add': 'true' }),
      'aria-label': shownProject ? t('editProject') : t('addProjectLabel'),
      'aria-haspopup': 'true',
      'aria-expanded': projectOpen,
      title: shownProject ? t('editProject') : t('addProjectLabel'),
      onClick: openProject,
      onKeyDown: (event) => { if (event?.key === 'Escape') setProjectOpen(false); },
    }, shownProject ? `#${shownProject}` : t('addProject')),
    projectOpen ? React.createElement(ProjectPopover, {
      key: 'pop',
      t,
      value: shownProject,
      options: projectOptions,
      truncated: projectsTruncated,
      onPick: commitProject,
      onClose: () => setProjectOpen(false),
    }) : null,
  ]);
  if (shownProject || projectPeek || projectOpen || projectError) meta.push(projectNode);
  if (projectError) {
    meta.push(React.createElement('span', {
      key: 'je',
      className: 'wt-project-error',
      role: 'status',
    }, projectError));
  }
  // 来源标记：让用户一眼看出这条是模型加的、还是从会话提升来的（人自己加的不用标）
  if (row.source === 'agent' || row.source === 'session') {
    meta.push(React.createElement('span', {
      key: 's',
      className: 'wt-tag',
      title: row.source === 'agent' ? t('sourceAgent') : t('sourceSession'),
    }, row.source === 'agent' ? t('sourceAgent') : t('sourceSession')));
  }

  // 拖动属性：只有父级给了 drag 才可拖（未启用时行为与以前完全一致）
  const dragAttrs = drag
    ? {
      draggable: true,
      onDragStart: (event) => {
        try {
          event.dataTransfer?.setData('text/plain', row.id ?? '');
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        } catch { /* 少数环境不允许写 dataTransfer，忽略即可 */ }
        drag.onStart?.(row.id);
      },
      onDragOver: (event) => { event.preventDefault(); drag.onOver?.(row.id); },
      onDrop: (event) => { event.preventDefault(); drag.onDrop?.(row.id); },
      onDragEnd: () => drag.onEnd?.(),
      title: drag.hint,
      style: dragging ? { opacity: 0.45 } : undefined,
    }
    : {};
  /**
   * 行的样式：拖拽半透明 + 高优先级的红色左缘。
   * 高亮/滑动**只走 CSS 动画**（.is-celebrating 的 background），这里不放任何会改布局的属性。
   */
  const rowStyle = {
    ...(dragging ? { opacity: 0.45 } : {}),
    ...(flagValue === 'high' ? { borderLeft: `2px solid ${C.error}`, paddingLeft: 8 } : {}),
  };
  return React.createElement('div', {
    className: `wt-row${celebrating ? ' is-celebrating' : ''}`,
    // 状态可见性给测试与读屏：动效开着时 data-wt-celebrating="true"
    'data-wt-celebrating': celebrating ? 'true' : undefined,
    'data-wt-row': row.id ?? '',
    'data-wt-row-priority': flagValue,
    // hover / focus 都让「无优先级」行的旗子、「无日期」行的＋日期、「无项目」行的＋项目淡出来。
    // focus 冒泡自子元素，纯键盘同样到达；日期/项目入口在「焦点仍在本行内」时不收起，
    // 否则刚从勾选框 Tab 到入口按钮，它会在被聚焦的瞬间消失。旗子保持原来的行为。
    onMouseEnter: () => { setFlagPeek(true); setDatePeek(true); setProjectPeek(true); },
    onMouseLeave: () => { setFlagPeek(false); setDatePeek(false); setProjectPeek(false); },
    onFocus: () => { setFlagPeek(true); setDatePeek(true); setProjectPeek(true); },
    onBlur: (event) => {
      setFlagPeek(false);
      const rowEl = event?.currentTarget;
      if (rowEl && event?.relatedTarget && typeof rowEl.contains === 'function' && rowEl.contains(event.relatedTarget)) return;
      setDatePeek(false);
      setProjectPeek(false);
    },
    // 动效是纯 CSS 的：动画跑完自己摘掉类，不需要逐帧 setState；列表刷新的延后由面板负责。
    // B3：`animationend` 会**冒泡** —— 勾选框的呼吸（620ms）与对勾描边（140→660ms）结束也会冒到行上，
    // 旧写法在 320ms 就把 is-celebrating 摘掉，整行高亮被截断（视觉跳变）。
    // 只处理「事件源就是这一行自己」的那一次（并顺手校验 animationName，防止未来加新动画时误摘）。
    onAnimationEnd: (event) => {
      if (!event || !event.currentTarget || event.target !== event.currentTarget) return;
      if (typeof event.animationName === 'string' && event.animationName && event.animationName !== 'wt-row-celebrate') return;
      if (celebrating) setCelebrating(false);
    },
    ...dragAttrs,
    style: rowStyle,
  }, [
    /* 优先级呈现（设计稿 v5）：高＝红色左缘 + 实心红旗；中＝琥珀；低＝灰；
       无＝默认不显（悬停/聚焦该行时淡出一个空心旗，可点）。旗子是按钮：点开四旗选择器。
       即「无」优先级的行也**始终渲染**这个按钮（占住那一列，各行左侧对齐稳定），
       只是 opacity:0 —— 因此 Tab 键依然能聚焦到它。 */
    React.createElement('span', {
      key: 'prio-flag',
      style: { position: 'relative', display: 'inline-flex', flex: '0 0 auto' },
    }, [
      React.createElement('button', {
        key: 'btn',
        type: 'button',
        className: `wt-flag-btn${flagVisible ? '' : ' is-ghost'}`,
        'data-wt-priority-btn': 'true',
        'data-wt-ghost': flagVisible ? undefined : 'true',
        'aria-label': `${t('priorityLabel')}：${flagLabel}`,
        'aria-expanded': flagOpen,
        'aria-haspopup': 'true',
        title: `${t('priorityLabel')}：${flagLabel}`,
        style: { color: priorityColor(flagValue), opacity: flagOpacity },
        onClick: () => setFlagOpen((open) => !open),
        onKeyDown: (event) => { if (event?.key === 'Escape') setFlagOpen(false); },
      }, React.createElement(IconFlag, { filled: flagValue === 'high', dashed: flagValue === 'none' })),
      flagOpen ? React.createElement(PriorityFlagsPopover, {
        key: 'pop',
        t,
        value: flagValue,
        // 选中即收弹层 + 走面板统一的写路径（POST /worktodo/update {ref, priority}）。
        // 失败由面板顶部的错误条原样显示；成功后按现有 refresh() 机制重取列表，不整页刷新。
        onPick: (value) => {
          setFlagOpen(false);
          Promise.resolve(onPriority?.(row.id, value)).catch(() => { /* 已在错误条上显示 */ });
        },
        onClose: () => setFlagOpen(false),
      }) : null,
    ]),
    React.createElement('button', {
      key: 'check',
      type: 'button',
      className: `wt-check${done ? ' wt-check-done' : ''}${celebrating ? ' wt-check-celebrate' : ''}`,
      // 尺寸与可点区域：渲染出来的值与样式表取同一组常量（CHECK_SIZE_PX / CHECK_HIT_PX）
      'data-wt-check-size': CHECK_SIZE_PX,
      'data-wt-check-hit': CHECK_HIT_PX,
      'aria-label': done ? t('unmarkDone') : t('markDone'),
      title: done ? t('unmarkDone') : t('markDone'),
      onClick: handleCheck,
    }, done ? React.createElement(IconCheck, { key: 'i', className: 'wt-check-mark' }) : null),
    React.createElement('div', { key: 'main', style: { flex: 1, minWidth: 0 } }, [
      titleEditing
        ? React.createElement('input', {
          key: 'title',
          className: 'wt-title wt-title-input',
          'data-wt-title-input': 'true',
          value: titleDraft,
          autoFocus: true,
          'aria-label': t('editTitle'),
          title: t('editTitle'),
          // 自动聚焦后全选：点一下就能直接重写；键盘 Tab 进来同样成立
          onFocus: (event) => {
            try { event?.target?.select?.(); } catch { /* 测试替身/旧内核没有 select，忽略 */ }
          },
          onChange: (event) => setTitleDraft(String(event?.target?.value ?? '')),
          onKeyDown: (event) => {
            if (event?.key === 'Enter') {
              event.preventDefault?.();
              commitTitle();
            } else if (event?.key === 'Escape') {
              event.preventDefault?.();
              cancelTitle();
            }
          },
          // 失焦 = 保存（用 ref 去重：Enter 已提交过就不会再发一次）
          onBlur: commitTitle,
          style: {
            color: done ? C.label3 : C.label,
            textDecoration: done ? 'line-through' : 'none',
            fontWeight: row.priority === 'high' && !done ? 650 : 400,
          },
        })
        : React.createElement('button', {
          key: 'title',
          type: 'button',
          className: 'wt-title wt-title-btn',
          'data-wt-title-btn': 'true',
          'aria-label': t('editTitle'),
          title: t('editHint'),
          onClick: startTitleEdit,
          style: {
            color: done ? C.label3 : C.label,
            textDecoration: done ? 'line-through' : 'none',
            fontWeight: row.priority === 'high' && !done ? 650 : 400,
          },
        }, shownTitle || t('untitled')),
      titleError
        ? React.createElement('span', {
          key: 'title-error',
          className: 'wt-title-error',
          role: 'status',
        }, titleError)
        : null,
      meta.length
        ? React.createElement('div', {
          key: 'meta',
          style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 },
        }, meta)
        : null,
    ]),
    // 标题单击改成行内编辑之后，完整表单（备注 / 日期 / 优先级 / 项目）从这里进
    React.createElement('button', {
      key: 'details',
      type: 'button',
      className: 'wt-icon-btn',
      'data-wt-edit-details': 'true',
      title: t('editDetails'),
      'aria-label': t('editDetails'),
      onClick: beginEdit,
    }, React.createElement(IconPencil, { key: 'i' })),
    React.createElement('button', {
      key: 'del',
      type: 'button',
      className: confirming ? 'wt-btn wt-btn-danger' : 'wt-icon-btn wt-icon-btn-danger',
      title: confirming ? t('confirmDelete') : t('deleteBtn'),
      'aria-label': t('deleteBtn'),
      onClick: () => {
        if (!confirming) { setConfirming(true); return; }
        setConfirming(false);
        Promise.resolve(onRemove(row.id)).catch(() => { /* 已在错误条上显示 */ });
      },
    }, confirming ? t('confirmDelete') : React.createElement(IconTrash, { key: 'i' })),
  ]);
});

/* ------------------------------------------------------------------ *
 * 分组：空组整块不渲染，避免五个空标题堆在面板上
 * ------------------------------------------------------------------ */
function Group({ label, items, meta, closed, t, today, onToggleOpen, onToggleTodo, onRemove, onSave, onPriority, onDue, onTitle, onProject, projects, projectsTruncated, celebrate, drag }) {
  const list = asArray(items);
  if (!list.length) return null;
  return React.createElement('div', { style: { marginTop: 6 } }, [
    React.createElement('div', {
      key: 'head',
      className: 'wt-group-head',
      onClick: onToggleOpen,
      title: closed ? t('expand') : t('collapse'),
      role: 'button',
      'aria-expanded': !closed,
    }, [
      React.createElement(IconChevron, { key: 'c', open: !closed }),
      React.createElement('span', { key: 'l', style: { fontWeight: 600, fontSize: 12 } }, label),
      React.createElement('span', { key: 'n', style: { fontSize: 11, color: C.label3 } }, meta || String(list.length)),
      React.createElement('span', { key: 'sp', style: { flex: 1 } }),
      React.createElement('span', { key: 'h', style: { fontSize: 11, color: C.label3 } }, closed ? t('expand') : t('collapse')),
    ]),
    closed ? null : React.createElement('div', { key: 'body' }, list.map((todo, index) => React.createElement(TodoRow, {
      key: (todo && todo.id) || `row-${index}`,
      todo,
      today,
      t,
      onToggle: onToggleTodo,
      onRemove,
      onSave,
      onPriority,
      onDue,
      onTitle,
      onProject,
      projects,
      projectsTruncated,
      celebrate,
      // S3-3：共享同一个 drag 对象（引用稳定），每行只有布尔 dragging 不同 ——
      // 否则每一行每次父级重渲染都会收到一个新的 drag 对象，memo 的浅比较必然失效
      drag,
      dragging: Boolean(drag) && drag.dragId === todo?.id,
    }))),
  ]);
}

/* ------------------------------------------------------------------ *
 * 会话待办：提升为工作待办
 *
 * 官方会话 todos 只能通过 useProjection hook 拿到，而 hook 不能在组件里「有条件地调用」。
 * 所以这里拆成独立子组件：父组件只在 props.useProjection 确实是函数时才挂载它，
 * 一旦挂载，这一份实例里 hook 的调用次数就是恒定的 —— 不违反 hooks 规则。
 * 投影为空（这个会话没列过待办）时整块返回 null，面板上不会多出一行没用的按钮。
 * ------------------------------------------------------------------ */
function SessionAdopt({ useProjection, t, onAdopt, busy }) {
  let projected;
  try {
    projected = useProjection('todos');
  } catch {
    // 投影尚未就绪 / 宿主版本没有这个投影：当作没有会话待办
    projected = null;
  }
  // 投影可能是裸数组，也可能是 { todos: [...] } 包一层——两种形状都认
  const raw = Array.isArray(projected) ? projected : asArray(projected?.todos);
  const items = raw.map((item) => ({
    content: typeof item?.content === 'string' ? item.content
      : (typeof item?.title === 'string' ? item.title : ''),
    status: typeof item?.status === 'string' ? item.status : 'pending',
  })).filter((item) => item.content.trim());
  if (!items.length) return null;
  const openCount = items.filter((item) => item.status !== 'completed').length;

  return React.createElement('div', {
    style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  }, [
    React.createElement('button', {
      key: 'b',
      type: 'button',
      className: 'wt-btn wt-btn-primary',
      disabled: Boolean(busy),
      title: t('adoptHint'),
      onClick: () => { Promise.resolve(onAdopt(items)).catch(() => { /* 已在错误条上显示 */ }); },
    }, `${t('adoptPre')}${items.length}${t('adoptPost')}`),
    React.createElement('span', {
      key: 'h',
      title: t('adoptHint'),
      style: { fontSize: 11, color: C.label3 },
    }, `${t('adoptPending')} ${openCount}`),
  ]);
}

/* ------------------------------------------------------------------ *
 * 面板主体
 * ------------------------------------------------------------------ */
const GROUPS = [
  { key: 'overdue', label: 'groupOverdue' },
  { key: 'today', label: 'groupToday' },
  { key: 'week', label: 'groupWeek' },
  { key: 'later', label: 'groupLater' },
  { key: 'completed', label: 'groupCompleted' },
];

/**
 * 视图 → 需要向宿主索取的数据形状（S3-3 客户端侧）。
 *
 * 宿主 `/list` 支持 `shapes=todos|groups|projectGroups`，但面板原来**完全没用**：
 * 每次轮询都拿三份同样大小的数据（5000 条 = 4.28 MiB/次），而面板一次只用得上其中一份。
 *   - 「按截止」渲染 `groups`；
 *   - 「按项目」渲染 `projectGroups`；
 *   - `todos`（平铺顺序）只在没有分组时的兼容路径上用得到，见 payloadRecordIds()。
 * 缺省（不带 shapes）仍然合法 —— 这是宿主侧的兼容合同，别的地方照旧能用。
 */
export const VIEW_SHAPES = { due: 'groups', project: 'projectGroups' };

/** 某个视图需要哪一份形状（未知视图按默认的「按截止」处理）。 */
export function shapesForView(view) {
  return VIEW_SHAPES[view] ?? VIEW_SHAPES.due;
}

/**
 * 当前载荷里有这个视图渲染所需的形状吗？
 *
 * 切视图时会立刻按新形状重新请求，但数据要等一个 RTT 才到；这期间如果沿用旧载荷，
 * `groups`（或 `projectGroups`）缺失会被当成「一条都没有」而闪一下空列表。
 * 有数据但缺形状时按「还在加载」渲染，等新载荷落地。
 * @param {object|null} data
 * @param {string} view
 */
export function hasViewShape(data, view) {
  if (!data) return false;
  return shapesForView(view) === 'projectGroups'
    ? Array.isArray(data.projectGroups)
    : Boolean(data.groups && typeof data.groups === 'object');
}

/**
 * 从当前载荷里取出一份「完整且有序」的记录 id 列表 —— 拖拽重排用它算新顺序。
 *
 * 优先用 `todos`（真·全局顺序）；只取了分组形状时把当前视图的桶摊平：用户看到的就是
 * 这个顺序，桶内顺序由宿主按当前 sort 排好，所以拖拽结果与屏幕上看到的一致。
 * 只取了 `groups` 时不再为拖拽多发一次请求（拖拽是低频的用户动作，多一次全量拉并不划算）。
 * @param {object|null} data
 * @returns {string[]}
 */
export function payloadRecordIds(data) {
  const flat = asArray(data?.todos).map((todo) => todo?.id).filter(Boolean);
  if (flat.length) return flat;
  const merged = [];
  const groups = data?.groups;
  if (groups && typeof groups === 'object') {
    for (const group of GROUPS) merged.push(...asArray(groups[group.key]));
  }
  for (const bucket of asArray(data?.projectGroups)) merged.push(...asArray(bucket?.todos));
  return merged.map((todo) => todo?.id).filter(Boolean);
}

/** 极简占位符替换：`{name}` → vars[name]（面板文案的少量插值，不引第三方库）。 */
function fillTemplate(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

/**
 * 把 `describe()` 里的存储告警整理成面板上真的能看见的几行（复审 R4/R5）。
 *
 * `mismatch`（后端不一致）、`split`（两处数据不一致）、`backendError`（当前后端读写失败）
 * 是**必须让用户看见**的三条：它们意味着「你看到的可能不是全部数据」。
 * `retired`（回退文件已退役）与 `merge`（最近一次合并）正常情况下是信息性的，
 * 但有两种形态必须升级成 warn（复审 0.2.2 F1/F3）：
 *   - 已退役 **且** 官方存储不可用：面板此时看不到任何待办，这条告警是唯一的解释；
 *   - 退役改名失败（`retired.error`）：必须显示失败原因与处理建议，绝不能说「已迁移并退役」。
 *
 * @param {object} store `/list` 载荷里的 store（= 宿主的 describe()）
 * @param {(key: string) => string} t 文案函数
 * @returns {{key: string, tone: 'warn'|'info', text: string}[]}
 */
export function storeAlerts(store, t) {
  if (!store || typeof store !== 'object') return [];
  const alerts = [];
  const retired = store.retired;
  const retiredKnown = Boolean(retired?.path || retired?.movedTo);
  if (store.mismatch) alerts.push({ key: 'mismatch', tone: 'warn', text: `${t('storeMismatch')}：${store.mismatch}` });
  if (store.split) alerts.push({ key: 'split', tone: 'warn', text: `${t('storeSplit')}：${store.split}` });
  if (store.backendError) alerts.push({ key: 'backendError', tone: 'warn', text: `${t('storeError')}：${store.backendError}` });
  // 复审 0.2.2 F3：rename 失败时**只**能说「失败 + 原因 + 建议」，且原错误不能丢
  if (retired?.error) {
    alerts.push({
      key: 'retiredFailed',
      tone: 'warn',
      text: `${t('storeRetiredFailed')}：${retired.error}。`
        + fillTemplate(t('storeRetiredFailedHint'), { path: retired.path ?? '' }),
    });
  } else if (retired?.movedTo) {
    alerts.push({ key: 'retired', tone: 'info', text: `${t('storeRetired')}：${retired.movedTo}` });
  }
  // 复审 0.2.2 F1：退役 + 官方存储不可用 = 看不到待办；面板此时**只**剩下这条解释。
  // 放在最后，保证 `retiredUnavailable` 是这一组里最醒目的一行。
  const domainUnavailable = Boolean(retiredKnown
    && (typeof store.domainUnavailable === 'boolean' ? store.domainUnavailable : store.kind !== 'domain'));
  if (domainUnavailable) {
    const when = Number.isFinite(retired?.at) ? new Date(retired.at).toLocaleString() : '此前';
    const archive = retired.movedTo ?? retired.marker ?? retired.path ?? '';
    alerts.push({
      key: 'retiredUnavailable',
      tone: 'warn',
      text: `${t('storeRetiredUnavailable')}：${fillTemplate(t('storeRetiredUnavailableHint'), { when, archive })}`,
    });
  }
  const merge = store.merge;
  if (merge && Number.isFinite(merge.merged)) {
    if (merge.aborted) {
      // 合并中途失败并已回滚：这是必须让用户看见的失败，不是信息
      alerts.push({ key: 'mergeAborted', tone: 'warn', text: `${t('storeMergeAborted')}：${merge.writeError ?? ''}` });
    } else {
      alerts.push({
        key: 'merge',
        tone: 'info',
        text: fillTemplate(t('storeMergeNote'), {
          merged: merge.merged, conflicts: merge.conflicts ?? 0, added: merge.added ?? 0,
        }),
      });
    }
  }
  return alerts;
}

/**
 * 页脚「存储位置」那一行要显示什么。
 *
 * 复审 0.2.2 F1/F3：只要句柄知道回退文件已退役，就**不能**把那个路径当作存储位置显示
 * （它可能根本不存在）。此时数据在官方存储：
 *   - 官方后端可用 → 「官方 storage · 回退文件已迁移并退役 · 档案 <movedTo>」；
 *   - 官方后端不可用 → 额外写「不可用」，与 warn 告警互相印证。
 * 退役失败（文件还在原地）时只显示**确认存在**的哨兵路径，不显示那个半退役的原文件。
 * @param {object} store
 * @param {(key: string) => string} t
 * @returns {string|null}
 */
export function storeLocationLabel(store, t) {
  if (!store || typeof store !== 'object') return null;
  const retired = store.retired;
  const retiredKnown = Boolean(retired?.path || retired?.movedTo);
  if (retiredKnown) {
    const domainReady = typeof store.domainUnavailable === 'boolean'
      ? !store.domainUnavailable
      : store.kind === 'domain';
    const confirmed = retired.movedTo ?? retired.marker;
    const archive = confirmed ? ` · ${t('storeRetiredArchive')} ${confirmed}` : '';
    const state = domainReady ? t('storeDomain') : `${t('storeDomain')} · ${t('storeUnavailable')}`;
    return `${t('storeAt')} · ${state} · ${t('storeRetired')}${archive}`;
  }
  if (!store.location) return null;
  const kind = store.kind === 'domain' ? t('storeDomain') : t('storeFile');
  return `${t('storeAt')} · ${kind} · ${store.location}`;
}

/**
 * 页脚「版本」旁边那一格该显示什么 —— 纯函数（导出供单测），不碰 DOM、不用 innerHTML。
 *
 * 阶段与文案**照 DSH 桌面版更新器**（`DesktopUpdateIndicator.updateCopy`）的语义来：
 *   checking      → 正在检查更新…
 *   check-failed  → 「暂时无法检查更新，稍后自动重试」**温和态**（不是故障：不亮红、不暴露
 *                   原始错误串；下一次轮询会按宿主退避自动重试）
 *   available     → 「有新版本 vX · 下载」（可点：**下载**是第一步）
 *   downloading   → 「下载中 42%」（进度来自宿主，绝不在前端编造百分比）
 *   verifying     → 正在校验更新文件…
 *   downloaded    → 「安装并重启」（可点：第二步才动已安装的版本）
 *   installing    → 安装中…
 *   installed     → 「已安装 vX，请手动重启 DSH」（**不可点**：DSH 没给插件重启入口，不假装能重启）
 *                  …除非宿主报 restartSupported（用户配了 restartCommand），那时给「重启 DSH」按钮
 *   restarting    → 重启中…
 *   unsupported   → 预期内的不适用（本地链接安装 / 推不出 profile）：淡色提示、不亮红、不给重试
 *   failed        → 失败原因 + 重试（`linked` 换成「本地链接安装」的专门说明，那不是一个故障）
 *   旧载荷兼容    → 只有 state 没有 phase 时按老规则渲染（running→正在更新，done→已更新待重启）
 *
 * 为什么 restartRequired 必须排在 hasUpdate 前面：后台装好新版后，`hasUpdate`（latest vs
 * **运行版本**）仍然是 true —— 但此时用户不需要再下载一次，只需要重启。两个都显示会把
 * 「装好了」误报成「还没装」。
 *
 * @param {object|null} run 宿主 /worktodo/update 的状态（或 /list 载荷里的摘要）
 * @param {object|null} update /list 载荷里的 update 字段
 * @param {(key: string) => string} t 文案函数
 * @returns {{text: string, title: string, tone: 'ok'|'busy'|'warn'|'muted'|'error', action: 'download'|'install'|'restart'|'retry'|'update'|null, disabled: boolean, phase: string|null}|null}
 */
/**
 * 三档更新方式的单选项（顺序固定：off → manual → auto）。
 * 面板与测试共用这一份，避免文案 key 在 JSX 里散落。
 */
export const UPDATE_MODE_OPTIONS = Object.freeze([
  { value: 'off', labelKey: 'updateModeOff', hintKey: 'updateModeOffHint' },
  { value: 'manual', labelKey: 'updateModeManual', hintKey: 'updateModeManualHint' },
  { value: 'auto', labelKey: 'updateModeAuto', hintKey: 'updateModeAutoHint' },
]);

/**
 * 装好待重启的**顶部提示条**内容（纯函数，导出供单测）。
 *
 * 只认 `restartRequired`；`off` 时返回 null（面板在 off 下只显示当前版本）。
 * 版本号只取「已落盘/已安装」字段，绝不拿 latest 顶替；没有版本号时用无版本的兜底文案。
 * 不返回任何 action —— 面板**没有**「假重启按钮」（DSH 未给插件重启入口）。
 * @param {object|null} update /list 载荷里的 update
 * @param {(key: string) => string} t 文案函数
 * @returns {{text: string, title: string, version: string|null}|null}
 */
export function restartNotice(update, t) {
  if (!update?.restartRequired) return null;
  if (update?.updateMode === 'off') return null;
  const raw = update?.installedVersion ?? update?.installed ?? null;
  const version = raw ? String(raw) : null;
  const text = version
    ? t('updateRestartBanner').replace('{version}', `v${version}`)
    : t('updateRestartBannerNoVersion');
  return { text, title: t('updateRestartBannerHint'), version };
}

export function updateBadgeState(run, update, t) {
  const state = run?.state ?? 'idle';
  const phase = typeof run?.phase === 'string' ? run.phase : null;
  const percent = Number.isFinite(run?.percent) ? Math.max(0, Math.min(100, Math.floor(run.percent))) : null;
  const version = run?.version ?? run?.download?.version ?? update?.latest ?? null;
  const tag = version ? ` v${version}` : '';
  const restartSupported = update?.restartSupported === true || run?.restartSupported === true || run?.restart?.supported === true;
  /** @type {(text: string, title: string, tone: string, action: string|null, disabled: boolean, phase: string|null) => object} */
  const view = (text, title, tone, action, disabled, at) => ({ text, title, tone, action, disabled, phase: at ?? phase });

  // off：面板「只显示当前版本」—— 不显示任何新版本 / 检查失败 / 不适用徽标。
  // 唯一例外是用户已经点过、正在跑的下载/安装：进度不该被藏掉（那不是「提示」）。
  if ((update?.updateMode ?? run?.updateMode) === 'off' && !isUpdateBusy(run)) return null;

  /* ---- 1. 新的细粒度阶段（DSH 语义） ---- */
  if (phase === 'checking') {
    return view(t('updateChecking'), t('updateChecking'), 'busy', null, true);
  }
  if (phase === 'check-failed') {
    // 检查更新失败 ≠ 插件坏了：用最淡的「muted」状态，不亮红、不给重试按钮
    //（下一次自动轮询会自己重试，用户不需要做什么），也不展示 raw error。
    return view(t('updateCheckFailed'), t('updateCheckFailedHint'), 'muted', null, true);
  }
  if (phase === 'unsupported') {
    // 预期内的不适用（本地链接安装 / 推不出 profile）：不是失败。
    // 淡色小字、不亮红、不出现「失败」、不给重试；技术细节只留在宿主 diagnostics，绝不上屏。
    const unsupportedKind = run?.updateUnsupported ?? run?.reason ?? null;
    const key = unsupportedKind === 'link-install' ? 'updateUnsupportedLink' : 'updateUnsupportedProfile';
    return view(t(key), t(key), 'muted', null, true);
  }
  if (phase === 'downloading') {
    // 有 content-length 才报百分比；没有就只报「已收到多少字节」，不编造进度
    const text = percent === null
      ? t('updateDownloadingBytes').replace('{bytes}', formatBytes(run?.download?.bytes ?? 0))
      : t('updateDownloading').replace('{percent}', String(percent));
    return view(text, run?.download?.url ? String(run.download.url) : t('updateDownloading'), 'busy', null, true);
  }
  if (phase === 'verifying') {
    return view(t('updateVerifying'), t('updateVerifying'), 'busy', null, true);
  }
  if (phase === 'downloaded') {
    return view(
      `${t('updateDownloadedState').replace('{version}', version ? `v${version}` : '')} · ${t('updateInstallRestart')}`,
      t('updateInstallHint').replace('{version}', version ? `v${version}` : ''),
      'ok',
      'install',
      false,
    );
  }
  if (phase === 'installing') {
    return view(t('updateInstalling'), run?.command ? String(run.command) : t('updateInstalling'), 'busy', null, true);
  }
  if (phase === 'restarting') {
    return view(t('updateRestarting'), t('updateRestarting'), 'busy', null, true);
  }
  if (phase === 'installed') {
    const restarted = run?.restart?.ok === true;
    if (restartSupported && !restarted) {
      return view(`${t('updateRestart')}${tag}`, t('updateRestartHint2'), 'ok', 'restart', false);
    }
    // 诚实态：装好了，但重启只能由用户做（DSH 把重启锁在 Electron 主进程里）
    const reason = typeof run?.restart?.error === 'string' && run.restart.error ? run.restart.error : t('updateInstalledManualHint');
    return view(
      t('updateInstalledManual').replace('{version}', version ? `v${version}` : ''),
      reason,
      'ok',
      null,
      true,
    );
  }
  if (phase === 'failed') {
    return failureBadge(run, t, view);
  }

  /* ---- 2. 只有 state 的旧载荷（老宿主，或页面刚刷新还没拿到新字段） ---- */
  if (state === 'running') {
    const to = run?.to ? ` v${run.to}` : '';
    return view(`${t('updating')}${to}`, run?.command ? String(run.command) : t('updating'), 'busy', null, true);
  }
  if (update?.restartRequired) {
    // 落盘版本 > 运行版本：已经装好了，只差重启。版本号只认「落盘/已安装」字段，不拿 latest 顶替。
    const installed = update?.installedVersion ?? update?.installed;
    const versionText = installed ? `v${installed}` : '';
    // 新宿主会带上 restartSupported:false —— 那就用诚实文案；老宿主/缺字段时保持旧文案
    const manual = update?.restartSupported === false;
    return view(
      manual
        ? t('updateInstalledManual').replace('{version}', versionText)
        : (installed ? t('updatedRestart').replace('{version}', versionText) : t('updateRestartHint')),
      manual ? t('updateInstalledManualHint') : (versionText || t('updateRestartHint')),
      'ok',
      null,
      true,
      null,
    );
  }
  if (state === 'done') {
    const to = run?.to ?? update?.installedVersion ?? update?.installed ?? update?.latest;
    if (to) {
      return view(
        t('updateInstalledManual').replace('{version}', `v${to}`),
        t('updateInstalledManualHint'),
        'ok',
        null,
        true,
        null,
      );
    }
    return view(t('updateRestartHint'), t('updateRestartHint'), 'ok', null, true, null);
  }
  if (state === 'failed') {
    return failureBadge(run, t, view, null);
  }
  if (update?.hasUpdate) {
    return view(
      `${t('updateAvailable')} v${update.latest} · ${t('updateDownload')}`,
      t('updateHint'),
      'ok',
      'download',
      false,
      null,
    );
  }
  return null;
}

/**
 * 失败诊断的一行摘要（导出供单测）：**步骤 / 命令 / 退出码 / 版本 / 日志尾部**。
 *
 * 只拼宿主已经给的事实，不猜、不编。面板把它放在失败徽标下面的一行小字里，
 * 同时整段挂到 `title` 上（hover 可看全文）；用户报障时复制这段即可定位。
 * @param {object|null} run 宿主状态（含 diagnostics）
 * @param {(key: string) => string} t 文案函数
 * @returns {string}
 */
export function updateFailureDetail(run, t) {
  const diagnostics = run?.diagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') {
    const current = run?.from ? String(run.from) : null;
    const target = run?.to ?? run?.version ?? null;
    return current || target
      ? `${t('updateDetailVersion')}=${current ?? '?'}→${target ?? '?'}`
      : '';
  }
  const parts = [];
  if (diagnostics.step) parts.push(`${t('updateDetailStep')}=${diagnostics.step}`);
  if (diagnostics.command) parts.push(`${t('updateDetailCommand')}=${diagnostics.command}`);
  if (diagnostics.exitCode !== null && diagnostics.exitCode !== undefined) {
    parts.push(`${t('updateDetailExit')}=${diagnostics.exitCode}`);
  }
  if (diagnostics.spawnError) parts.push(`${t('updateDetailSpawn')}=${diagnostics.spawnError}`);
  if (diagnostics.currentVersion || diagnostics.target) {
    parts.push(`${t('updateDetailVersion')}=${diagnostics.currentVersion ?? '?'}→${diagnostics.target ?? '?'}`);
  }
  if (Array.isArray(diagnostics.logTail) && diagnostics.logTail.length) {
    parts.push(`${t('updateDetailLog')}=${diagnostics.logTail.slice(-3).join(' / ')}`);
  }
  return parts.join(' · ');
}

/**
 * 失败/不可用那一格。`linked` 不是故障（那是开发工作流），单独给说明且不给重试。
 * 重试按钮的动作由「失败发生在哪一步」决定：下载失败重试下载，安装失败重试安装。
 * @param {object|null} run 宿主状态
 * @param {(key: string) => string} t 文案
 * @param {Function} view 构造返回值
 * @param {string|null} [forcedPhase]
 */
function failureBadge(run, t, view, forcedPhase = undefined) {
  const reason = run?.reason;
  if (reason === 'linked' || run?.failure === 'linked') {
    return view(t('updateLinked'), t('updateLinked'), 'warn', null, true, forcedPhase);
  }
  const reasonText = String(run?.error ?? reason ?? '');
  const detail = updateFailureDetail(run, t);
  const downloadFailed = run?.failedOperation === 'download' || run?.failure === 'download' || run?.failure === 'download-network'
    || run?.failure === 'download-corrupt';
  // 失败要能重试：用户可能只是网络抖了一下；下载没完成时重试的是「下载」而不是「安装」
  const action = downloadFailed || !run?.download ? 'download' : 'retry';
  const title = [t('updateRetryHint'), reasonText, detail].filter(Boolean).join(' — ');
  const badge = view(
    `${downloadFailed ? t('updateDownloadFailed') : t('updateFailed')}：${reasonText}`,
    title,
    'error',
    action,
    false,
    forcedPhase,
  );
  // 小字行：完整诊断（footer 会截断显示，title 里始终是全文）
  badge.detail = detail;
  return badge;
}

/**
 * 这个阶段算不算「进行中」（需要轮询、按钮要禁用）。
 * 与 DSH 的 BUSY_PHASES 对齐，另外把老载荷的 `state:'running'` 也算进来。
 * @param {object|null} run 宿主状态
 * @returns {boolean}
 */
export function isUpdateBusy(run) {
  const phase = run?.phase;
  if (typeof phase === 'string') {
    return phase === 'checking' || phase === 'downloading' || phase === 'verifying'
      || phase === 'installing' || phase === 'restarting';
  }
  // 老载荷只有 state：running 就是忙
  return run?.state === 'running';
}

/** 人类可读的字节数（只用于「没有 content-length 时的已下载量」）。 */
function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function WorkTodoPanel(props) {
  // t 由 locale 服务通过 slot props 注入；拿不到时退回中文，至少不显示裸 key。
  // 兜底必须是模块级常量（FALLBACK_T）：每次渲染新建箭头函数会让 TodoRow 的 memo 永远失效。
  const t = typeof props?.t === 'function' ? props.t : FALLBACK_T;
  // 排序：manual（默认，尊重拖动）/ priority / created
  const [sort, setSortState] = React.useState(lastSort);
  const setSort = React.useCallback((next) => { lastSort = next; setSortState(next); }, []);
  const [dragId, setDragId] = React.useState(null);
  // 视图：按截止（默认）或按项目。必须在 useList 之前声明 —— 视图决定要请求哪种形状（S3-3）。
  const [view, setView] = React.useState('due');
  const shapes = shapesForView(view);
  const { status, data, error, refresh } = useList(sort, shapes);

  // 版本与自升级状态必须在**任何依赖它们的 hook 之前**解析：
  // hook 的依赖数组是在渲染期求值的，放到后面（早退分支之后）会踩 TDZ。
  const version = typeof data?.version === 'string' ? data.version : '';
  const update = data?.update ?? null;
  // 庆祝动效开关：宿主 config.celebrate 随 /list 载荷下发（缺省 = 开）
  const celebrate = shouldCelebrate(data?.panel);

  /**
   * 完成动效的「延迟刷新」调度器：勾选完成时先让 1.2s 的 CSS 动画播完，
   * 再拿服务端真相重排列表（旧实现写成功就 refresh，动画被当场切断）。
   * 卸载时整条 effect 的清理函数会把待刷新定时器取消，不留悬空回调。
   */
  const celebrationRefresh = React.useMemo(() => createCelebrationRefresh(refresh), [refresh]);
  React.useEffect(() => () => celebrationRefresh.cancel(), [celebrationRefresh]);

  /**
   * 跟随外部改动刷新（审计 F7：宿主的 onChanged/onChange 原来是死代码，面板只在
   * 挂载 / 切排序 / 点刷新 / 自己写操作后才拉数据，agent 用工具加了一条用户看不到）。
   * 这里定期 + 窗口重新聚焦 / 重新可见时拉一次；清理函数里清掉定时器与监听，卸载后不留活动引用。
   * 复审 R4：轮询已放宽到 CHANGE_POLL_MS（30s），「重新聚焦」那条路径负责补新鲜度。
   * S3-3（客户端侧）：窗口隐藏时**停轮询**（一次都不打宿主）；重新可见时立刻补一次。
   */
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (isWindowHidden()) return; // 后台/最小化的窗口不再每 30 秒白打一次宿主
      refresh();
    }, CHANGE_POLL_MS);
    timer?.unref?.(); // Node（测试环境）里不要因为这个定时器挂住事件循环
    const onActive = () => refresh();
    const onVisible = () => { if (!isWindowHidden()) refresh(); };
    window?.addEventListener?.('focus', onActive);
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window?.removeEventListener?.('focus', onActive);
      if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisible);
    };
  }, [refresh]);

  /**
   * 自升级的本地状态：点下「立即更新」后，到轮询结束前的状态由它渲染。
   * `null` 表示「跟随 /list 载荷里的 update.run」（例如刚刷新页面时宿主还在跑）。
   */
  const [updateRun, setUpdateRun] = React.useState(null);
  const run = updateRun ?? update?.run ?? null;
  const runState = run?.state ?? 'idle';
  // 页脚那一格要显示什么、可点做什么：纯函数决定（见 updateBadgeState），
  // 必须在这里算 —— 下面的点击处理要用它的 action 分派，晚于 handleUpdate 会撞 TDZ。
  const updateBadge = updateBadgeState(run, update, t);
  // 顶部重启提醒条（restartRequired 时才有；off 下不显示，也没有「假重启按钮」）。
  const restart = restartNotice(update, t);

  /**
   * 更新方式设置（三档小浮层）。
   *
   * `modeOverride` 是本地的乐观值：POST 成功先回显，随后 `refresh()` 用 /list 的
   * `update.updateMode` 校准；页面刷新后仍然以宿主为准（settings.json 已落盘）。
   */
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [modeOverride, setModeOverride] = React.useState(null);
  const [settingsPending, setSettingsPending] = React.useState(false);
  const [settingsError, setSettingsError] = React.useState(null);
  const settingsWrapRef = React.useRef(null);
  const updateMode = modeOverride ?? update?.updateMode ?? 'manual';
  const openSettings = React.useCallback(() => {
    const next = !settingsOpen;
    setSettingsOpen(next);
    setSettingsError(null);
    if (!next) return;
    // 打开时向宿主确认一次（多标签页/别处改过设置时以宿主为准）。
    fetch(`${ROUTE_BASE}/settings`, { cache: 'no-store', credentials: 'same-origin' })
      .then((response) => response.json())
      .then((parsed) => {
        const mode = parsed?.ok ? parsed?.data?.updateMode : null;
        if (mode) setModeOverride(mode);
      })
      .catch(() => { /* 读不到就先用 /list 里的值，不打断面板 */ });
  }, [settingsOpen]);
  const chooseMode = React.useCallback((next) => {
    if (next === updateMode || settingsPending) return Promise.resolve(false);
    setSettingsPending(true);
    setSettingsError(null);
    return postJson('/settings', { updateMode: next })
      .then((data) => {
        setModeOverride(data?.updateMode ?? next);
        refresh();
        return true;
      })
      .catch((error) => {
        setSettingsError(String(error?.message ?? error));
        return false;
      })
      .finally(() => setSettingsPending(false));
  }, [updateMode, settingsPending, refresh]);

  /**
   * 点击浮层外部收起浮层（入口在页脚，浮层向上弹，点面板别处/面板外都要关）。
   * 监听只在这档打开时存在，关掉立刻移除 —— 不在面板常驻 document 监听。
   * Escape 走浮层容器（.wt-settings-wrap）的 onKeyDown：焦点还在齿轮上时也收得到。
   */
  React.useEffect(() => {
    if (!settingsOpen) return undefined;
    const onPointerDown = (event) => {
      const wrap = settingsWrapRef.current;
      if (wrap && typeof wrap.contains === 'function' && event?.target && wrap.contains(event.target)) return;
      setSettingsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [settingsOpen]);

  /**
   * 升级进度轮询：**只在「进行中」时存在**（checking/downloading/verifying/installing/restarting，
   * 以及老载荷的 running），一离开就立刻停（依赖数组里就是这两个值）。
   * 常驻定时器会让「不打无用请求」这条约束作废，所以这里刻意不做成固定间隔的常驻 effect。
   */
  const busy = isUpdateBusy(run);
  React.useEffect(() => {
    if (!busy) return undefined;
    let alive = true;
    const timer = setInterval(() => {
      if (isWindowHidden()) return; // 后台窗口不轮询；重新可见时由 visibilitychange 补
      fetchUpdateRun()
        .then((next) => {
          if (!alive || !next) return;
          if (!isUpdateBusy(next)) {
            setUpdateRun(next);
            refresh(); // 下载/安装落盘后列表与版本信息要重取一次
          }
        })
        .catch(() => { /* 单次轮询失败不改状态，下一次再试；后台动作不受影响 */ });
    }, UPDATE_POLL_MS);
    timer?.unref?.(); // Node（测试环境）里不要因为这个定时器挂住事件循环
    return () => { alive = false; clearInterval(timer); };
  }, [busy, refresh]);

  // 写操作的错误条；readError 是拉取错误（用户关掉之后，只有换成新错误才再弹）
  const [barError, setBarError] = React.useState(null);
  const [dismissedReadError, setDismissedReadError] = React.useState(null);
  const readError = error && error !== dismissedReadError ? error : null;
  const shownError = barError ?? readError;

  const [notice, setNotice] = React.useState(null);
  const [pending, setPending] = React.useState(0);
  // 「已完成」默认折叠（做完的事不用占满屏幕），其余默认展开
  const [closed, setClosed] = React.useState({ completed: true });
  /**
   * 已知项目清单：QuickAdd 与行内项目浮层共用。
   * 必须**引用稳定**（只在 data 变了才重建），否则每一行的 React.memo 浅比较都会失效。
   */
  const projectOptions = React.useMemo(
    () => asArray(data?.projects).map((name) => (typeof name === 'string' ? name.trim() : '')).filter(Boolean),
    [data],
  );

  /**
   * 所有写操作的统一外壳：成功清掉错误条，失败把宿主的 error 原文放上去，
   * 无论成败最后都重新拉一次列表（避免本地状态和磁盘上的真相对不上）。
   *
   * `options.deferRefreshMs`：完成类动画专用 —— 写成功后**不立刻** refresh，
   * 而是交给 celebrationRefresh 在动画播完后补一次，期间行留在原位把动画播完。
   * 失败 / 取消完成 / 其他写操作仍然立即 refresh（reduced-motion、celebrate:false 也走这条）。
   * `options.quietError`：不把原始异常贴到顶部错误条（行内日期用它显示一句温和提示），
   * 避免把 `HTTP 500` / `Error: …` 这类原始串直接丢给用户。
   * @param {() => Promise<object>} job
   * @param {{deferRefreshMs?: number, quietError?: boolean}} [options]
   * @returns {Promise<{ok: boolean, data: object}>} data 是宿主返回的 data（失败时为空对象）
   */
  const runWrite = React.useCallback(async (job, options = {}) => {
    const deferMs = Number(options?.deferRefreshMs);
    const wantsDeferredRefresh = Number.isFinite(deferMs) && deferMs > 0;
    // 任何一次新写入都先取消上一段待刷新：连续点击/连续完成时由最后一次接管，
    // 绝不让上一个已取消的操作在 1.2s 后再补一次刷新。
    celebrationRefresh.cancel();
    setPending((n) => n + 1);
    let writeFailed = false;
    try {
      const data = await job();
      setBarError(null);
      return { ok: true, data: data ?? {} };
    } catch (writeError) {
      writeFailed = true;
      // 行内日期走 quietError：原样报错留给静默路径，用户只看到行内那句温和提示
      if (options?.quietError !== true) setBarError(String(writeError?.message ?? writeError));
      // 写失败：取消完成动画的待刷新，立刻拿服务端真相（行不该停在假完成态）
      celebrationRefresh.cancel();
      return { ok: false, data: {} };
    } finally {
      setPending((n) => Math.max(0, n - 1));
      if (wantsDeferredRefresh && !writeFailed) {
        celebrationRefresh.schedule(deferMs);
      } else {
        celebrationRefresh.cancel();
        refresh();
      }
    }
  }, [refresh, celebrationRefresh]);

  /**
   * 自升级的**两步**动作（照 DSH 的交互）：
   *   download → 只下载（带进度），不动已安装的版本；
   *   install  → 安装并重启（宿主会先复核「下载物」，没下完直接拒绝）；
   *   restart  → 装好了但重启没成功时的重试；
   *   retry    → 按失败发生在哪一步回到那一步（下载失败重试下载，安装失败重试安装）。
   *
   * 刻意**不走 runWrite**：升级不是待办写操作，失败原因（尤其 `linked`）要留在页脚那一格，
   * 而不是弹到面板顶部的写错误条上。
   */
  const [updatePending, setUpdatePending] = React.useState(false);
  const postUpdateAction = React.useCallback((action) => {
    setUpdatePending(true);
    return postJson('/update', { action })
      .then((next) => {
        // 宿主可能同步就给结论（linked / not-downloaded / restart-unavailable），也可能给 running
        if (next && typeof next === 'object' && (next.phase || next.state)) setUpdateRun(next);
        refresh();
        return true;
      })
      .catch((updateError) => {
        setUpdateRun((previous) => ({
          ...(previous ?? {}),
          state: 'failed',
          phase: 'failed',
          failure: null,
          failedOperation: previous?.failedOperation ?? null,
          error: String(updateError?.message ?? updateError),
        }));
        return false;
      })
      .finally(() => setUpdatePending(false));
  }, [refresh]);

  const handleUpdate = React.useCallback(() => {
    if (busy || updatePending) return Promise.resolve(false);
    const action = updateBadge?.action ?? null;
    if (action === 'download') return postUpdateAction('plugin-update-download');
    if (action === 'install') return postUpdateAction('plugin-update-install');
    if (action === 'restart') return postUpdateAction('plugin-update-restart');
    if (action === 'retry') {
      // 下载没完成（或下载物坏了）时，重试必须回到「下载」，不能直接点安装
      const needsDownload = !run?.download || run?.failedOperation === 'download' || run?.failure === 'download-corrupt';
      return postUpdateAction(needsDownload ? 'plugin-update-download' : 'plugin-update-install');
    }
    // 兜底：老语义「立即更新」（宿主一次完成下载+安装）
    return postUpdateAction('plugin-update');
  }, [busy, updatePending, updateBadge?.action, run?.download, run?.failedOperation, run?.failure, postUpdateAction]);

  const handleAdd = React.useCallback((input) => {
    const title = String(input?.title ?? '').trim();
    // 空标题先在本地拦下：这条文案要走 t()，而宿主的报错是中文的，两个都显示会更乱
    if (!title) {
      setBarError(t('titleEmpty'));
      return Promise.resolve(false);
    }
    return runWrite(() => postJson('/create', {
      title,
      due: input?.due ? String(input.due) : null,
      // 必须一起发：QuickAdd 已经把「下午3点」这类时间词从标题里摘掉了，
      // 这里漏掉就等于用户输入的时间被永久丢弃（审计 F5）。空值统一给 null，别给 undefined。
      dueTime: input?.dueTime ? String(input.dueTime) : null,
      priority: input?.priority ?? 'normal',
      // 项目：来自 QuickAdd 的项目选择器。空值同样必须显式 null——
      // 宿主对请求体做无损 JSON 校验，undefined 会变成「没有这个键」甚至整次调用被拒。
      project: input?.project ? String(input.project).trim() : null,
    })).then((result) => result.ok);
  }, [runWrite, t]);

  /**
   * 勾选完成：行内说「这次要播动效」时，刷新推迟到动画播完（见 createCelebrationRefresh）；
   * 取消完成 / reduced-motion / celebrate:false 不推迟，立刻刷新让状态直接切换。
   */
  const handleToggle = React.useCallback((ref, options = {}) => runWrite(
    () => postJson('/status', { ref, toggle: true }),
    options?.celebrate ? { deferRefreshMs: CELEBRATE_REFRESH_MS } : undefined,
  ), [runWrite]);
  const handleRemove = React.useCallback((ref) => runWrite(() => postJson('/remove', { ref })), [runWrite]);
  const handleSave = React.useCallback((ref, patch) => runWrite(() => postJson('/update', { ref, ...patch })), [runWrite]);
  /**
   * 行内旗子选了某一档：走同一个写路径（POST /worktodo/update，body 就是 {ref, priority}）。
   * 必须是稳定引用（useCallback），否则每一行的 React.memo 浅比较都会失效。
   * `none` 是**真实档位**（不设优先级），宿主 patchRecord 已支持，不需要额外协议。
   */
  const handlePriority = React.useCallback((ref, priority) => runWrite(() => postJson('/update', { ref, priority })), [runWrite]);
  /**
   * 行内日期改动：走同一个写路径，body 形如 `{ref, due}` / `{ref, due, dueTime}` / `{ref, due:null}`。
   * 失败时**不贴原始异常**（quietError）—— 行组件已回滚乐观值，并在行内显示一句温和提示。
   */
  const handleDue = React.useCallback((ref, patch) => runWrite(
    () => postJson('/update', { ref, ...patch }),
    { quietError: true },
  ), [runWrite]);
  /**
   * 行内标题：`POST /worktodo/update {ref, title}`。
   * 与日期同一套温和失败路径：不贴原始异常，行组件负责回滚并显示行内提示。
   */
  const handleTitle = React.useCallback((ref, title) => runWrite(
    () => postJson('/update', { ref, title }),
    { quietError: true },
  ), [runWrite]);
  /**
   * 行内项目：`POST /worktodo/update {ref, project}`；清除时显式发 null。
   * 同样走 quietError —— 失败由行内回滚 + 温和提示收口。
   */
  const handleProject = React.useCallback((ref, project) => runWrite(
    () => postJson('/update', { ref, project: project ?? null }),
    { quietError: true },
  ), [runWrite]);

  /** 把 dragId 挪到目标之前，得到新的完整顺序并落盘（manual 模式生效） */

  const handleDropOn = React.useCallback((targetId) => {

    const dragging = dragId;

    setDragId(null);

    if (!dragging || !targetId || dragging === targetId) return Promise.resolve(false);

    // S3-3：面板现在只取当前视图需要的形状（按截止=groups、按项目=projectGroups），
    // 载荷里不一定有 todos —— 从当前视图的桶摊平出完整顺序（见 payloadRecordIds）。
    const ids = payloadRecordIds(data);

    const from = ids.indexOf(dragging);

    if (from === -1) return Promise.resolve(false);

    ids.splice(from, 1);

    const to = ids.indexOf(targetId);

    ids.splice(to === -1 ? ids.length : to, 0, dragging);

    return runWrite(() => postJson('/reorder', { ids })).then((result) => result.ok);

  }, [dragId, data, runWrite]);

  

  const dragHandlers = React.useMemo(() => ({

    dragId,

    hint: t('dragHint'),

    onStart: (id) => {

      setDragId(id);

      // 拖了就说明想自己定顺序：自动切到手动，否则松手后看起来「没生效」

      if (sort !== 'manual') setSort('manual');

    },

    onOver: () => {},

    onDrop: (id) => handleDropOn(id),

    onEnd: () => setDragId(null),

  }), [dragId, sort, t, setSort, handleDropOn]);

  

  const handleAdopt = React.useCallback((sessionTodos) => runWrite(() => postJson('/adopt', { todos: sessionTodos }))
    .then((result) => {
      // runWrite 已经刷新过列表，这里补一句「提升了几条、跳过几条」的回执，否则点完像没反应
      if (result.ok) {
        const created = Array.isArray(result.data?.created) ? result.data.created.length : 0;
        const skipped = Number.isFinite(Number(result.data?.skipped)) ? Number(result.data.skipped) : 0;
        setNotice(`${t('adoptDone')} ${created} · ${t('adoptSkipped')} ${skipped}`);
      }
      return result.ok;
    }), [runWrite, t]);

  // hooks 规则：这里只是取用，不调用。真正的调用在 SessionAdopt 里（按条件挂载整个子组件）
  const useProjection = typeof props?.useProjection === 'function' ? props.useProjection : undefined;

  const rootStyle = {
    height: '100%', overflow: 'auto', padding: '16px 18px 40px', boxSizing: 'border-box',
    color: C.label, fontFamily: 'var(--dsw-font-family, system-ui, sans-serif)', fontSize: 13,
  };

  if (status === 'loading' && !data) {
    return React.createElement('div', {
      className: 'wt-root',
      style: { ...rootStyle, display: 'flex', alignItems: 'center', gap: 8, color: C.label3, padding: 28 },
    }, [
      React.createElement('style', { key: 'css' }, STYLE_TEXT),
      React.createElement('span', { key: 'sp', className: 'wt-spin' }),
      React.createElement('span', { key: 't' }, t('loading')),
    ]);
  }

  if (status === 'failed' && !data) {
    return React.createElement('div', {
      className: 'wt-root',
      style: { ...rootStyle, padding: 28, color: C.error },
    }, [
      React.createElement('style', { key: 'css' }, STYLE_TEXT),
      React.createElement('div', { key: 'm' }, `${t('failed')}：${error ?? ''}`),
      React.createElement('button', {
        key: 'r', type: 'button', className: 'wt-btn', style: { marginTop: 10 }, onClick: refresh,
      }, t('retry')),
    ]);
  }

  // S3-3：切视图会按新形状立刻重新请求，但新载荷要等一个 RTT。这期间若沿用旧载荷，
  // 缺少的形状会被当成「一条都没有」而闪一下空列表；按「还在加载」渲染，等数据落地。
  if (data && !hasViewShape(data, view)) {
    return React.createElement('div', {
      className: 'wt-root',
      style: { ...rootStyle, display: 'flex', alignItems: 'center', gap: 8, color: C.label3, padding: 28 },
    }, [
      React.createElement('style', { key: 'css' }, STYLE_TEXT),
      React.createElement('span', { key: 'sp', className: 'wt-spin' }),
      React.createElement('span', { key: 't' }, t('loading')),
    ]);
  }

  const groups = data?.groups ?? {};
  const stats = data?.stats ?? {};
  const today = typeof data?.today === 'string' && data.today ? data.today : localToday();
  const store = data?.store ?? null;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const overdueCount = num(stats.overdue);
  // 视图分桶：按截止（原有 GROUPS）或按项目（宿主给的 projectGroups，附 未完成/总数/逾期）
  const projectGroups = asArray(data?.projectGroups);
  const viewGroups = view === 'project'
    ? projectGroups.map((bucket) => ({
      key: `p:${bucket?.key ?? ''}`,
      label: bucket?.project ? String(bucket.project) : t('noProject'),
      meta: `${num(bucket?.open)}/${num(bucket?.total)}${num(bucket?.overdue) ? ` · ${t('statOverdue')} ${num(bucket.overdue)}` : ''}`,
      items: bucket?.todos,
    }))
    : GROUPS.map((group) => ({ key: group.key, label: t(group.label), items: groups[group.key] }));
  const totalVisible = viewGroups.reduce((sum, group) => sum + asArray(group.items).length, 0);

  const chips = [
    { key: 'open', label: t('statOpen'), value: num(stats.open) },
    { key: 'overdue', label: t('statOverdue'), value: overdueCount, alert: overdueCount > 0 },
    { key: 'today', label: t('statToday'), value: num(stats.today) },
    { key: 'doing', label: t('statDoing'), value: num(stats.doing) },
    { key: 'done', label: t('statDoneToday'), value: num(stats.completedToday) },
  ];

  /**
   * 页脚「更新设置」入口（版本号右侧的齿轮）+ 向上弹的小浮层。
   *
   * 位置：页脚「版本 vX」那一行的版本号右侧，同一行、间距 6px、垂直居中；
   * 行为与版本信息放在一起（设置本来就属于「这一版怎么更新」，不占头部主区）。
   * 无障碍：齿轮是真按钮（title + aria-label 中英随语言）、浮层是 role=dialog、
   * 三档是 role=radio + aria-checked；全部键盘可达（原生 button），Escape 收起
   *（keydown 挂在整个入口容器上，所以焦点还在齿轮时也能关）。
   * 只用文本节点（没有 innerHTML）；没有新增动效（prefers-reduced-motion 无需额外分支）。
   */
  const settingsNode = React.createElement('span', {
    key: 'settings',
    className: 'wt-settings-wrap',
    ref: settingsWrapRef,
    onKeyDown: (event) => {
      if (event?.key === 'Escape' && settingsOpen) {
        event.preventDefault?.();
        setSettingsOpen(false);
      }
    },
  }, [
    React.createElement('button', {
      key: 'gear',
      type: 'button',
      className: 'wt-icon-btn wt-settings-btn',
      title: t('updateSettings'),
      'aria-label': t('updateSettings'),
      'aria-haspopup': 'dialog',
      'aria-expanded': settingsOpen,
      disabled: settingsPending,
      onClick: openSettings,
    }, React.createElement(IconSettings, { key: 'i' })),
    settingsOpen
      ? React.createElement('div', {
        key: 'pop',
        className: 'wt-settings-pop',
        role: 'dialog',
        'aria-label': t('updateSettingsTitle'),
      }, [
        React.createElement('div', { key: 't', className: 'wt-settings-pop-title' }, t('updateSettingsTitle')),
        React.createElement('div', { key: 'h', className: 'wt-settings-pop-hint' }, t('updateSettingsHint')),
        React.createElement('div', {
          key: 'g',
          className: 'wt-settings-group',
          role: 'radiogroup',
          'aria-label': t('updateModeLabel'),
        }, UPDATE_MODE_OPTIONS.map((option) => React.createElement('button', {
          key: option.value,
          type: 'button',
          role: 'radio',
          'aria-checked': updateMode === option.value,
          className: `wt-settings-option${updateMode === option.value ? ' is-on' : ''}`,
          title: t(option.hintKey),
          disabled: settingsPending,
          onClick: () => chooseMode(option.value),
        }, [
          React.createElement('span', { key: 'l', className: 'wt-settings-option-label' }, [
            React.createElement('span', { key: 'r', className: 'wt-settings-radio', 'aria-hidden': 'true' }),
            t(option.labelKey),
          ]),
          React.createElement('span', { key: 'h', className: 'wt-settings-option-hint' }, t(option.hintKey)),
        ]))),
        React.createElement('div', { key: 'f', className: 'wt-settings-foot' }, [
          React.createElement('span', { key: 'v', title: t('versionHint') }, t('updateSettingsCurrentVersion')
            .replace('{version}', version ? `v${version}` : '—')),
          React.createElement('span', { key: 'sp', style: { flex: 1 } }),
          React.createElement('button', {
            key: 'check',
            type: 'button',
            className: 'wt-btn',
            disabled: updateMode === 'off' || busy || updatePending || settingsPending,
            title: updateMode === 'off' ? t('updateCheckDisabledOff') : t('updateCheckNowHint'),
            onClick: () => postUpdateAction('plugin-update-check'),
          }, settingsPending ? t('updateSettingsSaving') : t('updateCheckNow')),
        ]),
        updateMode === 'off'
          ? React.createElement('div', { key: 'off', className: 'wt-settings-pop-hint' }, t('updateCheckDisabledOff'))
          : null,
        settingsError
          ? React.createElement('div', { key: 'err', className: 'wt-settings-error', role: 'alert' },
            `${t('updateSettingsFailed')}：${settingsError}`)
          : null,
      ])
      : null,
  ]);

  return React.createElement('div', { className: 'wt-root', style: rootStyle }, [
    React.createElement('style', { key: 'css' }, STYLE_TEXT),

    /* 顶部重启提醒：装好待重启时醒目但不打扰；没有假重启按钮 */
    restart
      ? React.createElement('div', {
        key: 'restart',
        className: 'wt-restart-banner',
        role: 'status',
        'aria-live': 'polite',
        title: restart.title,
      }, [
        React.createElement('span', { key: 'm', className: 'wt-restart-banner-mark', 'aria-hidden': 'true' }, '↑'),
        React.createElement('span', { key: 't', className: 'wt-restart-banner-text' }, restart.text),
      ])
      : null,

    /* 顶部：标题 + 统计 + 刷新（更新设置入口已移到页脚版本号旁边） */
    React.createElement('div', {
      key: 'head',
      className: 'wt-head',
      style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
    }, [
      React.createElement('div', { key: 'ti', style: { fontWeight: 700, fontSize: 15 } }, t('title')),
      ...chips.map((chip) => React.createElement('span', {
        key: chip.key,
        className: 'wt-chip',
        style: chip.alert
          ? { color: C.warn, borderColor: tint(C.warn, 50), background: tint(C.warn, 12) }
          : undefined,
      }, [
        React.createElement('span', { key: 'l', style: { color: C.label3 } }, chip.label),
        React.createElement('b', { key: 'v', style: { fontWeight: 650 } }, String(chip.value)),
      ])),
      React.createElement('span', { key: 'sort', className: 'wt-seg', title: t('sortLabel') }, [
        ...['manual', 'priority', 'created'].map((mode) => React.createElement('button', {
          key: mode,
          type: 'button',
          className: `wt-seg-btn${sort === mode ? ' is-on' : ''}`,
          title: mode === 'manual' ? t('dragHint') : `${t('sortLabel')}：${t(`sort${mode === 'manual' ? 'Manual' : mode === 'priority' ? 'Priority' : 'Created'}`)}`,
          onClick: () => setSort(mode),
        }, t(`sort${mode === 'manual' ? 'Manual' : mode === 'priority' ? 'Priority' : 'Created'}`))),
      ]),
      React.createElement('span', { key: 'view', className: 'wt-seg' }, [
        React.createElement('button', {
          key: 'due',
          type: 'button',
          className: `wt-seg-btn${view === 'due' ? ' is-on' : ''}`,
          title: t('viewDue'),
          onClick: () => setView('due'),
        }, t('viewDue')),
        React.createElement('button', {
          key: 'proj',
          type: 'button',
          className: `wt-seg-btn${view === 'project' ? ' is-on' : ''}`,
          title: t('viewProject'),
          onClick: () => setView('project'),
        }, t('viewProject')),
      ]),
      React.createElement('span', { key: 'sp', style: { flex: 1 } }),
      React.createElement('button', {
        key: 'rf',
        type: 'button',
        className: 'wt-btn',
        disabled: status === 'loading' || pending > 0,
        title: t('refresh'),
        onClick: refresh,
      }, [
        React.createElement(IconRefresh, { key: 'i' }),
        t('refresh'),
      ]),
    ]),

    /* 错误条：宿主的 error 原文照贴，绝不吞掉 */
    shownError
      ? React.createElement('div', {
        key: 'err',
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10, padding: '6px 9px',
          borderRadius: 8, border: `1px solid ${tint(C.error, 45)}`, background: tint(C.error, 12),
          color: C.error, fontSize: 12, lineHeight: 1.6,
        },
      }, [
        React.createElement('span', {
          key: 'm',
          style: { flex: 1, minWidth: 0, wordBreak: 'break-word' },
        }, `${t('failed')}：${shownError}`),
        React.createElement('button', {
          key: 'x',
          type: 'button',
          className: 'wt-icon-btn',
          style: { width: 18, height: 18, color: C.error },
          title: t('dismiss'),
          'aria-label': t('dismiss'),
          onClick: () => { setBarError(null); setDismissedReadError(error ?? null); },
        }, React.createElement(IconClose, { key: 'i' })),
      ])
      : null,

    /* 提升结果提示：点完按钮要有个回执 */
    notice
      ? React.createElement('div', {
        key: 'notice',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '5px 9px',
          borderRadius: 8, border: `1px solid ${tint(C.ok, 40)}`, background: tint(C.ok, 10),
          color: C.label2, fontSize: 11.5,
        },
      }, [
        React.createElement('span', { key: 'm', style: { flex: 1 } }, notice),
        React.createElement('span', {
          key: 'x', className: 'wt-link', onClick: () => setNotice(null),
        }, t('dismiss')),
      ])
      : null,

    /* 会话待办：只在拿得到 useProjection 时挂载（见 SessionAdopt 的说明） */
    useProjection
      ? React.createElement(SessionAdopt, {
        key: 'adopt',
        useProjection,
        t,
        busy: pending > 0,
        onAdopt: handleAdopt,
      })
      : null,

    React.createElement(QuickAdd, {
      key: 'quick',
      t,
      busy: pending > 0,
      onAdd: handleAdd,
      // 已知项目：宿主 /list 的 projects 在**任何 shapes 下都有**（见 service.list），
      // 所以面板无论停在「按截止」还是「按项目」，选择器都能列出已有项目。
      projects: projectOptions,
      projectsTruncated: Boolean(data?.projectsTruncated),
    }),

    /* 分组列表 */
    totalVisible
      ? React.createElement('div', { key: 'groups' }, viewGroups.map((group) => React.createElement(Group, {
        key: group.key,
        label: group.label,
        meta: group.meta,
        items: group.items,
        closed: Boolean(closed[group.key]),
        t,
        today,
        onToggleOpen: () => setClosed((prev) => ({ ...prev, [group.key]: !prev[group.key] })),
        onToggleTodo: handleToggle,
        onRemove: handleRemove,
        onSave: handleSave,
        onPriority: handlePriority,
        onDue: handleDue,
        onTitle: handleTitle,
        onProject: handleProject,
        projects: projectOptions,
        projectsTruncated: Boolean(data?.projectsTruncated),
        celebrate,
        drag: dragHandlers,
      })))
      : React.createElement('div', {
        key: 'empty',
        style: { padding: '22px 12px', textAlign: 'center', color: C.label3 },
      }, [
        React.createElement('div', { key: 'a', style: { fontSize: 13, color: C.label2 } }, t('empty')),
        React.createElement('div', { key: 'b', style: { fontSize: 11.5, marginTop: 4 } }, t('emptyHint')),
      ]),

    /* 底部：数据到底存在哪（排查「我的待办不见了」时第一眼要看的东西） */
    React.createElement('div', {
      key: 'foot',
      className: 'wt-foot',
      style: { marginTop: 14, paddingTop: 8, borderTop: `1px solid ${C.border1}`, fontSize: 10.5, color: C.label3, lineHeight: 1.7 },
    }, [
      /* 角落信息：装了哪一版 + 更新设置齿轮 + 有没有新版（一眼可见，不占主区）。
         齿轮紧挨版本号右侧（同一行、gap 6px、垂直居中）：设置是「这一版怎么更新」的一部分。 */
      React.createElement('div', {
        key: 'ver',
        className: 'wt-ver-row',
      }, [
        React.createElement('span', {
          key: 'v',
          title: t('versionHint'),
          style: { color: C.label3 },
        }, `${t('versionLabel')} ${version ? `v${version}` : '—'}`),
        settingsNode,
        updateBadge
          ? (updateBadge.action
            /* 只有真的能做点什么时才渲染 <button>；纯状态（下载中/安装中/已装好待重启/失败但不可重试）
               用 <span>，避免读屏与键盘用户撞上一个「点了没反应」的按钮。 */
            ? React.createElement('button', {
              key: 'u',
              type: 'button',
              className: 'wt-chip wt-update',
              // 无障碍：按钮的可读名就是当前那一格在说什么（下载/安装并重启/重启/重试）
              'aria-label': updateBadge.text,
              // 下载/安装进行中、或面板还有写操作在飞时不可点，避免连点出第二次下载/第二个子进程
              disabled: updateBadge.disabled || updatePending || busy || pending > 0,
              onClick: handleUpdate,
              title: updateBadge.title,
              style: { fontSize: 10, ...UPDATE_TONE_STYLE[updateBadge.tone] },
            }, updateBadge.text)
            : React.createElement('span', {
              key: 'u',
              className: 'wt-chip wt-update is-state',
              // 下载中报成 progressbar（读屏能听到 42%），其余进行中/终态是普通 status
              ...(updateBadge.phase === 'downloading' && Number.isFinite(run?.percent)
                ? { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.floor(run.percent) }
                : { role: 'status' }),
              'aria-label': updateBadge.text,
              'aria-live': 'polite',
              title: updateBadge.title,
              style: { fontSize: 10, ...UPDATE_TONE_STYLE[updateBadge.tone] },
            }, updateBadge.text))
          : null,
      ]),
      /* 失败详情：一行小字（完整内容在 title 里，可 hover 查看；只用文本节点，绝不拼 HTML）。
         内容全部来自宿主 diagnostics：步骤 / 命令 / 退出码 / 目标与当前版本 / 日志尾部。 */
      updateBadge?.detail
        ? React.createElement('div', {
          key: 'udetail',
          className: 'wt-update-detail',
          title: updateBadge.detail,
          style: { color: C.label3, wordBreak: 'break-word', marginBottom: 2 },
        }, `${t('updateFailureDetail')} · ${String(updateBadge.detail).length > 240
          ? `${String(updateBadge.detail).slice(0, 240)}…`
          : updateBadge.detail}`)
        : null,
      storeLocationLabel(store, t)
        ? React.createElement('div', {
          key: 'store',
          title: storeLocationLabel(store, t),
          style: { wordBreak: 'break-all' },
        }, storeLocationLabel(store, t))
        : null,
      /* 复审 R4/R5：describe() 里的告警必须在面板上**看得见**，不能只躺在 /health 的 JSON 里 */
      ...storeAlerts(store, t).map((alert) => React.createElement('div', {
        key: `alert-${alert.key}`,
        className: `wt-store-alert wt-store-alert-${alert.tone}`,
        title: alert.text,
        style: alert.tone === 'warn'
          ? { color: C.warn, wordBreak: 'break-word' }
          : { color: C.label3, wordBreak: 'break-word' },
      }, alert.text)),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * 插件体
 * ------------------------------------------------------------------ */
export const inject = ['slots', 'locale'];

/**
 * 幂等注册（S6-2）。
 *
 * 官方 `slots.register` / `locale.register` 对重复注册是**抛错**而不是幂等
 *（`single slot "…" already has a registration` / `locale namespace "…" already has locale "…"`）。
 * 而客户端 `apply()` 里这两处原来都没有兜底：同一 ctx 上第二次 apply（或与别的插件撞了 slot id）
 * 会一路抛到客户端 apply → **面板整体消失**，用户只能刷新页面。
 * 这里把「注册失败」降级成「丢这一条 + 控制台一行 warn」：面板的主入口（main slot）继续注册，
 * 最坏情况只是少了侧栏入口或某个语言字典 —— 绝不整块挂不上。
 *
 * 与宿主半侧同一条策略：`lib/index.js` 的路由注册（S1-1）与工具注册都是「单条失败只降级」。
 * @param {string} label 给日志用的一句话
 * @param {() => any} run
 * @returns {any} 注册结果（失败时给一个空 disposer）
 */
function safeRegister(label, run) {
  try {
    return run();
  } catch (error) {
    // 不吞错：原始原因照原样打出来（排查「面板为什么没出现」时第一眼要看这个）
    console.warn(`[${SHORT_NAME}] ${label}失败（跳过这一条，其余照常）：${error?.message ?? error}`);
    return () => {};
  }
}

export function apply(ctx) {
  ctx.effect(
    () => safeRegister('locale 字典注册', () => ctx.locale.register(LOCALE_NS, { zh, en })),
    `${LOCALE_NS}: dictionaries`,
  );

  // 侧栏入口（id 必须与 main 面板的 key 同名，sidebar 用它去选中面板）
  // 同样包错误边界：图标渲染抛错也不该把整个 sidebar 入口打崩
  ctx.slots.inject('sidebar.panellist', () => safeRegister('sidebar.panellist 注册', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: SLOT_ID,
    order: 88,
    label: () => '待办',
    locale: LOCALE_NS,
  }, withErrorBoundary((props) => React.createElement(WorkTodoIcon, { size: props?.size ?? 16, active: props?.active })))));

  // 中栏独立面板（外面包一层错误边界：渲染抛错时给中文兜底 + 重试，而不是整块白屏）
  ctx.slots.inject('main', () => safeRegister('main 面板注册', () => ctx.slots.register({
    name: 'main',
    key: SLOT_ID,
    locale: LOCALE_NS,
  }, withErrorBoundary(WorkTodoPanel))));
}
