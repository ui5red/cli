/**
 * Bun-specific JSDoc runner.
 *
 * JSDoc's internal modules use require() calls with paths relative to JSDoc's
 * own installation root (e.g., require("jsdoc/lib/jsdoc/env")). Node.js resolves
 * these through its standard CJS module resolution algorithm, which searches
 * node_modules directories up the tree. Bun's CJS resolver handles these paths
 * differently and fails to locate JSDoc's internal modules.
 *
 * This runner monkey-patches Module._resolveFilename to intercept require()
 * calls starting with "jsdoc/" and resolve them against the known JSDoc
 * installation directory (passed as process.argv[2]). This makes JSDoc's
 * internal require() calls work identically under both Node.js and Bun.
 *
 * See jsdocGenerator.js for the call site that spawns this runner.
 */
const path = require("node:path");
const Module = require("node:module");

const jsdocPath = process.argv[2];

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
	if (request.startsWith("jsdoc/")) {
		if (request.startsWith("jsdoc/lib/")) {
			request = path.join(jsdocPath, request.slice("jsdoc/".length)) + ".js";
		} else {
			request = path.join(jsdocPath, "lib", request) + ".js";
		}
	}
	return originalResolveFilename.call(this, request, parent, ...rest);
};

const env = require(path.join(jsdocPath, "lib", "jsdoc", "env.js"));
global.env = env;
env.dirname = jsdocPath;
env.pwd = process.cwd();
env.args = process.argv.slice(3);

global.app = require(path.join(jsdocPath, "lib", "jsdoc", "app.js"));

const cli = require(path.join(jsdocPath, "cli.js"));

function onFinish(errorCode) {
	cli.logFinish();
	cli.exit(errorCode || 0);
}

cli.setVersionInfo().loadConfig();

if (!env.opts.test) {
	cli.configureLogger();
}

cli.logStart();
cli.runCommand(onFinish);
