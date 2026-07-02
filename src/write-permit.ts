/**
 * pi-write-permit
 *
 * Restricts write operations (write, edit, bash) to an allowlist of
 * directories. Reuses the same config as write-allow-dirs.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse } from "unbash";
import type { Script } from "unbash";
import {
	getEffectivePolicy,
	loadProjectAllowedDirs,
	parseDirsArgList,
	parseFlagAllowedDirs,
	resolveAllowedDirs,
	formatResolvedList,
	type SessionOverride,
} from "./config.js";
import { canonicalizeTargetPath, isPathInside, resolveMaybeRelative } from "./path-utils.js";
import { extractWriteTargets, isAlwaysSafe, type WriteFinding } from "./bash-detect.js";

const PERSIST_TYPE = "write-permit";

let sessionOverride: SessionOverride | null = null;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function writePermit(pi: ExtensionAPI) {
	pi.registerFlag("write-permit", {
		description: "Comma-separated list of directories under which write/edit/bash operations are allowed (e.g. ./docs,./openspec)",
		type: "string",
	});

	function persistOverride(): void {
		if (!sessionOverride) return;
		pi.appendEntry(PERSIST_TYPE, sessionOverride);
	}

	pi.registerCommand("write-permit", {
		description:
			"Show or set the write/edit/bash allowlist. Usage: /write-permit docs,openspec | off | reset (CLI flag overrides)",
		handler: async (args, ctx) => {
			const argsTrimmed = (args ?? "").trim();
			const flagDirs = parseFlagAllowedDirs(pi.getFlag("write-permit"));
			const flagActive = flagDirs !== null;

			if (!argsTrimmed) {
				if (!ctx.hasUI) return;
				const policy = await getEffectivePolicy(pi.getFlag("write-permit"), sessionOverride, ctx.cwd);
				if (!policy.enforce) {
					ctx.ui.notify(`Write permit is not enforcing (source: ${policy.source}).`, "info");
					return;
				}
				const resolved = await resolveAllowedDirs(policy.dirs, ctx.cwd);
				ctx.ui.notify(`Write permit enforcing (source: ${policy.source}).\nAllowed under:\n${formatResolvedList(resolved)}\n\nTreat denied writes as policy boundaries, not technical failures to route around.`, "info");
				return;
			}

			if (flagActive) {
				if (ctx.hasUI) {
					ctx.ui.notify("Cannot change allowlist via /write-permit while --write-permit is set (CLI flag has priority).", "warning");
				}
				return;
			}

			const lower = argsTrimmed.toLowerCase();
			if (lower === "off" || lower === "disable") {
				sessionOverride = { mode: "off" };
				persistOverride();
				if (ctx.hasUI) {
					ctx.ui.notify("Write permit enforcement disabled for this session.", "info");
					await pi.sendMessage(
						{ customType: PERSIST_TYPE, content: "Write permit enforcement disabled for this session. Treat denied writes as policy boundaries, not technical failures to route around.", display: true },
						{ triggerTurn: false },
					);
				}
				return;
			}
			if (lower === "reset") {
				sessionOverride = { mode: "reset" };
				persistOverride();
				sessionOverride = null;
				if (ctx.hasUI) {
					ctx.ui.notify("Write permit reset (now falls back to .pi/settings.json if present).", "info");
					await pi.sendMessage(
						{ customType: PERSIST_TYPE, content: "Write permit reset (now falls back to .pi/settings.json if present). Treat denied writes as policy boundaries, not technical failures to route around.", display: true },
						{ triggerTurn: false },
					);
				}
				return;
			}

			const dirs = parseDirsArgList(argsTrimmed);
			sessionOverride = { mode: "allow", dirs };
			persistOverride();
			if (ctx.hasUI) {
				const resolved = await resolveAllowedDirs(dirs, ctx.cwd);
				const list = formatResolvedList(resolved);
				ctx.ui.notify(`Write permit set for this session.\nAllowed under:\n${list}\n\nTreat denied writes as policy boundaries, not technical failures to route around.`, "info");
				await pi.sendMessage(
					{ customType: PERSIST_TYPE, content: `Write permit set for this session.\nAllowed under:\n${list}\n\nTreat denied writes as policy boundaries, not technical failures to route around.`, display: true },
					{ triggerTurn: false },
				);
			}
		},
	});

	// Restore session override
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === PERSIST_TYPE)
			.pop() as { data?: SessionOverride } | undefined;
		if (!last?.data) return;
		if (last.data.mode === "reset") {
			sessionOverride = null;
			if (ctx.hasUI) {
				await pi.sendMessage(
					{ customType: PERSIST_TYPE, content: "Write permit reset (now falls back to .pi/settings.json if present). Treat denied writes as policy boundaries, not technical failures to route around.", display: true },
					{ triggerTurn: false },
				);
			}
			return;
		}
		sessionOverride = last.data;
		if (ctx.hasUI && last.data.mode === "allow") {
			const resolved = await resolveAllowedDirs(last.data.dirs, ctx.cwd);
			const list = formatResolvedList(resolved);
			await pi.sendMessage(
				{ customType: PERSIST_TYPE, content: `Write permit set for this session.\nAllowed under:\n${list}\n\nTreat denied writes as policy boundaries, not technical failures to route around.`, display: true },
				{ triggerTurn: false },
			);
		}
	});

	// Enforcement
	pi.on("tool_call", async (event, ctx) => {
		if (!["write", "edit", "bash"].includes(event.toolName)) return undefined;

		const policy = await getEffectivePolicy(pi.getFlag("write-permit"), sessionOverride, ctx.cwd);
		if (!policy.enforce) return undefined;

		// --- write / edit tools ---
		if (event.toolName === "write" || event.toolName === "edit") {
			const targetPathRaw = (event.input as { path?: unknown }).path;
			if (typeof targetPathRaw !== "string" || !targetPathRaw.trim()) {
				return { block: true, reason: `Invalid path argument for ${event.toolName}` };
			}

			const absTarget = resolveMaybeRelative(targetPathRaw, ctx.cwd);
			const canonicalTarget = await canonicalizeTargetPath(absTarget);

			const resolvedAllowed = await resolveAllowedDirs(policy.dirs, ctx.cwd);

			const ok = resolvedAllowed.some((dir) => isPathInside(canonicalTarget, dir));
			if (ok) return undefined;

			const policyMsg = `The user has set guard rails for this task — writes must stay under these directories:\n` + resolvedAllowed.map(d => "  " + d).join("\n");
			const reason = `PERMIT DENIED: Write operation to '${targetPathRaw}' is outside the allowed directories.\n\n` + policyMsg + `\n\nDo not attempt to work around this block with another tool, bash command, embedded interpreter, heredoc, symlink, temp file, or alternative path. If these guard rails block the intended work, stop and ask the user to clarify the target location or update the write permit. This restriction exists because task descriptions or goals may be ambiguous - the guard rail prevents unauthorized writes that could stem from unclear intent.`;
			return { block: true, reason };
		}

		// --- bash tool ---
		const rawCommand = (event.input as { command?: unknown }).command;
		if (typeof rawCommand !== "string" || !rawCommand.trim()) {
			return { block: true, reason: "Invalid command argument" };
		}

		const command = rawCommand.trim();

		let ast: Script;
		try {
			ast = parse(command);
		} catch (err) {
			return { block: true, reason: `Bash parse error: ${err instanceof Error ? err.message : String(err)}. Command blocked for safety.` };
		}

		let findings: WriteFinding[];
		try {
			findings = extractWriteTargets(ast);
		} catch (err) {
			return { block: true, reason: `AST analysis error: ${err instanceof Error ? err.message : String(err)}. Command blocked for safety.` };
		}

		if (findings.length === 0) return undefined;

		const resolvedAllowed = await resolveAllowedDirs(policy.dirs, ctx.cwd);

		const blocked: string[] = [];
		for (const finding of findings) {
			if (isAlwaysSafe(finding.path)) continue;
			if (finding.path === "__dynamic__") {
				blocked.push("dynamic path (unresolvable)");
				continue;
			}

			const absTarget = resolveMaybeRelative(finding.path, ctx.cwd);
			const canonicalTarget = await canonicalizeTargetPath(absTarget);

			const allowed = resolvedAllowed.some((dir) => isPathInside(canonicalTarget, dir));
			if (!allowed) {
				const sourceLabel = finding.source === "redirect" ? "redirect" : `${finding.commandName} command`;
				blocked.push(`${finding.path} (${sourceLabel})`);
			}
		}

		if (blocked.length > 0) {
			const policyMsg = `The user has set guard rails for this task — writes must stay under these directories:\n` + resolvedAllowed.map(d => "  " + d).join("\n");
			const blockedList = blocked.map(p => "  " + p).join("\n");
			const reason = `PERMIT DENIED: The bash command writes to:\n${blockedList}\n\n` + policyMsg + `\n\nDo not attempt to work around this block with another tool, bash command, embedded interpreter, heredoc, symlink, temp file, or alternative path. If these guard rails block the intended work, stop and ask the user to clarify the target location or update the write permit. This restriction exists because task descriptions or goals may be ambiguous - the guard rail prevents unauthorized writes that could stem from unclear intent.`;
			return { block: true, reason };
		}

		return undefined;
	});
}
