#!/usr/bin/env bash
#
# iyou_home — One-Click Sovereign Release Pipeline
#
# Builds macOS (local) and Linux (remote dc13 runner) release bundles,
# triggers Windows NSIS installer compilation via GitHub Actions,
# stages them under release-artifacts/, computes SHA-256 sums, publishes a
# GitHub Release for tag "v${VERSION}", and self-checks the download URLs.
#
# Idempotent: safe to re-run when a release tag already exists (it will
# re-upload and clobber assets). Requires: gh CLI (authenticated), ssh dc13
# (runner reachable), node/npm, and the Tauri toolchain on the local machine.
#
# Env overrides:
#   SKIP_MAC=1      skip the local macOS build
#   SKIP_LINUX=1    skip the remote dc13 Linux build
#   SKIP_WINDOWS=1  skip the Windows NSIS GitHub Actions build dispatch
#   SKIP_UPLOAD=1   skip tagging + GitHub release publish (staging only)
#   RELEASE_NOTES   custom release notes text
#
set -euo pipefail

# ---------------------------------------------------------------- helpers
log()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\n[FATAL] %s\n' "$*" >&2; exit 1; }

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# Identify the GitHub remote that points at Code-Barn/iyou_home.
pick_release_remote() {
  for r in origin gh pushall; do
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

if [[ "${SKIP_LINUX:-0}" != "1" ]]; then
  ssh -o BatchMode=yes -o ConnectTimeout=15 dc13 "true" || fail "ssh dc13 unreachable"
fi

# ---------------------------------------------------------------- stage
log "Staging directory: ${RELEASE_DIR}"
rm -f "$RELEASE_DIR"/iyou-home_* "$RELEASE_DIR"/iyou-home-* "$RELEASE_DIR"/SHA256SUMS.txt

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
  ${HASH_TOOL} iyou-home_* > SHA256SUMS.txt
)
log "SHA256SUMS.txt:"
cat "$RELEASE_DIR/SHA256SUMS.txt"

if [[ "${SKIP_UPLOAD:-0}" == "1" ]]; then
  log "SKIP_UPLOAD=1 — staged assets only; not tagging or publishing."
  exit 0
fi

# ---------------------------------------------------------------- publish
log "Tagging and publishing v${VERSION} to ${REPO} (remote '${REMOTE}')"

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