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