import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";

const defaultRoot = resolve(import.meta.dirname, "..");
const root = process.argv[2] === "--root" ? resolve(process.argv[3] ?? "") : defaultRoot;
const sourceRoots = ["app", "back", "hosted", "shared"];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const aliases = { "@back/": "back/", "@shared/": "shared/types/", "@hosted/": "hosted/" };
const forbiddenFeatureCapabilities = new Set([
	"fetch",
	"WebSocket",
	"XMLHttpRequest",
	"EventSource",
	"process",
	"eval",
	"Function",
]);
const controlledObserverGlobals = new Set([
	"process",
	"fetch",
	"globalThis",
	"global",
	"self",
	"window",
	"Reflect",
	"Proxy",
	"Object",
	"eval",
	"Function",
	"WebSocket",
	"XMLHttpRequest",
	"EventSource",
]);
const boundarySources = [
	["types", "back/services/magicBlockDevnetPreflightTypes"],
	["canonical helpers", "back/services/magicBlockDevnetPreflightCanonical"],
	["observation contracts", "back/services/magicBlockDevnetObservationContracts"],
	["producer", "back/services/magicBlockDevnetPreflightProducer"],
	["adapter", "back/services/magicBlockDevnetPreflightAdapter"],
	["integration caller", "back/services/magicBlockDevnetPreflightIntegration"],
	["audit writer", "back/services/magicBlockDevnetPreflightAuditWriter"],
	["unsigned v0 decoder", "back/services/magicBlockDevnetTransactionDecoder"],
	["request scope", "back/services/magicBlockDevnetRequestScope"],
	["literal HTTPS transport", "back/services/magicBlockDevnetHttpsTransport"],
];
const baseRequiredIngressSources = [
	["audit ingress", "hosted/magicblock/magicBlockAuditIngress"],
	["audit ingress composition", "hosted/magicblock/magicBlockAuditIngressFromEnv"],
	["observation store", "hosted/magicblock/magicBlockObservationStorePg"],
	["append-only ledger", "hosted/magicblock/magicBlockAuditLedgerPg"],
	["audit ingress entrypoint", "app/api/magicblock-devnet/audit/route"],
];
const proofImportIngressSources = [
	["audit proof verification contracts", "back/services/magicBlockAuditProofVerificationContracts"],
	["audit proof verification", "back/services/magicBlockAuditProofVerification"],
	["audit commitment materializer", "back/services/magicBlockAuditCommitment"],
	["audit proof import contracts", "back/services/magicBlockAuditProofImportContracts"],
	["audit proof record store", "hosted/magicblock/magicBlockAuditProofRecordStorePg"],
	["audit ingress authorization", "hosted/magicblock/magicBlockIngressAuth"],
	["audit proof import ingress", "hosted/magicblock/magicBlockAuditProofImportIngress"],
	["audit proof import composition", "hosted/magicblock/magicBlockAuditProofImportIngressFromEnv"],
	["audit proof import entrypoint", "app/api/magicblock-devnet/audit/import/route"],
	["audit read ingress", "hosted/magicblock/magicBlockAuditReadIngress"],
	["audit read ingress composition", "hosted/magicblock/magicBlockAuditReadIngressFromEnv"],
	["audit read GET entrypoint", "app/api/magicblock-devnet/audit/routeGet"],
	["audit POST entrypoint", "app/api/magicblock-devnet/audit/routePost"],
];
const requiredIngressSources = [
	...baseRequiredIngressSources,
	...(proofImportIngressSources.some(([, source]) => resolveFile(resolve(root, source)))
		? proofImportIngressSources
		: []),
];
const requiredObserverSources = [
	["MCP observer contracts", "back/services/mcp/observer/magicBlockMcpObserverContracts"],
	["MCP structured-content extractor", "back/services/mcp/observer/magicBlockMcpObservationExtractor"],
	["MCP observer config", "back/services/mcp/observer/magicBlockMcpObserverConfig"],
	["MCP hosted audit client", "back/services/mcp/observer/magicBlockHostedAuditClient"],
	["MCP audit observer", "back/services/mcp/observer/magicBlockMcpObserver"],
	["MCP server observer seam", "back/services/mcp/server/mcpProxyServerContracts"],
	["MCP server entrypoint", "back/services/mcp/server/mcpServer"],
];
const allowedObserverDirectEdgeSources = new Map([
	["MCP observer contracts", []],
	[
		"MCP structured-content extractor",
		[
			"back/services/magicBlockDevnetObservationContracts",
			"back/services/magicBlockDevnetPreflightCanonical",
			"back/services/mcp/observer/magicBlockMcpObserverContracts",
		],
	],
	[
		"MCP observer config",
		["back/services/mcp/observer/magicBlockMcpObserverContracts"],
	],
	[
		"MCP hosted audit client",
		[
			"back/services/magicBlockDevnetPreflightCanonical",
			"back/services/mcp/observer/magicBlockMcpObserverContracts",
			"back/services/mcp/observer/magicBlockMcpObserverConfig",
		],
	],
	[
		"MCP audit observer",
		["back/services/mcp/observer/magicBlockMcpObserverContracts"],
	],
	[
		"MCP server observer seam",
		[
			"back/services/mcp/proxy/mcpProxyContracts",
			"back/services/mcp/observer/magicBlockMcpObserverContracts",
		],
	],
	[
		"MCP server entrypoint",
		[
			"back/posthog/posthogClient",
			"back/guardrail/debugLogger",
			"back/services/envConfig",
			"back/services/mcp/config/loadRepoEnv",
			"back/services/mcp/proxy/mcpProxyContracts",
			"back/services/mcp/proxy/mcpProxyDispatcher",
			"back/services/mcp/server/mcpProxyServerContracts",
			"back/services/mcp/config/mcpRuntimeConfig",
			"back/services/mcp/proxy/mcpHostedClient",
			"back/services/mcp/proxy/mcpProxyAudit",
			"back/services/mcp/observer/magicBlockMcpObserverConfig",
			"back/services/mcp/observer/magicBlockHostedAuditClient",
			"back/services/mcp/observer/magicBlockMcpObserver",
			"back/services/mcp/observer/magicBlockMcpObserverContracts",
			"back/services/mcp/observer/magicBlockMcpObservationExtractor",
		],
	],
]);
const allowedObserverExternalSpecifiers = new Map([
	["MCP observer contracts", []],
	["MCP structured-content extractor", []],
	["MCP observer config", []],
	["MCP hosted audit client", []],
	["MCP audit observer", []],
	["MCP server observer seam", ["@modelcontextprotocol/sdk/types.js"]],
	[
		"MCP server entrypoint",
		[
			"node:url",
			"node:os",
			"node:crypto",
			"@modelcontextprotocol/sdk/client/index.js",
			"@modelcontextprotocol/sdk/client/stdio.js",
			"@modelcontextprotocol/sdk/server/index.js",
			"@modelcontextprotocol/sdk/server/stdio.js",
			"@modelcontextprotocol/sdk/types.js",
		],
	],
]);
const optionalObserverDirectEdgeSources = new Set([
	"MCP hosted audit client:back/services/magicBlockDevnetPreflightCanonical",
]);
const allowedObserverGlobalUses = new Map([
	["MCP observer contracts", new Map()],
	[
		"MCP structured-content extractor",
		new Map([
			[
				"Object.freeze:direct-object-literal@extractMagicBlockObservationFromStructuredContent",
				1,
			],
		]),
	],
	[
		"MCP observer config",
		new Map([
			[
				"process.env:parameter-default-env@readMagicBlockMcpObserverEnvConfig",
				1,
			],
		]),
	],
	[
		"MCP hosted audit client",
		new Map([
			[
				"globalThis.fetch:direct-call-url-init@createMagicBlockHostedAuditClient",
				1,
			],
		]),
	],
	["MCP audit observer", new Map()],
	["MCP server observer seam", new Map()],
	[
		"MCP server entrypoint",
		new Map([
			["process.cwd:direct-call@resolveLocalInstallationId", 1],
			["process.exit:direct-call-literal-1@<top-level>", 1],
			["process.argv:index-1-logical-left@isDirectExecution", 1],
			["process.argv:index-1-pathToFileURL-arg@isDirectExecution", 1],
			["process.env:object-spread@startClient", 1],
		]),
	],
]);
const allowedObserverComputedMemberUses = new Map([
	["MCP observer contracts", new Map()],
	[
		"MCP structured-content extractor",
		new Map([
			[
				"value:index-last-data-character@isBoundedCanonicalBase64",
				1,
			],
		]),
	],
	[
		"MCP observer config",
		new Map([
			[
				"env:index-ENABLED_ENV@readMagicBlockMcpObserverEnvConfig",
				1,
			],
			["env:index-URL_ENV@readMagicBlockMcpObserverEnvConfig", 1],
			["env:index-API_KEY_ENV@readMagicBlockMcpObserverEnvConfig", 1],
			["env:index-TIMEOUT_ENV@readMagicBlockMcpObserverEnvConfig", 1],
		]),
	],
	["MCP hosted audit client", new Map()],
	["MCP audit observer", new Map()],
	["MCP server observer seam", new Map()],
	[
		"MCP server entrypoint",
		new Map([
			[
				"process.argv:index-1-logical-left@isDirectExecution",
				1,
			],
			[
				"process.argv:index-1-pathToFileURL-arg@isDirectExecution",
				1,
			],
		]),
	],
]);
const protectedBoundaryMatchers = [
	["tool dispatcher", (path) => path === "back/services/mcp/proxy/mcpProxyDispatcher.ts" || /tool.*dispatch|dispatch.*tool/i.test(path)],
	["policy output", (path) =>
		path === "back/services/mcp/proxy/mcpProxyPolicyInterceptor.ts" ||
		path.startsWith("back/guardrail/policy/") ||
		path.startsWith("hosted/policy/") ||
		path.startsWith("hosted/policies/") ||
		/policy.*(?:output|decision)|(?:output|decision).*policy/i.test(path)],
	["confirmation gate", (path) => path === "hosted/verify/verifyConfirmService.ts" || path === "hosted/onchain/onchainApproval.ts" || /confirm/i.test(path)],
	["simulator", (path) => path === "back/guardrail/execution/executionGateway.ts" || /simulat/i.test(path)],
	["executor", (path) => path === "back/guardrail/execution/executionGateway.ts" || /(?:transaction.*execut|execut.*transaction|(?:transfer|swap|conditional)Gateway)/i.test(path)],
	["execution gateway", (path) => path.startsWith("back/guardrail/execution/")],
	["signer", (path) => /signer/i.test(path)],
	["sender", (path) => /sender/i.test(path)],
	["submitter", (path) => /submitter/i.test(path)],
	["permission handler", (path) => /permission/i.test(path)],
	["transaction executor", (path) => /transaction.*execut|execut.*transaction/i.test(path)],
	["commit handler", (path) => /commit/i.test(path)],
	["delegation handler", (path) => /(?:^|[/_.-])delegation/i.test(path)],
	["undelegation handler", (path) => /undelegat/i.test(path)],
	["registry writer", (path) => /registry.*(?:write|writer)|(?:write|writer).*registry/i.test(path)],
];

function sourceFiles(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = resolve(directory, entry.name);
		if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
		return sourceExtensions.has(extname(entry.name)) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
	});
}

function resolveFile(candidate) {
	const candidates = sourceExtensions.has(extname(candidate)) ? [candidate] : [
		...[...sourceExtensions].map((extension) => `${candidate}${extension}`),
		...[...sourceExtensions].map((extension) => resolve(candidate, `index${extension}`)),
	];
	return candidates.find((file) => existsSync(file) && statSync(file).isFile());
}

function resolveImport(from, specifier) {
	if (specifier.startsWith("node:")) return null;
	for (const [alias, target] of Object.entries(aliases)) {
		if (specifier.startsWith(alias)) return resolve(root, target, specifier.slice(alias.length));
	}
	if (specifier.startsWith(".")) return resolve(dirname(from), specifier);
	if (specifier.startsWith("/")) return resolve(specifier);
	return null;
}

function isLocalSpecifier(specifier) {
	return (
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		Object.keys(aliases).some((alias) => specifier.startsWith(alias))
	);
}

function imports(file) {
	const source = readFileSync(file, "utf8");
	const extension = extname(file);
	const scriptKind =
		extension === ".tsx" || extension === ".jsx"
			? ts.ScriptKind.TSX
			: extension === ".js" || extension === ".mjs" || extension === ".cjs"
				? ts.ScriptKind.JS
				: ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKind,
	);
	const specifiers = [];
	const forbiddenCapabilities = new Set();
	let hasNonliteralDynamic = false;
	let hasDynamicImport = false;
	let hasCommonJs = false;
	let hasCreateRequire = false;
	const runtimeModuleLoaders = new Set();
	const controlledGlobalUses = [];
	const computedMemberUses = [];
	const reflectiveCapabilities = new Set();
	const bindingPatternBypasses = [];

	function unparenthesized(node) {
		while (ts.isParenthesizedExpression(node)) node = node.expression;
		return node;
	}

	function staticString(node) {
		const expression = unparenthesized(node);
		if (ts.isStringLiteralLike(expression)) return expression.text;
		if (
			ts.isBinaryExpression(expression) &&
			expression.operatorToken.kind === ts.SyntaxKind.PlusToken
		) {
			const left = staticString(expression.left);
			const right = staticString(expression.right);
			return left !== undefined && right !== undefined
				? `${left}${right}`
				: undefined;
		}
		return undefined;
	}

	function accessedPropertyName(expression) {
		if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
		if (
			ts.isElementAccessExpression(expression) &&
			expression.argumentExpression
		) {
			return staticString(expression.argumentExpression);
		}
		return undefined;
	}

	function enclosingNamedFunction(node) {
		let current = node.parent;
		while (current) {
			if (
				(ts.isFunctionDeclaration(current) ||
					ts.isFunctionExpression(current) ||
					ts.isMethodDeclaration(current)) &&
				current.name &&
				ts.isIdentifier(current.name)
			) {
				return current.name.text;
			}
			current = current.parent;
		}
		return "<top-level>";
	}

	function controlledGlobalUse(identifier) {
		const parent = identifier.parent;
		const context = enclosingNamedFunction(identifier);
		if (
			ts.isPropertyAccessExpression(parent) &&
			parent.name === identifier
		) {
			return undefined;
		}
		if (
			identifier.text === "process" &&
			ts.isPropertyAccessExpression(parent) &&
			parent.expression === identifier &&
			!parent.questionDotToken
		) {
			const property = parent.name.text;
			const grandparent = parent.parent;
			if (
				property === "env" &&
				ts.isParameter(grandparent) &&
				grandparent.initializer === parent &&
				ts.isIdentifier(grandparent.name) &&
				grandparent.name.text === "env"
			) {
				return `process.env:parameter-default-env@${context}`;
			}
			if (
				property === "env" &&
				ts.isSpreadAssignment(grandparent) &&
				grandparent.expression === parent
			) {
				return `process.env:object-spread@${context}`;
			}
			if (
				property === "argv" &&
				ts.isElementAccessExpression(grandparent) &&
				grandparent.expression === parent &&
				!grandparent.questionDotToken &&
				ts.isNumericLiteral(grandparent.argumentExpression) &&
				grandparent.argumentExpression.text === "1"
			) {
				if (
					ts.isBinaryExpression(grandparent.parent) &&
					grandparent.parent.left === grandparent &&
					grandparent.parent.operatorToken.kind ===
						ts.SyntaxKind.AmpersandAmpersandToken
				) {
					return `process.argv:index-1-logical-left@${context}`;
				}
				if (
					ts.isCallExpression(grandparent.parent) &&
					ts.isIdentifier(grandparent.parent.expression) &&
					grandparent.parent.expression.text === "pathToFileURL" &&
					grandparent.parent.arguments.length === 1 &&
					grandparent.parent.arguments[0] === grandparent
				) {
					return `process.argv:index-1-pathToFileURL-arg@${context}`;
				}
			}
			if (
				property === "cwd" &&
				ts.isCallExpression(grandparent) &&
				grandparent.expression === parent &&
				!grandparent.questionDotToken &&
				grandparent.arguments.length === 0
			) {
				return `process.cwd:direct-call@${context}`;
			}
			if (
				property === "exit" &&
				ts.isCallExpression(grandparent) &&
				grandparent.expression === parent &&
				!grandparent.questionDotToken &&
				grandparent.arguments.length === 1 &&
				ts.isNumericLiteral(grandparent.arguments[0]) &&
				grandparent.arguments[0].text === "1"
			) {
				return `process.exit:direct-call-literal-1@${context}`;
			}
		}
		if (
			identifier.text === "globalThis" &&
			ts.isPropertyAccessExpression(parent) &&
			parent.expression === identifier &&
			parent.name.text === "fetch" &&
			!parent.questionDotToken &&
			ts.isCallExpression(parent.parent) &&
			parent.parent.expression === parent &&
			!parent.parent.questionDotToken &&
			parent.parent.arguments.length === 2 &&
			ts.isIdentifier(parent.parent.arguments[0]) &&
			parent.parent.arguments[0].text === "url" &&
			ts.isIdentifier(parent.parent.arguments[1]) &&
			parent.parent.arguments[1].text === "init"
		) {
			return `globalThis.fetch:direct-call-url-init@${context}`;
		}
		if (
			identifier.text === "Object" &&
			ts.isPropertyAccessExpression(parent) &&
			parent.expression === identifier &&
			parent.name.text === "freeze" &&
			!parent.questionDotToken &&
			ts.isCallExpression(parent.parent) &&
			parent.parent.expression === parent &&
			!parent.parent.questionDotToken &&
			parent.parent.arguments.length === 1 &&
			ts.isObjectLiteralExpression(parent.parent.arguments[0])
		) {
			return `Object.freeze:direct-object-literal@${context}`;
		}
		return `${identifier.text}:unapproved-reference@${context}`;
	}

	function computedMemberUse(node) {
		const context = enclosingNamedFunction(node);
		if (
			!node.questionDotToken &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "env" &&
			ts.isIdentifier(node.argumentExpression) &&
			["ENABLED_ENV", "URL_ENV", "API_KEY_ENV", "TIMEOUT_ENV"].includes(
				node.argumentExpression.text,
			)
		) {
			return `env:index-${node.argumentExpression.text}@${context}`;
		}
		if (
			!node.questionDotToken &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "value" &&
			ts.isBinaryExpression(node.argumentExpression) &&
			node.argumentExpression.operatorToken.kind ===
				ts.SyntaxKind.MinusToken &&
			ts.isNumericLiteral(node.argumentExpression.right) &&
			node.argumentExpression.right.text === "1" &&
			ts.isBinaryExpression(node.argumentExpression.left) &&
			node.argumentExpression.left.operatorToken.kind ===
				ts.SyntaxKind.MinusToken &&
			ts.isPropertyAccessExpression(node.argumentExpression.left.left) &&
			ts.isIdentifier(node.argumentExpression.left.left.expression) &&
			node.argumentExpression.left.left.expression.text === "value" &&
			node.argumentExpression.left.left.name.text === "length" &&
			ts.isIdentifier(node.argumentExpression.left.right) &&
			node.argumentExpression.left.right.text === "padding"
		) {
			return `value:index-last-data-character@${context}`;
		}
		if (
			!node.questionDotToken &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "process" &&
			node.expression.name.text === "argv" &&
			ts.isNumericLiteral(node.argumentExpression) &&
			node.argumentExpression.text === "1"
		) {
			if (
				ts.isBinaryExpression(node.parent) &&
				node.parent.left === node &&
				node.parent.operatorToken.kind ===
					ts.SyntaxKind.AmpersandAmpersandToken
			) {
				return `process.argv:index-1-logical-left@${context}`;
			}
			if (
				ts.isCallExpression(node.parent) &&
				ts.isIdentifier(node.parent.expression) &&
				node.parent.expression.text === "pathToFileURL" &&
				node.parent.arguments.length === 1 &&
				node.parent.arguments[0] === node
			) {
				return `process.argv:index-1-pathToFileURL-arg@${context}`;
			}
		}
		return `unrecognized:${node.getText(sourceFile)}@${context}`;
	}

	function visit(node) {
		if (ts.isBindingElement(node)) {
			bindingPatternBypasses.push(node.getText(sourceFile));
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken
		) {
			const target = unparenthesized(node.left);
			if (
				ts.isObjectLiteralExpression(target) ||
				ts.isArrayLiteralExpression(target)
			) {
				bindingPatternBypasses.push(target.getText(sourceFile));
			}
		}
		if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
			const target = unparenthesized(node.initializer);
			if (
				ts.isObjectLiteralExpression(target) ||
				ts.isArrayLiteralExpression(target)
			) {
				bindingPatternBypasses.push(target.getText(sourceFile));
			}
		}
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		}
		if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteralLike(node.argument.literal)
		) {
			specifiers.push(node.argument.literal.text);
		}
		if (ts.isImportEqualsDeclaration(node)) hasCommonJs = true;
		if (ts.isCallExpression(node)) {
			const expression = unparenthesized(node.expression);
			if (expression.kind === ts.SyntaxKind.ImportKeyword) {
				hasDynamicImport = true;
				if (
					node.arguments.length === 1 &&
					ts.isStringLiteralLike(node.arguments[0])
				) {
					specifiers.push(node.arguments[0].text);
				} else {
					hasNonliteralDynamic = true;
				}
			}
			if (ts.isIdentifier(expression) && expression.text === "require") {
				hasCommonJs = true;
			}
			const propertyName = accessedPropertyName(expression);
			if (propertyName === "require") hasCommonJs = true;
			if (propertyName === "constructor" || propertyName === "__proto__") {
				reflectiveCapabilities.add(propertyName);
			}
			if (
				propertyName &&
				["getBuiltinModule", "binding", "dlopen"].includes(propertyName)
			) {
				const receiver = unparenthesized(expression.expression);
				if (ts.isIdentifier(receiver) && receiver.text === "process") {
					runtimeModuleLoaders.add(`process.${propertyName}`);
				}
			}
		}
		if (ts.isIdentifier(node)) {
			if (forbiddenFeatureCapabilities.has(node.text)) {
				forbiddenCapabilities.add(node.text);
			}
			if (node.text === "require") hasCommonJs = true;
			if (node.text === "createRequire") hasCreateRequire = true;
			if (controlledObserverGlobals.has(node.text)) {
				const use = controlledGlobalUse(node);
				if (use) controlledGlobalUses.push(use);
			}
		}
		if (
			ts.isPropertyAccessExpression(node) &&
			(node.name.text === "constructor" || node.name.text === "__proto__")
		) {
			reflectiveCapabilities.add(node.name.text);
		}
		if (
			ts.isElementAccessExpression(node) &&
			node.argumentExpression
		) {
			computedMemberUses.push(computedMemberUse(node));
			const propertyName = staticString(node.argumentExpression);
			if (propertyName && forbiddenFeatureCapabilities.has(propertyName)) {
				forbiddenCapabilities.add(propertyName);
			}
			if (
				propertyName === "constructor" ||
				propertyName === "__proto__"
			) {
				reflectiveCapabilities.add(propertyName);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return {
		specifiers,
		forbiddenCapabilities: [...forbiddenCapabilities],
		hasNonliteralDynamic,
		hasDynamicImport,
		hasCommonJs,
		hasCreateRequire,
		runtimeModuleLoaders: [...runtimeModuleLoaders],
		controlledGlobalUses,
		computedMemberUses,
		reflectiveCapabilities: [...reflectiveCapabilities],
		bindingPatternBypasses,
		hasParseErrors: sourceFile.parseDiagnostics.length > 0,
	};
}

const preflightBoundaries = boundarySources.map(([role, source]) => ({
	role,
	file: resolveFile(resolve(root, source)),
}));
const preflightFiles = preflightBoundaries.flatMap(({ file }) => file ? [file] : []);
if (preflightFiles.length === 0) {
	throw new Error("incomplete MagicBlock preflight topology: no MagicBlock preflight boundary modules found");
}
const missingPreflightRoles = preflightBoundaries.filter(({ file }) => !file).map(({ role }) => role);
if (missingPreflightRoles.length > 0) {
	throw new Error(`incomplete MagicBlock preflight topology: missing ${missingPreflightRoles.join(", ")}`);
}
const allowedIngressBoundaries = requiredIngressSources.map(([role, source]) => ({
	role,
	file: resolveFile(resolve(root, source)),
}));
const missingIngressRoles = allowedIngressBoundaries
	.filter(({ file }) => !file)
	.map(({ role }) => role);
if (missingIngressRoles.length > 0) {
	throw new Error(`incomplete MagicBlock audit ingress topology: missing ${missingIngressRoles.join(", ")}`);
}
const allowedIngressRoots = allowedIngressBoundaries
	.filter(({ role }) => role === "audit ingress entrypoint" || role === "audit proof import entrypoint")
	.map(({ file }) => file);
const allowedObserverBoundaries = requiredObserverSources.map(([role, source]) => ({
	role,
	file: resolveFile(resolve(root, source)),
}));
const missingObserverRoles = allowedObserverBoundaries
	.filter(({ file }) => !file)
	.map(({ role }) => role);
if (missingObserverRoles.length > 0) {
	throw new Error(
		`incomplete MagicBlock MCP observer topology: missing ${missingObserverRoles.join(", ")}`,
	);
}
const observerEntrypoints = allowedObserverBoundaries
	.filter(({ role }) => role === "MCP server entrypoint")
	.map(({ file }) => file);
const observerImplementationFiles = allowedObserverBoundaries
	.filter(({ role }) => role !== "MCP server entrypoint")
	.map(({ file }) => file);

// ponytail: scan every local source edge so reverse imports cannot hide a boundary-to-gateway path.
const files = sourceRoots.flatMap((directory) => sourceFiles(resolve(root, directory)));
const graph = new Map(files.map((file) => [file, []]));
const analysis = new Map();
for (const file of files) {
	const parsed = imports(file);
	const unresolved = [];
	const outsideSourceRoots = [];
	analysis.set(file, { ...parsed, unresolved, outsideSourceRoots });
	for (const specifier of parsed.specifiers) {
		const candidate = resolveImport(file, specifier);
		if (candidate === null) continue;
		const dependency = resolveFile(candidate);
		if (!dependency) {
			unresolved.push(specifier);
			continue;
		}
		if (!graph.has(dependency)) {
			outsideSourceRoots.push(specifier);
			continue;
		}
		graph.get(file).push(dependency);
	}
}

function assertEsmFeatureModules() {
	const seen = new Set();
	const pending = [...preflightFiles];
	while (pending.length) {
		const file = pending.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const parsed = analysis.get(file);
		if (
			[".cjs", ".cts"].includes(extname(file)) ||
			parsed?.hasCommonJs ||
			parsed?.hasCreateRequire
		) {
			throw new Error(`unsupported CommonJS preflight/feature module: ${relative(root, file)}; .cjs/.cts files and require usage are not allowed`);
		}
		if (parsed?.hasParseErrors) {
			throw new Error(`source parse error in ${relative(root, file)}`);
		}
		if (parsed?.hasNonliteralDynamic) {
			throw new Error(`nonliteral dynamic import in ${relative(root, file)}`);
		}
		if (parsed?.unresolved.length) {
			throw new Error(`unresolved import ${parsed.unresolved[0]} from ${relative(root, file)}`);
		}
		if (parsed?.outsideSourceRoots.length) {
			throw new Error(`out-of-scope local import ${parsed.outsideSourceRoots[0]} from ${relative(root, file)}`);
		}
		const relativeFile = relative(root, file).replaceAll("\\", "/");
		const permittedCapabilities =
			relativeFile === "back/services/magicBlockDevnetHttpsTransport.ts"
				? new Set(["fetch"])
				: relativeFile === "back/services/magicBlockOnchainAudit.ts"
					? new Set(["fetch", "process"])
				: new Set();
		const forbiddenCapability = parsed?.forbiddenCapabilities.find(
			(capability) => !permittedCapabilities.has(capability),
		);
		if (forbiddenCapability) {
			throw new Error(`forbidden runtime capability ${forbiddenCapability} in ${relative(root, file)}`);
		}
		for (const specifier of parsed?.specifiers ?? []) {
			const allowedBuiltin =
				specifier === "node:crypto" ||
				(relativeFile === "back/services/magicBlockOnchainAudit.ts" &&
					["node:fs", "node:path", "@solana/web3.js", "bs58"].includes(specifier)) ||
				(relativeFile === "back/services/magicBlockDevnetTransactionDecoder.ts" &&
					specifier === "node:buffer");
			if (
				!specifier.startsWith(".") &&
				!specifier.startsWith("/") &&
				!allowedBuiltin &&
				!Object.keys(aliases).some((alias) => specifier.startsWith(alias))
			) {
				throw new Error(`forbidden external dependency ${specifier} from ${relative(root, file)}`);
			}
		}
		pending.push(...(graph.get(file) ?? []));
	}
}

assertEsmFeatureModules();

function closure(roots) {
	const seen = new Set();
	const pending = [...roots];
	while (pending.length) {
		const file = pending.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		pending.push(...(graph.get(file) ?? []));
	}
	return seen;
}

const featureClosureFiles = closure(preflightFiles);
const allowedIngressClosureFiles = closure(allowedIngressRoots);
const explicitlyApprovedIngressFiles = new Set(
	allowedIngressBoundaries.map(({ file }) => file),
);
for (const source of [
	"back/services/magicBlockOnchainAudit",
	"hosted/magicblock/magicBlockAuditRecordStorePg",
]) {
	const file = resolveFile(resolve(root, source));
	if (file) explicitlyApprovedIngressFiles.add(file);
}
const unreachableIngressRoles = allowedIngressBoundaries
	.filter(({ file }) => !allowedIngressClosureFiles.has(file))
	.map(({ role }) => role);
if (unreachableIngressRoles.length > 0) {
	throw new Error(
		`incomplete MagicBlock audit ingress closure: unreachable ${unreachableIngressRoles.join(", ")}`,
	);
}
for (const file of allowedIngressClosureFiles) {
	const parsed = analysis.get(file);
	if (
		[".cjs", ".cts"].includes(extname(file)) ||
		parsed?.hasCommonJs ||
		parsed?.hasCreateRequire
	) {
		throw new Error(`unsupported CommonJS usage in audit ingress closure: ${relative(root, file)}`);
	}
	if (parsed?.hasParseErrors) {
		throw new Error(`source parse error in audit ingress closure: ${relative(root, file)}`);
	}
	if (parsed?.hasNonliteralDynamic) {
		throw new Error(`nonliteral dynamic import in audit ingress closure: ${relative(root, file)}`);
	}
	if (parsed?.unresolved.length) {
		throw new Error(`unresolved import ${parsed.unresolved[0]} from audit ingress closure ${relative(root, file)}`);
	}
	if (parsed?.outsideSourceRoots.length) {
		throw new Error(`out-of-scope local import ${parsed.outsideSourceRoots[0]} from audit ingress closure ${relative(root, file)}`);
	}
}

function reaches(from, target) {
	const seen = new Set();
	const pending = [from];
	while (pending.length) {
		const file = pending.pop();
		if (file === target) return true;
		if (seen.has(file)) continue;
		seen.add(file);
		pending.push(...(graph.get(file) ?? []));
	}
	return false;
}

const isolatedReadRoots = allowedIngressBoundaries
	.filter(({ role }) => role === "audit proof import entrypoint" || role === "audit read GET entrypoint")
	.map(({ file }) => file);
const isolatedReadClosure = closure(isolatedReadRoots);
for (const file of isolatedReadClosure) {
	const relativeFile = relative(root, file).replaceAll("\\", "/");
	const parsed = analysis.get(file);
	const forbiddenSpecifier = (parsed?.specifiers ?? []).find((specifier) =>
		["node:fs", "node:path", "@solana/web3.js"].includes(specifier),
	);
	if (forbiddenSpecifier) throw new Error(`read-only MagicBlock proof root imports forbidden capability ${forbiddenSpecifier} from ${relativeFile}`);
	const source = readFileSync(file, "utf8");
	if (/sendTransaction|createMagicBlockAuditSignerFromEnv|createMagicBlockOnchainAuditSubmitter|\bKeypair\b|secretKey|\.register\s*\(/.test(source)) {
		throw new Error(`read-only MagicBlock proof closure contains secret/sign/submit capability in ${relativeFile}`);
	}
}
for (const forbiddenSource of [
	"back/services/magicBlockOnchainAudit",
	"hosted/magicblock/magicBlockAuditIngress",
	"hosted/magicblock/magicBlockAuditIngressFromEnv",
	"hosted/magicblock/magicBlockAuditRecordStorePg",
]) {
	const forbiddenFile = resolveFile(resolve(root, forbiddenSource));
	if (!forbiddenFile) continue;
	for (const isolatedRoot of isolatedReadRoots) {
		if (reaches(isolatedRoot, forbiddenFile)) {
			throw new Error(`read-only MagicBlock proof root ${relative(root, isolatedRoot)} reaches secret/sign/submit capability ${relative(root, forbiddenFile)}`);
		}
	}
}

for (const boundary of allowedObserverBoundaries) {
	const allowedSources = allowedObserverDirectEdgeSources.get(boundary.role);
	const allowedExternalSources = allowedObserverExternalSpecifiers.get(
		boundary.role,
	);
	const allowedGlobalUses = allowedObserverGlobalUses.get(
		boundary.role,
	);
	const allowedComputedMemberUses = allowedObserverComputedMemberUses.get(
		boundary.role,
	);
	if (
		!allowedSources ||
		!allowedExternalSources ||
		!allowedGlobalUses ||
		!allowedComputedMemberUses
	) {
		throw new Error(
			`missing explicit MCP observer dependency policy for ${boundary.role}`,
		);
	}
	const parsed = analysis.get(boundary.file);
	if (
		[".cjs", ".cts"].includes(extname(boundary.file)) ||
		parsed?.hasCommonJs ||
		parsed?.hasCreateRequire
	) {
		throw new Error(
			`unsupported CommonJS usage in ${boundary.role}: ${relative(root, boundary.file)}`,
		);
	}
	if (parsed?.hasParseErrors) {
		throw new Error(`source parse error in ${boundary.role}: ${relative(root, boundary.file)}`);
	}
	if (parsed?.hasDynamicImport) {
		throw new Error(
			`dynamic import is not allowed in ${boundary.role}: ${relative(root, boundary.file)}`,
		);
	}
	if (parsed?.bindingPatternBypasses.length) {
		throw new Error(
			`binding/destructuring pattern is not allowed in ${boundary.role}: ${parsed.bindingPatternBypasses[0]}`,
		);
	}
	if (parsed?.runtimeModuleLoaders.length) {
		throw new Error(
			`runtime module loader ${parsed.runtimeModuleLoaders[0]} is not allowed in ${boundary.role}`,
		);
	}
	if (parsed?.reflectiveCapabilities.length) {
		throw new Error(
			`reflective capability ${parsed.reflectiveCapabilities[0]} is not allowed in ${boundary.role}`,
		);
	}
	if (parsed?.unresolved.length) {
		throw new Error(
			`unresolved import ${parsed.unresolved[0]} from ${boundary.role}`,
		);
	}
	if (parsed?.outsideSourceRoots.length) {
		throw new Error(
			`out-of-scope local import ${parsed.outsideSourceRoots[0]} from ${boundary.role}`,
		);
	}
	const actualComputedMemberUses = new Map();
	for (const use of parsed?.computedMemberUses ?? []) {
		actualComputedMemberUses.set(
			use,
			(actualComputedMemberUses.get(use) ?? 0) + 1,
		);
	}
	const unexpectedComputedMemberUse = [...actualComputedMemberUses.keys()].find(
		(use) => !allowedComputedMemberUses.has(use),
	);
	if (unexpectedComputedMemberUse) {
		throw new Error(
			`unapproved computed member access ${unexpectedComputedMemberUse} in ${boundary.role}`,
		);
	}
	for (const [use, expectedCount] of allowedComputedMemberUses) {
		const actualCount = actualComputedMemberUses.get(use) ?? 0;
		if (actualCount !== expectedCount) {
			throw new Error(
				`expected ${expectedCount} exact ${use} computed access(es) in ${boundary.role}, found ${actualCount}`,
			);
		}
	}
	const actualGlobalUses = new Map();
	for (const use of parsed?.controlledGlobalUses ?? []) {
		actualGlobalUses.set(use, (actualGlobalUses.get(use) ?? 0) + 1);
	}
	const unexpectedGlobalUse = [...actualGlobalUses.keys()].find(
		(use) => !allowedGlobalUses.has(use),
	);
	if (unexpectedGlobalUse) {
		throw new Error(
			`unapproved global capability use ${unexpectedGlobalUse} in ${boundary.role}`,
		);
	}
	for (const [use, expectedCount] of allowedGlobalUses) {
		const actualCount = actualGlobalUses.get(use) ?? 0;
		if (actualCount !== expectedCount) {
			throw new Error(
				`expected ${expectedCount} exact ${use} use(s) in ${boundary.role}, found ${actualCount}`,
			);
		}
	}
	const expectedExternalSpecifiers = new Set(allowedExternalSources);
	const actualExternalSpecifiers = new Set(
		(parsed?.specifiers ?? []).filter((specifier) => !isLocalSpecifier(specifier)),
	);
	const unexpectedExternalSpecifier = [...actualExternalSpecifiers].find(
		(specifier) => !expectedExternalSpecifiers.has(specifier),
	);
	if (unexpectedExternalSpecifier) {
		throw new Error(
			`unexpected external dependency ${unexpectedExternalSpecifier} from ${boundary.role}`,
		);
	}
	const missingExternalSpecifier = [...expectedExternalSpecifiers].find(
		(specifier) => !actualExternalSpecifiers.has(specifier),
	);
	if (missingExternalSpecifier) {
		throw new Error(
			`missing external dependency ${missingExternalSpecifier} from ${boundary.role}`,
		);
	}
	const allowedEdges = new Set(
		allowedSources.map((source) => {
			const file = resolveFile(resolve(root, source));
			if (!file) {
				throw new Error(
					`incomplete MagicBlock MCP observer edge target: ${source}`,
				);
			}
			return file;
		}),
	);
	const actualEdges = new Set(graph.get(boundary.file) ?? []);
	const unexpected = [...actualEdges].find((file) => !allowedEdges.has(file));
	if (unexpected) {
		throw new Error(
			`unauthorized direct edge from ${boundary.role}: ${relative(root, unexpected)}`,
		);
	}
	const missing = [...allowedEdges].find((file) => !actualEdges.has(file));
	if (
		missing &&
		!optionalObserverDirectEdgeSources.has(
			`${boundary.role}:${relative(root, missing).replaceAll("\\", "/").replace(/\.[^.]+$/, "")}`,
		)
	) {
		throw new Error(
			`incomplete direct edge from ${boundary.role}: ${relative(root, missing)}`,
		);
	}
}

const isolatedReadBoundaryFiles = new Set(allowedIngressBoundaries
	.filter(({ role }) => role.startsWith("audit proof") || role.startsWith("audit read") || role === "audit commitment materializer" || role === "audit ingress authorization")
	.map(({ file }) => file));
const protectedBoundaries = files.flatMap((file) => {
	if (preflightFiles.includes(file)) return [];
	if (isolatedReadBoundaryFiles.has(file)) return [];
	const path = relative(root, file).replaceAll("\\", "/");
	return protectedBoundaryMatchers.filter(([, matches]) => matches(path)).map(([role]) => ({ file, role }));
});
if (protectedBoundaries.length === 0) throw new Error("no authorization/execution boundary modules found");

const protectedClosureFiles = new Set();
const protectedPending = protectedBoundaries.map(({ file }) => file);
while (protectedPending.length) {
	const file = protectedPending.pop();
	if (protectedClosureFiles.has(file)) continue;
	protectedClosureFiles.add(file);
	const parsed = analysis.get(file);
	if (
		[".cjs", ".cts"].includes(extname(file)) ||
		parsed?.hasCommonJs ||
		parsed?.hasCreateRequire
	) {
		throw new Error(`unsupported CommonJS usage in protected source closure: ${relative(root, file)}`);
	}
	if (parsed?.hasParseErrors) {
		throw new Error(`source parse error in protected source closure: ${relative(root, file)}`);
	}
	if (parsed?.hasNonliteralDynamic) {
		throw new Error(`nonliteral dynamic import in protected source closure: ${relative(root, file)}`);
	}
	if (parsed?.unresolved.length) {
		throw new Error(`unresolved import ${parsed.unresolved[0]} from protected source closure ${relative(root, file)}`);
	}
	if (parsed?.outsideSourceRoots.length) {
		throw new Error(`out-of-scope local import ${parsed.outsideSourceRoots[0]} from protected source closure ${relative(root, file)}`);
	}
	protectedPending.push(...(graph.get(file) ?? []));
}

for (const preflightFile of preflightFiles) {
	for (const boundary of protectedBoundaries) {
		if (reaches(preflightFile, boundary.file) || reaches(boundary.file, preflightFile)) {
			throw new Error(`MagicBlock preflight reaches ${boundary.role}: ${relative(root, preflightFile)}`);
		}
	}
}

for (const observerFile of observerImplementationFiles) {
	const reachedBoundary = protectedBoundaries.find((boundary) =>
		reaches(observerFile, boundary.file),
	);
	if (reachedBoundary) {
		throw new Error(
			`MagicBlock MCP observer reaches ${reachedBoundary.role}: ${relative(root, observerFile)}`,
		);
	}
	const reverseBoundary = protectedBoundaries.find((boundary) =>
		reaches(boundary.file, observerFile),
	);
	if (reverseBoundary) {
		throw new Error(
			`${reverseBoundary.role} reaches MagicBlock MCP observer: ${relative(root, observerFile)}`,
		);
	}
	const reverseFeature = preflightFiles.find((featureFile) =>
		reaches(featureFile, observerFile),
	);
	if (reverseFeature) {
		throw new Error(
			`MagicBlock preflight reverses into MCP observer: ${relative(root, reverseFeature)}`,
		);
	}
}

const observerServer = observerEntrypoints[0];
const observerExtractor = allowedObserverBoundaries.find(
	({ role }) => role === "MCP structured-content extractor",
)?.file;
for (const observerFile of observerImplementationFiles) {
	if (!reaches(observerServer, observerFile)) {
		const role = allowedObserverBoundaries.find(({ file }) => file === observerFile)?.role;
		throw new Error(
			`incomplete MagicBlock MCP observer closure: unreachable ${role}`,
		);
	}
}

for (const boundary of allowedObserverBoundaries) {
	if (
		boundary.file === observerExtractor ||
		boundary.file === observerServer ||
		boundary.role === "MCP hosted audit client"
	) {
		continue;
	}
	const reachedFeature = preflightFiles.find((featureFile) =>
		reaches(boundary.file, featureFile),
	);
	if (reachedFeature) {
		throw new Error(
			`${boundary.role} reaches MagicBlock feature root: ${relative(root, reachedFeature)}`,
		);
	}
}

const approvedObserverFeatureConsumers = new Set([
	observerExtractor,
	observerServer,
	allowedObserverBoundaries.find(
		({ role }) => role === "MCP hosted audit client",
	)?.file,
]);
for (const file of files) {
	if (preflightFiles.includes(file)) continue;
	const reachedFeature = preflightFiles.find((featureFile) => reaches(file, featureFile));
	if (!reachedFeature) continue;
	const reachedBoundary = protectedBoundaries.find((boundary) => reaches(file, boundary.file));
	if (reachedBoundary && !observerEntrypoints.includes(file)) {
		throw new Error(
			`${relative(root, file)} bridges MagicBlock preflight and ${reachedBoundary.role}`,
		);
	}
	if (
		!featureClosureFiles.has(file) &&
		!explicitlyApprovedIngressFiles.has(file) &&
		!approvedObserverFeatureConsumers.has(file)
	) {
		throw new Error(
			`unauthorized MagicBlock preflight consumer: ${relative(root, file)}`,
		);
	}
}

for (const file of files) {
	const parsed = analysis.get(file);
	if (parsed?.hasNonliteralDynamic) {
		throw new Error(
			`nonliteral dynamic import in scanned source root: ${relative(root, file)}`,
		);
	}
}

console.log(`PASS: ${preflightFiles.length} MagicBlock runtime boundary module(s) have one audit-ingress entrypoint with ${explicitlyApprovedIngressFiles.size} approved ingress module(s), one exact ${allowedObserverBoundaries.length}-module directed MCP observer graph with exact raw dependencies plus counted global/computed-member use sites and zero binding/destructuring forms, only extractor ingress to feature roots, and isolation from ${protectedBoundaries.length} authorization/execution boundary module(s).`);
