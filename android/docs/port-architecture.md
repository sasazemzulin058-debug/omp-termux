# Port architecture: oh-my-pi on Android arm64 / Termux

This document explains *how* the oh-my-pi native stack runs on Android.
It is the design companion to [port-changes.md](port-changes.md) (what
changed, current vs. pending) and [ci-cd.md](ci-cd.md) (how CI builds it).
Everything Android-specific lives under `android/`.

The upstream tree is only ever modified by the deterministic overlay —
see [port-changes.md](port-changes.md#delivery). The architecture below is
the decided target; staged rollout is tracked in
`../../specs/ANDROID_IMPLEMENTATION_PLAN.md`.

## 1. The target

| Fact | Value |
|------|-------|
| Target triple | `aarch64-linux-android` |
| CPU | aarch64 (arm64) |
| libc | **bionic** (Android's libc), not glibc, not musl |
| Rust `target_os` | `"android"` |
| Runtime | official Bionic Bun, bundled in the release tarball |
| Native addon | N-API (napi-rs) shared object, `pi_natives.android-arm64.node` |

### The single most important rustc fact

For `--target aarch64-linux-android`, rustc sets
`target_os = "android"` **and does NOT set `target_os = "linux"`**:

```
$ rustc --print cfg --target aarch64-linux-android
target_arch="aarch64"
target_family="unix"
target_os="android"
unix
```

Consequences that drive every patch:

- `#[cfg(target_os = "linux")]` code is **dead** on Android.
- `#[cfg(not(target_os = "linux"))]` branches **fire** on Android.
- Gate shared Linux/Android code with
  `#[cfg(any(target_os = "linux", target_os = "android"))]`.

### Builds are native on-device, cross in CI

Termux's own Rust reports `host: aarch64-linux-android`, so an on-device
build is a *native* build with no NDK and no cross toolchain. Only GitHub
Actions cross-compiles (Linux x86_64 → aarch64-linux-android) with the NDK.

## 2. The runtime contract

### Bundled Bionic Bun, not apt/proot Bun

The release tarball is **self-contained and Bionic-only**. It bundles the
official `@oven/bun-linux-aarch64-android` Bionic binary (PIE, interpreter
`/system/bin/linker64`) inside `$LIB_DIR`. A thin shim executes it directly:

```sh
exec env OMP_PLATFORM=android "$LIB_DIR/bun" "$LIB_DIR/cli.js" "$@"
```

The shim runs `$LIB_DIR/bun`, **never** `$PREFIX/bin/bun`. The installer no
longer installs Termux's apt `bun` package. Mixing a glibc-wrapper Bun with
a Bionic NDK `.node` is an unsupported ABI configuration and is prohibited.
`bun build --compile` is also prohibited: the built Android standalone
binary segfaulted on every attempt, so the runtime remains packaged Bun
plus JS chunks.

Bun version pins live in a single `android/versions.env` (BUN, NDK,
ANDROID_API, RUST), read by both workflows and the install/package scripts.
Version changes land only together with the addon and after the on-device
smoke test.

### Measured split packaging

The JS package is built with `Bun.build` and **`splitting: true`** required.
Whole-tree packaging is used — the build copies the entire `outDir`; the
shebang sits only on `cli.js`; there is no manifest; all chunks and assets
are tarred.

| Metric | Monolith | Split | Delta |
|--------|----------|-------|-------|
| Entry `cli.js` | — | 22,608 B / 322 files | — |
| `omp --version` median | 640 ms | 134 ms | ~4.8x |
| RSS | 129–144 MB | 54.9 MB | ~2x |

Targets: startup `--version` median ≤ 200 ms, HWM ≤ 65 MB. Splitting moves
runtime resources off the cold path — it does **not** remove them.

### Runtime resources

`models.json`, protobuf data, `CHANGELOG`, and `templates/` + tool views
are required at runtime. Splitting relocates them to lazy chunks/payloads;
it never drops them. OpenTelemetry must stay bundled into lazy chunks —
a stale local `node_modules` once caused the experimental-subcommand
failure, not splitting.

## 3. What ships in the release bundle

The release bundle `omp-termux.tar.gz` is a self-contained Bun app:

```
$LIB_DIR/
├── bun                  # official @oven/bun-linux-aarch64-android (Bionic PIE)
├── cli.js               # split entry, shebang #!/usr/bin/env bun
├── chunks/              # lazy code-split chunks + assets
└── node_modules/@oh-my-pi/pi-natives/native/
    ├── index.js
    ├── loader-state.js
    ├── embedded-addon.js
    ├── clipboard.js
    └── pi_natives.android-arm64.node   # the stripped aarch64 addon
```

The tarball needs no external runtime download. It owns Bun, JS chunks/assets,
and pi-natives as one versioned Bionic unit. The guarded installer and Android update
guard shown here are target contracts; current rollout status lives in
[port-changes.md](port-changes.md#current-state-vs-approved-pending).

### Bun platform tag and the loader

Under Bun on Termux: `process.platform === "android"`, `process.arch ===
"arm64"`. The loader builds its tag as `${process.platform}-${process.arch}`
= **`android-arm64`**; `packages/natives/native/loader-state.js`
(`SUPPORTED_PLATFORMS`) must contain it or the addon is rejected at
startup. `getAddonFilenames()` maps it to `pi_natives.android-arm64.node`.

### The addon

- Built by napi-rs from `crates/pi-natives` plus the `pi-shell`,
  `pi-builtins`, `pi-iso` crate family.
- `cargo build` produces `libpi_natives.so`; packaging renames it to
  `pi_natives.android-arm64.node` (a shared ELF object dlopen'd by Bun) and
  strips it with `llvm-strip --strip-unneeded`.
- Resident footprint is **only 6–8 MB after use**, and **0 KB on the
  `--version` split path**. Do not claim the 100 MB figure for the shipped
  addon.

## 4. ABI and capability floors

| Floor | Value | Meaning |
|-------|-------|---------|
| Binary / minSdk | **API 24** | `aarch64-linux-android24-clang`; ELF floor, minSdk 24 |
| pidfd capability | **API 34** | `pidfd_open` / `pidfd_send_signal`; on API 31–33 seccomp may SIGSYS-kill the syscall |

API 34 is a **claimed capability floor, not a tested compatibility gate**:
only one API 34-class device has been tested. No broad compatibility claim
is made. bionic provides `forkpty`/`openpty` since API 23, so `portable-pty`
works natively.

## 5. What runs natively vs. what is unsupported

| Surface | Android status |
|---------|----------------|
| Shell, PTY, process management (pidfd), grep, glob, file discovery, syntax highlighting, tokenization, AST edit/grep, diff, iso diff, sixel, fs-scan cache | **native**, unchanged |
| Clipboard | text only — JS falls back to `termux-clipboard-set` (`termux-api`) |
| Clipboard image paste | unsupported; current implementation returns empty |
| Audio capture / playback | unsupported; current Android implementation returns an error |
| Codex live WebRTC peer | unsupported; current Android implementation returns an error |
| Desktop surfaces | unsupported / not applicable |
| Local ONNX / STT / tiny inference | unsupported; optional dependencies are not shipped |
| Browser live CDP / relay | target contract (pending): per-call forced prompt on `open`/`run`; current flat `exec` policy does not enforce it |
| Clipboard text read (computer worker) | target contract (pending): per-read host approval if exposed |

Unsupported surfaces return real errors — no fake or stubbed success.
Audio/WebRTC stubs exist because the `pi-voice` + webrtc/opus dependency
graph OOM-kills free GitHub runners (~15 GB RAM + 24 GB swap still killed);
they are committed in-tree and gated on `target_os = "android"`.

## 6. Related docs

- [port-changes.md](port-changes.md) — the maintained Android deltas, current vs. approved-pending.
- [ci-cd.md](ci-cd.md) — GitHub Actions pipeline, NDK wiring, memory strategy.
- [verification.md](verification.md) — on-device and CI verification; reference-device only.
- [setup.md](setup.md) — user-facing install and troubleshooting.
