import test from "ava";
import {getUnsupportedHttp2Message} from "../../../lib/http2Support.js";

test("No HTTP/2 warning for supported Node runtime", (t) => {
	t.is(getUnsupportedHttp2Message({
		node: "22.20.0"
	}), null);
});

test("HTTP/2 warning for Node 24", (t) => {
	const msg = getUnsupportedHttp2Message({
		node: "24.0.0"
	});
	t.truthy(msg);
	t.true(msg.startsWith("ERROR:"));
	t.true(msg.includes("Node v24"));
	t.true(msg.includes("HTTP/2"));
});

test("HTTP/2 warning for Node 25+", (t) => {
	const msg = getUnsupportedHttp2Message({
		node: "25.1.0"
	});
	t.truthy(msg);
	t.true(msg.includes("Node v24"));
});

test("No HTTP/2 warning for Bun runtime", (t) => {
	t.is(getUnsupportedHttp2Message({
		bun: "1.3.1",
		node: "24.3.0"
	}), null);
});

test("No HTTP/2 warning for Node 22", (t) => {
	t.is(getUnsupportedHttp2Message({
		node: "22.0.0"
	}), null);
});

test("No HTTP/2 warning for Node 18", (t) => {
	t.is(getUnsupportedHttp2Message({
		node: "18.19.0"
	}), null);
});

test("Uses process.versions as default parameter", (t) => {
	// Calling without args should not throw
	const result = getUnsupportedHttp2Message();
	t.is(typeof result === "string" || result === null, true);
});
