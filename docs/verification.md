# 真机验证记录（0.1.0）

环境：macOS 桌面版 DSH，profile `desktop`，`$DSH_HOME=~/.dsh`，
插件以 `link:` 方式装进 profile（源码目录直接生效，改完重建即热更新）。

> 本文件是维护者记录，**不进 npm 包**（`package.json` 的 `files` 不含 `docs`）。

## 安装

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --expose-internals \
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" \
  plugin --profile desktop add <本仓库绝对路径>
```

`dsh plugin add` 同时写了两处，缺一不可：

- `dependencies`：`"dsh-worktodo": "link:.../dsh-worktodo"`（包能被解析到）
- `dsh.profile.bundles`：追加 `"dsh-worktodo"`（包会被装载）

## 已观察到的事实

| 检查项 | 结果 |
|---|---|
| 宿主半侧是否激活 | ✅ 安装后**未重启**即生效（HMR），本会话的工具清单里直接出现了 6 个 `worktodo_*` 工具 |
| `@deepseek-ai/dsh-tools` 是否解析得到 | ✅ 6 个工具全部注册成功，即 `defineTool` 从 DSH 安装目录解析成功（这正是 peer 声明 + 官方从安装目录解析的预期行为） |
| agent 工具端到端 | ✅ `worktodo_add` 真实写入（返回 `wt-mv34idb0-kjjq`），`worktodo_list` 真实读回同一条 |
| 数据落在哪 | ✅ **官方 storage**：`~/.dsh/storages/worktodo.json`（storage-json 后端，一个领域一个文件；含 `unit` 描述符与 `tables.todos`），**没有**走 JSON 文件回退 |
| 存储结构是否符合后端契约 | ✅ 文件里是 `{unit:{name:'worktodo',version:1}, global:null, tables:{todos:{...}}}` |
| 记录往返是否保真 | ✅ `status/priority/due/project/source/createdAt` 全部原样落盘并读回 |
| HTTP 路由是否活着 | ✅ `/worktodo/health` 有响应 |
| 路由准入围栏是否生效 | ✅ 未认证的 `curl` 得到 **401 Unauthorized**（`connection.requestRejection` 按设计拒绝），面板自身在已认证页面上下文里访问 |
| 单元/接线测试 | ✅ 166 例全通过（26 数据 + 11 存储 + 18 服务 + 27 宿主 + 12 客户端↔宿主契约 + 14 客户端 bundle + 11 CI 契约 + 30 发布面审计 + 17 收录门禁），均不需启动 DSH |
| 发布包内容 | ✅ `pnpm pack` 产物 75 KB，含 `lib/client.js`、`lib/index.js`、`cordis.patch.yml`、`locales`、`icon.svg`、README、docs、src |

## 平台包（`@deepseek-ai/dsh-tools` 等）在发布形态下怎么解析

这是本插件「装得上」的关键，值得记清楚，因为它曾经看起来像是个坑：

**担心**：`dependencies` 为空，`@deepseek-ai/dsh-tools` 只是 peer；而链接安装时工作区里有 devDependencies 副本，
会不会是那份副本兜住了、真实 registry 安装（没有 devDependencies）就会解析失败、导致**工具静默不注册**？

**结论：不会。** 依据是官方规范
`deepseek-harness/.agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.zh.md`
（「profile 解析的主线祖先链与拦截层」）与官方发布文档 `docs/user/develop/basic/publish.zh.md`：

- 运行中的 dsh 有一套 **runtime resolution**（installation 闭包，从运行中 dsh 的 `package.json` 沿
  `dependencies` / `peerDependencies` 广度优先遍历得到，含 `@deepseek-ai/dsh-tools`）。
- 拦截层是 `$DSH_HOME/profiles/node_modules`：runtime resolution 里有条目的包名，**在该层占据对应包目录的位置**，
  而且「即使该目录在磁盘上不存在也成立」（本机确认：`~/.dsh/profiles/node_modules` 物理上不存在）。
- 规范表 3 有一行恰好就是本插件的情形：
  「链接插件 → `@deepseek-ai/dsh-tools`（peer）→ 运行中的 dsh 的那一份；`R/node_modules` 里的
  **devDependency 副本不被读到**」。
- 规范同时要求：**需要与宿主共享实例的 dsh 包要同时声明在 `peerDependencies` 与 `devDependencies`**——
  本插件的 `@deepseek-ai/dsh-tools` / `dsh-storage-domain` / `dsh-home-paths` 正是这样声明的，
  `dependencies` 保持为空（把有状态 dsh 包放进 `dependencies` 会产生第二个实例，那才是真错误）。
- 本机 profile 的 `pnpm-workspace.yaml` 确实是 `nodeLinker: hoisted` + `autoInstallPeers: false`，
  所以 peer 从不被装进 profile，一律由拦截层提供——因此链接安装与 registry 安装走的是**同一套**解析，
  真机那次成功的工具注册就是这套机制的实证，不依赖工作区的 devDependencies。

**推论**：`peerDependenciesMeta.optional` 只影响安装器的提示与自动安装，解析规则读的是
`peerDependencies` 的声明本身，所以保留 optional（用来表达「缺它时降级成只有面板」）不影响拦截层生效。


## 真机回归抓到的第一个真 bug（工具返回值的 lossless JSON）

**症状**：在运行中的插件上调 `worktodo_add` **不传截止日期**时，整个工具调用被拒：

```
Error: tool "worktodo_add" returned invalid output: value is not lossless JSON
```

**根因**：工具返回值里有值为 `undefined` 的可选字段（`due: result.todo.due ?? undefined`）。
DSH 要求工具返回值必须能被 JSON 无损往返，`undefined` 过不了这道校验，**整次调用被判无效**。
而「加一条没有截止日期的待办」恰恰是最常见的用法——`worktodo_update` 清空截止日期后同理。
我的烟测因为每次都传了 `due` 而漏掉了它：**单元测试覆盖了参数，却没覆盖"可选字段缺席"这种返回值形状**。

**修复**：`src/tools.mjs` 加 `compact()`，可选字段缺席时**删键**而不是留 `undefined`。

**防回归（用真校验器，不是自己写的近似实现）**：`smoke-host.mjs` 里判定「无损」用的是 **DSH 自己的
`snapshotJsonValue`**（来自 `@deepseek-ai/dsh-util-values`）——也就是 `@deepseek-ai/dsh-tools` 抛出
`value is not lossless JSON` 时用的那一个函数（其 `lib/index.js` 的 `snapshotToolValue()`：
`const detached = snapshotJsonValue(candidate); if (detached === void 0) throw new ToolOutputError(...)`）。
另有一条断言专门证明这条守卫有牙齿：`snapshotJsonValue({ due: undefined })` 必须返回 `undefined`
（即旧写法必被拒），而 `{ due: null }` 合法。测试数演进：85 → 90 → 103 → 116 → 140 → 143 → 144 → 155 → 161 → **166（当前，9 个测试文件）**。

**教训（比 bug 本身重要）**：单元测试跑的是模块，真机跑的是**整条校验链**。
这类"返回值形状被上层校验拒绝"的问题，只有真机调用才暴露得出来——这也是为什么
`docs/verification.md` 这份记录要留着。

## 已安装插件的源码改动不会热更新（重要）

修好之后真机重试**仍然失败**，原因不是 bug 没修好，而是：

> **以 `link:` 装进 profile 的插件，源码改动不会换到已加载的模块 generation。**
> 官方文档写得很明确：「替换已安装的包需要重启才能加载新的 JavaScript 模块 generation」。
> 我 `touch` 了入口与工具模块也没有热重载——已加载的 ESM 模块缓存不会因为文件 mtime 变化而失效。

所以：**这次修复要在你重启 DSH 之后才会在运行中的实例里生效**。发布不影响这一点——
从 npm 全新安装的实例加载的就是修好的代码。

反过来，这件事暴露了一个可观测性缺口：**从外面看不出运行中的是哪一版、工具到底注册了几个。**
已补上：`/worktodo/health` 现在返回

```json
{
  "version": "0.1.0",
  "tools": { "status": "registered", "registered": 6, "names": ["worktodo_add", "..."], "error": null }
}
```

`tools.status` 为 `failed` 时还会带上 `error` 原文（比如平台包解析失败），
不用再去翻日志猜「工具为什么没出现」。

## 尚未验证（明确的限制）

- **面板的视觉呈现未经我确认**：本会话没有浏览器控制能力，我看不到侧栏与面板的实际渲染。
  已能证明的是「bundle 格式正确、slot 注册正确、首屏渲染不抛异常、挂载后确实请求 `/worktodo/list`」
  （见 `tools/smoke-client.mjs` 的 14 个用例），但**像素级效果与深浅色观感必须由人眼确认**。
- **README 首屏截图待补**：`docs/listing.md` 的提交清单要求真机截图，请在面板上截一张
  存成 `docs/shot-panel.png`，再把 README 里的截图段加上（不要用模拟图）。
- **多 agent 并发写同一列表**：存储层做了写入串行化，但两个 agent 同时改同一条记录时
  是「后写覆盖」，没有做乐观锁——v0.1.0 的已知取舍。

## 客户端 ↔ 宿主契约测试（第四轮补的）

`smoke-client` 只证明「面板首屏会去拉列表」，**按钮的写路径**一直没有端到端验证。而这条路径上最容易出的是
**静默错**：客户端把字段名打错（`due` → `duedate`）时，宿主不报错，只是那个字段永远不生效——
用户填了截止日期却永远不保存，而没有任何红灯。

所以加了 `tools/smoke-contract.mjs`（12 例），两层：

1. **静态提取**：从 `src/client/index.js` 抽出它实际请求的路径与字段名，与宿主 `apply()` 真实注册的路由、
   真正消费的字段比对。**已做变异验证证明它有牙齿**：把 `/status` 改成 `/statuss` 会红 3 条，
   把 `due` 改成 `duedate` 会红 1 条（正是那类静默错）。
2. **行为验证**：用客户端字面上的报文形状打真实路由，覆盖两处清空约定——create 用 `due: null`，
   行内编辑用 `due: ''` / `project: ''`（空串清空是 `lib/index.js` 里的约定），以及 toggle / adopt /
   remove / list 返回给面板的字段完整性。

注意：这是**行为**契约测试，不是视觉验证——面板长什么样仍然只能由人眼看。

## ⚠️ 不要用 `file:` 本地 tarball 装进 profile 做「registry 形态」验证

第四轮我试过：`pnpm pack` 出 tarball，再 `dsh plugin add ./dsh-worktodo-0.1.0.tgz`，本以为这能模拟
registry 安装，结果发现两件不该发生的事：

1. **pnpm 把它当本地包，连 devDependencies 一起装进包目录**——profile 里多出 24M
   （`<profile>/node_modules/dsh-worktodo/node_modules/` 里是 esbuild 与全部 `@deepseek-ai/*`）。
   真正的 registry 安装**不会**装依赖的 devDependencies，所以这个形态既臃肿又不具代表性。
2. **它把工作区的 `node_modules` 清空了**：实验之后 `verify-store` 少了 3 例、`smoke-host` 少了 10 例，
   报错正是 `Cannot find package '@deepseek-ai/dsh-storage-domain'`。重跑
   `pnpm install --config.auto-install-peers=false` 才恢复（**当时**为 6/6 文件、102 例；现在是 9/9、155 例）。

结论：**profile 里做验证就用 `link:`（或真发布后的 registry 安装）**，别用本地 tarball。
`pnpm pack` 只用来核对发布包内容（`tar -tzf`），不要拿它去 `dsh plugin add`。

## GitHub 安装路径实测（第五轮，第五步：不靠猜）

npm 发布被 2FA 卡住，所以「从 GitHub 装」不是备选而是主路径，必须实测而不是引用文档。

**做法**（不依赖用户的仓库，也不需要网络）：用 `git archive HEAD` 把**已提交的那棵树**（36 个文件）导出到
`/tmp/wt-git`，`git init` 成仓库，然后在一个干净的消费者目录里按 git 依赖安装：
`pnpm add git+file:///tmp/wt-git`。git 依赖的取包方式与 `github:owner/repo` 不同，但安装语义相同。

**结果（全部为实测值）**：

| 检查项 | 结果 |
|---|---|
| 是否解析出多余依赖 | **只解析 1 个包**（就是插件自己）→ 未把 devDependencies 装进来 |
| 包内是否有嵌套 `node_modules` | **没有**（对比：本地 `file:` tarball 那次被塞进 24 MB） |
| 安装体积 | **316 KB** |
| 浏览器半侧是否在 | ✅ `lib/client.js` 40 KB 在包里 |
| `dsh.bundle.patch` | ✅ `./cordis.patch.yml`，文件在 |
| `dsh.client` | ✅ `platform: web`、`immediately`、`inject` 都在 |
| 是否需要构建授权 | ❌ 不需要（包内无 `prepare`/`install` 脚本，输出已提交） |
| 安装内容 vs npm 发布包 | ✅ 逐文件一致——**pnpm 对 git 依赖也遵循 `files` 字段** |

**为什么这条路能成立**：官方分发文档说 git 安装拉源码且不跑构建、TS 包会因为缺 `lib/` 而加载失败。
本插件的对策是**把构建产物 `lib/client.js` 一起提交**，于是既不需要 `prepare` 脚本，也不需要用户授权构建。
这也是仓库里同时提交 `src/` 与 `lib/` 的原因。

## ⚠️ `node` 不在 PATH 上会让脚本与发布钩子莫名失败（第七轮，照跑 CI 时抓到）

**症状**：在 DSH 自带工具链的 shell 里执行 `pnpm run build` / `pnpm test`，得到

```
$ node tools/verify-all.mjs
sh: node: command not found
[ELIFECYCLE] Test failed.
```

**原因**：DSH 的环境里 `node` **不在 PATH 上**（只有捆绑的 node 可执行文件，要靠绝对路径调用）。
而 `package.json` 的脚本内部写的都是 `node …`，pnpm 通过 PATH 去 spawn，自然找不到。

**为什么这个坑致命**：`prepublishOnly` 也是这样的脚本。**在同一个 shell 里跑 `pnpm publish`，
会在测试钩子那一步失败**——看起来像"插件有问题"，其实是环境 PATH。发布最怕在最后一步栽在环境上。

**修复**：`pnpm-workspace.yaml` 里打开 pnpm 的专用设置

```yaml
scriptsPrependNodePath: true
```

它把 node 可执行文件所在目录前置到脚本子进程的 PATH。实测（不带任何命令行参数、即配置生效后的形态）：
`pnpm run build` ✅、`pnpm test` ✅（9/9、166 例）、`pnpm run prepublishOnly` ✅、`pnpm install --frozen-lockfile` ✅。

**顺带修掉的两个「本地能跑、CI 红」的隐藏不一致**：

1. 本地一直用 `--config.auto-install-peers=false` 装依赖，但该设置没写进配置文件 → CI 上一条普通的
   `pnpm install --frozen-lockfile` 会得到不同解析结果、甚至直接失败。已写进 `pnpm-workspace.yaml`
   （`autoInstallPeers: false`），且 `--frozen-lockfile` 实测通过，证明 lockfile 与该设置一致。
2. CI 原本用 `npm install`，而**本地从未装过 npm**：`@deepseek-ai/dsh-tools` 带 11 个 peer，
   npm 默认会自动安装 peer——那是一条没人验证过的解析路径。已把 CI 切到 pnpm（唯一验证过的路径），
   并在本地把 CI 每一步照跑了一遍（install / build / test / pack + 产物内容检查）。

## 发布前预检：无凭据实跑一次 `pnpm publish`（第十轮）

发布这一步没法在本地真跑（会真发出去），但**"它会在哪一步失败"是可以实测的**：不配任何凭据跑一次真发布，
它必然在认证处失败，于是就能看清前面所有关卡是否都过了。实测结果：

| 观察 | 结论 |
|---|---|
| 有没有因为「**没有 remote**」而触发 git 检查拦截 | **没有**，直接走到 `PUT https://registry.npmjs.org/dsh-worktodo` |
| 失败点 | `[E404] 404 Not Found - PUT …`（未认证发布就是这个响应） |
| 说明什么 | **唯一的门是认证**——`files`、`prepublishOnly` 钩子、打包全都过了 |
| 报错栈里的 `withOtpHandling` | 需要 OTP 时 **pnpm 会自己弹提示**，不必把码写进命令 |
| **工作区脏时会被拦** | `ERR_PNPM_GIT_UNCLEAN: Unclean working tree. Commit or stash changes first.`（第二次跑时因为文档还没提交就复现了） |

后一条同样是「会在最坏时刻咬人」的规则：**发布前工作区必须是干净的**（有未提交改动就拒绝），
所以改完任何文件（比如补截图）都要先 commit，或者用 `--no-git-checks` 显式跳过。
本仓库在提交后是干净的，可以直接发。

**同时发现一个会在最坏时刻咬人的坑**：`pnpm run <script>` 与 `pnpm publish` 触发同一个生命周期钩子时，
`scriptsPrependNodePath: true` 只对前者生效——**`pnpm publish` 跑的 `prepublishOnly` 仍然找不到 `node`**
（`sh: node: command not found`）。也就是说：用户在提示符处输完 OTP、看起来要发布的那一刻才失败，
**一个码白白烧掉**。可靠形式是在调用处显式前置 PATH：

```bash
export PATH="$(dirname "$NODE"):$PATH"
"$NODE" "$PNPM" publish --access public
```

这条已写进 `publish-checklist.local.md` 并标注「不能省」。普通开发者终端里 node 本来就在 PATH 上，
所以这个坑只影响 DSH 自带工具链这类环境——而这恰好是本项目的发布环境。

## npm 首次真实发布尝试的结果（2026-10-11）

工具链全部通过，被 npm 的策略门拦下——把结论记下来，省得下次再逐层排查：

| 阶段 | 结果 |
|---|---|
| `pnpm login`（维护者账号） | ✅ 成功；**token 落在 `~/Library/Preferences/pnpm/auth.ini`**（pnpm 11 在 macOS 上不用 `~/.npmrc`，查 `~/.npmrc` 会误判成"没登录"） |
| token 认证身份 | ✅ 维护者账号（用 `GET /-/npm/v1/user` 验证） |
| 账号 2FA 状态 | ❌ `tfa: false` |
| `prepublishOnly` 钩子 | ✅ 跑完（当时 7/7 个测试文件；现在 8 个） |
| 打包与上传 | ✅ 走到 `PUT https://registry.npmjs.org/dsh-worktodo` |
| 上传结果 | ❌ `403 Forbidden — Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.` |

**两条可复用的诊断经验**：
1. **未认证**发布请求返回 **404**（我先前那次无凭据预检），**已认证但缺 2FA** 返回 **403 并附带明确原因**——
   所以「404 还是 403」能直接区分"没登录"和"登录了但策略不满足"。
2. 查"到底登没登录"不能只看 `~/.npmrc`：pnpm 11 在 macOS 上把 token 放在
   `~/Library/Preferences/pnpm/auth.ini`。

**结论**：发布这一步卡在 npm 的策略上，唯一出路是**给账号启用 2FA（Authenticator app / TOTP）**。
而且这不是只为了发布——npm 2026-07 的变更规定「改 token / 包权限 / **trusted publishing 配置**」
都需要交互式 2FA 挑战，所以**绑定 Trusted Publisher 也需要它**；"带 bypass-2FA 的 granular token"
这条替代路同样要求创建 token 时就通过 2FA 挑战，等于死循环。**换言之 2FA 无可回避，只能开；
但开完之后，绑好 Trusted Publisher 就再也不需要输码了。**

## 2FA 开启之后仍然 403：会话凭据本身不被接受（2026-10-11 第二轮实测）

用户启用 2FA 后（`tfa: {'mode': 'auth-and-writes'}`，已在 registry 侧确认），发布**仍然**返回同一个 403。
为了分清「缺 OTP」还是「凭据不行」，直接对 registry 做了三次受控 PUT（空体，绝无发布可能）：

| 请求 | 响应 |
|---|---|
| 只带会话 token | `403 {"error":"Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages."}` |
| 带会话 token + `npm-otp: 000000`（假码） | **完全相同的 403** |
| 响应头检查 | **没有 `www-authenticate: OTP` 挑战头** |

**推论**：这不是"码没给"，而是**这个会话凭据不被接受用于写操作**——它是在 2FA 启用**之前**通过
`pnpm login` 建立的。npm 的措辞也印证了这一点：它要的是「2FA（凭据能证明存在性）**或**带 bypass-2FA 的
granular token」，而现在这个 token 两者都不是。

**两条可行路径**（都已具备前提条件，因为账号现在有 2FA 了）：

1. **重新登录（凭据带上 2FA 证明）**：`pnpm login` 现在会问 `Enter OTP`，登录后发布再带一次码
   （`--otp=`）。注意 pnpm 的自动提示**不一定触发**——实测这个 403 不带挑战头，pnpm 就不会弹提示，
   必须显式传 `--otp`。
2. **建一个带 bypass-2FA 的 granular access token**（更稳，且能绕开 30 秒输码窗口）：
   由用户写到 `~/.npmrc`，然后发布不再需要任何码。npm 的变更说明里，bypass token 的**直接发布能力
   要到 2027-01 才收回**，而这条 403 消息本身就把 bypass token 列为合法发布方式。

## ✅ npm 发布成功（2026-10-11 03:03 UTC）与被批准的"暂存发布"

**最终状态**：`dsh-worktodo@0.1.0` 已上线，`dist-tags.latest = 0.1.0`，发布者：维护者账号，
`/dsh-worktodo/0.1.0` 返回 200，包内含 `dsh.bundle.patch` 与 `dsh.client`。

### 一个重要的机制发现：bypass-2FA token 的 `pnpm publish` 会走「暂存发布」

第一次带 bypass token 的 `pnpm publish` 打印了成功，但 registry 上只有：
`0.0.0-stage | 描述 "Temporary package placeholder for staged publishing"`，而 `0.1.0` 查不到。
读 npm 官方文档（`content/packages-and-modules/securing-your-code/staged-publishing.mdx`）后确认：

> 当您暂存一个**尚不存在**的包时，npm 会发布一个版本号为 `0.0.0-stage` 的**占位版本**。
> 占位版本公开可见，但暂存版本及其内容在**维护者批准**前不公开。

也就是说：**npm 现在把 bypass token 的发布路由进 staging**，包名先被占位版本占住，
真正的内容要维护者在 CLI 或 **npmjs.com 的 Staged Packages 标签页**上**用 2FA 显式批准**
（网页端批准同样要 2FA——而这对 WebAuthn 型 2FA 恰好可行，命令行则不行）。

**维护者在浏览器里完成 2FA 批准后，`0.1.0` 立即上线** ✓（`dist-tags.latest` 从 `0.0.0-stage` 变为 `0.1.0`）。

### 这次顺带验证到的（之前做不到）

| 检查项 | 结果 |
|---|---|
| 已发布 tarball vs 本地构建 | `lib/client.js`、`lib/index.js` **逐字节完全相同** ✓ |
| 干净目录 `pnpm add dsh-worktodo` | 只解析 **1 个包**、**316 KB**、包内**无**嵌套 `node_modules` ✓ |
| 包内被解析的依赖 | 无 → 运行时平台包**必须**由 DSH 的拦截层提供（官方解析规范描述的行为） |
| profile 换成 registry 版本 | `dsh-worktodo: ^0.1.0`、真实目录、版本 0.1.0 ✓ |

### DSH 插件安装器的一个观察（不是本包的问题）

把包从 registry 装进 profile 后，`<profile>/node_modules/dsh-worktodo/node_modules` 里出现了
**22 MB 的开发依赖**（esbuild + 16 个 `@deepseek-ai/*`），包内还留了 `.modules.yaml` /
`.pnpm-workspace-state-v1.json`——说明安装器**以包目录为项目根额外跑了一次 install**。

用两次隔离实验排除了"我的包/我的配置"这个可能：复刻 profile 的 `pnpm-workspace.yaml`
（`nodeLinker: hoisted` + `autoInstallPeers: false`，且都触发了同样的 `minimumReleaseAgeExclude`）
后，普通 `pnpm add dsh-worktodo` 都是**干净的 316 KB、无嵌套 node_modules**。
所以这是**安装器行为**，对任何带 devDependencies 的插件都一样。

**当时的处理（❌ 错的，已在 0.1.1 更正）**：我判断"那棵 `node_modules` 只是开发依赖、运行时用不到"，
于是把它删掉，以为顺便造出了"真 registry 形态"（包内零依赖）。**这个判断是错的**——见下面那节：
删掉之后 DSH 重启时**插件直接加载失败**，因为那三个官方平台包正是运行期 import 的东西。
真正的修法是把它们从 `peerDependencies` 改成 `dependencies`（0.1.1），不是删本地副本。

## ⚠️ ⚠️ 用 `dsh plugin remove` 卸载 link 安装的插件，会清空被链接仓库的 `node_modules`

这个坑咬了我**两次**（第二次就在发布这轮），必须写下来：

**现象**：把插件以 `link:` 装进 profile 后，执行 `dsh plugin remove <包名>`（为了换成 registry 版本），
**被链接的那个仓库自己的 `node_modules` 被 prune 掉了**。随后工作区测试立刻变红：

```
5/7 个测试文件通过
Cannot find package '@deepseek-ai/dsh-storage-domain' imported from tools/verify-store.mjs
```

**原因**：`link:` 的目标被 pnpm 视作工作区成员，profile 的 hoisted 安装会连带管理（并 prune）它的依赖树；
该仓库已不在 profile 的依赖里时，它的 devDependencies 就成了"多余"，于是被清掉。

**恢复**：在仓库里重跑一次即可（本项目用 `--frozen-lockfile`，lockfile 与配置一致）：

```bash
pnpm install --frozen-lockfile      # 之后 9/9、166 例恢复全绿
```

**给插件开发者的提醒**：开发期用 `link:` 装插件很方便，但**每次卸载/换装都要准备好重跑一次
`pnpm install`**。第一次踩到时还以为是配置问题，白查了一圈。

## 发布产物 vs 工作区：逐文件比对（第十六轮）

把 npm 上的 tarball 解出来，与工作区逐个文件比对（18 个文件）：

| 结果 | 文件 | 原因 |
|---|---|---|
| **完全相同** | **15 个**（含 `lib/index.js`、`lib/client.js`、`src/` 全部源码、`cordis.patch.yml`、`icon.svg`、`locale/`、`CHANGELOG.md`、`LICENSE`） | — |
| 不同 | `README.md`、`README.en.md` | 我在**发布之后**又补了内容（安装体积的说明、`docs/releasing.md` 指针）；下次发版会刷新 |
| 不同 | `package.json` | 见下 |

**`package.json` 的那个差异值得记**：发布包里 **没有 `prepublishOnly`**（工作区有）：

```
发布包 scripts: build / watch / test
工作区 scripts: build / watch / test / prepublishOnly
```

也就是说 **pack 时把发布期钩子从清单里剥离了**（其余字段逐字相同，`dependencies: {}`、`files`、`devDependencies` 全一致）。
这是预期行为——`prepublishOnly` 只在**发布者仓库里**、**发布那一刻**生效；而且它确实跑了
（`pnpm publish --dry-run` 的输出里就是它的命令：`node tools/build-client.mjs && node tools/verify-all.mjs`）。
用户装到的包不该带发布钩子，所以这个"差异"反而是对的。

## 隐私审计：两个公开面都过了一遍（第十六轮，用户提出）

用户的担心很具体：**"别把我无关的数据一起打包上传了。"** 这件事必须查，因为 npm 上的包**已经公开**，
而 git 仓库一旦推送也公开。审计覆盖两个面：

| 面 | 范围 | 状态 |
|---|---|---|
| ① npm 发布包 | 18 个文件（`files` 字段 + `package.json`） | 已上传、**已公开** |
| ② git 跟踪文件 | 38 个文件 | 即将公开 |

### 扫描了什么

家目录绝对路径、当前用户名（**运行时取 `os.userInfo().username`**，所以检测代码本身不含任何人的名字）、
npm / GitHub token 形状、`_authToken=` 赋值、云厂商密钥、私钥块、私人邮箱、真实 IP（放行 RFC 5737 文档段）、
会话 id 形状。

### 发现与处理

| 发现 | 处理 |
|---|---|
| **`docs/releasing.md` 里有维护者真实的家目录路径**（写命令示例时带进去的） | 改成 `cd <本仓库目录>` |
| 文档 / workflow 里出现了**维护者的 npm 账号名**与**其 2FA 的具体方式** | 全部中性化（"维护者账号"、"WebAuthn 型 2FA"） |
| `README.md` / `README.en.md` / `cordis.patch.yml` 里的 `/Users/me/...` | **无需处理**：是虚构示例路径 |
| 构建产物的 source map 是经典的绝对路径泄露点 | **确认干净**：`sources: ['../src/client/index.js']`（相对路径），无 `sourceRoot` |
| 密码、token、IP、主机名、会话 id | **两个面都零命中** |
| `olimc2016` | **保留**：这是公开的仓库所有者身份，安装命令与收录 JSON 里必须出现 |

### 永久门禁：`tools/verify-privacy.mjs`

一次性清理不够——**这类泄露不会让测试变红、也不会让程序报错，只会静默公开**。所以加了一道门禁，
已接入 `pnpm test`（现为 9 个测试文件、166 例），对两个公开面逐条扫描，共 **24 项检查**。

并且**验证了这道门禁有牙齿**：临时把一个含 5 类违规的探针文件加入 git 索引，门禁立刻变红并精确指出
每一处（家目录路径、npm token 形状、私人邮箱、会话 id 形状、真实 IP 各一条），退出码 1；
清理后恢复 24 项全绿、退出码 0。第二轮投毒（写入真实用户名）同样被抓，
同时确认 RFC 5737 文档段 IP 被正确放行。

> 有意思的是：**这道门禁把本文档自己拦下过一次**——因为我在"证据"里原样写出了那几类模式的字面量。
> 所以下面与上面描述违规样本时一律用占位符（`/Users/<名字>`、`<名字>@<域名>`、`session-<十六进制>`），
> 这也是使用这道门禁时要习惯的写法。

**结论**：`package.json` 的 `files` 白名单 + `.gitignore` 挡住了"不该上传的文件"，
这次门禁则挡住了"文件里不该有的内容"。两道一起，才是"上传安全"。

## 唯一还没验证的一项：面板的**视觉**呈现（以及我为什么做不到）

其余所有项都有实证（见上文各节）。**只有"面板长什么样"我没看过**，这里把边界写清楚，
免得读者以为它被验过了：

**我尝试过的手段**：
- 本机**有** Google Chrome（可以无头截图）✓；
- 但 GUI `GET http://127.0.0.1:19387` 返回 **401**：`dsh web authentication required; reopen the URL printed by dsh web`；
- 那个带令牌的 URL 只存在于**正在运行的 App 内部**（用户的浏览器标签上）；日志、
  `~/Library/Logs`、`/tmp`、`~/Library/Application Support/DeepSeek Harness` 里都没有落盘；
- **不会**为了截图另起一个 `dsh web`：那会是第二个实例、可能同时写同一份工作待办存储，
  而且不属于用户要求的动作。

**我能证明的（替代证据）**：bundle 是官方 `window.__ModuleLoader__.load({id, factory})` 懒加载
CommonJS 工厂形态（契约测试断言）；`dsh.client` 声明齐全（platform=web、inject 非空）；
slot 注册路径与 locale 注册在客户端烟测中被执行且首屏渲染不抛异常；面板挂载后确实请求
`/worktodo/list`。**这些能证明它不会崩、会去拉数据，但不能证明它"看起来对"**——布局、
`--dsw-*` 配色、中文文案是否合眼，只有人看才知道。

**怎么补上（用户侧约 5 秒）**：打开 DSH → 侧栏找「工作待办 / Todo」标签页 → 看一眼面板是否
正常出现（新增一条待办、切一次"逾期"/"本周"过滤）。愿意的话截一张图放进 `docs/shot-panel.png`，
README 与收录材料就能引用它。

**同理，还有一项也要重启才生效**：运行中的实例仍是**旧模块 generation**，所以
`worktodo_add` 不传截止日期时仍会报旧的 `value is not lossless JSON`；修复已在已发布的
0.1.0 里（发布包 `src/tools.mjs` 含 `compact`，且已逐字节比对），**重启 DSH 即生效**。

## CI workflow 契约测试（第二十轮）

`tools/verify-workflows.mjs`，11 项。**为什么值得有**：`.github/workflows/` 是**唯一无法在本地执行**的部分——
它的错误只会在推 tag 之后暴露；更坏的情况是 YAML 坏了 → workflow **静默不触发**，
而人会以为是 npm 或 Trusted Publisher 绑错了，白白排查。

它钉住的东西：

| 检查 | 为什么是它 |
|---|---|
| `id-token: write` 存在 | 少了这行，OIDC 拿不到 token，Trusted Publishing 必然失败 |
| 触发条件含 `tags: 'v*'` 与 `workflow_dispatch` | 保证推 tag 会跑、也保留手动入口 |
| 步骤里确实有 `run: npm stage publish` 与 `run: npm publish` | **注意**：最初我写成匹配 `npm stage publish`，结果**匹配到了文件头注释里的同名文字**而假通过——断言必须锚定 `run:` |
| 顺序：锁文件安装 → 测试 → 构建 → 发布 | 顺序错了会发出没测过的产物 |
| 所有 `uses:` 固定大版本 tag | 不用浮动分支 |
| `test.yml` 覆盖 node 22/24、用 pnpm 而非 npm install、会跑 pack | 与文档承诺一致 |
| 无 tab 缩进 | YAML 把 tab 当语法错误 |

并且**条件是"有 ruby 才真解析 YAML"**：本机（与 GitHub 的 ubuntu runner）都有 ruby，于是会额外跑一次
`YAML.load_file` 真解析；没有 ruby 的机器会跳过并打印说明，而不是假绿。

**投毒验证**：删掉 `id-token: write` → 被抓；给 `test.yml` 注入 tab → 被"tab 检查"和"ruby 解析"同时抓到；
还原后 11/11 全绿。

## 发布后的外部核对：**暂存发布不会写入 registry 的 README**（第二十二轮）

发布成功之后我又从 registry 侧核对了一遍"用户实际看到什么"，抓到一个只有比对才能发现的问题：

| 包 | 发布方式 | packument 顶层 `readme` | `readmeFilename` |
|---|---|---|---|
| `dsh-token-meter-panel@0.6.4`（维护者的另一个包，作为**对照组**） | 普通 `publish` | **8193 字符** | `README.md` |
| `dsh-worktodo@0.1.0` | **暂存发布**（`npm stage publish` + 人工批准） | **0 字符** | `''` |

而 `dsh-worktodo-0.1.0.tgz` 里 **`README.md` / `README.en.md` 都在**（`tar tzf` 已确认）。
两个包都是同一台机器、同一个 pnpm 发布的，**唯一变量是"直接发布 vs 暂存发布"**。

**结论与影响**：registry 的 `readme` 字段是包页面渲染 README 的来源；它为 0，意味着
**npm 包页面很可能没有任何 README**——对一个以"能被搜到、能有人装"为目标的插件，这是实打实的损失。
（npm 官网页面本身我验证不了：`www.npmjs.com` 对自动化抓取返回 403 Cloudflare 挑战。）

**修正路径**（记在 `docs/releasing.md`）：
1. 下一个版本走**直接发布**（`npm publish`，OIDC 下不需要人类 2FA），而不是暂存发布；
2. 每次发布后用一条命令核对 `readme` 是否非空：

```bash
curl -s https://registry.npmjs.org/dsh-worktodo | python3 -c "import json,sys; d=json.load(sys.stdin); print('readme 长度:', len(d.get('readme') or ''))"
```

3. 顺便：该版本还会带上本仓库已修好的文档（三份文档里的绝对仓库地址说明）——
   因为 npm 页面显示的正是 registry 里那份 README。

## 推送成功 + 真实 GitHub 安装验证（第二十三轮）

仓库 `olimc2016/dsh-worktodo` 已推送（`main -> main`），**远端 40 个文件**，
`package.json` / `cordis.patch.yml` / `lib/index.js` / `lib/client.js` / `src/client/index.js` / `README.md` / `LICENSE`
逐个用 `git cat-file -e origin/main:<path>` 核对存在 ✓。

**最后一条没验过的安装路径也验通了**（之前是对着本地忠实模拟仓；这次是**真远端**）：

```
$ pnpm add github:olimc2016/dsh-worktodo
+ dsh-worktodo 0.1.0        （316 KB，包内无嵌套 node_modules，lib/client.js 在，
                             dsh.bundle.patch = ./cordis.patch.yml）
```

### 细粒度 token 做不了的两件事（都实测确认，非猜测）

| 操作 | 结果 | 原因 / 替代 |
|---|---|---|
| `PUT /repos/.../topics` 设话题 | **403** `Resource not accessible by personal access token` | 话题需要额外的 Administration 权限 → 改用网页 About 齿轮里填（10 秒）。**这件事有意义**：DSH Plugin Hub 就是靠 `dsh-plugin` 话题自动发现的 |
| `POST /repos/imsai-sh/awesome-deepseek-harness-plugins/forks` | **403** 同上 | 细粒度 token 不能 fork 别的仓库 → 收录 PR 要么网页点几下，要么换 classic `repo` token |

（同一个 token 的仓库权限是 `admin/maintain/push/triage/pull` 全真，推送正常——所以这是**权限类别**问题，不是 token 坏了。）

## CI 发布路径**首次真跑**（第二十三轮）：测试绿了，npm 侧认证没过

这是 `publish.yml` 第一次在真实仓库上跑，结果把两个问题一次暴露出来（这正是它存在的意义）：

### ① 先修掉两个自身缺陷（都已修并推送）

| 现象 | 根因 | 修法 |
|---|---|---|
| `test` workflow 每次 push 都红 | `smoke-host` 里**硬编码**了 `eq(body.version, '0.1.0')`，改版本号即红 | 改成从 `package.json` 动态读 |
| 修完仍红 | 发布面审计用**当前用户名**扫文件；CI 的用户名是通用词 `runner`，与文档里正常的 "ubuntu runner" **误撞** | 该规则改为**仅在开发者本机生效**（CI 跳过并打印说明）；与用户名无关的「家目录绝对路径」规则在任何环境照查。检查条数在两侧一致（30 项） |

修完后 `test` workflow **成功** ✓（这本身也验证了 CI 的工具链与 9 个测试文件在 Linux/Node 22+24 下都能跑）。

### ② 发布步骤被 npm 拒绝：**Trusted Publisher 没生效**

`publish` workflow 的步骤结论：检出 ✓ → 安装 ✓ → 测试 ✓ → 构建 ✓ → **Publish ✗**。日志原文：

```
npm notice name: dsh-worktodo      npm notice version: 0.1.1
npm notice filename: dsh-worktodo-0.1.1.tgz
npm notice package size: 79.3 kB    npm notice total files: 18
npm notice publish Signed provenance statement with source and build information from GitHub Actions
npm notice publish Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=3199540291
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/dsh-worktodo - Not found
npm error 404  'dsh-worktodo@0.1.1' is not in this registry.
```

**读法**：打包与 provenance 都正常（provenance 用的是 GitHub 的 OIDC，与 npm 认证无关，所以它成功**不能**证明绑定生效）；
`404 … is not in this registry` 是 npm 对**未认证发布**的典型回应——也就是 **npm 没把这次 OIDC 身份认成该包的 trusted publisher**。

两种可能，都要在网页上核对：
1. **绑定字段与实际不符**（最常见是 **workflow filename** 写成了别的值，或仓库/owner 写错）；
2. **绑定只允许 `npm stage publish`**（`npm trust` 的 `--allow-publish` / `--allow-stage-publish` 之分）——
   那么直接发布会像上面这样被拒，必须把 `npm publish` 也允许。

**顺带查到的**：`GET https://registry.npmjs.org/-/package/<pkg>/trust` 这个接口**存在**（返回
`401 Bearer token authorization is required`），但需要 npm 凭据；没有公开的匿名查询方式，所以核对只能看
<https://www.npmjs.com/package/dsh-worktodo/access>。

## ❌→✅ 插件启动失败：只声明 `peerDependencies` 是错的（0.1.1 修复）

**用户报告**：「代办启动失败了」。实测确认插件确实没加载——我自己的工具调用直接报
`Error: unknown tool "worktodo_list"`（工具全没了）。

### 根因

profile 里装的是 registry 版、而我此前删掉了包内的 `node_modules`，于是从安装位置解析平台包直接失败：

```
✗ ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
  imported from ~/.dsh/profiles/desktop/node_modules/dsh-worktodo/
```

而且 **profile 根目录的 `@deepseek-ai/` 是空的**——也就是说在这个 DSH 版本里，
**运行期并不会替插件提供平台包**；插件必须自己带上，或者被 `link:` 到有 `node_modules` 的目录。

### 修法（照"能正常工作的那个插件"来）

对照 `dsh-token-meter-panel`（一直在正常工作）的声明方式：

```json
"dependencies": { "@deepseek-ai/dsh-home-paths": "^0.2.0-rc.2", "@deepseek-ai/schemastery": "^3.18.2" }
```

于是把运行期真正 import 的三个平台包从 `peerDependencies` 移到 `dependencies`：

| 包 | 用途 |
|---|---|
| `@deepseek-ai/dsh-tools` | `defineTool` |
| `@deepseek-ai/dsh-storage-domain` | `defineDomain` |
| `@deepseek-ai/dsh-home-paths` | 存储路径 |

（`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tool-todo` 只出现在 **JSDoc / 注释**里，不是运行期 import，
所以 cordis 仍作为可选 peer 保留，`dsh-tool-todo` 根本不声明。）

### 实测验证

| 检查 | 结果 |
|---|---|
| 从 GitHub 安装（`pnpm add github:olimc2016/dsh-worktodo`） | 顶层 1 个包 + 3 个官方平台包 ✓ |
| 从**插件自身位置** import 三个平台包 | **全部可解析** ✓（修复前全部 `ERR_MODULE_NOT_FOUND`） |
| profile 侧（`link:` 形态） | 三个包全部可解析 ✓ |
| 安装体积 | 约 **12 MB**（其中约 8 MB 是官方 `dsh-tools` 依赖的 zod）——README 里的 "316 KB / 零依赖" 表述已按实测更正 |

**教训（值得记住）**：官方文档说"平台包由运行时提供、不要声明为依赖"，但**这个 DSH 版本的实际行为不是那样**
（profile 根的 `@deepseek-ai/` 是空的，实测启动失败）。**能工作的那个插件怎么声明，就怎么声明**——
同机对照比文档更可靠。此外：**"零依赖"是个诱人但危险的卖点**，它把"装出来能不能跑"赌在了一个未验证的运行时行为上。

## 回滚方式

```bash
# 移除插件（或在 DSH 面板「已安装」里卸载）
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --expose-internals \
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" \
  plugin --profile desktop remove dsh-worktodo
```

安装前的 profile 清单备份在 `/tmp/desktop-profile-package.json.bak`。
卸载后待办数据仍留在 `~/.dsh/storages/worktodo.json`（不会随插件删除而丢失，这是有意的）。
