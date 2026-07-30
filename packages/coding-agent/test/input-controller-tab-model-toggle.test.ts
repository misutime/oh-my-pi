import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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
		setText(t: string) {
			text = t;
		},
		getText() {
			return text;
		},
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft() {
			text = "";
		},
	};
}

// ── fixture ───────────────────────────────────────────────────

let dfModel: ReturnType<typeof getBundledModel>;
let extModel1: ReturnType<typeof getBundledModel>;
let extModel2: ReturnType<typeof getBundledModel>;

beforeEach(async () => {
	await Settings.init({ inMemory: true });
	initTheme();
	dfModel = getBundledModel("openai", "gpt-4o");
	extModel1 = getBundledModel("anthropic", "claude-sonnet-4-6");
	extModel2 = getBundledModel("google", "gemini-2.5-flash");
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
	session: Record<string, unknown>;
}

function makeHarness(tabCycleModels: string[]): Harness {
	const editor = makeEditor();
	const addInputListener = vi.fn();
	const setModelTemporary = vi.fn(async () => {});
	const setAdvisorEnabled = vi.fn();

	const session = {
		model: dfModel,
		modelRegistry: { getAvailable: () => [dfModel, extModel1, extModel2] },
		setModelTemporary,
		isAdvisorEnabled: vi.fn(() => false),
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
		showModelCycleTrack: vi.fn(),
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

	// Set the default model role + tab cycle models in settings
	Settings.instance.override("modelRoles", { default: "openai/gpt-4o" });
	Settings.instance.override("tabCycleModels", tabCycleModels);

	const controller = new InputController(base);
	controller.setupKeyHandlers();

	// setupKeyHandlers registers listeners in order. Grab the tab one (index 4).
	const calls = addInputListener.mock.calls.map((c: unknown[]) => c[0]) as Array<(data: string) => object | undefined>;
	const tab = calls[4]!;
	return {
		ctx: base,
		tab,
		flush: async () => {
			for (let i = 0; i < 4; i++) await Promise.resolve();
		},
		setModelTemporary,
		session: session as unknown as Record<string, unknown>,
	};
}

// ── tests ─────────────────────────────────────────────────────

describe("InputController Tab model cycle", () => {
	it("does nothing when tabCycleModels is empty", async () => {
		const h = makeHarness([]);

		const result = h.tab("\t");
		await h.flush();

		// Tab is consumed (listener returns { consume: true }) but no model switch happens
		expect(result).toEqual({ consume: true });
		expect(h.setModelTemporary).not.toHaveBeenCalled();
	});

	it("cycles default → extra on each Tab with one extra model", async () => {
		const h = makeHarness(["anthropic/claude-sonnet-4-6"]);

		// Tab 1: default → extra
		h.tab("\t");
		await h.flush();
		expect(h.setModelTemporary.mock.calls.length).toBe(1);
		expect(h.setModelTemporary.mock.calls[0][0]).toMatchObject({
			provider: extModel1.provider,
			id: extModel1.id,
		});

		// Tab 2: extra → default
		h.session.model = extModel1;
		h.tab("\t");
		await h.flush();
		expect(h.setModelTemporary.mock.calls.length).toBe(2);
		expect(h.setModelTemporary.mock.calls[1][0]).toMatchObject({
			provider: dfModel.provider,
			id: dfModel.id,
		});

		// Tab 3: default → extra again
		h.session.model = dfModel;
		h.tab("\t");
		await h.flush();
		expect(h.setModelTemporary.mock.calls.length).toBe(3);
		expect(h.setModelTemporary.mock.calls[2][0]).toMatchObject({
			provider: extModel1.provider,
			id: extModel1.id,
		});
	});

	it("cycles through three models with two extras", async () => {
		const h = makeHarness(["anthropic/claude-sonnet-4-6", "google/gemini-2.5-flash"]);

		// Tab 1: default → extra1
		h.tab("\t");
		await h.flush();
		expect(h.setModelTemporary.mock.calls[0][0]).toMatchObject({
			provider: extModel1.provider,
			id: extModel1.id,
		});

		// Tab 2: extra1 → extra2
		h.session.model = extModel1;
		h.tab("\t");
		await h.flush();
		expect(h.setModelTemporary.mock.calls[1][0]).toMatchObject({
			provider: extModel2.provider,
			id: extModel2.id,
		});

		// Tab 3: extra2 → default
		h.session.model = extModel2;
		h.tab("\t");
		await h.flush();
		expect(h.setModelTemporary.mock.calls[2][0]).toMatchObject({
			provider: dfModel.provider,
			id: dfModel.id,
		});
	});

	it("shows cycle track after each advance", async () => {
		const h = makeHarness(["anthropic/claude-sonnet-4-6"]);

		h.tab("\t");
		await h.flush();
		expect(h.ctx.showModelCycleTrack).toHaveBeenCalled();

		const track = (h.ctx.showModelCycleTrack as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(typeof track).toBe("string");
		expect(track.length).toBeGreaterThan(0);
	});

	it("starts from default when current model is not in cycle", async () => {
		const h = makeHarness(["anthropic/claude-sonnet-4-6"]);

		// Set session to a model not in the cycle (use a real bundled model)
		const unknownModel = getBundledModel("openai", "gpt-4o-mini");
		h.session.model = unknownModel;

		h.tab("\t");
		await h.flush();

		// Should advance to extra (position 1 in [default, extra])
		expect(h.setModelTemporary.mock.calls[0][0]).toMatchObject({
			provider: extModel1.provider,
			id: extModel1.id,
		});
	});

	it("shows status when tabCycleModels empty and only default exists in cycle", async () => {
		const h = makeHarness([]);

		h.tab("\t");
		await h.flush();

		expect(h.setModelTemporary).not.toHaveBeenCalled();
	});

	it("shows status when extra models duplicate the default", async () => {
		// Extra model string matches default — cycle has length 1 after dedup
		const h = makeHarness(["openai/gpt-4o"]);

		h.tab("\t");
		await h.flush();

		expect(h.setModelTemporary).not.toHaveBeenCalled();
		expect(h.ctx.showStatus).toHaveBeenCalledWith("No resolvable extra models for Tab cycle");
	});

	it("falls back to current model when default role is unset", async () => {
		// Create harness, then clear the default role
		const h = makeHarness(["anthropic/claude-sonnet-4-6"]);
		Settings.instance.setModelRole("default", undefined);

		h.tab("\t");
		await h.flush();

		// Cycle should fall back to currentModel (dfModel) as position 0,
		// then advance to extModel1 at position 1.
		expect(h.setModelTemporary.mock.calls.length).toBe(1);
		expect(h.setModelTemporary.mock.calls[0][0]).toMatchObject({
			provider: extModel1.provider,
			id: extModel1.id,
		});
	});

	it("shows status when all extra models are unresolvable", async () => {
		const h = makeHarness(["nonexistent/provider/model"]);

		h.tab("\t");
		await h.flush();

		expect(h.setModelTemporary).not.toHaveBeenCalled();
		expect(h.ctx.showStatus).toHaveBeenCalledWith("No resolvable extra models for Tab cycle");
	});

	it("passes through to autocomplete when editor has text", async () => {
		const h = makeHarness(["anthropic/claude-sonnet-4-6"]);
		const editor = h.ctx.editor as unknown as FakeEditor;
		editor.setText("hello");

		const result = h.tab("\t");
		await h.flush();

		// Tab returns undefined = not consumed when editor has text
		expect(result).toBeUndefined();
		expect(h.setModelTemporary).not.toHaveBeenCalled();
	});

	it("shows error when setModelTemporary throws", async () => {
		const h = makeHarness(["anthropic/claude-sonnet-4-6"]);

		// Replace setModelTemporary with a failing one
		const failFn = vi.fn(async () => {
			throw new Error("auth required");
		});
		(h.ctx.session as unknown as { setModelTemporary: unknown }).setModelTemporary = failFn;

		h.tab("\t");
		await h.flush();

		expect(failFn).toHaveBeenCalled();
		expect(h.ctx.showError).toHaveBeenCalledWith("auth required");
	});

	it("respects ephemeral flag on setModelTemporary", async () => {
		const h = makeHarness(["anthropic/claude-sonnet-4-6"]);

		h.tab("\t");
		await h.flush();

		expect(h.setModelTemporary.mock.calls[0][2]).toEqual({ ephemeral: true });
	});
});
