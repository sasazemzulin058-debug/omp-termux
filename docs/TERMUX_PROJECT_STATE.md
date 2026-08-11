# omp-termux project state

Updated: 2026-08-11 (commits `d24b5d8f` + CI runs through `31492095466`)

## Goal

Build and publish `oh-my-pi` for Termux Android ARM64:

- sync upstream `can1357/oh-my-pi`;
- apply deterministic Android overlay;
- cross-compile native addon with Android NDK;
- build bundled CLI with native Android Bun;
- publish GitHub Release assets;
- install with one command through `quickstart.sh`.

Repository: <https://github.com/sasazemzulin058-debug/omp-termux>
Upstream: <https://github.com/can1357/oh-my-pi>
Installer: <https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/quickstart.sh>

## Current automation

### `sync-upstream.yml`

Scheduled every six hours and manually runnable.

1. Imports upstream tree.
2. Preserves fork-owned `.github/`, `android/`, `quickstart.sh`, and `install.sh`.
3. Applies `android/scripts/apply-overlay.py`.
4. Verifies required upstream inputs.
5. Runs `android/scripts/check-release-inputs.py`.
6. Verifies the pinned Bun lockfile before committing.
7. Commits and pushes `main` plus immutable `v${version}-termux` tag atomically.
8. Tag push starts `android-release.yml`.

No-op sync exits cleanly. Existing release tags are not force-updated. Runtime directories `.bun-cache/` and `tmp/` are excluded from upstream import.

### `android-release.yml`

Release pipeline uses parallel jobs:

```text
native-addon ──┐
               ├─ package-release
js-bundle ─────┘
```

- `native-addon` builds `pi_natives.android-arm64.node` with NDK r27. Native jobs now target repository runner labels `[self-hosted, Windows, X64]`; `build-android-ci.sh` selects the Windows NDK host toolchain under Git Bash and keeps target `aarch64-linux-android`.
- The prior hosted run `31493742003` confirmed exit 143/OOM during Cargo compilation. Corrected checksum format, runner routing, and Windows NDK executable handling are published; active validation run `31494537653` is queued/assigned to `HOME-PC`.

`js-bundle` builds JavaScript bundle and uploads `termux-js-bundle`.

`package-release` downloads both artifacts, assembles `omp-termux.tar.gz`, checks archive contents and native checksum, then attaches:

- `omp-termux.tar.gz`
- `omp-termux.tar.gz.sha256`
- `pi_natives.android-arm64.node`
- `pi_natives.android-arm64.node.sha256`

Preflight checks reject version/tag mismatch, missing overlay inputs, runtime caches, and lockfile drift. Native compilation uses `CARGO_BUILD_JOBS=1`, low optimization, disabled debug info, and swap.

## Android overlay

Canonical overlay: `android/scripts/apply-overlay.py`.

Current transformations cover:

- Android-only `arboard` dependency gate;
- Android crash-handler allocation-hook removal;
- Android clipboard stubs and image decoder gates;
- Linux process support extended to Android;
- Android process snapshot support when present in upstream;
- Android memory snapshot support when present in upstream;
- Android ARM64 native loader platform list.

Verifier: `android/scripts/verify-overlay.py`.

Release preflight: `android/scripts/check-release-inputs.py`.

Verifier checks package/tag version consistency and overlay markers. Upstream versions may add files under `crates/pi-builtins`; verifier accepts those gates only when files exist in checked-out upstream.

Legacy `android/patches/` remains for old checkouts. Current CI release path uses Python overlay, not legacy patch application.

## Installer

`quickstart.sh` is sole installer. It:

1. requires Termux Android ARM64;
2. installs curl/tar through `pkg`;
3. downloads native Android Bun `@oven/bun-linux-aarch64-android` version `1.3.14`;
4. downloads release bundle and SHA-256;
5. verifies archive checksum;
6. installs `$PREFIX/lib/omp-termux/bun` and `$PREFIX/bin/omp`;
7. runs `omp --version`.

Device does not run `bun install`, Rust, clang, or native source build.

## Current known state

As of this document update:

- latest successful published release: `v0.1.6`; its four expected assets exist;
- release foundation and research log are published;
- `bun.lock` is synchronized with current upstream package metadata;
- tags without published assets are not installable;
- full physical test on another Android device is still pending;
- latest native workflow attempt failed during dependency-fetch/build startup before native artifact checksum verification;
- `docs/TERMUX_COMPATIBILITY_MATRIX.md` is authoritative for subsystem status and no-feature-loss acceptance criteria.

Do not claim `v17.2.12-termux` is installable until release assets exist and checks pass.

## Verification commands

```sh
cd omp-termux
bash -n android/scripts/*.sh quickstart.sh
python3 -m py_compile android/scripts/*.py
python3 android/scripts/check-release-inputs.py
git diff --check
gh run list --repo sasazemzulin058-debug/omp-termux --limit 20
gh release list --repo sasazemzulin058-debug/omp-termux --limit 10
```

After a successful release:

```sh
curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/quickstart.sh | sh
omp --version
```

## Operational rules

- Do not use `git pull` blindly during sync.
- Do not force-update release tags.
- Do not commit `.bun-cache/`, `tmp/`, or runtime artifacts.
- Do not run `bun install` on Termux device.
- Do not replace native Android Bun with a glibc wrapper.
- If the same CI error repeats, stop rerunning and send full context to reviewer before changing code.
