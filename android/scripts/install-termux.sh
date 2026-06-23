#!/usr/bin/env bash
# One-shot installer for oh-my-pi on Termux (Android 14+, aarch64).
#
# Clones this fork, installs build prerequisites, applies the Android patches,
# builds the native addon on-device, installs JS deps, and drops an `omp`
# launcher into $PREFIX/bin. Designed to be piped:
#   curl -fsSL <raw-url>/android/scripts/install-termux.sh | bash
# or run from a checkout.
set -euo pipefail

REPO_URL="${OMP_REPO_URL:-https://github.com/sasazemzulin058-debug/omp-termux}"
INSTALL_DIR="${OMP_INSTALL_DIR:-$HOME/omp-termux}"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- preflight: must be Termux ----------------------------------------------
[ -d "$PREFIX" ] || die "Termux \$PREFIX not found ($PREFIX). This installer is Termux-only."
case "$(uname -m)" in
	aarch64|arm64) ;;
	*) die "unsupported arch $(uname -m); only aarch64 is supported" ;;
esac

# Android 14+ (API 34) required for pidfd_send_signal under seccomp.
api="$(getprop ro.build.version.sdk 2>/dev/null || echo 0)"
if [ "$api" -gt 0 ] && [ "$api" -lt 34 ]; then
	warn "Android API $api detected; API 34+ (Android 14) is recommended."
	warn "Process signaling (pidfd) may be killed by seccomp on API 31-33."
fi

# --- prerequisites -----------------------------------------------------------
log "Installing build prerequisites via pkg"
pkg install -y rust clang git binutils || die "pkg install failed"

command -v bun >/dev/null 2>&1 || {
	log "Installing Bun"
	if command -v npm >/dev/null 2>&1; then
		npm install -g bun || die "bun install via npm failed"
	else
		die "bun not found and npm unavailable; install bun manually then re-run"
	fi
}

# --- clone / update ----------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
	log "Updating existing checkout at $INSTALL_DIR"
	git -C "$INSTALL_DIR" pull --ff-only || warn "git pull failed; using existing tree"
else
	log "Cloning $REPO_URL -> $INSTALL_DIR"
	git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || die "git clone failed"
fi

cd "$INSTALL_DIR"

# --- JS deps -----------------------------------------------------------------
log "Installing JS dependencies (bun install)"
bun install || die "bun install failed"

# --- native build ------------------------------------------------------------
log "Building native addon on-device (this is slow; ~10 min)"
CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" bash android/scripts/build-termux.sh || die "native build failed"

# --- launcher ----------------------------------------------------------------
# The `omp` bin is defined by packages/coding-agent (bin.omp -> src/cli.ts).
# A thin launcher that runs it through bun avoids a global install step and
# keeps the native addon resolution pointed at this checkout.
launcher="$PREFIX/bin/omp"
log "Installing launcher at $launcher"
cat > "$launcher" <<EOF
#!/usr/bin/env bash
exec bun "$INSTALL_DIR/packages/coding-agent/src/cli.ts" "\$@"
EOF
chmod +x "$launcher"

log "Done. Run: omp --version"
