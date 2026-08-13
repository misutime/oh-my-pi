import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { usesCodexTaskPrompt } from "@oh-my-pi/pi-coding-agent/task/prompt-policy";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import eagerTaskPrompt from "../src/prompts/system/eager-task.md" with { type: "text" };
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

async function renderSystemPromptWithDelegation(
	cwd: string,
	options: { model?: string; eagerTasks?: boolean; eagerTasksAlways?: boolean },
): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd,
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["task"],
		workspaceTree: { ...EMPTY_TREE, rootPath: cwd },
		...options,
	});
	return systemPrompt.join("\n\n");
}

async function expectPromptDateFromStartupTimezone(options: {
	tempDir: string;
	tempHomeDir: string;
	timeZone: string;
	now: string;
	expectedDate: string;
	rejectedDate: string;
}): Promise<void> {
	const scenarioPath = path.join(options.tempDir, "prompt-date-timezone.test.ts");
	await Bun.write(
		scenarioPath,
		`import { expect, it, setSystemTime } from "bun:test";
import { buildSystemPrompt } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/system-prompt.ts"))};

it("renders the prompt date in the startup timezone", async () => {
	setSystemTime(new Date(process.env.OMP_TEST_NOW!));
	try {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: process.cwd(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: {
				rootPath: process.cwd(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			activeRepoContext: null,
		});
		const rendered = systemPrompt.join("\\n\\n");
		expect(rendered).toContain(\`Today: \${process.env.OMP_EXPECTED_DATE}\`);
		expect(rendered).not.toContain(\`Today: \${process.env.OMP_REJECTED_DATE}\`);
	} finally {
		setSystemTime();
	}
});
`,
	);
	const child = Bun.spawn([process.execPath, "test", scenarioPath], {
		cwd: options.tempDir,
		env: {
			...process.env,
			HOME: options.tempHomeDir,
			TZ: options.timeZone,
			OMP_TEST_NOW: options.now,
			OMP_EXPECTED_DATE: options.expectedDate,
			OMP_REJECTED_DATE: options.rejectedDate,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(`${stdout}\n${stderr}`).toContain("1 pass");
	expect(exitCode).toBe(0);
}

describe("system prompt model identifier", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("renders the model identifier into the workstation block when provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			model: "anthropic/claude-opus-4",
		});

		expect(systemPrompt.join("\n\n")).toContain("Model: anthropic/claude-opus-4");
	});

	it("renders the prompt date from the startup local timezone rather than UTC", async () => {
		await expectPromptDateFromStartupTimezone({
			tempDir,
			tempHomeDir,
			timeZone: "America/Los_Angeles",
			now: "2026-07-01T03:15:00Z",
			expectedDate: "2026-06-30",
			rejectedDate: "2026-07-01",
		});
	});

	it("omits the model line when no model is provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		expect(systemPrompt.join("\n\n")).not.toContain("Model:");
	});
});

describe("AgentSession model-change prompt refresh", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function pickTwoModels(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(m => m.provider !== first.provider || m.id !== first.id);
		if (!first || !second) throw new Error("Expected at least two distinct models in the registry");
		return [first, second];
	}

	function pickTwoModelsWithSameTaskPolicy(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(
			model =>
				(model.provider !== first.provider || model.id !== first.id) &&
				usesCodexTaskPrompt(model.id) === usesCodexTaskPrompt(first.id),
		);
		if (!first || !second) throw new Error("Expected two distinct models with the same task prompt policy");
		return [first, second];
	}

	function pickModelsAcrossTaskPolicies(): [Model, Model] {
		const all = modelRegistry.getAll();
		const defaultPolicy = all.find(model => !usesCodexTaskPrompt(model.id));
		const codexPolicy = all.find(model => usesCodexTaskPrompt(model.id));
		if (!defaultPolicy || !codexPolicy) throw new Error("Expected default-policy and GPT-5.6 models");
		return [defaultPolicy, codexPolicy];
	}

	function newSession(
		model: Model,
		settings: Settings,
		rebuild: () => Promise<{ systemPrompt: string[] }>,
	): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => rebuild(),
		});
		return created;
	}

	it("rebuilds the prompt with the new model when includeModelInPrompt is enabled", async () => {
		const [modelA, modelB] = pickTwoModels();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(modelA, Settings.isolated({ "compaction.enabled": false }), async () => {
			rebuildCount++;
			const active = session?.model;
			return { systemPrompt: [`model:${active ? `${active.provider}/${active.id}` : ""}`] };
		});

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual([`model:${modelB.provider}/${modelB.id}`]);

		// Re-selecting the same model leaves the rendered model unchanged → no rebuild.
		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
	});

	it("does not rebuild a hidden-model prompt when the task policy stays the same", async () => {
		const [modelA, modelB] = pickTwoModelsWithSameTaskPolicy();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false, "tools.format": "native" }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["unchanged"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});

	it("rebuilds a hidden-model prompt when the task policy changes", async () => {
		const [modelA, modelB] = pickModelsAcrossTaskPolicies();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["policy changed"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["policy changed"]);
	});

	it("does not rebuild a hidden-model prompt across policies when task.eager=always unifies them", async () => {
		const [modelA, modelB] = pickModelsAcrossTaskPolicies();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({
				"compaction.enabled": false,
				includeModelInPrompt: false,
				"task.eager": "always",
				"tools.format": "native",
			}),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["unchanged"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});

	function pickModelsAcrossPromptShapes(): [Model, Model] {
		const all = modelRegistry.getAll();
		const native = all.find(model => model.supportsTools !== false);
		const owned = all.find(model => model.supportsTools === false);
		if (!native || !owned) throw new Error("Expected models with and without native tool support");
		return [native, owned];
	}

	it("rebuilds a hidden-model prompt under task.eager=always when the tool shape flips native to auto fallback", async () => {
		const [modelA, modelB] = pickModelsAcrossPromptShapes();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false, "task.eager": "always" }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["tool shape changed"] };
			},
		);

		// Delegation policy is unified under task.eager=always, but the native →
		// owned tool inventory flip is a real prompt-shaping difference and must
		// still refresh the hidden-model prompt.
		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["tool shape changed"]);
	});

	it("does not rebuild a hidden-model prompt under task.eager=always when an explicit owned dialect keeps the shape constant", async () => {
		const [modelA, modelB] = pickModelsAcrossPromptShapes();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({
				"compaction.enabled": false,
				includeModelInPrompt: false,
				"task.eager": "always",
				"tools.format": "glm",
			}),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["unchanged"] };
			},
		);

		// The explicit owned dialect resolves identically for every model, so the
		// unified delegation policy plus constant shape mean no prompt refresh.
		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});
});

describe("delegation policy routing (GPT-5.6 vs unified)", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-policy-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-policy-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("bypasses the Codex branch only when task.eager=always", () => {
		expect(usesCodexTaskPrompt("openai-codex/gpt-5.6-sol")).toBe(true);
		expect(usesCodexTaskPrompt("openai-codex/gpt-5.6-sol", false)).toBe(true);
		expect(usesCodexTaskPrompt("openai-codex/gpt-5.6-sol", true)).toBe(false);
		expect(usesCodexTaskPrompt("anthropic/claude-opus-4", true)).toBe(false);
		expect(usesCodexTaskPrompt("anthropic/claude-opus-4")).toBe(false);
		expect(usesCodexTaskPrompt(undefined, true)).toBe(false);
	});

	it("routes GPT-5.6 with task.eager=always into the unified hard branch", async () => {
		const rendered = await renderSystemPromptWithDelegation(tempDir, {
			model: "openai-codex/gpt-5.6-sol",
			eagerTasks: true,
			eagerTasksAlways: true,
		});
		expect(rendered).toContain("Delegation is the default here, not the exception");
		expect(rendered).not.toContain("Proactive multi-agent delegation is active");
		expect(rendered).not.toContain("Do not spawn sub-agents unless");
	});

	it("keeps the Codex proactive branch for GPT-5.6 with task.eager=preferred", async () => {
		const rendered = await renderSystemPromptWithDelegation(tempDir, {
			model: "openai-codex/gpt-5.6-sol",
			eagerTasks: true,
			eagerTasksAlways: false,
		});
		expect(rendered).toContain("Proactive multi-agent delegation is active");
		expect(rendered).not.toContain("Delegation is the default here, not the exception");
	});

	it("keeps the Codex gated branch for GPT-5.6 with task.eager=default", async () => {
		const rendered = await renderSystemPromptWithDelegation(tempDir, {
			model: "openai-codex/gpt-5.6-sol",
			eagerTasks: false,
			eagerTasksAlways: false,
		});
		expect(rendered).toContain("Do not spawn sub-agents unless");
		expect(rendered).not.toContain("Delegation is the default here, not the exception");
		expect(rendered).not.toContain("Proactive multi-agent delegation is active");
	});

	it("keeps the unified hard branch for non-5.6 models with task.eager=always", async () => {
		const rendered = await renderSystemPromptWithDelegation(tempDir, {
			model: "anthropic/claude-opus-4",
			eagerTasks: true,
			eagerTasksAlways: true,
		});
		expect(rendered).toContain("Delegation is the default here, not the exception");
		expect(rendered).not.toContain("Proactive multi-agent delegation is active");
	});
});

describe("delegation copy locks", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-copy-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-copy-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("keeps the unified work-alone and trigger wording in the hard branch", async () => {
		const rendered = await renderSystemPromptWithDelegation(tempDir, {
			model: "anthropic/claude-opus-4",
			eagerTasks: true,
			eagerTasksAlways: true,
		});
		expect(rendered).toContain("single-file mechanical edit with no semantic judgment");
		expect(rendered).not.toContain("under approximately 30 lines");
		expect(rendered).toContain(
			"investigations, reproductions, bug fixes, features, refactors, tests, unknown code scope, and any semantic code change",
		);
		expect(rendered).toContain("even a single slice");
		expect(rendered).toContain("Never re-implement a delegated slice");
		expect(rendered).toContain("MUST NOT implement it yourself");
	});

	it("gives the only non-mechanical slice a legal lone-spawn path in the hard branch", async () => {
		const rendered = await renderSystemPromptWithDelegation(tempDir, {
			model: "anthropic/claude-opus-4",
			eagerTasks: true,
			eagerTasksAlways: true,
		});
		expect(rendered).toContain(
			"the active delegation policy requires or directs delegating the only non-mechanical slice",
		);
		expect(rendered).toContain("the handoff cost is justified");
		expect(rendered).toContain("MUST NOT wait idle");
		expect(rendered).toContain("continue with independent verification preparation");
		expect(rendered).toContain("MUST NOT implement it yourself");
	});

	it("gives the only non-mechanical slice a legal lone-spawn path in the unified preferred branch", async () => {
		const rendered = await renderSystemPromptWithDelegation(tempDir, {
			model: "anthropic/claude-opus-4",
			eagerTasks: true,
			eagerTasksAlways: false,
		});
		expect(rendered).toContain("Delegation is preferred here");
		expect(rendered).toContain("delegation triggers, even a single slice");
		expect(rendered).toContain(
			"the active delegation policy requires or directs delegating the only non-mechanical slice",
		);
		expect(rendered).toContain("MUST NOT wait idle");
		expect(rendered).toContain("Never re-implement a delegated slice");
	});

	it("keeps the eager-task reminder copy aligned with the hard branch", () => {
		expect(eagerTaskPrompt).toContain("single-file mechanical edit with no semantic judgment");
		expect(eagerTaskPrompt).not.toContain("substantial slice");
		expect(eagerTaskPrompt).toContain("NEVER implement its slice yourself");
		expect(eagerTaskPrompt).toContain("only ONE non-mechanical slice exists");
		expect(eagerTaskPrompt).toContain("the handoff cost is justified");
		expect(eagerTaskPrompt).toContain("continue with verification while it runs");
	});
});
