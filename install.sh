#!/bin/sh
set -eu

# One-command Termux installer. CI publishes one self-contained app archive.
# Device installs only packaged Bun runtime; no bun install or source build.

PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
BIN_DIR="$PREFIX_DIR/bin"
LIB_DIR="$PREFIX_DIR/lib/omp-termux"
REPO="${OMP_REPO:-sasazemzulin058-debug/omp-termux}"
TAG="${OMP_VERSION:-latest}"
BASE="https://github.com/$REPO/releases"
[ "$TAG" = latest ] && BASE="$BASE/latest/download" || BASE="$BASE/download/$TAG"

case "$(uname -m)" in aarch64|arm64) ;; *) echo "error: Termux aarch64 required" >&2; exit 1 ;; esac
[ -n "${PREFIX:-}" ] || { echo 'error: run inside Termux' >&2; exit 1; }

pkg install -y curl tar bun
bun -e 'if (!Bun.version) process.exit(1)' || {
    echo 'error: Bun runtime failed smoke test' >&2
    exit 1
}

mkdir -p "$BIN_DIR" "$PREFIX_DIR/lib"
tmp="$PREFIX_DIR/tmp/omp-termux.$$"
trap 'rm -rf "$tmp" "$LIB_DIR.new"' EXIT INT TERM
mkdir -p "$tmp" "$LIB_DIR.new"
curl -fL --retry 3 "$BASE/omp-termux.tar.gz" -o "$tmp/omp-termux.tar.gz"
curl -fL --retry 3 "$BASE/omp-termux.tar.gz.sha256" -o "$tmp/omp-termux.tar.gz.sha256"
(cd "$tmp" && sha256sum -c omp-termux.tar.gz.sha256)
tar -xzf "$tmp/omp-termux.tar.gz" -C "$LIB_DIR.new"
rm -rf "$LIB_DIR"
mv "$LIB_DIR.new" "$LIB_DIR"

cat > "$BIN_DIR/omp" <<EOF
#!/bin/sh
exec "$PREFIX_DIR/bin/bun" "$LIB_DIR/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/omp"
"$BIN_DIR/omp" --version
printf '%s\n' 'Installed omp. Run: omp'
