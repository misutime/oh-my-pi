/**
 * Contract: after a deliberate user interrupt the advisor must not auto-resume
 * the run, but its concerns must survive as visible, persisted transcript cards
 * so they re-enter context when the user resumes. Internal (non-user) aborts keep
 * the prior behavior — advisor advice stays in the auto-continue path.
 *
 * Five seams:
 *  1. A concern already steered into the agent queue when the user hits Esc is
 *     pulled out of the post-abort auto-continue path and re-recorded as advice.
 *  2. A concern parked hidden (#pendingNextTurnMessages) by the suppressed
 *     delivery while the turn is still tearing down is reclaimed once idle.
 *  3. A non-user abort does NOT suppress: a steered advisor card still drives the
 *     auto-continue, so the gate is keyed to the user interrupt, not any abort.
 *  4. A user message queued (as a steer) before the interrupt is delivered on
 *     resume even though the preserved advisor card is the trailing message.
 *  5. The same queued as a follow-up: continuing from the preserved advisor card
 *     (which converts to `developer`) would send an invalid provider tail, so the
 *     follow-up stays queued for the next explicit resume rather than auto-running.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

interface MockYieldDetails {
	status: "success";
	data?: unknown;
	type?: string | string[];
}

const mockYieldParameters = type({
	result: "unknown",
	"type?": "unknown",
});

const ADVISOR_TYPE = "advisor";

interface ParkedHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	/** Resolves the moment the first turn's model stream begins (deterministic
	 *  "now streaming" signal — no wall-clock polling). */
	streamStarted: Promise<void>;
}

interface CompletedAdvisorHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	advisorMock: MockModel;
}

interface AdvisorTestExtensionRunner {
	hasHandlers(eventType: string): boolean;
	emitBeforeAgentStart(): Promise<undefined>;
	emit(event: { type: string; message?: AgentMessage }): Promise<void>;
}

describe("AgentSession advisor auto-resume suppression", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-advisor-suppress-");
	});

	afterEach(async () => {
		// dispose() aborts the agent, cancelling the parked first-turn stream.
		try {
			await session?.dispose();
		} finally {
			for (const authStorage of authStorages.splice(0)) authStorage.close();
			await Bun.sleep(0);
			await tempDir?.remove();
		}
	});

	/**
	 * First turn parks open (a 60s mock delay that abort cancels) so a steer/park
	 * + interrupt can be sequenced while the agent is genuinely streaming. The
	 * `streamStarted` promise resolves from the mock handler, before the delay, so
	 * tests await the real stream-begin signal rather than a timer.
	 */
	async function createParkedSession(tailResponses: MockResponse[] = []): Promise<ParkedHarness> {
		const started = Promise.withResolvers<void>();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				...tailResponses,
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return { session, sessionManager, mock, streamStarted: started.promise };
	}

	function readYieldResultData(result: unknown): unknown {
		if (!result || typeof result !== "object" || !("data" in result)) return undefined;
		return result.data;
	}

	function isYieldType(value: unknown): value is string | string[] {
		return (
			typeof value === "string" ||
			(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string"))
		);
	}

	function createMockYieldTool(): AgentTool<typeof mockYieldParameters, MockYieldDetails> {
		return {
			name: "yield",
			label: "Yield",
			description: "Mock yield tool",
			parameters: mockYieldParameters,
			execute: async (_toolCallId, params) => {
				const details: MockYieldDetails = { status: "success", data: readYieldResultData(params.result) };
				if (isYieldType(params.type)) details.type = params.type;
				return {
					content: [{ type: "text", text: "Result submitted." }],
					details,
				};
			},
		};
	}

	function createYieldMockResponse(args: { result: { data: unknown }; type?: string | string[] }): MockResponse {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: `call_yield_${Snowflake.next()}`,
			name: "yield",
			arguments: args,
		};
		return {
			content: [toolCall],
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	}

	async function createCompletedAdvisorSession(
		severity: "concern" | "blocker" = "concern",
		extensionRunner?: AdvisorTestExtensionRunner,
	): Promise<CompletedAdvisorHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["EXACT VERDICT"], stopReason: "stop" },
				{ content: ["CHANGED VERDICT"], stopReason: "stop" },
			],
		});
		const advisorMock = createMockModel({
			responses: [
			{
				content: [
					{
						type: "toolCall",
						name: "advise",
						arguments: { note: "Fixture verdict confirmed", severity },
					},
				],
			},
			{ content: ["no further advice"], stopReason: "stop" },
			{ content: ["advisor review complete"], stopReason: "stop" },
		],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "advisor.syncBacklog": "1" });
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
			extensionRunner: extensionRunner as never,
		});
		return { session, sessionManager, mock, advisorMock };
	}

	function advisorCard(content: string) {
		return {
			customType: ADVISOR_TYPE,
			content,
			display: true,
			attribution: "agent" as const,
			details: { notes: [{ note: content, severity: "concern" as const }] },
		};
	}

	function isAdvisorCard(message: AgentMessage): boolean {
		return message.role === "custom" && (message as { customType?: string }).customType === ADVISOR_TYPE;
	}

	function userMessageText(messages: AgentMessage[]): string[] {
		const out: string[] = [];
		for (const message of messages) {
			if (message.role !== "user") continue;
			const content = message.content;
			if (typeof content === "string") {
				out.push(content);
			} else {
				for (const part of content) if (part.type === "text") out.push(part.text);
			}
		}
		return out;
	}

	function capturePersistedAdvice(sessionManager: SessionManager): string[] {
		const persisted: string[] = [];
		sessionManager.onEntryAppended = entry => {
			if (entry.type === "custom_message" && entry.customType === ADVISOR_TYPE) {
				persisted.push(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
			}
		};
		return persisted;
	}
	it("steers a late advisor concern into a terminal fence so the primary re-evaluates", async () => {
		const { session, mock } = await createCompletedAdvisorSession();

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("read five fixture files and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);

		// Fence steered the concern during onPrimaryTurnEnd, primary ran again
		expect(mock.calls.length).toBe(2);
		// Steered advice appears in the agent state as an advisor card, confirming
		// the concern reached the primary's message history. The core code fix
		// (syncBacklog-independent catchup + sendCustomMessage steer path) ensures
		// the advice is visible in the transcript where the primary can process it.
		const hasAdvisorCard = session.agent.state.messages.some(m =>
			m.role === "custom" &&
			typeof m.content === "string" &&
			m.content.includes("Fixture verdict confirmed")
		);
		expect(hasAdvisorCard).toBe(true);
	});
	it("steers a late advisor blocker after a terminal answer so the primary corrects it", async () => {
		const { session, mock } = await createCompletedAdvisorSession("blocker");

		// Enable advisor BEFORE prompt so it is running when the fence activates
		expect(session.setAdvisorEnabled(true)).toBe(true);

		await session.prompt("read five fixture files and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);

		// Fence steered the blocker during onPrimaryTurnEnd, primary ran again
		expect(mock.calls.length).toBe(2);
	});

	it("steers another late advisor concern after an existing advisor card", async () => {
		const { session, mock } = await createCompletedAdvisorSession();

		expect(session.setAdvisorEnabled(true)).toBe(true);
		session.agent.state.messages.push({
			role: "custom",
			...advisorCard("first late concern"),
			timestamp: Date.now(),
		});
		await session.prompt("answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);

		// Fence steered the concern during onPrimaryTurnEnd; the pushed card and the
		// steered batch both appear in the transcript.
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(2);
		expect(mock.calls.length).toBe(2);
	});

	it("steers a late advisor concern after terminal text with provider metadata blocks", async () => {
		const { session, mock } = await createCompletedAdvisorSession();

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("answer with exactly one line");

		// Inject provider metadata blocks into the terminal assistant answer so the
		// fence path exercises redactedThinking/fallback handling in onPrimaryTurnEnd.
		const answer = session.agent.state.messages.at(-1);
		if (answer?.role !== "assistant") throw new Error("Expected terminal assistant answer");
		if (typeof answer.content === "string") throw new Error("Expected array content on mock assistant message");
		(answer.content as Array<{ type: string; data?: string; from?: unknown; to?: unknown }>).push(
			{ type: "redactedThinking", data: "opaque provider reasoning" },
			{ type: "fallback", from: { model: "first" }, to: { model: "second" } },
		);
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);

		// Fence steered the concern during onPrimaryTurnEnd, primary ran again
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(mock.calls.length).toBe(2);
	});

	it("steers a terminal concern via async review, starting an intervention turn", async () => {
		const { session, mock } = await createCompletedAdvisorSession();

		let agentStartCount = 0;
		const unsub = session.agent.subscribe(event => {
			if (event.type === "agent_start") agentStartCount++;
		});

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("read five fixture files and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);

		// Fence collected the concern during onPrimaryTurnEnd, steered it into the
		// agent loop, and the primary ran again within the same user-run (no extra
		// agent_start event was emitted — same session continues).
		expect(mock.calls.length).toBe(2);
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(agentStartCount).toBe(2);
		unsub();

});

	it("preserves an advisor concern steered before the user interrupt, without auto-resuming", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession();
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		// Advisor raises an interrupting concern mid-run: it lands in the steering queue.
		await session.sendCustomMessage(advisorCard("breaks the build"), { deliverAs: "steer", triggerTurn: true });
		expect(session.agent.peekSteeringQueue().some(isAdvisorCard)).toBe(true);

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();

		// Pulled out of the auto-continue path and re-recorded as a visible/persisted card.
		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["breaks the build"]);
		// No advisor-driven resume: only the original (aborted) turn called the model.
		expect(mock.calls.length).toBe(1);

		await running.catch(() => {});
	});

	it("reclaims an advisor concern parked during abort cleanup so it is not lost", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession();
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		// A suppressed delivery arriving while the turn is still streaming parks the
		// concern hidden in #pendingNextTurnMessages (the mid-abort race window).
		await session.sendCustomMessage(advisorCard("parked mid-abort"), { deliverAs: "nextTurn", triggerTurn: false });
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(0);
		expect(persisted).toEqual([]);

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();

		// Reclaimed and surfaced as a visible/persisted card once the agent settles.
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["parked mid-abort"]);
		expect(mock.calls.length).toBe(1);

		await running.catch(() => {});
	});

	it("keeps advisor auto-resume for a non-user (internal) abort", async () => {
		const { session, mock, streamStarted } = await createParkedSession([{ content: ["resumed after advice"] }]);

		const running = session.prompt("do the thing");
		await streamStarted;

		await session.sendCustomMessage(advisorCard("keep going"), { deliverAs: "steer", triggerTurn: true });
		expect(session.agent.peekSteeringQueue().some(isAdvisorCard)).toBe(true);

		// Internal abort (no USER_INTERRUPT_LABEL): the advisor card is NOT extracted;
		// it stays in the queue and drives a normal auto-continue turn.
		await session.abort();
		await session.waitForIdle();
		await running.catch(() => {});

		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(mock.calls.length).toBe(2);
	});

	it("reclaims a stranded advisor steer on settle while suppressed, instead of auto-resuming the stopped run", async () => {
		// Residual edge exposed once interrupting advice is steered (not parked) into a
		// resumed streaming run: a concern can land in the steer queue past the loop's
		// final boundary poll and strand. The steer queue otherwise bypasses the
		// suppression latch in #canAutoContinueForFollowUp, so the idle settle would
		// auto-resume the run the user stopped. The settle drain must instead reclaim the
		// stranded advisor steer as visible advice. (A non-user abort is used purely as a
		// deterministic settle trigger — it neither extracts advisor cards nor clears the
		// latch — standing in for the natural #endInFlight settle after the resumed turn.)
		const { session, sessionManager, mock, streamStarted } = await createParkedSession([
			{ content: ["must not auto-resume"] },
		]);
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		// User interrupt latches suppression.
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});
		expect(mock.calls.length).toBe(1);

		// A concern strands in the steer queue (steered past the resumed turn's last poll).
		session.agent.steer({
			role: "custom",
			customType: ADVISOR_TYPE,
			content: "stranded tail concern",
			display: true,
			attribution: "agent",
			details: { notes: [{ note: "stranded tail concern", severity: "concern" }] },
			timestamp: Date.now(),
		} as AgentMessage);
		expect(session.agent.peekSteeringQueue().some(isAdvisorCard)).toBe(true);

		// Settle while suppression is still in effect.
		await session.abort();
		await session.waitForIdle();

		// Reclaimed as visible/persisted advice; the steer queue is emptied and NO
		// advisor-only auto-resume turn ran (model still called exactly once).
		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["stranded tail concern"]);
		expect(mock.calls.length).toBe(1);
	});

	it("resumes a queued user steer stranded behind a preserved advisor card", async () => {
		// Reported bug: typing a message during a run (queued as a steer) then pressing
		// enter again (empty-submit interrupt) recorded the advisor card but stranded the
		// user message — nothing resumed the run. The preserved advisor card is the
		// trailing `custom` message, which #canAutoContinueForFollowUp must look past.
		const { session, sessionManager, mock, streamStarted } = await createParkedSession([
			{ content: ["resumed on the steer"] },
		]);
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		await session.sendCustomMessage(advisorCard("breaks the build"), { deliverAs: "steer", triggerTurn: true });
		await session.prompt("also rename the helper", { streamingBehavior: "steer" });

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		// Advisor card preserved as a visible/persisted card AND the user steer delivered
		// in exactly one resume turn (no spurious extra call).
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["breaks the build"]);
		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(mock.calls.length).toBe(2);
		expect(userMessageText(session.agent.state.messages)).toContain("also rename the helper");
	});

	it("leaves a queued user follow-up queued behind a preserved advisor card", async () => {
		// Same stranding, but the user message was queued as a follow-up (Ctrl+Enter).
		// Only steering resumes safely behind a preserved advisor card: agentLoopContinue
		// injects steering before the next model call, keeping the request tail valid. A
		// follow-up would instead resume by continuing from the advisor card (which converts
		// to `developer`) as the tail — a provider-invalid request — so it is NOT auto-run.
		// It stays queued for the next explicit user resume.
		const { session, sessionManager, mock, streamStarted } = await createParkedSession([
			{ content: ["must not run"] },
		]);
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		await session.sendCustomMessage(advisorCard("missing a guard"), { deliverAs: "steer", triggerTurn: true });
		await session.prompt("then add the test", { streamingBehavior: "followUp" });

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		// Advisor preserved as a visible/persisted card; the follow-up stays queued and
		// drives no resume (only the original, aborted turn ever called the model).
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["missing a guard"]);
		expect(userMessageText([...session.agent.peekFollowUpQueue()])).toContain("then add the test");
		expect(userMessageText(session.agent.state.messages)).not.toContain("then add the test");
		expect(mock.calls.length).toBe(1);
	});

	it("wakes a turn for an IRC aside stranded across a user interrupt", async () => {
		const { session, mock, streamStarted } = await createParkedSession([{ content: ["replying to peer"] }]);
		const running = session.prompt("do the thing");
		await streamStarted;
		// IRC arrives mid-turn → queued as a non-interrupting aside.
		await session.deliverIrcMessage({ id: "m1", from: "peer", to: "me", body: "ping", ts: Date.now() } as IrcMessage);
		// The user interrupt skips the loop's final aside poll, stranding the aside with no loop to
		// drain it. The settle drain must wake a turn so the peer still gets a response.
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		const sawIrc = session.agent.state.messages.some(
			m => m.role === "custom" && (m as { customType?: string }).customType === "irc:incoming",
		);
		expect(sawIrc).toBe(true);
		expect(mock.calls.length).toBe(2);
	});

	it("stops an idle IRC wake after a terminal yield", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		let providerCalls = 0;
		const mock = createMockModel({
			handler: () => {
				providerCalls++;
				if (providerCalls > 1) {
					throw new Error("terminal yield must not start a second provider call");
				}
				return createYieldMockResponse({ result: { data: { ok: true } } });
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [createMockYieldTool()] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const msg: IrcMessage = { id: "m-yield", from: "peer", to: "me", body: "status?", ts: Date.now() };

		const outcome = await session.deliverIrcMessage(msg);
		await session.waitForIdle();

		expect(outcome).toBe("woken");
		expect(providerCalls).toBe(1);
		expect(mock.calls.length).toBe(1);
	});

	it("flushes an accepted IRC aside on dispose instead of dropping it", async () => {
		const { session, streamStarted } = await createParkedSession();
		const running = session.prompt("do the thing");
		await streamStarted;
		await session.deliverIrcMessage({ id: "m1", from: "peer", to: "me", body: "ping", ts: Date.now() } as IrcMessage);
		// Dispose mid-flight persists the accepted aside to the transcript rather than dropping it.
		session.beginDispose();
		const sawIrc = session.agent.state.messages.some(
			m => m.role === "custom" && (m as { customType?: string }).customType === "irc:incoming",
		);
		expect(sawIrc).toBe(true);
		running.catch(() => {});
	});

	it("responds to a stranded IRC aside while keeping a blocked follow-up queued", async () => {
		const { session, mock, streamStarted } = await createParkedSession([{ content: ["replying to peer"] }]);
		const running = session.prompt("do the thing");
		await streamStarted;
		// The user queues a follow-up (Ctrl+Enter) and an IRC ping lands as an aside...
		await session.prompt("then add the test", { streamingBehavior: "followUp" });
		await session.deliverIrcMessage({ id: "m2", from: "peer", to: "me", body: "ping", ts: Date.now() } as IrcMessage);
		// ...then the user interrupts. The IRC must still get a response, but the user's queued
		// follow-up must NOT auto-run (seam #5) even though the IRC wake turn leaves a valid tail.
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		const sawIrc = session.agent.state.messages.some(
			m => m.role === "custom" && (m as { customType?: string }).customType === "irc:incoming",
		);
		expect(sawIrc).toBe(true);
		expect(userMessageText([...session.agent.peekFollowUpQueue()])).toContain("then add the test");
		expect(userMessageText(session.agent.state.messages)).not.toContain("then add the test");
		expect(mock.calls.length).toBe(2);
	});
	it("fires extension hooks for steer-delivered advisor cards", async () => {
		let emitCount = 0;
		let lastEventType = "";
		const hookRunner: AdvisorTestExtensionRunner = {
			hasHandlers: () => true,
			emitBeforeAgentStart: async () => undefined,
			emit: async event => {
				emitCount++;
				lastEventType = event.type;
			},
		};
		const { session: hookSession, mock } = await createCompletedAdvisorSession("concern", hookRunner);

		expect(hookSession.setAdvisorEnabled(true)).toBe(true);
		await hookSession.prompt("read five fixture files and answer with exactly one line");
		await hookSession.waitForIdle();
		await hookSession.waitForAdvisorCatchup(5000);
		await hookSession.waitForIdle();
		await hookSession.waitForAdvisorCatchup(5000);

		// Fence steered the concern: extension hooks must fire for the
		// steer-delivered advisor card (message_start/message_end for the
		// custom card emitted during the fence batch processing).
		expect(mock.calls.length).toBe(2);
		// At least one emit should have fired for the advisor card
		expect(emitCount).toBeGreaterThan(0);
	});

	it("persists advice before catchup reports completion", async () => {
		const { session: pSession, sessionManager, mock } = await createCompletedAdvisorSession();
		const persisted = capturePersistedAdvice(sessionManager);

		expect(pSession.setAdvisorEnabled(true)).toBe(true);
		await pSession.prompt("read five fixture files and answer with exactly one line");
		await pSession.waitForIdle();
		await pSession.waitForAdvisorCatchup(5000);
		await pSession.waitForIdle();
		await pSession.waitForAdvisorCatchup(5000);

		// The fence-steered advice must be persisted through the session
		// manager before catchup reports completion.
		expect(mock.calls.length).toBe(2);
		// The advisor card content should appear in persisted entries
		expect(persisted.length).toBeGreaterThan(0);
		const allPersisted = persisted.join(" ");
		expect(allPersisted).toContain("Fixture verdict confirmed");
	});

	it("preserves a second terminal concern as a visible card (intervention consumed)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["EXACT VERDICT"], stopReason: "stop" },
				{ content: ["CHANGED VERDICT"], stopReason: "stop" },
			],
		});
		const advisorMock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "advise", arguments: { note: "first concern", severity: "concern" } }] },
				{ content: ["no further advice"], stopReason: "stop" },
				// Second advisor review also produces a concern
				{ content: [{ type: "toolCall", name: "advise", arguments: { note: "second concern", severity: "concern" } }] },
				{ content: ["advisor review complete"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "advisor.syncBacklog": "1" });
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("read five fixture files and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);

		// First terminal concern: steered into the agent loop (intervention consumed)
		expect(mock.calls.length).toBe(2);

		// The first steer-delivered advisor card is in the transcript
		const advisorCards = session.agent.state.messages.filter(isAdvisorCard);
		expect(advisorCards.length).toBeGreaterThan(0);

		// The second concern from the second review must NOT trigger another steer.
		// Since intervention was already consumed, the second concern is preserved
		// as a visible card without triggering a third primary turn.
		const allPersistedText = advisorCards.map(c => typeof c.content === "string" ? c.content : "").join(" ");
		expect(allPersistedText).toContain("first concern");
		expect(allPersistedText).toContain("second concern");
	});

	it("preserves advice as visible card in plan mode (plan-mode preservation)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["EXACT VERDICT"], stopReason: "stop" },
				{ content: ["CHANGED VERDICT"], stopReason: "stop" },
			],
		});
		const advisorMock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "advise",
							arguments: { note: "Plan mode concern", severity: "concern" },
						},
					],
				},
				{ content: ["advisor complete"], stopReason: "stop" },
				{ content: ["advisor review complete"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.syncBacklog": "1",
			"plan.enabled": true,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("read five fixture files and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);

		// In plan mode, the fence should NOT steer the concern — it must be
		// preserved as a visible advisor card instead.
		const advisorCards = session.agent.state.messages.filter(isAdvisorCard);
		expect(advisorCards.length).toBeGreaterThan(0);
		expect(mock.calls.length).toBe(1);
	});
});

describe("AgentSession advisor terminal turn feedback characterization", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-advisor-term-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			for (const authStorage of authStorages.splice(0)) authStorage.close();
			await Bun.sleep(0);
			await tempDir?.remove();
		}
	});

		function isAdvisorCard(message: AgentMessage): boolean {
			return message.role === "custom" && (message as { customType?: string }).customType === ADVISOR_TYPE;
		}

	/**
	 * Create a session whose advisor produces a nit (or no severity, which defaults
	 * to nit). The primary mock has two responses to handle a potential re-evaluation
	 * turn triggered by the nit being picked up in the outer yield poll.
	 */
	async function createNitAdvisorSession(
		note: string,
		severity?: "nit",
	): Promise<CompletedAdvisorHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["TASK COMPLETE"], stopReason: "stop" },
				{ content: ["ACKNOWLEDGED"], stopReason: "stop" },
			],
		});
		const advisorMock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "advise",
						arguments: severity !== undefined ? { note, severity } : { note },
						},
					],
				},
				{ content: ["no further advice"], stopReason: "stop" },
				{ content: ["advisor review complete"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		return { session, sessionManager, mock, advisorMock };
	}

	/**
	 * Create a session whose advisor produces only text (no advise tool calls).
	 * Used to characterize silent-advisor behavior.
	 */
	async function createSilentAdvisorSession(): Promise<CompletedAdvisorHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["TASK COMPLETE"], stopReason: "stop" },
			],
		});
		const advisorMock = createMockModel({
			responses: [
				{ content: ["review complete, no issues"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		return { session, sessionManager, mock, advisorMock };
	}

	/**
	 * Create a session whose advisor produces an "all good" / "lgtm" note that the
	 * emission guard should suppress as content-free filler.
	 */
	async function createSuppressedPhraseSession(phrase: string): Promise<CompletedAdvisorHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["TASK COMPLETE"], stopReason: "stop" },
				{ content: ["ACKNOWLEDGED"], stopReason: "stop" },
			],
		});
		const advisorMock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "advise",
							arguments: { note: phrase },
						},
					],
				},
				{ content: ["advisor review complete"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		return { session, sessionManager, mock, advisorMock };
	}

	// ── Terminal nit visibility ──

	it("injects an advisor nit into the transcript after a terminal turn", async () => {
		const { session, mock } = await createNitAdvisorSession("Document looks correct.");

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("write a document and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();

		// The nit should appear as a preserved advisor card in the transcript.
		const advisorCards = session.agent.state.messages.filter(
			(m: AgentMessage) => m.role === "custom" && (m as { customType?: string }).customType === ADVISOR_TYPE,
		);
		expect(advisorCards.length).toBeGreaterThan(0);
		const cardTexts = advisorCards.map(c => typeof c.content === "string" ? c.content : "");
		expect(cardTexts.join(" ")).toContain("Document looks correct");
	});

	it("nit is preserved as visible card without triggering extra turns", async () => {
		const { session, mock } = await createNitAdvisorSession("fine-tuning suggestion");

		let agentStartCount = 0;
		const unsub = session.agent.subscribe(event => {
			if (event.type === "agent_start") agentStartCount++;
		});

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("write a document and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();

		// Nit is preserved as visible card — no primary re-evaluation and still
		// only one agent_start.
		const advisorCards = session.agent.state.messages.filter(
			(m: AgentMessage) => m.role === "custom" && (m as { customType?: string }).customType === ADVISOR_TYPE,
		);
		expect(advisorCards.length).toBeGreaterThan(0);
		expect(agentStartCount).toBe(1);
		unsub();
	});

	// ── Silent advisor (no advice) ──

	it("silent advisor does not inject any advisor card", async () => {
		const { session, mock } = await createSilentAdvisorSession();

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("write a document and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();

		const advisorCards = session.agent.state.messages.filter(
			(m: AgentMessage) => m.role === "custom" && (m as { customType?: string }).customType === ADVISOR_TYPE,
		);
		expect(advisorCards).toHaveLength(0);
		// Primary called exactly once — no re-evaluation turn.
		expect(mock.calls.length).toBe(1);
	});

	it("silent advisor produces exactly one agent_start", async () => {
		const { session } = await createSilentAdvisorSession();

		let agentStartCount = 0;
		const unsub = session.agent.subscribe(event => {
			if (event.type === "agent_start") agentStartCount++;
		});

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("write a document and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();

		expect(agentStartCount).toBe(1);
		unsub();

	});

	// ── Suppressed content-free phrases ──

	it("suppresses 'lgtm' advice as content-free filler", async () => {
		const { session, mock } = await createSuppressedPhraseSession("lgtm");

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("write a document and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();

		const advisorCards = session.agent.state.messages.filter(
			(m: AgentMessage) => m.role === "custom" && (m as { customType?: string }).customType === ADVISOR_TYPE,
		);
		expect(advisorCards).toHaveLength(0);
		// No re-evaluation triggered by suppressed phrase.
		expect(mock.calls.length).toBe(1);
	});

	it("suppresses 'all good' advice", async () => {
		const { session, mock } = await createSuppressedPhraseSession("all good");

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("write a document and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();

		const advisorCards = session.agent.state.messages.filter(
			(m: AgentMessage) => m.role === "custom" && (m as { customType?: string }).customType === ADVISOR_TYPE,
		);
		expect(advisorCards).toHaveLength(0);
		expect(mock.calls.length).toBe(1);
	});

	it("suppresses 'no issue; continue.' advice", async () => {
		const { session, mock } = await createSuppressedPhraseSession("no issue; continue.");

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("write a document and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();

		const advisorCards = session.agent.state.messages.filter(
			(m: AgentMessage) => m.role === "custom" && (m as { customType?: string }).customType === ADVISOR_TYPE,
		);
		expect(advisorCards).toHaveLength(0);
		expect(mock.calls.length).toBe(1);
	});

	// ── Nit-only fence batch does not consume intervention quota ──

	it("nit-only terminal review does not consume the intervention cap", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: ["FIRST ANSWER"], stopReason: "stop" }],
		});
		// Advisor produces a nit only; no re-evaluation → no second review.
		const advisorMock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "advise", arguments: { note: "minor formatting nit" } }] },
				{ content: ["no further advice"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false, "retry.enabled": false, "advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, advisorTools: [], advisorStreamFn: advisorMock.stream });

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("write a document and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();
		const advisorCards = session.agent.state.messages.filter(
			(m: AgentMessage) => m.role === "custom" && (m as { customType?: string }).customType === ADVISOR_TYPE,
		);
		const cardTexts = advisorCards.map(c => typeof c.content === "string" ? c.content : "").join(" ");
		expect(cardTexts).toContain("minor formatting nit");
		expect(mock.calls.length).toBe(1);
	});

	// ── Idle-path triggerTurn: fence relies on this when the primary loop has exited ──
	// NOTE: This tests the host sendCustomMessage({triggerTurn:true}) mechanism that the
	// fence fix depends on for async/idle delivery. It is NOT an end-to-end reproduction
	// of the fence's async timing (mock runs synchronously inside #beginInFlight).

	it("triggerTurn starts a new turn from idle (fence idle-path mechanism)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["FIRST ANSWER"], stopReason: "stop" },
				{ content: ["INTERVENTION RESPONSE"], stopReason: "stop" },
			],
		});
		// No advisor — test only the host sendCustomMessage({triggerTurn:true}) mechanism.
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false, "retry.enabled": false,
		});
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent, sessionManager, settings, modelRegistry,
			advisorTools: [], advisorStreamFn: undefined,
		});

		await session.prompt("write a document and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);

		// Session is idle — primary ran exactly once.
		expect(mock.calls.length).toBe(1);

		// Simulate what the terminal fence does when the agent loop has fully exited:
		// deliverAs: "steer" + triggerTurn: true must start a new turn from idle.
		const result = await session.sendCustomMessage(
			{
				customType: ADVISOR_TYPE,
				content: "late blocker found after turn end",
				display: true,
				attribution: "agent",
				details: { notes: [{ note: "late blocker found after turn end", severity: "blocker" }] },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);

		// triggerTurn returns true when it synchronously started a new turn.
		expect(result).toBe(true);
		// Primary ran again: original + intervention = 2.
		expect(mock.calls.length).toBe(2);
		const advisorCards = session.agent.state.messages.filter(isAdvisorCard);
		expect(advisorCards.length).toBeGreaterThan(0);
		const cardTexts = advisorCards.map(c => typeof c.content === "string" ? c.content : "").join(" ");
		expect(cardTexts).toContain("late blocker");
	});

	// ── Re-entrant cap: intervention turn's own terminal concern is preserved ──

	it("caps intervention at one per user-run: second terminal concern preserved as card", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["FIRST ANSWER"], stopReason: "stop" },
				{ content: ["INTERVENTION RESPONSE"], stopReason: "stop" },
				{ content: ["SHOULD NOT RUN"], stopReason: "stop" },
			],
		});
		// Advisor produces concern on first review AND another concern on second review
		const advisorMock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "advise", arguments: { note: "first concern", severity: "concern" } }] },
				{ content: ["no further advice"], stopReason: "stop" },
				// Second advisor review (during intervention turn) also produces a concern
				{ content: [{ type: "toolCall", name: "advise", arguments: { note: "second concern", severity: "concern" } }] },
				{ content: ["advisor review complete"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false, "retry.enabled": false, "advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent, sessionManager, settings, modelRegistry,
			advisorTools: [], advisorStreamFn: advisorMock.stream,
		});

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("read five fixture files and answer with exactly one line");
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		await session.waitForIdle();
		await session.waitForAdvisorCatchup(5000);
		// First concern triggered an intervention turn; second concern was capped.
		// Total: original turn + exactly one intervention turn = 2.
		expect(mock.calls.length).toBe(2);

		// Both concerns must be visible in the transcript.
		const advisorCards = session.agent.state.messages.filter(isAdvisorCard);
		const allText = advisorCards.map(c => typeof c.content === "string" ? c.content : "").join(" ");
		expect(allText).toContain("first concern");
		expect(allText).toContain("second concern");
	});
});
