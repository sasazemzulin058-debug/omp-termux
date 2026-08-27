#!/usr/bin/env python3
"""Hermes overlay transforms — deterministic, marker-checked."""

from pathlib import Path

ROOT = Path.cwd()
HERMES_COMMIT = "f20e315"
HERMES_SPEC = f"github:sasazemzulin058-debug/pi-hermes-memory#{HERMES_COMMIT}"
HERMES_OVERLAY_DIR = ROOT / "android" / "overlay" / "hermes"

def _once(text, old, new, rel):
    if text.count(old) != 1:
        raise SystemExit(f"overlay marker mismatch: {rel}: {old[:80]!r}")
    return text.replace(old, new, 1)

def hermes_package_json(text):
    # Ensure pi-hermes-memory spec
    if "pi-hermes-memory" in text:
        if HERMES_SPEC not in text:
            raise SystemExit(f"overlay marker mismatch: packages/coding-agent/package.json: pi-hermes-memory spec must be {HERMES_SPEC!r}")
        if "pi-hermes-memory#main" in text:
            raise SystemExit("overlay marker mismatch: packages/coding-agent/package.json: mutable #main spec found")
        after_pi = text
    else:
        old = '"puppeteer-core": "catalog:"'
        if text.count(old) != 1:
            raise SystemExit(f"overlay marker mismatch: packages/coding-agent/package.json: {old!r}")
        after_pi = text.replace(old, f'"puppeteer-core": "catalog:",\n    "pi-hermes-memory": "{HERMES_SPEC}"', 1)
    # Ensure @types/better-sqlite3 devDependency (catalog reference)
    if '"@types/better-sqlite3"' in after_pi:
        if '"@types/better-sqlite3": "catalog:"' not in after_pi:
            raise SystemExit("overlay marker mismatch: packages/coding-agent/package.json: @types/better-sqlite3 must be catalog:")
        return after_pi
    old_dev = '"@types/bun": "catalog:"'
    if after_pi.count(old_dev) != 1:
        raise SystemExit(f"overlay marker mismatch: packages/coding-agent/package.json devDeps: {old_dev!r}")
    return after_pi.replace(old_dev, '"@types/better-sqlite3": "catalog:",\n    "@types/bun": "catalog:"', 1)

def hermes_root_catalog(text):
    if '"@types/better-sqlite3"' in text:
        if '"@types/better-sqlite3": "^7.6.13"' not in text:
            raise SystemExit("overlay marker mismatch: package.json catalog: @types/better-sqlite3 version must be ^7.6.13")
        return text
    old = '"@types/bun": "^1.3.14"'
    if text.count(old) != 1:
        raise SystemExit(f"overlay marker mismatch: package.json catalog: {old!r}")
    return text.replace(old, '"@types/better-sqlite3": "^7.6.13",\n      "@types/bun": "^1.3.14"', 1)

def hermes_settings_schema(text):
    if '"hermes"' in text and 'memory.backend' in text:
        if text.count('"hermes"') < 1:
            raise SystemExit("overlay marker mismatch: settings-schema.ts: hermes not found after patch")
        return text
    old = 'values: ["off", "local", "hindsight", "mnemopi"] as const,'
    if text.count(old) != 1:
        raise SystemExit(f"overlay marker mismatch: packages/coding-agent/src/config/settings-schema.ts: {old[:80]!r}")
    new = 'values: ["off", "local", "hindsight", "mnemopi", "hermes"] as const,'
    text = text.replace(old, new, 1)
    old_desc = 'description: "Off, local summary pipeline, Mnemopi SQLite, or Hindsight remote memory"'
    new_desc = 'description: "Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Hermes persistent memory"'
    if old_desc in text:
        if text.count(old_desc) != 1:
            raise SystemExit("overlay marker mismatch: settings-schema.ts description")
        text = text.replace(old_desc, new_desc, 1)
    old_opt = '\t\t\t\t{\n\t\t\t\t\tvalue: "mnemopi",\n\t\t\t\t\tlabel: "Mnemopi",\n\t\t\t\t\tdescription: "Local SQLite recall/retain backend with optional embeddings",\n\t\t\t\t},'
    new_opt = '\t\t\t\t{\n\t\t\t\t\tvalue: "mnemopi",\n\t\t\t\t\tlabel: "Mnemopi",\n\t\t\t\t\tdescription: "Local SQLite recall/retain backend with optional embeddings",\n\t\t\t\t},\n\t\t\t\t{\n\t\t\t\t\tvalue: "hermes",\n\t\t\t\t\tlabel: "Hermes",\n\t\t\t\t\tdescription: "Hermes persistent memory (MEMORY.md/USER.md + SQLite FTS5) via pi-hermes-memory",\n\t\t\t\t},'
    if old_opt in text:
        # Only patch if hermes not already present after this block
        if '"hermes"' not in text.split(old_opt)[-1][:600]:
            if text.count(old_opt) != 1:
                raise SystemExit("overlay marker mismatch: settings-schema.ts mnemopi option")
            text = text.replace(old_opt, new_opt, 1)
    return text

def hermes_types(text):
    if "hermes" in text and "MemoryBackendId" in text:
        return text
    old = 'export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi";'
    if text.count(old) != 1:
        raise SystemExit(f"overlay marker mismatch: types.ts: {old!r}")
    new = 'export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi" | "hermes";'
    return text.replace(old, new, 1)

def hermes_index(text):
    correct = 'export * from "./hermes-backend";\nexport * from "./local-backend";'
    wrong = 'export * from "./local-backend";\nexport * from "./hermes-backend";'
    if correct in text:
        return text
    if wrong in text:
        return text.replace(wrong, correct, 1)
    old = 'export * from "./local-backend";'
    if text.count(old) != 1:
        raise SystemExit(f"overlay marker mismatch: memory-backend/index.ts: {old!r}")
    new = correct
    return text.replace(old, new, 1)

def hermes_resolve(text):
    if '"hermes"' in text and "hermesBackend" in text:
        return text
    old = 'if (id === "mnemopi") return (await import("../mnemopi/backend")).mnemopiBackend;'
    if text.count(old) != 1:
        raise SystemExit(f"overlay marker mismatch: resolve.ts: {old[:80]!r}")
    new = 'if (id === "mnemopi") return (await import("../mnemopi/backend")).mnemopiBackend;\n\t// Hermes is optional (pi-hermes-memory may be absent) and pulls better-sqlite3; keep it off the startup graph.\n\tif (id === "hermes") return (await import("./hermes-backend")).hermesBackend;'
    return text.replace(old, new, 1)

def hermes_session_memory(text):
    if "disposeHermesRuntimeForSession" in text:
        if 'import type { AgentSession } from "./agent-session";' not in text:
            raise SystemExit("overlay marker mismatch: session-memory.ts missing AgentSession import after patch")
        return text
    old_import = 'import type { MnemopiSessionState } from "../mnemopi/state";'
    if text.count(old_import) != 1:
        raise SystemExit(f"overlay marker mismatch: session-memory.ts import: {old_import!r}")
    new_import = 'import type { MnemopiSessionState } from "../mnemopi/state";\nimport type { AgentSession } from "./agent-session";'
    text = text.replace(old_import, new_import, 1)
    # Stable anchor: doc comment must appear exactly once, regardless of surrounding whitespace.
    doc = "\t/**\n\t * Apply the selected memory backend"
    if text.count(doc) != 1:
        raise SystemExit(f"overlay marker mismatch: session-memory.ts Apply doc comment: {doc!r}")
    # Use regex to find the method closing boundary immediately before the doc comment.
    # The method's closing brace is a single-tab "}" followed by zero or more blank lines, then the doc.
    # Allow 1 or 2 (or more) blank lines to be stable across upstream whitespace changes.
    # We require exactly one such boundary before the doc to ensure exact-once semantics.
    import re as _re
    pattern = r"\n\t\}\n(\n*)\t/\*\*\n\t \* Apply the selected memory backend"
    matches = list(_re.finditer(pattern, text))
    if len(matches) != 1:
        raise SystemExit(f"overlay marker mismatch: session-memory.ts method boundary: expected 1 match for Apply doc anchor, got {len(matches)}")
    m = matches[0]
    # Hermes disposal block — inserted inside #disposeMemoryBackendState before its closing brace.
    # Indentation is 2 tabs inside the method (method at 1 tab, body at 2 tabs).
    hermes_block = "\t\t// Hermes disposal — ensure no stale WeakMap entry remains when backend switches\n\t\t// or session ends. Dynamic import keeps hermes off the startup graph when\n\t\t// memory.backend !== hermes; explicit inert error is handled by the backend.\n\t\ttry {\n\t\t\tconst { disposeHermesRuntimeForSession } = await import(\"../memory-backend/hermes-backend\");\n\t\t\tconst maybeSession = this.#host.memoryBackendSession() as unknown as AgentSession;\n\t\t\tif (maybeSession) await disposeHermesRuntimeForSession(maybeSession);\n\t\t} catch (error) {\n\t\t\t// Only log unexpected errors; missing module when hermes never installed is benign.\n\t\t\tconst msg = error instanceof Error ? error.message : String(error);\n\t\t\tif (!msg.includes(\"Cannot find module\") && !msg.includes(\"is not installed\")) {\n\t\t\t\tlogger.warn(\"Memory lifecycle: Hermes dispose failed\", { error: msg });\n\t\t\t}\n\t\t}\n"
    old_segment = m.group(0)
    new_segment = "\n" + hermes_block + "\t}\n\n\t/**\n\t * Apply the selected memory backend"
    if text.count(old_segment) != 1:
        raise SystemExit(f"overlay marker mismatch: session-memory.ts exact segment: {old_segment[:60]!r}")
    text = text.replace(old_segment, new_segment, 1)
    return text


def hermes_agent_session(text):
    if "#disposeHermes" in text:
        return text
    old_method = "\tasync #disposeMnemopi(\n\t\tstate: MnemopiSessionState | undefined,\n\t\tconsolidateTimeoutMs: number | undefined,\n\t): Promise<void> {\n\t\ttry {\n\t\t\tawait state?.dispose({ timeoutMs: consolidateTimeoutMs });\n\t\t} finally {\n\t\t\t// Consolidation may embed final memories, so terminate its worker only afterward.\n\t\t\tawait shutdownMnemopiEmbedClient();\n\t\t}\n\t}"
    if old_method not in text:
        raise SystemExit("overlay marker mismatch: agent-session.ts mnemopi method body")
    new_method = old_method + "\n\n\tasync #disposeHermes(): Promise<void> {\n\t\ttry {\n\t\t\tconst { disposeHermesRuntimeForSession } = await import(\"../memory-backend/hermes-backend\");\n\t\t\tawait disposeHermesRuntimeForSession(this as any);\n\t\t} catch (error) {\n\t\t\tlogger.warn(\"Failed to dispose Hermes runtime during session dispose\", { error: String(error) });\n\t\t}\n\t}"
    text = text.replace(old_method, new_method, 1)
    old_settled = "this.#disposeMnemopi(mnemopiState, options.mnemopiConsolidateTimeoutMs),\n\t\t]);"
    if old_settled in text:
        if text.count(old_settled) != 1:
            raise SystemExit("overlay marker mismatch: agent-session.ts Promise.allSettled tail")
        new_settled = "this.#disposeMnemopi(mnemopiState, options.mnemopiConsolidateTimeoutMs),\n\t\t\tthis.#disposeHermes(),\n\t\t]);"
        text = text.replace(old_settled, new_settled, 1)
    else:
        if "this.#disposeMnemopi(mnemopiState" not in text:
            raise SystemExit("overlay marker mismatch: agent-session.ts Promise.allSettled mnemopi")
        text = text.replace("this.#disposeMnemopi(mnemopiState, options.mnemopiConsolidateTimeoutMs),", "this.#disposeMnemopi(mnemopiState, options.mnemopiConsolidateTimeoutMs),\n\t\t\tthis.#disposeHermes(),", 1)
    return text

def _edit(rel, transform):
    path = ROOT / rel
    text = path.read_text()
    new = transform(text)
    if new != text:
        path.write_text(new)
    return new != text

def apply_hermes_overlay():
    changed = 0
    if _edit("package.json", hermes_root_catalog):
        changed += 1
    if _edit("packages/coding-agent/package.json", hermes_package_json):
        changed += 1
    if _edit("packages/coding-agent/src/config/settings-schema.ts", hermes_settings_schema):
        changed += 1
    if _edit("packages/coding-agent/src/memory-backend/types.ts", hermes_types):
        changed += 1
    if _edit("packages/coding-agent/src/memory-backend/index.ts", hermes_index):
        changed += 1
    if _edit("packages/coding-agent/src/memory-backend/resolve.ts", hermes_resolve):
        changed += 1
    if _edit("packages/coding-agent/src/session/session-memory.ts", hermes_session_memory):
        changed += 1
    if _edit("packages/coding-agent/src/session/agent-session.ts", hermes_agent_session):
        changed += 1
    # New file copies — deterministic, fail if template missing
    for name in ["hermes-backend.ts", "hermes-backend.test.ts"]:
        src = HERMES_OVERLAY_DIR / name
        if not src.is_file():
            raise SystemExit(f"overlay missing template: {src}")
        dst = ROOT / ("packages/coding-agent/src/memory-backend/hermes-backend.ts" if name == "hermes-backend.ts" else "packages/coding-agent/test/hermes-backend.test.ts")
        dst.parent.mkdir(parents=True, exist_ok=True)
        content = src.read_text()
        if "#main" in content:
            raise SystemExit(f"overlay template must not contain mutable #main: {name}")
        existing = dst.read_text() if dst.exists() else ""
        if content != existing:
            dst.write_text(content)
            changed += 1
        # verify markers in copied file
        if name == "hermes-backend.ts":
            for needle in ["resolveHermesMemoryDir", "disposeHermesRuntimeForSession", "hermesBackend"]:
                if needle not in content:
                    raise SystemExit(f"overlay template corrupt: {name} missing {needle!r}")
            if "pi-hermes-memory/runtime" not in content:
                raise SystemExit(f"overlay template corrupt: {name} missing runtime import")
    return changed
