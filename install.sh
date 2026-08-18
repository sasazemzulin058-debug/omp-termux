#!/bin/sh
set -eu

# One-command Termux installer. CI publishes one self-contained app archive.
# Device installs only packaged Bun runtime; no bun install or source build.

PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
BIN_DIR="${OMP_BIN_DIR:-$PREFIX_DIR/bin}"
LIB_DIR="${OMP_LIB_DIR:-$PREFIX_DIR/lib/omp-termux}"
REPO="${OMP_REPO:-sasazemzulin058-debug/omp-termux}"
TAG="${OMP_VERSION:-latest}"
BASE="https://github.com/$REPO/releases"
[ "$TAG" = latest ] && BASE="$BASE/latest/download" || BASE="$BASE/download/$TAG"

case "$(uname -m)" in aarch64|arm64) ;; *) echo "error: Termux aarch64 required" >&2; exit 1 ;; esac
[ -n "${PREFIX:-}" ] || [ -n "${OMP_LIB_DIR:-}" ] || { echo 'error: run inside Termux' >&2; exit 1; }

pkg_deps=""
command -v curl >/dev/null 2>&1 || pkg_deps="$pkg_deps curl"
command -v tar >/dev/null 2>&1 || pkg_deps="$pkg_deps tar"
if [ -n "$pkg_deps" ]; then
    pkg install -y $pkg_deps
fi

mkdir -p "$BIN_DIR" "$(dirname "$LIB_DIR")"
tmp="$(mktemp -d "${TMPDIR:-$PREFIX_DIR/tmp}/omp-install.XXXXXX")"
had_old=0

cleanup() {
    rm -rf "$tmp" "$LIB_DIR.new"
    if [ "$had_old" -eq 1 ] && [ ! -d "$LIB_DIR" ] && [ -d "$LIB_DIR.old" ]; then
        mv "$LIB_DIR.old" "$LIB_DIR"
    fi
}
trap cleanup EXIT INT TERM

mkdir -p "$LIB_DIR.new"
curl -fL --retry 3 "$BASE/omp-termux.tar.gz" -o "$tmp/omp-termux.tar.gz"
curl -fL --retry 3 "$BASE/omp-termux.tar.gz.sha256" -o "$tmp/omp-termux.tar.gz.sha256"
(cd "$tmp" && sha256sum -c omp-termux.tar.gz.sha256)
tar -xzf "$tmp/omp-termux.tar.gz" -C "$LIB_DIR.new"
chmod +x "$LIB_DIR.new/bun"

# Pre-swap smoke test on .new
"$LIB_DIR.new/bun" "$LIB_DIR.new/cli.js" --version >/dev/null 2>&1 || {
    echo 'error: new OMP bundle failed smoke test' >&2
    exit 1
}

# Guarded two-rename swap
if [ -d "$LIB_DIR" ]; then
    rm -rf "$LIB_DIR.old"
    mv "$LIB_DIR" "$LIB_DIR.old"
    had_old=1
fi

if ! mv "$LIB_DIR.new" "$LIB_DIR"; then
    echo 'error: swap failed, restoring previous installation' >&2
    if [ "$had_old" -eq 1 ]; then
        mv "$LIB_DIR.old" "$LIB_DIR"
    fi
    exit 1
fi

# Post-swap smoke test
if ! "$LIB_DIR/bun" "$LIB_DIR/cli.js" --version >/dev/null 2>&1; then
    echo 'error: installed OMP bundle failed post-swap smoke test' >&2
    rm -rf "$LIB_DIR"
    if [ "$had_old" -eq 1 ]; then
        mv "$LIB_DIR.old" "$LIB_DIR"
    fi
    exit 1
fi
cat > "$BIN_DIR/omp" <<EOF
#!/bin/sh
exec env OMP_PLATFORM=android "$LIB_DIR/bun" "$LIB_DIR/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/omp"

if ! "$BIN_DIR/omp" --version >/dev/null 2>&1; then
    echo 'error: installed omp launcher failed verification' >&2
    rm -rf "$LIB_DIR"
    if [ "$had_old" -eq 1 ]; then
        mv "$LIB_DIR.old" "$LIB_DIR"
    fi
    exit 1
fi

rm -rf "$LIB_DIR.old"
had_old=0
printf '%s\n' 'Installed omp. Run: omp'
