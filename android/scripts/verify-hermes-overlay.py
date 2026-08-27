#!/usr/bin/env python3
"""Narrow self-check for Hermes overlay idempotence and marker presence.

Runs on a fresh copy after rsync+overlay, or idempotently on an already-patched tree.
Verifies exact markers exist and that a second apply_hermes_overlay is a no-op.
"""

from pathlib import Path
import sys
import re

ROOT = Path.cwd()
OVERLAY_DIR = ROOT / "android" / "overlay" / "hermes"
HERMES_COMMIT = "25a2b06"
HERMES_SPEC = f"github:sasazemzulin058-debug/pi-hermes-memory#{HERMES_COMMIT}"

def _read(rel):
    return (ROOT / rel).read_text()

def require(rel, needle):
    txt = _read(rel)
    if needle not in txt:
        raise SystemExit(f"verify failed: {rel} missing {needle!r}")

def require_match(rel, pattern, desc):
    txt = _read(rel)
    if not re.search(pattern, txt):
        raise SystemExit(f"verify failed: {rel} missing {desc!r} (pattern {pattern!r})")

def require_absent(rel, needle, msg=""):
    txt = _read(rel)
    if needle in txt:
        raise SystemExit(f"verify failed: {rel} unexpectedly contains {needle!r} {msg}")

def main():
    # 1. Package pin
    require("packages/coding-agent/package.json", HERMES_SPEC)
    require_absent("packages/coding-agent/package.json", "pi-hermes-memory#main", "(mutable spec)")
    require("packages/coding-agent/package.json", '"@types/better-sqlite3": "catalog:"')
    require("package.json", '"@types/better-sqlite3": "^7.6.13"')

    # 2. Source markers — scoped to exact blocks to avoid false positives from unrelated "hermes" (e.g., tools.format)
    checks = {
        "packages/coding-agent/src/memory-backend/types.ts": 'MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi" | "hermes"',
        "packages/coding-agent/src/memory-backend/index.ts": 'export * from "./hermes-backend"',
        "packages/coding-agent/src/memory-backend/resolve.ts": 'if (id === "hermes")',
        "packages/coding-agent/src/session/session-memory.ts": "disposeHermesRuntimeForSession",
        "packages/coding-agent/src/session/agent-session.ts": "#disposeHermes",
    }
    for rel, needle in checks.items():
        require(rel, needle)

    # Additional precise checks for TS type safety (fail loudly if hermes type union missing -> TS2367)
    # Must verify MemoryBackendId union contains hermes and settings-schema memory.backend values contain hermes
    require_match(
        "packages/coding-agent/src/memory-backend/types.ts",
        r'export\s+type\s+MemoryBackendId\s*=\s*["\']off["\']\s*\|\s*["\']local["\']\s*\|\s*["\']hindsight["\']\s*\|\s*["\']mnemopi["\']\s*\|\s*["\']hermes["\']\s*;',
        'MemoryBackendId hermes union (TS2367 guard)'
    )
    # settings-schema: ensure memory.backend enum includes hermes (scoped to memory.backend block, not tools.format)
    settings_text = _read("packages/coding-agent/src/config/settings-schema.ts")
    # Find memory.backend block and verify it contains hermes values
    m_backend = re.search(r'"memory\.backend"', settings_text)
    if not m_backend:
        raise SystemExit('verify failed: packages/coding-agent/src/config/settings-schema.ts missing "memory.backend"')
    # Check for hermes values array after memory.backend
    hermes_values_pat = r'values:\s*\[\s*"off"\s*,\s*"local"\s*,\s*"hindsight"\s*,\s*"mnemopi"\s*,\s*"hermes"\s*\]\s*as const,'
    if not re.search(hermes_values_pat, settings_text):
        raise SystemExit('verify failed: packages/coding-agent/src/config/settings-schema.ts missing values: ["off", "local", "hindsight", "mnemopi", "hermes"] as const, (memory.backend not patched)')
    # Ensure hermes UI option exists within ~4k after memory.backend
    mem_block = settings_text[m_backend.start(): m_backend.start()+5000]
    if 'value: "hermes"' not in mem_block:
        raise SystemExit('verify failed: packages/coding-agent/src/config/settings-schema.ts missing value: "hermes" option in memory.backend block')
    # Ensure hermes description also patched
    if 'Hermes persistent memory' not in mem_block:
        raise SystemExit('verify failed: packages/coding-agent/src/config/settings-schema.ts missing Hermes persistent memory description')

    # Also verify resolve contains hermesBackend import handler
    require("packages/coding-agent/src/memory-backend/resolve.ts", "hermesBackend")

    # 3. New file existence and content
    for name, rel in [("hermes-backend.ts", "packages/coding-agent/src/memory-backend/hermes-backend.ts"),
                      ("hermes-backend.test.ts", "packages/coding-agent/test/hermes-backend.test.ts")]:
        src = OVERLAY_DIR / name
        if not src.is_file():
            raise SystemExit(f"verify failed: overlay template missing {src}")
        dst = ROOT / rel
        if not dst.is_file():
            raise SystemExit(f"verify failed: required hermes file missing {rel}")
        content = dst.read_text()
        if "#main" in content:
            raise SystemExit(f"verify failed: {rel} contains mutable #main")
        if name == "hermes-backend.ts":
            for needle in ["resolveHermesMemoryDir", "disposeHermesRuntimeForSession", "pi-hermes-memory/runtime"]:
                if needle not in content:
                    raise SystemExit(f"verify failed: {rel} missing {needle!r}")
        # Template and dst must match (overlay is the source of truth)
        template = src.read_text()
        if template != content:
            raise SystemExit(f"verify failed: {rel} diverges from overlay template {src}")
        # Check overlay template itself not mutable
        if "#main" in template:
            raise SystemExit(f"verify failed: overlay template {src} contains #main")

    # 4. Idempotence: second apply should be no-op (changed == 0)
    # Import hermes_overlay helper via importlib to avoid PYTHONPATH issues
    import importlib.util
    spec = importlib.util.spec_from_file_location("hermes_overlay", str(ROOT / "android" / "scripts" / "hermes_overlay.py"))
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)  # type: ignore
    # Snapshot mtimes
    before = {}
    for rel in list(checks.keys()) + ["packages/coding-agent/src/config/settings-schema.ts", "packages/coding-agent/src/memory-backend/hermes-backend.ts", "packages/coding-agent/test/hermes-backend.test.ts", "packages/coding-agent/package.json", "package.json"]:
        p = ROOT / rel
        before[rel] = p.read_text() if p.exists() else None
    changed = mod.apply_hermes_overlay()
    if changed != 0:
        raise SystemExit(f"verify failed: hermes overlay not idempotent, second apply changed {changed} files")
    # Verify files unchanged after second apply
    for rel, old in before.items():
        cur = (ROOT / rel).read_text() if (ROOT / rel).exists() else None
        if cur != old:
            raise SystemExit(f"verify failed: {rel} changed on second apply (not idempotent)")

    # 5. Ensure mutable #main not present anywhere in overlay-transformed files
    for rel in ["packages/coding-agent/package.json", "packages/coding-agent/src/memory-backend/hermes-backend.ts"]:
        require_absent(rel, "#main", "in hermes context")

    print(f"verify-hermes-overlay: ok (pinned {HERMES_COMMIT}, {len(checks)+2} markers, idempotent)")

if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        # Ensure non-zero exit prints message
        if e.code and isinstance(e.code, str):
            print(e.code, file=sys.stderr)
            sys.exit(1)
        raise
