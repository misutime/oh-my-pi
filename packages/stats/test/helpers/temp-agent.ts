/**
 * Shared test isolation for stats Bun tests.
 *
 * The default profile's stats.db is redirected to `$XDG_DATA_HOME/omp/stats.db`
 * by {@link DirResolver} whenever `agentDirOverride === defaultAgent`. Tests
 * that only set `PI_CONFIG_DIR` + `setAgentDir(<home>/<config>/agent)` resolve
 * to that default and silently share `stats.db` across files when an XDG
 * variable is set (e.g. CI's `XDG_DATA_HOME`), producing the cross-test row
 * pollution that fails `db-range`, `behavior-backfill`, `priority-premium-*`,
 * and `agent-type` runs.
 *
 * `installStatsTestIsolation` snapshots and clears `XDG_*_HOME` plus
 * `PI_CONFIG_DIR` for the test, points the agent directory at a fresh
 * `TempDir`, closes the stats DB handle, and tears everything back down in the
 * matching `afterEach`.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeDb } from "@oh-my-pi/omp-stats/db";
import { getAgentDir, getStatsDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const XDG_KEYS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

export interface StatsTestIsolation {
	/** Active per-test `TempDir`. Null between tests. */
	current(): TempDir | null;
}

export function installStatsTestIsolation(prefix: string): StatsTestIsolation {
	const originalAgentDir = getAgentDir();
	let originalConfigDir: string | undefined;
	const originalXdg: Record<string, string | undefined> = {};
	let tempDir: TempDir | null = null;

	beforeEach(() => {
		tempDir = TempDir.createSync(prefix);
		originalConfigDir = process.env.PI_CONFIG_DIR;
		for (const key of XDG_KEYS) {
			originalXdg[key] = process.env[key];
			delete process.env[key];
		}
		const configDir = path.relative(os.homedir(), tempDir.join("config"));
		process.env.PI_CONFIG_DIR = configDir;
		setAgentDir(path.join(os.homedir(), configDir, "agent"));
	});

	afterEach(() => {
		closeDb();
		// Bun defers sqlite3_close on Windows until unreferenced prepared
		// statements are garbage-collected (oven-sh/bun#25964), which keeps the
		// .db file locked and makes the TempDir removal below fail with EBUSY.
		// closeDb() already forces a GC, but tests that closed the singleton
		// mid-test (or opened their own `new Database(...)` handles) leave dead
		// statements behind too, so sweep again before removing the temp dir.
		Bun.gc(true);
		// A sync that parsed sessions can leave stats.db's WAL/-shm files in a
		// transient (~1s) Windows delete-pending state even after the connection
		// is closed. Opening and closing one fresh connection checkpoints the
		// WAL and releases those handles, so the TempDir removal below succeeds.
		const statsDbPath = getStatsDbPath();
		if (fs.existsSync(statsDbPath)) {
			try {
				const flush = new Database(statsDbPath);
				flush.run("PRAGMA wal_checkpoint(TRUNCATE)");
				flush.close();
			} catch {
				// The DB may be mid-write from a leaked handle; the removal below surfaces it.
			}
			for (const suffix of ["-wal", "-shm"]) {
				try {
					fs.rmSync(statsDbPath + suffix, { force: true });
				} catch {
					// still transiently locked; removeSyncWithRetries covers the tail
				}
			}
		}
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		for (const key of XDG_KEYS) {
			const prior = originalXdg[key];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		}
		setAgentDir(originalAgentDir);
		// The serial cost-backfill path can leave a bun:sqlite statement
		// referenced past every GC sweep (oven-sh/bun#25964), locking the temp
		// dir on Windows past the removal retry window. Swallow the failure —
		// the OS temp reaper cleans it up. A single shot (no 2 s retry window)
		// keeps the teardown hook under its 5 s limit under parallel-suite load.
		try {
			fs.rmSync(tempDir.path(), { recursive: true, force: true });
		} catch {
			// leave for the OS temp reaper
		}
		tempDir = null;
	});

	return {
		current() {
			return tempDir;
		},
	};
}
