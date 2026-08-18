# OMP Termux Android arm64 — Decision Record

Status: approved decisions and measured evidence.
Execution: [`ANDROID_IMPLEMENTATION_PLAN.md`](ANDROID_IMPLEMENTATION_PLAN.md).
Operations: [`../android/README.md`](../android/README.md).
Date: 2026-08-18.

## 1. Scope

Build one maintained OMP repository for Termux Android arm64:
`sasazemzulin058-debug/omp-termux`.

Goals:

- native Bionic addon and official Android Bun;
- full supported OMP behavior on Android;
- explicit errors for unavailable platform capabilities;
- fast startup and bounded memory;
- guarded install/update behavior;
- safe access to live browser and clipboard data.

Out of scope:

- rewriting OMP in Rust;
- audio, WebRTC, clipboard image, desktop automation;
- local ONNX/STT/tiny-model inference;
- standalone `bun build --compile` binary;
- broad Android-device compatibility claims.

## 2. Reference environment

All runtime measurements use one Termux Android arm64 device:

- kernel `6.1.118`;
- API 34-class environment;
- 15.5 GB RAM, 7.5 GB available during investigation;
- Bun `1.3.14+0d9b296af`;
- OMP `17.3.5`.

Binary floor: API 24 (`aarch64-linux-android24-clang`).
`pidfd` capability floor: API 34. Only one device is verified.

## 3. Final runtime architecture

Release tarball owns one versioned Bionic unit:

```text
$LIB_DIR/
├── bun                         official @oven/bun-linux-aarch64-android
├── cli.js                      split entry
├── chunk-*.js                  lazy chunks
├── emitted assets
└── node_modules/@oh-my-pi/pi-natives/native/
    └── pi_natives.android-arm64.node
```

Shim:

```sh
exec env OMP_PLATFORM=android "$LIB_DIR/bun" "$LIB_DIR/cli.js" "$@"
```

No apt/glibc-wrapper Bun. No proot. No runtime package download.

Canonical version manifest:

```sh
BUN_VERSION=1.3.14
NDK_VERSION=r27c
ANDROID_API=24
RUST_TOOLCHAIN=nightly-2026-07-28
```

## 4. Why Bun remains

OMP product code is approximately 675k TypeScript lines versus 197k Rust lines.
Rust already owns system primitives through pi-natives.

Measured agents on the same device:

| Agent | Runtime | Startup median | Peak RSS |
|-------|---------|----------------|----------|
| crush | Go | 146 ms | 33 MB |
| codex | Rust | 322 ms | 26 MB |
| OMP monolith | Bun + Rust N-API | 640–697 ms | 129–144 MB |
| opencode | Bun standalone | 807 ms | 174 MB |
| pi-rs reference | Rust | 76 ms | 5.7 MB |

Bun itself starts in 53–71 ms and uses about 41 MB. JSC JIT and GC work on Android.
`--smol` is rejected: allocation-heavy work was about 6x slower and memory did not improve.

Rewrite cost is not justified. Bundle structure is the dominant fix.

## 5. Code splitting — approved and proven

Current `build-termux-js.ts` omits `splitting`, so Bun flattens lazy imports into one file.

Metafile evidence:

- 2,288 modules in full graph;
- 27 modules statically reachable from `cli.ts`;
- 0.25 MB static code out of 32.47 MB total input;
- 52 static pi-natives imports repo-wide, but only two reachable from entry;
- both reachable native paths pass through `tools/computer/worker-entry.ts`.

Exact build comparison:

| Mode | Entry | Outputs | Total |
|------|-------|---------|-------|
| no split | 20,569 KB | 6 | 22,636 KB |
| split | 22,608 B | 322 | 14.43–22.27 MB, depending on external set |

End-to-end Android result:

```text
split --version → omp/17.3.5, exit 0
split --help    → 12,432 bytes, exit 0
```

| Metric | Monolith | Split |
|--------|----------|-------|
| `--version` median | 640 ms | 134 ms |
| HWM/RSS | 129–144 MB | 54.9 MB |

Hard gates: median <= 200 ms; HWM <= 65 MB on the reference device.

Packaging contract:

1. `Bun.build({ splitting: true })`.
2. Copy all of `outDir` to the bundle tree.
3. Add shebang only to `cli.js`.
4. Tar all chunks and emitted assets; no manifest.
5. Do not externalize OpenTelemetry.
6. Keep runtime resources: models, protobuf, changelog, templates, tool views.
7. Smoke one lazy subcommand to prove cross-chunk imports.

The experimental subcommand failure came from stale local `node_modules` with missing
OpenTelemetry packages. Lockfile declarations were correct. CI must run `bun install`.

## 6. Lazy computer worker — approved secondary optimization

Static paths:

```text
cli.ts → worker-entry.ts → worker.ts → pi-natives/desktop
cli.ts → worker-entry.ts → worker.ts → clipboard → pi-natives/clipboard
```

Making the single `worker-entry` import dynamic changes native paths from 2 to 0.
`supervisor` may remain static; it does not lead to pi-natives.

This saves only the import cost, about 13 MB and 30–50 ms. It does not explain the
original 129–144 MB process footprint.

The 151 MB addon file is mostly virtual mapping:

- resident after import: 6.4 MB;
- resident after native grep: 8.0 MB;
- resident on split `--version`: 0 KB.

Do not split the addon. Kernel demand paging already solves that problem.

## 7. Rejected runtime paths

### Standalone Bun compile

Official Android target is accepted by Bun, but generated binaries crashed 5/5:

```text
panic(main thread): Segmentation fault at address 0x5730000
Bun v1.3.14 (0d9b296a), bionic
```

Plain `bun app.js` worked. Standalone and PIE-patching lanes are rejected.

### Termux apt Bun

Current apt candidate:

```text
Package: bun
Version: 1.3.14
Depends: glibc
Description: glibc wrapper for Termux
```

The verified runtime is official Bionic PIE under `/system/bin/linker64`.
Mixing apt/glibc Bun with a Bionic NDK addon is unsupported.

## 8. Platform capability decisions

| Capability | Decision |
|------------|----------|
| Shell, PTY, process management, grep, glob, highlighting, AST | Native, keep |
| Text clipboard copy | Termux CLI fallback |
| Text clipboard read | Per-read host approval if exposed |
| Clipboard image | Remove/unsupported; Termux:API 0.59.1 is text-only |
| Audio | Unsupported; `/dev/snd` denied, PulseAudio exposes only `auto_null` |
| WebRTC/live | Unsupported with audio |
| Desktop | Not applicable |
| Local ONNX/STT/tiny inference | Do not build; optional dependencies and online defaults exist |
| Browser live CDP/relay | Keep only with forced per-call consent |

Unsupported operations must return a clear error. Never fake success.

## 9. Live browser and clipboard security

Current default is unsafe for live browser access:

- `tools.approvalMode` defaults to `yolo`;
- BrowserTool has a flat `approval = "exec"`;
- live results enter session history and subsequent external LLM requests;
- emitted browser stream can enter debug logs.

Final `browser.live` contract:

- prompt every connected/relay `open` and `run` call;
- classify explicit args, settings, and `getTab(name)?.browser.kind`;
- re-check binding immediately before execution;
- `close` requires no forced prompt;
- headless/spawned/cmux keeps existing `exec` behavior;
- approve is one call, never a session grant;
- `yolo` and standing allow do not bypass;
- deny happens before CDP acquisition;
- denied payload must not enter prompt, session, provider request, or debug log.

Clipboard read is inside the computer worker, not a standalone tool. It needs a
worker-to-host approval RPC for every read. Clipboard image remains unsupported.

## 10. Reliability decisions

### Guarded install

Current installer has a destructive gap:

```sh
rm -rf "$LIB_DIR"
mv "$LIB_DIR.new" "$LIB_DIR"
```

Final guarded two-rename algorithm:

1. download, verify, extract to `.new`, and pre-smoke;
2. if current exists, rename it to `.old` and record `had_old=1`;
3. rename `.new` to current (short unavailable window exists between steps 2–3);
4. post-smoke;
5. on failure, remove/move failed current before restoring `.old` when `had_old=1`;
6. on fresh-install failure, remove failed current; no `.old` is expected;
7. delete `.old` only after success.

Peak disk is about 435 MB with 91 GB free. This is recoverable, not a single
atomic exchange; concurrent launch may fail during the rename window.

### Android updater

Current `omp update` reaches `getBinaryName()` and throws
`Unsupported platform: android`.

Final shim sets `OMP_PLATFORM=android`. `runUpdateCommand` checks that marker before any
network work, prints reinstall instructions, and exits 0.

### Rust panic containment

Two production native panics were observed:

- uucore utility name access with empty argv in N-API/cdylib context;
- Tokio `JoinHandle polled after completion`.

Do not update uucore. Move recovery to the Tokio task boundary so `JoinError` becomes a
recoverable tool/internal error. Keep `db9740d4a6` and add regressions for both cases.

## 11. Repository consolidation

One active repository: `sasazemzulin058-debug/omp-termux`.

Salvage exactly:

- `10d02ecd` — stopped child before SIGCHLD listener;
- `719804ec` — keep daemon broker graph lean.

Do not merge the other 30 clean-lane commits. They are standalone/PIE CI, formatting,
generated patch sync, or intermediate fixes already represented in current source.

Archive `omp-termux-clean` only after the first successful unified release.
After release, remove rebuildable targets in inactive trees to recover about 24.8 GB.

## 12. Upstream sync

Keep deterministic overlay, not an upstream PR, for the Termux-specific lazy-worker edit.
Add a ninth exact-string transform with the existing `once()` count guard.

Add failure notification to `sync-upstream.yml`. Current marker drift stops the workflow
but sends no notification. `cli.ts` changes upstream about 1–2 times per quarter.

## 13. Verification ownership

Executable gates live in [`../android/docs/verification.md`](../android/docs/verification.md).
Reproducible performance harness: `android/scripts/bench.sh`.

Baseline harness sample before split (scheduler-dependent eager import):

```text
--version wall median : 595–663 ms
--version peak RSS    : 129–144 MB
pi_natives resident   : 0–6.2 MB (external sampler may miss short mapping)
bun baseline HWM      : 40–41 MB
```

Exact in-process split measurement: pi-natives resident 0 KB, HWM 54.9–57.3 MB.

Release targets: <= 200 ms, <= 65 MB, full split lazy-command smoke, guarded rollback,
Android update guard, browser consent matrix, panic regressions, reference-device session.

## 14. Final implementation order

1. Save existing user work and baseline.
2. Consolidate repositories and cherry-pick two semantic fixes.
3. Enable splitting and whole-tree packaging.
4. Lazy-load computer worker and add overlay transform.
5. Bundle pinned Bionic Bun; unify version manifest.
6. Implement guarded installer and Android update guard.
7. Contain native worker panics.
8. Enforce browser/clipboard approval contracts.
9. Verify unsupported diagnostics.
10. Run full CI + reference-device release gate.

Exact files, rollback, acceptance, and commit boundaries:
[`ANDROID_IMPLEMENTATION_PLAN.md`](ANDROID_IMPLEMENTATION_PLAN.md).
