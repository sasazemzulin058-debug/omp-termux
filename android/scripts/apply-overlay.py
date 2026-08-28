#!/usr/bin/env python3
"""Apply checked Android/Termux transformations to fresh upstream tree."""
from pathlib import Path

ROOT = Path.cwd()

# Hermes overlay helpers (deterministic, marker-checked)
try:
    from hermes_overlay import apply_hermes_overlay
except ImportError:
    # Fallback when run from different cwd via python3 android/scripts/apply-overlay.py
    import importlib.util, sys
    spec = importlib.util.spec_from_file_location("hermes_overlay", str(ROOT / "android" / "scripts" / "hermes_overlay.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["hermes_overlay"] = mod
    assert spec and spec.loader
    spec.loader.exec_module(mod)  # type: ignore
    apply_hermes_overlay = mod.apply_hermes_overlay

def edit(rel, transform):
    path = ROOT / rel
    text = path.read_text()
    new = transform(text)
    if new == text:
        raise SystemExit(f"overlay made no change: {rel}")
    path.write_text(new)

def once(text, old, new, rel):
    if text.count(old) != 1:
        raise SystemExit(f"overlay marker mismatch: {rel}: {old[:80]!r}")
    return text.replace(old, new)

def apply_browser_overlay():
    """Apply browser changes after upstream import; fail closed on drift."""
    import subprocess
    patch = ROOT / "android" / "overlay" / "browser-fork.patch"
    if not patch.is_file() or patch.stat().st_size == 0:
        raise SystemExit(f"browser overlay missing or empty: {patch}")
    command = ["git", "apply", "--whitespace=nowarn", "--check", str(patch)]
    checked = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    if checked.returncode != 0:
        detail = (checked.stderr or checked.stdout).strip()
        raise SystemExit(f"browser overlay check failed: {detail}")
    applied = subprocess.run(
        ["git", "apply", "--whitespace=nowarn", str(patch)],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    if applied.returncode != 0:
        detail = (applied.stderr or applied.stdout).strip()
        raise SystemExit(f"browser overlay failed to apply: {detail}")
    template = ROOT / "android" / "overlay" / "browser" / "browser-android.test.ts"
    target = ROOT / "packages" / "coding-agent" / "test" / "tools" / "browser-android.test.ts"
    if not template.is_file():
        raise SystemExit(f"browser overlay missing test template: {template}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(template.read_text())
    return True
def browser_settings(text):
    marker = '\t"browser.screenshotDir": {'
    entry = '''\t"browser.executablePath": {
\t\ttype: "string",
\t\tdefault: undefined,
\t\tui: {
\t\t\ttab: "tools",
\t\t\tgroup: "Grep & Browser",
\t\t\tlabel: "Browser Executable Path",
\t\t\tdescription:
\t\t\t\t"Absolute path to the Chromium/Chrome executable for headless automation. Takes precedence over PUPPETEER_EXECUTABLE_PATH. Invalid explicit path fails closed.",
\t\t},
\t},
'''
    if '"browser.executablePath"' in text:
        return text
    return once(text, marker, entry + marker, "settings-schema.ts")

def cargo(text):
    # Drop arboard + pi-voice from always-on deps; re-add under not-android.
    # pi-voice/webrtc OOMs free GH runners (~15G+24G swap still killed).
    # Idempotent: if target cfg already present, verify and ensure pi-voice under it.
    has_target = "[target.'cfg(not(target_os = \"android\"))'.dependencies]" in text
    has_upstream = "anyhow.workspace = true\narboard.workspace = true\n" in text
    if has_target:
        # Already patched — validate anyhow alone and handle any remaining pi-voice drift.
        if "anyhow.workspace = true\n" not in text:
            raise SystemExit("overlay marker mismatch: Cargo.toml: anyhow missing after patch")
        # If upstream pi-voice trio still present before target (partial patch), strip it.
        if "pi-voice.workspace = true\n" in text and "pi-voice stubbed on Android" not in text:
            before_target = text.split("[target.'cfg(not(target_os = \"android\"))'.dependencies]")[0]
            if "pi-shell.workspace = true\npi-voice.workspace = true\npi-walker.workspace = true\n" in before_target:
                text = once(
                    text,
                    "pi-shell.workspace = true\npi-voice.workspace = true\npi-walker.workspace = true\n",
                    "pi-shell.workspace = true\npi-walker.workspace = true\n",
                    "Cargo.toml",
                )
        # Ensure pi-voice is present under target cfg (idempotent)
        if "pi-voice.workspace = true" not in text.split("[dev-dependencies]")[0].split(
            "[target.'cfg(not(target_os = \"android\"))'.dependencies]"
        )[-1]:
            text = once(
                text,
                "[target.'cfg(not(target_os = \"android\"))'.dependencies]\narboard.workspace = true\n",
                "[target.'cfg(not(target_os = \"android\"))'.dependencies]\narboard.workspace = true\n# pi-voice stubbed on Android: webrtc/opus OOMs free GH runners.\npi-voice.workspace = true\n",
                "Cargo.toml",
            )
        return text
    if not has_upstream:
        raise SystemExit("overlay marker mismatch: Cargo.toml: 'anyhow.workspace = true\\narboard.workspace = true\\n'")
    text = once(text, "anyhow.workspace = true\narboard.workspace = true\n", "anyhow.workspace = true\n", "Cargo.toml")
    # After upstream sync pi-voice is next to pi-shell; strip it from always-on.
    if "pi-voice.workspace = true\n" in text and "pi-voice stubbed on Android" not in text:
        text = once(
            text,
            "pi-shell.workspace = true\npi-voice.workspace = true\npi-walker.workspace = true\n",
            "pi-shell.workspace = true\npi-walker.workspace = true\n",
            "Cargo.toml",
        )
    marker = "[dev-dependencies]\n"
    insert = (
        "[target.'cfg(not(target_os = \"android\"))'.dependencies]\n"
        "arboard.workspace = true\n"
        "# pi-voice stubbed on Android: webrtc/opus OOMs free GH runners.\n"
        "pi-voice.workspace = true\n\n"
    )
    return once(text, marker, insert + marker, "Cargo.toml")

def crash(text):
    text = once(text, "\tsync::{\n\t\tOnce,\n\t\tatomic::{AtomicBool, Ordering},\n\t},", "\tsync::Once,", "crash_handler.rs")
    text = once(text, "static ALLOC_HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);\n", "", "crash_handler.rs")
    start = "\n\t\tstd::alloc::set_alloc_error_hook(|layout| {"
    if text.count(start) != 1:
        raise SystemExit("overlay marker mismatch: alloc hook")
    i = text.index(start)
    j = text.index("\n\t\t});", i) + len("\n\t\t});")
    text = text[:i] + "\n\t\t// alloc hook disabled on Android: unstable on bionic." + text[j:]
    text = once(text, "\tAlloc,\n", "\t#[allow(dead_code, reason = \"alloc hook disabled on Android\")]\n\tAlloc,\n", "crash_handler.rs")
    text = once(text, "fn format_alloc_report(", "#[allow(dead_code, reason = \"alloc hook disabled on Android\")]\nfn format_alloc_report(", "crash_handler.rs")
    return once(text, "fn write_alloc_failure_line(", "#[allow(dead_code, reason = \"alloc hook disabled on Android\")]\nfn write_alloc_failure_line(", "crash_handler.rs")

def clipboard(text):
    for old, new in [
        ("use std::io::Cursor;", "#[cfg(not(target_os = \"android\"))]\nuse std::io::Cursor;"),
        ("use arboard::{", "#[cfg(not(target_os = \"android\"))]\nuse arboard::{"),
        ("use image::{", "#[cfg(not(target_os = \"android\"))]\nuse image::{"),
        ("use crate::{js, task};", "use crate::js;\n#[cfg(not(target_os = \"android\"))]\nuse crate::task;"),
        ("fn encode_png(", "#[cfg(not(target_os = \"android\"))]\nfn encode_png("),
        ("fn rgba_to_png(", "#[cfg(not(target_os = \"android\"))]\nfn rgba_to_png("),
        ("fn dib_to_png(", "#[cfg(not(target_os = \"android\"))]\nfn dib_to_png("),
        ("#[cfg(target_os = \"linux\")]\nfn set_clipboard_text(", "#[cfg(all(target_os = \"linux\", not(target_os = \"android\")))]\nfn set_clipboard_text("),
        ("#[cfg(not(target_os = \"linux\"))]\nfn set_clipboard_text(", "#[cfg(all(not(target_os = \"linux\"), not(target_os = \"android\")))]\nfn set_clipboard_text("),
    ]:
        text = once(text, old, new, "clipboard.rs")
    stub = '''#[cfg(target_os = "android")]
fn set_clipboard_text(_text: &str) -> Result<()> {
\tErr(Error::from_reason(
\t\t"Clipboard copy is not supported on Android/Termux native build; use termux-clipboard-set",
\t))
}

'''
    text = once(text, "/// Read an image from the system clipboard.", stub + "/// Read an image from the system clipboard.", "clipboard.rs")
    text = once(text, "#[napi]\npub fn read_image_from_clipboard(", "#[cfg(not(target_os = \"android\"))]\n#[napi]\npub fn read_image_from_clipboard(", "clipboard.rs")
    return text + '''
#[cfg(target_os = "android")]
#[napi]
pub async fn read_image_from_clipboard() -> Result<Option<ClipboardImage>> {
\tOk(None)
}
'''

def process(text):
    return once(text, '#[cfg(target_os = "linux")]\nmod platform {', '#[cfg(any(target_os = "linux", target_os = "android"))]\nmod platform {', "process.rs")

def builtins(text):
    old = '#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]'
    if old in text:
        text = text.replace(old, '#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos", target_os = "windows"))]')
    return once(text, '#[cfg(target_os = "linux")]\nmod proc_snapshot {', '#[cfg(any(target_os = "linux", target_os = "android"))]\nmod proc_snapshot {', "proc_snapshot.rs")

def loader(text):
    json_import = 'import packageJson from "../package.json" with { type: "json" };'
    json_require = 'const packageJson = createRequire(import.meta.url)("../package.json");'
    if json_import in text:
        text = once(text, json_import, json_require, "loader-state.js")
    old = 'const SUPPORTED_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];'
    new = 'const SUPPORTED_PLATFORMS = ["linux-x64", "linux-arm64", "android-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];'
    if old in text:
        text = once(text, old, new, "loader-state.js")
    return text
def cli(text):
    text = once(text, 'import { startComputerWorker } from "./tools/computer/worker-entry";\n', "", "cli.ts")
    old_dispatch = '\tif (arg === COMPUTER_WORKER_ARG) {\n\t\tif (parentPort) installWorkerInbox(parentPort);\n\t\tstartComputerWorker();\n\t\treturn true;\n\t}'
    new_dispatch = '\tif (arg === COMPUTER_WORKER_ARG) {\n\t\tif (parentPort) installWorkerInbox(parentPort);\n\t\t// Dynamic import prevents eager native addon path in cold CLI startup graph.\n\t\tconst { startComputerWorker } = await import("./tools/computer/worker-entry");\n\t\tstartComputerWorker();\n\t\treturn true;\n\t}'
    return once(text, old_dispatch, new_dispatch, "cli.ts")

def lib(text):
    text = once(text, "#![feature(alloc_error_hook)]\n", "", "lib.rs")
    text = once(text, "pub mod audio;\n", "#[cfg(not(target_os = \"android\"))]\npub mod audio;\n", "lib.rs")
    return once(text, "pub mod live;\n", "#[cfg(not(target_os = \"android\"))]\npub mod live;\n", "lib.rs")

def webrtc(text):
    # napi-build parses files via regex/syn ignoring module-level #![cfg].
    # We must physically remove #[napi] markers so it stops generating C ABI
    # wrappers that reference disabled pi_voice modules.
    text = text.replace("#[napi]", "/* #[napi] disabled on android */")
    return text

def update_cli(text):
    if "Self-update is disabled on Android" in text:
        return text
    guard = '''\tconsole.log(chalk.dim(`Current version: ${VERSION}`));

\t// Android/Termux: self-update downloads desktop binaries; block early.
\tif (process.platform === "android" || process.env.OMP_PLATFORM === "android" || process.env.TERMUX_VERSION) {
\t\tconsole.log(chalk.yellow("Self-update is disabled on Android/Termux."));
\t\tconsole.log(
\t\t\tchalk.dim(
\t\t\t\t"Update via: curl -fsSL https://github.com/sasazemzulin058-debug/omp-termux/releases/latest/download/omp-termux.tar.gz | tar xz",
\t\t\t),
\t\t);
\t\treturn;
\t}
'''
    # Upstream v18.0.6+ adds optional channel param — try new marker first
    marker_new = "export async function runUpdateCommand(opts: {\n\tforce: boolean;\n\tcheck: boolean;\n\tchannel?: UpdateChannel;\n}): Promise<void> {\n\tconsole.log(chalk.dim(`Current version: ${VERSION}`));\n"
    if marker_new in text:
        if text.count(marker_new) != 1:
            raise SystemExit(f"overlay marker mismatch: update-cli.ts: {marker_new[:80]!r}")
        return text.replace(marker_new, "export async function runUpdateCommand(opts: {\n\tforce: boolean;\n\tcheck: boolean;\n\tchannel?: UpdateChannel;\n}): Promise<void> {\n" + guard, 1)
    marker_old = "export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {\n\tconsole.log(chalk.dim(`Current version: ${VERSION}`));\n"
    if marker_old in text:
        return once(text, marker_old, "export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {\n" + guard, "update-cli.ts")
    # Fallback: flexible insertion after first console.log inside runUpdateCommand
    func_idx = text.find("export async function runUpdateCommand")
    if func_idx != -1:
        log = "\tconsole.log(chalk.dim(`Current version: ${VERSION}`));\n"
        log_idx = text.find(log, func_idx)
        if log_idx != -1:
            # guard already contains the log line — replace single log with guard
            return text[:log_idx] + guard + text[log_idx + len(log):]
    raise SystemExit(f"overlay marker mismatch: update-cli.ts: 'export async function runUpdateCommand...'")

def native_index(text):
    stub = '''
// Android: audio/live/webrtc modules are excluded from native addon.
// Provide stub classes that throw a clear error instead of undefined TypeError.
function _unsupported(name) {
  return class {
    constructor() { throw new Error(`${name} is not available on Android/Termux`); }
  };
}
'''
    if "_unsupported" in text:
        return text
    text = text.replace("const nativeBindings = loadNative();\n", "const nativeBindings = loadNative();\n" + stub)
    text = text.replace("export const AudioCapture = nativeBindings.AudioCapture;", 'export const AudioCapture = nativeBindings.AudioCapture ?? _unsupported("AudioCapture");')
    text = text.replace("export const AudioPlayback = nativeBindings.AudioPlayback;", 'export const AudioPlayback = nativeBindings.AudioPlayback ?? _unsupported("AudioPlayback");')
    text = text.replace("export const LiveWebRtcPeer = nativeBindings.LiveWebRtcPeer;", 'export const LiveWebRtcPeer = nativeBindings.LiveWebRtcPeer ?? _unsupported("LiveWebRtcPeer");')
    return text

edit("crates/pi-natives/Cargo.toml", cargo)
edit("crates/pi-natives/src/lib.rs", lib)
edit("crates/pi-natives/src/audio.rs", webrtc)
edit("crates/pi-natives/src/live.rs", webrtc)

edit("crates/pi-natives/src/crash_handler.rs", crash)
edit("crates/pi-natives/src/clipboard.rs", clipboard)
edit("crates/pi-shell/src/process.rs", process)
edit("crates/pi-builtins/src/proc_snapshot.rs", builtins)
edit("crates/pi-builtins/src/ps.rs", lambda s: s.replace('#[cfg(target_os = "linux")]\nfn ps_total_memory_bytes()', '#[cfg(any(target_os = "linux", target_os = "android"))]\nfn ps_total_memory_bytes()', 1) if '#[cfg(target_os = "linux")]\nfn ps_total_memory_bytes()' in s else s)
edit("packages/natives/native/loader-state.js", loader)
edit("packages/coding-agent/src/cli.ts", cli)
edit("packages/coding-agent/src/cli/update-cli.ts", update_cli)
edit("packages/natives/native/index.js", native_index)
# Hermes overlay — must run after upstream rsync to recreate OMP hermes files
try:
    hermes_changed = apply_hermes_overlay()
except SystemExit:
    raise
except Exception as e:
    raise SystemExit(f"hermes overlay failed: {e}") from e
# Browser overlay must run after upstream import and Hermes overlay. It owns
# browser runtime files while keeping Chromium external to the OMP bundle.
browser_settings_path = ROOT / "packages" / "coding-agent" / "src" / "config" / "settings-schema.ts"
browser_settings_path.write_text(browser_settings(browser_settings_path.read_text()))
try:
    apply_browser_overlay()
except SystemExit:
    raise
except Exception as e:
    raise SystemExit(f"browser overlay failed: {e}") from e
print(f"Android overlay applied: 11 transformations + Hermes overlay ({hermes_changed} hermes files changed if any) + browser overlay")
