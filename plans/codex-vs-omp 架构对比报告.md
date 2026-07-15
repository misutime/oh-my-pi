# Codex vs OMP (oh-my-pi) — AI Coding Agent 架构对比报告

> 基于 Codex (`D:\misutime\102_pi\codex`) 和 OMP (`packages/coding-agent`) 源码深度分析。
> 分析日期：2026-07-15

---

## 1. 系统提示词 (System Prompt)

### 1.1 架构对比

| 维度           | Codex                                                                                 | OMP (oh-my-pi)                                                             |
| -------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **语言**       | Rust                                                                                  | TypeScript (Handlebars 模板)                                               |
| **主模板**     | `codex-rs/protocol/src/prompts/base_instructions/default.md` (~280 行)                | `src/prompts/system/system-prompt.md` (~273 行)                            |
| **组装方式**   | Fragment 系统: 各类 `ContextualUserFragment` 按角色 (`developer`/`user`) 注入消息列表 | `buildSystemPrompt()` 渲染 Handlebars 模板 + `project-prompt.md` 尾部      |
| **条件渲染**   | 编译时选择模板文件（不同 sandbox/approval 模式加载不同 .md）                          | 模板内 Handlebars 条件 `{{#if}}` / `{{#has}}` 按工具和能力动态调节         |
| **注入通道**   | `developer` 消息 (系统指令) + `user` 消息 (上下文)                                    | 纯 `system` 消息 (OpenAI/Anthropic 兼容)                                   |
| **项目上下文** | AGENTS.md 通过 `UserInstructionsProvider` 注入为 user fragment                        | `AGENTS.md` + workspace tree + context files 渲染在 `project-prompt.md` 中 |

### 1.2 内容结构对比

#### Codex — 核心章节

```
1. Identity (coding agent in Codex CLI, OpenAI)
2. Personality (concise, direct, friendly)
3. AGENTS.md spec (作用域规则, 优先级)
4. Responsiveness (preamble messages 格式)
5. Planning (update_plan 工具使用规范, 大量正反例)
6. Task execution (apply_patch 使用, 代码规范)
7. Validating work (测试/构建验证策略)
8. Ambition vs precision (新项目 vs 存量代码的差异策略)
9. Sharing progress updates (进度报告格式)
10. Presenting work and final message (输出格式: 标题/列表/等宽/文件引用)
11. Tool Guidelines (shell, update_plan)
```

#### OMP — 核心章节

```
1. <system-conventions> XML 标签协议, RFC 2119 关键词
2. ROLE (engineering principles: correctness first, agency and taste)
3. RUNTIME
   - Skills & Rules (条件注入)
   - Internal URLs (skill://, agent://, memory://, issue://, pr:// ...)
   - Tool Inventory (条件渲染工具列表)
4. TOOL POLICY
   - General (工具使用原则)
   - Specialized Tools (专用工具优先级: read > cat, grep > rg, etc.)
   - Exploration (Read sections, not snippets)
   - LSP / AST (语言服务器和语法树工具)
   - Delegation (子 Agent 调度门控规则)
5. EXECUTION WORKFLOW (6 阶段: Scope → Research → Decompose → Implement → Verify → Cleanup)
6. DELIVERY CONTRACT (completeness, evidence, yielding 规则)
7. <personality> (可选的三种人格块)
```

### 1.3 关键差异

|                   | Codex                                                             | OMP                                                                                                  |
| ----------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **语气规范**      | "concise, direct, and friendly"; 大量 preamble 示例               | RFC 2119 严格关键词(MUST/SHOULD/NEVER); 极简 terse 工程师风格                                        |
| **计划工具**      | `update_plan` — 详细的 5-7 词步骤, 状态追踪, 大量正反例           | `todo` — 轻量级, 执行工作流中的第 3 阶段                                                             |
| **代码修改**      | `apply_patch` 作为唯一编辑方式 (unified diff)                     | `edit` + `write` + `ast_edit` + LSP refactors (多种编辑路径)                                         |
| **子 Agent 指令** | 在 `base_instructions` 中不涉及 (由 role config 和运行时指令控制) | 详细的 Delegation gates (5 条规则: scope before spawn, no outsource plan, no spawn-one-then-wait 等) |
| **验证要求**      | "run tests, lint, do whatever you need"; 区分 approval mode       | "smoke test, not test file"; 5 种场景对应的验证策略                                                  |
| **XML 协议**      | 无                                                                | 全局约定: system 通过 XML tag 注入, 永不混淆 user/system 角色                                        |
| **内部 URL**      | 无                                                                | 完整的内部 URI 系统 (9 种 scheme)                                                                    |
| **输出格式**      | 极其详细的 markdown 格式规范 (标题/子弹/等宽/文件引用)            | 简单: terminal prose, 可选 LaTeX/mermaid                                                             |

### 1.4 人格 (Personality)

|               | Codex                                                    | OMP                                                    |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| **数量**      | 2 (backend 和 realtime)                                  | 3 (default / friendly / pragmatic)                     |
| **切换方式**  | realtime 后端独立 prompt; backend 由 config 层覆盖       | `personality` setting; 模板 `{{personality}}` 变量注入 |
| **default**   | "concise, direct, and friendly"                          | "terse, evidence-first engineer"                       |
| **friendly**  | "playful collaborator: fun, warm, witty" (realtime 后端) | "warm, supportive collaborator"                        |
| **pragmatic** | 无                                                       | "deeply pragmatic senior engineer"                     |

---

## 2. 工具系统 (Tools)

### 2.1 架构对比

| 维度            | Codex                                                                | OMP                                                                        |
| --------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **语言**        | Rust                                                                 | TypeScript                                                                 |
| **接口**        | `ToolExecutor<ToolInvocation>` trait                                 | `Tool` 基类                                                                |
| **Schema 生成** | Rust `JsonSchema` derive 宏 + 独立 `*_spec.rs` 文件                  | Arktype schema `.describe()` 链式 API                                      |
| **描述格式**    | Rust 函数返回 `ToolSpec` (text description + JSON Schema parameters) | Handlebars `.md` 模板文件 (~50 个)                                         |
| **条件工具**    | 编译时: 不同 `sandbox_mode`/`approval_policy` 加载不同 handler       | 运行时: `{{#has tools "bash"}}` 等模板条件                                 |
| **代码修改**    | `apply_patch` (unified diff, Lark grammar 解析)                      | `edit` (行号 patch) + `write` + `ast_edit` + `ast_grep` + LSP code_actions |
| **文件读取**    | 无独立工具 (通过 shell 的 `cat`/`rg`)                                | `read` (专用, 支持 selector/offset/limit)                                  |
| **文件搜索**    | 无独立工具 (通过 shell 的 `rg --files`/`find`)                       | `grep` + `glob` (专用, 禁止 shell 替代)                                    |
| **浏览器**      | 无                                                                   | `browser` (完整 Puppeteer, 多标签页)                                       |
| **MCP**         | 内置 `mcp` + `mcp_resource` handler                                  | `mcp://` URI scheme + tool proxy                                           |
| **图片**        | `view_image` (读) + `generate_image` (生成)                          | `generate_image` + `inspect_image`, 用户直传                               |
| **Shell**       | `shell` + `unified_exec` + `test_sync` (含 sandbox 隔离)             | `bash` + `launch` (区分短命令和长期服务)                                   |
| **Debug**       | 无                                                                   | `debug` (debugpy, dlv, gdb, lldb-dap)                                      |
| **Eval**        | 无                                                                   | `eval` (Python/JS 持久内核, DAG 编排)                                      |
| **子 Agent**    | `multi_agents`/`multi_agents_v2`/`agent_jobs` (3 套!)                | `task` (统一)                                                              |
| **用户交互**    | `request_user_input` + `request_permissions`                         | `ask` + `resolve`(apply/discard 协议)                                      |
| **LSP**         | 无                                                                   | `lsp` (definition, references, hover, rename, code_actions)                |
| **AST**         | 无                                                                   | `ast_grep` + `ast_edit`                                                    |
| **Git**         | 通过 shell                                                           | `github` (issue/PR 拉取)                                                   |

### 2.2 工具描述格式对比

#### Codex (Rust 自动生成)

```rust
// *_spec.rs: spec() 返回 ToolSpec { description: "简要一句话", parameters: JsonSchema }
// 工具描述极简: 1-2 句话的 description + 自动生成的 JSON Schema 参数文档
fn spec(&self) -> ToolSpec {
    memory_function_tool::<ReadArgs, ReadMemoryResponse>(
        READ_TOOL_NAME,
        "Read a Codex memory file by relative path, optionally starting at a 1-indexed line offset and limiting the number of lines returned.",
    )
}
```

#### OMP (Handlebars 模板, 高度定制)

```markdown
<!-- tools/read.md — 60+ 行, 含 selector 语法文档 -->

# Files

- Directory → depth-limited dirent listing.
- File + selector → filename-only snapshot header + numbered lines
- Parseable code, no selector → structural summary

<critical>
- Summary footer names elided ranges? Re-issue ONLY those ranges.
</critical>
```

### 2.3 模型看到的工具描述

|                   | Codex                             | OMP                                           |
| ----------------- | --------------------------------- | --------------------------------------------- |
| **详细程度**      | 极简: 1-2 句话 + 参数 JSON Schema | 深度文档: 使用条件、critical 反模式、输出格式 |
| **文件数量**      | ~50 个 handler(每个 1-2 句描述)   | ~50 个 .md 模板 (平均 30-80 行)               |
| **总 token 消耗** | 低 (~2-4K tokens)                 | 高 (~8-15K tokens)                            |
| **关键差异**      | 依赖模型对 OpenAI API 的内置理解  | 把知识编码进 prompt, 减少模型猜测             |

---

## 3. 子 Agent (Subagent / Multi-Agent)

### 3.1 架构对比

| 维度             | Codex                                                                 | OMP                                                                 |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **编排层数**     | 3 层: `multi_agents` v1, `multi_agents_v2`, `agent_jobs`              | 1 层: `task` 工具                                                   |
| **Agent 定义**   | TOML 配置文件 (`agent/builtins/{role}.toml`), config 层覆盖           | Markdown frontmatter (`prompts/agents/*.md`)                        |
| **内置 Agent**   | 3 个: `default`, `explorer`, `worker` (+ 注释掉的 `awaiter`)          | 6 个: `scout`, `designer`, `reviewer`, `librarian`, `task`, `sonic` |
| **自定义 Agent** | 用户通过 TOML config 定义 role, 可覆盖 model/instructions/personality | 用户通过 `.md` frontmatter 定义, 或项目 `.omp/agents/` 目录         |
| **模型分配**     | Role config 中的 `model` 字段 (TOML)                                  | `model: @smol` / `model: @slow` 等 Role alias (frontmatter)         |

### 3.2 子 Agent 通信机制

|                | Codex                                                                   | OMP                                                           |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| **通信原语**   | `send_message` / `wait_for_agent` / `followup_task` / `interrupt_agent` | `irc` (send/wait/list/inbox) + `history://` (只读 transcript) |
| **通信模型**   | 显式: spawn → 等 ID → send → wait                                       | 显式: spawn → 通过 `irc` DM + `history://` 读取               |
| **结果回传**   | Agent 完成时自动通知 + `report_agent_job_result`                        | `yield` 工具: 结构化 JSON schema 验证 + 增量 yield            |
| **父→子**      | `send_input` (steering)                                                 | `irc` steering (自动唤醒 parked agent)                        |
| **子→子**      | 无直接通道 (通过父中转)                                                 | `irc` 对等直接通信                                            |
| **批量 spawn** | `spawn_agents_on_csv` (CSV 驱动)                                        | `task` 原生 `tasks[]` 批量 (单次调用 32 上限)                 |
| **发现**       | `list_agents`                                                           | `irc list` + `history://` (列出所有活跃 agent)                |

### 3.3 子 Agent 生命周期

|              | Codex                                        | OMP                                                   |
| ------------ | -------------------------------------------- | ----------------------------------------------------- |
| **创建**     | `spawn` 调用 → 独立 Agent 实例               | `task` 调用 → 进程内 `AgentSession` + 独立 subprocess |
| **隔离**     | Sandbox (filesystem isolation) + 独立 `cwd`  | 进程内上下文继承 + 可选 `isolated: true` 文件系统隔离 |
| **工具访问** | 继承父工具集 (可通过 role config 限制)       | 白名单模型: agent frontmatter `tools: [...]`          |
| **消亡**     | 自然完成 / `interrupt_agent` / `close_agent` | 自然 yield / abort / TTL-based parking                |
| **存活**     | Turn 内, 完成后不可复活                      | idle → parked (TTL) → revived (按需唤醒)              |

### 3.4 内建 Agent 角色定义

#### Codex

```toml
# agent/builtins/default.toml
# agent/builtins/explorer.toml
# agent/builtins/worker.toml
# 每个 role 可覆盖: model, instructions, personality, developer_instructions

# spawn 参数中指定 role:
# "Optional type name for the new agent. If omitted, `default` is used.
#  Available roles: default (通用), explorer (探索), worker (工作)"
```

#### OMP

```yaml
# prompts/agents/scout.md
---
name: scout
description: Read-only research agent for codebase exploration
tools: [read, grep, glob, web_search]
model: @smol
---
# 具体行为指令...

# prompts/agents/designer.md
---
name: designer
description: UI/UX specialist
tools: [read, grep, glob, ...]
model: @designer
---

# prompts/agents/reviewer.md
---
name: reviewer
description: Code review specialist
tools: [read, grep, glob, bash, lsp, web_search, ast_grep]
spawns: scout
model: @slow
---
```

### 3.5 子 Agent 系统提示词差异

|                   | Codex                                                                | OMP                                                                                                  |
| ----------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **主 Agent**      | `base_instructions/default.md` (280 行)                              | `system-prompt.md` (273 行) + `project-prompt.md`                                                    |
| **子 Agent**      | Role config 中的 `instructions` 字段覆盖 + 运行时 context injections | `subagent-system-prompt.md` 包装器: ROLE(agent body) + COOP(IRC peers) + COMPLETION(yield)           |
| **子 Agent 继承** | 继承基指令 + role 覆盖 + 运行时 permissions/sandbox 提示             | 只继承系统约定层 (`<system-conventions>`), 替换 TOOL POLICY / EXECUTION WORKFLOW / DELIVERY CONTRACT |

---

## 4. 计划/任务追踪

| 维度          | Codex                                                             | OMP                                                    |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| **计划工具**  | `update_plan` — 详细步骤列表, 状态: pending/in_progress/completed | `todo` — 轻量步骤列表 + Plan Mode (模态切换)           |
| **计划粒度**  | 5-7 词步骤, 1 个 in_progress                                      | 自由格式                                               |
| **计划规范**  | 大量正反例: "High-quality plans" vs "Low-quality plans"           | 无内嵌示例                                             |
| **Goal 追踪** | Goal 系统: create_goal/get_goal/update_goal, token budget         | Goal Mode: `goal` 工具, guided interview, budget limit |

---

## 5. 上下文管理

| 维度         | Codex                                                         | OMP                                                     |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------- |
| **管理方式** | 模型自主: `get_context_remaining` + `new_context_window` 工具 | 系统自动: Auto-compaction (threshold / overflow / idle) |
| **压缩**     | `compact/prompt.md` 模板                                      | Snapcompact + compaction v2                             |
| **模型感知** | 模型主动查询剩余 token 并在需要时新开窗口                     | 模型不感知, 系统在后台自动压缩                          |

---

## 6. 权限与安全

| 维度            | Codex                                                  | OMP                                                           |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| **Sandbox**     | 3 级: danger_full_access / read_only / workspace_write | Isolation backends (APFS/Btrfs/OverlayFS/Windows Block Clone) |
| **审批策略**    | 4 级: never / unless_trusted / on_request / granular   | 配置级 (无运行时审批策略工具)                                 |
| **权限提升**    | `request_permissions` 工具 (模型可主动申请)            | 无 (预配置)                                                   |
| **Auto Review** | Guardian subagent (auto_review 审批审查者)             | 无                                                            |

---

## 7. 设计哲学对比

|                     | Codex                                                              | OMP                                                            |
| ------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| **整体风格**        | "给模型更多控制" — 模型管理上下文、申请权限、创建计划、spawn agent | "系统自动管理" — 自动 compaction、预配置权限、专用工具减少猜测 |
| **工具设计**        | 极简描述, 依赖模型对 API 的内置理解                                | 深度文档, 把约束编码进 prompt                                  |
| **代码编辑**        | 单一 `apply_patch` (unified diff)                                  | 多种路径: edit/write/ast_edit/LSP                              |
| **子 Agent**        | 显式 spawn/wait/message 原语, 更像 OS 进程模型                     | 统一 `task` 工具 + IRC 通信, 更像聊天群组模型                  |
| **提示词规模**      | 精简 (280 行基指令 + 模式模板)                                     | 丰富 (273 行模板 + 50+ 工具描述 + 模式注入)                    |
| **模型兼容性**      | GPT 系列 (OpenAI API 原生)                                         | 多模型 (OpenAI/Anthropic/Google/local)                         |
| **Vision Fallback** | 无 (所有模型支持图片)                                              | 完整的 vision→text 回退管线                                    |
| **Model Role**      | TOML role config → model 直接指定                                  | 10 个语义 Role → priority.json → 多层解析                      |

---

## 8. 补充: Codex Realtime Backend

Codex 有一个独特的双模型架构: "realtime backend" (语音/实时对话的前端) vs "backend agent" (编码执行的后端)。这两个层面有独立的系统提示词:

|            | Realtime Backend                                  | Backend Agent                            |
| ---------- | ------------------------------------------------- | ---------------------------------------- |
| **身份**   | "Codex, OpenAI general-purpose agentic assistant" | "coding agent in Codex CLI"              |
| **语气**   | "playful collaborator: fun, warm, witty"          | "concise, direct, and friendly"          |
| **职责**   | 对话表面, 委托后端执行, 不执行工作                | 实际编码执行                             |
| **提示词** | `backend_prompt.md` (~65 行)                      | `base_instructions/default.md` (~280 行) |

OMP 没有这种分离 — 单一 Agent 既是对话表面也是执行引擎。

---

## 附录: 文件索引

### Codex

| 文件                                                         | 内容                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `codex-rs/protocol/src/prompts/base_instructions/default.md` | 基础系统提示词 (280 行)                                  |
| `codex-rs/prompts/templates/realtime/backend_prompt.md`      | Realtime 后端提示词                                      |
| `codex-rs/prompts/templates/permissions/`                    | Sandbox/审批模板                                         |
| `codex-rs/prompts/templates/goals/`                          | Goal 模板                                                |
| `codex-rs/core/src/tools/handlers/`                          | 工具 handlers (~24 个)                                   |
| `codex-rs/core/src/context/`                                 | Context fragment 组装                                    |
| `codex-rs/core/src/agent/role.rs`                            | Agent role 定义和 spawn 描述                             |
| `codex-rs/ext/`                                              | 扩展工具 (web-search, image-gen, skills, memories, goal) |

### OMP

| 文件                                           | 内容                                        |
| ---------------------------------------------- | ------------------------------------------- |
| `src/system-prompt.ts`                         | 系统提示词构建器 (819 行)                   |
| `src/prompts/system/system-prompt.md`          | 基础系统提示词模板 (273 行)                 |
| `src/prompts/system/project-prompt.md`         | 项目上下文尾部模板                          |
| `src/prompts/system/subagent-system-prompt.md` | 子 Agent 包装模板                           |
| `src/prompts/system/personalities/`            | 三种人格模板                                |
| `src/prompts/tools/`                           | ~50 个工具描述模板                          |
| `src/prompts/agents/`                          | Agent frontmatter 定义                      |
| `src/task/`                                    | 子 Agent 编排 (spawn/executor/types/agents) |
| `src/config/model-roles.ts`                    | 10 个 Model Role 定义                       |
| `src/config/model-resolver.ts`                 | Role→Model 解析管线                         |
