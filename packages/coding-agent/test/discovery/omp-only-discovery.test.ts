import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const EXTERNAL_PROVIDER_IDS = [
	"agents",
	"agents-md",
	"claude",
	"claude-plugins",
	"cline",
	"codex",
	"cursor",
	"gemini",
	"github",
	"mcp-json",
	"opencode",
	"vscode",
	"windsurf",
];

describe("OMP-only discovery", () => {
	test("does not register external configuration providers in the default discovery entry point", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { getAllProvidersInfo } from "@oh-my-pi/pi-coding-agent/discovery"; process.stdout.write(JSON.stringify(getAllProvidersInfo().map(provider => provider.id)));`,
			],
			{ cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		const providers = new Set(JSON.parse(stdout) as string[]);
		for (const providerId of EXTERNAL_PROVIDER_IDS) {
			expect(providers.has(providerId)).toBe(false);
		}
	});

	test("ignores the Claude plugin registry while retaining the OMP registry", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-only-discovery-home-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-only-discovery-cwd-"));
		try {
			const claudeRegistry = path.join(home, ".claude", "plugins", "installed_plugins.json");
			await fs.mkdir(path.dirname(claudeRegistry), { recursive: true });
			await Bun.write(
				claudeRegistry,
				JSON.stringify({
					version: 1,
					plugins: {
						"claude-only@marketplace": [
							{ installPath: path.join(home, "claude-only"), version: "1.0.0", enabled: true },
						],
					},
				}),
			);
			const ompRegistry = path.join(home, ".omp", "plugins", "installed_plugins.json");
			await fs.mkdir(path.dirname(ompRegistry), { recursive: true });
			await Bun.write(
				ompRegistry,
				JSON.stringify({
					version: 1,
					plugins: {
						"omp-only@marketplace": [
							{ installPath: path.join(home, "omp-only"), version: "1.0.0", enabled: true },
						],
					},
				}),
			);

			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { listClaudePluginRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers"; const { roots } = await listClaudePluginRoots(process.env.OMP_TEST_HOME, process.env.OMP_TEST_CWD); process.stdout.write(JSON.stringify(roots.map(root => root.id)));`,
				],
				{
					cwd: process.cwd(),
					env: { ...process.env, OMP_TEST_HOME: home, OMP_TEST_CWD: cwd },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout) as string[]).toEqual(["omp-only@marketplace"]);
		} finally {
			await removeWithRetries(cwd);
			await removeWithRetries(home);
		}
	});

	test("ignores project-root SSH config while loading the OMP SSH config", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-only-discovery-home-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-only-discovery-cwd-"));
		try {
			await Bun.write(path.join(cwd, "ssh.json"), JSON.stringify({ hosts: { external: { host: "198.51.100.1" } } }));
			await Bun.write(
				path.join(cwd, ".omp", "ssh.json"),
				JSON.stringify({ hosts: { omp: { host: "198.51.100.2" } } }),
			);

			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery"; const result = await loadCapability("ssh", { cwd: process.env.OMP_TEST_CWD }); process.stdout.write(JSON.stringify(result.items.map(host => host.name)));`,
				],
				{
					cwd: process.cwd(),
					env: {
						...process.env,
						OMP_TEST_CWD: cwd,
						PI_CODING_AGENT_DIR: path.join(home, "agent"),
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout) as string[]).toEqual(["omp"]);
		} finally {
			await removeWithRetries(cwd);
			await removeWithRetries(home);
		}
	});
});
