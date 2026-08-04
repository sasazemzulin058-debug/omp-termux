#!/bin/sh
set -e

# =========================================================================
# omp-termux Native 1-Command Installer for Termux (Android aarch64)
# Repository: sasazemzulin058-debug/omp-termux
# =========================================================================

echo "🚀 Installing omp-termux (Oh My Pi Native Termux Port)..."

PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
BIN_DIR="${PREFIX_DIR}/bin"
INSTALL_DIR="${OMP_INSTALL_DIR:-$PREFIX_DIR/lib/omp-termux}"
REPO_URL="https://github.com/sasazemzulin058-debug/omp-termux.git"
RELEASE_TAG="v0.0.1"
NATIVE_URL="https://github.com/sasazemzulin058-debug/omp-termux/releases/download/${RELEASE_TAG}/pi_natives.android-arm64.node"

# 1. Ensure required packages in Termux
echo "🔍 Checking dependencies (nodejs, git, curl)..."
for pkg in node git curl; do
    if ! command -v "$pkg" >/dev/null 2>&1; then
        echo "Installing missing package: $pkg..."
        pkg install -y "$pkg"
    fi
done

# 2. Clone or update repository
if [ ! -d "$INSTALL_DIR" ]; then
    echo "📦 Cloning repository to $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR"
else
    echo "🔄 Repository already exists at $INSTALL_DIR."
fi

cd "$INSTALL_DIR"

# 3. Download prebuilt Android arm64 native bionic addon if missing/incomplete
NATIVE_FILE="packages/natives/native/pi_natives.android-arm64.node"
mkdir -p packages/natives/native

if [ ! -f "$NATIVE_FILE" ] || [ $(wc -c < "$NATIVE_FILE") -lt 100000000 ]; then
    echo "📥 Downloading prebuilt Android arm64 native addon (pi_natives.android-arm64.node)..."
    curl -fsSL -L "$NATIVE_URL" -o "$NATIVE_FILE.tmp"
    mv "$NATIVE_FILE.tmp" "$NATIVE_FILE"
fi

# 4. Expand catalog / workspace dependencies for npm
echo "⚙️ Configuring npm workspace dependencies..."
node -e '
const fs = require("fs");
const path = require("path");
const rootPkgPath = path.resolve("package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
const catalog = rootPkg.workspaces?.catalog || rootPkg.catalog || {};

function processFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const pkg = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let changed = false;
  for (const depType of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (!pkg[depType]) continue;
    for (const [name, ver] of Object.entries(pkg[depType])) {
      if (ver === "catalog:") {
        if (catalog[name]) { pkg[depType][name] = catalog[name]; changed = true; }
      } else if (typeof ver === "string" && ver.startsWith("workspace:")) {
        pkg[depType][name] = "*"; changed = true;
      }
    }
  }
  if (changed) fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + "\n");
}

processFile(rootPkgPath);
const packagesDir = path.resolve("packages");
if (fs.existsSync(packagesDir)) {
  fs.readdirSync(packagesDir).forEach(dir => processFile(path.join(packagesDir, dir, "package.json")));
}
'

# 5. Run npm install (bionic native)
echo "📦 Installing Node modules via npm..."
npm install --ignore-scripts --no-fund --no-audit

# 6. Install global binary executable at $PREFIX/bin/omp
LAUNCHER="${BIN_DIR}/omp"
echo "🔧 Setting up native launcher at ${LAUNCHER}..."

GLIBC_RUNNER="$(command -v glibc-runner || command -v grun)"

cat << 'EOF' > "$LAUNCHER"
#!/data/data/com.termux/files/usr/bin/sh
# Launcher script for omp-termux
OMP_DIR="${OMP_DIR:-/data/data/com.termux/files/usr/lib/omp-termux}"
GLIBC_RUNNER="$(command -v glibc-runner || command -v grun)"

if [ ! -d "$OMP_DIR" ]; then
    echo "Error: omp-termux directory not found at $OMP_DIR"
    exit 1
fi

exec "$GLIBC_RUNNER" -s "bun --cwd=$OMP_DIR packages/coding-agent/src/cli.ts $@"
EOF

chmod +x "$LAUNCHER"

echo ""
echo "✅ Installation complete!"
echo "🎉 Run 'omp' from anywhere in Termux."
