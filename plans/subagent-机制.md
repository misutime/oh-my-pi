# omp Subagent 机制

## 架构概览

omp 内置了完整的 subagent 委托系统。主 agent 通过 `task` 工具将工作分派给独立的子代理。每个 subagent 运行在自己的 session 中，拥有独立的 LLM 上下文和工具集。

```
主 Agent
  ├─ task({ role: "scout",   task: "找到所有调用 oldApi 的位置" })
  ├─ task({ role: "reviewer", task: "审查 src/auth.ts 安全" })
  └─ task({ tasks: [           // batch 模式：一次调用 spawn 多个
       { agent: "scout", task: "..." },
       { agent: "scout", task: "..." },
     ] })
```

### 执行模型

- **单 agent spawn** — 每个 `task` 调用 spawn 一个 subagent，主 agent 等待结果
- **Batch spawn** (`task.batch: true`) — 一次调用 spawn 多个，并行执行，共享 context
- **Detached/Async** — async 模式下 subagent 在后台运行，不阻塞主 agent turn
- **隔离模式** — 可选的在 git worktree 中运行，变更通过 patch 应用回主仓库

### 层级与递归

```typescript
// task/spawn-policy.ts
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
    // maxRecursionDepth = -1 时无限递归
}
```

每个 agent 定义文件的 `spawns` 字段控制其子 spawn 权限。`reviewer` 可以 spawn `scout`，但 `scout` 不能再 spawn。

---

## 默认内置 Agent

所有内置 agent 定义在 `src/prompts/agents/`，零配置可用。通过 `task` 工具调用时指定 `role` 字段。

### 1. `task` — 通用工人（默认）

| 属性 | 值 |
|---|---|
| 模型 | `@task`（当前会话模型） |
| 权限 | **全部工具** |
| spawn | `*`（可 spawn 所有 agent） |
| 用途 | 通用委托：编辑文件、运行命令、创建文件 |

不指定 `role` 时默认使用。拥有完整工具权限，适合大多数任务。

**调用示例：**
```
task({ task: "把 src/utils/format.ts 中的所有 console.log 替换为 logger.debug" })
```

### 2. `scout` — 只读代码探索

| 属性 | 值 |
|---|---|
| 模型 | `@smol`（快速/便宜） |
| 工具 | `read`, `grep`, `glob`, `web_search` |
| spawn | 无（不能再 spawn） |
| 推理深度 | medium |
| 用途 | 代码库探索、模式搜索、信息收集 |

只读，不能改文件。专门用于快速扫描大范围代码并返回压缩上下文。

**调用示例：**
```
task({ role: "scout", task: "在 src/ 中找出所有直接操作 DOM 的地方" })
```

### 3. `reviewer` — 代码审查

| 属性 | 值 |
|---|---|
| 模型 | `@slow`（强推理） |
| 工具 | `read`, `grep`, `glob`, `bash`, `lsp`, `web_search`, `ast_grep` |
| spawn | `scout`（可派 scout 缩小范围） |
| 推理深度 | high |
| 用途 | 代码审查、安全分析、质量评估 |

产出结构化 review 结果（`overall_correctness`、`explanation`、`suggestions`）。

**调用示例：**
```
task({ role: "reviewer", task: "审查 src/auth/ 的认证逻辑，关注 session 管理和 token 轮换" })
```

### 4. `librarian` — 外部库/API 调研

| 属性 | 值 |
|---|---|
| 模型 | `@smol` |
| 工具 | `read`, `grep`, `glob`, `bash`, `lsp`, `web_search`, `ast_grep` |
| spawn | 无 |
| 推理深度 | minimal |
| 用途 | 研究外部库和 API文档 |

读源码、查文档、验证 API 行为。优先用本地 `node_modules`，否则 clone 仓库。

**调用示例：**
```
task({ role: "librarian", task: "查 prisma v6 的 batch transaction API 签名和限制" })
```

### 5. `designer` — UI/UX 设计

| 属性 | 值 |
|---|---|
| 模型 | `@designer` |
| 权限 | 全部工具 |
| 用途 | UI 实现、设计审查、视觉优化 |

关注无障碍、对比度、间距、排版、组件一致性。

**调用示例：**
```
task({ role: "designer", task: "实现登录表单组件，遵循设计系统的间距和颜色规范" })
```

### 6. `sonic` — 纯机械批量改动

| 属性 | 值 |
|---|---|
| 模型 | `@smol` |
| 权限 | 全部工具（复用 `task` 系统 prompt） |
| 推理 | 极低 |
| 用途 | 重命名、格式统一、批量替换等纯机械操作 |

与 `task` 使用相同的系统 prompt，但 LLM reasoning effort 被压低。不适合需要判断的任务——速度快、token 消耗低。

**调用示例：**
```
task({ role: "sonic", task: "把 src/ 下所有 .ts 文件的 console.log 替换为 logger.debug" })
```

---

## Agent 模型配置

每个内置 agent 通过 frontmatter 声明默认模型（如 `model: "@smol"`）。`@smol`、`@slow`、`@task` 等是 **model role 占位符**，运行时解析为具体模型。有两种配置方式。

### 方式一：全局 model role

通过 `/model` 命令或 `settings.json` 修改 model role 映射，影响所有引用该 role 的 agent。

```
/model smol deepseek/deepseek-v4-flash
```

等价于在 `settings.json` 中：

```jsonc
{
  "modelRoles": {
    "smol": "deepseek/deepseek-v4-flash"
  }
}
```

效果：所有引用 `@smol` 的 agent（`scout`、`librarian`、prewalk 切换等）统一使用 `deepseek/deepseek-v4-flash`。

**内置 model role 及其使用方：**

| Role | 用途 | 使用该 role 的 agent |
|---|---|---|
| `@smol` | 快速/便宜模型 | `scout`, `librarian`, prewalk 切换, tiny 回退 |
| `@slow` | 强推理模型 | `reviewer` |
| `@task` | 会话模型 | `task`（默认 worker） |
| `@designer` | 设计模型 | `designer` |
| `@plan` | 架构师模型 | plan mode |

### 方式二：单 agent 覆盖

在用户 agents 目录创建同名定义文件，只覆盖指定 agent，不影响其他引用同一 role 的 agent。

```bash
mkdir -p ~/.omp/agent/agents
```

创建 `~/.omp/agent/agents/scout.md`：

```markdown
---
name: scout
description: 快速只读代码探索
tools: read, grep, glob, web_search
model: "deepseek/deepseek-v4-flash"
thinking-level: medium
---

（系统 prompt 可省略，继承内置定义）
```

Agent 发现优先级：**用户目录 > 项目目录 > 扩展 > 内置**。同名 agent 用户定义完全覆盖内置定义。

### 对比

| | 全局 model role | 单 agent 覆盖 |
|---|---|---|
| 影响范围 | 所有引用该 role 的 agent | 仅目标 agent |
| 配置位置 | `/model smol ...` 或 `settings.json` | `~/.omp/agent/agents/<name>.md` |
| 适用场景 | 统一升级所有 fast agent | scout 用廉价模型但 librarian/reviewer 不动 |
| 恢复默认 | `/model smol` 回车选默认，或删 `modelRoles.smol` | 删除对应 `.md` 文件 |

---

## `task` 工具参数

### 单独 spawn（默认）

| 参数 | 类型 | 说明 |
|---|---|---|
| `task` | string（必填） | 任务描述 |
| `agent` | string | agent 类型（默认根据 session spawn policy） |
| `model` | string | 模型覆盖 |
| `schema` | JSON Schema | 结构化输出格式 |
| `isolated` | boolean | 是否在隔离 worktree 中运行 |

### Batch spawn（`task.batch: true`）

| 参数 | 类型 | 说明 |
|---|---|---|
| `tasks[]` | array | 任务列表 |
| `tasks[].task` | string（必填） | 单个任务描述 |
| `tasks[].agent` | string | 该任务使用的 agent 类型 |
| `tasks[].name` | string | agent 实例名（用于 IRC/registry 标识） |
| `tasks[].isolated` | boolean | 该任务是否隔离运行 |
| `context` | string | 所有子任务的共享背景 |

---

## 关键机制

### Agent 注册与发现

```typescript
// task/discovery.ts
export async function discoverAgents(cwd: string, home: string) {
    // 加载优先级：用户目录 > 项目目录 > 扩展 > 内置
}
```

Agent 定义文件（`.md`）通过 frontmatter 声明：
```yaml
---
name: scout
description: 快速只读代码探索
tools: read, grep, glob, web_search
model: "@smol"
thinking-level: medium
spawns: ""           # 空 = 不能 spawn 子代理
---
```

### 资源控制

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `task.maxConcurrency` | — | 最大并发 subagent 数 |
| `task.maxRecursionDepth` | 2 | 最大递归深度（-1 = 无限） |
| `task.maxRuntimeMs` | — | 单个 subagent 最大运行时间 |
| `task.isolation.mode` | `none` | 隔离模式（`none`/`git`） |
| `task.isolation.patchMode` | — | 补丁应用模式 |
| `task.enableLsp` | `false` | subagent 是否启用 LSP |
| `async.enabled` | — | 是否允许 async/后台 subagent |
| `task.batch` | — | 是否允许批量 spawn |
| `task.agentIdleTtlMs` | 420000 (7min) | agent 空闲超时 |

### Soft Budget & 强制停止

每个 subagent 有软/硬请求预算。超过软上限后注入 budget notice，超过硬上限（软上限 × 1.5）后强制停止并要求 yield 当前结果。

### 隔离执行

当 `task.isolation.mode` 为 `git` 且指定 `isolated: true`：
1. 创建 git worktree 副本
2. subagent 在副本中运行
3. 成功后将 diff 作为 patch 应用回主仓库
4. 始终清理 worktree

### IRC 通信

subagent 之间通过 IRC 通信。注册到 `AgentRegistry`，可以 DM 或广播。主 agent 可以通过 IRC 随时向运行中的 subagent 发送 steering 指令。

### Subagent HUD

主 agent 的 `Agent Hub`（`Ctrl+G`）实时展示所有运行中/已完成的 subagent 状态、进度和输出。

---

## 并发

Provider 级别的并发控制确保 LLM 请求不过载。semaphore 粒度是**单次 LLM 调用**而非整个 agent 生命周期——父 agent stream 结束后立即释放 slot，子 agent 在工具执行期间可以获取 slot，避免 spawn tree 死锁。

---

## 源码布局

```
src/task/
├── index.ts           # TaskTool 实现、参数 schema、batch/spawn 逻辑
├── discovery.ts       # Agent 定义发现与加载
├── executor.ts        # 子进程/进程内 subagent 执行
├── spawn-policy.ts    # spawn 权限解析
├── types.ts           # TaskParams, SubagentProgressPayload 等类型
├── render.ts          # TUI 渲染
├── isolation-runner.ts # git worktree 隔离沙箱
├── worktree.ts        # worktree 管理
├── yield-assembly.ts  # 结构化输出组装
├── persisted-revive.ts # agent 恢复/重新激活
├── label.ts           # 自动生成 agent 标签
├── repair-args.ts     # LLM JSON 双编码修复
└── agents.ts          # 内置 agent 注册（task 默认 worker）

src/prompts/agents/
├── task.md            # 通用 worker 系统 prompt
├── scout.md           # 只读 explorer 系统 prompt
├── reviewer.md        # 代码审查 agent 系统 prompt
├── librarian.md       # 库/API 调研 agent 系统 prompt
├── designer.md        # UI/UX agent 系统 prompt
└── frontmatter.md     # Agent 定义模板

src/prompts/system/
├── subagent-system-prompt.md   # subagent 基础系统 prompt
├── subagent-user-prompt.md     # subagent 用户消息模板
├── subagent-yield-reminder.md  # yield 提醒模板
└── plan-mode-subagent.md       # plan mode subagent 提示
```
