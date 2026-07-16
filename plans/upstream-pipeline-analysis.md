# 上游 oh-my-pi 开发流水线架构分析

## 概览

上游 `can1357/oh-my-pi` 以 **256 commits/2天（~78 个 farm 分支/天）** 的速度迭代，核心驱动是 `robomp` —— 一个自托管的 GitHub 自动化 bot，覆盖从 issue 分类到写代码、跑 CI、提 PR 的完整流程。

## 整体架构

```
GitHub Webhook (issue opened / PR label)
       │
       ▼
┌──────────────────────────────────────────────┐
│              robomp (Python)                  │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │ server   │  │ queue    │  │ sandbox     │ │
│  │ FastAPI  │──│ SQLite   │──│ git worktree│ │
│  │ webhook  │  │ dispatch │  │ clone pool  │ │
│  └──────────┘  └──────────┘  └────────────┘ │
│       │                            │         │
│       ▼                            ▼         │
│  ┌──────────────────────────────────────┐   │
│  │    omp --mode rpc (子进程)           │   │
│  │    cwd = per-issue worktree          │   │
│  │    host_tools ← Python 暴露给 agent   │   │
│  └──────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
       │
       ▼
   farm/<8hex>/<slug> 分支 → PR → CI → 人工 review → merge
```

## 流水线环节

### 1. Issue 自动化分类（Triage）

```
issue opened
  → robomp 分类 (bug/feature/question/…)
  → 打标签 (triaged, p0~p3, area, provider)
  → 根据类型分流
```

### 2. Bug fix 分流（reproduce → fix → PR）

```
bug + triaged
  → robomp 创建隔离 worktree
  → omp agent checkout 到 farm/<hex>/<slug>
  → reproduce (复现) → fix (修复) → test → commit
  → gh_push_branch + gh_open_pr
  → PR 打上 label，等待 CI
```

### 3. 社区 PR Review 分流（WIP）

```
external PR opened
  → robomp 分类排名 (review:p0~p3)
  → checkout PR head 到隔离 worktree
  → diff review → inline comments → submit_pr_review
  → 只 COMMENT，不 APPROVE/CLOSE
```

### 4. CI 自动门控

**vouch 系统**（贡献者白名单）：
- `.github/VOUCHED.td` 维护可信贡献者列表
- 非白名单 PR 自动关闭（`vouch-pr.yml`）
- 白名单 PR 打 `vouched` 标签

**CI 流水线**（`ci.yml`，850 行）：
- 并发组：`main` 分支互斥、release 分支独占
- native 产物缓存：基于源文件 hash 的跨 run 复用（`sccache` + GitHub Actions artifact cache）
- 跨平台构建矩阵：Linux x64 (baseline+modern)、Linux arm64、macOS x64、macOS arm64、Windows x64
- 测试矩阵：workspace 测试、singleton 测试、UI 测试、runtime 测试、native 测试、heavy 测试

### 5. Release 自动化

```
bun run release
  → 版本号推进 + CHANGELOG 规范化
  → git push --atomic main + vX.Y.Z tag
  → CI 检测到 release tag → 构建全平台 native 产物
  → npm publish + GitHub Release + Homebrew formula 更新
```

## farm 分支体系

### 命名规范

```
farm/<8hex-commit-hash-prefix>/<kebab-case-description>
```

例如：
- `farm/c0c8781d/fix-bench-usage-error-dump`
- `farm/c19ed3e3/text-passed-to-plan-while-in-plan-mode-i`
- `farm/9afedb59/added-opt-in-task-prewalk`

### 生命周期

```
issue → robomp → farm 分支创建 → agent 写代码 → push → PR → CI → merge → 分支删除
```

每个 farm 分支对应一个独立的 git worktree，基于共享的 `--filter=blob:none` clone pool，确保隔离和快速创建。

### 并发控制

- `ROBOMP_MAX_CONCURRENCY`（默认 8）
- `_inflight` 集合按 `(owner, repo, issue_number)` 去重
- SQLite `BEGIN IMMEDIATE` 原子认领

## Commit 规范

所有 commit 遵循 conventional commits 变体：

```
<type>(<scope>): <description>
```

| 类型 | 占比（256 commits 样本） | 说明 |
|---|---|---|
| `fix` | 76% (195) | bug 修复 |
| `test` | 7% (18) | 测试 |
| `chore` | 6% (16) | 杂务/版本号 |
| `feat` | 5% (14) | 新功能 |
| `docs` | 2% (4) | 文档 |
| 其他 | 4% | style, perf, refactor, revert |

## 关键洞察

### 为什么这么快

1. **AI agent 写代码**：`omp --mode rpc` 作为子进程，使用 full toolset（read/edit/write/bash/lsp/grep），在隔离 worktree 中自主完成修复
2. **并行化**：最多 8 个 agent 同时处理不同 issue，每个有自己的 sandbox
3. **自动化门控**：vouch 白名单 + CI 全绿 + 格式检查（biome），减少人工 review 负担
4. **增量修复为主**：76% 的 commit 是 `fix`，每个修复小而独立，不容易冲突
5. **缓存体系**：native 产物缓存（按源文件 hash）、clone pool、sccache，避免重复编译

### 质量保证

- **隔离**：每个任务有独立的 git worktree + 独立 session_dir（可 resume）
- **审计**：robomp 的 `host_tools` 记录所有 GitHub 操作到 SQLite
- **断点续传**：`--continue` 机制在 robomp 重启后恢复同一 session
- **只读 review**：PR review 使用 detached HEAD，无法 push
- **幂等**：webhook 按 `X-GitHub-Delivery` 去重，per-issue inflight 去重

### 人类在环

- robomp **从不 merge/close/approve/push**
- `submit_pr_review` 强制 `event="COMMENT"`，不发 APPROVE/REQUEST_CHANGES
- 所有 PR 需要人工 review 后才 merge
- 人类维护者做架构决策、review 复杂变更

## 数据

| 指标 | 数值 |
|---|---|
| 日均 commits | ~128 |
| 日均 farm 分支合并 | ~78 |
| fix 占比 | 76% |
| 并发 agent 上限 | 8 |
| CI 构建平台 | 5 个平台 × 多架构 |
| robomp 代码量 | ~150KB Python |

## 对我们的启示

1. **考虑引入 robomp**：处理 issue triage 和简单 bug fix，减轻人工负担
2. **farm 分支隔离**：每个修复用独立 worktree，避免状态污染
3. **vouch 白名单**：简化外部贡献者的信任模型
4. **CI 缓存策略**：按源文件 hash 缓存的 native 产物 + sccache 可以显著加速构建
5. **注意冲突出**：高并发 farm 分支意味着频繁的上游变更，合并冲突是常态（我们在 2 小时内就落后了 154 commits）
