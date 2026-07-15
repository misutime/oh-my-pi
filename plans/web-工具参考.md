# omp Web 工具参考

## 架构总览

omp 通过**三条互补路径**暴露 web 能力，全部属于默认工具集：

| 工具 | 用途 | 零配置可用？ |
|---|---|---|
| `web_search` | 搜索互联网，返回结果 + 摘要 | ✅ (DDG/Ecosia/Mojeek 免凭证) |
| `read(url)` | 抓取网页内容并提取为 markdown | ✅ (内置 native reader) |
| `browser` | 完整 Chromium 标签页 — JS 执行、登录、截图 | ✅ (捆绑 headless Chromium) |

---

## 1. `web_search` — 搜索引擎

### 工作原理

`web_search` 底层由 **20+ 个 provider** 组成一条可配置的自动回退链。每轮搜索：

1. **解析 provider 列表** — `resolveProviderChain()` 遍历 `SEARCH_PROVIDER_ORDER`，收集所有 `isAvailable()` 返回 `true` 的 provider（有凭证、未被排除）。
2. **依次尝试** — 第一个返回有效内容的 provider 胜出。
3. **格式化给 LLM** — 结果文本包含摘要 + 来源链接（按模型输出预算截断）。

### 默认 provider 优先级（auto 模式）

```
Perplexity → Gemini → Anthropic → Codex (OpenAI) → xAI
→ Z.AI → Exa → TinyFish → Jina → Kagi → Tavily
→ Firecrawl → Brave → Kimi → Parallel → Synthetic
→ SearXNG → Startpage → DuckDuckGo → Ecosia
→ Google → Mojeek → Public Web
```

每多配一个 API key，只是在这个链条里新增一个优先尝试点。失败自动跳到下一个——**免费 fallback 永远不会丢**。

### 免凭证 provider

以下 provider 不需要任何 API key 或 OAuth 即可使用。auto 模式会跳过所有不可用的 API provider，落在第一个免凭证引擎上——**web_search 零配置完整可用**。

实测（`omp q "bun runtime performance"`，无任何凭证配置）：
- 命中的 provider：**Startpage**（免凭证 tier 的第一个）
- 返回 10 条结果，耗时约 3 秒，带摘要和 URL
- Google 搜索结果质量

| Provider | 机制 | 备注 |
|---|---|---|
| `duckduckgo` | 抓取 HTML 前端 | 数据中心/共享出口 IP 可能触发 bot 验证 |
| `startpage` | 抓取 Startpage（Google 后端） | 同上——可能触发 bot 验证 |
| `ecosia` | 浏览器后端抓取（Google 后端） | 通过 Chromium 页面，较慢 |
| `google` | 浏览器后端回退 | 更慢，可能触发 bot 验证 |
| `mojeek` | 浏览器后端抓取（独立索引） | 自有索引，非 Google 后端 |
| `public` | 并发查询所有免凭证引擎并合并去重 | 覆盖面最广但最慢 |

### API-key provider

这些需要 API key 或 OAuth 登录。通过 `/login <provider>` 或环境变量配置。

| Provider | 认证方式 | 环境变量 |
|---|---|---|
| `perplexity` | API key 或匿名回退 | `PERPLEXITY_API_KEY` |
| `gemini` | Google OAuth 或 API key | `GEMINI_API_KEY` |
| `anthropic` | Anthropic OAuth 或 API key | `ANTHROPIC_API_KEY` |
| `codex` | ChatGPT OAuth (`/login openai-codex`) | — |
| `xai` | API key | `XAI_API_KEY` |
| `zai` | Streamable HTTP MCP | — |
| `exa` | API key 或 MCP 回退 | `EXA_API_KEY` |
| `tinyfish` | API key | `TINYFISH_API_KEY` |
| `jina` | API key | `JINA_API_KEY` |
| `kagi` | API key (Kagi Search API beta) | `KAGI_API_KEY` |
| `tavily` | API key | `TAVILY_API_KEY` |
| `firecrawl` | API key | `FIRECRAWL_API_KEY` |
| `brave` | API key | `BRAVE_API_KEY` |
| `kimi` | API key | `MOONSHOT_SEARCH_API_KEY` 或 `MOONSHOT_API_KEY` |
| `parallel` | API key | `PARALLEL_API_KEY` |
| `synthetic` | API key | `SYNTHETIC_API_KEY` |
| `searxng` | 自托管端点 | `SEARXNG_ENDPOINT` |

### 工具参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string（必填） | 搜索查询 |
| `provider` | string | 显式指定 provider（`auto` = 强制完整 auto 链） |
| `recency` | `"day"`, `"week"`, `"month"`, `"year"` | 时间过滤 |
| `limit` | number | 最大返回结果数 |
| `max_tokens` | number | 输出 token 预算 |
| `num_search_results` | number | 向 provider 请求的原始结果数 |
| `temperature` | number | provider 端生成温度 |

### 设置项

```jsonc
{
  "web_search.enabled": true,                    // 是否启用该工具（默认：true）
  "providers.webSearch": "auto",                 // 首选 provider 或 "auto"
  "providers.webSearchExclude": [],               // 永久跳过的 provider
  "providers.webSearchGeminiModel": "gemini-2.5-flash" // Gemini 搜索用的模型
}
```

### Agent 指令（注入 prompt）

Agent 看到的是 `src/prompts/tools/web-search.md` 的内容：
- 优先使用一手来源（论文、官方文档）
- 用多个来源交叉验证关键结论
- 必须在最终回复中附上来源链接

---

## 2. `read(url)` — 网页内容抓取

### 工作原理

`read` 工具将 URL 与本地文件、目录、SQLite、压缩包、图片等统一处理。**不存在独立的 `web_fetch` 工具**。

当路径被识别为 URL 时：
1. `parseReadUrlTarget()` 提取 URL 和可选的行选择器。
2. `executeReadUrl()` 抓取并渲染内容。
3. 质量门禁：输出必须 > 100 个非空白字符，且不能是已知错误页面。

结果格式为**干净的 markdown**——剥离 HTML，保留可读文本。

### 渲染管道（按优先级）

由 `providers.fetch` 设置控制（默认：`"auto"`）。

| 后端 | 机制 | 备注 |
|---|---|---|
| `native` | 进程内 puppeteer reader | 即时，无网络开销，处理大多数页面 |
| `trafilatura` | Python 内容提取 | 本地可用（需安装 `trafilatura`） |
| `lynx` | 终端浏览器 | 本地可用（需安装 `lynx`） |
| `parallel` | Parallel API | 远端，需 `PARALLEL_API_KEY` |
| `jina` | Jina Reader API (`r.jina.ai`) | 远端，需 `JINA_API_KEY` |

回退行为：每个后端按顺序尝试；第一个输出满足质量门禁的胜出。远端后端每次尝试上限 10 秒，防止拖死整个管道。

### 特殊 URL 处理（无需配置）

| URL 类型 | 行为 |
|---|---|
| GitHub issue、PR、仓库 | 通过 API 获取结构化 markdown |
| Stack Overflow、Reddit | Reader-mode 内容提取 |
| NPM 包 | 包元数据 |
| Wikipedia | 干净的条目文本 |
| arXiv、RSS/Atom 订阅源 | Reader mode |
| PDF、DOCX、PPTX、XLSX、RTF、EPUB | 提取文本 |
| JSON 端点 | 解析并格式化 |
| 裸 `host:port` | 加尾部斜杠：`https://example.com/:80` |

### 设置项

```jsonc
{
  "providers.fetch": "auto"  // 优先级顺序：auto | native | trafilatura | lynx | parallel | jina
}
```

---

## 3. `browser` — 完整浏览器自动化

### 使用场景

`browser` 打开一个**headless（或真实）Chromium 标签页**，暴露完整的 puppeteer API。Agent 的 prompt 明确指示：

> 优先用 `read` 获取网页内容；只在 `read` 无法处理时才用 browser。

适用场景：
- 需要 JavaScript 执行的页面（SPA、动态内容）
- 认证流程（登录）
- 交互操作（点击、输入、提交）
- 页面截图
- Canvas/WebGL 内容

### 标签页生命周期

- `open` — 获取/复用命名标签页；可选 `url`、`viewport`、自动处理弹窗
- `run` — 执行 JS，可访问 `page` + `tab` 助手
- `close` — 释放标签页，可选 kill 进程树

标签页在多次 `run` 调用和整个 session 期间保持活跃。

### 核心能力

- 导航：`tab.goto(url)`、`tab.waitForUrl(pattern)`
- 交互：`tab.click(selector)`、`tab.type(selector, text)`、`tab.fill(selector, value)`
- 检查：`tab.observe()`（无障碍树）、`tab.ariaSnapshot()`（ARIA YAML）、`tab.screenshot()`
- 提取：`tab.extract("markdown" | "text")`
- HTTP 拦截：`tab.waitForResponse(pattern)`

---

## 4. 程序化访问

### `omp q` CLI 快速搜索

```bash
omp q "bun vs node benchmarks 2025"
```

单次搜索，绕过 TUI。接受所有 `web_search` 参数外加 `--provider`。

### Gallery 渲染预览

```bash
omp gallery --tool web_search  # 渲染所有状态下的工具输出
```

---

## 5. Provider 发现与懒加载

每个 provider 位于 `src/web/search/providers/<name>.ts`，实现 `SearchProvider` 接口：

```typescript
interface SearchProvider {
  id: SearchProviderId;
  label: string;
  isAvailable(auth: AuthStorage): Promise<boolean>;       // 是否可用？
  isExplicitlyAvailable(auth: AuthStorage): Promise<boolean>; // 显式（非回退）场景可用？
  search(params: SearchParams): Promise<SearchResponse>;  // 执行搜索
}
```

Provider 是**懒加载**的——只有 `isAvailable()` 为 true 的模块才会被 import。在一个典型 session 中，20 个 provider 有 18 个仅仅躺在磁盘上不动。

被排除的 provider（`providers.webSearchExclude`）在解析阶段就被过滤掉，其模块永远不会被加载。

---

## 6. 错误处理

- **所有 provider 都失败** → "All web search providers failed: …" 附带每个 provider 的错误详情
- **AbortError** → 以取消姿态立刻抛出，不会伪装成 provider 失败
- **空结果** → `SearchProviderError`("no renderable search content")，继续下一个 provider
- **HTTP 错误** → `WebSearchProviderError` 带状态码，继续回退链
- **Bot 限流** (DDG、Startpage) → 错误传递给调用方，下一个 provider 被尝试

---

## 源码布局

```
src/web/search/
├── index.ts              # WebSearchTool, executeSearch
├── provider.ts           # resolveProviderChain, provider 注册表
├── types.ts              # SearchProviderId, SearchParams, SEARCH_PROVIDER_OPTIONS
├── render.ts             # LLM 侧结果格式化
├── utils.ts              # formatSearchProviderFailure 等工具函数
└── providers/            # ~20 个 SearchProvider 实现

src/tools/fetch.ts        # URL 读取管道 (native → trafilatura → lynx → parallel → jina)
src/tools/read.ts         # Read 工具 — 将 URL 分发到 fetch.ts
src/web/scrapers/         # 50+ 领域特定内容抓取器 (npm, pypi, github 等)

src/prompts/tools/
├── web-search.md         # web_search 工具描述，注入 agent 上下文
└── read.md               # read 工具描述（在 # URLs 章节覆盖 URL 模式）
```
