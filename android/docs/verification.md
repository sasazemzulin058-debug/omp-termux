# Verification Procedures

## Automated CI checks

1. `python3 android/scripts/verify-overlay.py` checks Android overlay markers.
2. `python3 android/scripts/check-release-inputs.py` checks package metadata and official Bun manifest fields.
3. Release downloads `BUN_ARCHIVE_NAME` from the official Bun release URL, verifies `BUN_SHA256`, extracts executable `bun`, and checks aarch64 ELF architecture.
4. Release checks runtime version and package contents:

```sh
sha256sum -c omp-termux.tar.gz.sha256
tar -tzf omp-termux.tar.gz | grep -Fx './cli.js'
tar -tzf omp-termux.tar.gz | grep -Fx './bun'
tar -tzf omp-termux.tar.gz | grep -F './node_modules/@oh-my-pi/pi-natives/native/pi_natives.android-arm64.node'
```

## Local verification

```sh
python3 android/scripts/verify-overlay.py
python3 android/scripts/check-release-inputs.py
```

## Device smoke gate

After installing a release on Android ARM64 / Termux:

```sh
omp --version
bundled_bun="$PREFIX/lib/omp-termux/bun"
"$bundled_bun" --version
omp models --help
omp logs --help
omp stats --json
```

Then exercise one read tool and one bash tool, and launch interactive `omp`. Do not call a release fully verified until `stats --json` and interactive startup pass on device.
