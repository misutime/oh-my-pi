import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

// ── editor stub ───────────────────────────────────────────────

type FakeEditor = {
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	clearDraft(historyText?: string): void;
	imageLinks?: (string | undefined)[];
};

function makeEditor(): FakeEditor {
	let text = "";
	return {
		setText(t: string) { text = t; },
		getText() { return text; },
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft() { text = ""; },
	};
}

// ── fixture ───────────────────────────────────────────────────

let dfModel: ReturnType<typeof getBundledModel>;
let adModel: ReturnType<typeof getBundledModel>;

beforeEach(async () => {
	await Settings.init({ inMemory: true });
	dfModel = getBundledModel("openai", "gpt-5.2");
	adModel = getBundledModel("anthropic", "claude-sonnet-4-6");
});

afterEach(() => {
	resetSettingsForTest();
});

interface Harness {
	ctx: InteractiveModeContext;
	tab: (data: string) => object | undefined;
	/** Drain the microtask queue so `void asyncMethod()` work settles. */
	flush(): Promise<void>;
	setModelTemporary: ReturnType<typeof vi.fn>;
	setAdvisorEnabled: ReturnType<typeof vi.fn>;
	session: Record<string, unknown>;
}

function makeHarness(advisorEnabled: boolean): Harness {
	const editor = makeEditor();
	const addInputListener = vi.fn();
	const setModelTemporary = vi.fn(async () => {});
	const setAdvisorEnabled = vi.fn();
	const isAdvisorEnabled = vi.fn(() => advisorEnabled);

	const session = {
		model: dfModel,
		modelRegistry: { getAvailable: () => [dfModel, adModel] },
		setModelTemporary,
		isAdvisorEnabled,
		setAdvisorEnabled,
	} as unknown as InteractiveModeContext["session"];

	const base = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: {
			addInputListener,
			addStartListener: vi.fn(),
			getFocused: vi.fn(() => editor),
		} as unknown as InteractiveModeContext["ui"],
		session,
		viewSession: session as unknown as InteractiveModeContext["viewSession"],
		sessionManager: { getSessionId: () => "s1" } as unknown as InteractiveModeContext["sessionManager"],
		settings: Settings.instance,
		keybindings: { getKeys: () => [] } as unknown as InteractiveModeContext["keybindings"],
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		focusedAgentId: null,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		handleClearCommand: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleSTTToggle: vi.fn(),
		showDebugSelector: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(),
		showHistorySearch: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
	} as unknown as InteractiveModeContext;

	const controller = new InputController(base);
	controller.setupKeyHandlers();

	// setupKeyHandlers registers: [0] left-tap, [1] focused-paste, [2] btw-branch,
	// [3] btw-copy, [4] tab-model-toggle, [5] enhanced-paste. Grab index 4 explicitly.
	const calls = addInputListener.mock.calls.map((c: unknown[]) => c[0]) as Array<
		(data: string) => object | undefined
	>;
	const tab = calls[4]!;
	return {
		ctx: base,
		tab,
		flush: async () => {
			for (let i = 0; i < 4; i++) await Promise.resolve();
		},
		setModelTemporary,
		setAdvisorEnabled,
		session: session as unknown as Record<string, unknown>,
	};
}

const ROLES = { default: "openai/gpt-5.2", advisor: "anthropic/claude-sonnet-4-6" };

// ── tests ─────────────────────────────────────────────────────

describe("InputController Tab model toggle with advisor", () => {
	it("switches to advisor model and disables advisor", async () => {
		Settings.instance.override("modelRoles", ROLES);
		const h = makeHarness(true);

		h.tab("\t");
		await h.flush();

		expect(h.setModelTemporary.mock.calls[0][0]).toMatchObject({ provider: adModel.provider, id: adModel.id });
		expect(h.setAdvisorEnabled).toHaveBeenCalledWith(false);
	});

	it("returns to default model and restores advisor", async () => {
		Settings.instance.override("modelRoles", ROLES);
		const h = makeHarness(true);

		h.tab("\t"); await h.flush();
		h.session.model = adModel;

		h.tab("\t"); await h.flush();

		expect(h.setModelTemporary.mock.calls.length).toBe(2);
		expect(h.setModelTemporary.mock.calls[1][0]).toMatchObject({
			provider: dfModel.provider,
			id: dfModel.id,
		});
		expect(h.setAdvisorEnabled).toHaveBeenCalledWith(true);
	});

	it("does not restore advisor when it was already off", async () => {
		Settings.instance.override("modelRoles", ROLES);
		const h = makeHarness(false);

		h.tab("\t"); await h.flush();
		h.session.model = adModel;

		h.tab("\t"); await h.flush();

		expect(h.setModelTemporary.mock.calls.length).toBe(2);
		expect(h.setAdvisorEnabled).toHaveBeenCalledWith(false);
		expect(h.setAdvisorEnabled).not.toHaveBeenCalledWith(true);
	});

	it("cycles advisor on/off in same session (regression: third entry snapshot)", async () => {
		Settings.instance.override("modelRoles", ROLES);
		const h = makeHarness(true);

		// Cycle 1
		h.tab("\t"); await h.flush();
		expect(h.setAdvisorEnabled).toHaveBeenCalledWith(false);
		h.session.model = adModel;

		h.tab("\t"); await h.flush();
		expect(h.setAdvisorEnabled).toHaveBeenCalledWith(true);
		h.session.model = dfModel;

		// Cycle 2 — regression: must capture snapshot on re-entry
		h.tab("\t"); await h.flush();
		const advisorCalls = (h.setAdvisorEnabled as unknown as { mock: { calls: Array<[boolean]> } }).mock.calls;
		expect(advisorCalls.filter(([v]) => v === false).length).toBe(2);
		h.session.model = adModel;

		h.tab("\t"); await h.flush();
		expect(advisorCalls.filter(([v]) => v === true).length).toBe(2);
	});

	it("no-op when no advisor model is configured", async () => {
		const h = makeHarness(true);

		h.tab("\t");
		await h.flush();

		expect(h.ctx.showStatus as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("No advisor model configured");
		expect(h.setModelTemporary).not.toHaveBeenCalled();
	});
	it("does not corrupt snapshot when model switch fails", async () => {
		Settings.instance.override("modelRoles", ROLES);
		const editor = makeEditor();
		const addInputListener = vi.fn();
		let advisorEnabled = true;
		let failSwitch = true;
		const setModelTemporary = vi.fn<() => Promise<void>>(async () => {
			if (failSwitch) throw new Error("model unavailable");
		});
		const setAdvisorEnabled = vi.fn();
		const isAdvisorEnabled = vi.fn(() => advisorEnabled);

		const session = {
			model: dfModel,
			modelRegistry: { getAvailable: () => [dfModel, adModel] },
			setModelTemporary,
			isAdvisorEnabled,
			setAdvisorEnabled,
		} as unknown as InteractiveModeContext["session"];

		const base = {
			editor: editor as unknown as InteractiveModeContext["editor"],
			ui: {
				addInputListener,
				addStartListener: vi.fn(),
				getFocused: vi.fn(() => editor),
			} as unknown as InteractiveModeContext["ui"],
			session,
			viewSession: session as unknown as InteractiveModeContext["viewSession"],
			sessionManager: { getSessionId: () => "s1" } as unknown as InteractiveModeContext["sessionManager"],
			settings: Settings.instance,
			keybindings: { getKeys: () => [] } as unknown as InteractiveModeContext["keybindings"],
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			focusedAgentId: null,
			loadingAnimation: undefined,
			autoCompactionLoader: undefined,
			retryLoader: undefined,
			autoCompactionEscapeHandler: undefined,
			retryEscapeHandler: undefined,
			handleClearCommand: vi.fn(),
			handleHotkeysCommand: vi.fn(),
			handlePlanModeCommand: vi.fn(),
			showTreeSelector: vi.fn(),
			showUserMessageSelector: vi.fn(),
			showSessionSelector: vi.fn(),
			handleSTTToggle: vi.fn(),
			showDebugSelector: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
			showHistorySearch: vi.fn(),
			isBashMode: false,
			isPythonMode: false,
		} as unknown as InteractiveModeContext;

		const controller = new InputController(base);
		controller.setupKeyHandlers();
		const calls = addInputListener.mock.calls.map((c: unknown[]) => c[0]) as Array<
			(data: string) => object | undefined
		>;
		const tab = calls[4]!;

		// First attempt: model switch fails
		tab("\t");
		for (let i = 0; i < 4; i++) await Promise.resolve();

		expect(setAdvisorEnabled).not.toHaveBeenCalled();

		// Change advisor state before retry — if snapshot leaked, restore would use stale value
		advisorEnabled = false;
		failSwitch = false;

		// Retry: model switch succeeds
		tab("\t");
		for (let i = 0; i < 4; i++) await Promise.resolve();

		expect(setAdvisorEnabled).toHaveBeenCalledWith(false);
		expect(setAdvisorEnabled.mock.calls.length).toBe(1);

		// Now simulate that we're on advisor model and toggle back
		(session as unknown as Record<string, unknown>).model = adModel;
		tab("\t");
		for (let i = 0; i < 4; i++) await Promise.resolve();

		// The snapshot was captured fresh (advisorEnabled=false), so return should NOT restore
		expect(setAdvisorEnabled.mock.calls.length).toBe(1);
		expect(setAdvisorEnabled).not.toHaveBeenCalledWith(true);
	});
});
