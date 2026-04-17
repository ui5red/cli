import {fileURLToPath} from "node:url";
import os from "node:os";
import workerpool from "workerpool";
import {getLogger} from "@ui5/logger";
import {setTimeout as setTimeoutPromise} from "node:timers/promises";

const log = getLogger("builder:utils:workerpool");

const MIN_WORKERS = 2;
const MAX_WORKERS = 4;

/**
 * Calculates the number of workers based on available CPU cores.
 *
 * @returns {number} Number of workers to use (between MIN_WORKERS and MAX_WORKERS)
 */
function getMaxWorkers() {
	const osCpus = os.cpus().length || 1;
	return Math.max(Math.min(osCpus - 1, MAX_WORKERS), MIN_WORKERS);
}

/**
 * Creates a managed workerpool instance with Bun-compatible configuration
 * and automatic cleanup registration.
 *
 * Handles:
 * - Worker count calculation (2–4 workers based on CPU cores)
 * - Bun-specific workerType ("thread" vs "auto") since Bun's child_process.fork()
 *   does not reliably support the workerpool protocol
 * - Bun-specific force-termination during cleanup, since Bun's worker_threads
 *   does not always surface correct idle/total worker stats for graceful shutdown
 *
 * @param {object} options
 * @param {URL} options.workerUrl URL of the worker script (typically `new URL("./worker.js", import.meta.url)`)
 * @param {object} options.taskUtil TaskUtil instance for cleanup registration
 * @returns {workerpool.Pool} The workerpool instance
 */
export function createPool({workerUrl, taskUtil}) {
	const maxWorkers = getMaxWorkers();
	const osCpus = os.cpus().length || 1;

	log.verbose(`Creating workerpool with up to ${maxWorkers} workers (available CPU cores: ${osCpus})`);
	const workerPath = fileURLToPath(workerUrl);
	const pool = workerpool.pool(workerPath, {
		// Bun requires "thread" workerType because workerpool's "auto" mode uses
		// child_process.fork() which does not reliably support the workerpool
		// protocol on Bun. The "thread" mode uses worker_threads which Bun supports.
		workerType: process.versions.bun ? "thread" : "auto",
		maxWorkers
	});

	taskUtil.registerCleanupTask((force) => {
		return terminatePool(pool, force);
	});

	return pool;
}

/**
 * Gracefully terminates a workerpool, with Bun-specific force-termination.
 *
 * @param {workerpool.Pool} pool The pool to terminate
 * @param {boolean} force Whether to force-terminate immediately
 * @returns {Promise<void>}
 */
async function terminatePool(pool, force) {
	log.verbose(`Attempt to terminate the workerpool...`);

	if (!pool) {
		return;
	}

	if (process.versions.bun) {
		// On Bun, workerpool's graceful shutdown can hang because Bun's
		// worker_threads does not always surface correct idle/total stats.
		// Force-terminate to avoid blocking. Safe because all task results
		// have been collected before cleanup runs.
		return pool.terminate(true);
	}

	// For Node.js: wait for idle workers before terminating
	let {idleWorkers, totalWorkers} = pool.stats();
	while (idleWorkers !== totalWorkers && !force) {
		await setTimeoutPromise(100);
		({idleWorkers, totalWorkers} = pool.stats());
	}

	return pool.terminate(force);
}
