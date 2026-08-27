#!/usr/bin/env python3
"""Hermes overlay transforms — deterministic, marker-checked."""

from pathlib import Path
import re

ROOT = Path.cwd()
HERMES_COMMIT = "25a2b06"
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
    # Scoped idempotence: only return if memory.backend block already contains hermes values AND hermes option.
    # Avoid false positive from unrelated "hermes" (e.g., tools.format) by anchoring to exact memory.backend union.
    patched_values_pat = r'values:\s*\[\s*"off"\s*,\s*"local"\s*,\s*"hindsight"\s*,\s*"mnemopi"\s*,\s*"hermes"\s*\]\s*as const,'
    # Check if patched values exist and are after memory.backend marker
    if 'memory.backend' in text and re.search(patched_values_pat, text):
        # Locate memory.backend and patched values positions to ensure scope
        m_backend = re.search(r'"memory\.backend"', text)
        m_patched = re.search(patched_values_pat, text)
        if m_backend and m_patched and m_patched.start() > m_backend.start():
            # Also ensure hermes option exists near the backend block (within 2000 chars after)
            after = text[m_patched.end(): m_patched.end()+2500]
            if re.search(r'value:\s*"hermes"', after) or re.search(r'value:\s*"hermes"', text):
                # Further ensure description already patched or at least values is patched => consider idempotent
                # Check that the hermes option is indeed in the memory.backend UI options (search within ~3k after backend)
                mem_block = text[m_backend.start(): m_backend.start()+4000]
                if '"hermes"' in mem_block and 'MemoryBackendId' not in mem_block:  # sanity: mem_block should contain hermes option
                    # If both patched values and hermes option present in backend block, skip
                    if re.search(r'value:\s*"hermes"', mem_block):
                        return text
                # Fallback: if patched values present and hermes option anywhere after, assume patched
                # But ensure we don't mistake tools.format hermes - we already scoped to after memory.backend
                if re.search(r'value:\s*"hermes"', after):
                    return text
    # Patch values array: robust regex allowing whitespace/quote variations, but must match exactly one unpatched instance
    unpatched_values_pat = r'values:\s*\[\s*"off"\s*,\s*"local"\s*,\s*"hindsight"\s*,\s*"mnemopi"\s*\]\s*as const,'
    # Also handle single-quote variant if upstream switches quotes
    # Normalize to double-quote search; if not found try single-quote pattern
    if text.count('values: ["off", "local", "hindsight", "mnemopi"] as const,') == 1:
        old = 'values: ["off", "local", "hindsight", "mnemopi"] as const,'
        new = 'values: ["off", "local", "hindsight", "mnemopi", "hermes"] as const,'
        text = text.replace(old, new, 1)
    else:
        # Use regex fallback
        matches = list(re.finditer(unpatched_values_pat, text))
        # Also try single-quote version
        if not matches:
            sq_pat = r"values:\s*\[\s*'off'\s*,\s*'local'\s*,\s*'hindsight'\s*,\s*'mnemopi'\s*\]\s*as const,"
            matches = list(re.finditer(sq_pat, text))
            if len(matches) == 1:
                text = text[:matches[0].start()] + 'values: ["off", "local", "hindsight", "mnemopi", "hermes"] as const,' + text[matches[0].end():]
            else:
                raise SystemExit(f"overlay marker mismatch: packages/coding-agent/src/config/settings-schema.ts: {unpatched_values_pat[:80]!r}")
        elif len(matches) == 1:
            text = text[:matches[0].start()] + 'values: ["off", "local", "hindsight", "mnemopi", "hermes"] as const,' + text[matches[0].end():]
        else:
            raise SystemExit(f"overlay marker mismatch: packages/coding-agent/src/config/settings-schema.ts values: expected 1, got {len(matches)}")

    old_desc = 'description: "Off, local summary pipeline, Mnemopi SQLite, or Hindsight remote memory"'
    new_desc = 'description: "Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Hermes persistent memory"'
    if old_desc in text:
        if text.count(old_desc) != 1:
            raise SystemExit("overlay marker mismatch: settings-schema.ts description")
        text = text.replace(old_desc, new_desc, 1)
    else:
        # Try to detect already-patched description to keep idempotent
        if new_desc not in text:
            # Maybe upstream changed multiline formatting? Fallback regex for description
            desc_pat = r'description:\s*"Off,\s*local summary pipeline,\s*Mnemopi SQLite,\s*or Hindsight remote memory"'
            if len(list(re.finditer(desc_pat, text))) == 1:
                text = re.sub(desc_pat, new_desc, text, count=1)
            # If not found, leave as is - maybe upstream already changed description text, but we require at least values patched

    # Patch UI option for hermes: find mnemopi option block
    old_opt = '\t\t\t\t{\n\t\t\t\t\tvalue: "mnemopi",\n\t\t\t\t\tlabel: "Mnemopi",\n\t\t\t\t\tdescription: "Local SQLite recall/retain backend with optional embeddings",\n\t\t\t\t},'
    new_opt = '\t\t\t\t{\n\t\t\t\t\tvalue: "mnemopi",\n\t\t\t\t\tlabel: "Mnemopi",\n\t\t\t\t\tdescription: "Local SQLite recall/retain backend with optional embeddings",\n\t\t\t\t},\n\t\t\t\t{\n\t\t\t\t\tvalue: "hermes",\n\t\t\t\t\tlabel: "Hermes",\n\t\t\t\t\tdescription: "Hermes persistent memory (MEMORY.md/USER.md + SQLite FTS5) via pi-hermes-memory",\n\t\t\t\t},'
    if old_opt in text:
        # Only patch if hermes not already present after this block
        # Scope check: look ahead 800 chars after old_opt for hermes option
        idx = text.index(old_opt)
        after_opt = text[idx+len(old_opt): idx+len(old_opt)+1200]
        if 'value: "hermes"' not in after_opt:
            if text.count(old_opt) != 1:
                raise SystemExit("overlay marker mismatch: settings-schema.ts mnemopi option")
            text = text.replace(old_opt, new_opt, 1)
        # else already patched
    else:
        # Fallback regex for whitespace-tolerant matching
        mnemopi_opt_pat = r'\{\s*value:\s*"mnemopi"\s*,\s*label:\s*"Mnemopi"\s*,\s*description:\s*"Local SQLite recall/retain backend with optional embeddings"\s*,\s*\}'
        matches = list(re.finditer(mnemopi_opt_pat, text))
        if len(matches) == 1:
            m = matches[0]
            # Check if hermes already follows
            after = text[m.end(): m.end()+1200]
            if 'value: "hermes"' not in after and '"hermes"' not in after[:600]:
                # Insert hermes option after mnemopi block, preserving surrounding commas
                # Need to reconstruct with exact canonical formatting; insert after the matched block's comma handling
                # The matched block may or may not include trailing comma; our pattern includes optional comma via \s*,\s*?
                # Our pattern for mnemopi currently expects not trailing comma? Actually we included comma outside.
                # For fallback, handle both
                # Simpler: insert new hermes block after the matched mnemopi object
                insertion = ',\n\t\t\t\t{\n\t\t\t\t\tvalue: "hermes",\n\t\t\t\t\tlabel: "Hermes",\n\t\t\t\t\tdescription: "Hermes persistent memory (MEMORY.md/USER.md + SQLite FTS5) via pi-hermes-memory",\n\t\t\t\t}'
                # Check if original had trailing comma after the mnemopi object
                # If matched text ends with '},' we already have comma, just add hermes
                # Our regex currently matches without trailing comma capture; handle separately
                # Find the exact end position: extend to include trailing comma if present
                end = m.end()
                # If next non-whitespace char is ',', include it in replacement and then add hermes after
                # For idempotence, we will insert after the comma
                trailing = ""
                ws_after = text[end: end+20]
                # If directly after is comma, keep it
                if ws_after.lstrip().startswith(","):
                    # Find comma position
                    comma_idx = text.find(",", end)
                    end = comma_idx + 1
                else:
                    # Need to add comma before hermes if not present
                    insertion = ',' + insertion
                text = text[:end] + insertion + text[end:]
            # else already patched
        elif len(matches) == 0:
            # Check if already patched (hermes option exists)
            if 'value: "hermes"' in text and re.search(patched_values_pat, text):
                pass  # already patched, no action
            else:
                raise SystemExit(f"overlay marker mismatch: settings-schema.ts mnemopi option not found")
        else:
            raise SystemExit(f"overlay marker mismatch: settings-schema.ts mnemopi option expected 1, got {len(matches)}")
    return text

def hermes_types(text):
    # Scoped idempotence: check for exact hermes union in MemoryBackendId
    patched_pat = r'export\s+type\s+MemoryBackendId\s*=\s*["\']off["\']\s*\|\s*["\']local["\']\s*\|\s*["\']hindsight["\']\s*\|\s*["\']mnemopi["\']\s*\|\s*["\']hermes["\']\s*;'
    if re.search(patched_pat, text):
        return text
    # Also handle already patched but maybe spacing differs: simple check for hermes in MemoryBackendId line
    # Extract MemoryBackendId line
    m_line = re.search(r'export\s+type\s+MemoryBackendId\s*=\s*[^;]+;', text)
    if m_line and '"hermes"' in m_line.group(0) and "'hermes'" not in m_line.group(0) or '"hermes"' in m_line.group(0):
        # If line contains hermes, verify it also contains all 5 values -> then consider patched
        line = m_line.group(0)
        if all(v in line for v in ['"off"', '"local"', '"hindsight"', '"mnemopi"', '"hermes"']):
            return text
        if all(v in line for v in ["'off'", "'local'", "'hindsight'", "'mnemopi'", "'hermes'"]):
            return text

    # Try exact old string first for performance and strict marker
    old = 'export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi";'
    if text.count(old) == 1:
        new = 'export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi" | "hermes";'
        return text.replace(old, new, 1)
    # Fallback regex for unpatched (allow quote/spacing variations)
    unpatched_pat = r'export\s+type\s+MemoryBackendId\s*=\s*["\']off["\']\s*\|\s*["\']local["\']\s*\|\s*["\']hindsight["\']\s*\|\s*["\']mnemopi["\']\s*;'
    matches = list(re.finditer(unpatched_pat, text))
    if len(matches) != 1:
        raise SystemExit(f"overlay marker mismatch: types.ts: {old!r} (regex matched {len(matches)})")
    m = matches[0]
    new = 'export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi" | "hermes";'
    return text[:m.start()] + new + text[m.end():]

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
    # Scoped idempotence: check for exact hermes branch
    if re.search(r'if\s*\(id\s*===\s*["\']hermes["\']\)', text) and "hermesBackend" in text:
        # Ensure it's the expected import line
        if re.search(r'if\s*\(id\s*===\s*["\']hermes["\']\)\s*return\s*\(await import\(["\']\./hermes-backend["\']\)\)\.hermesBackend', text):
            return text
        # Still consider patched if hermes check exists - avoid duplicate
        return text
    # Try exact old string first
    old = 'if (id === "mnemopi") return (await import("../mnemopi/backend")).mnemopiBackend;'
    if text.count(old) == 1:
        new = 'if (id === "mnemopi") return (await import("../mnemopi/backend")).mnemopiBackend;\n\t// Hermes is optional (pi-hermes-memory may be absent) and pulls better-sqlite3; keep it off the startup graph.\n\tif (id === "hermes") return (await import("./hermes-backend")).hermesBackend;'
        return text.replace(old, new, 1)
    # Fallback regex for upstream formatting variations (quotes/spacing)
    # Match mnemopi line with flexible spacing/quotes
    mnemopi_pat = r'if\s*\(id\s*===\s*["\']mnemopi["\']\)\s*return\s*\(await import\(["\']\.\./mnemopi/backend["\']\)\)\.mnemopiBackend\s*;'
    matches = list(re.finditer(mnemopi_pat, text))
    if len(matches) != 1:
        raise SystemExit(f"overlay marker mismatch: resolve.ts: {old[:80]!r} (regex matched {len(matches)})")
    m = matches[0]
    # Preserve original mnemopi line text as found
    orig = m.group(0)
    insertion = orig + '\n\t// Hermes is optional (pi-hermes-memory may be absent) and pulls better-sqlite3; keep it off the startup graph.\n\tif (id === "hermes") return (await import("./hermes-backend")).hermesBackend;'
    return text[:m.start()] + insertion + text[m.end():]

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
    pattern = r"\n\t\}\n(\n*)\t/\*\*\n\t \* Apply the selected memory backend"
    matches = list(re.finditer(pattern, text))
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
