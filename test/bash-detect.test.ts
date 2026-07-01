import { describe, expect, it } from "vitest";
import { parse } from "unbash";
import { extractWriteTargets, isAlwaysSafe, type WriteFinding } from "../src/bash-detect.js";

function findings(command: string): WriteFinding[] {
	return extractWriteTargets(parse(command));
}

function writerTargets(command: string): Array<{ path: string; commandName?: string }> {
	return findings(command)
		.filter((finding) => finding.source === "writer_command")
		.map(({ path, commandName }) => ({ path, commandName }));
}

describe("extractWriteTargets", () => {
	it.each([
		["touch", "touch out.txt", [{ path: "out.txt", commandName: "touch" }]],
		["mkdir", "mkdir out-dir", [{ path: "out-dir", commandName: "mkdir" }]],
		["rmdir", "rmdir old-dir", [{ path: "old-dir", commandName: "rmdir" }]],
		["rm", "rm old-file.txt", [{ path: "old-file.txt", commandName: "rm" }]],
		["unlink", "unlink old-link.txt", [{ path: "old-link.txt", commandName: "unlink" }]],
		["cp", "cp source.txt copied.txt", [{ path: "copied.txt", commandName: "cp" }]],
		["mv", "mv source.txt moved.txt", [{ path: "moved.txt", commandName: "mv" }]],
		["ln", "ln source.txt linked.txt", [{ path: "linked.txt", commandName: "ln" }]],
		["install", "install source.txt installed.txt", [{ path: "installed.txt", commandName: "install" }]],
		["tee", "tee one.txt two.txt", [
			{ path: "one.txt", commandName: "tee" },
			{ path: "two.txt", commandName: "tee" },
		]],
		["dd", "dd if=input.bin of=output.bin", [{ path: "output.bin", commandName: "dd" }]],
		["rsync", "rsync source/ dest/", [{ path: "dest/", commandName: "rsync" }]],
		["tar", "tar -xf archive.tar dest-dir", [{ path: "dest-dir", commandName: "tar" }]],
	])("detects %s writer command targets", (_name, command, expected) => {
		expect(writerTargets(command)).toEqual(expected);
	});

	it.each([
		["rm -rf old-dir", [{ path: "old-dir", commandName: "rm" }]],
		["mkdir -p parent/child", [{ path: "parent/child", commandName: "mkdir" }]],
		["tee -a append.txt", [{ path: "append.txt", commandName: "tee" }]],
		["cp -r source-dir copied-dir", [{ path: "copied-dir", commandName: "cp" }]],
		["ln -s target linked-target", [{ path: "linked-target", commandName: "ln" }]],
	])("ignores flags when extracting writer command targets: %s", (command, expected) => {
		expect(writerTargets(command)).toEqual(expected);
	});

	it.each([
		["touch a.txt b.txt c.txt", [
			{ path: "a.txt", commandName: "touch" },
			{ path: "b.txt", commandName: "touch" },
			{ path: "c.txt", commandName: "touch" },
		]],
		["rm a.txt b.txt c.txt", [
			{ path: "a.txt", commandName: "rm" },
			{ path: "b.txt", commandName: "rm" },
			{ path: "c.txt", commandName: "rm" },
		]],
		["rmdir a b", [
			{ path: "a", commandName: "rmdir" },
			{ path: "b", commandName: "rmdir" },
		]],
	])("detects multiple path operands: %s", (command, expected) => {
		expect(writerTargets(command)).toEqual(expected);
	});

	it.each([">", ">>", "<>", ">|", "&>", "&>>"])("detects %s write redirects", (operator) => {
		expect(findings(`echo hello ${operator} out.txt`)).toContainEqual({
			path: "out.txt",
			source: "redirect",
		});
	});

	it("does not detect read-only redirects", () => {
		expect(findings("cat < input.txt")).toEqual([]);
	});

	it("marks dynamic redirect targets as unresolvable", () => {
		expect(findings("echo hello > $OUT")).toContainEqual({
			path: "__dynamic__",
			source: "redirect",
		});
	});

	it("detects writer commands inside pipelines", () => {
		expect(findings("printf hello | tee out.txt")).toContainEqual({
			path: "out.txt",
			source: "writer_command",
			commandName: "tee",
		});
	});

	it("detects writer commands inside compound boolean commands", () => {
		expect(writerTargets("touch first.txt && rm second.txt")).toEqual([
			{ path: "first.txt", commandName: "touch" },
			{ path: "second.txt", commandName: "rm" },
		]);
	});

	it("does not produce findings for unsupported read-only commands", () => {
		expect(findings("grep needle input.txt && ls output-dir")).toEqual([]);
	});

	it("documents that opaque Python heredoc writes are not covered by current static bash detection", () => {
		const command = `python3 << 'EOF'
with open('/outside/permit.txt', 'w') as f:
    f.write('bypass')
EOF`;

		expect(findings(command)).toEqual([]);
	});
});

describe("isAlwaysSafe", () => {
	it.each(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd/1", "/dev/fd/2"])(
		"allows %s without permit checks",
		(path) => {
			expect(isAlwaysSafe(path)).toBe(true);
		},
	);
});
