#!/bin/sh
set -eu

# One-command Termux installer. CI publishes one self-contained app archive.
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
BIN_DIR="$PREFIX_DIR/bin"
LIB_DIR="$PREFIX_DIR/lib/omp-termux"
REPO="${OMP_REPO:-sasazemzulin058-debug/omp-termux}"
TAG="${OMP_VERSION:-latest}"
BASE="https://github.com/$REPO/releases"
[ "$TAG" = latest ] && BASE="$BASE/latest/download" || BASE="$BASE/download/$TAG"

case "$(uname -m)" in aarch64|arm64) ;; *) echo "error: Termux aarch64 required" >&2; exit 1 ;; esac
[ -n "${PREFIX:-}" ] || { echo 'error: run inside Termux' >&2; exit 1; }

BUN_VERSION="${OMP_BUN_VERSION:-1.3.14}"
BUN_URL="https://registry.npmjs.org/@oven/bun-linux-aarch64-android/-/bun-linux-aarch64-android-${BUN_VERSION}.tgz"
pkg install -y curl tar

mkdir -p "$BIN_DIR" "$PREFIX_DIR/lib"
tmp="$PREFIX_DIR/tmp/omp-termux.$$"
trap 'rm -rf "$tmp" "$LIB_DIR.new"' EXIT INT TERM
mkdir -p "$tmp" "$LIB_DIR.new"
curl -fL --retry 5 --retry-all-errors --retry-delay 2 \
    "$BUN_URL" -o "$tmp/bun.tgz"
mkdir -p "$tmp/bun"
tar -xzf "$tmp/bun.tgz" -C "$tmp/bun"
install -m 755 "$tmp/bun/package/bin/bun" "$LIB_DIR.new/bun"
"$LIB_DIR.new/bun" -e 'if (process.platform !== "android" || process.arch !== "arm64") process.exit(1)'
curl -fL --retry 5 --retry-all-errors --retry-delay 2 \
    "$BASE/omp-termux.tar.gz" -o "$tmp/omp-termux.tar.gz"
curl -fL --retry 5 --retry-all-errors --retry-delay 2 \
    "$BASE/omp-termux.tar.gz.sha256" -o "$tmp/omp-termux.tar.gz.sha256"
(cd "$tmp" && sha256sum -c omp-termux.tar.gz.sha256)
tar -xzf "$tmp/omp-termux.tar.gz" -C "$LIB_DIR.new"
rm -rf "$LIB_DIR"
mv "$LIB_DIR.new" "$LIB_DIR"

cat > "$BIN_DIR/omp" <<EOF
#!/bin/sh
exec env OMP_PLATFORM=android "$LIB_DIR/bun" "$LIB_DIR/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/omp"
"$BIN_DIR/omp" --version
printf '%s\n' 'Installed omp. Run: omp'
