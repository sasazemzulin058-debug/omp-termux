# Verification: proving the Android/Termux port works

Every gate that exists for the port, grouped by kind. Each is marked
**implemented** (runs today) or **pending** (defined contract, not yet
enforced). The on-device checks run on the reference device only — see the
disclosure at the end.

## 1. Current vs target

| Gate | Status |
|------|--------|
| Overlay gates, release preflight, rustc cfg, addon artifact, current tarball content | implemented (CI) |
| Version/help, grep/executeShell/PTY | implemented (manual smoke) |
| Official bundled Bun ELF/provenance | pending |
| Split chunks/assets + lazy-subcommand integrity | pending |
| Benchmark <=200 ms and <=65 MB | pending CI enforcement |
| Swap fault injection, update guard, browser prompt matrix | pending |
| Unsupported diagnostics | implemented (manual) |

## 2. Automated static gates — implemented

Runs in the workflows before any artifact is used.

**Overlay present in the tree**

```sh
python3 android/scripts/verify-overlay.py
```

Expected: `Android overlay verified: 10 gates, version <version>`. Asserts
on failure (exit 1): the pi-voice gated re-add, `alloc_error_hook` removed,
crash-handler alloc hook disabled, clipboard/audio/live stubs, the
`#[cfg(any(target_os = "linux", target_os = "android"))]` gates in
`pi-builtins`, and `"android-arm64"` in `loader-state.js`. If `RELEASE_TAG`
is set it must equal `v<version>-termux`.

**Release-input preflight**

```sh
RELEASE_TAG=v17.3.5-termux python3 android/scripts/check-release-inputs.py
```

Expected: `Release preflight passed`. Asserts `package.json` + `bun.lock`,
tag match, overlay marker files, and no `node_modules/`, `target/`, or
`.cache/` in the staging tree.


**Rust target facts** (source of truth for every cfg gate)

```sh
rustc --print cfg --target aarch64-linux-android
```

Must include `target_os="android"`, `target_family="unix"`, `unix` and must
not include `target_os="linux"`. On-device the build is native (host triple
`aarch64-linux-android`), so `cargo check` needs no NDK. A Linux x86_64 host
needs the Rust target plus the NDK environment from [ci-cd.md](ci-cd.md).

**Addon artifact** (after any cross-compile)

```sh
test -s packages/natives/native/pi_natives.android-arm64.node
file packages/natives/native/pi_natives.android-arm64.node   # *ELF*aarch64*
(cd packages/natives/native && sha256sum -c pi_natives.android-arm64.node.sha256)
```

**Release bundle content**

```sh
sha256sum -c omp-termux.tar.gz.sha256
tar -tzf omp-termux.tar.gz | grep -Fx './cli.js'
tar -tzf omp-termux.tar.gz | grep -F './node_modules/@oh-my-pi/pi-natives/native/pi_natives.android-arm64.node'
tar -tzf omp-termux.tar.gz | grep -F './node_modules/@oh-my-pi/pi-natives/package.json'
```

The `package-release` job runs exactly these checks before attaching
anything to a release.

## 3. Official Bun runtime — pending

Gate: the shipped runtime is the official Bionic
`@oven/bun-linux-aarch64-android@1.3.14`, not the pkg glibc-wrapper Bun.

```sh
file "$LIB_DIR/bun"                              # ELF, aarch64, linked against bionic
"$LIB_DIR/bun" --version                        # 1.3.14
sha256sum "$LIB_DIR/bun"                         # matches the provenance record
```

For each release, record the artifact's expected sha256 from the official
release provenance. Compute the actual and compare. Do not ship a runtime
whose provenance is unverifiable.

## 4. Split bundle integrity — pending

Gate: the tarball carries a split build (not a single `cli.js`).

```sh
tar -tzf omp-termux.tar.gz | grep -c '\.js$'     # > 1 (chunks present)
tar -tzf omp-termux.tar.gz | grep -Fx './cli.js' # entry point
# first line carries the shebang; chunks carry none
```

Startup must not reference a missing chunk: `"$LIB_DIR/bun" "$LIB_DIR/cli.js" --version`
prints the version with no chunk-not-found error.

## 5. Behavioral gates — implemented (manual)

**Version and help**

```sh
omp --version
omp --help          # renders; no is-not-a-function errors
```

**Lazy entry (pending).** After splitting and the dynamic computer-worker import,
`--version` must not load pi-natives.

```sh
android/scripts/bench.sh --runs 9 --json
# target: addon_rss_kb == 0 after the lazy-worker phase
```

Current monolith samples vary from 0 to about 6.2 MB because the external sampler may
miss the short mapping. The exact in-process split probe measured 0 KB.

**grep / executeShell / PTY** run natively on Android (exercises the
pi-shell/pi-builtins platform gates):

```sh
omp -p "run: echo native-shell-ok"
omp -p "grep: builtin-probe"        # native grep path
```

## 6. Unsupported diagnostics — implemented (manual)

Android surfaces that are removed must give clear errors, never fake
success:

- `copyToClipboard` from JS errors; the fallback is the Termux CLI
  (`termux-clipboard-set`). Clipboard image paste returns empty.
- `AudioCapture` / `AudioPlayback` constructors throw
  `Native audio is not supported on Android/Termux arm64 build`.
- `LiveWebRtcPeer` constructs but every media call throws
  `LiveWebRtcPeer is not supported on Android/Termux arm64 build`.
- Desktop, local ONNX/STT/tiny inference: unsupported, with a clear message.

## 7. Security gates — pending

**Browser prompt matrix.** Live CDP/relay browser use requires a forced,
per-call prompt on `open` and `run`. `close` takes no prompt. Both the
requested URL args and an already-bound tab are classified and require the
prompt. `yolo` cannot bypass. Clipboard text read, where exposed, requires
per-read host approval. When verifying, do not dump page or clipboard
secrets to outputs; assert prompt/no-prompt behavior only.

**Swap fault injection.** Test fresh install and upgrade from an existing tree.

- fail before backup rename: prior install stays runnable;
- fail after current→`.old`: rollback restores `.old`;
- fail after `.new`→current: remove failed current, then restore `.old`;
- fresh-install failure expects no `.old` and removes the failed tree;
- corrupt archive/checksum aborts before swap;
- isolated test uses `OMP_LIB_DIR` and `OMP_BIN_DIR` overrides.

Portable POSIX uses two renames, not an atomic exchange. A concurrent launch may fail
between renames; final state must always be old-working or new-working.

**Update guard.** Through the installed shim, `OMP_PLATFORM=android`; `omp update`
returns reinstall instructions before network or updater method selection.

## 8. Benchmark gates — pending CI enforcement

`android/scripts/bench.sh` measures median startup and peak RSS of the
installed app against a fixed method.

```sh
android/scripts/bench.sh --runs 9 --json
```

Targets on the reference device:

- `omp --version` median wall time <= 200 ms.
- peak RSS <= 65 MB.

Measured split-path values are well inside these bounds (see
[ci-cd.md](ci-cd.md#7-js-bundle-packaging)). The gate is pending CI or
release enforcement; today it is run by a maintainer.

## 9. On-device smoke test — reference device only

```sh
curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/install.sh | sh
omp --version
```

Additional probes:

```sh
"$PREFIX/lib/omp-termux/bun" -e 'if (!Bun.version) process.exit(1)' # after bundled-runtime phase
"$PREFIX/lib/omp-termux/bun" -e 'console.log(`${process.platform}-${process.arch}`)'
pkg install -y termux-api
echo -n "test" | termux-clipboard-set   # dummy value; never real secrets
```

Before the bundled-runtime phase, use the current launcher (`omp --version`) rather
than treating global `bun` as verified provenance.

### One-device disclosure

On-device results are reference-device only: kernel 6.1.118,
Android/API34-class environment, one device. No broad compatibility claim.
Capability floors (API24 binary, API34 pidfd) come from source and the
toolchain, not from wide device testing.

## 10. Not covered by automation

End-to-end interactive `omp` sessions on-device (the running app is a
manual smoke — sections 5–6, 9) and performance on low-RAM devices.
