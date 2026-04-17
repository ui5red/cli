/**
 * Bun-native HTTP server adapter for the UI5 CLI.
 *
 * Eliminates the Express dependency entirely by providing two server modes:
 *
 * **HTTP/1 (Bun.serve()):**
 * Uses Bun.serve() as the HTTP listener and converts between Bun's Web API
 * Request/Response and the Node.js-style req/res objects that the middleware
 * chain expects. BunNativeResponse extends Writable so stream.pipe(res) works.
 *
 * **HTTP/2 (node:http2.createSecureServer()):**
 * Uses Bun's node:http2 implementation with {allowHTTP1: true} so both H2
 * and H1 clients are supported. The router middleware chain receives native
 * Http2ServerRequest/Http2ServerResponse objects which already implement the
 * full Node.js HTTP API — no wrapper needed.
 *
 * Key design decisions:
 * - Uses the standalone "router" package (same one Express uses internally)
 *   for middleware dispatch, so app.use() works identically.
 * - Streaming responses (H1 path) use a ReadableStream controller so
 *   stream.pipe(res) works for serveResources.js.
 * - Simple responses (end(body) with no prior write()) bypass streaming.
 * - Express is NOT loaded at all. Both H1 and H2 are handled natively.
 */
import {Buffer} from "node:buffer";
import {EventEmitter} from "node:events";
import {STATUS_CODES} from "node:http";
import Router from "router";
import {Readable, Writable} from "node:stream";

const kNoBodyStatusCodes = new Set([204, 205, 304]);
const RESPONSE_TIMEOUT_MS = 30_000;
const createRouter = Router;

function appendHeader(headers, name, value) {
	if (Array.isArray(value)) {
		for (const item of value) {
			headers.append(name, String(item));
		}
		return;
	}
	headers.append(name, String(value));
}

function createSocket(requestUrl, clientIP) {
	const socket = new EventEmitter();
	const url = new URL(requestUrl);
	const isTls = url.protocol === "https:";

	Object.assign(socket, {
		encrypted: isTls,
		destroyed: false,
		localAddress: url.hostname,
		localPort: url.port ? Number(url.port) : (isTls ? 443 : 80),
		// Use the real client IP from Bun.serve()'s server.requestIP() when
		// available, falling back to 127.0.0.1 for localhost/unknown cases.
		remoteAddress: clientIP?.address || "127.0.0.1",
		remotePort: clientIP?.port || undefined,
		setTimeout() {
			return socket;
		},
		destroy(error) {
			socket.destroyed = true;
			if (error) {
				socket.emit("error", error);
			}
			socket.emit("close");
		},
	});

	return socket;
}

function createRequestHeaders(headers) {
	const normalizedHeaders = Object.create(null);
	const rawHeaders = [];

	for (const [name, value] of headers) {
		rawHeaders.push(name, value);
		const normalizedName = name.toLowerCase();
		if (normalizedHeaders[normalizedName] === undefined) {
			normalizedHeaders[normalizedName] = value;
		} else if (Array.isArray(normalizedHeaders[normalizedName])) {
			normalizedHeaders[normalizedName].push(value);
		} else {
			normalizedHeaders[normalizedName] = [normalizedHeaders[normalizedName], value];
		}
	}

	return {normalizedHeaders, rawHeaders};
}

function createNodeRequest(request, clientIP) {
	const url = new URL(request.url);
	const socket = createSocket(request.url, clientIP);
	const stream = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
	const {normalizedHeaders, rawHeaders} = createRequestHeaders(request.headers);
	const query = Object.fromEntries(url.searchParams.entries());

	Object.assign(stream, {
		method: request.method,
		url: `${url.pathname}${url.search}`,
		originalUrl: `${url.pathname}${url.search}`,
		headers: normalizedHeaders,
		rawHeaders,
		httpVersion: "1.1",
		httpVersionMajor: 1,
		httpVersionMinor: 1,
		socket,
		connection: socket,
		secure: socket.encrypted,
		protocol: url.protocol.slice(0, -1),
		host: normalizedHeaders.host ?? url.host,
		hostname: url.hostname,
		path: url.pathname,
		query,
		get(name) {
			return normalizedHeaders[name.toLowerCase()];
		},
		header(name) {
			return normalizedHeaders[name.toLowerCase()];
		},
	});

	return stream;
}

/**
 * Node.js-compatible HTTP response backed by Bun's Web API Response.
 *
 * Extends Writable so that stream.pipe(res) works (used by serveResources.js
 * for streaming file content). Two code paths:
 *
 * 1. **Streaming** — When _write() is called (e.g. via stream.pipe(res)),
 *    a ReadableStream is created on the first chunk and the Response is
 *    resolved immediately with that streaming body. Subsequent chunks are
 *    enqueued to the controller. _final() closes the stream.
 *
 * 2. **Simple** — When end(body) is called without prior write() calls
 *    (the common case for 304, JSON, error pages), the body is passed
 *    directly to new Response() with no streaming overhead.
 */
class BunNativeResponse extends Writable {
	constructor({method}) {
		super();
		this.method = method;
		this.statusCode = 200;
		this.statusMessage = STATUS_CODES[this.statusCode];
		this.headersSent = false;
		this.req = undefined;
		this.locals = Object.create(null);
		this.socket = undefined;
		this.connection = undefined;
		this._headers = new Map();
		this._streamController = null;
		this._resolveResponse = null;
		this._responseResolved = false;
		this._responsePromise = new Promise((resolve) => {
			this._resolveResponse = resolve;
		});
	}

	_resolveWith(body) {
		if (this._responseResolved) {
			return;
		}
		this._responseResolved = true;
		this._resolveResponse(this._buildResponse(body));
	}

	_write(chunk, encoding, callback) {
		this.headersSent = true;
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);

		if (!this._streamController) {
			// First write: create a ReadableStream and resolve the response
			// immediately so Bun can start streaming to the client.
			const self = this;
			const body = new ReadableStream({
				start(controller) {
					self._streamController = controller;
					controller.enqueue(new Uint8Array(buf));
				},
			});
			this._resolveWith(body);
		} else {
			this._streamController.enqueue(new Uint8Array(buf));
		}
		callback();
	}

	_final(callback) {
		if (this._streamController) {
			// Close the streaming body
			this._streamController.close();
			this._streamController = null;
		} else if (!this._responseResolved) {
			// end() called without any write() — resolve with an empty body
			this._resolveWith(null);
		}
		callback();
	}

	/**
	 * Override end() to handle the common case where middleware calls
	 * res.end(body) directly without prior write() calls. In this case
	 * we skip the streaming path entirely and resolve with a simple body.
	 *
	 * @param {*} [chunk] Data to write before ending
	 * @param {string} [encoding] Character encoding
	 * @param {Function} [callback] Callback for when the stream is finished
	 */
	end(chunk, encoding, callback) {
		if (typeof chunk === "function") {
			callback = chunk;
			chunk = undefined;
			encoding = undefined;
		} else if (typeof encoding === "function") {
			callback = encoding;
			encoding = undefined;
		}

		if (chunk != null && !this._streamController && !this._responseResolved) {
			// Simple response: end(body) with no prior write().
			// Resolve immediately with the body, then let Writable clean up.
			this.headersSent = true;
			const body = typeof chunk === "string" ? chunk :
				Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || "utf8");
			this._resolveWith(body);
			return super.end(callback);
		}

		return super.end(chunk, encoding, callback);
	}

	setHeader(name, value) {
		this._headers.set(name.toLowerCase(), {name, value});
		return this;
	}

	set(name, value) {
		if (typeof name === "object" && name !== null) {
			for (const [headerName, headerValue] of Object.entries(name)) {
				this.setHeader(headerName, headerValue);
			}
			return this;
		}
		return this.setHeader(name, value);
	}

	header(name, value) {
		return this.set(name, value);
	}

	getHeader(name) {
		return this._headers.get(name.toLowerCase())?.value;
	}

	get(name) {
		return this.getHeader(name);
	}

	getHeaders() {
		return Object.fromEntries([...this._headers.values()].map(({name, value}) => [name, value]));
	}

	getHeaderNames() {
		return [...this._headers.values()].map(({name}) => name.toLowerCase());
	}

	hasHeader(name) {
		return this._headers.has(name.toLowerCase());
	}

	removeHeader(name) {
		this._headers.delete(name.toLowerCase());
	}

	writeHead(statusCode, statusMessageOrHeaders, headers) {
		this.statusCode = statusCode;
		this.statusMessage = typeof statusMessageOrHeaders === "string" ?
			statusMessageOrHeaders : STATUS_CODES[statusCode];

		const headerBag = typeof statusMessageOrHeaders === "object" && statusMessageOrHeaders !== null ?
			statusMessageOrHeaders : headers;
		if (headerBag) {
			for (const [name, value] of Object.entries(headerBag)) {
				this.setHeader(name, value);
			}
		}

		this.headersSent = true;
		return this;
	}

	flushHeaders() {
		this.headersSent = true;
	}

	status(code) {
		this.statusCode = code;
		this.statusMessage = STATUS_CODES[code];
		return this;
	}

	json(body) {
		if (!this.hasHeader("Content-Type")) {
			this.setHeader("Content-Type", "application/json; charset=utf-8");
		}
		this.end(JSON.stringify(body));
		return this;
	}

	send(body) {
		if (body === undefined || body === null) {
			this.end();
			return this;
		}

		if (typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
			return this.json(body);
		}

		this.end(body);
		return this;
	}

	_buildResponse(body) {
		const headers = new Headers();
		for (const {name, value} of this._headers.values()) {
			appendHeader(headers, name, value);
		}

		const finalBody = this.method === "HEAD" || kNoBodyStatusCodes.has(this.statusCode) ?
			undefined : body;

		return new Response(finalBody, {
			status: this.statusCode,
			statusText: this.statusMessage,
			headers,
		});
	}

	get responsePromise() {
		return this._responsePromise;
	}
}

class BunNativeServer extends EventEmitter {
	constructor({app, host, port}) {
		super();
		this._app = app;
		this._server = undefined;
		this._host = host;
		this._port = port;
		this.listening = false;

		queueMicrotask(() => {
			try {
				this._server = globalThis.Bun.serve({
					hostname: host,
					port,
					// Pass the server instance to the fetch handler so
					// BunNativeApp.handle() can call server.requestIP(request)
					// for accurate remoteAddress on the socket emulation.
					fetch: (request, server) => this._app.handle(request, server),
				});
				this._port = this._server.port;
				this.listening = true;
				this.emit("listening");
			} catch (error) {
				this.emit("error", error);
			}
		});
	}

	address() {
		return {
			address: this._host ?? "0.0.0.0",
			family: "IPv4",
			port: this._port,
		};
	}

	close(callback) {
		const done = (error) => {
			if (callback) {
				callback(error);
			}
			if (error) {
				this.emit("error", error);
				return;
			}
			this.listening = false;
			this.emit("close");
		};

		if (!this._server) {
			queueMicrotask(() => done());
			return this;
		}

		Promise.resolve(this._server.stop()).then(() => {
			done();
		}, done);
		return this;
	}

	ref() {
		return this;
	}

	unref() {
		return this;
	}
}

/**
 * HTTP/2 server backed by node:http2.createSecureServer().
 *
 * The H2 server uses {allowHTTP1: true} so it handles both HTTP/2 and HTTP/1.1
 * clients over TLS. The router middleware chain receives native
 * Http2ServerRequest/Http2ServerResponse objects which already implement the
 * full Node.js HTTP API that the middleware expects (setHeader, writeHead,
 * stream.pipe(res), etc.). No wrapper conversion is needed.
 */
class BunNativeH2Server extends EventEmitter {
	constructor({app, host, port, key, cert}) {
		super();
		this._app = app;
		this._server = undefined;
		this._host = host;
		this._port = port;
		this.listening = false;

		this._init(host, port, key, cert).catch((error) => {
			this.emit("error", error);
		});
	}

	async _init(host, port, key, cert) {
		const {createSecureServer} = await import("node:http2");

		// Route incoming requests through the router middleware chain.
		// Http2ServerRequest and Http2ServerResponse already implement the
		// Node.js HTTP req/res API, so the middleware chain works directly.
		const requestHandler = (req, res) => {
			this._app._router(req, res, (error) => {
				if (error) {
					if (!res.headersSent) {
						res.writeHead(error.statusCode || error.status || 500, {
							"Content-Type": "text/plain; charset=utf-8",
						});
					}
					res.end(error.message || "Internal Server Error");
					return;
				}

				if (!res.writableEnded) {
					res.writeHead(404, {
						"Content-Type": "text/plain; charset=utf-8",
					});
					res.end(`Cannot ${req.method} ${req.url}`);
				}
			});
		};

		this._server = createSecureServer(
			{allowHTTP1: true, cert, key},
			requestHandler
		);

		const listenOptions = {port};
		if (host) {
			listenOptions.host = host;
		}

		this._server.listen(listenOptions, () => {
			const addr = this._server.address();
			this._port = addr.port;
			this.listening = true;
			this.emit("listening");
		});

		this._server.on("error", (error) => {
			this.emit("error", error);
		});
	}

	address() {
		if (this._server) {
			return this._server.address();
		}
		return {
			address: this._host ?? "0.0.0.0",
			family: "IPv4",
			port: this._port,
		};
	}

	close(callback) {
		if (!this._server) {
			if (callback) {
				queueMicrotask(() => callback());
			}
			return this;
		}

		this._server.close(() => {
			this.listening = false;
			this.emit("close");
			if (callback) {
				callback();
			}
		});
		return this;
	}

	ref() {
		return this;
	}

	unref() {
		return this;
	}
}

class BunNativeApp {
	constructor() {
		this._router = createRouter();
	}

	use(...args) {
		this._router.use(...args);
		return this;
	}

	/**
	 * Start an HTTP/1 server using Bun.serve().
	 *
	 * @param {object} options Server options
	 * @param {Function} [callback] Callback for when server is listening
	 */
	listen(options, callback) {
		const server = new BunNativeServer({
			app: this,
			host: options.host,
			port: options.port,
		});

		if (callback) {
			server.once("listening", callback);
		}

		return server;
	}

	/**
	 * Start an HTTP/2 + HTTP/1.1 server using node:http2.createSecureServer().
	 * Both H2 and H1 clients are supported over TLS via ALPN negotiation.
	 *
	 * @param {object} options Server options
	 * @param {Function} [callback] Callback for when server is listening
	 */
	listenH2(options, callback) {
		const server = new BunNativeH2Server({
			app: this,
			host: options.host,
			port: options.port,
			key: options.key,
			cert: options.cert,
		});

		if (callback) {
			server.once("listening", callback);
		}

		return server;
	}

	async handle(request, server) {
		const clientIP = server?.requestIP?.(request);
		const req = createNodeRequest(request, clientIP);
		const res = new BunNativeResponse({method: req.method});
		req.res = res;
		res.req = req;
		res.socket = req.socket;
		res.connection = req.connection;

		// Safety timeout: if the middleware chain hangs (e.g. a middleware
		// never calls next() and never ends the response), resolve with
		// a 504 after RESPONSE_TIMEOUT_MS to avoid blocking Bun.serve().
		const timeoutId = setTimeout(() => {
			if (!res._responseResolved) {
				res.writeHead(504, {"Content-Type": "text/plain; charset=utf-8"});
				res.end("Gateway Timeout");
			}
		}, RESPONSE_TIMEOUT_MS);

		this._router(req, res, (error) => {
			if (error) {
				if (!res.headersSent) {
					res.writeHead(error.statusCode || error.status || 500, {
						"Content-Type": "text/plain; charset=utf-8",
					});
				}
				res.end(error.message || "Internal Server Error");
				return;
			}

			if (!res.writableEnded) {
				res.writeHead(404, {
					"Content-Type": "text/plain; charset=utf-8",
				});
				res.end(`Cannot ${req.method} ${req.originalUrl}`);
			}
		});

		try {
			return await res.responsePromise;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

export default function createBunNativeApp() {
	return new BunNativeApp();
}
