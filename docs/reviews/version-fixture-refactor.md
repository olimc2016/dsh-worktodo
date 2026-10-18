# 测试夹具「模拟版本」集中化（修发版假红）

- 仓库：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`
- 版本：`package.json` **仍为 0.2.7（本次没有改动版本号）**
- 触发：升到 0.2.7 时用脚本把 `tools/smoke-host.mjs` 里独立的 `'0.2.7'` 批量替换成
  `FAKE_NEXT_VERSION`，**没改全**，全量测试变成 9/10。
- 报告里的路径一律写 `~/...`。

---

## 1. 现象（修之前）

`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` → **9/10**，红的都在 `smoke-host.mjs`：

| 用例 | 报错（摘要） |
| --- | --- |
| 自升级（核心）：pnpm update no-op → 第 2 步交 pnpm add 精确版本… | `add 必须指名精确版本：["add","dsh-worktodo@0.2.8",…] 期望 true，实际 false` |
| 自升级：拿得到官方 CLI 时走 dsh plugin … | `CLI 真换掉版本就该 done（实际 failed，error=安装命令退出码 1（pnpm add dsh-worktodo@0.2.8 …）；且落盘版本未变）` |
| 自升级：buildUpdateSteps 的步骤顺序… | `期望 "add dsh-worktodo@0.2.7 --save-exact …"，实际 "add dsh-worktodo@0.2.8 --save-exact …"` |

即 `smoke-host` 自己是 100 通过 / 3 失败。

## 2. 根因（已确认，共 5 处漏改 + 1 处被脚本改坏）

`PKG_VERSION` = 0.2.7、`FAKE_NEXT_VERSION` = 0.2.8。代码/假 pnpm 用的都是 `FAKE_NEXT_VERSION`（0.2.8），
但下面这些**字符串字面量**还停在 0.2.7：

1. 核心用例断言：`invocations[1].includes('dsh-worktodo@0.2.7')` → 实际 argv 是 `dsh-worktodo@0.2.8`。
2. `buildUpdateSteps` 用例：期望整条命令 `add dsh-worktodo@0.2.7 --save-exact …`。
3. A3 回滚夹具：`replaceAll('"^0.2.0"', '"0.2.7"')` 把「pnpm 改写后的规格」写成了旧值。
4. **被脚本改坏的生成脚本**：假 CLI 的源码是模板串里的**字面文本**，
   `JSON.stringify({ name: 'dsh-worktodo', version: FAKE_NEXT_VERSION }, null, 2)` 不在 `${}` 里，
   于是子进程里执行到未定义标识符 `FAKE_NEXT_VERSION` → ReferenceError → 退出码非 0 →
   代码正确地退回 pnpm 兜底并落 failed。这条不是断言期望值问题，而是夹具本身被改坏。
5. Windows 段用例的 `target: '0.2.6'`（模拟目标版本，虽不参与断言，但属于同类字面量）。

另有多处注释直接写死当前版本号（如「registry latest 0.2.7」「规格留在 0.2.7」），会误导下一位读者。

结论：**根因就是「模拟目标版本」既有派生常量、又有残留字面量**，两套值在发版后不再相等。

## 3. 修法：唯一来源 + 全部引用

### 3.1 常量集中（`tools/smoke-host.mjs` 顶部）

```js
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const FAKE_CURRENT_VERSION = PKG_VERSION;                  // 当前版本的显式别名（语义可读）
const FAKE_NEXT_VERSION = bumpPatch(PKG_VERSION, 1);       // 模拟的「registry 新版本」
```

- 删掉了文件里重复的模块级 `pkgVersion`（原 ~77 行）和 `/list` 用例里的函数级同名遮蔽（原 ~844 行）。
- 全文件统一用 `PKG_VERSION`（11 处引用），不再有第二份「从 package.json 读版本」的代码。
- 约定写进常量注释：**历史老版本**（如 `'0.2.0'`，模拟「已装的老版本」）保持字面量——
  它远低于当前版本、语义是「旧」，不会因发版过期；**升级目标/新版本**一律 `FAKE_NEXT_VERSION`。

### 3.2 逐处替换（5 处代码）

| 位置 | 改动 |
| --- | --- |
| 核心用例断言 | `'dsh-worktodo@0.2.7'` → `` `dsh-worktodo@${FAKE_NEXT_VERSION}` `` |
| `buildUpdateSteps` 期望命令 | `'add dsh-worktodo@0.2.7 …'` → 模板串插值 `FAKE_NEXT_VERSION` |
| A3 回滚夹具 | `'"0.2.7"'` → `` `"${FAKE_NEXT_VERSION}"` ``（两处 replaceAll） |
| 假 CLI 生成脚本 | 字面量 `version: FAKE_NEXT_VERSION` → `${JSON.stringify(FAKE_NEXT_VERSION)}`（修好被改坏的夹具） |
| Windows 段 `buildUpdateSteps` | `target: '0.2.6'` → `target: FAKE_NEXT_VERSION` |

### 3.3 注释同步

把 4 处「写死当前版本号」的注释改成「当前版本 + 1 / 新版本」的表述
（核心用例头部、A2 超时用例、A3 两段位用例、`swapped-by-update` 用例），
避免下一个人照着注释把字面量抄回去。

### 3.4 断言没有放宽

- 「add 必须指名精确版本」仍在，且仍断言 `dsh-worktodo@<精确版本>`（只是期望值改为派生）。
- 「`--save-exact`」「`--registry` 官方源」「CLI 第 1 步成功不跑 pnpm 兜底」
  「失败必须逐字节回滚」「CLI 真换版本才 done」等全部原样保留。
- 没有删除、跳过或 `if` 包裹任何断言。

## 4. 防回归元测试（新增 1 条）

用例名：`元测试：模拟版本全部从 package.json 派生，源码里没有当前版本号字面量（防发版假红回归）`。

两层断言：

1. **派生关系自检**：`FAKE_CURRENT_VERSION === PKG_VERSION`；
   `FAKE_NEXT_VERSION !== PKG_VERSION`；形如 `x.y.z`；且 `bumpPatch(FAKE_NEXT_VERSION, -1) === PKG_VERSION`。
2. **源码扫描**：读 `smoke-host.mjs` 自身，逐行找「当前版本号字面量」，命中即红并打印行号。

为什么选「扫全文」而不是只查某几行/列白名单：

- 这次的假红正是**漏改的字符串**造成的（断言、生成脚本、清单片段各一处），
  只盯已知位置或白名单必然还会漏；
- 扫描用边界正则 `(?<![\d.])<version>(?![\d.])`，避免将来 `0.2.10` 被 `0.2.1` 子串误伤；
- 当前版本号单调递增，历史夹具用的 `0.2.0`、`0.2.4`、`0.2.5`、`0.2.6`、`1.2.3`、`9.9.9`
  均不会被「未来某个当前版本」命中，**误伤面极小**；
- 真出现误伤时会打印具体行号，修法明确（改用 `PKG_VERSION` / `FAKE_NEXT_VERSION` 或改写注释）。

**反向验证（按仓库规范故意破坏一次）**：临时注入 `const deliberatelyBrokenFixture = '0.2.7';`
→ 元测试变红并准确报出「第 88 行」，其余用例不受影响；用备份恢复后
`shasum` 与注入前一致（`0cfd4fd1…`）。

## 5. 其它套件的排查结论

- `smoke-contract.mjs`、`verify-records/service/store/privacy/submission/workflows`：
  没有与当前版本绑定的夹具；`verify-submission.mjs` 本来就读 `package.json` 校验仓库地址，不涉及版本号。
- `smoke-client.mjs` 里确实有大量 `0.2.7`/`0.2.6`/`0.2.5` 字符串，但它们是**面板文案用例自己造的数据**
  （看板要原样透传任意版本号），既没有和 `package.json` 比较，也不会因发版变红。
  改成派生反而会削弱「客户端不得自己猜版本」这条语义，因此**按约定不动**。
- `build-client.mjs` 读 `package.json` 只用于 bundle 元信息，与版本号无关。

## 6. 验证结果

| 环境 | 命令 | 结果 |
| --- | --- | --- |
| 本机 | `WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` | **10/10 通过（含构建）**；`smoke-host` 104 通过 / 0 失败 |
| 干净环境 | `rm -rf /tmp/cihome && mkdir -p /tmp/cihome && env -i HOME=/tmp/cihome PATH=<node目录>:/usr/bin:/bin CI=true node tools/verify-all.mjs` | **10/10 通过（含构建）** |
| 语法 | `node --check tools/smoke-host.mjs` | 通过 |

测试文件数量仍为 **9 个**；未改版本号 / CHANGELOG / `.github/`；未 commit / push / tag / 发布；
所有用例只写 `/tmp` 与临时 `DSH_HOME`。

## 7. 改动文件

- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs`（唯一代码改动）
- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/docs/reviews/version-fixture-refactor.md`（本报告）

## 8. 剩余不确定

- `smoke-host.mjs` 里仍保留 `'0.2.0'`（模拟已装老版本）、Windows 模拟端到端的 `0.2.5 → 0.2.6`
  （自查的一对历史版本，`installedVersionChanged` 纯函数用例也用它）以及 `1.2.3`/`9.9.9`
  （命令形状 / 永远更新）。它们与「当前版本」无关、语义是「旧版本或任意版本」，
  版本号单调递增后也不会再等于当前版本，因此不随发版变化；若将来真发到 1.2.3，
  元测试会把它当字面量报出来——届时按提示改成派生即可（这也是元测试想要的「逼你停下来想一下」）。
- 元测试是「文本扫描」，无法证明所有字符串都用了派生（例如绕过版本号语义的拼接）；
  它只覆盖这次踩过的坑：当前版本号的裸字面量。
