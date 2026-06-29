import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

export function resolveMaybeRelative(p: string, cwd: string): string {
	const expanded = expandHome(p);
	return path.isAbsolute(expanded) ? path.normalize(expanded) : path.normalize(path.resolve(cwd, expanded));
}

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function realpathIfExists(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return p;
	}
}

/**
 * Canonicalize a path for containment checks.
 * Uses realpath when possible; for non-existent files (common for writes),
 * resolves the nearest existing parent directory then re-attaches the suffix.
 */
export async function canonicalizeTargetPath(absTargetPath: string): Promise<string> {
	const normalizedTarget = path.normalize(absTargetPath);
	if (await fileExists(normalizedTarget)) {
		return await realpathIfExists(normalizedTarget);
	}
	let probe = path.dirname(normalizedTarget);
	let suffixParts: string[] = [path.basename(normalizedTarget)];
	while (probe !== path.dirname(probe)) {
		if (await fileExists(probe)) {
			const realParent = await realpathIfExists(probe);
			return path.join(realParent, ...suffixParts);
		}
		suffixParts = [path.basename(probe), ...suffixParts];
		probe = path.dirname(probe);
	}
	return normalizedTarget;
}

export function isPathInside(targetAbs: string, allowedDirAbs: string): boolean {
	const rel = path.relative(allowedDirAbs, targetAbs);
	if (rel === "") return true;
	return !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel);
}
