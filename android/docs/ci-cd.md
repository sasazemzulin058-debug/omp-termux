# CI/CD: build, package, release, sync

Android automation lives in `.github/workflows/`. Four workflows cooperate:
an upstream sync bot, the custom Bun source build, the per-PR build smoke
job, and the release pipeline. This page states the current pipeline as it
runs today. Older goals and superseded behavior are preserved in the
collapsible sections rather than deleted.

## 1. Current state at a glance

| Area | Current state |
|------|---------------|
| Version policy | `android/versions.env` is consumed by Android workflows; OMP version comes from `packages/coding-agent/package.json` |
| Manifest values | `BUN_VERSION`, `BUN_BOOTSTRAP_VERSION`, `BUN_SOURCE_COMMIT`, `NDK_VERSION`, `ANDROID_API`, `RUST_TOOLCHAIN` are read from the manifest |
| Bun runtime | Bundled custom Bun built from pinned source for Bionic aarch64; version follows `BUN_VERSION` |
| Bootstrap Bun | `BUN_BOOTSTRAP_VERSION` is CI-only and never shipped |
| JS bundle | Split build (`splitting: true`), whole outDir packaged |
| Installer | Guarded two-rename swap with pre/post smoke test and rollback; `omp update` disabled on Android |
| Sync failure | Fails loudly and opens/updates a GitHub Issue, without masking the original failure |
| Release trigger | `v<version>-termux` tag plus explicit dispatch from `sync-upstream` after atomic push |

To inspect current values without copying stale versions into docs:

```sh
cat android/versions.env
python3 -c 'import json; print(json.load(open("packages/coding-agent/package.json"))["version"])'
```

## 2. Workflow overview

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `sync-upstream.yml` | cron `17 3 */2 * *` + manual | Import upstream `can1357/oh-my-pi` main, apply deterministic overlay, verify inputs, commit, tag `v<version>-termux`, push atomically, dispatch the release |
| `bun-build.yml` | manual (`workflow_dispatch`) | Cross-compile the custom Bionic Bun from Bun source; upload `bun-android-arm64` artifact |
| `android-build.yml` | push/PR touching `crates/**`, `packages/natives/**`, `android/**`, the workflow; manual | Cross-compile smoke: build the arm64 addon, upload as artifact |
| `android-release.yml` | tag push `v*-termux`; manual with existing `tag` input; dispatched by `sync-upstream` | Build addon + JS bundle, download custom Bun, verify provenance, assemble `omp-termux.tar.gz`, attach to GitHub Release |

`ci.yml` is the upstream main CI and is not Android-specific.

## 3. Upstream sync (`sync-upstream.yml`)

1. `git fetch --no-tags can1357/oh-my-pi main`, `git archive FETCH_HEAD | tar -x` to a temp dir.
2. `rsync -a --delete` the upstream tree over the working copy, excluding
   `.git/`, `.github/`, `android/`, `quickstart.sh`, `install.sh`,
   `.bun-cache/`, `tmp/`. The fork's own additions survive. Note that
   `README.md` is **not** excluded, so a sync replaces the local README with
   the upstream one.
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
7. Because a `GITHUB_TOKEN` tag push does **not** trigger downstream
   push-triggered workflows, the sync job explicitly dispatches the release
   on the new tag: `gh workflow run android-release.yml --repo
   ${{ github.repository }} --ref "$tag" -f tag="$tag"` and logs the
   dispatch.

Release tags are immutable. If `v<version>-termux` already exists at a
different commit, the sync fails loudly. If it already points at the new
HEAD, the release is considered published and the job exits clean.

**Failure notification (implemented).** When the job fails, the final step
creates or updates a GitHub Issue titled `Upstream sync failure` (labeled
`android-sync`) keyed by the failed run, falling back through several
lookups so a missing label or issue can never make the notification step
itself fail. The original sync failure remains visible in the run log
regardless.

<details>
<summary>Historical note — notification target (superseded)</summary>

The original design goal was: overlay/sync failure fails via `set -e` but
sends no alert. The current workflow creates or updates a GitHub Issue when
possible and never masks the original sync failure.
</details>

## 4. Version policy — one source of truth
Android workflows source `android/versions.env`; OMP version comes from
`packages/coding-agent/package.json`. Do not duplicate version literals in
workflow text, scripts, or release notes.

```sh
cat android/versions.env
python3 -c 'import json; print(json.load(open("packages/coding-agent/package.json"))["version"])'
```

- `BUN_VERSION` — shipped runtime version.
- `BUN_BOOTSTRAP_VERSION` — CI-only bootstrap; never shipped.
- `BUN_SOURCE_COMMIT` — exact Bun source provenance; empty values are rejected.
- `BUN_BUILD_REF` — optional experiment ref, not production provenance.
- `NDK_VERSION`, `ANDROID_API`, `RUST_TOOLCHAIN` — Android build inputs.

The release artifact records `bun.version`, `bun.source-commit`, and
`bun.sha256`; packaging verifies all available provenance before publishing.
- `ANDROID_API=24` is the binary floor: the toolchain driver is
  `aarch64-linux-android24-clang`. API34 is the `pidfd` capability floor at
  runtime, but only one API34 device is tested; no broad compatibility claim.
- NDK and Rust channel are pinned in one place and read by all workflows.

<details>
<summary>Historical note — scattered versions (superseded)</summary>

Previously the values lived in separate places and drifted: `BUN_VERSION`
inline in `android-release.yml`, NDK inline per workflow (`r27c` release,
`r27` PR smoke), and unpinned `nightly` in `android-build.yml`. The merged
manifest is the current source of truth; do not trust any single workflow
file over it.
</details>

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
`src/cli.ts` with `splitting: true` into an outDir, copies the **entire
outDir** (`cli.js` plus chunk files) into the bundle, applies the shebang
only to `cli.js`, embeds the gzipped `docs/**/*.md` payload, copies the
natives loader stubs and `package.json`, and tars the result as
`termux-js.tar.gz` with no manifest — all chunks and assets included.

Runtime resources `models.json`, protobuf, CHANGELOG, and tool views are
required; splitting moves them off the cold path, it does not remove them.
The computer worker is loaded through a dynamic `import()` in
`src/cli.ts`, so the cold startup graph does not eagerly pull the native
addon path.

`bun build --compile` is prohibited: the built Android binary segfaulted
5/5. The runtime stays packaged Bun + JS chunks.

<details>
<summary>Historical note — single-file monolith and split target (superseded)</summary>

The previous bundle was a single-file `cli.js`. The split target was:
`splitting:true`, whole outDir packaged, shebang only on `cli.js`, no
manifest. Rationale, measured on the reference device: split `--version`
median 134 ms vs 640 ms monolith (~4.8x), split RSS 54.9 MB vs 129–144 MB
(~2x). That target is now the shipped build.
</details>

## 8. Bundled Bun runtime (implemented)

**Current:** `install.sh` downloads `omp-termux.tar.gz`, verifies the
checksum, stages the tree, and executes the shim
`env OMP_PLATFORM=android "$LIB_DIR/bun" "$LIB_DIR/cli.js"` where
`$LIB_DIR/bun` is the **custom Bun built from Bun source** — not the Termux
`pkg bun` glibc wrapper and not an npm artifact. The release pipeline
verifies the artifact's sha256 and that `bun.version` equals the manifest
`BUN_VERSION` (1.4.0) before packaging; the source commit is recorded in
`bun.source-commit`.

<details>
<summary>Historical note — pkg bun and the official-runtime goal (superseded)</summary>

Previously `install.sh` ran `pkg install bun` and the `omp` shim exec'd the
Termux-packaged (`glibc-wrapper`) Bun. The target was to bundle the official
Bionic runtime `@oven/bun-linux-aarch64-android@1.3.14`. The shipped runtime
is instead the custom source-built Bun 1.4.0 (Bionic, aarch64), built and
verified by this repo's own pipeline — same provenance discipline (checksum
+ version recorded), no glibc wrapper. Never use the apt/pkg glibc-wrapper
Bun.
</details>

## 9. Release pipeline (`android-release.yml`)

Three jobs, each starting with `verify-overlay.py` and
`check-release-inputs.py`:

- `native-addon`: cross-compiles the addon (section 5 env), verifies
  `pi_natives.android-arm64.node` and `.sha256` match (`sha256sum -c`),
  uploads `android-arm64-native`.
- `js-bundle`: builds the split JS bundle (section 7), verifies `./cli.js`,
  `node_modules/@oh-my-pi/pi-natives/package.json`, `native/index.js`,
  uploads `termux-js-bundle`.
- `package-release` (needs both): downloads both, downloads the custom Bun
  artifact from the `bun-build.yml` run (`bun-android-arm64` via
  `dawidd6/action-download-artifact` with `search_artifacts`), verifies the
  bun sha256 and `bun.version == $BUN_VERSION`, copies `bun` into the
  bundle root as `./bun`, re-verifies every entry, tars
  `omp-termux.tar.gz`, emits+checks `.sha256`, attaches all four files via
  `softprops/action-gh-release@v2` (`fail_on_unmatched_files: true`).

### Release contract

- **Tag:** `v<version>-termux` where `<version>` =
  `packages/coding-agent/package.json` (enforced by the preflight scripts).
- **Assets:** `omp-termux.tar.gz`, `.sha256`, the `.node`, the `.node.sha256`.
- **Runtime requirements:** aarch64 Termux, bundled custom Bun (1.4.0,
  Bionic). No glibc, no proot, no npm, no source build on device.

**Installer swap (implemented).** `install.sh` stages the new tree as
`$LIB_DIR.new`, smoke-tests it with the bundled bun before touching the live
tree, then performs a guarded two-rename swap (`current → .old` → `.new →
current`) with rollback on any failure: a failed `mv` restores `.old`; a
failed post-swap smoke test removes the broken current tree and restores
`.old`; a failed fresh install leaves no `.old` and removes the failed tree.
On success the stale `.old` is removed. `omp update` is disabled on Android
(`update-cli.ts` returns a reinstall instruction immediately when
`process.platform === "android"` or `OMP_PLATFORM=android`), so recovery is
always a clean re-run of the installer.

<details>
<summary>Historical note — unguarded replacement and pending swap (superseded)</summary>

Previously `install.sh` ran `rm -rf "$LIB_DIR"` then `mv`, which could leave
the install absent, and `omp update` was not Android-aware. Target: stage
and verify, use a guarded two-rename swap, restore the old tree on failure.
There is a short rename window where concurrent launch may fail; final state
must always be old-working or new-working. That target is now the shipped
installer.
</details>

## 10. Custom Bun build (`bun-build.yml`) — the runtime source

The shipped runtime is **not** a released Bun artifact. It is compiled by
this repo from the Bun source tree against the Android NDK (Bionic).

- **Trigger:** `workflow_dispatch` only. No automatic rebuild.
- **Inputs:**
  - `bun_ref` (default `main`) — git ref/branch/tag of `oven-sh/bun`.
  - `use_commit` (optional, default empty) — exact commit SHA; when set it
    overrides `bun_ref`. When empty, the workflow **must** resolve the
    `BUN_SOURCE_COMMIT` from `android/versions.env` and errors out if that
    manifest value is empty — the default can never silently become a
    mutable `main` checkout.
- **Steps:** checkout the resolved commit (shallow fetch of the exact SHA),
  patch Bun's clang-version gates (`21.1.x` → `18.0.3`) for NDK r27c, build
  with `bun scripts/build.ts --profile=release --abi=android
  --arch=aarch64 --configure-only` plus `ninja`, strip with llvm-strip,
  verify the ELF is aarch64/Bionic, record `bun.version` (manifest
  `BUN_VERSION`) and `bun.source-commit` (the checked-out SHA) and a
  `sha256sum`, and upload the `bun-android-arm64` artifact.
- **Release attach:** when invoked under a tag ref (or with a non-`main`
  `bun_ref`), the binary and its checksum are also attached to the GitHub
  Release.

### Dispatching a build

Pinned manifest commit (the normal path):

```sh
gh workflow run bun-build.yml --repo sasazemzulin058-debug/omp-termux
```

Explicit experimental override (dev build from a specific commit):

```sh
gh workflow run bun-build.yml --repo sasazemzulin058-debug/omp-termux \
  -f bun_ref=main -f use_commit=<commit-sha>
```

The build takes on the order of an hour on a GitHub runner and produces the
artifact `bun-android-arm64` that `android-release.yml` consumes.

## 11. Preflight scripts (shared by all workflows)

- `android/scripts/verify-overlay.py` — asserts the overlay is present (10
  gates across crate sources + loader) and the release tag matches the
  package version.
- `android/scripts/check-release-inputs.py` — requires `package.json` +
  `bun.lock`, validates `RELEASE_TAG` against `v<version>-termux`, requires
  overlay marker files, rejects staging trees containing `node_modules/`,
  `target/`, or `.cache/`.

See [verification.md](verification.md) for how to run each check locally.