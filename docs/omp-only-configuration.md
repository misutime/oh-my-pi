# OMP-only configuration

This fork deliberately isolates automatic coding-tool configuration discovery to OMP-owned paths:

- User scope: `~/.omp/agent/`, or `~/.omp/profiles/<name>/agent/` for an active profile.
- Project scope: `.omp/`, including the nearest ancestor `.omp/` directories where that feature supports inheritance.

OMP does not automatically import settings, MCP servers, skills, rules, commands, hooks, tools, plugins, or instruction files from Claude Code, Codex, Gemini, Cursor, VS Code, GitHub Copilot, OpenCode, Cline, Windsurf, or the Agents standard. It also ignores standalone project-root `mcp.json`, `.mcp.json`, `ssh.json`, and `.ssh.json` files.

Use `.omp/mcp.json` for project MCP servers and `~/.omp/agent/mcp.json` for user MCP servers. Move any configuration from another tool into the equivalent OMP-owned location before relying on it.

OMP plugin packages and explicitly supplied CLI extension paths remain supported. Their configuration is explicit OMP input; they are not automatic discovery of another tool's config directory.

## Maintenance policy

The upstream discovery modules for other tools remain in the source tree so this fork can merge upstream fixes without recurring modify/delete conflicts. The normal OMP entry point does not register them, so they cannot load configuration during a standard CLI or SDK session. This is a product boundary, not a user setting.
