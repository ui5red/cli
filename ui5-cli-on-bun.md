# UI5 CLI on Bun

This fork contains the UI5 CLI-side changes needed to run the CLI against the sibling Bun fork and to keep the main build and server paths working there.

Sibling repo references:

- Bun fork: <https://github.com/ui5red/bun>
- Validation app: <https://github.com/ui5red/ui5-cli-on-bun>
- Local sibling checkouts used during development: `../bun` and `../ui5-cli-on-bun`

## What changed in this UI5 CLI fork

### 1. Builder JSDoc execution under Bun

Files:

- `packages/builder/lib/processors/jsdoc/jsdocGenerator.js`
- `packages/builder/lib/processors/jsdoc/bunJsdocRunner.cjs`
- `packages/builder/test/lib/processors/jsdoc/jsdocGenerator.js`

JSDoc's CLI expects a Node/CommonJS execution model that does not map cleanly to Bun when launched the same way.

This fork adds a Bun-specific runner that:

- resolves JSDoc's internal CommonJS modules from the installed package directory
- bootstraps `env` and `app` the way JSDoc expects
- preserves the existing Node path for non-Bun runtimes

The builder test coverage was updated so the invocation contract stays explicit.

### 2. Server-side HTTP/2 support on Bun

Files:

- `packages/server/lib/server.js`
- `packages/server/lib/http2Support.js`
- `packages/server/test/lib/server/http2Support.js`

This fork adds a Bun-specific HTTP/2 server path for `ui5 serve --h2`.

On Bun:

- the server uses `node:http2.createSecureServer({ allowHTTP1: true, cert, key }, app)`
- Express request/response prototypes are adapted so the app can run on Bun's `Http2ServerRequest` / `Http2ServerResponse`
- the Bun runtime is treated as supported even where newer Node versions are blocked because of the old `spdy` limitation

On non-Bun runtimes, the existing `spdy` path remains intact.

### 3. Worker pool behaviour on Bun

Files:

- `packages/builder/lib/processors/minifier.js`
- `packages/builder/lib/tasks/minify.js`
- `packages/builder/lib/tasks/buildThemes.js`

workerpool's `auto` mode uses `child_process.fork()` which Bun does not support reliably. This fork forces `workerType: "thread"` (worker_threads) on Bun.

Worker-based theme building (`buildThemes`) is enabled on Bun. The theme builder uses `MessageChannel`/`MessagePort` for cross-thread filesystem communication, and Bun's worker_threads supports this.

The minifier worker pool is disabled on Bun as a conservative choice — workerpool's graceful shutdown can hang because Bun's worker_threads does not always surface accurate idle/total worker stats. Force-termination logic is added for Bun in both pool cleanup paths.

### 4. Full Express elimination (`experiment/bun-native-full` branch)

Files:

- `packages/server/lib/bun/BunNativeApp.js`
- `packages/server/lib/server.js`

This branch eliminates Express entirely on Bun for **both** HTTP/1 and HTTP/2 serve paths:

**HTTP/1 (Bun.serve()):**
- `BunNativeApp` converts between Bun's Web API Request/Response and Node.js-style req/res objects for the middleware chain
- Streaming responses use a ReadableStream controller so `stream.pipe(res)` works for `serveResources.js`
- Real client IP via `server.requestIP(request)` instead of faking from URL hostname

**HTTP/2 (node:http2.createSecureServer()):**
- `BunNativeH2Server` uses Bun's node:http2 implementation with `{allowHTTP1: true}` so both H2 and H1 clients are supported over TLS
- The router middleware chain receives native `Http2ServerRequest`/`Http2ServerResponse` objects which already implement the full Node.js HTTP API — no Express prototype manipulation needed
- ALPN negotiation (h2/http/1.1) is handled natively by Bun's TLS layer

**Key architecture:**
- Uses the standalone `router` package (same one Express uses internally) for middleware dispatch, so `app.use()` works identically
- Express is **never loaded** on Bun — neither for HTTP/1 nor HTTP/2
- On non-Bun runtimes, the existing Express + spdy path remains intact

See `bun-build-assessment.md` in this repo for the Bun.build() investigation findings.

## Branch strategy

- `main` — stable: Express for all serve modes, workers enabled for theme builds
- `experiment/bun-native-serve` — preserves original BunNativeApp usage (pre-improvements)
- `experiment/bun-native-full` — Express-free on Bun: Bun.serve() for HTTP/1, node:http2 for HTTP/2, Bun.build() assessment

## Cross-repo picture

This fork provides the CLI integration.
The sibling Bun fork provides the runtime support that made the final HTTP/2 path actually interoperable:

- `process.binding("stream_wrap")` compatibility (Uint8Array for streamBaseState)
- Node HTTP/HTTPS/TLS compatibility improvements
- the native HTTP/2 SETTINGS serialization fix that unblocked external clients

See the sibling repo documentation for the runtime-side details:

- <https://github.com/ui5red/bun/blob/main/ui5-cli-on-bun.md>

The standalone validation app provides the user-facing setup and test flow:

- <https://github.com/ui5red/ui5-cli-on-bun>

## End-to-end validation performed

Validation covered both direct CLI flows and extension hooks:

- `ui5 serve --h2` served a real fixture app over TLS/HTTP2 using the sibling Bun binary
- an external Node HTTP/2 client successfully fetched `/index.html` from that server
- a custom middleware validation app successfully added `x-bun-validation-middleware: active` over HTTP/2
- a custom task validation app successfully emitted `custom-task-marker.txt` during `ui5 build`
- `ui5 serve` (non-H2) served resources via BunNativeApp (Bun.serve()) on the `experiment/bun-native-full` branch
- `ui5 serve --h2` served a real fixture app over TLS/HTTP2 via BunNativeApp (node:http2) on the `experiment/bun-native-full` branch — Express fully eliminated
- All 5 smoke tests and the full 38-fixture suite pass on both `main` and `experiment/bun-native-full`

Those validation steps now live in the standalone validation app rather than in this fork.

## Recommended test flow

Use the standalone validation app as the entry point for setup and testing:

```sh
git clone https://github.com/ui5red/ui5-cli-on-bun.git
cd ui5-cli-on-bun
npm install
npm run setup:forks
npm run bun:build:fork
npm run smoke
```

That flow clones the sibling Bun and UI5 CLI forks automatically, prepares their dependencies, builds the custom Bun binary, and runs the end-to-end validation from one repository.

## Current state

With the sibling Bun fork at the matching patch level, this fork can run the relevant UI5 CLI build and server flows on Bun, including the HTTP/2 serve path that originally required deeper runtime work.

The `experiment/bun-native-full` branch demonstrates that Bun.serve() can replace Express for HTTP/1 serving with full middleware compatibility. HTTP/2 still requires Express because Bun.serve() does not support HTTP/2 at the fetch handler level.
