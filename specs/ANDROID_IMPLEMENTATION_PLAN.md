# OMP Termux Android arm64 — Implementation Plan

Status: executable plan. Companion to `specs/ANDROID_NATIVE_PLAN.md` (decision record).
No research chronology, no hypotheses unless marked `[INFERENCE]`.
Reference device: Termux, Android arm64, kernel 6.1.118, API34-class. One device only.

## Targets (hard gates)

- Startup: real `omp --version` median <= 200 ms. Measured split baseline 134 ms.
- Memory: HWM <= 65 MB. Measured split baseline 54.9 MB.
- Room above measured baseline is headroom, not budget. Do not regress toward it.

## Out of scope (final decisions, hard)

- No audio, no WebRTC/live, no local ONNX/STT/tiny inference, no clipboard image.
- `bun build --compile` prohibited (built binary segfaults 5/5).
- No glibc-wrapper apt Bun. `--smol` off. No `--bytecode`. No pi-rs rewrite.

## Definition of Done (applies repo-wide)

1. Every step in every phase has run and passed its acceptance on the reference device or CI.
2. `bench.sh` post-change vs pre-change committed; startup and HWM meet targets.
3. All docs in `android/docs/` match code state. No stale version/swap/thread-count pins.
4. One repo `sasazemzulin058-debug/omp-termux`. Clean lane archived, not merged.
5. No standalone/PIE/patched-bun residue in main line.
6. `omp update` returns reinstall instructions on Android. Installer uses a guarded
   two-rename swap with rollback and documents its short unavailable window.
7. Every unsupported surface returns a clear, honest error. No fake success.
8. Commits follow Conventional Commits; each phase lands as one boundary (see each phase).

---

## Phase 0 — Baseline + save user work

Save uncommitted work before any structural change. Nothing measured in prior phases is
committed yet.

Files / symbols:
- All currently modified/untracked Android docs, scripts, specs, generated bindings, and lockfile.

Steps:
1. Capture `git status --short` and review every existing change as user work.
2. Stage explicit paths only. **Never use `git add -A`** for this mixed working tree.
3. Review staged diff/stat; confirm no generated cache, temp build, or unrelated file.
4. Commit the documentation/baseline set separately from generated bindings/lock changes
   unless they are one coherent existing change.
5. Record `git rev-parse HEAD` and run `android/scripts/bench.sh --runs 7 --json`.
6. Confirm the tree contains no unaccounted changes; do not require it to be empty if
   intentionally preserved user work remains unstaged.

Prior art:
- `android/scripts/bench.sh` already exists; do not rebuild it. It is the measurement gate.

Acceptance:
- HEAD and benchmark baseline recorded. Every pre-existing change is either committed
  coherently or listed as intentionally preserved user work. No edit is lost.

Rollback:
- Record the baseline commit SHA. Before publication, soft-reset only after asserting
  `git rev-parse HEAD` equals that SHA. After publication, use `git revert <recorded-sha>`.

Commit boundary:
- `chore(android): save pre-implementation working tree`

---

## Phase 1 — Repo consolidation + cherry-picks

Main line stays `sasazemzulin058-debug/omp-termux`. Clean lane is archived, never merged.

Files / symbols:
- `crates/vendor/brush-core/src/processes.rs` — initial
  `poll_for_stopped_children()` (from `10d02ecd`).
- `packages/coding-agent/src/session/streaming-output.ts` — `formatBytes` import
  (from `719804ec`).
- Obsolete Android branches/repos are archived only after the first successful release.

Steps:
1. Confirm Phase 0 accounted for every pre-existing change.
2. Fetch origin/upstream tags. Cherry-pick exactly:
   `git cherry-pick 10d02ecd 719804ec`.
3. Run focused tests for changed brush process waiting and streaming-output imports.
4. After the first successful unified release, archive obsolete GitHub repositories
   (`Https-not/oh-my-pi`, `Https-not/omp-termux-android`) if the authenticated account
   has admin rights. GitHub has no per-branch archive state.
5. Keep old branches read-only. Delete them only under separate explicit approval.
6. Move local `~/omp-termux-clean` to `~/.archive/omp-termux-clean`; do not delete.
7. Search active build/workflow code for `patchelf`, `sh_offset`, `bun-termux`, and
   standalone PIE execution. Historical decision prose may retain rejected experiments.
8. After successful release, ask again before deleting inactive `target/` directories
   (~24.8 GB). Never delete `omp-termux/target`.

Prior art:
- Commit analysis and the 2/32 salvage list are final in `ANDROID_NATIVE_PLAN.md` §7.5.
- `omp-termux/target` is active; never touch.

Acceptance:
- Cherry-picks apply cleanly. `formatBytes` resolves from `@oh-my-pi/pi-utils`.
- No active standalone/PIE/patched-Bun build path remains. Historical prose may mention
  the rejected experiment; code/workflows must not execute it.
- Clean lane remains recoverable in the archive until the first successful release.

Rollback:
- Record the two **new** SHA values created by cherry-pick. Revert them in reverse order.
- On conflict, resolve and continue or `git revert --abort`; never treat conflict as no-op.
- `mv ~/.archive/omp-termux-clean ~/omp-termux-clean` restores the local lane.

Commit boundaries (two):
- `fix(shell): handle stopped children before SIGCHLD wait`
- `fix(ci): keep daemon broker module graph lean`

---

## Phase 2 — Splitting + whole-tree packaging

The single highest-measured change: reuse ready-made chunks, stop flattening the graph
into one monolith.

Files / symbols:
- `android/scripts/build-termux-js.ts` — `Bun.build` options; `splitting` key;
  the outDir→bundleDir copy block; the tar step.

Measurements (final):
- splitting true: entry `cli.js` 22,608 bytes, 322 files total, volumes ~14.4 MB.
- Real `omp --version` median 134 ms vs 640 ms monolith (4.8x).
- Split RSS 54.9 MB vs 129–144 MB (~2.5x).

Steps:
1. In `build-termux-js.ts` add `splitting: true` to `Bun.build` options.
2. Replace the "copy only `cli.js`" step: recursively copy the entire `outDir` into
   `bundleDir`.
3. Write shebang only to the entry `cli.js`. No manifest file.
   Content-hashed `chunk-*.js` and assets stay adjacent; Bun resolves relative
   `import()` from the chunk file.
4. Keep `external: ["@oh-my-pi/pi-natives", "@huggingface/transformers",
   "fastembed", "onnxruntime-node", "omp-legacy-pi-modules"]`.
   Do NOT externalize `@opentelemetry/*` — it must be bundled into lazy chunks
   (`bun install` in CI provides it).
5. Keep copying native stubs + `loader-state.js` into
   `bundleDir/node_modules/@oh-my-pi/pi-natives/native/`.
6. Tar the whole `bundleDir` tree as today.

Acceptance:
- Tarball contains `cli.js`, `chunk-*.js`, assets, and pi-natives native directory.
- Fresh staging install: `--version` and `--help` exit 0.
- At least one lazy subcommand runs, proving cross-chunk `import()` resolution.
- `bench.sh --runs 9 --json`: median <= 200 ms and HWM <= 65 MB.

Rollback:
- Revert the splitting/whole-tree packaging commit and rebuild the prior single-file
  tarball. The guarded installer replaces the complete tree; no mixed layout is retained.

Commit boundary:
- `feat(android): enable code splitting with whole-tree packaging`

---

## Phase 3 — Lazy worker + 9th overlay

Two changes: lazy-load the computer worker in `cli.ts`, and teach the upstream overlay
to re-apply that same change after every sync. Both are the same edit in effect.

Files / symbols:
- `packages/coding-agent/src/cli.ts` — lines 39 (static import) and 173 (dispatch).
- `packages/coding-agent/src/tools/computer/worker-entry.ts` — `startComputerWorker`.
- `android/scripts/apply-overlay.py` — add a 9th transform.
- `packages/coding-agent/src/tools/browser/tab-worker-entry.ts` — neighbor pattern.

Facts:
- `worker-entry.ts` auto-starts on import only if `!Bun.argv.some(isWorkerHostSelector)`,
  but `import { ComputerWorkerCore } from "./worker"` at module top that follows any path
  to the native addon. The guard is a runtime guard; the import is not lazy. Make the
  import lazy, not the call.
- Static graph: 27 modules reachable from `cli.ts`; 2 native paths; both via one import
  `cli.ts:39`. Lazy → 0 native paths on cold path.

Steps:
1. In `cli.ts`, delete the static `import { startComputerWorker } from
   "./tools/computer/worker-entry";` (line 39).
2. In `cli.ts:173` (the `COMPUTER_WORKER_ARG` branch), replace the direct call with a
   dynamic import, then call the export explicitly:
   ```ts
   if (arg === COMPUTER_WORKER_ARG) {
   	if (parentPort) installWorkerInbox(parentPort);
   	const { startComputerWorker } = await import("./tools/computer/worker-entry");
   	startComputerWorker();
   	return true;
   }
   ```
   Do NOT rely on worker-entry's auto-start branch: the worker is spawned with argv
   `__omp_worker_computer`, so `isWorkerHostSelector(argv[0])` is true and that
   `!Bun.argv.some(isWorkerHostSelector)` block does not run in this path. The
   explicit call is mandatory. The module-level `started` guard prevents double-start.
3. Keep `supervisor` import as-is (optional −3 modules, no native path; not required).
4. Add a ninth `apply-overlay.py` transform for `cli.ts`. It applies the same
   static-to-dynamic import edit with the existing `once()` count guard.
5. Add GitHub-native failure notification to `sync-upstream.yml`:
   - grant workflow `issues: write`;
   - on failure, search open issue labeled `android-sync`;
   - create one if absent, otherwise append run URL/ref/error summary;
   - never create duplicate issues for repeated failures;
   - use `GITHUB_TOKEN`; no email or external secret.

Acceptance:
- Metafile after change: 0 native paths reachable from `cli.ts` cold path.
- Fresh overlay output is byte-identical to the manual `cli.ts` edit; count guard passes.
- `--version` passes and `bench.sh` records the delta.
- A forced overlay failure creates/updates exactly one `android-sync` GitHub Issue and
  leaves the workflow failed.

Rollback:
- Re-add the static import; revert dispatch to direct call. Overlay transform removed.
- Note: upstream may already move this import (churn ~1–2/quarter). The `once()` guard
  fails the build loudly rather than misapplying — that is the designed handling.

Commit boundary:
- `perf(android): lazy-load computer worker entry`
  (applies to `cli.ts`; overlay transform + CI notify ride the same commit,
  conventional `perf` + `ci` bodies).

---

## Phase 4 — Bundled Bionic runtime + version manifest

One source of truth for all version pins; release tarball is self-contained Bionic.

Files / symbols:
- New `android/versions.env`:
  ```
  BUN_VERSION=1.3.14
  NDK_VERSION=r27c
  ANDROID_API=24
  RUST_TOOLCHAIN=nightly-2026-07-28
  ```
- `.github/workflows/android-release.yml` — NDK version, `-j4`, swap.
- `.github/workflows/android-build.yml` — NDK r27→r27c, floating nightly→pin.
- `install.sh` — remove apt `pkg install bun`; no glibc-wrapper.
- `packages/coding-agent/src/cli/update-cli.ts` — `MIN_BUN_VERSION` (already exists).
- Shim: `$LIB_DIR/bun $LIB_DIR/cli.js`.

Steps:
1. Create `android/versions.env` with the four pins above.
2. Make both workflows source the file for `ndk-version`, Rust toolchain, API.
3. `android-release.yml`: NDK r27c (already set); keep `-j4` but add swap
   guard consistent with `android-build.sh` (unify, do not invent).
4. `android-build.yml`: `ndk-version: r27` → `r27c`; replace floating
   `--default-toolchain nightly` with `--default-toolchain nightly-2026-07-28`.
5. Download official `@oven/bun-linux-aarch64-android@1.3.14` into the release bundle
   as `$LIB_DIR/bun`.
6. Rewrite shim:
   `exec env OMP_PLATFORM=android "$LIB_DIR/bun" "$LIB_DIR/cli.js" "$@"`.
   Reuse that shim in package-release; no apt Bun.
7. Keep runtime floor `MIN_BUN_VERSION >= 1.3.14`.
8. Document only the measured official Bionic runtime as supported.

Prior art:
- API24 is the ELF/build floor (`aarch64-linux-android24-clang` already in use).
- API34 is the declared pidfd capability floor only; one device tested. No broad
  compatibility claim (see Phase 9).

Acceptance:
- `versions.env` is canonical; workflows and package/install scripts read it.
- Fresh install runs `$LIB_DIR/bun`, never `$PREFIX/bin/bun`.
- `file "$LIB_DIR/bun"` reports Android/Bionic PIE with `/system/bin/linker64`;
  `readelf -d` shows Android system libraries, not glibc loader paths.
- No `pkg install bun` remains; installed shim sets `OMP_PLATFORM=android`;
  `--version` passes on-device.

Rollback:
- Revert the bundled-runtime/version-manifest commit and restore the last verified release
  tarball. Do **not** restore apt/glibc Bun: that ABI configuration is explicitly unsupported.

Commit boundary:
- `feat(android): bundle Bionic runtime and unify version pins`

---

## Phase 5 — Guarded install swap and update guard

The installer must recover deterministically. Two portable POSIX renames are not one
atomic exchange: there is a short window where `$LIB_DIR` is absent. Document and test it.

Files / symbols:
- `install.sh` — current destructive `rm -rf`/`mv` window and trap.
- `packages/coding-agent/src/cli/update-cli.ts` — `runUpdateCommand`.

Steps:
1. Add test overrides:
   - `LIB_DIR=${OMP_LIB_DIR:-$PREFIX/lib/omp-termux}`;
   - `BIN_DIR=${OMP_BIN_DIR:-$PREFIX/bin}`.
2. Stage/download/verify/extract into `LIB_DIR.new`; run pre-swap smoke there.
3. Set `had_old=0`. If `LIB_DIR` exists: remove stale `.old`, rename current to `.old`,
   set `had_old=1`.
4. Rename `.new` to `LIB_DIR`; run post-swap smoke.
5. On failure after step 3: move/remove failed `LIB_DIR` first, then restore `.old` only
   when `had_old=1`. Fresh install has no `.old` and must simply remove the failed tree.
6. Delete `.old` only after post-swap success. Trap is idempotent.
7. Shim always exports `OMP_PLATFORM=android` and executes bundled Bun:
   `exec env OMP_PLATFORM=android "$LIB_DIR/bun" "$LIB_DIR/cli.js" "$@"`.
8. `runUpdateCommand` checks `process.env.OMP_PLATFORM === "android"` before any network
   or method selection. It prints reinstall instructions and exits 0.

Acceptance:
- Fault injection at every boundary covers fresh install and upgrade with existing tree.
- During the two-rename window, a concurrent launch may fail; after recovery old or new
  OMP is runnable. Docs state this limit; no false atomicity claim.
- Installed shim, with no manually supplied env, sets `OMP_PLATFORM=android`.
- `omp update` through that shim performs zero network calls and exits 0.
- Isolated test uses `OMP_LIB_DIR` + `OMP_BIN_DIR`; real installation is untouched.

Rollback:
- Revert the phase commit and reinstall the last verified release. Never restore the
  destructive `rm -rf` installer as a supported path.

Commit boundary:
- `fix(android): guard install swap and block omp update`

---

## Phase 6 — Rust panic containment

Two fatal panics on the tokio runtime; both become recoverable.

Files / symbols:
- `crates/pi-builtins/src/host.rs` — `run_caught` (`~line 633`), `catch_unwind`
  (`~line 35` import, call at `~643`).
- `crates/vendor/brush-core/` — `JoinHandle polled after completion` (tokio task core).
- `crates/pi-builtins/src/jobs.rs` — existing `is_finished()` guard (~104–110), plus
  the unguarded `wait()` branch (~92).

Facts:
- `uucore::args_os()` empty argv is a napi/cdylib-on-Android class of panic. Do NOT
  upgrade uucore (breaks 114 vendored ports). Fix at the boundary instead.
- Current `run_caught` uses synchronous `catch_unwind`, which stops at the first
  `await`; async panics escape it.

Steps:
1. Move recovery to the tokio-task boundary: `tokio::spawn` + `await` the worker,
   map `JoinError` to internal error, raise a recoverable scope at the worker.
2. Both panics become `LoggedRecoverable` instead of process abort.
3. Keep `jobs.rs` polling fixes; add the missing guard on the `wait()` branch so a
   spawn failed before polling cannot cause a second poll.
4. Leave `uucore` at 0.8.0. One layer changes, not 114 utilities.

Acceptance:
- Reproduce each panic path (empty argv uucore; JoinHandle-after-completion). After
  fix, each surfaces as a logged recoverable error, process continues.
- `--version` (no addon path) still exit 0; full command no longer panics.
- Review unwind safety; no `catch_unwind` swallowing a live abort.

Rollback:
- Revert the `tokio::spawn` boundary change and `jobs.rs` guard. Panics return to
  abort (worse; log the rollback risk).

Commit boundary:
- `fix(native): contain panics at tokio-task boundary`

---

## Phase 7 — Browser/clipboard approval

Live browser attach and text-clipboard read must prompt per call. No session grant.

Files / symbols:
- `packages/coding-agent/src/tools/browser.ts` — approval classification; `readonly
  approval = "exec" as const` (~line 141); the `{tier:"exec", policy:"prompt",
  override:true, policyKey:"browser.live"}` decision.
- `packages/coding-agent/src/tools/computer/worker.ts` — clipboard read at `~713–718`
  via `readTextFromClipboard` (`utils/clipboard.ts`).
- `config/settings-schema.ts` — `tools.approvalMode` default `"yolo"` (~line 3680).

Steps:
1. `browser.live` dynamic approval classifies not just requested args but also any
   already-bound tab `getTab(name)?.browser.kind`. Re-issue of `browser run` with only
   `name+code` must still classify the bound live tab.
   - `open` connected CDP/relay → prompt each call.
   - `run` on already-bound connected/relay tab → prompt each call.
   - `close` / `close all` → no forced prompt (releases an OMP handle only).
   - OMP-owned headless/spawned/cmux → existing `exec`, no new prompt.
2. Prompt shows action, tab, endpoint kind, and a code preview. Never page result,
   cookies, or secret material. Debug log unchanged (browser stream verbatim is a
   separate, pre-existing concern; do not regress it here).
3. No session grant: approve = one call; the next live call prompts again.
4. Re-check binding kind immediately before execution (re-approve on close/rebind
   race).
5. Revoke path: `tools.approval.browser.live: deny` + `browser close` + clear
   cdpUrl/relay settings.
6. Clipboard: text read happens inside the computer worker, so no policy helper on a
   tool can intercept it. Add a worker→host approval RPC at the operation boundary.
   Prompt every read; no session grant. Value not logged; after a successful read it
   becomes a tool result and may go to the LLM — state that in the prompt.
   Clipboard image is removed entirely; already stubbed `Ok(None)`/honest unsupported.

Acceptance matrix:
- explicit cdpUrl / configured cdpUrl / relay open = prompt.
- bound live `run` without `app` = prompt.
- headless `run` = no forced prompt.
- `close` = no prompt.
- `deny` = zero CDP calls; `SECRET_SENTINEL` never appears in prompt/session/debug.
- next approved live call prompts again.
- binding closed/rebound between classify and execute fails or re-prompts.

Rollback:
- Restore flat `exec` tier and remove the clipboard RPC. Live tabs revert to
  unguarded access (worse; log it).

Commit boundary:
- `feat(security): per-call approval for live browser and clipboard read`

---

## Phase 8 — Honest unsupported diagnostics

Every unsupported surface returns a clear "not supported on this platform" error.
No silent failure, no fake success.

Files / symbols:
- `crates/pi-voice/src/device/unsupported.rs` — keep the honest `Err`.
- `crates/pi-natives/src/clipboard.rs` — `read_image_from_clipboard` android stub
  returns `Ok(None)` (via overlay). Keep; surface as "unsupported" in diagnostics.
- `packages/coding-agent/src/*/mnemopi/embed-client.ts` — `createUnavailableWorker`,
  `spawnWorkerOrUnavailable`.
- `packages/coding-agent/src/stt/models.ts`, `tiny/models.ts` — on-device STT /
  tiny-title models.
- Desktop: `Err("desktop backend unavailable")` — keep.
- `packages/coding-agent/package.json:76-79` — optionalDependencies
  (`@huggingface/transformers`, `sherpa-onnx-node`).

Steps:
1. Audit every "unsupported" surface returns a specific message naming the platform
   and (where applicable) the Termux:API fallback. No `Ok(None)` strangers masquerading
   as real data.
2. Local-model paths (mnemopi embeddings, STT, tiny-title) route through
   `spawnWorkerOrUnavailable`; ensure the user-facing message is
   "unavailable on Android" not a silent empty result.
3. Verify `read_image_from_clipboard` android stub and `desktop` remain explicit.
4. Confirm all four optional subsystems are absent from the cold path (already true
   after Phase 3 + splitting).

Acceptance:
- Calling each unsupported feature prints a clear platform-specific error; process
  continues; no crash, no empty-success.
- `--smol`/audio/live/onnx are documented as unsupported in `android/docs/` and
  `cli` help.

Rollback:
- Revert any diagnostics wording only; no structural revert expected.

Commit boundary:
- `feat(android): explicit unsupported diagnostics`

---

## Phase 9 — Full verify + release

Final gate. Everything is measured on the reference device, not asserted.

Files / symbols:
- `android/scripts/bench.sh` — startup + HWM + addon-residency gate.
- Fresh-install acceptance through `OMP_LIB_DIR` + `OMP_BIN_DIR` overrides.
- `android/docs/verification.md` — updates to match final measurements.
- Reference-device limitation stated in `android/docs/setup.md` and README.

Steps:
1. Cold-start smoke: fresh install from the final tarball with both overrides pointing
   to temporary directories; run `--version`, `grep`, `executeShell`, one lazy subcommand.
2. Run `bench.sh` before/after on the installed tree. Record median wall + HWM.
   Gate: startup <= 200 ms, HWM <= 65 MB.
3. Verify callback: addon resident 6–8 MB after use, 0 KB on `--version` split path.
   Do not claim 105 MB.
4. On-device smoke in CI: `--version`, addon load, `grep`, `executeShell`
   (research §3.3). Without it, cross-compile is blind.
5. Full command run: `models`, `sessions`, `doctor`, `--help`, one tool round-trip.
6. Document the reference device limitation: kernel 6.1.118, API34-class. State that
   API34 is a pidfd capability floor, capability-only, not a broad compatibility claim.
7. Verify docs drift none: `android/docs/ci-cd.md` syncs with actual workflow pins.
8. Update `android/docs/verification.md` and README with final numbers. No marketing
   sentences, no contradicted hypotheses.

Definition of Done for Phase 9 = the global DoD list at the top, all green.

Acceptance:
- All global DoD items pass. Bench committed. Docs match code. Release tarball
  installs cleanly from an isolated dir.
- Known limitations stated in setup/README.

Rollback:
- Release is cut from a tag; pre-tag revert of any failing change. Not a runtime
  rollback.

Commit boundary:
- `chore(android): verify release gate and sync docs`, then tag the release.

## Post-release housekeeping (separate approval)

After successful release, ask before deleting rebuildable `target/` directories in
inactive `pi-rs`, `pi-rs-main-audit`, and archived clean trees (~24.8 GB).
This is workspace cleanup, not a product deliverable. Never touch `omp-termux/target`.

## Final state

Implementation plan self-contained. Ordering is by measured effect; each phase is an
independently revertible commit. Targets (startup <= 200 ms, HWM <= 65 MB) have
measured headroom over the 134 ms / 54.9 MB split baseline.
