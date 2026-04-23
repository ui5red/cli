import {spawn} from "node:child_process";
import {access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import ensureSapUiVersionInfo from "./sapUiVersionInfo.js";

const ESM_MODULE_DIR_NAME = "_esm";
const APP_MODULE_EXTENSIONS = [".js", ".ts"];
const EXPLICIT_RELATIVE_IMPORT_EXTENSIONS = new Set([
	".cjs",
	".css",
	".js",
	".json",
	".mjs",
	".svg",
	".ts",
	".xml",
]);
const nodeRequire = createRequire(import.meta.url);

export default async function buildExperimentalSourceEsm({
	projectRoot = process.cwd(),
	runtimeDistDir = path.join(projectRoot, "dist"),
	sourceRootDirName = "esm-source-bridge-free",
	debugOutDirName = "dist-esm-source-debug",
	releaseOutDirName = "dist-esm-source-release",
} = {}) {
	const webappRoot = path.join(projectRoot, "webapp");
	const overlayRoot = path.join(projectRoot, "esm-overlay");
	const ui5YamlPath = path.join(projectRoot, "ui5.yaml");
	const sourceRoot = path.join(projectRoot, sourceRootDirName);
	const debugOutDir = path.join(projectRoot, debugOutDirName);
	const releaseOutDir = path.join(projectRoot, releaseOutDirName);
	const runtimeResourcesDir = path.join(runtimeDistDir, "resources");
	const sapUiCorePath = path.join(runtimeResourcesDir, "sap-ui-core.js");

	await assertPathExists(webappRoot, "Experimental source ESM build requires a webapp directory");
	await assertPathExists(ui5YamlPath, "Experimental source ESM build requires a ui5.yaml file");
	await assertPathExists(sapUiCorePath,
		`Experimental source ESM build requires ${sapUiCorePath}. ` +
		"The prerequisite standard build did not emit UI5 runtime resources. " +
		"Declare a framework section in ui5.yaml or provide runtimeDistDir from a framework-enabled build output.");
	await ensureSapUiVersionInfo({resourcesDir: runtimeResourcesDir, ui5YamlPath, logger: log});

	await generateSourceVariant({
		projectRoot,
		webappRoot,
		overlayRoot,
		sourceRoot,
		runtimeDistDir,
	});

	const entryFiles = await listBuildEntrypoints(sourceRoot);
	const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "ui5-experimental-source-esm-"));

	try {
		await rebuildDir(debugOutDir);
		await copyNonJsAssets(sourceRoot, debugOutDir);

		const rollupConfigPath = await writeRollupConfig(entryFiles, sourceRoot, scratchRoot, debugOutDir);
		log(`Bundling debug sources into ${path.relative(projectRoot, debugOutDir)}`);
		await runCommand("npm", [
			"exec",
			"--yes",
			"rollup",
			"--",
			"--config",
			rollupConfigPath,
			"--silent",
		], {
			cwd: projectRoot,
		});

		await rebuildDir(releaseOutDir);
		await copyNonJsAssets(sourceRoot, releaseOutDir);

		log(`Bundling release sources into ${path.relative(projectRoot, releaseOutDir)}`);
		await runCommand("npm", [
			"exec",
			"--yes",
			"esbuild",
			"--",
			...entryFiles,
			`--outdir=${releaseOutDir}`,
			`--outbase=${toPosix(sourceRoot)}`,
			"--bundle",
			"--format=esm",
			"--platform=browser",
			"--splitting",
			"--minify",
			"--entry-names=[dir]/[name]",
			"--chunk-names=chunks/[name]-[hash]",
			"--sourcemap=external",
		], {
			cwd: projectRoot,
		});
	} finally {
		await rm(scratchRoot, {force: true, recursive: true});
	}

	return {
		sourceRoot,
		debugOutDir,
		releaseOutDir,
		runtimeDistDir,
	};
}

async function generateSourceVariant({
	projectRoot,
	webappRoot,
	overlayRoot,
	sourceRoot,
	runtimeDistDir,
}) {
	await rebuildDir(sourceRoot);
	await copyStaticAssets(webappRoot, sourceRoot, shouldCopyWebappAsset);
	await copyStaticAssets(overlayRoot, sourceRoot, shouldCopyOverlayAsset);
	await copyRuntimeHelper(sourceRoot);

	const appModuleSources = await collectAppModuleSources(webappRoot, overlayRoot);
	const typeScriptCompiler = await loadTypeScriptCompilerIfNeeded(projectRoot, appModuleSources);
	const manifestConfig = await readJson(path.join(sourceRoot, "manifest.json"));
	const appNamespace = manifestConfig?.["sap.app"]?.id ?? null;
	if (!appNamespace) {
		throw new Error("Experimental source ESM build requires manifest.json sap.app.id");
	}

	const frameworkModuleNames = new Set();
	const transformedModules = new Map();
	const runtimeFilePath = path.join(sourceRoot, "framework", "_runtime.js");
	const componentModuleRelativePath = findComponentModuleRelativePath(appModuleSources);
	if (!componentModuleRelativePath) {
		throw new Error(
			"Experimental source ESM build currently requires a Component module in webapp or esm-overlay. " +
			"HTML-shell apps with index.html + main.js entrypoints are not supported yet."
		);
	}

	for (const [relativePath, sourcePath] of appModuleSources) {
		const sourceText = await readAppModuleSource(sourcePath, typeScriptCompiler);
		const targetPath = path.join(sourceRoot, ESM_MODULE_DIR_NAME, relativePath);
		const transformed = transformModuleSource(sourceText, targetPath, runtimeFilePath, {
			componentClassName: relativePath === componentModuleRelativePath ? `${appNamespace}.Component` : null,
		});

		for (const moduleName of transformed.frameworkModuleNames) {
			frameworkModuleNames.add(moduleName);
		}
		transformedModules.set(relativePath, transformed.contents);

		await ensureParentDir(targetPath);
		await writeFile(targetPath, transformed.contents);
	}

	const componentModuleImportPaths = buildComponentModuleImportPaths(appNamespace, componentModuleRelativePath);
	const controllerModulePaths = await collectRuntimeControllerModulePaths(transformedModules, appNamespace, sourceRoot);
	const controllerModuleImportPaths = buildControllerModuleImportPaths(controllerModulePaths, appNamespace);
	const appRuntimeModulePaths = await collectRuntimeAppModulePaths(transformedModules, appNamespace, sourceRoot);
	const appRuntimeModuleImportPaths = buildAppModuleImportPaths(appRuntimeModulePaths, appNamespace);
	const componentPreloadModulePaths = buildComponentPreloadModulePaths(appModuleSources);
	const componentPreloadResourcePaths = await collectComponentPreloadResourcePaths(sourceRoot);
	const bootstrapHtmlConfig = await readBootstrapHtmlConfig({
		appNamespace,
		overlayRoot,
		runtimeDistDir,
		sourceRoot,
		webappRoot,
	});

	await writeFile(
		path.join(sourceRoot, "bootstrap.js"),
		buildBootstrapModule({
			appNamespace,
			appRuntimeModuleImportPaths,
			componentId: inferComponentId(appNamespace),
			componentModuleImportPaths,
			controllerModuleImportPaths,
			hasMockserver: appModuleSources.has("localService/mockserver.js"),
			preloadModules: collectBootstrapPreloadModules(manifestConfig, frameworkModuleNames),
			rootViewId: manifestConfig?.["sap.ui5"]?.rootView?.id ?? null,
			routingControlId: manifestConfig?.["sap.ui5"]?.routing?.config?.controlId ?? null,
		}),
	);
	await writeFile(
		path.join(sourceRoot, "Component-preload.js"),
		buildComponentPreloadModule(appNamespace, componentPreloadModulePaths, componentPreloadResourcePaths),
	);
	await writeFile(path.join(sourceRoot, "index-esm.html"), buildIndexHtml(bootstrapHtmlConfig));

	log(`Generated ${path.relative(projectRoot, sourceRoot)}`);
}

async function listBuildEntrypoints(sourceRoot) {
	const files = await listFiles(sourceRoot);

	return files
		.filter((filePath) => filePath.endsWith(".js"))
		.filter((filePath) => {
			const relativePath = path.relative(sourceRoot, filePath);
			return !relativePath.startsWith(`framework${path.sep}`) && !isStaticBuildScript(relativePath);
		})
		.map(toPosix)
		.sort();
}

async function writeRollupConfig(entryFiles, sourceRoot, scratchRoot, debugOutDir) {
	const rollupConfigPath = path.join(scratchRoot, "rollup.config.mjs");
	const configSource = `
export default {
  input: ${JSON.stringify(entryFiles, null, 2)},
  output: {
    dir: ${JSON.stringify(toPosix(debugOutDir))},
    format: "es",
    preserveModules: true,
    preserveModulesRoot: ${JSON.stringify(toPosix(sourceRoot))},
    entryFileNames: "[name].js",
    chunkFileNames: "chunks/[name]-[hash].js",
    sourcemap: true,
  },
};
`.trimStart();

	await writeFile(rollupConfigPath, configSource);
	return rollupConfigPath;
}

async function copyNonJsAssets(sourceRoot, outputRoot) {
	for (const sourcePath of await listFiles(sourceRoot)) {
		const relativePath = path.relative(sourceRoot, sourcePath);
		if (sourcePath.endsWith(".js.map")) {
			continue;
		}

		if (isTransformableAppModule(relativePath) && !isStaticBuildScript(relativePath)) {
			continue;
		}

		const targetPath = path.join(outputRoot, relativePath);
		await ensureParentDir(targetPath);
		await cp(sourcePath, targetPath);
	}
}

function isStaticBuildScript(relativePath) {
	return relativePath === "Component-preload.js";
}

async function runCommand(command, args, {cwd}) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit",
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}

			reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
		});
	});
}

async function readAppModuleSource(sourcePath, typeScriptCompiler) {
	const sourceText = await readFile(sourcePath, "utf8");

	if (!sourcePath.endsWith(".ts")) {
		return rewriteRelativeModuleSpecifiers(sourceText);
	}

	return rewriteRelativeModuleSpecifiers(transpileTypeScriptSource(sourceText, sourcePath, typeScriptCompiler));
}

async function loadTypeScriptCompilerIfNeeded(projectRoot, appModuleSources) {
	if (![...appModuleSources.values()].some((sourcePath) => sourcePath.endsWith(".ts"))) {
		return null;
	}

	let typeScriptPath;
	try {
		typeScriptPath = nodeRequire.resolve("typescript", {paths: [projectRoot]});
	} catch {
		throw new Error(
			"Experimental source ESM build requires the 'typescript' package in the project root to transpile TypeScript application sources",
		);
	}

	return nodeRequire(typeScriptPath);
}

function transpileTypeScriptSource(sourceText, sourcePath, typeScriptCompiler) {
	if (!typeScriptCompiler) {
		throw new Error(`Missing TypeScript compiler for ${sourcePath}`);
	}

	return typeScriptCompiler.transpileModule(sourceText, {
		compilerOptions: {
			module: typeScriptCompiler.ModuleKind.ESNext,
			target: typeScriptCompiler.ScriptTarget.ES2022,
			sourceMap: false,
		},
		fileName: sourcePath,
	}).outputText;
}

function rewriteRelativeModuleSpecifiers(sourceText) {
	return sourceText
		.replace(/(\bfrom\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
			return `${prefix}${ensureRelativeJsExtension(specifier)}${suffix}`;
		})
		.replace(/(\bimport\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
			return `${prefix}${ensureRelativeJsExtension(specifier)}${suffix}`;
		})
		.replace(/import\s*\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)/g, (_match, quote, specifier) => {
			return `import(${quote}${ensureRelativeJsExtension(specifier)}${quote})`;
		});
}

function ensureRelativeJsExtension(specifier) {
	const match = specifier.match(/^([^?#]+)(.*)$/);
	if (!match) {
		return specifier;
	}

	const [, pathPart, suffix] = match;
	if (EXPLICIT_RELATIVE_IMPORT_EXTENSIONS.has(path.posix.extname(pathPart))) {
		return specifier;
	}

	return `${pathPart}.js${suffix}`;
}

function transformModuleSource(sourceText, outputPath, runtimeFilePath, {componentClassName = null} = {}) {
	let contents = sourceText;
	const injectedImports = [];
	const facadeDeclarations = [];
	const frameworkModuleNames = new Set();
	const uiComponentLocalName = componentClassName ? inferDefaultSapImportLocalName(sourceText, "sap/ui/core/UIComponent") : null;
	let sapFacadeIndex = 0;

	contents = contents.replace(/^import\s+([^"\n]+?)\s+from\s+["'](sap\/[^"']+)["'];?\n?/gm,
		(_match, importClause, moduleName) => {
			injectedImports.push(buildRuntimeImport(outputPath, runtimeFilePath, "createUi5NamespaceFacade"));
			facadeDeclarations.push(...buildSapImportFacadeDeclarations(importClause.trim(), moduleName, sapFacadeIndex));
			frameworkModuleNames.add(moduleName);
			sapFacadeIndex += 1;
			return "";
		},
	);

	contents = contents.replace(/^import\s+["'](sap\/[^"']+)["'];?\n?/gm, (_match, moduleName) => {
		frameworkModuleNames.add(moduleName);
		return "";
	});

	contents = contents.replace(/^import\s*\{[^}]*requireUI5[^}]*\}\s*from\s*["'][^"']*esm-helpers\.js["'];\n?/m, "");

	contents = contents.replace(/const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s*requireUI5\("([^"]+)"\);\n?/g,
		(_match, variableName, moduleName) => {
			injectedImports.push(buildRuntimeImport(outputPath, runtimeFilePath, "createUi5NamespaceFacade"));
			facadeDeclarations.push(`const ${variableName} = createUi5NamespaceFacade(${JSON.stringify(moduleName)});`);
			frameworkModuleNames.add(moduleName);
			return "";
		},
	);

	contents = contents.replace(/const\s*\[([^\]]+)\]\s*=\s*await\s*requireUI5All\(([\s\S]*?)\);\n?/g,
		(_match, variableList, moduleList) => {
			const variables = variableList.split(",").map((item) => item.trim()).filter(Boolean);
			const modules = [...moduleList.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

			if (variables.length !== modules.length) {
				throw new Error(`Could not transform requireUI5All() in ${outputPath}`);
			}

			for (let index = 0; index < variables.length; index += 1) {
				injectedImports.push(buildRuntimeImport(outputPath, runtimeFilePath, "createUi5NamespaceFacade"));
				facadeDeclarations.push(`const ${variables[index]} = createUi5NamespaceFacade(${JSON.stringify(modules[index])});`);
				frameworkModuleNames.add(modules[index]);
			}

			return "";
		},
	);

	if (contents.includes("sap.ui.require.toUrl(")) {
		contents = contents.replace(/sap\.ui\.require\.toUrl\(/g, "resolveUi5ResourceUrl(");
		injectedImports.push(buildRuntimeImport(outputPath, runtimeFilePath, "resolveUi5ResourceUrl"));
	}

	const rewrittenComponentExport = rewriteUi5ComponentDefaultExport(contents, {
		className: componentClassName,
		baseLocalName: uiComponentLocalName,
	});
	if (rewrittenComponentExport.rewritten) {
		contents = rewrittenComponentExport.contents;
		injectedImports.push(buildRuntimeImport(outputPath, runtimeFilePath, "adaptUi5ExtendClass"));
	}

	contents = injectImports(contents, injectedImports);
	contents = injectDeclarations(contents, facadeDeclarations);
	contents = contents.replace(/\n{3,}/g, "\n\n").trimEnd();

	return {
		contents: `${contents}\n`,
		frameworkModuleNames: [...frameworkModuleNames].sort(),
	};
}

function inferDefaultSapImportLocalName(sourceText, moduleName) {
	const pattern = new RegExp(`^import\\s+([A-Za-z_$][\\w$]*)\\s*(?:,|from)\\s*["']${escapeRegex(moduleName)}["'];?`, "m");
	const match = sourceText.match(pattern);
	return match?.[1] ?? null;
}

function rewriteUi5ComponentDefaultExport(sourceText, {baseLocalName, className}) {
	if (!baseLocalName || !className) {
		return {contents: sourceText, rewritten: false};
	}

	const exportPattern = new RegExp(`export\\s+default\\s+class\\s+([A-Za-z_$][\\w$]*)\\s+extends\\s+${escapeRegex(baseLocalName)}\\s*\\{`);
	const match = sourceText.match(exportPattern);
	if (!match) {
		return {contents: sourceText, rewritten: false};
	}

	const componentLocalName = match[1];
	const rewrittenSource = sourceText.replace(exportPattern, `class ${componentLocalName} extends ${baseLocalName} {`);

	return {
		contents: `${rewrittenSource.trimEnd()}\n\nconst __ui5AdaptedDefaultExport = adaptUi5ExtendClass(${baseLocalName}, ${componentLocalName}, ${JSON.stringify(className)});\nexport default __ui5AdaptedDefaultExport;\n`,
		rewritten: true,
	};
}

function escapeRegex(text) {
	return text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function buildRuntimeImport(outputPath, runtimeFilePath, importName) {
	const relativeImport = toModuleImport(path.relative(path.dirname(outputPath), runtimeFilePath));
	return `import { ${importName} } from ${JSON.stringify(relativeImport)};`;
}

function buildSapImportFacadeDeclarations(importClause, moduleName, facadeIndex) {
	const declarations = [];
	const facadeVariableName = `__ui5Facade${facadeIndex}`;
	let defaultImport = importClause;
	let secondaryImport = null;

	if (importClause.includes(",")) {
		const importParts = importClause.split(/,(.+)/, 2).map((part) => part?.trim()).filter(Boolean);
		[defaultImport, secondaryImport] = importParts;
	}

	declarations.push(`const ${facadeVariableName} = createUi5NamespaceFacade(${JSON.stringify(moduleName)});`);

	if (defaultImport?.startsWith("{")) {
		secondaryImport = defaultImport;
		defaultImport = null;
	}

	if (defaultImport?.startsWith("* as ")) {
		secondaryImport = defaultImport;
		defaultImport = null;
	}

	if (defaultImport) {
		declarations.push(`const ${defaultImport} = ${facadeVariableName};`);
	}

	if (secondaryImport?.startsWith("* as ")) {
		declarations.push(`const ${secondaryImport.slice(5).trim()} = ${facadeVariableName};`);
	} else if (secondaryImport?.startsWith("{")) {
		declarations.push(`const ${normalizeNamedImportClause(secondaryImport)} = ${facadeVariableName};`);
	}

	return declarations;
}

function normalizeNamedImportClause(namedImportClause) {
	return namedImportClause.replace(/\s+as\s+/g, ": ");
}

function injectImports(sourceText, frameworkImports) {
	if (frameworkImports.length === 0) {
		return sourceText;
	}

	const importBlock = [...new Set(frameworkImports)].join("\n");
	const importMatches = [...sourceText.matchAll(/^import .*;$/gm)];

	if (importMatches.length === 0) {
		return `${importBlock}\n\n${sourceText.trimStart()}`;
	}

	const lastImport = importMatches.at(-1);
	const insertionIndex = lastImport.index + lastImport[0].length;
	return `${sourceText.slice(0, insertionIndex)}\n${importBlock}${sourceText.slice(insertionIndex)}`;
}

function injectDeclarations(sourceText, declarations) {
	if (declarations.length === 0) {
		return sourceText;
	}

	const declarationBlock = [...new Set(declarations)].join("\n");
	const importMatches = [...sourceText.matchAll(/^import .*;$/gm)];

	if (importMatches.length === 0) {
		return `${declarationBlock}\n\n${sourceText.trimStart()}`;
	}

	const lastImport = importMatches.at(-1);
	const insertionIndex = lastImport.index + lastImport[0].length;
	return `${sourceText.slice(0, insertionIndex)}\n\n${declarationBlock}${sourceText.slice(insertionIndex)}`;
}

async function copyRuntimeHelper(sourceRoot) {
	const targetPath = path.join(sourceRoot, "framework", "_runtime.js");
	await ensureParentDir(targetPath);
	await cp(new URL("./experimentalSourceEsmRuntime.js", import.meta.url), targetPath);
}

function buildBootstrapModule({
	appNamespace,
	appRuntimeModuleImportPaths,
	componentId,
	componentModuleImportPaths,
	controllerModuleImportPaths,
	hasMockserver,
	preloadModules,
	rootViewId,
	routingControlId,
}) {
	const appNamespaceLiteral = JSON.stringify(appNamespace);
	const appRuntimeImportPathsLiteral = JSON.stringify(appRuntimeModuleImportPaths, null, 2);
	const preloadModulesLiteral = JSON.stringify(preloadModules, null, 2);
	const controllerImportPathsLiteral = JSON.stringify(controllerModuleImportPaths, null, 2);
	const componentImportPathsLiteral = JSON.stringify(componentModuleImportPaths, null, 2);
	const mockserverImport = hasMockserver ? `import mockserver from "./${ESM_MODULE_DIR_NAME}/localService/mockserver.js";\n` : "";
	const mockserverInit = hasMockserver ? `
try {
  await mockserver.init();
} catch (error) {
		showUi5Error(error);
}
` : "";
	const componentSettings = shouldInjectComponentId(componentId, rootViewId, routingControlId) ? `
    settings: {
      id: ${JSON.stringify(componentId)},
    },` : "";

	return `
import {
	createUi5NamespaceFacade,
	installUi5ModuleImportHook,
	loadUi5Modules,
	preloadMappedUi5ModuleImports,
	waitForUi5CoreReady,
} from "./framework/_runtime.js";
${mockserverImport}
const appNamespace = ${appNamespaceLiteral};
const manifestPreloadModules = ${preloadModulesLiteral};
const MessageBox = createUi5NamespaceFacade("sap/m/MessageBox");
const ComponentContainer = createUi5NamespaceFacade("sap/ui/core/ComponentContainer");
const controllerModuleImportPaths = ${controllerImportPathsLiteral};
const controllerModuleImportUrls = Object.fromEntries(
  Object.entries(controllerModuleImportPaths).map(([controllerName, modulePath]) => [
    controllerName,
    new URL(modulePath, import.meta.url).href,
  ]),
);
const appRuntimeModuleImportPaths = ${appRuntimeImportPathsLiteral};
const appRuntimeModuleImportUrls = Object.fromEntries(
	Object.entries(appRuntimeModuleImportPaths).map(([moduleName, modulePath]) => [
		moduleName,
		new URL(modulePath, import.meta.url).href,
	]),
);
const componentModuleImportPaths = ${componentImportPathsLiteral};
const componentModuleImportUrls = Object.fromEntries(
  Object.entries(componentModuleImportPaths).map(([moduleName, modulePath]) => [
    moduleName,
    new URL(modulePath, import.meta.url).href,
  ]),
);

function reportError(error) {
  const errorBox = document.getElementById("esm-errors");
  const message = error instanceof Error ? (error.stack || error.message) : String(error);

  if (errorBox) {
		errorBox.textContent = (errorBox.textContent + "\\n" + message).trim();
  }

  console.error(error);
}

function showUi5Error(error) {
	const message = error instanceof Error ? error.message : String(error);

	reportError(error);

	try {
		MessageBox.error(message);
	} catch (messageBoxError) {
		reportError(messageBoxError);
	}
}

function waitForComponentStartup(container, appNamespace) {
	return new Promise((resolve, reject) => {
		let isSettled = false;

		const complete = (callback) => (value) => {
			if (isSettled) {
				return;
			}

			isSettled = true;
			clearTimeout(timeoutId);
			callback(value);
		};

		container.attachComponentCreated(complete(event => resolve(event.getParameter("component"))));
		container.attachComponentFailed(complete(event => reject(event.getParameter("reason"))));

		const timeoutId = setTimeout(() => {
			const contentNode = document.getElementById("content");
			const componentInstance = typeof container.getComponentInstance === "function"
				? container.getComponentInstance()
				: null;

			reject(new Error(
				"Timed out waiting for ComponentContainer startup for " + appNamespace +
				"; componentInstance=" + (componentInstance ? "present" : "missing") +
				"; contentChildren=" + (contentNode?.childElementCount ?? "n/a") +
				"; contentHtmlLength=" + (contentNode?.innerHTML?.length ?? "n/a"),
			));
		}, 5000);
	});
}

window.addEventListener("error", event => {
  reportError(event.error || event.message);
});

window.addEventListener("unhandledrejection", event => {
  reportError(event.reason);
});

await waitForUi5CoreReady();

await installUi5ModuleImportHook(controllerModuleImportUrls);
await installUi5ModuleImportHook(appRuntimeModuleImportUrls);
await installUi5ModuleImportHook(componentModuleImportUrls);

if (manifestPreloadModules.length > 0) {
  await loadUi5Modules(...manifestPreloadModules);
}

await preloadMappedUi5ModuleImports();

${mockserverInit}let container;

try {
  container = new ComponentContainer("container", {
    async: true,
    height: "100%",
		manifest: true,
		name: appNamespace,${componentSettings}
    width: "100%",
  });

  container.placeAt("content");
	await waitForComponentStartup(container, appNamespace);
} catch (error) {
  container?.destroy();
	showUi5Error(error);
}
`.trimStart();
}

function buildComponentPreloadModule(appNamespace, moduleImportPaths, resourcePaths) {
	const bundleName = appNamespace
		? `${appNamespace.replaceAll(".", "/")}/Component-preload.js`
		: "Component-preload.js";

	return `
//@ui5-bundle ${bundleName}
(function() {
  const host = globalThis.window ?? globalThis;
  const documentRef = host.document;
  const scriptUrl = documentRef?.currentScript?.src ?? host.location?.href;
  if (!scriptUrl) {
    return;
  }

  const moduleImportPaths = ${JSON.stringify(moduleImportPaths, null, 2)};
  const resourcePaths = ${JSON.stringify(resourcePaths, null, 2)};
  const baseUrl = new URL("./", scriptUrl);
  const moduleUrls = [...new Set(moduleImportPaths.map(modulePath => new URL(modulePath, baseUrl).href))];
  const resourceUrls = [...new Set(resourcePaths.map(resourcePath => new URL(resourcePath, baseUrl).href))];

  const logError = (label, error) => {
    const message = error instanceof Error ? error.message : String(error);
    host.console?.warn?.("[bridge-free-source] " + label + ": " + message);
  };

  const link = documentRef?.createElement?.("link");
  const supportsModulePreload = !!link?.relList?.supports?.("modulepreload");
  if (supportsModulePreload && documentRef?.head) {
    for (const href of moduleUrls) {
      const preloadLink = documentRef.createElement("link");
      preloadLink.rel = "modulepreload";
      preloadLink.href = href;
      preloadLink.addEventListener("error", () => {
        logError("Failed to preload module " + href, href);
      }, {once: true});
      documentRef.head.append(preloadLink);
    }
  } else {
    Promise.allSettled(moduleUrls.map(href => import(href))).then(results => {
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          logError("Failed to import fallback preload module " + moduleUrls[index], result.reason);
        }
      });
    });
  }

  for (const href of resourceUrls) {
    fetch(href, {credentials: "same-origin"}).catch(error => {
      logError("Failed to preload resource " + href, error);
    });
  }
})();
`.trimStart();
}

function buildIndexHtml({compatVersion, resourceRoots, sapUiCorePath, theme, title}) {
	return `
<!DOCTYPE html>
<html>
<head>

  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>${escapeHtml(title)}</title>
	<link rel="icon" href="data:,">

  <script
    id="sap-ui-bootstrap"
    src="${sapUiCorePath}"
    data-sap-ui-theme="${theme}"
    data-sap-ui-compat-version="${compatVersion}"
    data-sap-ui-async="true"
    data-sap-ui-resource-roots='${JSON.stringify(resourceRoots, null, 6)}'>
  </script>

  <script>
    window.__ui5CoreReady = window.__ui5CoreReady || new Promise(resolve => {
      document.addEventListener("sap-ui-core-ready", resolve, { once: true });
    });
  </script>

  <style>
    #esm-errors {
      white-space: pre-wrap;
      color: #8a1313;
      font: 12px/1.5 monospace;
      margin: 0;
      padding: 12px;
      border-top: 1px solid #e0e0e0;
      background: #fff8f8;
    }
  </style>

</head>
<body class="sapUiBody">
  <div id="content"></div>
  <pre id="esm-errors"></pre>
  <script type="module" src="./bootstrap.js"></script>
</body>
</html>
`.trimStart();
}

async function readBootstrapHtmlConfig({appNamespace, overlayRoot, runtimeDistDir, sourceRoot, webappRoot}) {
	const templatePath = await findBootstrapTemplatePath([
		path.join(overlayRoot, "index-esm.html"),
		path.join(webappRoot, "index.html"),
	]);
	const templateHtml = templatePath ? await readFile(templatePath, "utf8") : "";

	return {
		compatVersion: parseHtmlAttribute(templateHtml, "data-sap-ui-compat-version") ?? "edge",
		resourceRoots: parseBootstrapResourceRoots(templateHtml) ?? {[appNamespace]: "./"},
		sapUiCorePath: toModuleImport(path.relative(sourceRoot, path.join(runtimeDistDir, "resources", "sap-ui-core.js"))),
		theme: parseHtmlAttribute(templateHtml, "data-sap-ui-theme") ?? "sap_horizon",
		title: parseHtmlTitle(templateHtml) ?? "Bridge-Free ESM Exploration",
	};
}

async function findBootstrapTemplatePath(candidatePaths) {
	for (const candidatePath of candidatePaths) {
		try {
			await access(candidatePath);
			return candidatePath;
		} catch {
			// try next candidate
		}
	}

	return null;
}

function parseBootstrapResourceRoots(htmlText) {
	const rawValue = parseHtmlAttribute(htmlText, "data-sap-ui-resource-roots");
	if (!rawValue) {
		return null;
	}

	try {
		return JSON.parse(rawValue);
	} catch {
		return null;
	}
}

function parseHtmlAttribute(htmlText, attributeName) {
	if (!htmlText) {
		return null;
	}

	const attributePattern = new RegExp(`${escapeRegExp(attributeName)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
	return attributePattern.exec(htmlText)?.[2] ?? null;
}

function parseHtmlTitle(htmlText) {
	if (!htmlText) {
		return null;
	}

	return htmlText.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function collectManifestPreloadModules(manifestConfig) {
	const preloadModules = new Set();
	const appConfig = manifestConfig?.["sap.app"];
	const ui5Config = manifestConfig?.["sap.ui5"];
	const modelConfigs = ui5Config?.models ?? {};
	const dataSources = appConfig?.dataSources ?? {};
	const routingConfig = ui5Config?.routing?.config;

	for (const modelConfig of Object.values(modelConfigs)) {
		const moduleName = inferManifestModelModule(modelConfig, dataSources);
		if (moduleName) {
			preloadModules.add(moduleName);
		}
	}

	addViewModule(preloadModules, ui5Config?.rootView?.type);
	addViewModule(preloadModules, routingConfig?.viewType);
	addClassModule(preloadModules, ui5Config?.routing?.config?.routerClass);

	return [...preloadModules].sort();
}

function collectBootstrapPreloadModules(manifestConfig, frameworkModuleNames) {
	const preloadModules = new Set(collectManifestPreloadModules(manifestConfig));

	preloadModules.add("sap/m/MessageBox");
	preloadModules.add("sap/ui/core/ComponentContainer");

	for (const moduleName of frameworkModuleNames ?? []) {
		preloadModules.add(moduleName);
	}

	return [...preloadModules].sort();
}

function inferManifestModelModule(modelConfig, dataSources) {
	if (typeof modelConfig === "string") {
		return inferManifestModelModule({dataSource: modelConfig}, dataSources);
	}

	const explicitTypeModule = classNameToModuleName(modelConfig?.type);
	if (explicitTypeModule) {
		return explicitTypeModule;
	}

	if (!modelConfig?.dataSource) {
		return null;
	}

	const dataSource = dataSources?.[modelConfig.dataSource];
	if (!dataSource || typeof dataSource !== "object") {
		return null;
	}

	const dataSourceType = dataSource.type ?? "OData";
	if (dataSourceType === "OData") {
		const odataVersion = String(dataSource.settings?.odataVersion ?? modelConfig.settings?.odataVersion ?? "2.0");
		return odataVersion.startsWith("4")
			? "sap/ui/model/odata/v4/ODataModel"
			: "sap/ui/model/odata/v2/ODataModel";
	}

	if (dataSourceType === "JSON") {
		return "sap/ui/model/json/JSONModel";
	}

	if (dataSourceType === "XML") {
		return "sap/ui/model/xml/XMLModel";
	}

	return null;
}

function addClassModule(target, className) {
	const moduleName = classNameToModuleName(className);
	if (moduleName) {
		target.add(moduleName);
	}
}

function addViewModule(target, viewType) {
	const moduleName = viewTypeToModuleName(viewType);
	if (moduleName) {
		target.add(moduleName);
	}
}

function classNameToModuleName(className) {
	if (typeof className !== "string" || !className.startsWith("sap.")) {
		return null;
	}

	return className.replaceAll(".", "/");
}

function viewTypeToModuleName(viewType) {
	switch (String(viewType ?? "").toUpperCase()) {
		case "HTML":
			return "sap/ui/core/mvc/HTMLView";
		case "JS":
			return "sap/ui/core/mvc/JSView";
		case "JSON":
			return "sap/ui/core/mvc/JSONView";
		case "TEMPLATE":
			return "sap/ui/core/mvc/TemplateView";
		case "XML":
			return "sap/ui/core/mvc/XMLView";
		default:
			return null;
	}
}

async function listFiles(dirPath) {
	const entries = await readdir(dirPath, {withFileTypes: true});
	const files = [];

	for (const entry of entries) {
		const entryPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...await listFiles(entryPath));
			continue;
		}

		files.push(entryPath);
	}

	return files.sort();
}

async function listFilesIfExists(dirPath) {
	try {
		return await listFiles(dirPath);
	} catch (error) {
		if (error?.code === "ENOENT") {
			return [];
		}

		throw error;
	}
}

async function collectAppModuleSources(webappRoot, overlayRoot) {
	const moduleSources = new Map();

	await addAppModuleSources(moduleSources, webappRoot, {priority: 1});
	await addAppModuleSources(moduleSources, overlayRoot, {priority: 2});

	return new Map([...moduleSources.entries()].map(([relativePath, sourceInfo]) => [relativePath, sourceInfo.sourcePath]));
}

async function collectRuntimeControllerModulePaths(appModuleSources, appNamespace, sourceRoot) {
	const controllerModulePaths = new Set();

	for (const relativePath of await collectXmlControllerModulePaths(appNamespace, sourceRoot)) {
		addControllerModulePath(controllerModulePaths, appModuleSources, relativePath);
	}

	for (const sourceText of appModuleSources.values()) {
		for (const relativePath of collectExplicitRuntimeModulePaths(sourceText, appNamespace)) {
			addControllerModulePath(controllerModulePaths, appModuleSources, relativePath);
		}
	}

	return [...controllerModulePaths].sort();
}

async function collectRuntimeAppModulePaths(appModuleSources, appNamespace, sourceRoot) {
	const modulePaths = new Set();

	for (const relativePath of await collectXmlRuntimeModulePaths(appNamespace, sourceRoot)) {
		if (appModuleSources.has(relativePath)) {
			modulePaths.add(relativePath);
		}
	}

	return [...modulePaths].sort();
}

async function collectXmlControllerModulePaths(appNamespace, sourceRoot) {
	const modulePaths = new Set();

	for (const sourcePath of await listFiles(sourceRoot)) {
		if (!sourcePath.endsWith(".xml")) {
			continue;
		}

		const xmlText = await readFile(sourcePath, "utf8");
		for (const controllerName of collectXmlAttributeValues(xmlText, "controllerName")) {
			const relativePath = controllerNameToRelativePath(controllerName, appNamespace);
			if (relativePath) {
				modulePaths.add(relativePath);
			}
		}
	}

	return [...modulePaths].sort();
}

async function collectXmlRuntimeModulePaths(appNamespace, sourceRoot) {
	const modulePaths = new Set();

	for (const sourcePath of await listFiles(sourceRoot)) {
		if (!sourcePath.endsWith(".xml")) {
			continue;
		}

		const xmlText = await readFile(sourcePath, "utf8");
		for (const relativePath of collectXmlModulePaths(xmlText, appNamespace)) {
			modulePaths.add(relativePath);
		}
	}

	return [...modulePaths].sort();
}

function collectExplicitRuntimeModulePaths(sourceText, appNamespace) {
	const modulePaths = new Set();

	for (const pattern of [
		/Controller\.create\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/g,
		/sap\.ui\.controller\(\s*["']([^"']+)["']/g,
	]) {
		for (const match of sourceText.matchAll(pattern)) {
			const relativePath = controllerNameToRelativePath(match[1], appNamespace);
			if (relativePath) {
				modulePaths.add(relativePath);
			}
		}
	}

	return [...modulePaths].sort();
}

function collectXmlModulePaths(sourceText, appNamespace) {
	const modulePaths = new Set();

	for (const match of sourceText.matchAll(/["']((?:module:)?[A-Za-z0-9_./-]+)["']/g)) {
		const relativePath = appModuleNameToRelativePath(match[1], appNamespace);
		if (relativePath) {
			modulePaths.add(relativePath);
		}
	}

	return [...modulePaths].sort();
}

function collectXmlAttributeValues(sourceText, attributeName) {
	const attributeValues = [];
	const pattern = new RegExp(`${attributeName}\\s*=\\s*["']([^"']+)["']`, "g");

	for (const match of sourceText.matchAll(pattern)) {
		attributeValues.push(match[1]);
	}

	return attributeValues;
}

function addControllerModulePath(controllerModulePaths, appModuleSources, relativePath) {
	if (appModuleSources.has(relativePath)) {
		controllerModulePaths.add(relativePath);
	}
}

function buildControllerModuleImportPaths(controllerModulePaths, appNamespace) {
	const controllerModuleImportPaths = {};

	for (const relativePath of controllerModulePaths) {
		const importPath = toModuleImport(path.join(ESM_MODULE_DIR_NAME, relativePath));
		for (const controllerName of controllerRelativePathToNames(relativePath, appNamespace)) {
			controllerModuleImportPaths[controllerName] = importPath;
		}
	}

	return controllerModuleImportPaths;
}

function buildAppModuleImportPaths(appModulePaths, appNamespace) {
	const appModuleImportPaths = {};

	for (const relativePath of appModulePaths) {
		const moduleName = relativePathToModuleName(relativePath, appNamespace);
		if (!moduleName) {
			continue;
		}

		const importPath = toModuleImport(path.join(ESM_MODULE_DIR_NAME, relativePath));
		appModuleImportPaths[moduleName] = importPath;
		appModuleImportPaths[`module:${moduleName}`] = importPath;
	}

	return appModuleImportPaths;
}

function findComponentModuleRelativePath(appModuleSources) {
	if (appModuleSources.has("Component.js")) {
		return "Component.js";
	}

	const componentModulePaths = [...appModuleSources.keys()]
		.filter((relativePath) => relativePath.endsWith("/Component.js"))
		.sort();

	return componentModulePaths[0] ?? null;
}

function buildComponentModuleImportPaths(appNamespace, componentModuleRelativePath) {
	const componentModuleName = `${appNamespace.replaceAll(".", "/")}/Component`;
	const componentImportPath = toModuleImport(path.join(ESM_MODULE_DIR_NAME, componentModuleRelativePath));

	return {
		[componentModuleName]: componentImportPath,
		[`module:${componentModuleName}`]: componentImportPath,
	};
}

function buildComponentPreloadModulePaths(appModuleSources) {
	return [...appModuleSources.keys()]
		.sort()
		.map((relativePath) => toModuleImport(path.join(ESM_MODULE_DIR_NAME, relativePath)));
}

async function collectComponentPreloadResourcePaths(sourceRoot) {
	const resourcePaths = [];

	for (const sourcePath of await listFiles(sourceRoot)) {
		const relativePath = toPosixRelative(sourceRoot, sourcePath);
		if (shouldIncludeComponentPreloadResource(relativePath)) {
			resourcePaths.push(toModuleImport(relativePath));
		}
	}

	return resourcePaths.sort();
}

function shouldIncludeComponentPreloadResource(relativePath) {
	if (relativePath.startsWith(`${ESM_MODULE_DIR_NAME}/`) || relativePath.startsWith("framework/") || relativePath.startsWith("test/")) {
		return false;
	}

	if (relativePath === "Component-preload.js" || relativePath === "index-esm.html") {
		return false;
	}

	if (relativePath === "manifest.json" || relativePath === "localService/metadata.xml") {
		return true;
	}

	if (relativePath.startsWith("i18n/") && relativePath.endsWith(".properties")) {
		return true;
	}

	if (relativePath.startsWith("view/") && relativePath.endsWith(".xml")) {
		return true;
	}

	return false;
}

function controllerRelativePathToNames(relativePath, appNamespace) {
	if (typeof relativePath !== "string" || !relativePath.startsWith("controller/") || !relativePath.endsWith(".controller.js")) {
		return [];
	}

	const controllerSuffix = relativePath
		.slice("controller/".length, -".controller.js".length)
		.replaceAll("/", ".");
	const dottedName = `${appNamespace}.controller.${controllerSuffix}`;
	const moduleName = `${appNamespace.replaceAll(".", "/")}/controller/${controllerSuffix.replaceAll(".", "/")}.controller`;

	return [dottedName, moduleName, `module:${moduleName}`];
}

function controllerNameToRelativePath(controllerName, appNamespace) {
	if (typeof controllerName !== "string") {
		return null;
	}

	if (controllerName.startsWith("module:")) {
		const modulePath = trimAppNamespaceFromModulePath(controllerName.slice("module:".length), appNamespace);
		if (!modulePath) {
			return null;
		}

		return modulePath.endsWith(".js") ? modulePath : `${modulePath}.js`;
	}

	const namespacePrefix = `${appNamespace}.`;
	if (!controllerName.startsWith(namespacePrefix)) {
		return null;
	}

	const localControllerName = controllerName.slice(namespacePrefix.length);
	if (!localControllerName.startsWith("controller.")) {
		return null;
	}

	const controllerPath = localControllerName.slice("controller.".length).replaceAll(".", "/");
	return `controller/${controllerPath}.controller.js`;
}

function appModuleNameToRelativePath(moduleName, appNamespace) {
	if (typeof moduleName !== "string") {
		return null;
	}

	const normalizedModuleName = moduleName.startsWith("module:") ? moduleName.slice("module:".length) : moduleName;
	const modulePath = trimAppNamespaceFromModulePath(normalizedModuleName, appNamespace);
	if (!modulePath) {
		return null;
	}

	return modulePath.endsWith(".js") ? modulePath : `${modulePath}.js`;
}

function relativePathToModuleName(relativePath, appNamespace) {
	if (typeof relativePath !== "string" || !relativePath.endsWith(".js")) {
		return null;
	}

	return `${appNamespace.replaceAll(".", "/")}/${relativePath.slice(0, -".js".length)}`;
}

function trimAppNamespaceFromModulePath(modulePath, appNamespace) {
	const namespacePath = appNamespace.replaceAll(".", "/");
	if (modulePath.startsWith(`${namespacePath}/`)) {
		return modulePath.slice(namespacePath.length + 1);
	}

	return null;
}

async function addAppModuleSources(moduleSources, rootDir, {priority}) {
	const files = await listFilesIfExists(rootDir);

	for (const sourcePath of files) {
		const relativePath = toPosixRelative(rootDir, sourcePath);
		if (!shouldIncludeAppModule(relativePath)) {
			continue;
		}

		const outputRelativePath = getAppModuleOutputPath(relativePath);
		const candidate = {
			sourcePath,
			priority,
			extensionPriority: sourcePath.endsWith(".js") ? 2 : 1,
		};
		const existing = moduleSources.get(outputRelativePath);
		if (existing && (
			existing.priority > candidate.priority ||
			(existing.priority === candidate.priority && existing.extensionPriority >= candidate.extensionPriority)
		)) {
			continue;
		}

		moduleSources.set(outputRelativePath, candidate);
	}
}

async function copyStaticAssets(fromDir, toDir, includeFile) {
	const files = await listFilesIfExists(fromDir);

	for (const sourcePath of files) {
		const relativePath = toPosixRelative(fromDir, sourcePath);
		if (!includeFile(relativePath)) {
			continue;
		}

		const targetPath = path.join(toDir, relativePath);
		await ensureParentDir(targetPath);
		await cp(sourcePath, targetPath);
	}
}

async function ensureParentDir(filePath) {
	await mkdir(path.dirname(filePath), {recursive: true});
}

async function rebuildDir(dirPath) {
	await rm(dirPath, {force: true, recursive: true});
	await mkdir(dirPath, {recursive: true});
}

function shouldCopyWebappAsset(relativePath) {
	if (relativePath === "index.html" || relativePath === "test.html") {
		return false;
	}

	return !isTransformableAppModule(relativePath);
}

function shouldCopyOverlayAsset(relativePath) {
	if (relativePath === "index-esm.html") {
		return false;
	}

	return !isTransformableAppModule(relativePath);
}

function isTransformableAppModule(relativePath) {
	if (relativePath.endsWith(".d.ts")) {
		return false;
	}

	return APP_MODULE_EXTENSIONS.some((extension) => relativePath.endsWith(extension));
}

function shouldIncludeAppModule(relativePath) {
	if (!isTransformableAppModule(relativePath)) {
		return false;
	}

	if (relativePath.startsWith("test/")) {
		return false;
	}

	return relativePath !== "esm-helpers.js"
		&& relativePath !== "initMockServer.js"
		&& relativePath !== "resources/esm-bridge.js";
}

function getAppModuleOutputPath(relativePath) {
	if (relativePath.endsWith(".ts")) {
		return `${relativePath.slice(0, -3)}.js`;
	}

	return relativePath;
}

async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

function toModuleImport(relativePath) {
	const normalized = relativePath.split(path.sep).join("/");
	return normalized.startsWith(".") || normalized.startsWith("../") ? normalized : `./${normalized}`;
}

function toPosixRelative(from, to) {
	return path.relative(from, to).split(path.sep).join("/");
}

function toPosix(filePath) {
	return filePath.split(path.sep).join("/");
}

function inferComponentId(appNamespace) {
	return appNamespace.split(".").at(-1) || "app";
}

function shouldInjectComponentId(componentId, rootViewId, routingControlId) {
	if (!componentId) {
		return false;
	}

	return componentId !== rootViewId && componentId !== routingControlId;
}

async function assertPathExists(targetPath, message) {
	try {
		await access(targetPath);
	} catch {
		throw new Error(message);
	}
}

export const _internal = {
	buildAppModuleImportPaths,
	buildIndexHtml,
	buildComponentModuleImportPaths,
	collectRuntimeAppModulePaths,
	collectAppModuleSources,
	getAppModuleOutputPath,
	rewriteRelativeModuleSpecifiers,
	shouldInjectComponentId,
	shouldCopyOverlayAsset,
	shouldCopyWebappAsset,
	shouldIncludeAppModule,
	transformModuleSource,
	transpileTypeScriptSource,
};

function log(message) {
	console.log(`[bridge-free-source] ${message}`);
}