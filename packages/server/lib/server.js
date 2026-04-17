import portscanner from "portscanner";
import MiddlewareManager from "./middleware/MiddlewareManager.js";
import {createReaderCollection} from "@ui5/fs/resourceFactory";
import ReaderCollectionPrioritized from "@ui5/fs/ReaderCollectionPrioritized";
import {getLogger} from "@ui5/logger";
import {getUnsupportedHttp2Message} from "./http2Support.js";

const log = getLogger("server");

// Lazy-loaded: Express is only imported on non-Bun runtimes.
// On Bun, BunNativeApp handles both HTTP/1 and HTTP/2, so Express is never loaded.
let _express;
async function _getExpress() {
	if (!_express) {
		_express = (await import("express")).default;
	}
	return _express;
}

function _addRuntimeHeader(app, runtime = process.versions.bun ? "bun" : "node") {
	app.use(function runtimeHeader(req, res, next) {
		res.setHeader("X-UI5-Runtime", runtime);
		next();
	});
}
/**
 * @public
 * @module @ui5/server
 */

/**
 * Returns a promise resolving by starting the server.
 *
 * @param {object} app The express application object
 * @param {number} port Desired port to listen to
 * @param {boolean} changePortIfInUse If true and the port is already in use, an unused port is searched
 * @param {boolean} acceptRemoteConnections If true, listens to remote connections and not only to localhost connections
 * @returns {Promise<object>} Returns an object containing server related information like (selected port, protocol)
 * @private
 */
function _listen(app, port, changePortIfInUse, acceptRemoteConnections) {
	return new Promise(function(resolve, reject) {
		const options = {};

		if (!acceptRemoteConnections) {
			// Unless remote connections are allowed, bind to the IPv4 loopback address
			options.host = "127.0.0.1";
		} // If remote connections are allowed, do not set host so the server listens on all supported interfaces

		const portScanHost = options.host || "127.0.0.1";
		let portMax;
		if (changePortIfInUse) {
			portMax = port + 30;
		} else {
			portMax = port;
		}

		portscanner.findAPortNotInUse(port, portMax, portScanHost, function(error, foundPort) {
			if (error) {
				reject(error);
				return;
			}

			if (!foundPort) {
				if (changePortIfInUse) {
					const error = new Error(
						`EADDRINUSE: Could not find available ports between ${port} and ${portMax}.`);
					error.code = "EADDRINUSE";
					error.errno = "EADDRINUSE";
					error.address = portScanHost;
					error.port = portMax;
					reject(error);
					return;
				} else {
					const error = new Error(`EADDRINUSE: Port ${port} is already in use.`);
					error.code = "EADDRINUSE";
					error.errno = "EADDRINUSE";
					error.address = portScanHost;
					error.port = portMax;
					reject(error);
					return;
				}
			}

			options.port = foundPort;
			const server = app.listen(options, function() {
				resolve({port: options.port, server});
			});

			server.on("error", function(err) {
				reject(err);
			});
		});
	});
}

/**
 * Start an HTTP/2 server using BunNativeApp.listenH2().
 *
 * Uses node:http2.createSecureServer({allowHTTP1: true}) under the hood.
 * Only called on Bun — Express is not involved.
 *
 * @param {object} app The BunNativeApp instance
 * @param {number} port Desired port to listen to
 * @param {boolean} changePortIfInUse If true and the port is already in use, an unused port is searched
 * @param {boolean} acceptRemoteConnections If true, listens to remote connections
 * @param {string} key Private key for TLS
 * @param {string} cert Certificate for TLS
 * @returns {Promise<object>} Returns an object containing server and port
 * @private
 */
function _listenH2(app, port, changePortIfInUse, acceptRemoteConnections, key, cert) {
	return new Promise(function(resolve, reject) {
		const options = {key, cert};

		if (!acceptRemoteConnections) {
			options.host = "127.0.0.1";
		}

		const portScanHost = options.host || "127.0.0.1";
		let portMax;
		if (changePortIfInUse) {
			portMax = port + 30;
		} else {
			portMax = port;
		}

		portscanner.findAPortNotInUse(port, portMax, portScanHost, function(error, foundPort) {
			if (error) {
				reject(error);
				return;
			}

			if (!foundPort) {
				if (changePortIfInUse) {
					const portError = new Error(
						`EADDRINUSE: Could not find available ports between ${port} and ${portMax}.`);
					portError.code = "EADDRINUSE";
					portError.errno = "EADDRINUSE";
					portError.address = portScanHost;
					portError.port = portMax;
					reject(portError);
					return;
				} else {
					const portError = new Error(`EADDRINUSE: Port ${port} is already in use.`);
					portError.code = "EADDRINUSE";
					portError.errno = "EADDRINUSE";
					portError.address = portScanHost;
					portError.port = portMax;
					reject(portError);
					return;
				}
			}

			options.port = foundPort;
			const server = app.listenH2(options, function() {
				resolve({port: options.port, server});
			});

			server.on("error", function(err) {
				reject(err);
			});
		});
	});
}

/**
 * Adds SSL support to an express application (Node.js only).
 *
 * On Bun, HTTP/2 is handled by BunNativeApp.listenH2() — this function is not called.
 *
 * @param {object} parameters
 * @param {object} parameters.app The original express application
 * @param {string} parameters.key Path to private key to be used for https
 * @param {string} parameters.cert Path to certificate to be used for for https
 * @returns {Promise<object>} The express application with SSL support
 * @private
 */
async function _addSsl({app, key, cert}) {
	// Using spdy as http2 server as the native http2 implementation
	// from Node v8.4.0 doesn't seem to work with express
	const {default: spdy} = await import("spdy");
	return spdy.createServer({cert, key}, app);
}


/**
 * SAP target CSP middleware options
 *
 * @public
 * @typedef {object} module:@ui5/server.SAPTargetCSPOptions
 * @property {string} [defaultPolicy="sap-target-level-1"]
 * @property {string} [defaultPolicyIsReportOnly=true]
 * @property {string} [defaultPolicy2="sap-target-level-3"]
 * @property {string} [defaultPolicy2IsReportOnly=true]
 * @property {string[]} [ignorePaths=["test-resources/sap/ui/qunit/testrunner.html"]]
 */


/**
 * Start a server for the given project (sub-)tree.
 *
 * @public
 * @param {@ui5/project/graph/ProjectGraph} graph Project graph
 * @param {object} options Options
 * @param {number} options.port Port to listen to
 * @param {boolean} [options.changePortIfInUse=false] If true, change the port if it is already in use
 * @param {boolean} [options.h2=false] Whether HTTP/2 should be used - defaults to <code>http</code>
 * @param {string} [options.key] Path to private key to be used for https
 * @param {string} [options.cert] Path to certificate to be used for for https
 * @param {boolean} [options.simpleIndex=false] Use a simplified view for the server directory listing
 * @param {boolean} [options.acceptRemoteConnections=false] If true, listens to remote connections and
 * 															not only to localhost connections
 * @param {boolean|module:@ui5/server.SAPTargetCSPOptions} [options.sendSAPTargetCSP=false]
 * 										If set to <code>true</code> or an object, then the default (or configured)
 * 										set of security policies that SAP and UI5 aim for (AKA 'target policies'),
 * 										are send for any requested <code>*.html</code> file
 * @param {boolean} [options.serveCSPReports=false] Enable CSP reports serving for request url
 * 										'/.ui5/csp/csp-reports.json'
 * @returns {Promise<object>} Promise resolving once the server is listening.
 * 							It resolves with an object containing the <code>port</code>,
 * 							<code>h2</code>-flag and a <code>close</code> function,
 * 							which can be used to stop the server.
 */
export async function serve(graph, {
	port: requestedPort, changePortIfInUse = false, h2 = false, key, cert,
	acceptRemoteConnections = false, sendSAPTargetCSP = false, simpleIndex = false, serveCSPReports = false
}) {
	const rootProject = graph.getRoot();

	const readers = [];
	await graph.traverseBreadthFirst(async function({project: dep}) {
		if (dep.getName() === rootProject.getName()) {
			// Ignore root project
			return;
		}
		readers.push(dep.getReader({style: "runtime"}));
	});

	const dependencies = createReaderCollection({
		name: `Dependency reader collection for project ${rootProject.getName()}`,
		readers
	});

	const rootReader = rootProject.getReader({style: "runtime"});

	// TODO change to ReaderCollection once duplicates are sorted out
	const combo = new ReaderCollectionPrioritized({
		name: "server - prioritize workspace over dependencies",
		readers: [rootReader, dependencies]
	});
	const resources = {
		rootProject: rootReader,
		dependencies: dependencies,
		all: combo
	};

	const middlewareManager = new MiddlewareManager({
		graph,
		rootProject,
		resources,
		options: {
			sendSAPTargetCSP,
			serveCSPReports,
			simpleIndex
		}
	});

	// On Bun: use BunNativeApp for BOTH HTTP/1 (Bun.serve()) and HTTP/2 (node:http2).
	// Express is NOT loaded at all — the standalone "router" package handles middleware dispatch.
	// On Node: use Express (required for spdy-based HTTP/2 and traditional HTTP/1).
	let app;
	if (process.versions.bun) {
		const {default: createBunNativeApp} = await import("./bun/BunNativeApp.js");
		app = createBunNativeApp();
	} else {
		app = (await _getExpress())();
	}

	_addRuntimeHeader(app);
	await middlewareManager.applyMiddleware(app);

	let port;
	let server;

	if (h2) {
		const unsupportedHttp2Message = getUnsupportedHttp2Message();
		if (unsupportedHttp2Message) {
			log.error(unsupportedHttp2Message);
			process.exit(1);
		}

		if (process.versions.bun) {
			// Bun: BunNativeApp.listenH2() uses node:http2.createSecureServer({allowHTTP1: true}).
			// Http2ServerRequest/Http2ServerResponse implement the full Node.js HTTP API,
			// so the middleware chain works directly — no Express prototype manipulation needed.
			const listenResult = await _listenH2(app, requestedPort, changePortIfInUse,
				acceptRemoteConnections, key, cert);
			port = listenResult.port;
			server = listenResult.server;
		} else {
			app = await _addSsl({app, key, cert});
			const listenResult = await _listen(app, requestedPort, changePortIfInUse,
				acceptRemoteConnections);
			port = listenResult.port;
			server = listenResult.server;
		}
	} else {
		const listenResult = await _listen(app, requestedPort, changePortIfInUse,
			acceptRemoteConnections);
		port = listenResult.port;
		server = listenResult.server;
	}

	return {
		h2,
		port,
		close: function(callback) {
			server.close(callback);
		}
	};
}
