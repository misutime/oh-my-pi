# Model Roles 使用场景调研报告

> 基于源码深度追踪：Role 定义、解析管线、Agent frontmatter、Plan Mode 生命周期、Commit Pipeline、Memory 管线、Title 生成、Vision 回退等。
> 分析日期：2026-07-15

---

## 1. 架构概览

系统定义了 **10 个内置 Model Role**，每个 Role 是一个语义标签，通过多层解析管线映射到具体 AI 模型。用户可通过 `modelRoles` 配置项覆盖任意 Role 对应的实际模型。

### 解析管线（优先级从高到低）

| 阶段 | 机制 |
|---|---|
| 1. 显式配置 | `settings.getModelRole(role)` → 用户直接指定的模型 |
| 2. Default 继承 | `smol`/`slow`/`designer` 未配置时继承 `default` 的模型 |
| 3. Priority 别名 | `advisor` → `slow` 链, `tiny` → `smol` 链 |
| 4. Priority 链回退 | `priority.json` 中按序尝试候选模型 |
| 5. 通配符/别名展开 | `@rolename` / `pi/rolename` / `*` 语法 |

### Role 别名语法

```
@rolename          — 规范别名（如 @smol）
pi/rolename        — 旧版兼容别名
*                  — default Role 的简写
@rolename:xhigh    — 携带 thinking level 后缀
```

---

## 2. 十大内置 Role — 按场景归类的使用分析

### 2.1 主交互场景

#### `default` — 默认主会话模型

| 属性 | 值 |
|---|---|
| 标签 | **DEFAULT** |
| 显示名 | Default |
| 色标 | `success` (绿色) |
| 继承 default | — (自身) |
| Priority 链 | 无独立链，完全依赖显式配置 |

**源码追踪 — 调用场景**：

| 场景 | 代码位置 | 行为 |
|---|---|---|
| 会话启动 | `model-resolver.ts:resolveModelFromSettings()` | 遍历 `MODEL_ROLE_IDS` 顺序找到第一个已配置 Role 的模型；未配置任何 Role 时返回 `availableModels[0]` |
| Dry-Balance | `dry-balance-cli.ts:resolveDryBalanceModel()` | 用 `settings.getModelRole("default")` 解析余额查询模型 |
| 子 Agent 回退 | `model-resolver.ts:resolveAgentModelPatterns()` | 当 Agent 无显式 `model:` 时，回退到 `default` 的模型 |
| Vision 回退 | `image-vision-fallback.ts:resolveVisionModel()` | `@vision` → `@default` → active model → 第一个 image-capable |
| Memory Phase1 回退 | `memories/index.ts:runPhase1()` | `fallbackRole: "default"` — 用主会话模型做记忆提取 |
| 继承源 | `model-resolver.ts:shouldInheritDefaultBeforePriority()` | `smol`/`slow`/`designer` 未配置时先继承 `default` 配置（再回退到 priority.json） |

---

#### `smol` — 快速/低成本模型

| 属性 | 值 |
|---|---|
| 标签 | **SMOL** |
| 显示名 | Fast |
| 色标 | `warning` (琥珀色) |
| 继承 default | ✅ 是（`shouldInheritDefaultBeforePriority` 白名单） |

**Priority 链**：
```
cerebras/zai-glm-4.7 → zai-glm-4.6 → zai-glm →
gemini-3.1-flash-lite → gemini-3.5-flash → gemini-3-flash →
haiku-4-5 → haiku → flash → mini
```

**源码追踪 — 调用场景**：

| 场景 | 代码位置 | 行为 |
|---|---|---|
| **Commit Reduce 阶段** | `commit/model-selection.ts:resolveSmolModel()` | 为 map-reduce 分析提供快速模型：先解析 `"smol"` Role，回退到 `MODEL_PRIO.smol` 逐个匹配，最后用 `primaryModel` |
| **Commit 消息生成** | `utils/commit-message-generator.ts:getSmolModelCandidates()` | 生成 commit message 的候选模型列表：配置的 `smol` → `MODEL_PRIO.smol` 模式匹配 → 全部 available |
| **Memory Phase2 回退** | `memories/index.ts:runPhase2()` | `fallbackRole: "smol"` — 用快速模型做记忆整合 |
| **Title 生成回退** | `utils/title-generator.ts:getTitleModel()` | `resolveRoleSelection(["tiny", "commit", "smol"])` — `tiny`/`commit` 都不可用时用 `smol` |
| **`tiny` Role 别名源** | `model-resolver.ts:ROLE_PRIORITY_ALIAS` | `tiny: "smol"` — `tiny` 复用 `smol` 的 priority 链 |
| **`sonic` Agent** | `task/agents.ts` | 低推理子 Agent 使用 `@smol` |
| **`scout` Agent** | `prompts/agents/scout.md` | 只读搜索 Agent 使用 `@smol` |
| **`librarian` Agent** | `prompts/agents/librarian.md` | 库/API 研究 Agent 使用 `@smol` |
| **Alt+M 模型切换** | `session/agent-session.ts:cycleRoleModels()` | 用户可在 Role 间循环切换 |

---

#### `slow` — 强力推理模型

| 属性 | 值 |
|---|---|
| 标签 | **SLOW** |
| 显示名 | Thinking |
| 色标 | `accent` (紫色/蓝色) |
| 继承 default | ✅ 是 |

**Priority 链**：
```
gpt-5.5 → gpt-5.4 → gpt-5.3-codex → gpt-5.2-codex → gpt-5.1-codex →
codex → opus-4.8 → opus-4.7 → opus-4.6 → opus-4.5 → opus-4.1 → pro
```

**源码追踪 — 调用场景**：

| 场景 | 代码位置 | 行为 |
|---|---|---|
| **`reviewer` Agent** | `prompts/agents/reviewer.md` | 代码审查 Agent 使用 `@slow` — 需要深度推理能力 |
| **`advisor` Role 别名源** | `model-resolver.ts:ROLE_PRIORITY_ALIAS` | `advisor: "slow"` — 复用 `slow` 的 priority 链 |
| **Alt+M 手动切换** | `session/agent-session.ts:cycleRoleModels()` | 用户处理复杂问题时切换到强力模型 |

---

### 2.2 Plan Mode 场景

#### `plan` — 架构规划模型

| 属性 | 值 |
|---|---|
| 标签 | **PLAN** |
| 显示名 | Architect |
| 色标 | `muted` |
| 继承 default | ❌ 否 |

**源码追踪 — Plan Mode 完整生命周期**：

```
enterPlanMode()
  → applyPlanModeModel()
    → resolveRoleModelWithThinking("plan")
    → settings.getModelRole("plan")
    → setModelTemporary(plan-model)     ← 临时切换到 plan Role

... Agent 生成计划 ...

resolve tool: action=apply
  → approveAndResolvePlan()
    → exitPlanMode()
      → restorePlanPreviousModel()     ← 恢复进入 Plan Mode 前的模型
      → 用户可通过 model slider 选择执行模型
        → applyRoleModel(execution-role-entry)

PlanYolo 模式（无交互）：
  → runPlanYoloApprovalResolve()
    → planYolo.target 指定的模型（或保持不变）
```

**关键源码**：`modes/interactive-mode.ts:#enterPlanMode`, `#exitPlanMode`, `#applyPlanModeModel`, `#applyPlanExecutionModel`, `#applyDeferredPlanModelTransition`

**Plan 模型的特殊行为**：
- 进入 Plan Mode 时"借用"plan Role 模型，原模型保存在 `#planModePreviousModelState`
- 退出时恢复，用户可从 model-tier slider 选择不同的执行模型
- 若只配置了 `modelRoles.plan` 而未配 `default`，`getRoleModelCycle` 会合成一个单独的 `default` 条目（用 plan 模型），此时 slider 隐藏
- Thinking level 也会在 plan ↔ execution 间切换：相同的 model + 不同 thinking suffix 视为不同

---

### 2.3 子 Agent / Task 场景

#### `task` — 子任务执行模型

| 属性 | 值 |
|---|---|
| 标签 | **TASK** |
| 显示名 | Subtask |
| 色标 | `muted` |
| 继承 default | ❌ 否（有特殊处理） |

**子 Agent 模型解析链路**：

```
TaskTool.execute()
  → task.agentModelOverrides[name]?  ← 优先：per-agent override
  → resolveAgentModelPatterns({
      settingsOverride,      // 来自 task.agentModelOverrides
      agentModel,            // Agent 的 model: frontmatter
      activeModelPattern,    // 父会话当前模型
      fallbackModelPattern,  // 来自 settings
    })

resolveAgentModelPatterns 内部逻辑：
  1. settingsOverride 非空 → 直接使用
  2. agentModel 是 "@task" / "pi/task" → 不继承会话模型，直接返回配置的 task Role 模型
  3. agentModel 是 session-inherited（如 @default） → 回退到 activeModelPattern
  4. 其他 agentModel → 返回配置的 agent 模型
  5. 最终 fallback → getModelRole("default")
```

**关键源码**：`config/model-resolver.ts:resolveAgentModelPatterns()`（`@task` 的特殊 `if` 分支在 line 1045-1049）

| Agent | model: | 行为 |
|---|---|---|
| `task` | `@task` | 使用配置的 task Role 模型，**不继承**父会话模型 |
| `sonic` | `@smol` | 低推理快速 Agent |
| `scout` | `@smol` | 只读搜索 |
| `librarian` | `@smol` | 库研究 |
| `reviewer` | `@slow` | 代码审查 |
| `designer` | `@designer` | UI/UX 设计 |

**子 Agent 模型覆盖**：`task.agentModelOverrides` settings 可为每个 Agent 名指定覆盖模型。

---

### 2.4 Commit 生成场景

#### `commit` — 提交信息生成模型

| 属性 | 值 |
|---|---|
| 标签 | **COMMIT** |
| 显示名 | Commit |
| 色标 | `dim` |
| 继承 default | ❌ 否 |

**Commit Pipeline 模型使用**：

```
Legacy Pipeline (runLegacyCommitCommand):
  resolvePrimaryModel()
    → resolveRoleSelection(["commit", "smol", ...MODEL_ROLE_IDS])
    → 解析顺序: commit → smol → default → slow → vision → ...
  resolveSmolModel()
    → resolveRoleSelection(["smol"])
    → 回退: MODEL_PRIO.smol 逐个匹配
    → 最终 fallback: primaryModel

  primaryModel → generateConventionalAnalysis()   (整体 diff 分析)
  primaryModel → generateSummary()                (commit message 生成)
  smolModel    → runMapReduceAnalysis()           (大 diff 的 reduce 阶段)
```

**关键源码**：`commit/model-selection.ts:resolvePrimaryModel()`, `resolveSmolModel()`; `commit/pipeline.ts:generateAnalysis()`

---

### 2.5 Memory / Title / 微任务场景

#### `tiny` — 微型任务模型

| 属性 | 值 |
|---|---|
| 标签 | **TINY** |
| 显示名 | Tiny |
| 色标 | `dim` |
| Priority 别名 | → `smol` |
| 继承 default | ❌ 否 |

**双模式运行**：

| 模式 | 配置键 | 模型来源 |
|---|---|---|
| **Online** | `providers.tinyModel = "online"` (默认) | 解析 `tiny` → `commit` → `smol` Role 链，通过 API 调用 |
| **Local** | `providers.tinyModel = "lfm2-350m"` 等 | 本地 ONNX 模型，不消耗 API 额度 |

**本地模型支持**：
- **Title 模型**（0.27B–0.7B）：`lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`
- **Memory 模型**（1B–3B）：`qwen3-1.7b`, `llama3.2:3b`, `gemma-3-1b`, `qwen2.5-1.5b`, `lfm2-1.2b`

**源码追踪 — 调用场景**：

| 场景 | 代码位置 | 行为 |
|---|---|---|
| **会话标题生成** | `utils/title-generator.ts:getTitleModel()` | `resolveRoleSelection(["tiny", "commit", "smol"])` — 三层回退 |
| **Memory 提取** | `memories/index.ts:runPhase1()` | `fallbackRole: "default"` — Phase1 用主会话模型 |
| **Memory 整合** | `memories/index.ts:runPhase2()` | `fallbackRole: "smol"` — Phase2 用快速模型 |
| **意外停止分类** | `session/unexpected-stop-classifier.ts:classifyLocal()` | 本地 tiny 模型分类 agent 意外停止原因 |
| **Task 标签生成** | `task/label.ts:generateTaskLabel()` | 调用 `generateSessionTitle()` 生成子任务描述标签 |
| **Auto-thinking 分类** | `auto-thinking/classifier.ts` | 用 tiny 模型判断任务难度以决定 thinking level |

**Title 生成在线路径**：
```
generateSessionTitle()
  → providers.tinyModel === "online" → generateTitleOnline()
    → getTitleModel() → resolveRoleSelection(["tiny", "commit", "smol"])
    → 逐个尝试直到找到有 API key 的模型
```

---

### 2.6 视觉/多模态场景

#### `vision` — 图像分析模型

| 属性 | 值 |
|---|---|
| 标签 | **VISION** |
| 显示名 | Vision |
| 色标 | `error` (红色) |
| 继承 default | ❌ 否 |

**Image Vision Fallback 完整链路**：

```
用户粘贴图片到 text-only 模型
  → describeAttachedImagesForTextModel()
    → resolveVisionModel()
      → 1. resolvePattern("@vision")   ← 优先: 配置的 vision Role
      → 2. resolvePattern("@default")  ← 回退: default Role（若 image-capable）
      → 3. resolvePattern(activeModelString)  ← 当前模型（若 image-capable）
      → 4. available.find(model.input.includes("image"))  ← 第一个多模态模型
    → 逐个图片:
      → saveImage(local://image-<hash>.png)
      → describeImage(visionModel, image)
      → formatImageBlock(localUrl, description)
        → "<image path="local://..." description="..." />" 注入 prompt
```

**关键源码**：`utils/image-vision-fallback.ts:resolveVisionModel()`, `describeAttachedImagesForTextModel()`

---

### 2.7 审查/顾问场景

#### `advisor` — 侧通道审查模型

| 属性 | 值 |
|---|---|
| 标签 | **ADVISOR** |
| 显示名 | Advisor |
| 色标 | `accent` |
| Priority 别名 | → `slow` |
| 继承 default | ❌ **明确不继承**（只复用 `slow` 的 priority 链） |

**Advisor 启动条件**：

```
#buildAdvisorRuntime()
  → advisor.enabled === true
  → agentKind === "main" || advisor.subagents === true
  → #advisors.length === 0 (未重复创建)
```

**行为**：
- 创建独立的 Agent 实例（独立 context、独立工具集）
- 读取主会话 transcript，作为"第二意见"审查
- 模型通过 `resolveAdvisorRuntimeDescriptors()` 解析（内部用 advisor Role 配置）
- 输出被 `quarantineAdvisorUnsafeOutput()` 过滤后再注入主会话

**与 `slow` 的区别**：
- 复用 `slow` 的 priority.json 链（同样选强力模型）
- 但**从不继承** `default` 的显式配置 — 保持独立的强力模型选择
- 若 `advisor` Role 显式配置，直接使用配置；未配置时才走 `slow` 的 priority 回退

**关键源码**：`session/agent-session.ts:#buildAdvisorRuntime()`; `advisor/runtime.ts`

---

### 2.8 UI/UX 设计场景

#### `designer` — 设计专用模型

| 属性 | 值 |
|---|---|
| 标签 | **DESIGNER** |
| 显示名 | Designer |
| 色标 | `muted` |
| 继承 default | ✅ 是 |

**Priority 链**：
```
gemini-3.1-pro → gemini-3-pro → gemini-3.5-flash → gemini-3-flash
```

**调用场景**：
- `designer` Agent (`prompts/agents/designer.md`) — UI/UX 设计专用子 Agent

---

## 3. Role 映射总表

| Role | 标签 | 显示名 | 继承 default | 别名源 | 主要调用方 |
|---|---|---|---|---|---|
| `default` | DEFAULT | Default | — | — | 主会话、所有未配置 Role 的回退 |
| `smol` | SMOL | Fast | ✅ | `tiny` 别名源 | Commit reduce, memory Phase2, title 回退, scout/librarian/sonic |
| `slow` | SLOW | Thinking | ✅ | `advisor` 别名源 | reviewer Agent, 手动切换 |
| `vision` | VISION | Vision | ❌ | — | 图片描述回退 |
| `plan` | PLAN | Architect | ❌ | — | Plan Mode 规划阶段 |
| `designer` | DESIGNER | Designer | ✅ | — | designer Agent |
| `commit` | COMMIT | Commit | ❌ | — | Commit 主分析、commit message 生成 |
| `tiny` | TINY | Tiny | ❌ | → `smol` | 标题生成、记忆提取/整合、auto-thinking 分类 |
| `task` | TASK | Subtask | ❌ | — | task Agent (子任务执行，不继承会话模型) |
| `advisor` | ADVISOR | Advisor | ❌ | → `slow` (不继承 default) | 侧通道代码审查 |

---

## 4. 子 Agent 模型解析完整流程

```
TaskTool.execute()
  │
  ├─ task.agentModelOverrides[name] ?
  │   └─ YES → 使用覆盖配置 (最高优先级)
  │
  └─ NO → resolveAgentModelPatterns({
            agentModel: agentConfig.model,   // frontmatter 中的 model: 字段
            activeModelPattern: parentModel, // 父会话当前模型
            fallbackModelPattern: settings,  // modelRoles.default
          })
          │
          ├─ agentModel === "@task" → 特殊: 不继承父会话，直接解析 task Role
          ├─ agentModel 其他 Role → 解析该 Role 的配置模型
          ├─ agentModel 是 session-inherited → 使用父会话模型
          └─ 无 agentModel → fallback 到 modelRoles.default
```

**6 个内置 Agent 的 model 分配**：

| Agent | model: | 解析结果 |
|---|---|---|
| `task` | `@task` | 用 task Role 配置，不继承父会话 |
| `sonic` | `@smol` | 用 smol Role 的快速模型 |
| `scout` | `@smol` | 只读搜索用快速模型 |
| `librarian` | `@smol` | 库研究用快速模型 |
| `reviewer` | `@slow` | 代码审查用强力推理模型 |
| `designer` | `@designer` | UI/UX 用设计模型 |

---

## 5. 关键调用链速查

| 场景 | 调用入口 | Role 解析顺位 |
|---|---|---|
| 会话启动 | `resolveModelFromSettings()` | MODEL_ROLE_IDS 顺序 → availableModels[0] |
| 子 Agent 模型 | `resolveAgentModelPatterns()` | override → agent.model → session model → default |
| Commit 主模型 | `resolvePrimaryModel()` | commit → smol → 全部 MODEL_ROLE_IDS |
| Commit reduce | `resolveSmolModel()` | smol → priority.json → fallback |
| Title 生成 | `getTitleModel()` | tiny → commit → smol |
| Memory Phase1 | `resolveMemoryModel(fallbackRole:"default")` | default → session.model |
| Memory Phase2 | `resolveMemoryModel(fallbackRole:"smol")` | smol → session.model |
| Vision 回退 | `resolveVisionModel()` | @vision → @default → active → first image-capable |
| Plan Mode 进入 | `applyPlanModeModel()` | plan Role |
| Advisor 启动 | `#buildAdvisorRuntime()` | advisor Role (优先级: slow 链) |

---

## 6. Settings 配置接口

### `modelRoles`
```jsonc
{
  "modelRoles": {
    "default": "anthropic/claude-sonnet-4-5",
    "smol": "google/gemini-3.5-flash",
    "slow": "openai/gpt-5.1-codex",
    "plan": "@slow",          // 可引用其他 Role
    "advisor": "@slow:xhigh"  // 可附加 thinking level
  }
}
```

### `cycleOrder` — Alt+M 切换顺序
```jsonc
{ "cycleOrder": ["slow", "default", "smol"] }
```

### `modelTags` — Role 显示元数据
```jsonc
{ "modelTags": { "smol": { "hidden": true }, "custom": { "name": "My Role", "color": "success" } } }
```

### `task.agentModelOverrides` — 子 Agent 模型覆盖
```jsonc
{ "task": { "agentModelOverrides": { "reviewer": "openai/gpt-5.5", "scout": "@smol:xhigh" } } }
```

---

## 7. 扩展：自定义 Role

1. 在 `modelRoles` 中添加新键值
2. 可选地在 `modelTags` 中配置 name/color/hidden
3. 在 `cycleOrder` 中包含新 Role
4. 自定义 Role 无 priority.json 回退链 — **必须显式配置模型**
5. 可通过 `@custom-role` 语法在其他 Role 配置中引用

---

## 附录：源码索引

| 文件 | 内容 |
|---|---|
| `src/config/model-roles.ts` | `ModelRole` 类型、`MODEL_ROLES` 元数据、`MODEL_ROLE_IDS`、`getKnownRoleIds()`、`getRoleInfo()` |
| `src/config/model-resolver.ts` | 全解析管线：`resolveConfiguredRolePattern()`、`rolePriorityDefaults()`、`resolveAgentModelPatterns()`、`resolveModelRoleValue()`、`ROLE_PRIORITY_ALIAS`、`shouldInheritDefaultBeforePriority()` |
| `src/config/settings.ts` | `setModelRole()`、`getModelRole()`、`getModelRoles()` |
| `src/priority.json` | `smol`/`slow`/`designer` 的默认 model 候选链 |
| `src/utils/image-vision-fallback.ts` | `resolveVisionModel()` — vision Role 的图像回退 |
| `src/tiny/models.ts` | tiny Role 的在线/本地模型定义 |
| `src/commit/model-selection.ts` | `resolvePrimaryModel()`、`resolveSmolModel()` |
| `src/advisor/runtime.ts` | Advisor Agent 运行时接口 |
| `src/session/agent-session.ts` | `getRoleModelCycle()`、`cycleRoleModels()`、`applyRoleModel()`、`#buildAdvisorRuntime()`、plan-mode 模型方法 |
| `src/modes/interactive-mode.ts` | `#enterPlanMode`、`#exitPlanMode`、`#applyPlanModeModel`、`#applyPlanExecutionModel` |
| `src/modes/components/model-browser.ts` | `resolveRoleAssignments()` — UI 中展示 Role 模型映射 |
| `src/memories/index.ts` | `resolveMemoryModel()`、`runPhase1()`、`runPhase2()` |
| `src/utils/title-generator.ts` | `getTitleModel()`、`generateSessionTitle()` |
| `src/auto-thinking/classifier.ts` | tiny model 用于 auto-thinking 难度分类 |
| `src/task/agents.ts` | Agent 定义中的 model 字段配置 |
| `src/prompts/agents/*.md` | scout/reviewer/designer/librarian 的 frontmatter 定义 |
| `src/session/unexpected-stop-classifier.ts` | tiny model 用于意外停止分类 |
