import { describe, expect, it, vi, beforeEach } from "vitest";
import writePermit from "../src/write-permit.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
	getEffectivePolicy: vi.fn().mockResolvedValue({ enforce: true, source: "test", dirs: ["./docs"] }),
	resolveAllowedDirs: vi.fn().mockResolvedValue(["/abs/docs"]),
	formatResolvedList: vi.fn().mockReturnValue("  ./docs"),
	parseDirsArgList: vi.fn((s) => s.split(",")),
	parseFlagAllowedDirs: vi.fn().mockReturnValue(null),
	loadProjectAllowedDirs: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/path-utils.js", () => ({
	canonicalizeTargetPath: vi.fn().mockImplementation((p) => p),
	isPathInside: vi.fn().mockReturnValue(false),
	resolveMaybeRelative: vi.fn().mockImplementation((p) => p),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockPI(): any {
	const callbacks: Record<string, Function[]> = {};
	return {
		registerFlag: vi.fn(),
		registerCommand: vi.fn(),
		getFlag: vi.fn().mockReturnValue(undefined),
		appendEntry: vi.fn(),
		sendMessage: vi.fn().mockResolvedValue(undefined),
		on: vi.fn((event: string, handler: Function) => {
			if (!callbacks[event]) callbacks[event] = [];
			callbacks[event].push(handler);
		}),
		_fireEvent: async (event: string, payload: any) => {
			for (const h of callbacks[event] || []) {
				await h(payload.event, payload.ctx);
			}
		},
		_getCallbacks: () => callbacks,
	};
}

function createMockCtx(overrides: Partial<any> = {}) {
	return {
		ui: {
			notify: vi.fn(),
		},
		hasUI: true,
		cwd: "/project",
		sessionManager: {
			getEntries: vi.fn().mockReturnValue([]),
		},
		modelRegistry: {},
		model: undefined,
		isIdle: vi.fn().mockReturnValue(true),
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: vi.fn().mockReturnValue(false),
		shutdown: vi.fn(),
		getContextUsage: vi.fn().mockReturnValue(undefined),
		compact: vi.fn(),
		getSystemPrompt: vi.fn().mockReturnValue(""),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("write-permit extension", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers the flag and command", () => {
		const pi = createMockPI();
		writePermit(pi);
		expect(pi.registerFlag).toHaveBeenCalledWith("write-permit", expect.objectContaining({ type: "string" }));
		expect(pi.registerCommand).toHaveBeenCalledWith("write-permit", expect.objectContaining({ handler: expect.any(Function) }));
	});

	it("subscribes to the tool_call event", () => {
		const pi = createMockPI();
		writePermit(pi);
		expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
	});

	// -----------------------------------------------------------------------
	// /write-permit command: sendMessage calls
	// -----------------------------------------------------------------------

	describe("/write-permit command", () => {
		it("sends message to agent on allowlist set", async () => {
			const pi = createMockPI();
			writePermit(pi);
			const cmd = pi.registerCommand.mock.calls.find((c: any[]) => c[0] === "write-permit");
			const handler = cmd![1].handler;
			const ctx = createMockCtx();

			await handler("docs,openspec", ctx);

			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: "write-permit",
					content: expect.stringContaining("Write permit set for this session"),
				}),
				expect.objectContaining({ triggerTurn: false }),
			);
		});

		it("sends message to agent on disable", async () => {
			const pi = createMockPI();
			writePermit(pi);
			const cmd = pi.registerCommand.mock.calls.find((c: any[]) => c[0] === "write-permit");
			const handler = cmd![1].handler;
			const ctx = createMockCtx();

			await handler("off", ctx);

			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: "write-permit",
					content: expect.stringContaining("disabled"),
				}),
				expect.objectContaining({ triggerTurn: false }),
			);
		});

		it("sends message to agent on reset", async () => {
			const pi = createMockPI();
			writePermit(pi);
			const cmd = pi.registerCommand.mock.calls.find((c: any[]) => c[0] === "write-permit");
			const handler = cmd![1].handler;
			const ctx = createMockCtx();

			await handler("reset", ctx);

			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: "write-permit",
					content: expect.stringContaining("reset"),
				}),
				expect.objectContaining({ triggerTurn: false }),
			);
		});

		it("still notifies UI alongside sendMessage", async () => {
			const pi = createMockPI();
			writePermit(pi);
			const cmd = pi.registerCommand.mock.calls.find((c: any[]) => c[0] === "write-permit");
			const handler = cmd![1].handler;
			const ctx = createMockCtx();

			await handler("docs", ctx);

			expect(ctx.ui.notify).toHaveBeenCalled();
			expect(pi.sendMessage).toHaveBeenCalled();
		});

		it("skips sendMessage when no UI (print mode)", async () => {
			const pi = createMockPI();
			writePermit(pi);
			const cmd = pi.registerCommand.mock.calls.find((c: any[]) => c[0] === "write-permit");
			const handler = cmd![1].handler;
			const ctx = createMockCtx({ hasUI: false });

			await handler("docs", ctx);

			expect(ctx.ui.notify).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// Blocking behavior (unchanged, sanity check)
	// -----------------------------------------------------------------------

	describe("blocking", () => {
		it("blocks write to unauthorized path", async () => {
			const pi = createMockPI();
			writePermit(pi);
			const callbacks = pi._getCallbacks();
			const toolCallHandler = callbacks["tool_call"][0];
			const ctx = createMockCtx();

			const result = await toolCallHandler(
				{ type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "/outside/file.txt", content: "data" } },
				ctx,
			);

			expect(result).toEqual(expect.objectContaining({ block: true }));
			expect(result?.reason).toContain("PERMIT DENIED");
		});

		it("allows write to authorized path", async () => {
			vi.mocked((await import("../src/path-utils.js")).isPathInside).mockReturnValue(true);
			const pi = createMockPI();
			writePermit(pi);
			const callbacks = pi._getCallbacks();
			const toolCallHandler = callbacks["tool_call"][0];
			const ctx = createMockCtx();

			const result = await toolCallHandler(
				{ type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "./docs/file.txt", content: "data" } },
				ctx,
			);

			expect(result).toBeUndefined();
		});
	});
});