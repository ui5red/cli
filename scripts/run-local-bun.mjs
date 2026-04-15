import {spawn} from "node:child_process";
import {access} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(import.meta.dirname, "..");
const bunRepoDir = path.resolve(rootDir, "..", "bun");

const candidateBinaries = [
	process.env.BUN_FORK_BINARY,
	path.join(bunRepoDir, "build", "debug", "bun-debug"),
	path.join(bunRepoDir, "build", "release", "bun"),
	path.join(bunRepoDir, "build", "release-local", "bun"),
	path.join(bunRepoDir, "build", "debug-local", "bun-debug")
].filter(Boolean);

async function findBinary() {
	for (const candidate of candidateBinaries) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			continue;
		}
	}

	throw new Error(
		"No local Bun binary found. Build the sibling Bun fork first with `npm run bun:build:fork`, " +
		"or set BUN_FORK_BINARY to an explicit executable path."
	);
}

const binaryPath = await findBinary();
const args = process.argv.slice(2);

const child = spawn(binaryPath, args, {
	stdio: "inherit",
	cwd: process.cwd(),
	env: process.env,
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});

child.on("error", (error) => {
	console.error(error.message);
	process.exit(1);
});