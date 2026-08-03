#!/bin/sh

set -u

PROGRAM=spool-installer
VERSION=
PREFIX=
PREFIX_SUPPLIED=0
RELEASES_URL=${SPOOL_RELEASE_BASE_URL:-https://github.com/elazzabi/spool/releases}

usage() {
  cat <<'EOF'
Usage: install.sh [--version X.Y.Z] [--prefix PATH]

Install the latest stable spool release, or an exact stable version, without npm.
EOF
}

fail() {
  printf '%s: %s\n' "$PROGRAM" "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires X.Y.Z"
      VERSION=$2
      shift 2
      ;;
    --prefix)
      [ "$#" -ge 2 ] || fail "--prefix requires a path"
      PREFIX=$2
      PREFIX_SUPPLIED=1
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

if [ "$PREFIX_SUPPLIED" -eq 0 ]; then
  [ -n "${HOME:-}" ] || fail "HOME is not set; pass --prefix PATH"
  PREFIX=$HOME/.local
fi

if [ -n "$VERSION" ]; then
  case "$VERSION" in
    *[!0-9.]*|*.*.*.*|.*|*.) fail "expected an exact stable version such as 1.2.3" ;;
  esac
  OLD_IFS=$IFS
  IFS=.
  set -- $VERSION
  IFS=$OLD_IFS
  [ "$#" -eq 3 ] && [ -n "$1" ] && [ -n "$2" ] && [ -n "$3" ] ||
    fail "expected an exact stable version such as 1.2.3"
  ASSET_BASE=$RELEASES_URL/download/v$VERSION
else
  ASSET_BASE=$RELEASES_URL/latest/download
fi

[ -n "$PREFIX" ] || fail "installation prefix cannot be empty"
command -v node >/dev/null 2>&1 || fail "Node 24 is required; install it and retry"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]") || fail "could not inspect Node"
NODE_ABI=$(node -p "process.versions.modules") || fail "could not inspect Node ABI"
PLATFORM=$(node -p "process.platform") || fail "could not inspect operating system"
ARCHITECTURE=$(node -p "process.arch") || fail "could not inspect architecture"

[ "$NODE_MAJOR" = 24 ] || fail "unsupported Node major $NODE_MAJOR; spool requires Node 24"
[ "$NODE_ABI" = 137 ] || fail "unsupported Node ABI $NODE_ABI; spool requires ABI 137"
case "$PLATFORM-$ARCHITECTURE" in
  darwin-x64|darwin-arm64|linux-x64|linux-arm64) ;;
  *) fail "unsupported runtime tuple: $PLATFORM-$ARCHITECTURE" ;;
esac

TEMPORARY_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/spool-install.XXXXXX") ||
  fail "could not create temporary directory"
cleanup() {
  rm -rf "$TEMPORARY_ROOT"
}
trap cleanup 0
trap 'cleanup; exit 1' HUP INT TERM

MANIFEST_PATH=$TEMPORARY_ROOT/release-manifest.json
if ! curl -fL --retry 2 --connect-timeout 10 --max-time 300 \
  --speed-limit 1024 --speed-time 30 -o "$MANIFEST_PATH" \
  "$ASSET_BASE/release-manifest.json"; then
  fail "could not download release manifest from $ASSET_BASE"
fi

SELECTION=$(node -e '
const fs = require("node:fs");
const [manifestPath, platform, architecture, abi, requested] = process.argv.slice(1);
let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
catch { throw new Error("release manifest is not valid JSON"); }
if (manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("release manifest metadata is invalid");
}
if (!/^[0-9a-f]{40}$/.test(manifest.sourceRevision)) {
  throw new Error("release manifest source revision is invalid");
}
if (requested && manifest.version !== requested) {
  throw new Error(`requested ${requested}, but manifest describes ${manifest.version}`);
}
if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 4) {
  throw new Error("release manifest must contain the complete four-tuple matrix");
}
const declared = new Set(["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]);
const seen = new Set();
for (const artifact of manifest.artifacts) {
  if (!artifact || typeof artifact !== "object") throw new Error("invalid artifact descriptor");
  const tuple = `${artifact.platform}-${artifact.architecture}`;
  if (!declared.has(tuple)) throw new Error(`undeclared release tuple: ${tuple}`);
  if (seen.has(tuple)) throw new Error(`duplicate release tuple: ${tuple}`);
  seen.add(tuple);
  if (artifact.nodeMajor !== 24 || artifact.nodeAbi !== 137) {
    throw new Error(`invalid Node contract for ${tuple}`);
  }
  const expected = `spool-v${manifest.version}-node24-abi137-${tuple}.tar.gz`;
  if (artifact.filename !== expected || !/^[A-Za-z0-9._-]+$/.test(artifact.filename)) {
    throw new Error(`invalid artifact filename for ${tuple}`);
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
    throw new Error(`invalid digest or size for ${tuple}`);
  }
}
if (seen.size !== declared.size) throw new Error("release manifest matrix is incomplete");
const matches = manifest.artifacts.filter((item) =>
  item.platform === platform && item.architecture === architecture &&
  item.nodeMajor === 24 && item.nodeAbi === Number(abi));
if (matches.length !== 1) throw new Error("release manifest does not declare exactly one matching artifact");
const artifact = matches[0];
process.stdout.write(`${artifact.filename} ${artifact.sha256} ${manifest.version} ${artifact.size}`);
' "$MANIFEST_PATH" "$PLATFORM" "$ARCHITECTURE" "$NODE_ABI" "$VERSION") ||
  fail "release manifest is malformed or does not support this runtime"

set -- $SELECTION
[ "$#" -eq 4 ] || fail "release manifest selection returned invalid data"
ARTIFACT_FILENAME=$1
ARTIFACT_DIGEST=$2
RELEASE_VERSION=$3
ARTIFACT_SIZE=$4
ARTIFACT_PATH=$TEMPORARY_ROOT/$ARTIFACT_FILENAME

if ! curl -fL --retry 2 --connect-timeout 10 --max-time 300 \
  --speed-limit 1024 --speed-time 30 -o "$ARTIFACT_PATH" \
  "$ASSET_BASE/$ARTIFACT_FILENAME"; then
  fail "could not download release artifact $ARTIFACT_FILENAME"
fi

ACTUAL_SIZE=$(wc -c < "$ARTIFACT_PATH" | tr -d '[:space:]')
[ "$ACTUAL_SIZE" = "$ARTIFACT_SIZE" ] || fail "release artifact size mismatch"

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_DIGEST=$(sha256sum "$ARTIFACT_PATH" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_DIGEST=$(shasum -a 256 "$ARTIFACT_PATH" | awk '{print $1}')
else
  fail "sha256sum or shasum is required to verify the release"
fi
[ "$ACTUAL_DIGEST" = "$ARTIFACT_DIGEST" ] || fail "release artifact SHA-256 mismatch"

CANDIDATE=$TEMPORARY_ROOT/candidate
mkdir "$CANDIDATE" || fail "could not stage candidate"
tar -xzf "$ARTIFACT_PATH" -C "$CANDIDATE" || fail "could not extract release artifact"
MANAGED_INSTALL=$CANDIDATE/dist/distribution/managed-install.js
[ -f "$MANAGED_INSTALL" ] || fail "release artifact is missing its managed installer"

set -- install \
  --candidate "$CANDIDATE" \
  --prefix "$PREFIX" \
  --version "$RELEASE_VERSION" \
  --release-source "$ASSET_BASE" \
  --artifact-digest "$ARTIFACT_DIGEST" \
  --node-abi "$NODE_ABI"
if [ -n "${SPOOL_CONFIG_PATH:-}" ]; then
  set -- "$@" --config "$SPOOL_CONFIG_PATH"
fi

node "$MANAGED_INSTALL" "$@"
STATUS=$?
exit "$STATUS"
