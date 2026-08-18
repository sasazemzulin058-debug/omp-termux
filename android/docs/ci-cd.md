# CI/CD: build, package, release, sync

Android automation lives in `.github/workflows/`. Three workflows cooperate:
an upstream sync bot, a per-PR build smoke job, and the release pipeline.
This page states the intended pipeline and marks what is implemented today
versus pending.

## 1. Current vs target

| Area | Implemented today | Target |
|------|-------------------|--------|
| Version policy | Scattered — `BUN_VERSION` in `android-release.yml`, NDK inline, Rust nightly pinned by `rust-toolchain.toml` | One `android/versions.env` (BUN, NDK, ANDROID_API, RUST) |
| NDK | `r27c` (release, self-hosted setup) / `r27` (PR smoke) | `r27c` everywhere |
| Rust channel | `nightly-2026-07-28` via `rust-toolchain.toml` (release); PR smoke uses unpinned `nightly` | `nightly-2026-07-28` everywhere |
| Bun runtime | Termux `pkg bun` + shim `$PREFIX_DIR/bin/bun` | Official Bionic `@oven/bun-linux-aarch64-android@1.3.14` bundled in tarball |
| JS bundle | Single-file `cli.js` | `splitting:true`, whole outDir packaged |
| Release assets | Attach tarball + checksums | Guarded two-rename installer swap with rollback |
| Sync failure | Job fails loudly, no notification | Failure notification |

Follows are per-item detail. Until `android/versions.env` exists and the
workflows read it, the workflow files are the current source of truth.

## 2. Version policy — one source (pending)

Target: a single `android/versions.env` consumed by every workflow:

```sh
BUN_VERSION=1.3.14
NDK_VERSION=r27c
ANDROID_API=24
RUST_TOOLCHAIN=nightly-2026-07-28
```

`ANDROID_API=24` is the binary floor: the toolchain driver is
`aarch64-linux-android24-clang`. API34 is the `pidfd` capability floor at
runtime, but only one API34 device is tested; no broad compatibility claim.

Today the values live in separate places and drift:

- `BUN_VERSION=1.3.14` in `android-release.yml`.
- NDK version inline per workflow (`r27c` release, `r27` PR smoke).
- Rust nightly pinned in `rust-toolchain.toml` as `nightly-2026-07-28`;
  `android-release.yml` installs it via `rustup show`+`toolchain install`,
  but `android-build.yml` installs unpinned `nightly`.

The single file is the pending consolidation. Until merged, do not trust any
one spot; read the workflow.

## 3. Workflow overview (implemented)

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `sync-upstream.yml` | cron `17 */6 * * *` + manual | Import upstream `can1357/oh-my-pi` main, apply deterministic overlay, commit, tag `v<version>-termux`, push |
| `android-build.yml` | push/PR touching `crates/**`, `packages/natives/**`, `android/**`, the workflow; manual | Cross-compile smoke: build the arm64 addon, upload as artifact |
| `android-release.yml` | tag push `v*-termux`; manual with existing tag | Build addon + JS bundle, assemble `omp-termux.tar.gz`, attach to GitHub Release |

`ci.yml` is the upstream main CI and is not Android-specific.

## 4. Upstream sync (`sync-upstream.yml`) — implemented

1. `git fetch --no-tags can1357/oh-my-pi main`, `git archive FETCH_HEAD | tar -x` to a temp dir.
2. `rsync -a --delete` upstream tree over the working copy, excluding
   `.git/`, `.github/`, `android/`, `quickstart.sh`, `install.sh`,
   `.bun-cache/`, `tmp/`. The fork's own additions survive.
3. `android/scripts/apply-overlay.py` re-applies the deterministic
   transformations on the fresh upstream tree.
4. `git diff --check`, then verifies build inputs (`package.json`,
   `bun.lock`, `crates/pi-natives/Cargo.toml`,
   `packages/natives/native/loader-state.js`) and runs
   `check-release-inputs.py`.
5. `bun install --frozen-lockfile` proves the lockfile is in sync; pure
   format churn is tolerated (`git checkout -- bun.lock`).
6. Reads `packages/coding-agent/package.json` version, commits
   `chore: sync upstream OMP <version>`, pushes
   `--atomic origin HEAD:main refs/tags/v<version>-termux`.

Release tags are immutable. If `v<version>-termux` already exists at a
different commit, the sync fails loudly. If it already points at the new
HEAD, the release is considered published and the job exits clean.

**Pending:** overlay/sync failure currently fails via `set -e` but sends no alert.
Target: create or update one GitHub Issue labeled `android-sync`, keyed by the failed
workflow/ref. No email integration or external notification secret.

## 5. NDK toolchain wiring (`build-android-ci.sh`) — implemented

Cross-compile uses the Android NDK clang directly, not cargo-zigbuild (no
bionic libc). The script:

1. Resolves the NDK host tag and the LLVM prebuilt bin dir.
2. Selects `aarch64-linux-android24-clang` (API24 driver) with `llvm-ar`,
   `llvm-ranlib`, `llvm-strip`; every tool is existence-checked.
3. Exports `CC`, `CXX`, `CC_aarch64_linux_android`, `AR_...`, `RANLIB_...`,
   `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER/_AR/_RANLIB`; PATH gets the
   NDK bin dir first.
4. Writes a temporary `.cargo/config.toml` for `[target.aarch64-linux-android]`
   pinning linker/ar/ranlib; restores via an EXIT trap.

`napi build` injects the runner NDK r29 linker and routes through
cargo-zigbuild, so the script runs `cargo build` directly with the NDK
toolchain. The built `.so` is stripped (`llvm-strip --strip-unneeded`),
`file`-verified as `*ELF*aarch64*`, copied to
`packages/natives/native/pi_natives.android-arm64.node`, and a `.sha256` is
emitted.

The CMake/Ninja shim (`$RUNNER_TEMP/bin/cmake`) strips
`-DCMAKE_SYSTEM_PROCESSOR=*` and injects Ninja so ring/opus cmake builds
work.

**Pending:** NDK `r27c` everywhere. `android-build.yml` still uses `r27`.
Target one pin.

## 6. Memory strategy

The pi-voice + webrtc/opus graph OOM-killed free runners before the
stub. The remaining graph is still heavy.

- Swap: replace the runner swapfile with 32 GB (`fallocate`), 16 GB fallback.
- Rust: `CARGO_BUILD_PIPELINING=false`, `CARGO_INCREMENTAL=false`,
  `RAYON_NUM_THREADS` low, `RUSTFLAGS="-C debuginfo=0"`. Deliberately not
  `-C codegen-units=1` (one giant LLVM unit OOMs harder); `codegen-units=16`.
- `[profile.ci]` is patched in place (low-memory values); the build script
  must not redefine the block — a duplicate key breaks cargo.

Parallelism flags (`-j`, `MAKEFLAGS`, `NINJAFLAGS`, `NUM_JOBS`) differ
between workflows and have changed over time. Do not hardcode them here:
**the `env:` block of each workflow file is the current source of truth.**

## 7. JS bundle packaging

**Current (implemented):** `build-termux-js.ts` runs `Bun.build` on
`src/cli.ts` to a single-file `cli.js`, prepends `#!/usr/bin/env bun`,
embeds the gzipped `docs/**/*.md` payload, copies the natives loader stubs
and `package.json`, and tars the result as `termux-js.tar.gz`.

**Target (pending): `splitting:true`.** Bun emits `cli.js` plus chunk files
into an outDir; the build copies the entire outDir into the bundle, applies
the shebang only to `cli.js`, writes no manifest, and tars all chunks and
assets. Rationale, measured on the reference device: split `--version`
median 134 ms vs 640 ms monolith (~4.8x), split RSS 54.9 MB vs 129–144 MB
(~2x). Runtime resources `models.json`, protobuf, CHANGELOG, and tool views
are required; splitting moves them off the cold path, it does not remove
them.

`bun build --compile` is prohibited: the built Android binary segfaulted
5/5. The runtime stays packaged Bun + JS chunks.

## 8. Official Bun runtime (pending)

**Current: diverges.** `install.sh` runs `pkg install bun` and the `omp`
shim does `exec "$PREFIX_DIR/bin/bun" "$LIB_DIR/cli.js"`. That is the
Termux-packaged Bun.

**Target:** bundle the official Bionic runtime
`@oven/bun-linux-aarch64-android@1.3.14` into the release tarball; the shim
executes `"$LIB_DIR/bun" "$LIB_DIR/cli.js"`. Never use the apt/pkg
glibc-wrapper Bun. Verify the runtime's provenance and checksum before
shipping. Until the installer is changed, `install.sh` remains the current
behavior.

## 9. Release pipeline (`android-release.yml`)

Three jobs, each starting with `verify-overlay.py` and
`check-release-inputs.py`:

- `native-addon`: cross-compiles the addon (section 5 env), verifies
  `pi_natives.android-arm64.node` and `.sha256` match (`sha256sum -c`),
  uploads `android-arm64-native`.
- `js-bundle`: builds the JS bundle (section 7), verifies `./cli.js`,
  `node_modules/@oh-my-pi/pi-natives/package.json`, `native/index.js`,
  uploads `termux-js-bundle`.
- `package-release` (needs both): downloads both, copies the addon into
  `node_modules/@oh-my-pi/pi-natives/native/`, re-verifies every entry, tars
  `omp-termux.tar.gz`, emits+checks `.sha256`, attaches all four files via
  `softprops/action-gh-release@v2` (`fail_on_unmatched_files: true`).

### Release contract

- **Tag:** `v<version>-termux` where `<version>` =
  `packages/coding-agent/package.json` (enforced by the preflight scripts).
- **Assets:** `omp-termux.tar.gz`, `.sha256`, the `.node`, the `.node.sha256`.
- **Runtime requirements:** aarch64 Termux, packaged Bun (target: bundled
  Bun). No glibc, no proot, no npm, no source build.

**Pending — guarded installer swap:** `install.sh` currently runs
`rm -rf "$LIB_DIR"` then `mv`, which can leave the install absent. Target:
stage and verify, use a guarded two-rename swap, and restore the old tree on failure.
There is a short rename window where concurrent launch may fail. `omp update` returns
early on Android and instructs reinstall.

## 10. Preflight scripts (shared by all workflows)

- `android/scripts/verify-overlay.py` — asserts the overlay is present (10
  gates across crate sources + loader) and the release tag matches the
  package version.
- `android/scripts/check-release-inputs.py` — requires `package.json` +
  `bun.lock`, validates `RELEASE_TAG` against `v<version>-termux`, requires
  overlay marker files, rejects staging trees containing `node_modules/`,
  `target/`, or `.cache/`.

See [verification.md](verification.md) for how to run each check locally.
