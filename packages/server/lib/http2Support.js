export function getUnsupportedHttp2Message(
	processVersions = process.versions
) {
	if (processVersions.bun) {
		return null;
	}

	const nodeVersion = parseInt(processVersions.node.split(".")[0], 10);
	if (nodeVersion >= 24) {
		return "ERROR: With Node v24, usage of HTTP/2 is no longer supported. Please check https://github.com/UI5/cli/issues/327 for updates.";
	}

	return null;
}