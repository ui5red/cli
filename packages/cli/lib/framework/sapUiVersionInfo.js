import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

export default async function ensureSapUiVersionInfo({resourcesDir, ui5YamlPath, logger = defaultLogger}) {
	const sapUiVersionPath = path.join(resourcesDir, "sap-ui-version.json");

	try {
		await readFile(sapUiVersionPath, "utf8");
		return {
			created: false,
			sapUiVersionPath,
		};
	} catch (error) {
		if (error?.code !== "ENOENT") {
			throw error;
		}
	}

	const frameworkConfig = await readFrameworkConfig(ui5YamlPath);
	const payload = {
		name: frameworkConfig.name ?? "OpenUI5",
		version: frameworkConfig.version ?? "0.0.0-bridge-free-source",
		buildTimestamp: null,
		scmRevision: null,
		libraries: frameworkConfig.libraries.map((name) => ({name})),
	};

	await mkdir(path.dirname(sapUiVersionPath), {recursive: true});
	await writeFile(sapUiVersionPath, `${JSON.stringify(payload, null, 2)}\n`);
	logger(`Synthesized ${sapUiVersionPath}`);

	return {
		created: true,
		payload,
		sapUiVersionPath,
	};
}

async function readFrameworkConfig(ui5YamlPath) {
	const yamlText = await readFile(ui5YamlPath, "utf8");
	const frameworkConfig = {
		name: null,
		version: null,
		libraries: [],
	};

	let inFramework = false;
	let inLibraries = false;

	for (const line of yamlText.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const indent = line.match(/^\s*/)[0].length;
		if (indent === 0) {
			inFramework = trimmed === "framework:";
			inLibraries = false;
			continue;
		}

		if (!inFramework) {
			continue;
		}

		if (indent === 2 && trimmed.startsWith("name:")) {
			frameworkConfig.name = parseYamlScalar(trimmed);
			continue;
		}

		if (indent === 2 && trimmed.startsWith("version:")) {
			frameworkConfig.version = parseYamlScalar(trimmed);
			continue;
		}

		if (indent === 2 && trimmed === "libraries:") {
			inLibraries = true;
			continue;
		}

		if (indent === 4 && inLibraries && trimmed.startsWith("- name:")) {
			frameworkConfig.libraries.push(parseYamlScalar(trimmed.replace(/^\-\s*/, "")));
			continue;
		}

		if (indent <= 2) {
			inLibraries = false;
		}
	}

	return frameworkConfig;
}

function parseYamlScalar(line) {
	const [, rawValue = ""] = line.split(/:\s*/, 2);
	return rawValue.replace(/^['"]|['"]$/g, "");
}

function defaultLogger(message) {
	console.log(`[bridge-free-source] ${message}`);
}