# oh-my-pi on Termux (Android, aarch64)

Android/Termux port of [oh-my-pi](https://github.com/can1357/oh-my-pi).
Android-specific source, build scripts, and verification live under `android/`.

## Support status

- Target: Termux on aarch64 Android.
- Binary floor: API 24. `pidfd` process signaling needs an API 34-class kernel.
- Verified on one reference device: kernel 6.1.118, API 34-class environment.
- No broad Android-device compatibility claim.

Current releases are a developer preview. `install.sh` still uses the Termux
`bun` package and a non-atomic directory replacement. Do not treat it as the
final supported installer.

The approved release contract is pending implementation:

- bundle official Bionic `@oven/bun-linux-aarch64-android@1.3.14`;
- split the CLI into lazy chunks;
- install through a guarded two-rename swap with rollback;
- block `omp update` on Android in favor of reinstall;
- require per-call consent for live Chrome CDP/relay access.

Track delivery in
[`../specs/ANDROID_IMPLEMENTATION_PLAN.md`](../specs/ANDROID_IMPLEMENTATION_PLAN.md).

## Current capability boundary

| Surface | Status |
|---------|--------|
| Shell, PTY, process management, grep, glob, highlighting | Native |
| Text clipboard copy | JS fallback through `termux-clipboard-set` |
| Clipboard image, audio, WebRTC, desktop, local ONNX/STT | Unsupported |
| Browser live CDP/relay | Technically available; mandatory per-call consent is pending |

Unsupported surfaces must return a clear error. They must not report fake success.

## Documentation

| Document | Owner |
|----------|-------|
| [docs/setup.md](docs/setup.md) | Current install behavior, target installer, uninstall, recovery |
| [docs/port-architecture.md](docs/port-architecture.md) | Target Bionic runtime, split layout, capability boundaries |
| [docs/ci-cd.md](docs/ci-cd.md) | Current vs target build/package/release pipeline |
| [docs/verification.md](docs/verification.md) | Implemented and pending acceptance gates |
| [docs/port-changes.md](docs/port-changes.md) | Maintained Android delta and rebase mechanics |

Decision evidence remains in
[`../specs/ANDROID_NATIVE_PLAN.md`](../specs/ANDROID_NATIVE_PLAN.md).
