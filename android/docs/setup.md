# Setting up oh-my-pi on Termux

## Requirements

- Android 14 or newer (API 34+). Earlier versions may have process signaling
  (`pidfd_send_signal`) blocked by seccomp.
- aarch64 device (all modern Android phones).
- [Termux](https://github.com/termux/termux-app) from F-Droid or GitHub (the
  Play Store build is outdated — do not use it).

## Option A — prebuilt addon (fastest)

Once a release is published, the native addon is attached to the GitHub Release.

```sh
pkg install -y git bun
git clone --depth 1 https://github.com/sasazemzulin058-debug/omp-termux ~/omp-termux
cd ~/omp-termux
bun install
# download the prebuilt addon for this release tag:
ver=$(git describe --tags --abbrev=0)
curl -fsSL -o packages/natives/native/pi_natives.android-arm64.node \
  "https://github.com/sasazemzulin058-debug/omp-termux/releases/download/$ver/pi_natives.android-arm64.node"
bun packages/coding-agent/src/cli.ts --version
```

## Option B — one-shot installer (builds on-device)

```sh
curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/android/scripts/install-termux.sh | bash
```

Installs prerequisites, clones, applies patches, builds the addon (~10 min on a
flagship; longer on mid-range), and installs the `omp` launcher.

## Option C — manual build

```sh
pkg install -y rust clang git binutils bun
git clone https://github.com/sasazemzulin058-debug/omp-termux ~/omp-termux
cd ~/omp-termux
bun install
CARGO_BUILD_JOBS=2 bash android/scripts/build-termux.sh
```

`CARGO_BUILD_JOBS=2` is important: a full-parallelism build OOM-kills Termux on
most devices. Lower it to `1` if you still hit out-of-memory.

## Running

```sh
omp --version
omp                # interactive
omp -p "summarize this repo"
```

If you built without the installer, launch directly:

```sh
bun ~/omp-termux/packages/coding-agent/src/cli.ts
```

## Known limitations on Android

- **Clipboard copy** is unsupported natively — use `termux-clipboard-set` (from
  the `termux-api` package) if you need it.
- **Clipboard image paste** returns empty.
- Everything else (shell, PTY, process management, grep, file discovery, syntax
  highlighting, tokenization) runs natively.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Build killed mid-compile | Lower `CARGO_BUILD_JOBS` to 1; close other apps |
| `pi_natives ... is not a function` | Addon/version mismatch — rebuild after `git pull` |
| Process signals don't work | Android < 14; seccomp blocks pidfd. Upgrade OS |
| `cargo: command not found` | `pkg install rust` |
