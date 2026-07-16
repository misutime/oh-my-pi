/**
 * Cross-platform replacement for scripts/link-omp.sh.
 *
 * On Unix: replaces the bun-shebang symlink with the `scripts/omp` wrapper
 * (workaround for bunfig.toml preload bug).
 * On Windows: the wrapper is a POSIX shell script; keep the original `bun link`
 * output linking to `src/cli.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");

if (process.platform === "win32") {
	console.log("link-omp: skipping wrapper replacement on Windows (wrapper is POSIX sh)");
	process.exit(0);
}

const target = path.join(repoRoot, "packages", "coding-agent", "scripts", "omp");

if (!fs.existsSync(target)) {
	console.error(`link-omp: target wrapper not found: ${target}`);
	process.exit(1);
}

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

const linkPath = path.join(globalBin, "omp");
try { fs.unlinkSync(linkPath); } catch {}
fs.symlinkSync(target, linkPath);

console.log(`link-omp: linked ${linkPath} -> ${target}`);
