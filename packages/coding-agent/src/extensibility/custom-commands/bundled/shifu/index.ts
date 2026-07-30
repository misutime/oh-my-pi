import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomCommand, CustomCommandAPI } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import shifuRequestTemplate from "../../../../prompts/shifu-request.md" with { type: "text" };
import * as git from "../../../../utils/git";

async function getCurrentBranch(api: CustomCommandAPI): Promise<string | undefined> {
	try {
		return (await git.branch.current(api.cwd)) ?? undefined;
	} catch {
		return undefined;
	}
}

async function getRecentChanges(api: CustomCommandAPI): Promise<string | undefined> {
	try {
		const result = await api.exec("git", ["diff", "--stat", "HEAD~5..HEAD"], { cwd: api.cwd });
		if (result.code === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	} catch {
		// Not a git repo or no history
	}
	return undefined;
}

export class ShifuCommand implements CustomCommand {
	name = "shifu";
	description = "Escalate to the shifu expert agent when stuck on a problem";

	constructor(private api: CustomCommandAPI) {}

	async execute(args: string[], _ctx: HookCommandContext): Promise<string> {
		const problem = args.length > 0 ? args.join(" ") : undefined;
		const [branch, recentChanges] = await Promise.all([getCurrentBranch(this.api), getRecentChanges(this.api)]);

		return prompt.render(shifuRequestTemplate, {
			problem,
			cwd: this.api.cwd,
			branch,
			recentChanges,
		});
	}
}
