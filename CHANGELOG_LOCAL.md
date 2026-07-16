# Local Changelog

本文件记录 `misutime/oh-my-pi` 相对上游 `can1357/oh-my-pi` 的本地独有改动。
上游 CHANGELOG 见 `packages/coding-agent/CHANGELOG.md`。
复查时从最后记录的 commit 开始：`git log <hash>..HEAD --oneline --no-merges`。

## [Unreleased] — 基于 v17.0.0

### Breaking Changes

- 限制自动配置发现为 OMP 专属路径（`~/.omp/` 和 `.omp/`），移除所有非 OMP 外部工具配置发现（13 个 provider 文件）(`6c17e1f7`)

### Added

- Codex MCP 配置提取支持 `enabled` 和 `cwd` 字段 (`cbc75df6`)
- 源码运行时（非编译版本）自动标记为开发版本 (`a888996f`)

### Changed

- `.gitignore` 添加 `.codegraph/` 和 `nul` (`eafc4cc1`)

### Fixed

- MCP 连接状态消息不再使用 dim 淡色显示，确保可读性 (`6b2b76d0`)

<!-- 最后记录的 commit: 2727d7fb -->
