#!/usr/bin/env bun
/**
 * Build the release (pro) omp binary and install it as the global `omp`.
 *
 * The dev `bun setup` links the global `omp` command to the source CLI
 * (`src/cli.ts`, reports `omp/<version>-dev`). This script replaces that
 * global entry with the standalone compiled binary (`dist/omp.exe`, reports
 * `omp/<version>` — no `-dev` suffix), embedding natives/mupdf and running
 * with `PI_COMPILED=true`.
 *
 * Re-run `bun setup` afterwards to restore the dev link.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");
const codingAgentDir = path.join(repoRoot, "packages", "coding-agent");
const binaryName = process.platform === "win32" ? "omp.exe" : "omp";
const binaryPath = path.join(codingAgentDir, "dist", binaryName);

// 1. Build the release binary.
console.log("setup-pro: building release binary…");
const build = await $`bun --cwd=${codingAgentDir} run build`.nothrow();
if (build.exitCode !== 0) {
	console.error("setup-pro: build failed:\n" + build.stderr.toString());
	process.exit(build.exitCode || 1);
}
if (!fs.existsSync(binaryPath)) {
	console.error(`setup-pro: build produced no binary at ${binaryPath}`);
	process.exit(1);
}

// 2. Resolve the global bin directory (same approach as link-omp.ts).
let globalBin = "";
try {
	const result = await $`bun pm -g bin`.quiet().nothrow();
	globalBin = result.text().trim();
} catch {}
if (!globalBin) {
	const bunInstall = process.env.BUN_INSTALL;
	const home = process.env.HOME ?? "~";
	globalBin = path.join(bunInstall ?? home, ".bun", "bin");
}
fs.mkdirSync(globalBin, { recursive: true });
const destPath = path.join(globalBin, binaryName);

// 3. Install atomically: copy to a temp name, then rename over the target.
// A running `omp` process (e.g. the dev-link shim) holds the target on
// Windows, so a replace failure surfaces that clearly.
const tempPath = `${destPath}.pro-new`;
await fs.promises.copyFile(binaryPath, tempPath);
try {
	await fs.promises.rename(tempPath, destPath);
} catch {
	try {
		await fs.promises.unlink(destPath);
		await fs.promises.rename(tempPath, destPath);
	} catch (err) {
		await fs.promises.unlink(tempPath).catch(() => {});
		console.error(
			`setup-pro: failed to replace ${destPath}: ${(err as Error).message}\n` +
				"Close any running omp processes (e.g. a dev `omp` session) and retry.",
		);
		process.exit(1);
	}
}
if (process.platform !== "win32") {
	await fs.promises.chmod(destPath, 0o755);
}

// 4. Verify the installed binary reports a release version.
const verify = await $`${destPath} --version`.quiet().nothrow();
const version = verify.text().trim();
if (verify.exitCode !== 0 || version.includes("-dev")) {
	console.error(`setup-pro: installed binary reports unexpected version: ${version || "(no output)"}`);
	process.exit(1);
}
console.log(`setup-pro: installed ${destPath} → ${version}`);
