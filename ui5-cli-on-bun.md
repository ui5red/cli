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

## Cross-repo picture

This fork provides the CLI integration.
The sibling Bun fork provides the runtime support that made the final HTTP/2 path actually interoperable:

- `process.binding("stream_wrap")` compatibility
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
