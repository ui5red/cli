import {Buffer} from "node:buffer";
import {EventEmitter} from "node:events";
import {STATUS_CODES} from "node:http";
import Router from "router";
import {Readable, Writable} from "node:stream";

const kNoBodyStatusCodes = new Set([204, 205, 304]);
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

function createSocket(requestUrl) {
	const socket = new EventEmitter();
	const url = new URL(requestUrl);
	const isTls = url.protocol === "https:";

	Object.assign(socket, {
		encrypted: isTls,
		destroyed: false,
		localAddress: url.hostname,
		localPort: url.port ? Number(url.port) : (isTls ? 443 : 80),
		remoteAddress: url.hostname,
		remotePort: url.port ? Number(url.port) : undefined,
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

function createNodeRequest(request) {
	const url = new URL(request.url);
	const socket = createSocket(request.url);
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
		this._bodyChunks = [];
		this._responsePromise = new Promise((resolve) => {
			this.once("finish", () => resolve(this.toResponse()));
		});
	}

	_write(chunk, encoding, callback) {
		this.headersSent = true;
		this._bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
		callback();
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

	toResponse() {
		const headers = new Headers();
		for (const {name, value} of this._headers.values()) {
			appendHeader(headers, name, value);
		}

		const body = this.method === "HEAD" || kNoBodyStatusCodes.has(this.statusCode) ?
			undefined : Buffer.concat(this._bodyChunks);

		return new Response(body, {
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
					fetch: (request) => this._app.handle(request),
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

class BunNativeApp {
	constructor() {
		this._router = createRouter();
	}

	use(...args) {
		this._router.use(...args);
		return this;
	}

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

	async handle(request) {
		const req = createNodeRequest(request);
		const res = new BunNativeResponse({method: req.method});
		req.res = res;
		res.req = req;
		res.socket = req.socket;
		res.connection = req.connection;

		return await new Promise((resolve) => {
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

			res.responsePromise.then(resolve);
		});
	}
}

export default function createBunNativeApp() {
	return new BunNativeApp();
}
