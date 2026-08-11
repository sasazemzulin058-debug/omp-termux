#!/usr/bin/env python3
"""Apply checked Android/Termux transformations to fresh upstream tree."""
from pathlib import Path

ROOT = Path.cwd()

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

def cargo(text):
    text = once(text, "anyhow.workspace = true\narboard.workspace = true\n", "anyhow.workspace = true\n", "Cargo.toml")
    marker = "[dev-dependencies]\n"
    return once(text, marker, "[target.'cfg(not(target_os = \"android\"))'.dependencies]\narboard.workspace = true\n\n" + marker, "Cargo.toml")

def crash(text):
    text = once(text, "\tsync::{\n\t\tOnce,\n\t\tatomic::{AtomicBool, Ordering},\n\t},", "\tsync::Once,", "crash_handler.rs")
    text = once(text, "static ALLOC_HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);\n", "", "crash_handler.rs")
    start = "\n\t\tstd::alloc::set_alloc_error_hook(|layout| {"
    if text.count(start) != 1:
        raise SystemExit("overlay marker mismatch: alloc hook")
    i = text.index(start)
    j = text.index("\n\t\t});", i) + len("\n\t\t});")
    text = text[:i] + "\n\t\t// alloc hook disabled on Android: unstable on bionic.\n" + text[j:]
    text = once(text, "\tAlloc,\n", "\t#[allow(dead_code, reason = \"alloc hook disabled on Android\")]\n\tAlloc,\n", "crash_handler.rs")
    text = once(text, "fn format_alloc_report(", "#[allow(dead_code, reason = \"alloc hook disabled on Android\")]\nfn format_alloc_report(", "crash_handler.rs")
    return once(text, "fn write_alloc_failure_line(", "#[allow(dead_code, reason = \"alloc hook disabled on Android\")]\nfn write_alloc_failure_line(", "crash_handler.rs")

def clipboard(text):
    for old, new in [
        ("use std::io::Cursor;", "#[cfg(not(target_os = \"android\"))]\nuse std::io::Cursor;"),
        ("use arboard::{", "#[cfg(not(target_os = \"android\"))]\nuse arboard::{"),
        ("use image::{", "#[cfg(not(target_os = \"android\"))]\nuse image::{"),
        ("use crate::task;", "#[cfg(not(target_os = \"android\"))]\nuse crate::task;"),
        ("fn encode_png(", "#[cfg(not(target_os = \"android\"))]\nfn encode_png("),
        ("#[cfg(target_os = \"linux\")]\nfn set_clipboard_text(", "#[cfg(all(target_os = \"linux\", not(target_os = \"android\")))]\nfn set_clipboard_text("),
        ("#[cfg(not(target_os = \"linux\"))]\nfn set_clipboard_text(", "#[cfg(all(not(target_os = \"linux\"), not(target_os = \"android\")))]\nfn set_clipboard_text("),
    ]:
        text = once(text, old, new, "clipboard.rs")
    stub = '''#[cfg(target_os = "android")]\nfn set_clipboard_text(_text: String) -> Result<()> {\n\tErr(Error::from_reason("Clipboard copy is not supported on Android/Termux native build; use termux-clipboard-set"))\n}\n\n'''
    text = once(text, "/// Read an image from the system clipboard.", stub + "/// Read an image from the system clipboard.", "clipboard.rs")
    text = once(text, "#[napi]\npub fn read_image_from_clipboard(", "#[cfg(not(target_os = \"android\"))]\n#[napi]\npub fn read_image_from_clipboard(", "clipboard.rs")
    return text + '''\n#[cfg(target_os = "android")]\n#[napi]\npub async fn read_image_from_clipboard() -> Result<Option<ClipboardImage>> { Ok(None) }\n'''

def process(text):
    return once(text, '#[cfg(target_os = "linux")]\nmod platform {', '#[cfg(any(target_os = "linux", target_os = "android"))]\nmod platform {', "process.rs")

def builtins(text):
    return once(text, '#[cfg(target_os = "linux")]\nmod proc_snapshot {', '#[cfg(any(target_os = "linux", target_os = "android"))]\nmod proc_snapshot {', "proc_snapshot.rs")

def loader(text):
    old = 'const SUPPORTED_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];'
    new = 'const SUPPORTED_PLATFORMS = ["linux-x64", "linux-arm64", "android-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];'
    return once(text, old, new, "loader-state.js")

edit("crates/pi-natives/Cargo.toml", cargo)
edit("crates/pi-natives/src/lib.rs", lambda s: once(s, "#![feature(alloc_error_hook)]\n", "", "lib.rs"))
edit("crates/pi-natives/src/crash_handler.rs", crash)
edit("crates/pi-natives/src/clipboard.rs", clipboard)
edit("crates/pi-shell/src/process.rs", process)
edit("crates/pi-builtins/src/proc_snapshot.rs", builtins)
edit("packages/natives/native/loader-state.js", loader)
print("Android overlay applied: 6 transformations")
