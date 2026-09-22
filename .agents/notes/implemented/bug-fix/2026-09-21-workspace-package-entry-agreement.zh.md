# Agent Note: 源码启动下每个工作区包只有一个模块实例

Status: implemented

[English](2026-09-21-workspace-package-entry-agreement.md) | 中文

## 问题

从源码启动（`pnpm dsh`，即 `node --import tsx/esm apps/cli/src/bin.ts`）时，同一进程加载了两个 `@deepseek-ai/dsh-tools` 模块实例：27 个 import 经 tsconfig `paths` 投影解析到 `packages/core/tools/src/index.ts`，另一个解析到 `packages/core/tools/lib/index.js`。

那一个正是 Loader 自身的 entry import。`Include.import`（`vendor/loader/src/config/tree.ts`）解析裸插件名时以 `ctx.baseUrl` 为 parent，而 `ctx.baseUrl` 就是 profile 目录。profile 解析路由捕获了该请求、匹配到 fallback 路由，并从 `apps/cli/node_modules` 中该路由的 declarer manifest 重新解析——这条 import 链里没有源文件，`paths` 投影不适用，于是包 manifest 声明的已发布入口胜出。

后果不是主观歧义，而是硬失败。当时 `TOOL_RUNTIME_SCHEDULER` 为 `Symbol('@deepseek-ai/dsh-tools.scheduler')`，每次模块求值都产生新 symbol，因此 `agent-loop` 那一份符号永远无法匹配 `ToolRuntime` 实例上的键，所有工具调用都以 `Cannot read properties of undefined (reading 'prepare')` 失败。失败的 step 已记录 `tool/call` 却从未记录其结果；DeepSeek Messages 请求会拒绝 assistant 轮的 `tool_use` id 未被紧随其后的 user 轮全部解析的历史，且该检查发生在构建请求阶段、任何网络调用之前，于是该 session 之后的每一轮同样失败。构建版启动只加载一个平面，观察不到该缺陷。

## 决策

fallback 路由选中的是**包**，而非包内的入口。当 importer 自身的查找顺序把请求解析到该路由选中的包目录内时，路由直接返回该解析结果；仅当 importer 完全无法到达该包时，才从 declarer manifest 重新解析。比较基于规范化路径，因为中间的 `node_modules` 路径是符号链接。

该规则限定在 `enforce` 行为下，即所有真实启动使用的模式（`resolutionMode: 'runtime'`，启动器默认值）。dual 模式仍比较 Node 的磁盘结果与 generation，因为它校验的是包身份，而非入口选择。

路由不检测“源码启动”。它既不检查进程参数，也不探测 `tsx`；它向 loader 询问一个 loader 能够回答的问题——importer 自身的顺序是否解析到选中的包目录内。打包后的可执行文件其 importer 没有这样的路径，因此沿用原有路由。importer 的查找链经由当前 loader hook 而非 fallback 表到达工作区包，因为从未物化 profile 链接的启动不会给 importer 留下自己的查找路径。

## 备选方案

**检测源码启动并跳过路由。** 可通过进程参数或探测 `tsx` 实现，但这会让运行时行为取决于进程的启动方式，并且对其他所有启动载体而言，“一个包对应两个入口”的歧义依然存在。

**用 `createRequire` 比较包目录。** 这会读取 profile 的 `node_modules` fallback 链接，而普通启动从不物化这些链接，因此该检查会在创建链接的 fixture 中通过、在生产中失败。URL containment 比较只依赖产生该分歧的 loader hook。

**改用 `Symbol.for` 共享 scheduler 符号，而不是修复路由。** 这是止住崩溃最省事的办法，但它把硬失败变成两个存活的 `ToolRuntime` 实例——两套注册表、两份缓存——因此只处理了症状，而非重复加载的模块。它未被用作根治手段，而是后来作为纵深防御单独落地。

**让 generation 同时选择入口与包。** 部署便可以把某个工作区包固定到其构建产物入口，但 generation 在任何插件加载之前就已计算完毕，对当前 loader hook 一无所知；把这种影响编码进去，等于在 Node 实际查询的 resolver 之外又复制了一份解析逻辑。

## 后果

源码启动现在为每个工作区包只加载一个实例：`packages/*/lib/` 的加载数从 62 降到 7，剩下的 7 个是生成的 `typert.host.js` 产物，而非 `src` 模块的副本。`pnpm dsh` 无需再依赖构建版启动，污染 session 的失败已从源头消除。

该规则收窄了 fallback 路由的控制范围。generation 仍选择哪个包，而 loader hook 选择包内的哪个入口。若某个部署的 hook 把工作区包映射到该包目录之外的文件，则沿用原有行为，因为要求目录一致；若某个包依赖 generation 为一个 importer 也能到达的包覆盖入口，在 enforce 模式下不再可覆盖。本仓库不存在这样的路由，观察到的所有分歧都是同一个包内的 `src` 与 `lib` 之别。

scheduler 键本身也改为 `Symbol.for('@deepseek-ai/dsh-tools.scheduler')`，作为独立加固：另一个重复的包、worker 或嵌套安装此后会在该键上取得一致，而不是在其上崩溃。它仍只是缓解措施，因为两个存活的 `ToolRuntime` 实例依然意味着两套注册表、两份缓存；根治手段仍是路由规则。`packages/core/tools/tests/scheduler-symbol.spec.ts` 固定了该注册表身份，以及通过它进行的实例查找。

`packages/boot/app-boot/tests/profile-resolution.spec.ts` 用一个注册的 loader hook 覆盖该规则，其中包括 importer 无法到达选中包、必须沿用 generation 路由的情形。该 hook 注册后无法移除，因此独占一个其他用例不会使用的包名。打包可执行文件的运行仍未测量；该规则不可能改变那条路径，因为打包后的二进制没有 source-plane hook，但这一论证是推理，而非证据。

同一缺陷还留下第二个独立缺口：调度器失败时，对已经记录的调用不写结果，这正是使一次崩溃永久污染 session 的原因。调度器失败的配对结果决策另行记录。
