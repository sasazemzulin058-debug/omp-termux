#!/usr/bin/env python3
"""Narrow self-check for Hermes overlay idempotence and marker presence.

Runs on a fresh copy after rsync+overlay, or idempotently on an already-patched tree.
Verifies exact markers exist and that a second apply_hermes_overlay is a no-op.
"""

from pathlib import Path
import sys

ROOT = Path.cwd()
OVERLAY_DIR = ROOT / "android" / "overlay" / "hermes"
HERMES_COMMIT = "f20e315"
HERMES_SPEC = f"github:sasazemzulin058-debug/pi-hermes-memory#{HERMES_COMMIT}"

def _read(rel):
    return (ROOT / rel).read_text()

def require(rel, needle):
    txt = _read(rel)
    if needle not in txt:
        raise SystemExit(f"verify failed: {rel} missing {needle!r}")

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

    # 2. Source markers
    checks = {
        "packages/coding-agent/src/config/settings-schema.ts": '"hermes"',
        "packages/coding-agent/src/memory-backend/types.ts": 'MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi" | "hermes"',
        "packages/coding-agent/src/memory-backend/index.ts": 'export * from "./hermes-backend"',
        "packages/coding-agent/src/memory-backend/resolve.ts": 'hermesBackend',
        "packages/coding-agent/src/session/session-memory.ts": "disposeHermesRuntimeForSession",
        "packages/coding-agent/src/session/agent-session.ts": "#disposeHermes",
    }
    for rel, needle in checks.items():
        require(rel, needle)

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
    for rel in list(checks.keys()) + ["packages/coding-agent/src/memory-backend/hermes-backend.ts", "packages/coding-agent/test/hermes-backend.test.ts", "packages/coding-agent/package.json", "package.json"]:
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

    print(f"verify-hermes-overlay: ok (pinned {HERMES_COMMIT}, {len(checks)} markers, idempotent)")

if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        # Ensure non-zero exit prints message
        if e.code and isinstance(e.code, str):
            print(e.code, file=sys.stderr)
            sys.exit(1)
        raise
