# pi-write-permit

Pi extension that restricts write operations (`write`, `edit`, `bash`) to an allowlist of directories.

## What it does

Intercepts the `write`, `edit`, and `bash` tools and blocks operations targeting paths outside an explicit allowlist.

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
/write-permit off              # disable enforcement
/write-permit reset            # fall back to .pi/settings.json
```

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

If no configuration is present, the extension does **not** enforce anything.

## How bash detection works

The extension parses each bash command with `unbash` and walks the AST:

1. **Redirects**: Inspects `Redirect` nodes for write-capable operators (`>`, `>>`, `<>`, `>|`, `&>`, `&>>`) and extracts the target path.
2. **Writer commands**: Checks the command name against a whitelist and extracts destination arguments (e.g., last arg for `cp`/`mv`, all non-flag args for `touch`/`tee`).
3. **Dynamic paths**: Targets containing variables (`$VAR`), command substitution (`$(cmd)`), or arithmetic expansion are treated as unresolvable and **blocked** (fail-closed).
4. **Always-safe paths**: `/dev/null`, `/dev/stdout`, `/dev/stderr` bypass the allowlist.

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
