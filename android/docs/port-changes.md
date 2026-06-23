# Port changes: oh-my-pi → Termux/Android (aarch64)

Catalog of every delta from upstream, why it exists, and how it was verified.
All deltas are delivered as patches under `android/patches/` — the upstream
source tree is unmodified until `apply-patches.sh` runs.

## Target facts (verified)

- `rustc --print cfg --target aarch64-linux-android` →
  `target_family="unix"`, `target_os="android"`, `unix`. **`target_os="linux"`
  is NOT set.** This is the single most important fact: any code gated on
  `target_os = "linux"` is dead on Android, and any `not(target_os = "linux")`
  branch fires on Android.
- Termux's own Rust reports `host: aarch64-linux-android`, so an on-device build
  is a native (non-cross) build — no NDK needed.
- Bun on Android reports `process.platform === "android"`, `process.arch ===
  "arm64"` → loader platform tag `android-arm64`, addon file
  `pi_natives.android-arm64.node`.
- bionic provides `forkpty`/`openpty` since API 23 → `portable-pty` works.
- `pidfd_open`/`pidfd_send_signal` work on Android 14+ (API 34). On API 31–33
  seccomp may SIGSYS-kill the syscall, hence the API 34 floor in the installer.

## Patch 01 — Cargo.toml: gate arboard

`arboard` has no bionic backend (no X11/Wayland/AppKit/Win32 surface available
to native code in Termux). Moving it from unconditional `[dependencies]` to
`[target.'cfg(not(target_os = "android"))'.dependencies]` keeps it off the
Android build entirely. Verified: `cargo check -p pi-natives` on
`aarch64-linux-android` completes with no arboard in the dependency graph.

## Patch 02 — lib.rs: drop feature(alloc_error_hook)

`#![feature(alloc_error_hook)]` is nightly-only. Termux ships **stable** Rust
(1.95.0). Removing the feature attribute lets the crate compile on stable. The
runtime alloc-error diagnostics are sacrificed (see patch 03).

## Patch 03 — crash_handler.rs: disable alloc hook

`std::alloc::set_alloc_error_hook` requires the removed feature, so the
registration block is replaced with a comment. The alloc-report helpers
(`format_alloc_report`, `write_alloc_failure_line`, `CrashKind::Alloc`) are kept
— the unit tests still exercise them — but marked `#[allow(dead_code)]` and the
now-unused `ALLOC_HOOK_ACTIVE` static and `atomic::Ordering` import are removed
so the lib compiles warning-clean. Panic diagnostics are unaffected.

## Patch 04 — clipboard.rs: Android cfg gates + stubs

The most involved patch. Because `target_os = "linux"` is false on Android, the
existing `#[cfg(not(target_os = "linux"))]` arm would otherwise select the
arboard path on Android. Changes:

- `use std::io::Cursor`, `use arboard::…`, `use image::…`, `use crate::task`
  gated `#[cfg(not(target_os = "android"))]`.
- `encode_png` gated `#[cfg(not(target_os = "android"))]`.
- Linux arm tightened to `#[cfg(all(target_os = "linux", not(target_os = "android")))]`.
- macOS/Windows arm tightened to `#[cfg(all(not(target_os = "linux"), not(target_os = "android")))]`.
- Android `set_clipboard_text` stub returns an error (copy unsupported; JS can
  fall back to `termux-clipboard-set`).
- `read_image_from_clipboard` split: the arboard version gated
  `#[cfg(not(target_os = "android"))]`; an Android `async fn` returns `Ok(None)`.

Both `#[napi]` exports keep the same name so the JS binding surface is identical
on every platform. Verified: `cargo check -p pi-natives` clean on Android.

## Patch 05 — process.rs: enable platform module on Android

The Linux `mod platform` (pidfd-based process management) is gated
`#[cfg(target_os = "linux")]`, which excludes Android. Widened to
`#[cfg(any(target_os = "linux", target_os = "android"))]`. The macOS and Windows
`mod platform` blocks are left untouched. Verified: `cargo check -p pi-shell`
clean on Android.

## Patch 06 — loader-state.js: register android-arm64

`SUPPORTED_PLATFORMS` did not list `android-arm64`, so the loader would reject
the addon at startup. Added `"android-arm64"` to the array. The loader builds
its platform tag from `${process.platform}-${process.arch}`, which is
`android-arm64` under Bun on Termux.

## Verification performed

- `rustc --print cfg --target aarch64-linux-android` — confirmed target_os.
- `cargo check -p pi-natives` on host `aarch64-linux-android` — **0 errors, 0
  warnings** after patches.
- `cargo check -p pi-shell` on host `aarch64-linux-android` — clean.
- `git apply --check` on all six patches individually and combined — clean
  against the upstream tree.

## Not yet runtime-verified

- Full `bun --cwd=packages/natives run build` producing the `.node` (compile is
  proven via `cargo check`; the napi link/copy step is exercised by CI).
- End-to-end `omp` run on-device.
