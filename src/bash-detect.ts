import type {
	AssignmentPrefix,
	Command,
	Node,
	Redirect,
	RedirectOperator,
	Script,
	Word,
} from "unbash";

// ---------------------------------------------------------------------------
// Write-capable redirect operators
// ---------------------------------------------------------------------------

const WRITE_OPERATORS = new Set<RedirectOperator>([">", ">>", "<>", ">|", "&>", "&>>"]);

// ---------------------------------------------------------------------------
// Always-safe paths (bypass allowlist)
// ---------------------------------------------------------------------------

const SAFE_DEV_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd/1", "/dev/fd/2"]);

export function isAlwaysSafe(target: string): boolean {
	const normalized = target.replace(/\\/g, "/"); // normalise Windows backslashes
	return SAFE_DEV_PATHS.has(normalized);
}

// ---------------------------------------------------------------------------
// Dynamic path detection
// ---------------------------------------------------------------------------

export function wordContainsDynamicParts(word: Word): boolean {
	if (!word.parts || word.parts.length === 0) return false;
	return word.parts.some(
		(p) =>
			p.type === "SimpleExpansion" ||
			p.type === "ParameterExpansion" ||
			p.type === "CommandExpansion" ||
			p.type === "ArithmeticExpansion" ||
			p.type === "ProcessSubstitution",
	);
}

// ---------------------------------------------------------------------------
// Write finding model
// ---------------------------------------------------------------------------

export interface WriteFinding {
	path: string;
	source: "redirect" | "writer_command";
	commandName?: string;
}

// ---------------------------------------------------------------------------
// AST walk: extract write targets from Redirect nodes
// ---------------------------------------------------------------------------

export function extractWriteTargets(ast: Script): WriteFinding[] {
	const findings: WriteFinding[] = [];

	// Collect redirect targets from all nodes in the AST
	function walkRedirects(node: Node): void {
		if (!node) return;

		// Check redirects on this node directly
		if ("redirects" in node && Array.isArray(node.redirects)) {
			for (const redirect of node.redirects as Redirect[]) {
				processRedirect(redirect);
			}
		}

		// Recurse into nested command nodes (Statement wraps Command/Pipeline/AndOr/etc.)
		if ("command" in node && node.command && typeof node.command === "object") {
			walkRedirects(node.command as Node);
		}

		if ("commands" in node && Array.isArray((node as any).commands)) {
			for (const c of (node as any).commands) walkRedirects(c);
		}
		if ("body" in node && node.body) walkRedirects(node.body as Node);
		if ("clause" in node && node.clause) walkRedirects(node.clause as Node);
		if ("then" in node && node.then) walkRedirects(node.then as Node);
		if ("else" in node && node.else) walkRedirects(node.else as Node);
	}

	function processRedirect(redirect: Redirect): void {
		if (!WRITE_OPERATORS.has(redirect.operator)) return;
		const target = redirect.target;
		if (!target) return;
		if (wordContainsDynamicParts(target)) {
			findings.push({ path: "__dynamic__", source: "redirect" });
		} else {
			findings.push({ path: target.value, source: "redirect" });
		}
	}

	walkRedirects(ast);

	// Collect writer command targets
	function walkWriterCommands(node: Node): void {
		if (!node) return;

		// Check this node directly
		if (node.type === "Command" && node.name) {
			const targets = extractWriterCommandTargets(node);
			for (const t of targets) {
				findings.push({ path: t, source: "writer_command", commandName: node.name.value });
			}
		}

		// Recurse into nested command nodes (Statement wraps Command/Pipeline/AndOr/etc.)
		if ("command" in node && node.command && typeof node.command === "object") {
			walkWriterCommands(node.command as Node);
		}

		if ("commands" in node && Array.isArray((node as any).commands)) {
			for (const c of (node as any).commands) walkWriterCommands(c);
		}
		if ("body" in node && node.body) walkWriterCommands(node.body as Node);
		if ("clause" in node && node.clause) walkWriterCommands(node.clause as Node);
		if ("then" in node && node.then) walkWriterCommands(node.then as Node);
		if ("else" in node && node.else) walkWriterCommands(node.else as Node);
	}
	walkWriterCommands(ast);

	return findings;
}

// ---------------------------------------------------------------------------
// Writer command whitelist
// ---------------------------------------------------------------------------

interface WriterCommandSpec {
	name: string;
	extract: (args: Word[]) => string[];
}

function nonFlagWords(prefix: AssignmentPrefix[], suffix: Word[]): Word[] {
	return [...suffix].filter((w) => !w.text.startsWith("-"));
}

const WRITER_COMMANDS: WriterCommandSpec[] = [
	{ name: "touch", extract: (args) => args.map((w) => w.value) },
	{ name: "mkdir", extract: (args) => args.map((w) => w.value) },
	{ name: "rmdir", extract: (args) => args.map((w) => w.value) },
	{ name: "rm", extract: (args) => args.map((w) => w.value) },
	{ name: "unlink", extract: (args) => args.map((w) => w.value) },
	{ name: "cp", extract: (args) => (args.length >= 2 ? [args[args.length - 1].value] : []) },
	{ name: "mv", extract: (args) => (args.length >= 2 ? [args[args.length - 1].value] : []) },
	{ name: "ln", extract: (args) => (args.length >= 2 ? [args[args.length - 1].value] : []) },
	{ name: "install", extract: (args) => (args.length >= 2 ? [args[args.length - 1].value] : []) },
	{ name: "tee", extract: (args) => args.map((w) => w.value) },
	{
		name: "dd",
		extract: (args) => {
			const ofMatch = args.find((w) => w.text.startsWith("of="));
			return ofMatch ? [ofMatch.text.slice(3)] : [];
		},
	},
	{ name: "rsync", extract: (args) => (args.length >= 2 ? [args[args.length - 1].value] : []) },
	{ name: "tar", extract: (args) => (args.length > 0 ? [args[args.length - 1].value] : []) },
];

function extractWriterCommandTargets(cmd: Command): string[] {
	if (!cmd.name) return [];
	const name = cmd.name.value.toLowerCase();
	const spec = WRITER_COMMANDS.find((s) => s.name === name);
	if (!spec) return [];
	const args = nonFlagWords(cmd.prefix, cmd.suffix);
	return spec.extract(args);
}
