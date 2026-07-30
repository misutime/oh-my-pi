# 上游 469 commits 冲突分析

> merge-base: `d16c6168c`
> 我们领先: **80 commits** | 上游领先: **469 commits**
> Bazel 构建体系已排除（我们拒绝，不分析）

---

## 总览

上游 469 个提交中，与我们修改的 TypeScript 核心代码有交集的文件共 **14 个**（已排除 Bazel 构建文件）。按冲突严重程度分三层：

| 层级 | 文件数 | 说明 |
|---|---|---|
| 🔴 高危 | 3 | 同一段逻辑双方都大幅改写，无法自动合并 |
| 🟡 中等 | 3 | 一方大改、另一方小改，或追加型冲突 |
| 🟢 低危 | 8 | 改动区域不重叠，仅需位置调整 |

---

## 🔴 高危冲突（3 处）

### 1. `session-advisors.ts` — Advisor 会话管理核心

**双方改动**：我们 +224/-18（14 hunks），上游 +142/-23（30+ hunks）

**我们做了什么**：实现了 **Terminal Review（终点审查）** 系统。当 Agent 完成一轮回答后，Advisor 异步审查最终输出，在回答发给用户**之前**拦截并给出建议。具体包括：
- `onPrimaryTurnEnd()` — 检测终点轮次，触发异步审查后立即返回，不阻塞主流程
- `#routeAdvice()` — 新增一整套终点审查结果的路由逻辑：nits 静默卡片、concerns/blockers 触发新一轮 Agent 思考（有配额控制和防重复）
- `onBatchComplete` — 审查完成追踪；纯噪音批处理显示紧凑 ✓ 卡片
- `ActiveAdvisor` 扩展了 `pendingTerminalReviewIds` / `pendingTerminalReviewGeneration` 字段
- `SessionAdvisorsHost` 接口新增 `scheduleAgentContinuation`

**上游做了什么**：主要为 Cursor/Codex 集成和会话生命周期加固：
- Advisor 支持 Cursor exec 协议（`createGrepTool`, `createEditTool`, `getToolContext`, `mcpResources`）
- 会话切换安全：`drainAndDetachRecorders()`, `pauseForSessionTransition()`, `reattachRecorderFeeds()`
- `AbortSignal` 贯穿所有异步路径（防止会话切换时残留回调）
- `initialCosts` — 恢复持久化的费用账本
- 删除了 `annotateForStaleness`（不再标记建议时效性）
- Native compaction 错误处理增强

**冲突在哪里**：
- 前 300 行完全重叠：`SessionAdvisorsHost` 接口、`ActiveAdvisor` 接口、`SessionAdvisors` 构造函数、`onPrimaryTurnEnd` 方法
- `#routeAdvice()` 方法双方都改 — 我们的终点审查路由 vs 上游删 staleness 注解
- `#buildAdvisorAgent()` 中双方都往 `AdvisorRuntime` 和 `Agent` 构造传了新参数

**你的决策**：
> 两边的改动**方向不同但目标不矛盾**。我们的 Terminal Review 是新增的用户体验功能；上游的 Cursor 集成和会话安全是基础设施加固。合并时需要手动对齐接口定义和新字段初始化顺序。**建议：保留我们的 Terminal Review 逻辑，接上游的 Cursor 支持和 AbortSignal 贯通，接口字段合并。**

---

### 2. `advisor/runtime.ts` — Advisor 运行时引擎

**双方改动**：我们 +93/-12（25 hunks），上游 +138/-24（28 hunks）

**我们做了什么**：适配 Terminal Review 流程的小幅调整——`onTurnEnd` 增加 `triggerMode` 和 `reviewId` 返回；错误处理中保留 note。

**上游做了什么**：Advisor 运行时全面加固：
- 新增会话切换暂停/恢复生命周期（`pauseForSessionTransition`, `resumeAfterSessionTransition`）
- 每个 drain 迭代加了 `AbortController` — 会话切换或 reset 时立即中断正在跑的 advisor prompt
- 模型身份追踪 + thinking 动态开关（provider refusal 时自动关掉 primary reasoning 重试）
- `onTurnError` / `maintainContext` / `onTurnSuccess` 全部加 `AbortSignal`
- 删除了 `hasFreshBacklog` 属性

**冲突在哪里**：
- `AdvisorRuntimeHost` 接口 — 双方都加了新字段
- `#drain()` 循环 — 我们加了 minor 调整，上游重写了循环控制（session transition 检查 + AbortController）
- 错误恢复路径 — 上游加了 classifier refusal 恢复（去 thinking 重试），我们加了 preserve note

**你的决策**：
> 上游的 AbortSignal 贯通是**必须接的**—没有它，会话切换时 advisor 的残留异步回调可能写到已销毁的 session。我们的改动小且局部，合并时融入上游的加固框架即可。**建议：以上游为准，将我们的 endpoint review hook 接入上游的新 abort 框架。**

---

### 3. `thinking.ts` — Thinking Effort 天花板逻辑

**双方改动**：我们 +83/-25，上游 +29/-10

**我们做了什么**：
- 新增 `resolveEffortCeiling()` — 从 model pattern 的 `:level` 后缀和 agent 定义的 `thinking-level` 中提取 effort 天花板
- 重构 `resolveTaskEffortLevel()` — `maxEffort` → `ceiling`，天花板 clamping 改为向下走 supported ladder 而非抛异常
- `clampThinkingLevelToCeiling()` — doc 优化

**上游做了什么**：
- `clampAutoThinkingEffort()` — 加了 `ceiling` 参数，实现 floor+ceiling 双层限制
- `resolveProvisionalAutoLevel()` — 显式传 `Effort.XHigh` 作为 ceiling（之前是隐式行为）

**冲突在哪里**：
- **语义冲突**：双方都在解决"thinking effort 上限控制"问题，但方案不同
  - 我们的方案：在任务分发层面设限 — `resolveEffortCeiling` 从配置提取上限，`resolveTaskEffortLevel` 遵守
  - 上游的方案：在 auto thinking 分类层面设限 — `clampAutoThinkingEffort` 接受 `ceiling` 参数
  - 两套方案不互斥，但函数签名和调用点都需要对齐
- `resolveProvisionalAutoLevel` — 上游改了（传 XHigh），我们没改这个函数

**你的决策**：
> 这是**唯一有语义重叠的冲突**。两边在解决同一类问题但切入点不同。上游的方案更底层（auto thinking 分类器级别），我们的方案更上层（任务分发级别）。两套可以共存——我们的 `resolveEffortCeiling` + `resolveTaskEffortLevel` 控制 task spawn 的上限，上游的 `clampAutoThinkingEffort` ceiling 控制 auto 模式本身的范围。**建议：两套都保留，`resolveTaskEffortLevel` 内部调用上游新版 `clampAutoThinkingEffort` 时传我们自己的 ceiling。**

---

## 🟡 中等冲突（3 处）

### 4. `agent-session.ts` — Agent 会话主类

| | 我们 | 上游 |
|---|---|---|
| 变更量 | +16/-1（3 hunks） | +330/-179（20+ hunks） |
| 内容 | Terminal Review 桥接（`scheduleAgentContinuation`, `onUserPrompt`, `hasActiveAdvisorReviews`） | Codex session store、Cursor bridge cwd、大量 import 重排 |

**冲突面小**（我们的改动仅 3 处），但上游改动量巨大。合并时主要是位置调整——上游可能移动了我们插入代码附近的区块。**建议：以上游为准，将我们的 3 处改动按语义重新定位。**

### 5. `interactive-mode.ts` — 交互模式 UI

| | 我们 | 上游 |
|---|---|---|
| 变更量 | +17/-2（5 hunks） | +67/-64（20+ hunks） |
| 内容 | Subagent HUD 显示 agent 类型和模型、中文 Advisor spinner、状态栏 dim 修复 | Changelog 显示模式、import 重排 |

改动区域基本不重叠。我们的 subagent HUD 在 `renderSubagentHudLines`（~402 行），上游的 changelog 逻辑在后面。**建议：直接合并，预期无逻辑冲突。**

### 6. `settings-schema.ts` — 设置 Schema

| | 我们 | 上游 |
|---|---|---|
| 变更量 | +17/-13 | +65/-6 |
| 内容 | 删除了 `task.maxEffort`（thinking ceiling 重构的一部分）、新增 Tab 模型循环配置 | 新增 `startup.changelogDisplay`、`browser.cdpUrl`、`marketplace.autoUpdate` 等 |

Schema 是追加型文件，通常无冲突。但我们的删除（`task.maxEffort`）需要确认上游不引用它。**建议：保留上游新增项，我们的删除确认无引用后执行。**

---

## 🟢 低危冲突（8 处）

| 文件 | 我们改动 | 上游改动 | 说明 |
|---|---|---|---|
| `main.ts` | +1 行 | +127/-56 | 我们加了一行，上游加了 Codex bridge + changelog 模式 |
| `task/executor.ts` | +12/-14 | +17/-4 | 我们的 thinking ceiling 传递 vs 上游小修 |
| `xdev.ts` | +2/-1 | +39/-14 | 上游 state interface 重构 |
| `auth-storage.ts` | +8 | +447/-28 | 上游 OAuth credential 大重构，我们仅 8 行 |
| `discovery/claude-plugins.ts` | +8/-5 | +144/-34 | 上游 Codex plugin discovery |
| `system-prompt.md` | +5/-1 | +3 | 双方小幅调整 |
| `advise-tool.ts` | +14/-7 | -11 | 上游删代码，我们加 advisor 追踪 |
| `agent-session-events.ts` | 1 hunk | 1 hunk | 事件类型扩展 |

这些文件改动区域不重叠或改动量极小，合并时主要是位置对齐。**无需决策。**

---

## 上游新增功能（我们完全没有，无冲突）

这些是上游 469 commits 中完全新增的功能模块，不影响我们已有代码：

| 功能 | 规模 | 说明 |
|---|---|---|
| **Cursor/Codex exec 协议** | ~2000 行新代码 | 支持 Cursor 的现代工具执行协议 |
| **Codex session store** | ~670 行 | Codex 会话持久化 |
| **Codex reset fireworks** | ~370 行 | Codex 重置时的 UI 动效 |
| **Voice/audio 独立 crate** | ~1100 行 | 音频引擎从 natives 抽离为独立 Rust crate |
| **Hashline v2 编辑语法** | ~1200 行 | 精简 patch 语言：移除了 `COPY`（复制行）和 `DELETE`（删除行）两个操作符，新增剪贴板操作。语法更简洁但 LLM 需要重新学习新语法写 patch。注意：这是 hashline 自身的编辑语言操作符，不影响 JS `Map.delete()` 等运行时 API |
| **OAuth credential pin** | ~200 行 | OAuth 凭据的持久化存储 |
| **MCP → extension 通知** | ~340 行 | MCP 服务器通知可以推送给扩展 |
| **startup changelog 显示模式** | 中型 | 启动时变更日志的显示策略 |
| **browser.cdpUrl 设置** | 小型 | 浏览器自动化连接到已有 CDP 端点 |
| **marketplace.autoUpdate** | 小型 | 扩展市场自动更新策略 |
| **Bazel 构建体系** | ~1000 行 | 我们明确拒绝 |

---

## 决策清单

| # | 决策项 | 推荐 | 理由 |
|---|---|---|---|
| 1 | `session-advisors.ts` — Terminal Review + Cursor 集成并存 | ✅ 合并，二者保留 | 方向不同不矛盾；接口字段手动对齐 |
| 2 | `advisor/runtime.ts` — 接上游 AbortSignal 框架 | ✅ 接上游，融入我们的 hook | 没有 AbortSignal 会话切换不安全 |
| 3 | `thinking.ts` — 两套 effort ceiling 方案 | ✅ 两套共存，分层控制 | 上游控制 auto 范围，我们控制 task spawn 上限 |
| 4 | Bazel 构建体系 | ❌ 拒绝 | 已决策 |
| 5 | Hashline v2 编辑语法 | ⚠️ 需评估 | 语法简化不影响运行时正确性，但 edit tool prompt 需要同步更新。接受则跟随上游语法演进；拒绝则未来 hashline 改动持续分歧 |
| 6 | 其余中等/低危文件 | ✅ 直接合并 | 无实质性逻辑冲突 |

---

## 合并策略建议

不建议一次性合并 469 commits，推荐分批：

1. **第一批（低危区）**：auth-storage, main.ts, task/executor, xdev, discovery, system-prompt, events, advise-tool — 直接 merge，仅位置对齐
2. **第二批（新功能区）**：Codex、Voice crate、MCP 通知、changelog 模式、browser.cdpUrl — 无冲突，纯新增，cherry-pick 或整区 merge
3. **第三批（高危区）**：session-advisors, advisor/runtime, thinking — 需要手动合并，预计主要工作量
4. **第四批（Hashline v2）**：评估是否接受编辑语法变更
