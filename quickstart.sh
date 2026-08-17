#!/bin/sh
set -eu

# One-command installer for omp-termux (Termux Android aarch64).
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
LIB_DIR="$PREFIX_DIR/lib/omp-termux"
BIN_DIR="$PREFIX_DIR/bin"
REPO="${OMP_REPO:-sasazemzulin058-debug/omp-termux}"
TAG="${OMP_VERSION:-latest}"
BASE="https://github.com/$REPO/releases"
[ "$TAG" = latest ] && BASE="$BASE/latest/download" || BASE="$BASE/download/$TAG"

case "$(uname -m)" in aarch64|arm64) ;; *) echo 'error: Android arm64 required' >&2; exit 1 ;; esac
[ -n "${PREFIX:-}" ] || { echo 'error: run inside Termux' >&2; exit 1; }

BUN_VERSION="${OMP_BUN_VERSION:-1.3.14}"
TMP="$PREFIX_DIR/tmp/omp-termux.$$"
trap 'rm -rf "$TMP" "$LIB_DIR.new"' EXIT INT TERM
mkdir -p "$TMP" "$LIB_DIR.new" "$BIN_DIR"
pkg install -y curl tar

# Download bun if not found in PATH
if command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
  cp "$BUN_BIN" "$LIB_DIR.new/bun"
else
  curl -fL --retry 5 --retry-all-errors --retry-delay 2 \
    "https://registry.npmjs.org/@oven/bun-linux-aarch64-android/-/bun-linux-aarch64-android-${BUN_VERSION}.tgz" \
    -o "$TMP/bun.tgz"
  tar -xzf "$TMP/bun.tgz" -C "$TMP"
  install -m 755 "$TMP/package/bin/bun" "$LIB_DIR.new/bun"
fi
"$LIB_DIR.new/bun" -e 'if (process.platform !== "android" || process.arch !== "arm64") process.exit(1)'
curl -fL --retry 5 --retry-all-errors --retry-delay 2 \
  "$BASE/omp-termux.tar.gz" -o "$TMP/omp-termux.tar.gz"
curl -fL --retry 5 --retry-all-errors --retry-delay 2 \
  "$BASE/omp-termux.tar.gz.sha256" -o "$TMP/omp-termux.tar.gz.sha256"
(cd "$TMP" && sha256sum -c omp-termux.tar.gz.sha256)
tar -xzf "$TMP/omp-termux.tar.gz" -C "$LIB_DIR.new"
rm -rf "$LIB_DIR"
mv "$LIB_DIR.new" "$LIB_DIR"

cat > "$BIN_DIR/omp" <<EOF
#!/bin/sh
exec env OMP_PLATFORM=android "$LIB_DIR/bun" "$LIB_DIR/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/omp"
"$BIN_DIR/omp" --version
printf '%s\n' 'Installed omp-termux. Run: omp'
