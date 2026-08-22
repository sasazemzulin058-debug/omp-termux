# Setting up oh-my-pi on Termux

## Requirements

- Termux on aarch64 (arm64) Android.
- Release binaries target API 24 (Android 7.0) as the binary floor.
- Process signalling (pidfd) needs an API 34-class kernel. Verified on one
  reference device (kernel 6.1.118, API 34). No broad compatibility claim.
- [Termux](https://github.com/termux/termux-app) from F-Droid or GitHub.
  The Play Store build is outdated — do not use it.

## Release install: current preview

```sh
curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/install.sh | sh
omp --version
```

Current `install.sh` is a preview installer. It:

1. Requires Termux and aarch64.
2. Runs `pkg install -y curl tar bun`.
3. Downloads and checks `omp-termux.tar.gz`.
4. Replaces `$PREFIX/lib/omp-termux` with the extracted tree.
5. Writes a shim that executes `$PREFIX/bin/bun $LIB_DIR/cli.js`.

Two current limitations matter:

- the apt `bun` candidate is a glibc-wrapper build, not the verified official
  Bionic runtime;
- replacement is not atomic: `rm -rf "$LIB_DIR"` runs before the new tree moves in.

Do not interrupt installation during replacement. Re-run the installer if it fails.

## Approved installer contract: pending

The target installer is defined in
[`../../specs/ANDROID_IMPLEMENTATION_PLAN.md`](../../specs/ANDROID_IMPLEMENTATION_PLAN.md).
It will:

- ship official stable Bun Android aarch64 runtime in the tarball;
- execute `env OMP_PLATFORM=android $LIB_DIR/bun $LIB_DIR/cli.js`;
- stage and smoke-test the new tree before a guarded two-rename swap with rollback;
- restore the old tree after interruption or failed verification;
- make `omp update` return a reinstall instruction on Android.

These behaviors are **not implemented yet**. The current script remains the source
of truth until the implementation plan lands.

## Update and reinstall

Current `omp update` is not Android-aware and may throw
`Unsupported platform: android`. Re-run `install.sh` instead.

After the target guard lands, `omp update` will print the same reinstall instruction
and exit without network or replacement work.

## Uninstall

```sh
rm -rf "$PREFIX/lib/omp-termux"
rm -f "$PREFIX/bin/omp"
```

## Recovery after an interrupted install

- Before extraction/replacement: re-run the installer.
- During `rm -rf`/`mv`: the current preview may leave `$LIB_DIR` missing or partial.
  Re-run the installer. There is no rollback until the guarded-installer phase lands.
- Checksum mismatch: re-run; downloads already use `curl --retry 3`.
- `$LIB_DIR` intact but `omp` missing: re-run to restore `$PREFIX/bin/omp`.

## Source build (maintainers only)

The on-device source build compiles the native addon on the device from a
source clone. It needs Rust, the full toolchain, and a long OOM-controlled
build. This is not the supported user path; use the release install. See
[../README.md](../README.md) and the scripts under `android/scripts/` for
how to run it.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `pi_natives ... is not a function` | Addon/CLI mismatch. Reinstall the bundle, or rebuild after `git pull`. |
| Installer checksum mismatch | Corrupt download. Re-run the installer. |
| Process signals don't work | Kernel below API 34; seccomp blocks pidfd. Only the reference device (API 34) is verified. |
| `omp` starts but clipboard copy fails | Unsupported — expected. Use `termux-clipboard-set` (`termux-api`). |
| Clipboard image paste returns empty | Unsupported — expected. |
| Audio / WebRTC calls throw | Unsupported — stubbed on Android. Expected. |

Unsupported capabilities fail loudly; they are not install errors.
