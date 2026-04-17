import test from "ava";
import sinonGlobal from "sinon";
import esmock from "esmock";

test.beforeEach(async (t) => {
	const sinon = t.context.sinon = sinonGlobal.createSandbox();

	const Ajv = t.context.Ajv = sinon.stub();
	const ajvErrors = t.context.ajvErrors = sinon.stub();

	t.context.validatorModule = await esmock.p("../../../lib/validation/validator.js", {
		"ajv": Ajv,
		"ajv-errors": ajvErrors
	});
	const {validate, validateWorkspace, _Validator: Validator} = t.context.validatorModule;

	t.context.validate = validate;
	t.context.validateWorkspace = validateWorkspace;
	t.context.Validator = Validator;
});

test.afterEach.always((t) => {
	t.context.sinon.restore();
	esmock.purge(t.context.validatorModule);
});

test("validate function calls Validator#validate method", async (t) => {
	const {sinon, Validator, validate} = t.context;
	const config = {config: true};
	const project = {project: true};
	const yaml = {yaml: true};

	const validateStub = sinon.stub(Validator.prototype, "validate");
	validateStub.resolves();

	const result = await validate({config, project, yaml});

	t.is(result, undefined, "validate should return undefined");
	t.is(validateStub.callCount, 1, "validate should be called once");
	t.deepEqual(validateStub.getCall(0).args, [{config, project, yaml}]);
});

test("validateWorkspace function calls Validator#validate method without project", async (t) => {
	const {sinon, Validator, validateWorkspace} = t.context;
	const config = {config: true};
	const yaml = {yaml: true};

	const validateStub = sinon.stub(Validator.prototype, "validate");
	validateStub.resolves();

	const result = await validateWorkspace({config, yaml});

	t.is(result, undefined, "validate should return undefined");
	t.is(validateStub.callCount, 1, "validate should be called once");
	t.deepEqual(validateStub.getCall(0).args, [{config, yaml}]);
});

test("validateWorkspace throw an Error", async (t) => {
	const {validateWorkspace} = await esmock("../../../lib/validation/validator.js");
	const config = {config: true};
	const yaml = {yaml: true};

	const err = await t.throwsAsync(async () => {
		return await validateWorkspace({config, yaml});
	});

	t.is(err.message.includes("Invalid workspace configuration."), true);
});

test("Validator requires schemaName", (t) => {
	const {sinon, Validator} = t.context;

	const Ajv = sinon.stub();
	const ajvErrors = sinon.stub();
	const invalidContructor = () => {
		new Validator({Ajv, ajvErrors});
	};

	t.throws(invalidContructor, {
		message:
			"\"schemaName\" is missing or incorrect. The available schemaName variants are ui5, ui5-workspace",
	});
});

test("Validator requires a valid schemaName", (t) => {
	const {sinon, Validator} = t.context;

	const Ajv = sinon.stub();
	const ajvErrors = sinon.stub();
	const invalidContructor = () => {
		new Validator({Ajv, ajvErrors, schemaName: "invalid schema name"});
	};

	t.throws(invalidContructor, {
		message:
			"\"schemaName\" is missing or incorrect. The available schemaName variants are ui5, ui5-workspace",
	});
});

test("Validator#_compileSchema cache test", async (t) => {
	const {sinon, Validator} = t.context;

	const schema1 = {schema1: true};

	const loadSchemaStub = sinon.stub(Validator, "loadSchema");
	loadSchemaStub.onCall(0).resolves(schema1);
	loadSchemaStub.resolves({schema2: true});

	const schema1Fn = sinon.stub().named("schema1Fn");

	const compileAsyncStub = sinon.stub().resolves();
	compileAsyncStub.onCall(0).resolves(schema1Fn);
	compileAsyncStub.resolves(sinon.stub().named("schema2Fn"));

	const Ajv = sinon.stub().returns({
		compileAsync: compileAsyncStub
	});
	const ajvErrors = sinon.stub();

	const validator = new Validator({Ajv, ajvErrors, schemaName: "ui5-workspace"});

	const compile1 = validator._compileSchema();
	const compile2 = validator._compileSchema();
	const compile3 = validator._compileSchema();

	const compile1Result = await compile1;
	const compile2Result = await compile2;
	const compile3Result = await compile3;

	t.is(compile1Result, compile2Result);
	t.is(compile2Result, compile3Result);

	t.is(loadSchemaStub.callCount, 1);
	t.deepEqual(loadSchemaStub.getCall(0).args, ["ui5-workspace.json"]);

	t.is(compileAsyncStub.callCount, 1);
	t.deepEqual(compileAsyncStub.getCall(0).args, [schema1]);
});

// --- Negative test cases ---

test("Validator#validate throws ValidationError on invalid config", async (t) => {
	const {sinon, Validator} = t.context;

	const validationErrors = [{keyword: "required", message: "must have required property 'specVersion'"}];
	const schema = {type: "object"};

	const validateFn = sinon.stub().returns(false);
	validateFn.errors = validationErrors;
	validateFn.schema = schema;

	const compileAsyncStub = sinon.stub().resolves(validateFn);
	const loadSchemaStub = sinon.stub(Validator, "loadSchema").resolves({}); // eslint-disable-line no-unused-vars

	const Ajv = sinon.stub().returns({
		compileAsync: compileAsyncStub
	});
	const ajvErrors = sinon.stub();

	const validator = new Validator({Ajv, ajvErrors, schemaName: "ui5"});

	const error = await t.throwsAsync(() =>
		validator.validate({config: {}, project: {id: "test-project"}})
	);

	t.truthy(error);
	t.is(error.name, "ValidationError");
});

test("Validator constructor throws with null schemaName", (t) => {
	const {sinon} = t.context;
	const Ajv = sinon.stub();
	const ajvErrors = sinon.stub();

	t.throws(() => {
		new t.context.Validator({Ajv, ajvErrors, schemaName: null});
	}, {
		message: /schemaName.*missing or incorrect/
	});
});

test("Validator constructor throws with empty string schemaName", (t) => {
	const {sinon} = t.context;
	const Ajv = sinon.stub();
	const ajvErrors = sinon.stub();

	t.throws(() => {
		new t.context.Validator({Ajv, ajvErrors, schemaName: ""});
	}, {
		message: /schemaName.*missing or incorrect/
	});
});

test("validate function propagates ValidationError from Validator#validate", async (t) => {
	const {sinon, Validator, validate} = t.context;

	const validationError = new Error("Invalid configuration.");
	validationError.name = "ValidationError";

	sinon.stub(Validator.prototype, "validate").rejects(validationError);

	const error = await t.throwsAsync(() =>
		validate({config: {}, project: {id: "test"}})
	);

	t.is(error.name, "ValidationError");
	t.is(error.message, "Invalid configuration.");
});

test("validate function passes through config, project, and yaml", async (t) => {
	const {sinon, Validator, validate} = t.context;

	const validateStub = sinon.stub(Validator.prototype, "validate").resolves();

	const config = {specVersion: "4.0", type: "application", metadata: {name: "test"}};
	const project = {id: "my-project"};
	const yaml = {path: "/path/to/ui5.yaml", source: "specVersion: '4.0'"};

	await validate({config, project, yaml});

	t.is(validateStub.callCount, 1);
	t.deepEqual(validateStub.getCall(0).args[0], {config, project, yaml});
});

test("validateWorkspace passes config without project property", async (t) => {
	const {sinon, Validator, validateWorkspace} = t.context;

	const validateStub = sinon.stub(Validator.prototype, "validate").resolves();

	const config = {specVersion: "workspace/1.0"};

	await validateWorkspace({config});

	t.is(validateStub.callCount, 1);
	t.deepEqual(validateStub.getCall(0).args[0], {config});
});
