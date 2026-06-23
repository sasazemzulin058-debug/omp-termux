# oh-my-pi on Termux (Android, aarch64)

This directory is the entire Android/Termux overlay for [oh-my-pi](https://github.com/can1357/oh-my-pi).
It is a thin, patch-based fork: the upstream source is left untouched on disk,
and a handful of patches are applied on top to make the native Rust addon build
and run on Android's bionic libc. Everything Android-specific lives here.

## Layout

```
android/
├── patches/        # source patches applied onto upstream (git apply)
├── scripts/        # apply-patches, build, install, regen
└── docs/           # setup + maintenance docs
```

## Quick start (end user)

On a Termux session (Android 14+, aarch64):

```sh
curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/android/scripts/install-termux.sh | bash
omp --version
```

This installs `rust`, `clang`, `git`, and `bun`, clones the repo, applies the
patches, builds the native addon on-device (~10 min), and installs an `omp`
launcher into `$PREFIX/bin`.

## Build paths

| Path | Where | Script |
|------|-------|--------|
| On-device | Termux (host = aarch64-linux-android) | `android/scripts/build-termux.sh` |
| Cross-compile | CI / Linux x86_64 + zig | `.github/workflows/android-build.yml` |
| Prebuilt | GitHub Release on `v*` tag | `.github/workflows/android-release.yml` |

## The patches

Six patches, each a single concern, applied in numeric order:

| Patch | File | Why |
|-------|------|-----|
| 01 | `crates/pi-natives/Cargo.toml` | Gate `arboard` to non-Android (no bionic clipboard backend) |
| 02 | `crates/pi-natives/src/lib.rs` | Drop nightly-only `feature(alloc_error_hook)` |
| 03 | `crates/pi-natives/src/crash_handler.rs` | Disable the alloc-error hook; keep tests via `#[allow(dead_code)]` |
| 04 | `crates/pi-natives/src/clipboard.rs` | Android cfg gates + stubs for clipboard fns |
| 05 | `crates/pi-shell/src/process.rs` | Enable the Linux `platform` module on `target_os = "android"` |
| 06 | `packages/natives/native/loader-state.js` | Add `android-arm64` to `SUPPORTED_PLATFORMS` |

A critical detail: for the `aarch64-linux-android` target, `rustc` sets
`target_os = "android"` and **`target_os = "linux"` is false**. Patch 04 keeps
the Linux clipboard path gated on `all(target_os = "linux", not(target_os = "android"))`
so the arboard-backed code is never selected on Android, and patch 05 uses
`any(target_os = "linux", target_os = "android")` for the shared process module.

See [docs/port-changes.md](docs/port-changes.md) for the full rationale.

## Maintenance

Patches are stored as `git diff` output and validated with `git apply --check`.
To rebase onto a newer upstream:

```sh
git fetch upstream && git merge upstream/main   # or rebase
android/scripts/apply-patches.sh                 # apply; fails loudly on drift
# ... fix conflicts in the 6 target files by hand ...
android/scripts/regen-patches.sh                 # rewrite patches from the tree
git checkout -- crates/ packages/                # reset tree to clean upstream
```
