# xd:// 协议导致 discoverable 工具调用失败分析

## 问题现象

模型调用 `web_search` / `mcp__codegraph_explore` 等工具时，出现：

```
╭─── ✘ Web Search ─────────────────────────────────────╮
│ Error: Tool web_search not found                     │
╰──────────────────────────────────────────────────────╯
```

部分情况下 TUI 渲染为 `undefined/undefined`（工具名解析失败）。

## 根因

### 肇事提交

| 项目 | 详情 |
|---|---|
| Commit | `5ff277349c` |
| 作者 | `can1357 <me@can.ac>` (上游) |
| 标题 | `refactor(coding-agent): consolidated tool surface onto xd:// devices and hub` |
| 日期 | 2026-07-15 |
| 合并方式 | `Merge remote-tracking branch 'upstream/main'` |

### 变更内容

该提交用 **xd:// 虚拟设备协议**替换了旧的 BM25 工具发现系统：

- 新增 `ToolLoadMode`：`"essential"`（顶层工具）vs `"discoverable"`（xd:// 设备）
- 新增 `tools.xdev` 设置（默认 `true`），控制是否启用 xd:// 挂载
- `XDEV_KEEP_TOP_LEVEL = { todo, ask, grep }` — 只有这 3 个 discoverable 工具豁免
- 所有 `loadMode: "discoverable"` 且不在豁免名单的工具，从顶层函数调用中移除，改为通过 `write xd://<tool>` 调用

### 为什么旧代码没问题

旧系统中 `loadMode` 只在 `tools.discoveryMode === "all"` 时才生效（此时 discoverable 工具被 BM25 搜索系统隐藏）。**默认 `discoveryMode` 是 `"off"`，所以 `web_search` 默认是顶层工具，模型可以直接调用。**

### 为什么新代码有问题

新系统中 `tools.xdev` 默认 `true`，**所有 discoverable 工具无条件移入 xd:// 注册表**。部分模型忽略 xd:// 协议直接调用函数名 → `agent-loop.ts:1962` 抛出 `Tool X not found`。

## 影响范围

### 受影响的内置工具（14 个）

| 工具 | 文件 |
|---|---|
| `ast_edit` | `tools/ast-edit.ts` |
| `ast_grep` | `tools/ast-grep.ts` |
| `browser` | `tools/browser.ts` |
| `checkpoint` | `tools/checkpoint.ts` |
| `rewind` | `tools/checkpoint.ts` |
| `debug` | `tools/debug.ts` |
| `github` | `tools/gh.ts` |
| `inspect_image` | `tools/inspect-image.ts` |
| `lsp` | `lsp/index.ts` |
| `memory_edit` | `tools/memory-edit.ts` |
| `recall` | `tools/memory-recall.ts` |
| `retain` | `tools/memory-retain.ts` |
| `reflect` | `tools/memory-reflect.ts` |
| **`web_search`** | `web/search/index.ts` |

### 额外受影响

- **所有 MCP 工具**（如 `mcp__codegraph_explore`）— 默认 `discoverable`
- **所有自定义/扩展/RPC 宿主工具** — 默认 `discoverable`

### 不受影响（保留顶层）

`read`, `bash`, `edit`, `write`, `eval`, `glob`, `hub`, `task`, `learn`, `manage_skill`, `review`, `report-tool-issue`, `tts`, `image-gen`, `vibe`, `yield`, `goal`
+ 豁免名单：`todo`, `ask`, `grep`

## 关键代码路径

### 工具挂载 (`createTools`, `tools/index.ts:404-610`)

```typescript
const xdevEnabled = requestedTools === undefined && session.settings.get("tools.xdev");
if (xdevEnabled) {
    for (const tool of tools) {
        const mountable = isMountableUnderXdev(tool) && tool.name in BUILTIN_TOOLS;
        (mountable ? mounted : kept).push(tool);
    }
    session.xdevRegistry = new XdevRegistry(mounted);
    tools = kept;  // discoverable 工具被移除
}
```

### 挂载判定 (`isMountableUnderXdev`, `tools/xdev.ts:54-55`)

```typescript
export function isMountableUnderXdev(tool: { name: string; loadMode?: ToolLoadMode }): boolean {
    return tool.loadMode === "discoverable" && !(tool.name in XDEV_KEEP_TOP_LEVEL);
}
```

### 工具查找失败 (`executeToolCalls`, `agent/src/agent-loop.ts:1962`)

```typescript
if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
```

无回退逻辑，不检查 xd:// 注册表，不提示正确调用路径。

### TUI 渲染 (`tool-execution.ts:386-387`)

```typescript
this.#toolName = toolName;
this.#toolLabel = tool?.label ?? toolName;
```

工具不在注册表时 `tool` 为 `undefined`，`#toolLabel` 回退到 `toolName`。但如果 toolName 本身解析失败（如 MCP 工具名包含特殊字符被截断），则可能出现 `undefined/undefined`。

---

# 临时修复方案

> **注意：这是临时方案。上游 `can1357/oh-my-pi` 以极高频率迭代（日均 ~128 commits），该问题大概率会在近期被上游修复。届时需评估上游方案，决定保留或回退。**

## 策略：优化提示词而非改代码

不改 `XDEV_KEEP_TOP_LEVEL`、不改工具 `loadMode`、不碰 agent-loop。根因是**系统 prompt 对 xd:// 调用约定的传达不够强**——两处优化即可显著降低认知摩擦。

## 改动 1：强化 xd:// 段首说明

**文件**: `packages/coding-agent/src/prompts/system/system-prompt.md` (lines 82-87)

**现状**:
```markdown
# xd:// Tool Devices
Additional tools are mounted as virtual devices, executed by writing a JSON
args object as `content` to `xd://<tool>` via `write`.
Invalid args return the schema in the error — fix and retry
```

**改为**:
```markdown
# xd:// Tool Devices
Additional tools are mounted as virtual devices, executed by writing a JSON
args object as `content` to `xd://<tool>` via `{{toolRefs.write}}`.
Invalid args return the schema in the error — fix and retry

<critical>
These are NOT callable as `tool_name(...)` functions. You MUST use
`{{toolRefs.write}}` with `path: "xd://<tool>"` and `content` as a JSON
string of the arguments. Calling them directly as functions will fail with
"Tool not found".
</critical>
```

**效果**: 
- RFC 2119 关键词 (`MUST`, `critical`) 与系统 prompt 其他部分一致
- 明确告知**不该做什么**（负例）——这是当前版本缺失的
- `{{toolRefs.write}}` 保持模板变量一致性

## 改动 2：每个工具条目中，调用方式放在 schema 之前

**文件**: `packages/coding-agent/src/tools/xdev.ts` (`renderDocs` 函数, lines 87-104)

**现状**（调用方式在 schema 之后）:
```typescript
return [
    `${heading} ${inst.name}...`,
    "",
    description,
    "",
    `${heading}# Schema`,
    "```json",
    schema,
    "```",
    `Execute by writing JSON to ${XD_URL_PREFIX}${inst.name}.`,  // ← 最后
].join("\n");
```

**改为**（调用方式紧跟工具名，schema 放后面）:
```typescript
return [
    `${heading} ${inst.name}${inst.label ? ` — ${inst.label}` : ""}`,
    "",
    `> Invoke via \`${toolRefWrite}\` with \`path: "${XD_URL_PREFIX}${inst.name}"\` and \`content\` as JSON args.`,
    "",
    description,
    "",
    `${heading}# Schema`,
    "```json",
    schema,
    "```",
].join("\n");
```

> 注：`toolRefWrite` 需要从外部传入（当前 `renderDocs` 不感知模板变量）。如果不想改动函数签名，可以硬编码为 `\`write\`` —— 系统 prompt 中 `write` 不会改名。

**效果**:
- 模型读到工具名后**立即**看到调用方式，不会形成"这是函数调用"的第一印象
- blockquote 格式 (`>`) 在视觉上区分"怎么调"和"干什么"

## 预期效果

| 改前 | 改后 |
|---|---|
| 模型第一反应：`web_search(query=...)` | 第一反应：`write({path: "xd://web_search", content: ...})` |
| "not found" → 回溯 → 自愈 (~500 token 浪费) | 直接正确调用 (0 浪费) |
| 弱模型可能反复失败 | 负例指导降低失败率 |

## 验证

修改后启动 omp，确认：
1. 系统 prompt 中 xd:// 段包含 `<critical>` 块，含 MUST 和负例
2. 每个 xd:// 工具条目开头就是 `> Invoke via write...`
3. 模型首次调用 xd:// 工具即使用 `write` 而非直接函数调用

## 回退

```bash
git revert <此临时修复的 commit>
```

或手动还原两个文件的改动。
