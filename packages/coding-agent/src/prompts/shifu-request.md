## Shifu Escalation Request

The user is stuck and needs expert help.

{{#if problem}}
### Problem Description

{{problem}}
{{/if}}

### Context

- **Working directory**: `{{cwd}}`
{{#if branch}}- **Branch**: `{{branch}}`{{/if}}
{{#if recentChanges}}
### Recent Changes

{{recentChanges}}
{{/if}}

### Instructions

1. Collect additional context as needed: recent errors, what was attempted, relevant code.
2. Use the `task` tool with `agent: "shifu"` to spawn exactly **1 shifu agent**.
3. The shifu assignment MUST include:
   - The problem as stated{{#if problem}} above{{/if}}
   - What you know has been tried so far
   - Any error messages or unexpected behavior observed
   - Relevant file paths and code sections
4. Wait for shifu's result, then present the diagnosis and fix to the user.
