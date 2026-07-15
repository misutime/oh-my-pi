# CodeGraph 调研报告：对 Oh My Pi Coding Agent 的价值评估

> 调研日期：2026-07-15
> 项目地址：https://github.com/colbymchenry/codegraph
> 当前版本：1.0

---

## 1. CodeGraph 是什么

CodeGraph 是一个**预索引代码知识图谱**工具，通过 tree-sitter 解析源码，将所有符号（函数、类、方法）和关系边（调用、导入、继承）存入本地 SQLite 数据库（含 FTS5 全文搜索），并通过 MCP 协议暴露给 coding agent 使用。

核心工作流：

```
源码 --[tree-sitter 解析]--> AST --[语言特定提取规则]--> 节点 + 边 --[SQLite]--> 知识图谱
                                                                       |
                                        MCP server ←-- file watcher 自动同步 ←-- 文件变更
                                           |
                                     coding agent 直接查询
```

**关键特性：**

|特性|说明|
|---|---|
|**预索引**|一次性构建，agent 查询即返回，无需逐文件探索|
|**自动同步**|原生 OS 文件事件（FSEvents/inotify/ReadDirectoryChangesW），debounce 2s|
|**100% 本地**|SQLite 存储，无外网调用，无 API Key|
|**20+ 语言**|TS/JS/Python/Go/Rust/Java/C#/C/C++/Swift/Kotlin 等|
|**框架感知**|识别 17 种 Web 框架路由模式（Express/NestJS/Django/Spring 等）|
|**跨语言桥接**|Swift↔ObjC、React Native JS↔Native、Expo Modules|
|**MCP 单工具**|仅暴露 `codegraph_explore`，一调用返回源码 + 调用路径 + 影响范围|

---

## 2. Oh My Pi 现有代码智能能力

omp 已具备三套代码探索工具：

### 2.1 AST Grep（`ast_grep`）

- **原理**：基于 tree-sitter 的 AST 结构模式匹配，实时解析源码
- **强项**：精确的结构化搜索（如 `console.log($$$)` 匹配所有调用），支持 codemod（`ast_edit`）
- **局限**：每次调用需解析文件；不做跨文件关系索引；纯模式匹配无上下文理解

### 2.2 LSP（`lsp`）

- **原理**：通过 Language Server Protocol 连接真实编译器/语言服务器
- **强项**：`definition`（跳转定义）、`references`（查找引用）、`rename`（重命名）、`hover`（类型信息）、`code_actions`（自动修复）、`diagnostics`（诊断）
- **局限**：每种语言需单独 server；冷启动慢（数十秒）；无法跨语言；不追踪框架约定模式

### 2.3 文本搜索（`grep` / `glob` / `read`）

- 通用但低效，需多轮调用逐文件探索

---

## 3. 能力对比矩阵

|能力维度|CodeGraph|AST Grep|LSP|grep/glob/read|
|---|---|---|---|---|
|**预索引查询**|✅ 一次调用|❌ 每次解析|❌ 每次请求|❌ 逐文件|
|**调用链追踪**|✅ callers/callees|❌|✅ references|❌|
|**动态分发追踪**|✅ callback, interface→impl|❌|⚠️ 部分|❌|
|**影响范围分析**|✅ impact/affected|❌|❌|❌|
|**跨语言关系**|✅ Swift↔ObjC, RN bridge|❌|❌|❌|
|**框架路由识别**|✅ 17 框架|❌|❌|❌|
|**符号级精确重命名**|❌|❌|✅|❌|
|**类型信息/hover**|❌|❌|✅|❌|
|**自动修复/Code Action**|❌|❌|✅|❌|
|**诊断/错误检查**|❌|❌|✅|❌|
|**结构化模式搜索**|❌|✅|❌|❌|
|**Codemod 批量重写**|❌|✅ (`ast_edit`)|⚠️ 有限|❌|
|**模糊文本搜索**|❌|❌|❌|✅|

**结论：三者互补，不是替代关系。**

---

## 4. CodeGraph 的独特价值

### 4.1 外科手术式上下文（Surgical Context）

CodeGraph 最大卖点：**一个 `codegraph_explore` 调用返回 LLM 所需的全部上下文**——相关符号的逐字源码、符号间调用路径、变更影响范围。benchmark 数据：

|指标|数据|
|---|---|
|减少 tool call 数|**58%**（中位数）|
|减少耗时|**22%**（中位数）|
|文件读取次数|**降至接近零**（0 vs 6–9 次）|
|减少 token 消耗|23%–64%|

对 omp 的意义：每次 agent 会话中 grep→read→grep 的探索循环是最大的时间和 token 浪费源。CodeGraph 将这个过程压缩为一次调用，尤其在大型代码库（如 omp 自身的 monorepo）中效果显著。

### 4.2 影响分析（Impact Analysis）

`codegraph impact <symbol>` 和 `codegraph affected <files>` 是 LSP 完全不具备的能力：

- **变更前**：修改一个导出函数，知道哪些调用方、测试文件会受影响
- **CI 集成**：`git diff --name-only | codegraph affected --stdin` 只跑受影响的测试

这在 agent 做大型重构时极其关键——agent 可能漏掉间接依赖的调用方，CodeGraph 的传递依赖追踪能发现这些。

### 4.3 动态分发 / 间接调用

LSP 的 `references` 无法追踪的回调模式、接口实现分发、React re-render 链路，CodeGraph 声称能捕获。例如：

```typescript
// LSP references 找不到这个调用关系：
registerHandler("click", myCallback);
// CodeGraph 通过树和命名约定推断出 myCallback 被调用
```

### 4.4 跨语言桥接（对 omp 不关键）

CodeGraph 的 Swift↔ObjC、React Native 跨语言桥接能力在 omp（纯 TypeScript + Rust）场景下不相关。但如果未来 omp 扩展到多语言项目，这会成为独特优势。

---

## 5. 对 Oh My Pi 的实际适用性

### 5.1 当前状态

omp 项目**已经安装了 CodeGraph**：
- 项目根存在 `.codegraph/codegraph.db`（305.9 MB，已索引完成）
- `C:\Users\Misu\.config\opencode\AGENTS.md` 中有 CodeGraph 使用指引
- 系统 prompt 中注入：*"In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files"*

### 5.2 适用场景

|场景|推荐工具|原因|
|---|---|---|
|"这个函数被谁调用？调用链多深？"|**CodeGraph**|一次调用给完整调用链|
|"改这个文件会破坏什么？"|**CodeGraph**|`impact` / `affected`|
|"这个模块的整体架构是什么？"|**CodeGraph**|`explore` 返回入口点+关系全景|
|"找到所有 `useState(...)` 调用"|**AST Grep**|精确结构化模式匹配|
|"重命名这个导出符号"|**LSP**|跨文件精确重命名|
|"这个变量的类型是什么？"|**LSP**|编译器级类型信息|
|"修复这个 import 错误"|**LSP**|`code_actions`|
|"某段文本出现在哪里？"|**grep**|纯文本搜索最快|
|"执行 codemod 批量改写"|**AST Edit**|结构化批量重写|

### 5.3 建议的策略

**保留全部工具，按场景分层使用：**

```
理解代码 / 架构探索  ──→  CodeGraph（探索阶段首选）
精确重构 / 重命名    ──→  LSP（编译器保证正确性）
结构模式搜索 / Codemod ──→  AST Grep / AST Edit
纯文本搜索           ──→  grep
```

## 6. 与 AST Grep 的深度对比

两者都基于 tree-sitter，但设计目的完全不同：

|维度|CodeGraph|AST Grep|
|---|---|---|
|**范式**|预建索引 → 查询|实时解析 → 模式匹配|
|**查询方式**|自然语言或符号名|AST 结构模式（如 `$CALLER($$$ARGS)`）|
|**返回内容**|源码 + 调用关系图 + 影响范围|匹配位置的源码快照|
|**跨文件**|天然跨文件（索引全局）|需指定搜索范围，逐文件解析|
|**关系追踪**|内置 callers/callees/impact|无，需人脑拼接多轮匹配结果|
|**精确定位**|依赖索引覆盖度，可能有遗漏|只要模式对，不漏任何匹配|
|**冷启动**|需先 `codegraph init` 索引（一次性）|无，首次调用即用|

### 典型对比场景

**场景 A：理解 `ToolSession` 的调用者有哪些**

- CodeGraph: `codegraph explore "ToolSession 被谁调用"` → 一次返回所有调用方+源码
- AST Grep: 需要构造 `new ToolSession($$$)`、`ToolSession($$$)`、`implements ToolSession` 等多个模式，仍需人脑拼接

**场景 B：找到所有 `console.log` 调用（包括变体）**

- AST Grep: `console.$METHOD($$$ARGS)` 一行模式搞定，精确匹配
- CodeGraph: 不适合，这是结构模式匹配而非理解型查询

**结论：CodeGraph 用于"理解与发现"，AST Grep 用于"精确匹配与批量改写"。**

---

## 7. 与 LSP 的深度对比

|维度|CodeGraph|LSP|
|---|---|---|
|**精度**|tree-sitter 静态分析 + 启发式规则|编译器级语义分析|
|**覆盖**|跨文件、跨语言、框架模式|单语言，依赖 server 能力|
|**动态分发**|启发式推断（接口→实现、回调）|通常无法追踪|
|**类型信息**|无|hover 返回完整签名/文档|
|**重命名**|不支持|跨文件精确重命名|
|**响应速度**|毫秒级（索引查询）|百毫秒到数秒（server 计算）|
|**离线可用**|✅|❌（需安装语言 server）|
|**索引维护**|自动 file watcher|无需维护|

### 关键差异

**LSP 做 CodeGraph 做不到的事：**
- 重命名：编译器级语义理解保证 `interface.foo` 和 `impl.foo` 同时改名
- Code Actions：自动添加 import、提取变量、修复错误
- Diagnostics：实时错误标记（类型错误、未使用变量等）

**CodeGraph 做 LSP 做不到的事：**
- 影响范围分析：传递依赖追踪
- 跨语言：LSP 天然单语言
- 零冷启动：预索引，首次查询即毫秒级
- 框架语义：理解 `@Controller` + `@Get` = HTTP 路由

---

## 8. 潜在风险与局限

### 8.1 索引准确性

- tree-sitter 解析 + 启发式规则不如真实编译器精确
- 动态特性（`eval`、`Reflect`、高阶函数组合）可能漏边
- 项目已在用，观察是否有遗漏

### 8.2 索引维护开销

- 大型项目索引可达数百 MB（omp 当前 305.9 MB）
- file watcher 需常驻后台（MCP server 自带）
- 初始索引时间（omp 已索引完成，增量更新轻量）

### 8.3 工具选择困惑

- agent 已有 grep/glob/ast_grep/lsp 四套探索工具，加上 CodeGraph 是第五套
- 需要清晰的工具选择策略（见 5.3 节）

---

## 9. 结论

**CodeGraph 对 omp 有显著价值，且不可被现有 AST/LSP 替代。** 核心原因：

1. **它解决了一个 AST/LSP 都没覆盖的问题**：一次性获取理解代码所需的全景上下文（源码 + 调用链 + 影响范围），而非多轮文件探索
2. **benchmark 数据支持**：减少 tool call 58%、文件读取接近零
3. **与现有工具互补而非竞争**：理解用 CodeGraph，重构用 LSP，模式搜索用 AST Grep
4. **已集成到 omp 工作流**：项目已索引，AGENTS.md 已指引 agent 优先使用

**推荐策略：保持现状，持续使用。** 如果未来探索阶段发现 agent 过度依赖 grep/read 链，可强化 AGENTS.md 中 CodeGraph 的优先引导。
