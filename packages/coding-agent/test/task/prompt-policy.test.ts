import { describe, expect, it } from "bun:test";
import { promptToolShape } from "@oh-my-pi/pi-coding-agent/task/prompt-policy";

describe("promptToolShape", () => {
	it("labels provider-native tool calling constant across models", () => {
		expect(promptToolShape("native", { id: "claude-x", supportsTools: true })).toBe("native");
		expect(promptToolShape("auto", { id: "claude-x", supportsTools: true })).toBe("native");
		expect(promptToolShape("auto", undefined)).toBe("native");
	});

	it("labels an explicit owned dialect constant across models", () => {
		const nativeModel = promptToolShape("qwen3", { id: "claude-x", supportsTools: true });
		const fallbackModel = promptToolShape("qwen3", { id: "MiniMax-M3", supportsTools: false });
		expect(nativeModel).toBe("owned:qwen3");
		expect(fallbackModel).toBe("owned:qwen3");
	});

	it("refreshes when auto falls back to a model-dependent dialect", () => {
		const native = promptToolShape("auto", { id: "claude-x", supportsTools: true });
		const qwenFallback = promptToolShape("auto", { id: "qwen3-coder-plus", supportsTools: false });
		const minimaxFallback = promptToolShape("auto", { id: "MiniMax-M3", supportsTools: false });
		expect(native).toBe("native");
		expect(qwenFallback).toBe("auto:qwen3");
		expect(minimaxFallback).toBe("auto:minimax");
		// Every resolved shape differs, so a model switch that flips the fallback
		// (or drops into it from native) refreshes the prompt cache key even when
		// `task.eager=always` unifies the delegation policy dimension.
		expect(qwenFallback).not.toBe(native);
		expect(minimaxFallback).not.toBe(qwenFallback);
	});
});
