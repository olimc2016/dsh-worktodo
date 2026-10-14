# 自升级（自己升级自己）：设计与验证报告

> 针对的真实问题：另一台电脑上装好的 dsh-worktodo 面板已经显示「有新版本 v0.2.4」，
> 但实际装的仍是 **0.2.0**，重启不变，且**没有任何自动更新**。
>
> 本报告路径一律写 `~/...` / `$DSH_HOME` / 应用包内相对路径，不含任何个人路径或用户名。
> 所有实验都在临时目录（`/tmp`、`os.tmpdir()`）与假 profile 上完成，**没有触碰用户真实 profile 或数据**。

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 只提示、不动作 | ✅ 已补 `GET/POST /worktodo/update` 状态机 + 面板可点「立即更新」 |
| 装完还是旧版（pin 住的旧规格） | ✅ 命令显式 `dsh-worktodo@latest` |
| 被镜像 / 元数据缓存挡住 | ✅ 命令显式 `--registry https://registry.npmjs.org/`（默认值，可配置） |
| 没有自动更新 | ✅ 新增 `autoUpdate`（**默认 false**，用户显式开启才后台执行） |
| 本地开发被误升级 | ✅ `link:` 安装**一个子进程都不起**，直接返回 `reason:'linked'` |
| 并发连点 | ✅ 幂等：已在跑就返回 `running`，子进程只启动一次 |
| 失败/超时无回声 | ✅ `state:'failed'` + 稳定 `reason` + `error` + `logTail`（尾部日志） |
| 阻塞面板 | ✅ 升级在后台子进程里跑；实测升级进行中 `GET /list` **0–1ms** 返回 |
| 全量测试 | ✅ `node tools/verify-all.mjs` → **10/10 步骤通过**（含构建） |

---

## 2. 设计

### 2.1 路由：为什么不新增路径

`POST /worktodo/update` **早就是「改待办」**（面板行内编辑提交 patch 用的就是它）。
真实 `webServer` 的路由表按路径去重、重复注册会抛 `duplicate exact route`，所以：

- **不新增路径**，而是把同一条 `/worktodo/update` 改成「一个路径两个动词 + 意图分派」：
  - `GET /worktodo/update` → 返回升级状态 `{ok:true, data:{state, from, to, startedAt, finishedAt, command, logTail, error, reason, installed, autoUpdate, registry, timeoutMs}}`；
  - `POST /worktodo/update`：
    - 体里带 `{action:'plugin-update'}`（面板用的形态）或**空体 `{}`** → 触发自升级；
    - 带 `ref`/`id`/任何待办字段 → 保持老语义「改待办」。
- 这样老客户端/文档里的 `POST /worktodo/update {ref,title}` 不受影响（有专门用例钉住），
  新增能力也没有把既有路由挤掉（否则第二条注册会被降级丢弃，升级这条路会静默不存在）。
- 405 的 `allow` 头现在会同时列出 `GET, POST`。

### 2.2 怎么定位 profile 与执行升级

**profile 定位**（`findProfileDir()`，按顺序，找不到就明确失败，绝不猜目录）：

1. 测试缝 `WORKTODO_PROFILE_DIR`（显式注入；`~` 会展开）；
2. **从本插件自己被加载的模块路径反推**（`profileDirFromModuleUrl(import.meta.url)`）：
   registry 安装时模块就在 `.../profiles/<name>/node_modules/dsh-worktodo/lib/index.js`，
   往前切到 `node_modules` 之前即 profile 目录。这是最精确的信号，**多 profile 时不会选错**；
   `link:` 安装时 ESM 会把软链接解析成仓库真实路径（不含 profile 的 `node_modules` 段），此路返回 null；
3. `$DSH_HOME/profiles/*` 里 `package.json` 依赖了 `dsh-worktodo` 的那一个（字典序取第一个，保证确定性）；
4. 兜底 `$DSH_HOME/profiles/desktop`（Electron 桌面端的固定名字，CLI 也把 desktop 当保留 profile）。

`$DSH_HOME` 复用插件已有的 `resolveDshHome()`（官方 `@deepseek-ai/dsh-home-paths` 优先，失败回落
`$DSH_HOME` / `~/.dsh`），与存储层同一套规则，不引入第二套家目录语义。

**执行器**（`resolveUpdater()`）：

1. 测试缝 `WORKTODO_UPDATE_CLI`（强制某个 CLI 脚本）；
2. **官方 CLI 优先**：从宿主进程自身推导，例如 Electron 下
   `dirname(process.execPath)/../Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`，
   并用 `process.resourcesPath` 兜底（Windows/Linux 打包布局走这条）。命中则：
   `ELECTRON_RUN_AS_NODE=1 <process.execPath> --expose-internals <cli.js> plugin --profile <name> add dsh-worktodo@latest --registry <registry>`
   （与官方 `runtime/cli/bin/dsh` 启动器同款；CLI 内部会把 `add`/`--registry` 转交给 Desktop 自带的 pnpm）；
3. 拿不到 CLI → 退回 pnpm：缝 `WORKTODO_PNPM_PATH` → 应用自带
   `<resources>/runtime/pnpm/bin/pnpm.mjs`（用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑）→ PATH 上的 `pnpm`。
   命令：`pnpm add dsh-worktodo@latest --registry <registry>`，`cwd` 固定为 profile 目录。

**`@latest` + 官方源是硬编码在命令里的**（`buildUpdateCommand()`），不是「继承 npm 配置」：

- 规格恒为 `dsh-worktodo@latest` —— 直接压过 profile 里 pin 死的 `"dsh-worktodo": "0.2.0"`；
- `--registry` 恒为配置值、默认 `https://registry.npmjs.org/` —— 绕开镜像与 6 小时元数据缓存。

### 2.3 配置项（全默认安全）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `autoUpdate` | `false` | 只有 `=== true` 才算开启；`'yes'`/`1` 之类一律当关。开启后：检测到新版→后台 `void` 执行一次，失败只 `logger.warn` 不打扰用户 |
| `updateRegistry` | `https://registry.npmjs.org/` | 空白/非字符串回落官方源 |
| `updateTimeoutMs` | `180000` | 非法或 <100 回落默认；封顶 1 小时 |

自动升级还有三条「不打扰」护栏（抽成纯函数 `shouldAutoUpdate()`，可直接单测）：
没有新版不跑、正在跑不重入、**同一个 latest 版本只自动尝试一次**。

### 2.4 状态机与失败模式

`updateRun.state`: `idle → running → done | failed`，用 `finish()` 做**幂等收口**
（超时与进程退出会竞争，只认第一个结论）。

| 失败模式 | `reason` | 行为 |
| --- | --- | --- |
| profile 目录找不到 | `profile-not-found` | 明确报错，不去猜目录写安装 |
| profile 里没有本插件依赖 | `not-installed` | 明确报错 |
| `link:` 本地链接安装 | `linked` | **不起子进程**，回专门的说明（要用户走 git/pnpm 工作流） |
| spawn 失败（ENOENT 等） | `spawn-failed` | `error` 带原因 |
| 子进程退出码非 0 | `exit-nonzero` | `error` 带退出码/信号；`logTail` 带 stderr 尾部 |
| 超时 | `timeout` | 先 `SIGKILL` 再落失败（不让改了 `node_modules` 的进程继续在后台跑） |

成功时**不靠退出码判断结果**：重新读 profile 里
`node_modules/dsh-worktodo/package.json` 的 `version` 作为 `installed`/`to`，
并据此重算 `hasUpdate`（`restartRequired` 表示「已落盘但当前进程还是旧模块 → 重启 DSH 生效」）。

输出捕获：stdout/stderr 只保留最后 40 行 / 4000 字符；`/list` 载荷里只放**不含日志**的摘要，
完整 `logTail` 只走 `GET /worktodo/update`（列表是高频轮询，不该被安装日志撑大）。

### 2.5 客户端

- 页脚「版本 vX」旁边那一格从只读 `<span>` 变成 `<button class="wt-chip wt-update">`（**无 `innerHTML`**）：
  - `idle + hasUpdate` → `有新版本 vX · 立即更新`，可点 → `POST /worktodo/update {action:'plugin-update'}`；
  - `running` → `正在更新…`，禁用（防连点出第二个子进程）；
  - `done` → `已更新到 vX，重启 DSH 生效`（版本未知时退化为「已更新完成，重启 DSH 生效」）；
  - `failed` → `更新失败：<原因>`，可点重试；`reason === 'linked'` 换成专门的「本地链接安装」说明且**不给重试**。
- 进度用 `GET /worktodo/update` **每 2 秒**轮询，`useEffect` 的依赖就是 `state`：**一离开 `running` 立刻 clearInterval**，
  面板正常挂载时**不注册**这个定时器（不给「省着打宿主」的既有约束拖后腿）；窗口隐藏时同样不打。
- `postJson` 现在把宿主的 `reason` 挂到抛出的 `Error` 上（否则 `linked` 只能靠解析中文 message 区分）。
- 文案中英双语（沿用 `zh`/`en` 字典），配色全部走主题变量（`C.ok`/`C.warn`/`C.error`/`C.label2`）。

---

## 3. 测试覆盖

新增用例都加在**现有 9 个测试文件**里（文件数不变），主要落在 `tools/smoke-host.mjs`，
面板侧落在 `tools/smoke-client.mjs`，契约侧的字段白名单同步更新 `tools/smoke-contract.mjs`。

假子进程的做法：临时目录里写一个 `pnpm` shell 脚本（`chmod 755` + PATH 前置注入），
它把每次调用的 argv 追加进 capture 文件，并可配置 `sleep` 与退出码；
于是「到底执行了什么命令、启动了几次」都能**逐字断言**，而不是靠读代码推断。

| # | 用例（`smoke-host.mjs`） | 抓什么 bug |
| --- | --- | --- |
| 1 | `link:` 安装被跳过，一个子进程都不起（`reason=linked`） | 误把开发链接安装换成 registry 版本；capture 文件必须**不存在** |
| 2 | profile pin 成 `0.2.0` 时命令同时带 `@latest` 与官方 registry | 「装完还是 0.2.0」的根因；并用假 `node_modules/.../package.json` 断言成功态 `to/installed` 来自**落盘版本** |
| 2b | `WORKTODO_UPDATE_CLI` 指向假 CLI → 首选路径的 argv 是 `plugin --profile <name> add dsh-worktodo@latest --registry …` | 首选 CLI 路径的 profile 名/子命令/来源被改坏（假 CLI 是 Node 脚本，真实现用 `process.execPath` 跑它） |
| 3 | 连续两次 POST 只启动一个子进程（幂等） | 并发/连点出两个安装进程；用 `INVOKE` 标记数调用次数 |
| 4 | 退出码非 0 → `state=failed` + `reason` + `error` + stderr 进 `logTail` | 失败被吞成「没事」 |
| 5 | 子进程 sleep 5s + `updateTimeoutMs=300` → 到点被杀落 `failed/timeout` | 挂死的安装永久占住 running；**实测 325–330ms 收口**（不是等满 180s） |
| 6 | 升级进行中 `GET /list` 及时返回 | 升级阻塞面板；**实测 0–1ms** |
| 7 | 空体 `POST /update` 也算升级 | 面板/脚本不写 `action` 时静默变成「改待办」失败 |
| 8 | 带 `ref` 的 POST 仍是「改待办」 | 新能力劫持老语义（这会让行内编辑静默坏掉） |
| 9 | 配置默认值：`autoUpdate=false` / 官方源 / `180000`；非法值回落 | 「默认安全」被改坏（例如默认打开自动升级） |
| 10 | `shouldAutoUpdate()` 全分支 | 自动升级重入、同版本反复重试、已是最新还去装 |
| 11 | `profileDirFromModuleUrl()`：registry 布局精确切出 profile；link/缺 manifest/坏输入返回 null | 多 profile 时选错安装；把非 profile 目录当 profile |

面板侧（`smoke-client.mjs`）：

- `updateBadgeState()` 纯函数：可点/进行中/已完成/`linked`/普通失败五种形态；
- **真渲染**一次页脚，断言存在恰好一个 `wt-update` 按钮、挂了 `onClick`、`running` 时 `disabled=true`
  且文案变成「正在更新…」（防止退化成只读 `span` 或忘记禁用）。

契约侧（`smoke-contract.mjs`）：路径集合断言改为去重（`/update` 现在有两个调用点），
并把 `action` 加进 `/update` 的字段白名单 —— 否则「字段名打错」这道门禁会把新字段误判成 bug。

### 3.1 反向验证（回退修复 → 测试必须变红）

每次改动前先 `shasum -a 256` 记基线，用 `/tmp` 副本回退，跑完再从副本恢复并核对 shasum 一致
（恢复后校验 `8debc502a0cb…`；该文件随后又新增了 `shouldAutoUpdate`/`timeoutMs`，sha 已变化）。
每次回退**只**改被测的那一处：

| 回退的修复 | 结果 |
| --- | --- |
| 删掉 `link:` 早退分支 | ✗ `link: 安装必须被拒绝，而不是照装：期望 false，实际 true`（且 capture 文件被创建＝真的起了子进程）；49 通过 1 失败 |
| 命令去掉 `@latest` 与 `--registry` | ✗ `命令必须显式带 @latest：INVOKE`（argv 里确实没有）；49 通过 1 失败 |
| 删掉并发早退护栏 | ✗ `并发两次 POST 只能启动一个子进程（实际 2 个）：期望 1，实际 2`；49 通过 1 失败 |
| 非 0 退出也当成功 | ✗ `非 0 退出必须落到 failed（实际 done）`；49 通过 1 失败 |

四条都是「回退即红、恢复即绿」，说明用例抓的是行为而不是恒真断言。

### 3.2 全量结果

`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs`：

```
  ✓ 客户端 bundle 构建  (build-client.mjs)
  ✓ 数据模型 / 服务层 / 存储层 / 宿主接线与工具
  ✓ 客户端↔宿主契约 / 客户端 bundle / CI workflow 契约
  ✓ 发布面审计（隐私与文档完整性） / 收录提交门禁
10/10 个步骤通过（含构建）
```

单文件计数：`smoke-host.mjs` 54/54（改前 42）、`smoke-client.mjs` 34/34（改前 32）、
`smoke-contract.mjs` 14/14。测试文件仍是 **9 个**。

---

## 4. 未做 / 不确定

1. **没有在真机上执行一次真实升级**。`findProfileDir()` 会去读真实 `$DSH_HOME/profiles`，
   而「装到桌面 profile」这一步必然修改用户真实安装 —— 按本次约束（不得触碰真实 profile）
   只做了「命令拼装 + 假子进程」的端到端验证。**首次真机升级需要人工确认**：
   点一次面板上的「立即更新」，看是否真的落到 0.2.4 并提示重启。
2. **真实 CLI 没有真跑过**，只覆盖了「命令形状」。已确认应用包内
   `Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` 存在，
   推导路径与 `Resources/runtime/cli/bin/dsh` 启动器那行一致；
   并用 `WORKTODO_UPDATE_CLI` 指向一个假 CLI（Node 脚本）验证了完整 argv
   （`plugin --profile <name> add dsh-worktodo@latest --registry …`）。
   但「Electron 以 `ELECTRON_RUN_AS_NODE=1` 跑 asar 内脚本、再由它转交自带 pnpm」
   这条只在官方启动器里见过，未在本机执行验证。拿不到 CLI 时会自动退回 pnpm
   （自带 `runtime/pnpm/bin/pnpm.mjs` 存在），所以最坏情况是走降级路径。
3. **Windows / 非 Electron 宿主**：
   - Windows 上优先用 `process.resourcesPath` 拼 `app.asar/...`（未在 Windows 实测）；
     `spawn` 用绝对 `process.execPath`，PATH 上的 `pnpm` 需要 `pnpm.cmd` 才能被无 shell 解析 —— 
     目前 `resolveUpdater()` 只会在 `resourcesPath` 缺失且自带 `pnpm.mjs` 也不存在时才用裸 `pnpm`，
     Windows 上这条降级路径可能失败（会以 `spawn-failed` 明确报出来，不会静默）。
   - 非 Electron（例如从源码 `dsh web`）宿主推导不到 Desktop CLI，会退回 pnpm 路径：
     这要求 profile 目录里有可用的 pnpm（自带或 PATH 上）。这条路径只有假 pnpm 的单测覆盖，
     没有在真实非 Electron 宿主上跑过。
4. **自动升级的端到端触发未覆盖**。测试进程用 `WORKTODO_NO_UPDATE_CHECK=1` 完全关掉了
   registry 查询，所以「检测到新版 → 后台执行」这条链路只验证了**决策纯函数**
   （`shouldAutoUpdate` 全分支）与 `startUpdate()` 本体，没有跑通「真查 registry → 真自动装」。
5. **升级完成后的 `hasUpdate` 重算依赖「能读到 profile 里落盘的版本」**：
   若 pnpm 用了某种不落盘 `node_modules/dsh-worktodo/package.json` 的布局（或读不到），
   `installed` 会是 `null`，此时 `to` 退化为 registry 的 `latest`，面板显示「已更新完成，重启 DSH 生效」
   而不是具体版本号——功能不受影响，但版本号可能显示得不够准。
6. **同一路径两种语义**是有意的兼容取舍（见 2.1）：判定规则是「带待办字段 = 改待办，否则 = 升级」。
   如果将来有人给 `/update` 加一个既不带 `action` 也不带待办字段的新用途，会被当成升级；
   已知约束写在这里，避免以后踩坑。
7. **不做自动重启**：升级完成后只提示「重启 DSH 生效」，插件不代替用户重启应用
   （重启会中断正在跑的会话，不该由面板的一键操作触发）。
8. **多 profile + `link:` 安装时的歧义**：registry 安装靠模块自身路径精确定位（见 2.2 步骤 2），
   但 `link:` 安装反推不出 profile，只能扫 `$DSH_HOME/profiles/*` 并取字典序第一个 ——
   同时存在多个链接了本插件的 profile 时可能选错。实际场景里 `link:` 会被直接跳过（`reason:'linked'`），
   不会真的执行安装，所以影响限于「报错指向了另一个 profile」。
