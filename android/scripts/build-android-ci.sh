#!/usr/bin/env bash
# Cross-compile pi-natives for aarch64-linux-android on a Linux x86_64 CI
# runner using the Android NDK directly (not cargo-zigbuild, which has no
# bionic libc support). Outputs pi_natives.android-arm64.node at the canonical
# location and verifies it.
#
# Required env:
#   ANDROID_NDK_ROOT — root of an NDK that ships aarch64-linux-android clang,
#                      e.g. r27 from nttld/setup-ndk
#
# Optional env:
#   CARGO_BUILD_JOBS — parallel cargo jobs (default 2)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

: "${ANDROID_NDK_ROOT:?ANDROID_NDK_ROOT must be set to the NDK root}"

NATIVE_DIR="packages/natives/native"
ADDON="$NATIVE_DIR/pi_natives.android-arm64.node"
JOBS="${CARGO_BUILD_JOBS:-2}"
export CARGO_BUILD_JOBS="$JOBS"

NDK_CLANG="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang"
NDK_AR="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar"
NDK_RANLIB="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ranlib"
NDK_STRIP="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"

for tool in "$NDK_CLANG" "$NDK_AR" "$NDK_RANLIB" "$NDK_STRIP"; do
	[ -x "$tool" ] || { echo "error: NDK tool not found: $tool" >&2; exit 1; }
done

# Point cargo + cc-rs at the NDK clang for the aarch64-linux-android target.
# `cc` (cc-rs) reads CC_<target> (dashes → underscores); cargo reads
# CARGO_TARGET_<TARGET>_LINKER / _AR. Both must agree on the toolchain.
export CC_aarch64_linux_android="$NDK_CLANG"
export AR_aarch64_linux_android="$NDK_AR"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK_CLANG"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_AR="$NDK_AR"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RANLIB="$NDK_RANLIB"

# Locate the napi bin. The CLI is declared as a dev dependency in
# packages/natives, so `bun install` should hoist `node_modules/.bin/napi` to
# the repo root, but workspace hoisting varies; check several locations and
# fall back to a direct JS entry.
NAPI_BIN=""
for candidate in \
	"$REPO_ROOT/node_modules/.bin/napi" \
	"$REPO_ROOT/packages/natives/node_modules/.bin/napi"
do
	if [ -x "$candidate" ]; then
		NAPI_BIN="$candidate"
		break
	fi
done
if [ -z "$NAPI_BIN" ]; then
	NAPI_BIN="$(command -v napi 2>/dev/null || true)"
fi
# Last resort: invoke the JS entry directly via node.
if [ -z "$NAPI_BIN" ] || [ ! -x "$NAPI_BIN" ]; then
	ENTRY=""
	for c in \
		"$REPO_ROOT/node_modules/@napi-rs/cli/cli.mjs" \
		"$REPO_ROOT/node_modules/@napi-rs/cli/dist/cli.js" \
		"$REPO_ROOT/packages/natives/node_modules/@napi-rs/cli/cli.mjs"
	do
		if [ -f "$c" ]; then ENTRY="$c"; break; fi
	done
	if [ -n "$ENTRY" ] && command -v node >/dev/null 2>&1; then
		NAPI_BIN="node"
		# Use a wrapper: shift args to put the entry first.
		napi_entry="$ENTRY"
	fi
fi
if [ -z "$NAPI_BIN" ]; then
	echo "error: napi CLI not found in workspace node_modules" >&2
	echo "rerun 'bun install' from repo root" >&2
	exit 1
fi

echo "==> Cross-compiling pi-natives (aarch64-linux-android, jobs=$JOBS)"
echo "    NDK clang: $NDK_CLANG"
echo "    napi bin:  $NAPI_BIN"

mkdir -p "$NATIVE_DIR/.build"
TMP_DIR="$(mktemp -d "$NATIVE_DIR/.build/cross-XXXXXX")"

# Call napi build directly with --target but WITHOUT --cross-compile, so napi
# invokes `cargo build --target aarch64-linux-android` (not cargo-zigbuild,
# which cannot provide bionic libc).
if [ "$NAPI_BIN" = "node" ] && [ -n "${napi_entry:-}" ]; then
	# Direct entry-point invocation (fallback when .bin was not hoisted).
	"$NAPI_BIN" "$napi_entry" build \
		--manifest-path "$REPO_ROOT/crates/pi-natives/Cargo.toml" \
		--package-json-path "$REPO_ROOT/packages/natives/package.json" \
		--target aarch64-linux-android \
		--profile release \
		--platform --no-js --dts index.d.ts \
		-o "$TMP_DIR"
else
	"$NAPI_BIN" build \
		--manifest-path "$REPO_ROOT/crates/pi-natives/Cargo.toml" \
		--package-json-path "$REPO_ROOT/packages/natives/package.json" \
		--target aarch64-linux-android \
		--profile release \
		--platform --no-js --dts index.d.ts \
		-o "$TMP_DIR"
fi

# napi copies the produced .node into $TMP_DIR named `pi_natives.<platformArchABI>.node`
# (see @napi-rs/cli src/api/build.ts:839). For --target aarch64-linux-android that
# becomes `pi_natives.android-arm64.node`.
BUILT="$TMP_DIR/pi_natives.android-arm64.node"
if [ ! -f "$BUILT" ]; then
	echo "error: napi build did not produce $BUILT" >&2
	ls -la "$TMP_DIR" >&2
	exit 1
fi

# Strip in place (NDK debug symbols can bloat the .node to 100+ MB) and copy
# to the canonical filename.
"$NDK_STRIP" --strip-unneeded "$BUILT" 2>/dev/null || true
cp "$BUILT" "$ADDON"

# Verify
file_type="$(file -b "$ADDON")"
echo "==> Built: $ADDON"
echo "    $file_type"
case "$file_type" in
	*ELF*aarch64*) echo "    OK: aarch64 ELF shared object" ;;
	*) echo "error: unexpected file type: $file_type" >&2; exit 1 ;;
esac

# Emit sha256
sha256sum "$ADDON" | awk '{print $1}' > "$ADDON.sha256"
echo "    sha256: $(cat "$ADDON.sha256")"
echo "==> Done"
