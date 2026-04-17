# Bun.build() Assessment for UI5 CLI

This document records the investigation into whether Bun's native bundler (`Bun.build()`) could contribute to or replace parts of the UI5 CLI build pipeline.

## Summary

**Bun.build() cannot replace the UI5 builder's bundling pipeline.** The module system mismatch is fundamental: UI5 uses custom AMD semantics (`sap.ui.define`/`sap.ui.require.preload`) while Bun only produces ESM, CJS, or IIFE output. However, Bun.build() may be relevant for future ESM-native UI5 applications.

## Detailed Findings

### 1. UI5 Bundle Format Is Incompatible

UI5 preload bundles use a multi-section format with distinct embedding modes:

```javascript
// Preload mode — wraps modules as string entries
sap.ui.require.preload({
  "sap/ui/core/Core.js": function() { /* module code */ },
  "my/app/Component.js": function() { /* module code */ },
  "my/app/view/Main.view.xml": '<mvc:View .../>',  // Non-JS resource as string
}, "my/app/Component-preload");

// Raw mode — embeds module code directly (no wrapping)
// Used for bootstrap modules that must execute immediately

// Provided mode — marks modules as "already loaded" (not included)

// BundleInfo mode — emits metadata for the ui5loader
```

Bun.build() produces standard module formats (ESM, CJS, IIFE) and has no mechanism to generate these UI5-specific wrappers at the bundle level.

### 2. Non-JS Resource Embedding

UI5 preload bundles embed XML views, `.properties` files, JSON manifests, and other non-JS resources as string data within the `sap.ui.require.preload()` call. The LBT resolver at `packages/builder/lib/lbt/bundle/Resolver.js` determines which resources to include based on filter patterns and dependency analysis.

Bun.build() can only bundle JS/TS/CSS/JSON files and treats them as importable modules, not as string data to embed in a custom format.

### 3. Dependency Resolution Mismatch

UI5's dependency resolver operates on AMD-style `sap.ui.define()` declarations:

```javascript
sap.ui.define([
  "sap/ui/core/Control",
  "sap/ui/model/json/JSONModel"
], function(Control, JSONModel) { ... });
```

The resolver at `packages/builder/lib/lbt/analyzer/analyzeModuleAST.js` parses these declarations to build the module dependency graph. Bun's resolver only understands ESM `import`/`export` and CJS `require()`.

### 4. Section-Based Bundle Architecture

The bundle builder at `packages/builder/lib/lbt/bundle/Builder.js` generates output with multiple sections that have different semantics:

| Section Mode | Purpose | Bun Equivalent |
|---|---|---|
| `raw` | Direct code embedding with topological sort | None — Bun produces a single module graph |
| `preload` | Wrapped modules in `sap.ui.require.preload()` | None — no custom wrapper support |
| `provided` | Marks modules as "already loaded" | None — Bun always resolves imports |
| `require` | Generates `sap.ui.require()` boot calls | None — Bun uses `import()` |
| `bundleInfo` | Metadata for ui5loader optimization | None |

### 5. Debug Variant Management

UI5 maintains paired outputs:
- `Component.js` (minified) + `Component.js.map`
- `Component-dbg.js` (debug, unminified) + `Component-dbg.js.map`

Bun.build() produces a single output per entry point and doesn't have a concept of debug/production variant pairs with coordinated source maps.

## What Bun.build() Could Do (Future Directions)

### TypeScript Transpilation

Bun.build() with `--no-bundle` (transpile-only mode) is extremely fast for TypeScript. However, the UI5 builder doesn't have a dedicated TypeScript transpilation task — TypeScript is handled by each project's own toolchain (typically `tsc` or `@babel/preset-typescript`) before the UI5 builder processes the output.

If UI5 ever adds a first-party TypeScript transpilation task, Bun's transpiler would be a strong candidate for the Bun runtime path.

### Bun.build() Plugin for sap.ui.define Wrapping

Bun's plugin API allows custom loaders and module resolution. A plugin could theoretically:

```javascript
const ui5Plugin = {
  name: "ui5-define-wrapper",
  setup(build) {
    build.onLoad({ filter: /\.js$/ }, async (args) => {
      const contents = await Bun.file(args.path).text();
      return {
        contents: `sap.ui.define("${moduleName}", [], function() {\n${contents}\n});`,
        loader: "js",
      };
    });
  },
};
```

This works for individual module wrapping but **cannot produce the multi-section preload bundle structure** that UI5 expects. The orchestration of which resources to include, how to filter them, and how to combine them into sections is controlled by the LBT resolver, not the bundler.

### ESM-Native UI5 Applications

If UI5 migrates to ESM internally (a separate long-term effort being explored by the UI5 team), Bun.build() could handle bundling natively:

```javascript
await Bun.build({
  entrypoints: ["./webapp/Component.js"],  // ESM entry point
  outdir: "./dist",
  target: "browser",
  splitting: true,   // Code splitting for lazy-loaded routes
  minify: true,
});
```

This would produce standard ESM bundles that a modern UI5 loader could consume. However, this requires fundamental changes to how UI5 applications are structured and loaded.

### Existing Spike

The self-contained bundler spike at `ui5-cli-on-bun/examples/self-contained-bundler-spike/` already demonstrates this boundary. It shows that Bun.build() handles a dedicated HTML+ESM app naturally, while the UI5 self-contained bundler uses preload semantics that don't map to standard bundling.

## Conclusion

Bun.build() is not a viable replacement for any part of the current UI5 builder pipeline. The UI5 module system is too deeply AMD-based and relies on custom bundle formats that no standard bundler can produce. The path forward for Bun.build() integration is contingent on UI5's broader migration toward ESM — a separate, multi-year effort.

For this experiment, the build pipeline continues to use the existing UI5 builder tasks running on Bun via the Node.js compatibility layer, which already works correctly and shows competitive performance.
