# 重复平台包导致桌面版启动失败：结论、修复与验证

- 日期：2026-10-18
- 仓库：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`
- 基线：HEAD `c9b361c`（工作区另有本轮未提交改动）；版本保持 `0.2.7`，**未发版、未提交**
- 现象：用户 Windows 桌面版启动失败 ——「1 required plugin did not activate」+ 16 个插件等待
  `tools` / `storageDomain` / `workspaceRegistry`；同机 `dsh web` 正常（web profile 没装社区插件）
- 桌面 profile 装的社区插件：`dsh-worktodo` 0.2.5、`dsh-token-mb` 0.6.6
- 触发点：2026-10-17 应用自动更新（宿主平台包随之变化）

## 1. 结论

**确认存在这个缺陷，且它是本轮启动失败最可能的根因；但不是 100% 结案。**

三条都已坐实：

1. **发布形态确实会装出第二份平台包。** 已发布的 0.2.5 / 0.2.6 清单里，
   `@deepseek-ai/dsh-tools`、`dsh-storage-domain`、`dsh-home-paths` 都在 `dependencies`；
   pnpm 会把它们装进 profile 的 `node_modules`（本轮用真实 tarball 复现，见 §3）。
2. **第二份确实会盖住宿主自带的那份。** DSH 0.2.1 的 profile resolution 对「从 profile 层发出的
   bare import」优先选**本层本地候选**，其次才是 installation 条目；profile 根多了同名包就赢。
   实测同一份 tarball：带 `dependencies` 时，插件里 `@deepseek-ai/dsh-tools` 解析到
   **profile 内的 0.2.0-rc.2**；不带时解析到**宿主层 0.2.1-rc.2**。
3. **宿主有一个 required 条目正好叫 `@deepseek-ai/dsh-storage-domain`。** 基础 bundle 的
   patch 里 `storage-domain` 条目的 `name` 就是这个包名；profile 里出现同名包后，该 required 条目
   会加载 profile 里的 0.2.0-rc.2，而不是宿主的 0.2.1-rc.2。这与报错里缺 `storageDomain`
   以及「1 required plugin did not activate」的形状吻合；`tools` / `workspaceRegistry` 的等待
   可作为下游级联解释。

**为什么仍留一点不确定**：用户只贴了诊断的标题行。DSH 的完整诊断还会列出
`Failed plugins`（含条目 id、包名、原始异常）和每个 waiter 缺的服务；拿到那一段才能把
「具体是 storage-domain 条目抛了什么」钉死。本轮没有 Windows 机器，也没有失败现场的日志。
但这不影响修复方向：**包里唯一能产生第二份平台包的就是这三个 `dependencies`，它必须被移除。**

## 2. 证据链

### 2.1 宿主版本与平台包版本

| 项 | 值 | 来源 |
|---|---|---|
| 桌面运行时 | `@deepseek-ai/dsh-desktop-runtime` 0.2.1-rc.2 | 安装包内 `app.asar/dsh/package.json` |
| 宿主自带 `dsh-tools` / `dsh-storage-domain` / `dsh-home-paths` | 0.2.1-rc.2 | 同上，`dsh/node_modules/@deepseek-ai/*/package.json` |
| 插件 0.2.5 的 `dependencies` | 三个平台包（`^0.2.0-rc.2`） | `npm view dsh-worktodo@0.2.5`（npmjs） |
| 插件 0.2.6 的 `dependencies` | 同上 | `npm view dsh-worktodo@0.2.6`（npmjs） |
| pnpm 对 `^0.2.0-rc.2` 的实际选择 | **0.2.0-rc.2** | 本轮 profile 模拟（§3），宿主为 0.2.1-rc.2 |

也就是说，失败现场大概率是「**宿主 0.2.1 + profile 里另有一份 0.2.0**」的混装形态。

### 2.2 DSH 的解析顺序（决定性的一段）

从安装包 `app.asar` 内读到的实现（只读检查，未修改安装目录）：

- `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js`
  - `computeProfileLayer(dir, active)`：profile 的本地前缀就是 `dir`（即 `$DSH_HOME/profiles/<name>`），
    本层搜索路径是 `<profile>/node_modules`。
  - `routeScoped(...)`：先跑 `createRequire(parent).resolve.paths(name)` 找 **local candidates**，
    命中就 `kind: "native"` 直接用；全部没命中才回落到 `resolution.entries`（installation / profile 条目）。
    换句话说：**profile 里有一份同名包，从 profile 发出的 import 就读它，不会读 installation 的那份。**
- `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`
  - `boot()` 把 `ctx.baseUrl` 设为 profile 配置文件所在目录，root include 里的插件条目按这个 base 导入。
  - `collectProfileScopePackages` / `dependencyClosure` 会沿 profile 包的 `dependencies` +
    `peerDependencies` 建依赖闭包；这正是「插件声明什么，profile 就多出什么」的入口。
  - `unmetRequirements`：`@deepseek-ai/dsh-*` 的 peer 范围会用 `includePrerelease: true`
    对照运行时版本，所以 `^0.2.0-rc.2` 对 0.2.1-rc.2 是满足的（不会因 peer 范围被拒）。
- `dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`
  - 有 `id: storage-domain`、`name: '@deepseek-ai/dsh-storage-domain'` 的条目；
    profile 里出现同名包后，解析会选 profile 那份。

> 上述文件在公开仓库里看不到（在安装包 `app.asar` 内）。本轮用脚本按 asar 头把需要的
> JS / YAML 只读抽出到 `/tmp` 核对，没有改安装目录。

### 2.3 为什么不是「版本范围写错」而一定是「多带一份」

peer 范围 `^0.2.0-rc.2` 在 `includePrerelease: true` 下覆盖 0.2.1-rc.2，DSH 的兼容性闸门不会拒。
真正的问题是**包里带了实体副本**：pnpm 装进 profile，Node 解析从本层开始，宿主那份就被绕过。
这也是官方规范里「需要与宿主共享实例的 dsh 包要同时放在 `peerDependencies` 与
`devDependencies`，不要放 `dependencies`」的原因（`docs/verification.md` 顶部已记录）。

## 3. 依赖改动前后

### 3.1 `package.json`

| 包 | 改动前 | 改动后 |
|---|---|---|
| `@deepseek-ai/dsh-tools` | `dependencies: ^0.2.0-rc.2` | `peerDependencies: ^0.2.0-rc.2` + `optional: true` + `devDependencies: 0.2.0-rc.2` |
| `@deepseek-ai/dsh-storage-domain` | 同上 | 同上 |
| `@deepseek-ai/dsh-home-paths` | 同上 | 同上 |
| `@deepseek-ai/cordis` | `peerDependencies: ^4.0.2` + optional | **原样保留** |
| 其它 `@deepseek-ai/*` | —— | `dependencies` 里现在为 **0 个**（`dependencies: {}`） |

- 三个平台包全部标 `optional`：解析不到时表达的是「降级成只有面板」，而不是安装失败。
- **加进 `devDependencies` 是刻意的**：仓库测试要 import 它们（`verify-store` / `smoke-host`），
  若不进 devDependencies，干净环境 `pnpm install` 会因它们只被 peer 声明而不装，测试会
  `ERR_MODULE_NOT_FOUND`。这也符合 DSH 官方规范「peer + dev 同时声明」。
- `pnpm-lock.yaml` 同步把这三项从 importer 的 `dependencies` 移到 `devDependencies`
  （版本与 integrity 不变，diff 只有 9 增 10 删）；`pnpm install --lockfile-only --frozen-lockfile`
  在离线状态通过，说明 lockfile 与清单一致。

### 3.2 文档同步

- `README.md` / `README.en.md`：删掉「平台包必须是 dependencies」的旧结论，改成
  「optional peer、由 DSH 提供、解析不到只降级」，并说明 0.1.x 为什么曾经反过来。
- `docs/verification.md`：给 0.1.1 的「peer 是错的」历史结论加 **0.2.7 更正**，
  保留历史记录但明确它只适用于 0.2.1 之前的 DSH。
- `docs/listing.md` / `docs/submission.md`：去掉「约 12 MB / 顶层 3 个平台包」的旧实测描述，
  改为「顶层只有本插件，平台包由 DSH 提供」。
- `CHANGELOG.md` 未改（按约定由 Lead 发版时处理）；版本号未动。

## 4. profile 模拟：第二份是否消失、解析到哪一份

### 4.1 环境

用真实 tarball + 真实 pnpm 模拟 DSH profile 的两层结构（平台包放在 profile 的父级
`profiles/node_modules`，与 DSH 的拦截层一致）：

```
/tmp/wt-sim/
  profiles/                         # 宿主安装层（installation 拦截层替身）
    package.json                    # 三个平台包 0.2.1-rc.2
    node_modules/@deepseek-ai/...   # dsh-tools / dsh-storage-domain / dsh-home-paths
    desktop/                        # 模拟一个 profile
      package.json                  # 只依赖 dsh-worktodo 的 tarball
      node_modules/dsh-worktodo/    # pnpm 从 tarball 装出来的
    desktop-bad/                    # 反向样本：tarball 里带 dependencies
```

命令（`node`/`pnpm` 均用本机 DSH 运行时自带的版本）：

```bash
node <pnpm.cjs> pack --pack-destination /tmp/wt-pack
# 修好的 tarball 的 package.json：dependencies = {}，三个平台包是 optional peer
cd /tmp/wt-sim/profiles && node <pnpm.cjs> install
cd /tmp/wt-sim/profiles/desktop && node <pnpm.cjs> add /tmp/wt-pack/<固定版 tarball>
# 反向样本：解包后把三个包塞回 dependencies，再 pack 成另一份 tarball，装进 desktop-bad
```

### 4.2 结果

| 检查 | 修好后 | 改坏后（dependencies 形态） |
|---|---|---|
| profile 的 `node_modules` 顶层 | 只有 `dsh-worktodo` | 多出 `node_modules/@deepseek-ai/{dsh-tools,dsh-storage-domain,dsh-home-paths,...}`（7 个包） |
| 插件目录内 `node_modules` | **不存在** | 不存在（pnpm hoisted 到 profile 顶层，正是问题） |
| 插件内 ESM 解析 `dsh-tools` | `profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js` | `desktop-bad/node_modules/@deepseek-ai/dsh-tools/lib/index.js` |
| 解析到的版本 | **0.2.1-rc.2（宿主）** | **0.2.0-rc.2（profile 副本）** |
| CJS `createRequire(plugin/lib/index.js).resolve` | 同上，三条都指向 `profiles/node_modules` | 同上，指向 profile 副本 |
| 反向静态断言 | 绿 | **红**（`verify-submission` exit 1，见 §5） |

三条平台包的解析路径都落在 profile 的父级宿主层，且没有任何一条落在 `desktop/node_modules` 内；
`desktop/node_modules/dsh-worktodo/node_modules` 不存在。

结论：**修好后 profile 里不会再出现第二份平台包；插件 import 会解析到宿主那一份 0.2.1-rc.2。**
改坏后第二份出现，并**真的**抢在宿主前面被解析到（不是理论推断）。

## 5. 门禁与反向验证

### 5.1 新增/改了哪些门禁

- `tools/verify-submission.mjs`
  - 新测试「平台包只能是可选 peer」：
    - `dependencies` 里不得出现任何 `@deepseek-ai/*`；
    - 三个平台包必须在 `peerDependencies` 且 `peerDependenciesMeta.optional === true`；
    - 扫描 `lib/index.js` + `src/*.mjs`：**不允许**模块顶层静态 import 非 `node:` 包
      （否则平台包缺失 = 模块求值失败，可能连累宿主）；运行期动态 import 的 bare 包集合
      必须恰好等于这三个平台包。
  - 反向自检：用 `structuredClone` 式的副本把 `dsh-tools` 塞回 `dependencies` / 从 peer 移走，
    断言校验器会报错。**故意改坏 package.json 实跑过**：`verify-submission` exit 1，
    错误信息为「`@deepseek-ai/dsh-tools` 出现在 dependencies（安装时会多出第二份）」；
    恢复后 18/18 通过、exit 0。
- `tools/smoke-host.mjs` 新测试「平台包全部不可解析：apply 不抛、只降级」：
  - 把 `lib/`、`src/`、`package.json` 复制到 `/tmp`（父目录链上没有平台包），子进程里用假 ctx
    （故意提供 `storageDomain` + `tools`，逼它真的去 import 平台包）跑 `apply()`；
  - 断言：`apply()` 不抛；日志出现「工具未注册」「官方存储打开失败」「回退到 JSON 文件」；
    子进程 exit 0。成功后输出 `RESILIENT_OK`。
- `tools/verify-privacy.mjs` 修了一个**本轮之前就存在**的误报：`/tmp/.../home/.dsh` 被
  `/\/home\//` 当成家目录泄露（`docs/reviews/stability-0.2.7.md`）。规则改为要求路径边界
  `(?<![\w.~-])`，`/home/<user>`、`/Users/<user>` 仍会被抓（占位写法在隐私门禁里放行）；这不是本轮启动失败的一部分，
  但不修的话门禁基线就是红的。

### 5.2 两套门禁

| 门禁 | 结果 |
|---|---|
| 本机：`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` | **10/10，exit 0**（`smoke-host` 119 例、`verify-submission` 18 例…） |
| 干净环境：`env -i HOME=/tmp/cihome PATH=<node目录>:/usr/bin:/bin CI=true ...` | **10/10，exit 0** |

两套都显式检查了退出码（`echo exit=$?`），不是只看最后一行。
基线（改动前）其实是 9/10：`verify-privacy` 被上面那处误报卡红；修复后两套都是 10/10。

## 6. `apply()` 抗失败设计

### 6.1 现状：平台包已经不在模块顶层 import

| 位置 | 代码 | 失败时 |
|---|---|---|
| `src/store.mjs:100` | `const official = await import('@deepseek-ai/dsh-home-paths')` | `try/catch`，回落到 `$DSH_HOME` / `~/.dsh` |
| `src/store.mjs:429` | `const { defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain')` | 在 `createDomainBackend` 内，外层 `tryUpgrade` 捕获 → 留在 JSON 后端并报 `mismatch` |
| `src/tools.mjs:44` | `const { defineTool } = await import('@deepseek-ai/dsh-tools')` | `registerWorkTodoTools` reject → `apply()` 里 `.catch` → `toolState.status = 'failed'` + `logger.warn` |

`lib/index.js` 顶层只 import 本地模块与 `node:` 内建；`src/*.mjs` 的顶层也只有本地模块。
`apply()` 里打开存储失败会降级成 `store.kind = 'unavailable'` 的显式错误对象，面板/`/health`
能看见原因，而不是让整个插件挂不上。

### 6.2 取舍

- **不在模块顶层求值平台包**：代价是「缺包」只能在用到时才发现，错误晚一点；收益是
  **插件加载阶段永不因平台包失败**。对一个需要与宿主共享实例的插件，这个取舍是对的：
  加载失败会把宿主一起拖下水（正是本轮要避免的），而降级只影响本插件的工具/官方存储能力。
- 不能用 `try { import } catch` 包住**静态** import（ESM 语法不允许），只能把它们放到函数里
  动态 import；现有代码已经这样，本轮用测试把这条形态钉死（谁改回顶层静态 import，
  `verify-submission` 立刻红）。
- 仍有边界：如果宿主在**加载插件模块本身**时就因为别的原因失败（JSON 坏、语法错），
  插件侧无法兜底；这不在本轮范围。

## 7. 未做 / 不确定

1. **没有在 Windows 失败现场复现完整 boot。** 本机 DSH CLI 明确拒绝启动 desktop profile
   （`profile "desktop" is managed exclusively by the Electron application`），且 0.2.1 的
   部分平台包没有全部发到 npmjs（例如 `@deepseek-ai/dsh-invariants` 只到 0.2.0-rc.2），
   无法在 `/tmp` 拼出一套完整的 0.2.1 installation 闭包来做真 boot。
   因此「到底哪个 required 条目、抛了什么」需要用户提供诊断里的 `Failed plugins` 段。
2. **用户机器上的宿主版本是推断的**：按 2026-10-17 自动更新推断为 0.2.1-rc.2；
   若实际是别的版本，「0.2.0 副本 vs 宿主 x.y」的具体冲突表现可能不同，但
   「profile 多一份、解析优先本层」这个机制不变。
3. **未改 `dsh-token-mb`**：它仍把 `@deepseek-ai/dsh-home-paths` 放在 `dependencies`。
   `dsh-home-paths` 是无状态路径工具，危害远小于 `storage-domain`；但同样的形态值得它自己的
   维护者处理，不在本仓库写域内。
4. **未发版、未提交、未打 tag。** 修复要等 Lead 发一个包含本轮改动的版本；用户装着的 0.2.5
   不会自动变好。
5. 版本号保持 `0.2.7`，`CHANGELOG.md` / `.github/` 未动（按约定由 Lead 处理）。
