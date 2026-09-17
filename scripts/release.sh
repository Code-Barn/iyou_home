#!/usr/bin/env bash
#
# iyou_home — One-Click Sovereign Release Pipeline
#
# Automatically bumps SemVer across all 5 manifests, commits the bump,
# builds macOS (local) and Linux (remote dc13 runner) release bundles,
# triggers Windows NSIS installer compilation via GitHub Actions,
# stages them under release-artifacts/, computes SHA-256 sums, publishes a
# GitHub Release for tag "v${VERSION}", and self-checks the download URLs.
#
# Usage:
#   ./scripts/release.sh           # bump patch (default: 0.2.0 -> 0.2.1)
#   ./scripts/release.sh patch     # explicit patch bump
#   ./scripts/release.sh minor     # bump minor (0.2.0 -> 0.3.0)
#   ./scripts/release.sh major     # bump major (0.2.0 -> 1.0.0)
#   ./scripts/release.sh 0.3.5     # explicit target version
#   ./scripts/release.sh current   # build/publish current version without bumping
#
# Idempotent: safe to re-run when a release tag already exists (it will
# re-upload and clobber assets). Requires: gh CLI (authenticated), ssh dc13
# (runner reachable), node/npm, and the Tauri toolchain on the local machine.
#
# Env overrides:
#   BUMP=patch|minor|major|current|X.Y.Z (alternative to CLI argument)
#   SKIP_MAC=1      skip the local macOS build
#   SKIP_LINUX=1    skip the remote dc13 Linux build
#   SKIP_WINDOWS=1  skip the Windows NSIS GitHub Actions build dispatch
#   SKIP_UPLOAD=1   skip tagging + GitHub release publish (staging only)
#   RELEASE_NOTES   custom release notes text
#   RELEASE_REMOTE  target git remote (default: auto-detected)
#
set -euo pipefail

# ---------------------------------------------------------------- helpers
log()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\n[FATAL] %s\n' "$*" >&2; exit 1; }

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

BUMP_ARG="${1:-${BUMP:-patch}}"

if [[ "${BUMP_ARG}" == "--help" || "${BUMP_ARG}" == "-h" ]]; then
  echo "iyou_home — One-Click Sovereign Release Pipeline"
  echo ""
  echo "Usage: $0 [patch|minor|major|<version>|current]"
  echo ""
  echo "Arguments:"
  echo "  patch     Bump patch version (default, e.g. 0.2.0 -> 0.2.1)"
  echo "  minor     Bump minor version (e.g. 0.2.0 -> 0.3.0)"
  echo "  major     Bump major version (e.g. 0.2.0 -> 1.0.0)"
  echo "  X.Y.Z     Bump to explicit SemVer version"
  echo "  current   Build & publish current version without bumping (alias: none)"
  echo ""
  echo "Environment variables:"
  echo "  BUMP          Alternative to positional argument"
  echo "  SKIP_MAC=1    Skip local macOS build"
  echo "  SKIP_LINUX=1  Skip remote dc13 Linux build"
  echo "  SKIP_WINDOWS=1 Skip Windows NSIS GitHub Actions workflow dispatch"
  echo "  SKIP_UPLOAD=1 Stage and checksum only (no tag, no push, no publish)"
  echo "  RELEASE_NOTES Custom release notes string"
  echo "  RELEASE_REMOTE Target git remote (default: auto-detected)"
  exit 0
fi

# Identify the GitHub remote that points at Code-Barn/iyou_home.
pick_release_remote() {
  for r in pushall origin gh; do
    if url="$(git config --get "remote.$r.url")"; then
      case "$url" in
        *github.com*Code-Barn/iyou_home*) echo "$r"; return 0 ;;
      esac
    fi
  done
  fail "no git remote points at github.com/Code-Barn/iyou_home (set RELEASE_REMOTE)"
}
REMOTE="${RELEASE_REMOTE:-$(pick_release_remote)}"
REPO="Code-Barn/iyou_home"
RELEASE_DIR="$ROOT/release-artifacts"
mkdir -p "$RELEASE_DIR"

# ---------------------------------------------------------------- version bump
case "$BUMP_ARG" in
  current|none|0)
    log "Releasing currently committed version without bumping"
    ;;
  patch|minor|major|[0-9]*)
    log "Bumping version ($BUMP_ARG)..."
    [[ -z "$(git status --porcelain)" ]] || fail "git working tree is dirty; commit or stash before bumping version"

    CURRENT_VERSION="$(node -p "require('./package.json').version")"
    log "Current version: ${CURRENT_VERSION}"

    # 1. Update package.json & package-lock.json
    npm version "$BUMP_ARG" --no-git-tag-version >/dev/null
    NEW_VERSION="$(node -p "require('./package.json').version")"
    [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "non-SemVer version '$NEW_VERSION' produced by npm version"
    log "New version: ${NEW_VERSION}"

    # 2. Update src-tauri/tauri.conf.json
    node -e '
      const fs = require("fs");
      const p = "src-tauri/tauri.conf.json";
      const conf = JSON.parse(fs.readFileSync(p, "utf8"));
      conf.version = process.argv[1];
      fs.writeFileSync(p, JSON.stringify(conf, null, 4) + "\n");
    ' "$NEW_VERSION"

    # 3. Update src-tauri/Cargo.toml
    node -e '
      const fs = require("fs");
      const p = "src-tauri/Cargo.toml";
      let content = fs.readFileSync(p, "utf8");
      content = content.replace(/(\[package\][\s\S]*?version\s*=\s*")[^"]+(")/, `$1${process.argv[1]}$2`);
      fs.writeFileSync(p, content);
    ' "$NEW_VERSION"

    # 4. Update src-tauri/Cargo.lock
    cargo check --manifest-path src-tauri/Cargo.toml --quiet

    # 5. Commit the 5 manifests
    git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
    git commit -m "chore(release): bump version to v${NEW_VERSION}"
    log "Committed version bump to v${NEW_VERSION}"
    ;;
  *)
    fail "unrecognized bump argument '$BUMP_ARG' (expected: patch, minor, major, explicit X.Y.Z, or current/none)"
    ;;
esac

# ---------------------------------------------------------------- pre-flight
log "Pre-flight checks"

VERSION="$(node -p "require('./package.json').version")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "non-SemVer version '$VERSION' in package.json"
log "Version: ${VERSION} (tag v${VERSION})"

[[ -z "$(git status --porcelain)" ]] || fail "git working tree is dirty; commit or stash before releasing"
git rev-parse --git-dir >/dev/null

command -v gh >/dev/null || fail "gh CLI not found"
gh auth status >/dev/null 2>&1 || fail "gh not authenticated"
command -v node >/dev/null || fail "node not found"
command -v cargo >/dev/null || fail "cargo not found"

if [[ "${SKIP_LINUX:-0}" != "1" ]]; then
  ssh -o BatchMode=yes -o ConnectTimeout=15 dc13 "true" || fail "ssh dc13 unreachable"
fi

# ---------------------------------------------------------------- stage
log "Staging directory: ${RELEASE_DIR}"
rm -f "$RELEASE_DIR"/iyou-home_* "$RELEASE_DIR"/iyou-home-* "$RELEASE_DIR"/SHA256SUMS.txt "$RELEASE_DIR"/MIRRORS.txt

# ---------------------------------------------------------------- Mac build
if [[ "${SKIP_MAC:-0}" != "1" ]]; then
  log "Building macOS bundle (local)"
  npm run tauri build
  dmg="$(find src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -print -quit 2>/dev/null || true)"
  [[ -n "$dmg" && -f "$dmg" ]] || fail "no .dmg produced under src-tauri/target/release/bundle/dmg/"
  cp "$dmg" "$RELEASE_DIR/iyou-home_${VERSION}_x64.dmg"
  log "macOS bundle staged: iyou-home_${VERSION}_x64.dmg"
else
  log "Skipping macOS build (SKIP_MAC=1)"
fi

# ---------------------------------------------------------------- Linux build
if [[ "${SKIP_LINUX:-0}" != "1" ]]; then
  log "Building Linux bundles on dc13 (streaming repository, clean build)"

  tar_flags=(--exclude='.git' --exclude='node_modules' --exclude='src-tauri/target' --exclude='dist')
  if tar --version 2>/dev/null | head -n1 | grep -qi bsdtar; then
    tar_flags+=(--no-xattrs)   # macOS bsdtar would otherwise stall on xattr metadata
  fi

  remote_cmd='set -euo pipefail; export PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games"; rm -rf ~/build-runner; mkdir -p ~/build-runner; tar -xzf - -C ~/build-runner; cd ~/build-runner; npm ci; npm run tauri build; ls -1 src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/appimage/*.AppImage'

  tar "${tar_flags[@]}" -czf - -C "$ROOT" . | ssh -o BatchMode=yes dc13 "$remote_cmd"

  scp "dc13:~/build-runner/src-tauri/target/release/bundle/deb/"*.deb "$RELEASE_DIR/"
  scp "dc13:~/build-runner/src-tauri/target/release/bundle/appimage/"*.AppImage "$RELEASE_DIR/"
  scp "dc13:~/build-runner/src-tauri/target/release/bundle/rpm/"*.rpm "$RELEASE_DIR/" 2>/dev/null || true

  log "Linux bundles staged: .deb, .AppImage (+ .rpm)"
else
  log "Skipping dc13 Linux build (SKIP_LINUX=1)"
fi

# ---------------------------------------------------------------- checksums
log "Generating checksums"

if command -v sha256sum >/dev/null 2>&1; then
  HASH_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH_TOOL="shasum -a 256"
else
  fail "no sha256sum/shasum tool found"
fi

(
  cd "$RELEASE_DIR"
  shopt -s nullglob
  staged_files=(iyou-home_*)
  if [ ${#staged_files[@]} -gt 0 ]; then
    ${HASH_TOOL} "${staged_files[@]}" > SHA256SUMS.txt
    log "SHA256SUMS.txt:"
    cat "$RELEASE_DIR/SHA256SUMS.txt"
  else
    log "No staged bundles found under ${RELEASE_DIR}."
  fi
)

# ---------------------------------------------------------------- mirrors
log "Generating BitTorrent metainfo and IPFS mirror manifests"

# 1. BitTorrent (.torrent + magnet URI)
TORRENT_FILE="iyou-home_${VERSION}.torrent"
TORRENT_PATH="$RELEASE_DIR/$TORRENT_FILE"

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

if [[ -n "$PYTHON_BIN" ]]; then
  log "Generating BitTorrent metainfo using $PYTHON_BIN (bencode engine)..."
  eval "$($PYTHON_BIN - "$RELEASE_DIR" "$VERSION" << 'PYEOF'
import os
import sys
import hashlib
import time
import urllib.parse

def bencode(val):
    if isinstance(val, int):
        return f"i{val}e".encode("ascii")
    elif isinstance(val, str):
        b = val.encode("utf-8")
        return f"{len(b)}:".encode("ascii") + b
    elif isinstance(val, bytes):
        return f"{len(val)}:".encode("ascii") + val
    elif isinstance(val, list):
        return b"l" + b"".join(bencode(x) for x in val) + b"e"
    elif isinstance(val, dict):
        items = []
        for k, v in val.items():
            kb = k.encode("utf-8") if isinstance(k, str) else k
            items.append((kb, v))
        items.sort(key=lambda x: x[0])
        res = b"d"
        for kb, v in items:
            res += f"{len(kb)}:".encode("ascii") + kb + bencode(v)
        res += b"e"
        return res
    raise TypeError(f"Cannot bencode {type(val)}")

release_dir = sys.argv[1]
version = sys.argv[2]
torrent_name = f"iyou-home_{version}.torrent"
torrent_path = os.path.join(release_dir, torrent_name)

trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce"
]

files = []
if os.path.isdir(release_dir):
    for f in sorted(os.listdir(release_dir)):
        full = os.path.join(release_dir, f)
        if os.path.isfile(full):
            # Include installer packages, exclude .torrent and .txt
            if (f.startswith(('iyou-home_', 'iyou-home-')) and not f.endswith(('.torrent', '.txt'))) or f.endswith(('.deb', '.AppImage', '.dmg', '.exe', '.rpm')):
                files.append(f)

if not files:
    btih = "0" * 40
    magnet = f"magnet:?xt=urn:btih:{btih}&dn=iyou-home_{version}"
    for tr in trackers:
        magnet += f"&tr={urllib.parse.quote(tr, safe='')}"
    print(f"BTIH={btih}")
    print(f"MAGNET_LINK='{magnet}'")
    sys.exit(0)

piece_len = 262144  # 256 KiB
pieces = bytearray()
buffer = bytearray()
files_info = []

for f in files:
    full = os.path.join(release_dir, f)
    sz = os.path.getsize(full)
    files_info.append({"length": sz, "path": [f]})
    with open(full, "rb") as fh:
        while True:
            chunk = fh.read(piece_len - len(buffer))
            if not chunk:
                break
            buffer.extend(chunk)
            if len(buffer) == piece_len:
                pieces.extend(hashlib.sha1(buffer).digest())
                buffer.clear()

if len(buffer) > 0:
    pieces.extend(hashlib.sha1(buffer).digest())
    buffer.clear()

info_dict = {
    "files": files_info,
    "name": f"iyou-home_{version}",
    "piece length": piece_len,
    "pieces": bytes(pieces),
}

torrent_dict = {
    "announce": trackers[0],
    "announce-list": [[tr] for tr in trackers],
    "comment": f"iyou_home v{version} sovereign release",
    "created by": "iyou_home release automation",
    "creation date": int(time.time()),
    "info": info_dict,
}

info_bencoded = bencode(info_dict)
btih = hashlib.sha1(info_bencoded).hexdigest()

with open(torrent_path, "wb") as fh:
    fh.write(bencode(torrent_dict))

magnet = f"magnet:?xt=urn:btih:{btih}&dn=iyou-home_{version}"
for tr in trackers:
    magnet += f"&tr={urllib.parse.quote(tr, safe='')}"

print(f"BTIH={btih}")
print(f"MAGNET_LINK='{magnet}'")
PYEOF
)"
  log "BitTorrent Info Hash (BTIH): ${BTIH}"
  log "Magnet URI: ${MAGNET_LINK}"
else
  log "Warning: Python interpreter not found; skipping BitTorrent generation"
  BTIH="[NOT_GENERATED]"
  MAGNET_LINK="[NOT_GENERATED]"
fi

# 2. IPFS Root CID & Gateways
IPFS_ROOT_CID=""
if command -v ipfs >/dev/null 2>&1; then
  log "Computing deterministic IPFS root CID via local ipfs CLI..."
  IPFS_ROOT_CID="$(ipfs add -r -Q --only-hash "$RELEASE_DIR" 2>/dev/null || true)"
elif ssh -o BatchMode=yes -o ConnectTimeout=5 dc13 'export PATH="$PATH:/usr/local/bin"; which ipfs' >/dev/null 2>&1; then
  log "Computing deterministic IPFS root CID via runner dc13..."
  tar_flags=(--exclude='.DS_Store' --exclude='MIRRORS.txt')
  if tar --version 2>/dev/null | head -n1 | grep -qi bsdtar; then
    tar_flags+=(--no-xattrs)
  fi
  IPFS_ROOT_CID="$(tar "${tar_flags[@]}" -czf - -C "$RELEASE_DIR" . | ssh -o BatchMode=yes dc13 '
    export PATH="$PATH:/usr/local/bin"
    TMPDIR=$(mktemp -d)
    tar -xzf - -C "$TMPDIR"
    ipfs add -r -Q --only-hash "$TMPDIR" 2>/dev/null || true
    rm -rf "$TMPDIR"
  ')"
fi

if [[ -n "$IPFS_ROOT_CID" && "$IPFS_ROOT_CID" =~ ^Qm[1-9A-HJ-NP-Za-km-z]{44}|^bafy[a-z0-9]+ ]]; then
  IPFS_GATEWAY_URL="https://ipfs.io/ipfs/${IPFS_ROOT_CID}/"
  IPFS_ALT_GATEWAY_URL="https://dweb.link/ipfs/${IPFS_ROOT_CID}/"
  IPFS_NATIVE_URI="ipfs://${IPFS_ROOT_CID}/"
  log "IPFS Root CID: ${IPFS_ROOT_CID}"
  log "IPFS Gateway URL: ${IPFS_GATEWAY_URL}"
else
  IPFS_ROOT_CID="[PENDING_CLUSTER_PIN]"
  IPFS_GATEWAY_URL="[PENDING_CLUSTER_PIN]"
  IPFS_ALT_GATEWAY_URL="[PENDING_CLUSTER_PIN]"
  IPFS_NATIVE_URI="[PENDING_CLUSTER_PIN]"
  log "IPFS CLI not available locally or on runner dc13; marked [PENDING_CLUSTER_PIN]"
fi

# 3. Assemble MIRRORS.txt
cat << EOF > "$RELEASE_DIR/MIRRORS.txt"
RELEASE_VERSION=v${VERSION}
MAGNET_LINK=${MAGNET_LINK}
TORRENT_FILE=${TORRENT_FILE}
IPFS_ROOT_CID=${IPFS_ROOT_CID}
IPFS_GATEWAY_URL=${IPFS_GATEWAY_URL}
IPFS_ALT_GATEWAY_URL=${IPFS_ALT_GATEWAY_URL}
IPFS_NATIVE_URI=${IPFS_NATIVE_URI}
EOF

log "MIRRORS.txt:"
cat "$RELEASE_DIR/MIRRORS.txt"

if [[ "${SKIP_UPLOAD:-0}" == "1" ]]; then
  log "SKIP_UPLOAD=1 — staged assets only; not tagging or publishing."
  exit 0
fi

# ---------------------------------------------------------------- publish
log "Tagging and publishing v${VERSION} to ${REPO} (remote '${REMOTE}')"

git push "$REMOTE" HEAD
if ! git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null; then
  git tag "v${VERSION}"
  log "Created tag v${VERSION}"
fi
git push "$REMOTE" "refs/tags/v${VERSION}:refs/tags/v${VERSION}" || log "tag already present on remote"

notes="${RELEASE_NOTES:-Automated Sovereign Desktop Build}"
assets=(
  "$RELEASE_DIR/iyou-home_${VERSION}_amd64.deb"
  "$RELEASE_DIR/iyou-home_${VERSION}_amd64.AppImage"
  "$RELEASE_DIR/iyou-home_${VERSION}_x64.dmg"
  "$RELEASE_DIR/iyou-home_${VERSION}_x64-setup.exe"
  "$RELEASE_DIR"/iyou-home-*.rpm
  "$RELEASE_DIR/SHA256SUMS.txt"
  "$RELEASE_DIR/SHA256SUMS_LINUX.txt"
  "$RELEASE_DIR/SHA256SUMS_WINDOWS.txt"
  "$RELEASE_DIR/iyou-home_${VERSION}.torrent"
  "$RELEASE_DIR/MIRRORS.txt"
)
asset_args=()
for a in "${assets[@]}"; do
  [[ -f "$a" ]] && asset_args+=("$a")
done

if ! gh release create "v${VERSION}" "${asset_args[@]}" --repo "$REPO" --title "iyou_home v${VERSION}" --notes "$notes" 2>/dev/null; then
  log "Release v${VERSION} already exists — uploading and clobbering assets."
  gh release upload "v${VERSION}" "${asset_args[@]}" --repo "$REPO" --clobber
fi

if [[ "${SKIP_WINDOWS:-0}" != "1" ]]; then
  log "Triggering Windows NSIS build on GitHub Actions runner..."
  gh workflow run build-windows.yml --repo "$REPO" -f tag="v${VERSION}"
  log "Windows NSIS build dispatched (~9-10 min build time on windows-latest)."
  log "The .exe installer and SHA256SUMS_WINDOWS.txt will attach directly to release v${VERSION} upon completion."
else
  log "Skipping Windows build dispatch (SKIP_WINDOWS=1)"
fi

# ---------------------------------------------------------------- self-check
log "Verifying published asset URLs (expect 302/200, not 404)"
failed=0
for a in "${asset_args[@]}"; do
  name="$(basename "$a")"
  code="$(curl -sI -o /dev/null -w '%{http_code}' "https://github.com/$REPO/releases/download/v${VERSION}/${name}" || true)"
  if [[ "$code" != "302" && "$code" != "200" ]]; then
    printf '  [FAIL] %-40s HTTP %s\n' "$name" "$code"
    failed=1
  else
    printf '  [OK]   %-40s HTTP %s\n' "$name" "$code"
  fi
done

# Acknowledge Windows NSIS assets in self-check
win_exe="iyou-home_${VERSION}_x64-setup.exe"
win_code="$(curl -sI -o /dev/null -w '%{http_code}' "https://github.com/$REPO/releases/download/v${VERSION}/${win_exe}" || true)"
if [[ "$win_code" == "302" || "$win_code" == "200" ]]; then
  printf '  [OK]   %-40s HTTP %s\n' "$win_exe" "$win_code"
elif [[ "${SKIP_WINDOWS:-0}" != "1" ]]; then
  printf '  [ASYNC] %-40s (Compiling via GitHub Actions windows-latest runner...)\n' "$win_exe"
fi

win_sum="SHA256SUMS_WINDOWS.txt"
win_sum_code="$(curl -sI -o /dev/null -w '%{http_code}' "https://github.com/$REPO/releases/download/v${VERSION}/${win_sum}" || true)"
if [[ "$win_sum_code" == "302" || "$win_sum_code" == "200" ]]; then
  printf '  [OK]   %-40s HTTP %s\n' "$win_sum" "$win_sum_code"
elif [[ "${SKIP_WINDOWS:-0}" != "1" ]]; then
  printf '  [ASYNC] %-40s (Will attach with Windows .exe on completion)\n' "$win_sum"
fi

[[ "$failed" == "0" ]] || fail "one or more assets returned a non-200/302 status"
log "Release automation complete: https://github.com/$REPO/releases/tag/v${VERSION}"