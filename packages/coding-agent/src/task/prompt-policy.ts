import type { Model } from "@oh-my-pi/pi-ai";
import {
	bareModelId,
	type Dialect,
	FALLBACK_DIALECT,
	parseOpenAIModel,
	preferredDialect,
	semverEqual,
} from "@oh-my-pi/pi-catalog/identity";

/**
 * Whether task guidance should follow Codex's GPT-5.6-specific delegation policy.
 * `task.eager=always` routes through the unified hard delegation rules, bypassing
 * the GPT-5.6/Codex soft branch regardless of model.
 */
export function usesCodexTaskPrompt(modelId: string | undefined, eagerAlways = false): boolean {
	if (eagerAlways) return false;
	if (!modelId) return false;
	const parsed = parseOpenAIModel(bareModelId(modelId));
	return parsed !== null && semverEqual(parsed.version, "5.6");
}

/**
 * The prompt-shaping tool dialect of the system prompt cache key, mirroring
 * `resolveDialect` (sdk.ts) so the key stays in lockstep with how the prompt
 * renders the tool inventory. The resolved dialect is threaded through
 * `buildSystemPromptInternal`'s `toolDialect` into `renderToolInventory`, so
 * the labels below are byte-faithful: `buildSystemPromptInternal` renders the
 * compact provider-native name list when the dialect is native and the full
 * owned-dialect `# Tool:` catalog (examples in the pinned dialect, independent
 * of the active model) otherwise. Returns a stable shape label:
 * - `native` — provider-native tool calling, constant across models;
 * - `owned:<dialect>` — an explicit in-band dialect, constant across models;
 * - `auto:<dialect>` — `auto` fell back for a model without native tool
 *   support; the resolved dialect is model-dependent.
 *
 * Unlike the delegation policy, `task.eager=always` does NOT unify this
 * dimension: a model switch that flips the resolved shape (e.g. native to an
 * `auto` fallback dialect) must refresh the system prompt even when the
 * delegation policy branch is unified.
 */
export function promptToolShape(
	format: "auto" | "native" | Dialect,
	model: (Pick<Model, "supportsTools"> & Partial<Pick<Model, "id">>) | undefined,
): string {
	if (format === "native") return "native";
	if (format !== "auto") return `owned:${format}`;
	if (model?.supportsTools !== false) return "native";
	const preferred = model.id ? preferredDialect(model.id) : FALLBACK_DIALECT;
	return `auto:${preferred === FALLBACK_DIALECT ? "glm" : preferred}`;
}
