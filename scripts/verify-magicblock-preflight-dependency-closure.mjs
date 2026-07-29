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
const requiredIngressSources = [
	["audit ingress", "hosted/magicblock/magicBlockAuditIngress"],
	["audit ingress composition", "hosted/magicblock/magicBlockAuditIngressFromEnv"],
	["observation store", "hosted/magicblock/magicBlockObservationStorePg"],
	["append-only ledger", "hosted/magicblock/magicBlockAuditLedgerPg"],
	["audit ingress entrypoint", "app/api/magicblock-devnet/audit/route"],
];
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
	let hasCommonJs = false;
	let hasCreateRequire = false;

	function unparenthesized(node) {
		while (ts.isParenthesizedExpression(node)) node = node.expression;
		return node;
	}

	function visit(node) {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		}
		if (ts.isImportEqualsDeclaration(node)) hasCommonJs = true;
		if (ts.isCallExpression(node)) {
			const expression = unparenthesized(node.expression);
			if (expression.kind === ts.SyntaxKind.ImportKeyword) {
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
		}
		if (ts.isIdentifier(node)) {
			if (forbiddenFeatureCapabilities.has(node.text)) {
				forbiddenCapabilities.add(node.text);
			}
			if (node.text === "createRequire") hasCreateRequire = true;
		}
		if (
			ts.isElementAccessExpression(node) &&
			node.argumentExpression &&
			ts.isStringLiteralLike(node.argumentExpression) &&
			forbiddenFeatureCapabilities.has(node.argumentExpression.text)
		) {
			forbiddenCapabilities.add(node.argumentExpression.text);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return {
		specifiers,
		forbiddenCapabilities: [...forbiddenCapabilities],
		hasNonliteralDynamic,
		hasCommonJs,
		hasCreateRequire,
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
	.filter(({ role }) => role === "audit ingress entrypoint")
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

const protectedBoundaries = files.flatMap((file) => {
	if (preflightFiles.includes(file)) return [];
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

for (const file of files) {
	if (preflightFiles.includes(file)) continue;
	const reachedFeature = preflightFiles.find((featureFile) => reaches(file, featureFile));
	if (!reachedFeature) continue;
	const reachedBoundary = protectedBoundaries.find((boundary) => reaches(file, boundary.file));
	if (reachedBoundary) {
		throw new Error(
			`${relative(root, file)} bridges MagicBlock preflight and ${reachedBoundary.role}`,
		);
	}
	if (!featureClosureFiles.has(file) && !explicitlyApprovedIngressFiles.has(file)) {
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

console.log(`PASS: ${preflightFiles.length} MagicBlock runtime boundary module(s) have one audit-ingress entrypoint with ${explicitlyApprovedIngressFiles.size} explicitly approved ingress module(s), and are isolated from ${protectedBoundaries.length} authorization/execution boundary module(s).`);
