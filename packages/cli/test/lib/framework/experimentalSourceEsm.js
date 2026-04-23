import test from "ava";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import buildExperimentalSourceEsm, {_internal} from "../../../lib/framework/experimentalSourceEsm.js";
import {adaptUi5ExtendClass, createUi5NamespaceFacade, loadUi5Modules} from "../../../lib/framework/experimentalSourceEsmRuntime.js";
import ensureSapUiVersionInfo from "../../../lib/framework/sapUiVersionInfo.js";

async function writeTempFile(baseDir, relativePath, contents = "") {
	const filePath = path.join(baseDir, relativePath);
	await mkdir(path.dirname(filePath), {recursive: true});
	await writeFile(filePath, contents);
	return filePath;
}

test.afterEach.always(async (t) => {
	if (t.context.tmpDir) {
		await rm(t.context.tmpDir, {force: true, recursive: true});
	}
});

test.serial("collectAppModuleSources maps TypeScript modules to JavaScript output paths", async (t) => {
	t.context.tmpDir = await mkdtemp(path.join(os.tmpdir(), "ui5-experimental-source-esm-"));
	const webappRoot = path.join(t.context.tmpDir, "webapp");

	await writeTempFile(webappRoot, "Component.ts", "export default class Component {}\n");
	await writeTempFile(webappRoot, "controller/Main.controller.ts", "export default class Main {}\n");
	await writeTempFile(webappRoot, "model/models.ts", "export default {};\n");
	await writeTempFile(webappRoot, "test/Test.controller.ts", "export default class Test {}\n");
	await writeTempFile(webappRoot, "esm-helpers.js", "export {};\n");

	const moduleSources = await _internal.collectAppModuleSources(
		webappRoot,
		path.join(t.context.tmpDir, "missing-overlay"),
	);

	t.deepEqual([...moduleSources.keys()].sort(), [
		"Component.js",
		"controller/Main.controller.js",
		"model/models.js",
	]);
	t.true(moduleSources.get("Component.js").endsWith("Component.ts"));
});

test.serial("collectAppModuleSources lets overlay modules override webapp modules", async (t) => {
	t.context.tmpDir = await mkdtemp(path.join(os.tmpdir(), "ui5-experimental-source-esm-"));
	const webappRoot = path.join(t.context.tmpDir, "webapp");
	const overlayRoot = path.join(t.context.tmpDir, "esm-overlay");

	await writeTempFile(webappRoot, "Component.js", "export default class WebappComponent {}\n");
	await writeTempFile(overlayRoot, "Component.ts", "export default class OverlayComponent {}\n");

	const moduleSources = await _internal.collectAppModuleSources(webappRoot, overlayRoot);

	t.is(moduleSources.get("Component.js"), path.join(overlayRoot, "Component.ts"));
});

test.serial("buildExperimentalSourceEsm explains when the prerequisite runtime build is missing", async (t) => {
	t.context.tmpDir = await mkdtemp(path.join(os.tmpdir(), "ui5-experimental-source-esm-"));

	await writeTempFile(t.context.tmpDir, "ui5.yaml", "specVersion: \"3.0\"\n");
	await mkdir(path.join(t.context.tmpDir, "webapp"), {recursive: true});

	const error = await t.throwsAsync(buildExperimentalSourceEsm({
		projectRoot: t.context.tmpDir,
	}));

	t.regex(error.message, /did not emit UI5 runtime resources/);
	t.regex(error.message, /framework section in ui5\.yaml/);
	t.regex(error.message, /runtimeDistDir/);
});

test.serial("ensureSapUiVersionInfo synthesizes framework version info from ui5.yaml", async (t) => {
	t.context.tmpDir = await mkdtemp(path.join(os.tmpdir(), "ui5-experimental-source-esm-"));
	const ui5YamlPath = await writeTempFile(t.context.tmpDir, "ui5.yaml", [
		"specVersion: \"3.0\"",
		"framework:",
		"  name: OpenUI5",
		"  version: 1.2.3-test",
		"  libraries:",
		"    - name: sap.m",
		"    - name: sap.ui.core",
	].join("\n"));
	const resourcesDir = path.join(t.context.tmpDir, "dist", "resources");

	const result = await ensureSapUiVersionInfo({
		resourcesDir,
		ui5YamlPath,
		logger: () => {},
	});
	const payload = JSON.parse(await readFile(result.sapUiVersionPath, "utf8"));

	t.true(result.created);
	t.is(payload.name, "OpenUI5");
	t.is(payload.version, "1.2.3-test");
	t.deepEqual(payload.libraries, [
		{name: "sap.m"},
		{name: "sap.ui.core"},
	]);
});

test.serial("buildExperimentalSourceEsm explains that HTML-shell apps are unsupported", async (t) => {
	t.context.tmpDir = await mkdtemp(path.join(os.tmpdir(), "ui5-experimental-source-esm-"));
	const runtimeResourcesDir = path.join(t.context.tmpDir, "dist", "resources");

	await writeTempFile(t.context.tmpDir, "ui5.yaml", "specVersion: \"3.0\"\n");
	await writeTempFile(t.context.tmpDir, "webapp/manifest.json", JSON.stringify({
		"sap.app": {
			id: "custom.app",
		},
	}, null, 2));
	await writeTempFile(t.context.tmpDir, "webapp/main.js", "export default {};\n");
	await writeTempFile(runtimeResourcesDir, "sap-ui-core.js", "// runtime\n");

	const error = await t.throwsAsync(buildExperimentalSourceEsm({
		projectRoot: t.context.tmpDir,
	}));

	t.regex(error.message, /requires a Component module/);
	t.regex(error.message, /HTML-shell apps with index\.html \+ main\.js entrypoints are not supported yet/);
});

test("buildComponentModuleImportPaths uses the resolved component module path", (t) => {
	t.deepEqual(_internal.buildComponentModuleImportPaths("sample.ts.app", "nested/Component.js"), {
		"sample/ts/app/Component": "./_esm/nested/Component.js",
		"module:sample/ts/app/Component": "./_esm/nested/Component.js",
	});
});

test("shouldInjectComponentId skips conflicting root and routing ids", (t) => {
	t.false(_internal.shouldInjectComponentId("app", "app", "app"));
	t.false(_internal.shouldInjectComponentId("app", "main", "app"));
	t.true(_internal.shouldInjectComponentId("cart", "app", "layout"));
});

test.serial("collectRuntimeAppModulePaths includes app-owned XML core:require modules", async (t) => {
	t.context.tmpDir = await mkdtemp(path.join(os.tmpdir(), "ui5-experimental-source-esm-"));
	const sourceRoot = path.join(t.context.tmpDir, "esm-source-bridge-free");

	await writeTempFile(sourceRoot, "view/Main.view.xml", [
		'<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns:core="sap.ui.core"',
		'  core:require="{ formatter: \'sample/ts/app/model/formatter\', framework: \'sap/m/MessageBox\' }">',
		'</mvc:View>',
	].join("\n"));

	const modulePaths = await _internal.collectRuntimeAppModulePaths(
		new Map([["model/formatter.js", "/tmp/model/formatter.js"]]),
		"sample.ts.app",
		sourceRoot,
	);

	t.deepEqual(modulePaths, ["model/formatter.js"]);
});

test("transformModuleSource rewrites direct sap imports to UI5 namespace facades", (t) => {
	const result = _internal.transformModuleSource(
		[
			'import UIComponent from "sap/ui/core/UIComponent";',
			'import { History as Ui5History } from "sap/ui/core/routing/History";',
			"export default [UIComponent, Ui5History];",
		].join("\n"),
		"/tmp/project/esm-source-bridge-free/_esm/Component.js",
		"/tmp/project/esm-source-bridge-free/framework/_runtime.js",
	);

	t.true(result.contents.includes('createUi5NamespaceFacade("sap/ui/core/UIComponent")'));
	t.true(result.contents.includes('createUi5NamespaceFacade("sap/ui/core/routing/History")'));
	t.false(result.contents.includes('from "sap/ui/core/UIComponent"'));
	t.false(result.contents.includes('from "sap/ui/core/routing/History"'));
	t.deepEqual(result.frameworkModuleNames, [
		"sap/ui/core/UIComponent",
		"sap/ui/core/routing/History",
	]);
});

test("transformModuleSource adapts default UIComponent subclasses to UI5 extend semantics", (t) => {
	const result = _internal.transformModuleSource(
		[
			'import UIComponent from "sap/ui/core/UIComponent";',
			"export default class Component extends UIComponent {",
			"  static metadata = { manifest: \"json\" };",
			"}",
		].join("\n"),
		"/tmp/project/esm-source-bridge-free/_esm/Component.js",
		"/tmp/project/esm-source-bridge-free/framework/_runtime.js",
		{componentClassName: "sample.ts.app.Component"},
	);

	t.true(result.contents.includes("adaptUi5ExtendClass"));
	t.true(result.contents.includes("class Component extends UIComponent"));
	t.true(result.contents.includes('const __ui5AdaptedDefaultExport = adaptUi5ExtendClass(UIComponent, Component, "sample.ts.app.Component");'));
	t.true(result.contents.includes("export default __ui5AdaptedDefaultExport;"));
	t.false(result.contents.includes("export default class Component extends UIComponent"));
});

test("transformModuleSource rewrites sap.ui.require.toUrl to the runtime resource resolver", (t) => {
	const result = _internal.transformModuleSource(
		[
			"export async function loadVersionInfo() {",
			"\treturn fetch(sap.ui.require.toUrl(\"sap-ui-version.json\"));",
			"}",
		].join("\n"),
		"/tmp/project/esm-source-bridge-free/_esm/Component.js",
		"/tmp/project/esm-source-bridge-free/framework/_runtime.js",
	);

	t.true(result.contents.includes("import { resolveUi5ResourceUrl }"));
	t.true(result.contents.includes('fetch(resolveUi5ResourceUrl("sap-ui-version.json"))'));
	t.false(result.contents.includes("sap.ui.require.toUrl("));
});

test("rewriteRelativeModuleSpecifiers appends .js to extensionless relative imports", (t) => {
	const rewritten = _internal.rewriteRelativeModuleSpecifiers([
		'import BaseController from "./BaseController";',
		'export { default as models } from "../model/models";',
		'import("./controller/Main.controller");',
	].join("\n"));

	t.true(rewritten.includes('from "./BaseController.js"'));
	t.true(rewritten.includes('from "../model/models.js"'));
	t.true(rewritten.includes('import("./controller/Main.controller.js")'));
});

test("buildIndexHtml suppresses the browser default favicon request", (t) => {
	const html = _internal.buildIndexHtml({
		compatVersion: "edge",
		resourceRoots: {"sample.ts.app": "./"},
		sapUiCorePath: "../dist/resources/sap-ui-core.js",
		theme: "sap_horizon",
		title: "sample.ts.app",
	});

	t.true(html.includes('<link rel="icon" href="data:,">'));
	t.true(html.includes('src="../dist/resources/sap-ui-core.js"'));
});

test.serial("createUi5NamespaceFacade falls back to sap.ui.requireSync when no global namespace export exists", (t) => {
	const originalSap = globalThis.sap;
	const messageBox = {
		Icon: {
			ERROR: "error",
		},
		error(message) {
			capturedMessages.push(message);
		},
	};
	const capturedMessages = [];
	const requestedModules = [];

	t.teardown(() => {
		if (typeof originalSap === "undefined") {
			delete globalThis.sap;
			return;
		}

		globalThis.sap = originalSap;
	});

	globalThis.sap = {
		ui: {
			requireSync(moduleName) {
				requestedModules.push(moduleName);
				if (moduleName === "sap/m/MessageBox") {
					return messageBox;
				}

				throw new Error(`Unexpected module request: ${moduleName}`);
			},
		},
	};

	const facade = createUi5NamespaceFacade("sap/m/MessageBox");

	t.is(facade.Icon.ERROR, "error");
	facade.error("boom");

	t.deepEqual(requestedModules, ["sap/m/MessageBox"]);
	t.deepEqual(capturedMessages, ["boom"]);
});

test("adaptUi5ExtendClass preserves prototype methods on adapted UI5 classes", (t) => {
	class BaseClass {
		static extend(_className, classInfo) {
			class AdaptedClass {}

			for (const [propertyName, propertyValue] of Object.entries(classInfo)) {
				if (propertyName === "metadata") {
					continue;
				}

				AdaptedClass.prototype[propertyName] = propertyValue;
			}

			AdaptedClass.metadata = classInfo.metadata;
			return AdaptedClass;
		}
	}

	class NativeComponent extends BaseClass {
		static metadata = {
			manifest: "json",
		};

		getContentDensityClass() {
			return "sapUiSizeCompact";
		}
	}

	const AdaptedComponent = adaptUi5ExtendClass(BaseClass, NativeComponent, "sample.ts.app.Component");
	const instance = new AdaptedComponent();

	t.is(instance.getContentDensityClass(), "sapUiSizeCompact");
	t.deepEqual(AdaptedComponent.metadata, {manifest: "json"});
});

test.serial("loadUi5Modules caches loader exports for later namespace facades", async (t) => {
	const originalSap = globalThis.sap;
	const capturedMessages = [];
	const messageBox = {
		error(message) {
			capturedMessages.push(message);
		},
	};

	t.teardown(() => {
		if (typeof originalSap === "undefined") {
			delete globalThis.sap;
			return;
		}

		globalThis.sap = originalSap;
	});

	globalThis.sap = {
		ui: {
			getCore() {
				return {
					isInitialized() {
						return true;
					},
				};
			},
			require(moduleNames, onSuccess) {
				t.deepEqual(moduleNames, ["sap/m/MessageBox"]);
				onSuccess(messageBox);
			},
		},
	};

	await loadUi5Modules("sap/m/MessageBox");
	createUi5NamespaceFacade("sap/m/MessageBox").error("boom");

	t.deepEqual(capturedMessages, ["boom"]);
});