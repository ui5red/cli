import {spawn} from "node:child_process";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import baseMiddleware from "../middlewares/base.js";

const ui5CliEntryPath = fileURLToPath(new URL("../../../bin/ui5.cjs", import.meta.url));

const build = {
	command: "build",
	describe: "Build project in current directory",
	handler: handleBuild,
	middlewares: [baseMiddleware]
};

build.builder = function(cli) {
	return cli
		.command("jsdoc", "Build JSDoc resources", {
			handler: handleBuild,
			builder: noop,
			middlewares: [baseMiddleware]
		})
		.command("preload", "(default) Build project and create preload bundles", {
			handler: handleBuild,
			builder: noop,
			middlewares: [baseMiddleware]
		})
		.command("self-contained",
			"Build project and create self-contained bundle. " +
			"Recommended to be used in conjunction with --include-all-dependencies", {
				handler: handleBuild,
				builder: noop,
				middlewares: [baseMiddleware]
			})
		.command("experimental-source-esm",
			"Experimental bridge-free source-native ESM build for application projects", {
				handler: handleBuild,
				builder: noop,
				middlewares: [baseMiddleware]
			})
		.option("include-all-dependencies", {
			describe: "Include all dependencies in the build result. " +
				"This is equivalent to '--include-dependency \"*\"'",
			alias: ["all", "a"],
			default: false,
			type: "boolean"
		})
		.option("include-dependency", {
			describe: "A list of dependencies to be included in the build result. You can use the asterisk '*' as" +
				" an alias for including all dependencies in the build result. The listed dependencies cannot be" +
				" overruled by dependencies defined in 'exclude-dependency'. " +
				"The provided name must match with the dependency name shown in 'ui5 ls --flat'",
			type: "string",
			array: true
		})
		.option("include-dependency-regexp", {
			describe: "A list of regular expressions defining dependencies to be included in the build result." +
				" This list is prioritized like 'include-dependency'.",
			type: "string",
			array: true
		})
		.option("include-dependency-tree", {
			describe: "A list of dependencies to be included in the build result. Transitive dependencies are" +
				" implicitly included and do not need to be part of this list. These dependencies overrule" +
				" the selection of 'exclude-dependency-tree' but can be overruled by 'exclude-dependency'.",
			type: "string",
			array: true
		})
		.option("exclude-dependency", {
			describe: "A list of dependencies to be excluded from the build result. The listed dependencies can" +
				" be overruled by dependencies defined in 'include-dependency'. " +
				"The provided name must match with the dependency name shown in 'ui5 ls --flat'",
			type: "string",
			array: true
		})
		.option("exclude-dependency-regexp", {
			describe: "A list of regular expressions defining dependencies to be excluded from the build result." +
				" This list is prioritized like 'exclude-dependency'.",
			type: "string",
			array: true
		})
		.option("exclude-dependency-tree", {
			describe: "A list of dependencies to be excluded from the build result. Transitive dependencies are" +
				" implicitly included and do not need to be part of this list.",
			type: "string",
			array: true
		})
		.option("dest", {
			describe: "Path of build destination",
			default: "./dist",
			type: "string"
		})
		.option("clean-dest", {
			describe: "If present, clean the destination directory before building",
			default: false,
			type: "boolean"
		})
		.option("create-build-manifest", {
			describe: "Store build metadata in a '.ui5' directory in the build destination, " +
				"allowing reuse of the build result in other builds",
			default: false,
			type: "boolean"
		})
		.option("include-task", {
			describe: "A list of tasks to be added to the default execution set. " +
				"This option takes precedence over any excludes.",
			type: "string",
			array: true
		})
		.option("exclude-task", {
			describe: "A list of tasks to be excluded from the default task execution set",
			type: "string",
			array: true
		})
		.option("framework-version", {
			describe: "Overrides the framework version defined by the project. " +
				"Takes the same value as the version part of \"ui5 use\"",
			type: "string"
		})
		.option("cache-mode", {
			describe:
				"Cache mode to use when consuming SNAPSHOT versions of framework dependencies. " +
				"The 'Default' behavior is to invalidate the cache after 9 hours. 'Force' uses the cache only and " +
				"does not create any requests. 'Off' invalidates any existing cache and updates from the repository",
			type: "string",
			default: "Default",
			choices: ["Default", "Force", "Off"]
		})
		.option("experimental-css-variables", {
			describe:
				"Generate CSS variables (css-variables.css, css-variables.source.less)" +
				" and skeleton (library-skeleton(-RTL).css) for all themes",
			default: false,
			type: "boolean"
		})
		.option("output-style", {
			describe:
				"Processes build results into a specific directory structure.<br>" +
				"- Flat: Omits the project namespace and the \"resources\" directory.<br>" +
				"- Namespace: Respects the project namespace and the \"resources\" directory, " +
					"maintaining the original structure.<br>" +
				"- Default: The default directory structure for every project type. For applications, " +
					"this is identical to \"Flat\", and for libraries, it is \"Namespace\". Other types have a " +
					"more distinct default output style.",
			type: "string",
			default: "Default",
			choices: ["Default", "Flat", "Namespace"],
		})
		.coerce("output-style", (opt) => {
			return opt.charAt(0).toUpperCase() + opt.slice(1).toLowerCase();
		})
		.example("ui5 build", "Preload build for project without dependencies")
		.example("ui5 build self-contained", "Self-contained build for project")
		.example("ui5 build --exclude-task=* --include-task=minify generateComponentPreload",
			"Build project but only apply the minify- and generateComponentPreload tasks")
		.example("ui5 build --include-task=minify --exclude-task=generateComponentPreload",
			"Build project by applying all default tasks including the minify " +
			"task and excluding the generateComponentPreload task")
		.example("ui5 build experimental-source-esm",
			"Run the standard build and then generate experimental bridge-free source-native ESM outputs")
		.example("ui5 build --experimental-css-variables",
			"Preload build with experimental CSS variables artifacts");
};

function appendCliOption(args, name, value) {
	if (value == null || value === false) {
		return;
	}
	if (value === true) {
		args.push(name);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((entry) => {
			appendCliOption(args, name, entry);
		});
		return;
	}
	args.push(name, `${value}`);
}

function getExperimentalSourceEsmPrerequisiteArgs(argv) {
	const args = ["build"];

	appendCliOption(args, "--config", argv.config);
	appendCliOption(args, "--dependency-definition", argv.dependencyDefinition);
	appendCliOption(args, "--framework-version", argv.frameworkVersion);
	appendCliOption(args, "--cache-mode", argv.cacheMode);
	appendCliOption(args, "--workspace-config", argv.workspaceConfig);

	if (argv.workspace === false) {
		args.push("--no-workspace");
	} else {
		appendCliOption(args, "--workspace", argv.workspace);
	}

	if (argv["include-all-dependencies"]) {
		args.push("--all");
	}

	appendCliOption(args, "--include-dependency", argv["include-dependency"]);
	appendCliOption(args, "--include-dependency-regexp", argv["include-dependency-regexp"]);
	appendCliOption(args, "--include-dependency-tree", argv["include-dependency-tree"]);
	appendCliOption(args, "--exclude-dependency", argv["exclude-dependency"]);
	appendCliOption(args, "--exclude-dependency-regexp", argv["exclude-dependency-regexp"]);
	appendCliOption(args, "--exclude-dependency-tree", argv["exclude-dependency-tree"]);
	appendCliOption(args, "--dest", argv.dest);
	appendCliOption(args, "--clean-dest", argv["clean-dest"]);
	appendCliOption(args, "--create-build-manifest", argv["create-build-manifest"]);
	appendCliOption(args, "--include-task", argv["include-task"]);
	appendCliOption(args, "--exclude-task", argv["exclude-task"]);
	appendCliOption(args, "--experimental-css-variables", argv["experimental-css-variables"]);
	appendCliOption(args, "--output-style", argv["output-style"]);

	return args;
}

async function runExperimentalSourceEsmPrerequisiteBuildWithNode(argv) {
	const nodeBinary = process.env.NODE_RUNTIME_BINARY || process.env.npm_node_execpath || "node";
	const env = {
		...process.env,
		UI5_CLI_NO_LOCAL: process.env.UI5_CLI_NO_LOCAL ?? "1"
	};

	await new Promise((resolve, reject) => {
		const child = spawn(nodeBinary, [ui5CliEntryPath, ...getExperimentalSourceEsmPrerequisiteArgs(argv)], {
			cwd: process.cwd(),
			env,
			stdio: "inherit"
		});

		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (signal) {
				reject(new Error(`Node prerequisite build terminated with signal ${signal}`));
				return;
			}
			if (code !== 0) {
				reject(new Error(`Node prerequisite build exited with code ${code}`));
				return;
			}
			resolve();
		});
	});
}

async function handleBuild(argv) {
	const command = argv._[argv._.length - 1];

	const {graphFromStaticFile, graphFromPackageDependencies} = await import("@ui5/project/graph");

	let graph;
	if (argv.dependencyDefinition) {
		graph = await graphFromStaticFile({
			filePath: argv.dependencyDefinition,
			rootConfigPath: argv.config,
			versionOverride: argv.frameworkVersion,
			cacheMode: argv.cacheMode,
		});
	} else {
		graph = await graphFromPackageDependencies({
			rootConfigPath: argv.config,
			versionOverride: argv.frameworkVersion,
			cacheMode: argv.cacheMode,
			workspaceConfigPath: argv.workspaceConfig,
			workspaceName: argv.workspace === false ? null : argv.workspace,
		});
	}
	const buildSettings = graph.getRoot().getBuilderSettings() || {};
	const buildOptions = {
		graph,
		destPath: argv.dest,
		cleanDest: argv["clean-dest"],
		createBuildManifest: argv["create-build-manifest"],
		dependencyIncludes: {
			includeAllDependencies: argv["include-all-dependencies"],
			includeDependency: argv["include-dependency"],
			includeDependencyRegExp: argv["include-dependency-regexp"],
			includeDependencyTree: argv["include-dependency-tree"],
			excludeDependency: argv["exclude-dependency"],
			excludeDependencyRegExp: argv["exclude-dependency-regexp"],
			excludeDependencyTree: argv["exclude-dependency-tree"],
			defaultIncludeDependency: buildSettings.includeDependency,
			defaultIncludeDependencyRegExp: buildSettings.includeDependencyRegExp,
			defaultIncludeDependencyTree: buildSettings.includeDependencyTree
		},
		selfContained: command === "self-contained",
		jsdoc: command === "jsdoc",
		includedTasks: argv["include-task"],
		excludedTasks: argv["exclude-task"],
		cssVariables: argv["experimental-css-variables"],
		outputStyle: argv["output-style"],
	};

	let prerequisiteBuildDelegated = false;
	if (command === "experimental-source-esm" && process.versions.bun) {
		try {
			await runExperimentalSourceEsmPrerequisiteBuildWithNode(argv);
			prerequisiteBuildDelegated = true;
		} catch (error) {
			if (error?.code !== "ENOENT") {
				throw error;
			}
		}
	}

	if (!prerequisiteBuildDelegated) {
		await graph.build(buildOptions);
	}

	if (command === "experimental-source-esm") {
		const {default: buildExperimentalSourceEsm} = await import("../../framework/experimentalSourceEsm.js");
		await buildExperimentalSourceEsm({
			projectRoot: process.cwd(),
			runtimeDistDir: path.resolve(process.cwd(), argv.dest)
		});
	}
}

function noop() {}

export default build;
