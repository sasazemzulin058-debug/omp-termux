#!/bin/sh
set -e

# =========================================================================
# omp-termux 1-Command Standalone Installer for Termux (Android aarch64)
# Repository: sasazemzulin058-debug/omp-termux
# =========================================================================

echo "🚀 Installing omp-termux (Standalone Single Bundle)..."

PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
BIN_DIR="${PREFIX_DIR}/bin"
LIB_DIR="${PREFIX_DIR}/lib/omp"
RELEASE_TAG="v0.0.1"

BUNDLE_URL="https://github.com/sasazemzulin058-debug/omp-termux/releases/download/${RELEASE_TAG}/omp-standalone.js"
NATIVE_URL="https://github.com/sasazemzulin058-debug/omp-termux/releases/download/${RELEASE_TAG}/pi_natives.android-arm64.node"

# 1. Ensure required packages in Termux
for pkg in curl; do
    if ! command -v "$pkg" >/dev/null 2>&1; then
        echo "Installing missing package: $pkg..."
        pkg install -y "$pkg"
    fi
done

# 2. Create system directories
mkdir -p "$BIN_DIR" "$LIB_DIR/packages/natives/native"

BUNDLE_FILE="$LIB_DIR/omp-standalone.js"
NATIVE_FILE="$LIB_DIR/packages/natives/native/pi_natives.android-arm64.node"

# 3. Download standalone JS bundle (24 MB)
echo "📥 Downloading standalone omp JavaScript bundle..."
curl -fsSL -L "$BUNDLE_URL" -o "$BUNDLE_FILE.tmp"
mv "$BUNDLE_FILE.tmp" "$BUNDLE_FILE"

# 4. Download Android arm64 native addon (113 MB) if missing/incomplete
if [ ! -f "$NATIVE_FILE" ] || [ $(wc -c < "$NATIVE_FILE") -lt 100000000 ]; then
    echo "📥 Downloading Android arm64 native addon..."
    curl -fsSL -L "$NATIVE_URL" -o "$NATIVE_FILE.tmp"
    mv "$NATIVE_FILE.tmp" "$NATIVE_FILE"
fi

# 5. Create launcher at $PREFIX/bin/omp
LAUNCHER="${BIN_DIR}/omp"
echo "🔧 Setting up launcher at ${LAUNCHER}..."

cat << EOF > "$LAUNCHER"
#!/bin/sh
GLIBC_RUNNER="\$(command -v glibc-runner || command -v grun)"
exec "\$GLIBC_RUNNER" -s "bun --cwd=$LIB_DIR $BUNDLE_FILE \$@"
EOF

chmod +x "$LAUNCHER"

echo ""
echo "✅ Installation complete!"
echo "🎉 Run 'omp' from anywhere in Termux."
