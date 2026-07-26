<system-reminder>
Task delegation is enabled — subagents are the default for this request.

When the request's affected files and scope boundaries are unclear, spawn a read-only scout FIRST to map the code surface. Once you have the map, settle the decomposition and cross-slice contracts — scoping and top-level design are YOUR job; NEVER outsource the overall plan. Then you MUST fan the work out to `{{toolRefs.task}}` subagents instead of implementing it yourself.{{#if taskBatch}} Batch independent slices into ONE parallel `{{toolRefs.task}}` call; never serialize work that can run concurrently.{{/if}}

Work alone ONLY for: a single-file mechanical edit, a direct answer using already available context (no further investigation needed), or a command the user explicitly asked you to run yourself. A lone subagent is still valid when you continue another independent slice in parallel.
</system-reminder>
