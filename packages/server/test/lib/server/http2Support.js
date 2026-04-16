import test from "ava";
import {getUnsupportedHttp2Message} from "../../../lib/http2Support.js";

test("No HTTP/2 warning for supported Node runtime", (t) => {
	t.is(getUnsupportedHttp2Message({
		node: "22.20.0"
	}), null);
});

test("HTTP/2 warning for Node 24", (t) => {
	t.is(getUnsupportedHttp2Message({
		node: "24.0.0"
	}), "ERROR: With Node v24, usage of HTTP/2 is no longer supported. Please check https://github.com/UI5/cli/issues/327 for updates.");
});

test("No HTTP/2 warning for Bun runtime", (t) => {
	t.is(getUnsupportedHttp2Message({
		bun: "1.3.1",
		node: "24.3.0"
	}), null);
});