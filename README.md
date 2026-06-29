# pi-write-permit

Pi extension that restricts write operations (`write`, `edit`, `bash`) to an allowlist of directories.

## What it does

Intercepts the `write`, `edit`, and `bash` tools and blocks **write** operations targeting paths outside an explicit allowlist. Read operations are unaffected.

For `bash`, it uses [`unbash`](https://github.com/webpro-nl/unbash) — a zero-dependency TypeScript bash AST parser — to detect:

- **Redirect writes**: `>`, `>>`, `<>`, `>|`, `&>`, `&>>`
- **Writer commands**: `touch`, `cp`, `mv`, `tee`, `mkdir`, `rmdir`, `install`, `dd`, `rsync`, `tar`, `ln`

## Installation

```bash
pi install ~/dev-external/pi-write-permit
```

Or add to `.pi/settings.json`:

```json
{
  "extensions": ["~/dev-external/pi-write-permit"]
}
```

## Configuration

Three config sources, highest priority first:

### 1. CLI flag

```bash
pi --write-permit "./docs,./openspec" -p "your prompt"
```

### 2. Session command

```
/write-permit docs,openspec    # set allowlist for this session
/write-permit reset            # fall back to .pi/settings.json
```

> Enforcement is **mandatory** — `/write-permit off` is not supported. If no configuration is present, the extension does not enforce anything (no config = no block).

### 3. Project settings (`.pi/settings.json`)

```json
{
  "writePolicy": { "allowedDirs": ["./lib", "./test"] }
}
```

Legacy format also supported:

```json
{ "writeAllowDirs": ["./lib", "./test"] }
```

If no configuration is present, the extension does **not** enforce anything (write-permit requires explicit config to activate). Enforcement is mandatory once configured — there is no off switch.

## How bash detection works

The extension parses each bash command with `unbash` and walks the AST:

1. **Redirects**: Inspects `Redirect` nodes for write-capable operators (`>`, `>>`, `<>`, `>|`, `&>`, `&>>`) and extracts the target path.
2. **Writer commands**: Checks the command name against a whitelist and extracts destination arguments (e.g., last arg for `cp`/`mv`, all non-flag args for `touch`/`tee`).
3. **Dynamic paths**: Targets containing variables (`$VAR`), command substitution (`$(cmd)`), or arithmetic expansion are treated as unresolvable and **blocked** (fail-closed).
4. **Always-safe paths**: `/dev/null`, `/dev/stdout`, `/dev/stderr` bypass the allowlist.

## Docker + extension: complementary layers

This extension can be used standalone (CLI flag / session command / settings) **or** alongside Docker volume restrictions for defence-in-depth:

```bash
docker run -p 4002:4002 \
  -e GEMINI_API_KEY="your-api-key-here" \
  -e SECRET_KEY_BASE=$(openssl rand -base64 48) \
  -v $(pwd):/app/data:ro \
  -v $(pwd)/genie-state/genie_output:/app/genie_output \
  -v $(pwd)/genie-state/genie_tasks:/app/genie_tasks \
  agent-coding-gui
```

The Docker `:ro` mount blocks writes at the **filesystem level** — the container cannot write to the workspace. But the filesystem layer gives no guidance to the LLM: it just sees an error and may try workarounds.

This extension complements it by providing a **clear, structured error message** that tells the LLM *why* the write was blocked and *where* it is allowed. The LLM then knows the restriction is intentional (agreed with the user) and won't waste tokens searching for bypasses.

## Design decisions

- **Fail-closed**: Parse errors, unexpected AST shapes, or dynamic/unresolvable paths → block.
- **Reuse config**: Same `.pi/settings.json` keys as `write-allow-dirs.ts` — no duplicate config.
- **Not exhaustive**: Writer command detection covers common cases but can't catch every file-modifying command (e.g., `python -c "open('/x','w')"`).

## Architecture

```
src/
├── path-utils.ts      # expandHome, resolveMaybeRelative, canonicalizeTargetPath, isPathInside
├── config.ts          # SettingsShape, SessionOverride, loadProjectAllowedDirs, getEffectivePolicy
├── bash-detect.ts     # WRITE_OPERATORS, WRITER_COMMANDS, extractWriteTargets, isAlwaysSafe
└── write-permit.ts    # Extension factory: flag/command registration + tool_call enforcement
```
