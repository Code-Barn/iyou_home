#!/usr/bin/env bash
#
# iyou_home — One-Click Sovereign Release Pipeline
#
# Automatically bumps SemVer across all 5 manifests, commits the bump,
# builds macOS (local) and Linux (remote dc13 runner) release bundles,
# synchronizes with the GitHub Actions Windows CI runner (or downloads
# the fresh Windows NSIS .exe directly from the GitHub Release),
# gathers every platform bundle under release-artifacts/iyou_home_${VERSION}/,
# computes SHA-256 sums, wraps them in a BitTorrent .torrent + magnet URI
# (seeded via public trackers & optional seed box), publishes a GitHub Release
# for tag "v${VERSION}", and automatically patches the SHA-256 verification
# table in iyou_idp's _download_modal.html.
#
# Usage:
#   ./scripts/release.sh           # bump patch (default: 0.2.0 -> 0.2.1)
#   ./scripts/release.sh patch     # explicit patch bump
#   ./scripts/release.sh minor     # bump minor (0.2.0 -> 0.3.0)
#   ./scripts/release.sh major     # bump major (0.2.0 -> 1.0.0)
#   ./scripts/release.sh 0.3.5     # explicit target version
#   ./scripts/release.sh current   # build/publish current version without bumping
#   ./scripts/release.sh --current # alias for current (re-run after a failed release
#                                  # to package the already-bumped version)
#   ./scripts/release.sh --package-only  # no bump, no rebuilds; stage existing bundles
#                                  # (add --skip-build / --skip-bump as aliases)
#   ./scripts/release.sh --dry-run # test/evaluate commit alignment & preview modal updates
#   ./scripts/release.sh --sync-windows # download & verify Windows binary from GitHub CI,
#                                  # regenerate checksums/torrent, upload, and seed
#   ./scripts/release.sh --seed-qnap # seed release payload to QNAP NAS via SSH
#   ./scripts/release.sh --patch-idp    # compute SHA-256 sums and patch iyou_idp download modal
#   ./scripts/release.sh --no-wait-windows # trigger/skip waiting for Windows CI
#   ./scripts/release.sh --no-seed # skip seed-box rsync + transmission registration
#
# Idempotent: safe to re-run when a release tag already exists (it will
# re-upload and clobber assets). Requires: gh CLI (authenticated), ssh dc13
# (runner reachable), node/npm, and the Tauri toolchain on the local machine.
#
# Env overrides:
#   BUMP=patch|minor|major|current|X.Y.Z (alternative to CLI argument)
#   SKIP_MAC=1      skip the local macOS build
#   SKIP_LINUX=1    skip the remote dc13 Linux build
#   SKIP_WINDOWS=1  skip the Windows NSIS GitHub Actions build dispatch / sync
#   SKIP_UPLOAD=1   skip tagging + GitHub release publish (staging only)
#   RELEASE_NOTES   custom release notes text
#   RELEASE_REMOTE  target git remote (default: auto-detected)
#   WINDOWS_EXE     explicit path to a Windows NSIS .exe to stage into the payload
#   WINDOWS_STAGE_DIR directory scanned for a staged/downloaded Windows .exe
#   NO_WAIT_WINDOWS=1 dispatch Windows CI asynchronously without blocking/waiting
#   DRY_RUN=1       evaluate alignment and modal patch without mutations
#   IDP_PATH=DIR    path to iyou_idp repository (default: ../iyou_idp)
#   FORCE_PARTIAL_TORRENT=1  skip the missing-bundle prompt (partial payload ok)
#   PACKAGE_ONLY=1  no version bump and no rebuilds; stage existing bundles only
#   SEED_HOST       ssh target of the BitTorrent seed box (default: qnap)
#   SEED_DIR        remote directory holding release payloads (default: auto-detected or releases)
#   QNAP_TORRENT_DATA_DIR override target payload data directory on QNAP
#   QNAP_TORRENT_WATCH_DIR override target .torrent watch directory on QNAP
#   SKIP_SEED=1     skip rsync to the seed box and transmission-remote registration
#   REMOTE_TRANSMISSION_REMOTE=name|path  remote transmission-remote binary
#                   (default: transmission-remote; Entware /opt/bin fallback)
#
set -euo pipefail

# This script is non-interactive by contract (CI, pipes, `nohup` runs). Git
# defaults to a pager whenever stdout is a TTY, so a plain `git diff` blocks
# forever waiting for the operator to press `q`. Neutralize the pager globally;
# individual read-only inspection commands additionally pass `--no-pager` so
# they stay safe even if this guard is ever dropped.
export GIT_PAGER=cat
export PAGER=cat

# ---------------------------------------------------------------- helpers & tools
log()  { printf '\n==> %s\n' "$*"; }
warn() { printf '\n[WARN] %s\n' "$*" >&2; }
fail() { printf '\n[FATAL] %s\n' "$*" >&2; exit 1; }

# Checksum tooling
if command -v sha256sum >/dev/null 2>&1; then
  HASH_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH_TOOL="shasum -a 256"
else
  fail "no sha256sum/shasum tool found"
fi

# Python interpreter
PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# Locate iyou_idp _download_modal.html
find_idp_download_modal() {
  local candidate_dirs=(
    "${IDP_PATH:-}"
    "$ROOT/../iyou_idp"
    "../iyou_idp"
  )
  for base in "${candidate_dirs[@]}"; do
    [[ -n "$base" && -d "$base" ]] || continue
    local p1="$base/auth_bridge/templates/auth_bridge/_download_modal.html"
    local p2="$base/templates/auth_bridge/_download_modal.html"
    local p3="$base/templates/_download_modal.html"
    for p in "$p1" "$p2" "$p3"; do
      if [[ -f "$p" ]]; then
        printf '%s\n' "$p"
        return 0
      fi
    done
    local found
    found="$(find "$base" -name "_download_modal.html" -print -quit 2>/dev/null || true)"
    if [[ -n "$found" && -f "$found" ]]; then
      printf '%s\n' "$found"
      return 0
    fi
  done
  return 1
}

# Locate iyou_idp download_modal.js
find_idp_download_js() {
  local candidate_dirs=(
    "${IDP_PATH:-}"
    "$ROOT/../iyou_idp"
    "../iyou_idp"
  )
  for base in "${candidate_dirs[@]}"; do
    [[ -n "$base" && -d "$base" ]] || continue
    local p1="$base/auth_bridge/static/auth_bridge/js/download_modal.js"
    local p2="$base/static/auth_bridge/js/download_modal.js"
    for p in "$p1" "$p2"; do
      if [[ -f "$p" ]]; then
        printf '%s\n' "$p"
        return 0
      fi
    done
    local found
    found="$(find "$base" -name "download_modal.js" -print -quit 2>/dev/null || true)"
    if [[ -n "$found" && -f "$found" ]]; then
      printf '%s\n' "$found"
      return 0
    fi
  done
  return 1
}

# Compute primary artifact SHA-256 hashes: macOS (.dmg), Windows (.exe), Debian (.deb), AppImage
PRIMARY_WIN_SHA=""
PRIMARY_MAC_SHA=""
PRIMARY_DEB_SHA=""
PRIMARY_APP_SHA=""

compute_primary_hashes() {
  local win_file="$RELEASE_DIR/iyou-home_${VERSION}_x64-setup.exe"
  local mac_file="$RELEASE_DIR/iyou-home_${VERSION}_x64.dmg"
  local deb_file
  deb_file="$(find "$RELEASE_DIR" -maxdepth 1 \( -name "iyou-home_${VERSION}*.deb" -o -name "*_amd64.deb" \) 2>/dev/null | head -n1 || true)"
  local app_file
  app_file="$(find "$RELEASE_DIR" -maxdepth 1 \( -name "iyou-home_${VERSION}*.AppImage" -o -name "*_amd64.AppImage" \) 2>/dev/null | head -n1 || true)"

  PRIMARY_WIN_SHA=""
  PRIMARY_MAC_SHA=""
  PRIMARY_DEB_SHA=""
  PRIMARY_APP_SHA=""

  # 1. First check remote release metadata for verified digests
  local rel_json
  rel_json="$(gh release view "v${VERSION}" --repo "$REPO" --json assets 2>/dev/null || true)"
  local rel_win_digest="" rel_mac_digest="" rel_deb_digest="" rel_app_digest=""
  if [[ -n "$rel_json" ]]; then
    local remote_hashes
    remote_hashes="$($PYTHON_BIN -c '
import sys, json
data = json.loads(sys.argv[1])
h = {}
for a in data.get("assets", []):
    name = a.get("name", "")
    digest = a.get("digest", "")
    if digest.startswith("sha256:"):
        digest = digest[7:]
    if name.endswith("x64-setup.exe") or (name.endswith(".exe") and "setup" in name):
        h["win"] = digest
    elif name.endswith("x64.dmg"):
        h["mac"] = digest
    elif name.endswith(".deb"):
        h["deb"] = digest
w = h.get("win", "")
m = h.get("mac", "")
d = h.get("deb", "")
a = h.get("app", "")
print(f"{w}|{m}|{d}|{a}")
' "$rel_json" 2>/dev/null || true)"
    IFS='|' read -r rel_win_digest rel_mac_digest rel_deb_digest rel_app_digest <<< "$remote_hashes"
  fi

  # 2. Windows (.exe): On macOS, local builds cannot produce Windows binaries.
  # If remote release has a verified CI digest, verify local file or prioritize remote.
  if [[ -f "$win_file" ]]; then
    local local_win_sha
    local_win_sha="$(${HASH_TOOL} "$win_file" | awk '{print $1}')"
    if [[ -n "$rel_win_digest" && "$local_win_sha" != "$rel_win_digest" ]]; then
      warn "Local Windows .exe is STALE ($local_win_sha != remote $rel_win_digest). Using remote release SHA-256."
      PRIMARY_WIN_SHA="$rel_win_digest"
    else
      PRIMARY_WIN_SHA="$local_win_sha"
    fi
  elif [[ -n "$rel_win_digest" ]]; then
    PRIMARY_WIN_SHA="$rel_win_digest"
  elif [[ -f "$RELEASE_DIR/SHA256SUMS_WINDOWS.txt" ]]; then
    PRIMARY_WIN_SHA="$(awk '{print $1}' "$RELEASE_DIR/SHA256SUMS_WINDOWS.txt" | head -n1 || true)"
  fi

  # 3. macOS (.dmg)
  if [[ -f "$mac_file" ]]; then
    PRIMARY_MAC_SHA="$(${HASH_TOOL} "$mac_file" | awk '{print $1}')"
  elif [[ -n "$rel_mac_digest" ]]; then
    PRIMARY_MAC_SHA="$rel_mac_digest"
  fi

  # 4. Debian (.deb)
  if [[ -n "$deb_file" && -f "$deb_file" ]]; then
    PRIMARY_DEB_SHA="$(${HASH_TOOL} "$deb_file" | awk '{print $1}')"
  elif [[ -n "$rel_deb_digest" ]]; then
    PRIMARY_DEB_SHA="$rel_deb_digest"
  fi

  # 5. AppImage (.AppImage)
  if [[ -n "$app_file" && -f "$app_file" ]]; then
    PRIMARY_APP_SHA="$(${HASH_TOOL} "$app_file" | awk '{print $1}')"
  elif [[ -n "$rel_app_digest" ]]; then
    PRIMARY_APP_SHA="$rel_app_digest"
  fi
}

# Automate iyou_idp _download_modal.html & download_modal.js updates
auto_patch_idp() {
  log "Automating iyou_idp SHA-256 update in _download_modal.html and download_modal.js"
  local modal_file
  modal_file="$(find_idp_download_modal || true)"
  local js_file
  js_file="$(find_idp_download_js || true)"

  if [[ -z "$modal_file" || ! -f "$modal_file" ]]; then
    warn "Could not locate iyou_idp _download_modal.html (checked ../iyou_idp and IDP_PATH)."
    warn "Skipping automatic download modal patch."
    return 0
  fi

  log "Found download modal at: $modal_file"
  [[ -n "$js_file" ]] && log "Found download modal script at: $js_file"
  compute_primary_hashes

  log "Primary Artifact SHA-256 Hashes for v${VERSION}:"
  printf '  Windows (.exe) : %s\n' "${PRIMARY_WIN_SHA:-[NOT_FOUND]}"
  printf '  macOS (.dmg)    : %s\n' "${PRIMARY_MAC_SHA:-[NOT_FOUND]}"
  printf '  Debian (.deb)   : %s\n' "${PRIMARY_DEB_SHA:-[NOT_FOUND]}"
  printf '  AppImage        : %s\n' "${PRIMARY_APP_SHA:-[NOT_FOUND]}"

  if [[ -z "$PRIMARY_WIN_SHA" || -z "$PRIMARY_MAC_SHA" || -z "$PRIMARY_DEB_SHA" || -z "$PRIMARY_APP_SHA" ]]; then
    warn "One or more primary artifact hashes could not be resolved."
  fi

  [[ -n "$PYTHON_BIN" ]] || fail "Python interpreter is required to patch _download_modal.html"

  $PYTHON_BIN - "$modal_file" \
    "${PRIMARY_WIN_SHA:-}" \
    "${PRIMARY_MAC_SHA:-}" \
    "${PRIMARY_DEB_SHA:-}" \
    "${PRIMARY_APP_SHA:-}" \
    "${DRY_RUN:-0}" \
    "${VERSION}" \
    "${MAGNET_LINK:-}" \
    "${js_file:-}" << 'PYEOF'
import sys, os, re

modal_path = sys.argv[1]
win_sha = sys.argv[2].strip() if len(sys.argv) > 2 else ""
mac_sha = sys.argv[3].strip() if len(sys.argv) > 3 else ""
deb_sha = sys.argv[4].strip() if len(sys.argv) > 4 else ""
app_sha = sys.argv[5].strip() if len(sys.argv) > 5 else ""
dry_run = (sys.argv[6] == "1") if len(sys.argv) > 6 else False
version = sys.argv[7].strip() if len(sys.argv) > 7 else ""
magnet_uri = sys.argv[8].strip() if len(sys.argv) > 8 else ""
js_path = sys.argv[9].strip() if len(sys.argv) > 9 else ""

if not os.path.isfile(modal_path):
    sys.stderr.write(f"[ERROR] Modal file not found: {modal_path}\n")
    sys.exit(1)

with open(modal_path, "r", encoding="utf-8") as f:
    original_content = f.read()

targets = [
    ("Windows (.exe)", r"(<span[^>]*>Windows\s*\(\.exe\):</span>\s*<code[^>]*>)([a-fA-F0-9]{64})(</code>)", win_sha),
    ("macOS (.dmg)",    r"(<span[^>]*>macOS\s*\(\.dmg\):</span>\s*<code[^>]*>)([a-fA-F0-9]{64})(</code>)", mac_sha),
    ("Debian (.deb)",   r"(<span[^>]*>Debian\s*\(\.deb\):</span>\s*<code[^>]*>)([a-fA-F0-9]{64})(</code>)", deb_sha),
    ("AppImage",        r"(<span[^>]*>AppImage:</span>\s*<code[^>]*>)([a-fA-F0-9]{64})(</code>)", app_sha),
]

print(f"\n--- Checking iyou_idp SHA-256 Table: {modal_path} ---")
updated_content = original_content
changes_needed = 0

for label, pattern, new_hash in targets:
    m = re.search(pattern, updated_content)
    if not m:
        sys.stderr.write(f"[ERROR] Could not find row matching '{label}' in {modal_path}\n")
        sys.exit(1)
    old_hash = m.group(2)
    if not new_hash:
        print(f"  {label:<15} : Current = {old_hash} (No new hash provided)")
        continue
    if not re.match(r"^[a-fA-F0-9]{64}$", new_hash):
        sys.stderr.write(f"[ERROR] Invalid 64-char hex hash for {label}: '{new_hash}'\n")
        sys.exit(1)
    if old_hash == new_hash:
        print(f"  {label:<15} : [OK] {new_hash} (Already up-to-date)")
    else:
        print(f"  {label:<15} : [UPDATE] {old_hash} -> {new_hash}")
        changes_needed += 1
        updated_content = re.sub(pattern, rf"\g<1>{new_hash}\g<3>", updated_content)

if magnet_uri and "magnet:?xt=urn:btih:" in magnet_uri and not magnet_uri.startswith("["):
    m_escaped = magnet_uri.replace("&", "&amp;")
    magnet_pat = r'(<a\s+id="dl-magnet"\s+href=")[^"]*(")'
    if re.search(magnet_pat, updated_content):
        updated_content = re.sub(magnet_pat, rf"\g<1>{m_escaped}\g<2>", updated_content)
        print("  Magnet link     : [UPDATED] with new release magnet URI")

if dry_run:
    print(f"\n[DRY-RUN] {changes_needed} hash field(s) would be updated in {modal_path}.")
else:
    if changes_needed > 0 or (magnet_uri and updated_content != original_content):
        tmp_path = modal_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(updated_content)
        os.replace(tmp_path, modal_path)
        with open(modal_path, "r", encoding="utf-8") as f:
            verify_content = f.read()
        for label, pattern, new_hash in targets:
            if new_hash:
                assert new_hash in verify_content, f"Verification failed for {label}"
        print(f"\n[OK] Successfully patched {changes_needed} hash(es) into {modal_path} (atomic replace).")
    else:
        print(f"\n[OK] All hashes in {modal_path} are already up-to-date. No write needed.")

# Also update download_modal.js MAGNET_FALLBACK_URI if js_path is present
if js_path and os.path.isfile(js_path) and magnet_uri and "magnet:?xt=urn:btih:" in magnet_uri and not magnet_uri.startswith("["):
    with open(js_path, "r", encoding="utf-8") as f:
        js_content = f.read()
    js_pat = r"(var\s+MAGNET_FALLBACK_URI\s*=\s*')[^']+(';)"
    if re.search(js_pat, js_content):
        updated_js = re.sub(js_pat, rf"\g<1>{magnet_uri}\g<2>", js_content)
        if updated_js != js_content:
            if not dry_run:
                tmp_js = js_path + ".tmp"
                with open(tmp_js, "w", encoding="utf-8") as f:
                    f.write(updated_js)
                os.replace(tmp_js, js_path)
                print(f"[OK] Patched MAGNET_FALLBACK_URI in {js_path}")
            else:
                print(f"[DRY-RUN] Would patch MAGNET_FALLBACK_URI in {js_path}")
        else:
            print(f"[OK] MAGNET_FALLBACK_URI in {js_path} is already up-to-date.")
PYEOF

  # If git repo exists in ../iyou_idp, display git diff.
  # `--no-pager` is essential: this script runs non-interactively (CI, pipes,
  # subshells), and a default-pager `git diff` blocks forever waiting for the
  # operator to press `q`.
  if [[ -d "$ROOT/../iyou_idp/.git" && "${DRY_RUN:-0}" != "1" ]]; then
    log "Git diff in iyou_idp:"
    git -C "$ROOT/../iyou_idp" --no-pager diff -U1 "$modal_file" ${js_file:+"$js_file"} || true
  fi
}

# Inspect and evaluate remote Windows CI runs and release status
check_remote_windows_status() {
  local target_tag="v${VERSION}"
  local head_commit
  head_commit="$(git rev-parse HEAD 2>/dev/null || true)"
  local tag_commit
  tag_commit="$(git rev-parse -q --verify "refs/tags/${target_tag}^{commit}" 2>/dev/null || git rev-parse -q --verify "${target_tag}^{commit}" 2>/dev/null || true)"

  log "Windows CI Alignment Check (Target: ${target_tag})"
  printf '  Local HEAD commit  : %s\n' "${head_commit}"
  printf '  Target Tag commit  : %s\n' "${tag_commit:-[tag not present locally]}"

  # Check remote GitHub release
  local release_json
  release_json="$(gh release view "$target_tag" --repo "$REPO" --json tagName,targetCommitish,assets,createdAt,publishedAt 2>/dev/null || true)"
  local rel_win_digest=""
  if [[ -n "$release_json" ]]; then
    rel_win_digest="$($PYTHON_BIN -c '
import sys, json
data = json.loads(sys.argv[1])
for a in data.get("assets", []):
    name = a.get("name", "")
    digest = a.get("digest", "")
    if digest.startswith("sha256:"):
        digest = digest[7:]
    if name.endswith("x64-setup.exe") or (name.endswith(".exe") and "setup" in name):
        print(digest)
        sys.exit(0)
sys.exit(1)
' "$release_json" 2>/dev/null || true)"
    printf '  Remote Release     : Present (Tag: %s)\n' "$target_tag"
    if [[ -n "$rel_win_digest" ]]; then
      printf '  Remote Windows .exe: Present (SHA-256: %s)\n' "$rel_win_digest"
    else
      printf '  Remote Windows .exe: Missing from release assets\n'
    fi
  else
    printf '  Remote Release     : Tag %s not created yet on GitHub\n' "$target_tag"
  fi

  # Check GitHub Actions runs for build-windows.yml
  local runs_json
  runs_json="$(gh run list --workflow build-windows.yml --repo "$REPO" -L 10 --json databaseId,headSha,event,headBranch,status,conclusion,createdAt,url 2>/dev/null || echo "[]")"

  $PYTHON_BIN - "$runs_json" "$target_tag" "${tag_commit:-}" "$head_commit" "$rel_win_digest" "$ROOT" "$VERSION" << 'PYEOF'
import sys, json, os

runs = json.loads(sys.argv[1])
target_tag = sys.argv[2]
tag_commit = sys.argv[3]
head_commit = sys.argv[4]
rel_win_digest = sys.argv[5]
root_dir = sys.argv[6]
version = sys.argv[7]

print(f"\n  GitHub Actions Workflow: build-windows.yml (Recent Runs: {len(runs)})")
matched_run = None
for r in runs:
    branch = r.get("headBranch") or ""
    sha = r.get("headSha") or ""
    match_tag = (branch == target_tag)
    match_tag_sha = bool(tag_commit and sha.startswith(tag_commit))
    match_head_sha = bool(head_commit and sha.startswith(head_commit))
    
    if match_tag or match_tag_sha or match_head_sha:
        if not matched_run:
            matched_run = r
    
    star = "*" if (matched_run and matched_run["databaseId"] == r["databaseId"]) else " "
    print(f"  {star} Run {r['databaseId']}: event={r.get('event')} branch={branch} status={r.get('status')} conclusion={r.get('conclusion')} commit={sha[:7]} (match_tag={match_tag}, match_tag_sha={match_tag_sha}, match_head_sha={match_head_sha})")

if matched_run:
    sha = matched_run.get("headSha", "")[:7]
    print(f"\n  [ALIGNMENT] Active Windows Run ID: {matched_run['databaseId']}")
    print(f"              Status={matched_run.get('status')} Conclusion={matched_run.get('conclusion')} Commit={sha}")
    if matched_run.get("status") == "completed" and matched_run.get("conclusion") == "success":
        print(f"              [OK] Remote Windows executable matches target tag/commit.")
    elif matched_run.get("status") in ("in_progress", "queued"):
        print(f"              [WAIT] Windows executable is CURRENTLY COMPILING on GitHub Actions.")
    else:
        print(f"              [WARN] Windows build concluded with: {matched_run.get('conclusion')}")
else:
    print(f"\n  [ALIGNMENT] No GitHub Actions run found matching tag '{target_tag}' or commit '{head_commit[:7]}'.")

# Local cache inspection
local_cache = os.path.join(root_dir, "release-artifacts", "windows", f"iyou-home_{version}_x64-setup.exe")
if os.path.isfile(local_cache):
    import hashlib
    with open(local_cache, "rb") as fh:
        local_hash = hashlib.sha256(fh.read()).hexdigest()
    print(f"\n  Local Windows Cache : {local_cache}")
    print(f"  Local Cache SHA-256 : {local_hash}")
    if rel_win_digest:
        if local_hash == rel_win_digest:
            print("  Local vs Remote     : [MATCH] Local cached .exe matches remote release.")
        else:
            print("  Local vs Remote     : [STALE DETECTED] Local cached .exe is STALE and will be updated from remote release.")
else:
    print(f"\n  Local Windows Cache : None present at {local_cache}")
PYEOF
}

# Synchronize Windows NSIS installer from GitHub Actions CI
sync_windows_exe() {
  log "Synchronizing Windows NSIS installer from GitHub Actions CI"

  local is_darwin=0
  if [[ "$(uname -s)" == "Darwin" ]]; then
    is_darwin=1
    log "Platform: macOS Darwin (local NSIS cross-compilation is disabled/unsupported)."
    log "Windows .exe is strictly compiled via GitHub Actions windows-latest runner."
  fi

  # 1. User provided explicit WINDOWS_EXE override
  if [[ -n "${WINDOWS_EXE:-}" ]]; then
    if [[ -f "$WINDOWS_EXE" ]]; then
      log "Using explicitly provided WINDOWS_EXE: $WINDOWS_EXE"
      mkdir -p "$RELEASE_DIR"
      cp "$WINDOWS_EXE" "$RELEASE_DIR/iyou-home_${VERSION}_x64-setup.exe"
      return 0
    else
      fail "WINDOWS_EXE was set to '$WINDOWS_EXE' but file does not exist"
    fi
  fi

  # Flag stale local paths if present
  local stale_local=""
  for search_dir in \
    "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis" \
    "src-tauri/target/release/bundle/nsis"; do
    if [[ -d "$search_dir" ]]; then
      stale_local="$(find "$search_dir" -maxdepth 1 -type f -name '*.exe' -print -quit 2>/dev/null || true)"
      if [[ -n "$stale_local" ]]; then
        warn "Found local binary at $stale_local. On macOS, this local binary is STALE and will not be used."
      fi
    fi
  done

  # Run alignment and status check
  check_remote_windows_status

  local target_tag="v${VERSION}"
  local head_commit
  head_commit="$(git rev-parse HEAD 2>/dev/null || true)"
  local tag_commit
  tag_commit="$(git rev-parse -q --verify "refs/tags/${target_tag}^{commit}" 2>/dev/null || git rev-parse -q --verify "${target_tag}^{commit}" 2>/dev/null || true)"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "[DRY-RUN] Skipping remote workflow dispatch and asset download."
    return 0
  fi

  # Check if remote release already has .exe
  local release_json
  release_json="$(gh release view "$target_tag" --repo "$REPO" --json tagName,targetCommitish,assets 2>/dev/null || true)"
  local has_remote_exe=0
  if [[ -n "$release_json" ]]; then
    if echo "$release_json" | grep -q "x64-setup.exe"; then
      has_remote_exe=1
    fi
  fi

  # Check recent runs
  local runs_json
  runs_json="$(gh run list --workflow build-windows.yml --repo "$REPO" -L 10 --json databaseId,headSha,event,headBranch,status,conclusion,createdAt 2>/dev/null || echo "[]")"

  local eval_result
  eval_result="$($PYTHON_BIN -c '
import sys, json
runs = json.loads(sys.argv[1])
target_tag = sys.argv[2]
tag_commit = sys.argv[3]
head_commit = sys.argv[4]

run_id = ""
run_status = ""
run_conclusion = ""
run_matches = False

for r in runs:
    branch = r.get("headBranch") or ""
    sha = r.get("headSha") or ""
    if branch == target_tag or (tag_commit and sha.startswith(tag_commit)) or (head_commit and sha.startswith(head_commit)):
        run_id = str(r.get("databaseId"))
        run_status = r.get("status") or ""
        run_conclusion = r.get("conclusion") or ""
        run_matches = True
        break

print(f"{run_id}|{run_status}|{run_conclusion}|{1 if run_matches else 0}")
' "$runs_json" "$target_tag" "${tag_commit:-}" "$head_commit" 2>/dev/null || echo "|||0")"

  IFS='|' read -r run_id run_status run_conclusion run_matches <<< "$eval_result"

  # Need to await or dispatch?
  if [[ "$has_remote_exe" == "1" && "$run_matches" == "1" && "$run_status" == "completed" && "$run_conclusion" == "success" ]]; then
    log "[OK] Verified Windows NSIS installer is already attached to release '${target_tag}'."
  elif [[ "$run_status" == "in_progress" || "$run_status" == "queued" ]]; then
    if [[ "${NO_WAIT_WINDOWS:-0}" == "1" ]]; then
      warn "NO_WAIT_WINDOWS=1 — Windows build $run_id is currently $run_status. Proceeding without waiting."
      return 0
    else
      log "Awaiting in-progress Windows build on GitHub Actions (Run ID: $run_id)..."
      gh run watch "$run_id" --repo "$REPO" --exit-status || fail "GitHub Actions Windows build (Run ID: $run_id) failed!"
      log "[OK] Windows build finished successfully."
    fi
  else
    # Check if release exists on remote before dispatching
    if [[ -z "$release_json" ]]; then
      log "Release '${target_tag}' does not exist on remote yet."
      log "GitHub Actions build-windows.yml requires the release to exist to attach the .exe."
      log "Mac and Linux will be staged & published first, then Windows build will be triggered and awaited."
      return 0
    fi

    log "Triggering Windows NSIS build on GitHub Actions runner for tag '${target_tag}'..."
    gh workflow run build-windows.yml --repo "$REPO" -f tag="${target_tag}"
    log "Windows NSIS build dispatched (~9-10 min build time on windows-latest)."

    if [[ "${NO_WAIT_WINDOWS:-0}" == "1" ]]; then
      warn "NO_WAIT_WINDOWS=1 — Dispatched Windows build. Proceeding without waiting."
      return 0
    fi

    log "Waiting for new GitHub Actions run to register..."
    local new_run_id=""
    for i in {1..15}; do
      sleep 3
      new_run_id="$(gh run list --workflow build-windows.yml --repo "$REPO" -L 3 --json databaseId,createdAt --jq '.[0].databaseId' 2>/dev/null || true)"
      if [[ -n "$new_run_id" && "$new_run_id" != "$run_id" ]]; then
        break
      fi
    done

    if [[ -n "$new_run_id" && "$new_run_id" != "$run_id" ]]; then
      log "Watching Windows build on GitHub Actions (Run ID: $new_run_id)..."
      gh run watch "$new_run_id" --repo "$REPO" --exit-status || fail "GitHub Actions Windows build ($new_run_id) failed!"
      log "[OK] Windows build completed successfully."
    else
      log "Polling release view for Windows .exe asset..."
      local attempts=0
      while (( attempts < 120 )); do
        sleep 10
        (( attempts++ ))
        if gh release view "$target_tag" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null | grep -q "x64-setup.exe"; then
          log "[OK] Windows installer detected on release '${target_tag}'."
          break
        fi
      done
    fi
  fi

  # Download fresh .exe and SHA256SUMS_WINDOWS.txt from GitHub release
  mkdir -p "$RELEASE_DIR"
  local win_exe_name="iyou-home_${VERSION}_x64-setup.exe"
  log "Downloading fresh Windows installer from GitHub release '${target_tag}'..."
  gh release download "$target_tag" --repo "$REPO" --pattern "*x64-setup.exe" --dir "$RELEASE_DIR" --clobber
  gh release download "$target_tag" --repo "$REPO" --pattern "SHA256SUMS_WINDOWS.txt" --dir "$RELEASE_DIR" --clobber 2>/dev/null || true

  # Normalize filename if needed
  if [[ ! -f "$RELEASE_DIR/$win_exe_name" ]]; then
    local dl_exe
    dl_exe="$(find "$RELEASE_DIR" -maxdepth 1 -type f -name '*.exe' -print -quit 2>/dev/null || true)"
    if [[ -n "$dl_exe" && -f "$dl_exe" ]]; then
      mv "$dl_exe" "$RELEASE_DIR/$win_exe_name"
    else
      fail "Failed to locate downloaded Windows .exe in $RELEASE_DIR"
    fi
  fi

  local win_sha
  win_sha="$(${HASH_TOOL} "$RELEASE_DIR/$win_exe_name" | awk '{print $1}')"
  log "Windows installer staged : $RELEASE_DIR/$win_exe_name"
  log "Windows installer SHA-256: $win_sha"

  if [[ -f "$RELEASE_DIR/SHA256SUMS_WINDOWS.txt" ]]; then
    local expected_win_sha
    expected_win_sha="$(awk '{print $1}' "$RELEASE_DIR/SHA256SUMS_WINDOWS.txt" | head -n1)"
    if [[ -n "$expected_win_sha" ]]; then
      if [[ "$win_sha" != "$expected_win_sha" ]]; then
        fail "Integrity check failed: Downloaded Windows .exe SHA-256 ($win_sha) does not match SHA256SUMS_WINDOWS.txt ($expected_win_sha)!"
      else
        log "[OK] Verified Windows .exe matches remote SHA256SUMS_WINDOWS.txt"
      fi
    fi
  fi

  # Cache fresh binary to $ROOT/release-artifacts/windows/
  mkdir -p "$ROOT/release-artifacts/windows"
  cp "$RELEASE_DIR/$win_exe_name" "$ROOT/release-artifacts/windows/$win_exe_name"
  log "Updated local Windows cache at $ROOT/release-artifacts/windows/$win_exe_name"
}

# Fallback find_windows_exe respecting macOS invariants
find_windows_exe() {
  if [[ -n "${WINDOWS_EXE:-}" && -f "$WINDOWS_EXE" ]]; then
    printf '%s\n' "$WINDOWS_EXE"
    return 0
  fi
  # If on Darwin (macOS), warn that local build directories are invalid
  if [[ "$(uname -s)" == "Darwin" ]]; then
    warn "Running on macOS: local src-tauri NSIS directories are not applicable."
  fi
  local search_dir exe
  for search_dir in \
    "${WINDOWS_STAGE_DIR:-}" \
    "$ROOT/release-artifacts/windows"; do
    [[ -n "$search_dir" && -d "$search_dir" ]] || continue
    exe="$(find "$search_dir" -maxdepth 1 -type f -name '*.exe' -print -quit 2>/dev/null || true)"
    if [[ -n "$exe" ]]; then
      printf '%s\n' "$exe"
      return 0
    fi
  done
  return 1
}

# Generate master SHA256SUMS.txt from staged files in $RELEASE_DIR
generate_checksums() {
  log "Generating master SHA256SUMS.txt"
  (
    cd "$RELEASE_DIR"
    shopt -s nullglob
    staged_files=(iyou-home_* iyou-home-*)
    hash_targets=()
    for f in "${staged_files[@]}"; do
      [[ "$f" == *.torrent || "$f" == *.txt ]] && continue
      [[ -f "$f" ]] && hash_targets+=("$f")
    done
    if (( ${#hash_targets[@]} > 0 )); then
      ${HASH_TOOL} "${hash_targets[@]}" > SHA256SUMS.txt
      log "SHA256SUMS.txt generated:"
      cat "$RELEASE_DIR/SHA256SUMS.txt"
    else
      warn "No staged bundles found under ${RELEASE_DIR}."
    fi
  )
  compute_primary_hashes
}

# Generate BitTorrent metainfo (.torrent) and IPFS mirror manifests (MIRRORS.txt)
generate_bittorrent_and_mirrors() {
  log "Generating BitTorrent metainfo and IPFS mirror manifests"
  TORRENT_FILE="iyou-home_${VERSION}.torrent"
  TORRENT_PATH="$RELEASE_DIR/$TORRENT_FILE"

  if [[ -n "$PYTHON_BIN" ]]; then
    log "Generating BitTorrent metainfo using $PYTHON_BIN (bencode engine)..."
    eval "$($PYTHON_BIN - "$RELEASE_DIR" "$VERSION" "$REPO" << 'PYEOF'
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
repo = sys.argv[3] if len(sys.argv) > 3 else "Code-Barn/iyou_home"
torrent_name = f"iyou-home_{version}.torrent"
torrent_path = os.path.join(release_dir, torrent_name)
web_seed_url = f"https://github.com/{repo}/releases/download/v{version}/"

trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.torrent.eu.org:451/announce"
]

files = []
if os.path.isdir(release_dir):
    for f in sorted(os.listdir(release_dir)):
        full = os.path.join(release_dir, f)
        if os.path.isfile(full):
            if (f.startswith(('iyou-home_', 'iyou-home-')) and not f.endswith(('.torrent', '.txt'))) or f.endswith(('.deb', '.AppImage', '.dmg', '.exe', '.rpm')):
                files.append(f)

if not files:
    btih = "0" * 40
    magnet = f"magnet:?xt=urn:btih:{btih}&dn=iyou-home_{version}"
    for tr in trackers:
        magnet += f"&tr={urllib.parse.quote(tr, safe='')}"
    magnet += f"&ws={urllib.parse.quote(web_seed_url, safe='')}"
    print(f"BTIH={btih}")
    print(f"MAGNET_LINK='{magnet}'")
    print(f"WEB_SEED_URL='{web_seed_url}'")
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
    "url-list": [web_seed_url],
}

info_bencoded = bencode(info_dict)
btih = hashlib.sha1(info_bencoded).hexdigest()

with open(torrent_path, "wb") as fh:
    fh.write(bencode(torrent_dict))

magnet = f"magnet:?xt=urn:btih:{btih}&dn=iyou-home_{version}"
for tr in trackers:
    magnet += f"&tr={urllib.parse.quote(tr, safe='')}"
magnet += f"&ws={urllib.parse.quote(web_seed_url, safe='')}"

print(f"BTIH={btih}")
print(f"MAGNET_LINK='{magnet}'")
print(f"WEB_SEED_URL='{web_seed_url}'")
PYEOF
)"
    log "BitTorrent Info Hash (BTIH): ${BTIH}"
    log "Magnet URI: ${MAGNET_LINK}"
    log "BEP 19 Web Seed URL: ${WEB_SEED_URL}"
  else
    warn "Python interpreter not found; skipping BitTorrent generation"
    BTIH="[NOT_GENERATED]"
    MAGNET_LINK="[NOT_GENERATED]"
    WEB_SEED_URL="[NOT_GENERATED]"
  fi

  # IPFS Root CID & Gateways
  IPFS_ROOT_CID=""
  if command -v ipfs >/dev/null 2>&1; then
    log "Computing deterministic IPFS root CID via local ipfs CLI..."
    IPFS_ROOT_CID="$(ipfs add -r -Q --only-hash "$RELEASE_DIR" 2>/dev/null || true)"
  elif ssh -o BatchMode=yes -o ConnectTimeout=5 dc13 'export PATH="$PATH:/usr/local/bin"; which ipfs' >/dev/null 2>&1; then
    log "Computing deterministic IPFS root CID via runner dc13..."
    local tar_flags=(--exclude='.DS_Store' --exclude='MIRRORS.txt')
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

  # Assemble MIRRORS.txt
  cat << EOF > "$RELEASE_DIR/MIRRORS.txt"
RELEASE_VERSION=v${VERSION}
MAGNET_LINK=${MAGNET_LINK}
TORRENT_FILE=${TORRENT_FILE}
WEB_SEED_URL=${WEB_SEED_URL:-https://github.com/${REPO}/releases/download/v${VERSION}/}
IPFS_ROOT_CID=${IPFS_ROOT_CID}
IPFS_GATEWAY_URL=${IPFS_GATEWAY_URL}
IPFS_ALT_GATEWAY_URL=${IPFS_ALT_GATEWAY_URL}
IPFS_NATIVE_URI=${IPFS_NATIVE_URI}
EOF

  log "MIRRORS.txt:"
  cat "$RELEASE_DIR/MIRRORS.txt"
}

# Upload final verified release assets to GitHub Release
FINAL_RELEASE_ASSETS=()
publish_release_assets() {
  local final_candidates=(
    "$RELEASE_DIR/iyou-home_${VERSION}_amd64.deb"
    "$RELEASE_DIR/iyou-home_${VERSION}_amd64.AppImage"
    "$RELEASE_DIR/iyou-home_${VERSION}_x64.dmg"
    "$RELEASE_DIR/iyou-home_${VERSION}_x64-setup.exe"
    "$RELEASE_DIR"/iyou-home-*.rpm
    "$RELEASE_DIR/SHA256SUMS.txt"
    "$RELEASE_DIR/SHA256SUMS_WINDOWS.txt"
    "$RELEASE_DIR/iyou-home_${VERSION}.torrent"
    "$RELEASE_DIR/MIRRORS.txt"
  )
  FINAL_RELEASE_ASSETS=()
  for a in "${final_candidates[@]}"; do
    [[ -f "$a" ]] && FINAL_RELEASE_ASSETS+=("$a")
  done

  if [[ "${SKIP_UPLOAD:-0}" == "1" ]]; then
    log "SKIP_UPLOAD=1 — staged assets only; not tagging or uploading final assets."
    return 0
  fi
  log "Uploading final verified assets to release v${VERSION} on ${REPO}"
  gh release upload "v${VERSION}" "${FINAL_RELEASE_ASSETS[@]}" --repo "$REPO" --clobber

  # The body is the only channel mirror clients actually read, so keep it in
  # sync on every publish, not just on first release creation.
  sync_release_p2p_body
}

# Build the "P2P & Decentralized Mirrors" markdown block for the release body.
#
# This mirrors the MIRRORS.txt written by generate_bittorrent_and_mirrors(),
# which is why a complete manifest can be embedded even when MIRRORS.txt is not
# present in the payload tree at publish time. Every field uses a `:-` default
# because `set -u` is active and the BitTorrent/IPFS stages are each allowed to
# be skipped, leaving their variables unset.
#
# Backticks are backslash-escaped: the heredoc delimiter is unquoted so the
# shell variables expand, which would otherwise trigger command substitution.
build_p2p_mirror_block() {
  cat <<EOF

### P2P & Decentralized Mirrors
- **Magnet URI**: \`${MAGNET_LINK:-[NOT_GENERATED]}\`
- **IPFS Gateway**: ${IPFS_GATEWAY_URL:-[NOT_GENERATED]}
- **IPFS CID**: \`${IPFS_ROOT_CID:-[NOT_GENERATED]}\`

<details><summary>Full P2P manifest (MIRRORS.txt)</summary>

\`\`\`
RELEASE_VERSION=v${VERSION}
MAGNET_LINK=${MAGNET_LINK:-[NOT_GENERATED]}
TORRENT_FILE=${TORRENT_FILE:-iyou-home_${VERSION}.torrent}
IPFS_ROOT_CID=${IPFS_ROOT_CID:-[NOT_GENERATED]}
IPFS_GATEWAY_URL=${IPFS_GATEWAY_URL:-[NOT_GENERATED]}
IPFS_ALT_GATEWAY_URL=${IPFS_ALT_GATEWAY_URL:-}
IPFS_NATIVE_URI=${IPFS_NATIVE_URI:-}
WEB_SEED_URL=${WEB_SEED_URL:-}
\`\`\`

</details>
EOF
}

# Ensure the GitHub Release body exposes the P2P mirror metadata.
#
# Why the body and not just an asset: download_modal.js in the web satellites
# reads `release.body` from GitHub's CORS-friendly `releases/latest` endpoint
# and parses the magnet link out of it. A magnet published only as a
# MIRRORS.txt/torrent *asset* is invisible to that client, so `releases/latest`
# would advertise no way to reach the P2P mirrors at all.
#
# This is required on the "release already exists" path, which is the normal
# case: .github/workflows/release.yml uses softprops/action-gh-release@v2 on tag
# push, so the release (and its auto-generated body) is created by CI before this
# script runs. Without the sync, the magnet would essentially never be embedded.
#
# Appends to the existing body rather than replacing it, so maintainer-written
# release notes survive, and is idempotent so re-runs never duplicate the block.
sync_release_p2p_body() {
  local tag="v${VERSION}"
  local existing_body magnet block

  magnet="${MAGNET_LINK:-}"
  if [[ -z "${magnet}" || "${magnet}" == "[NOT_GENERATED]" ]]; then
    warn "MAGNET_LINK is unavailable — cannot embed P2P metadata in ${tag} body"
    return 0
  fi

  existing_body="$(gh release view "${tag}" --repo "${REPO}" --json body --jq '.body' 2>/dev/null || true)"

  if grep -qF -- "${magnet}" <<<"${existing_body}"; then
    log "P2P mirror metadata already present in ${tag} body — nothing to do"
    return 0
  fi

  block="$(build_p2p_mirror_block)"
  log "Embedding P2P & decentralized mirror metadata into ${tag} release body..."
  if [[ -n "${existing_body}" ]]; then
    gh release edit "${tag}" --repo "${REPO}" --notes "${existing_body}${block}" \
      || warn "Failed to update ${tag} release body — magnet link absent from releases/latest"
  else
    gh release edit "${tag}" --repo "${REPO}" --notes "${block}" \
      || warn "Failed to set ${tag} release body — magnet link absent from releases/latest"
  fi
}

# Automate BitTorrent seeding on QNAP NAS
seed_qnap_torrent() {
  log "Automating BitTorrent seeding on QNAP NAS (${SEED_HOST})"

  if [[ "${SKIP_SEED:-0}" == "1" || "${SKIP_SEED:-}" =~ ^[tT][rR][uU][eE]$ ]]; then
    log "Skipping QNAP torrent seeding (SKIP_SEED=1 / --skip-seed)."
    SEED_STATUS="skipped (SKIP_SEED=1)"
    return 0
  fi

  # Check SSH connectivity to QNAP in batch mode with short timeout
  if ! ssh -q -o ConnectTimeout=3 -o BatchMode=yes "$SEED_HOST" exit 2>/dev/null; then
    warn "Cannot connect via SSH to '$SEED_HOST' (BatchMode failed or host unreachable)."
    warn "Skipping QNAP seeding. To debug: ssh $SEED_HOST"
    SEED_STATUS="skipped (SSH to $SEED_HOST unreachable)"
    return 0
  fi

  log "Connected to $SEED_HOST via SSH. Detecting active torrent client and directories..."

  # Run remote client detection on QNAP
  local detect_script='
export PATH="/opt/bin:/opt/sbin:/usr/local/bin:/usr/bin:/bin:$PATH"

OVERRIDE_DATA="'"${QNAP_TORRENT_DATA_DIR:-}"'"
OVERRIDE_WATCH="'"${QNAP_TORRENT_WATCH_DIR:-}"'"

ENGINE=""
DATA_DIR=""
WATCH_DIR=""
TR_REMOTE=""
QBT_CLI=""

# 1. Inspect Transmission Daemon
if ps | grep -v grep | grep -q "transmission-daemon"; then
  ENGINE="transmission"
  TR_REMOTE=$(command -v transmission-remote 2>/dev/null || echo "/opt/bin/transmission-remote")
  ps_cmd=$(ps | grep -v grep | grep "transmission-daemon" | head -n1)
  if echo "$ps_cmd" | grep -q -- "-w "; then
    DATA_DIR=$(echo "$ps_cmd" | sed -n "s/.*-w \([^ ]*\).*/\1/p")
  fi
  if echo "$ps_cmd" | grep -q -- "-c "; then
    WATCH_DIR=$(echo "$ps_cmd" | sed -n "s/.*-c \([^ ]*\).*/\1/p")
  fi
  if [ -z "$DATA_DIR" ] && [ -x "$TR_REMOTE" ]; then
    DATA_DIR=$("$TR_REMOTE" -si 2>/dev/null | grep -i "Download directory:" | awk -F": " "{print \$2}" | xargs)
  fi
  if [ -z "$WATCH_DIR" ] && [ -n "$DATA_DIR" ] && [ -d "$DATA_DIR/watch" ]; then
    WATCH_DIR="$DATA_DIR/watch"
  fi
fi

# 2. Inspect qBittorrent
if [ -z "$ENGINE" ] && ps | grep -v grep | grep -q "qbittorrent"; then
  ENGINE="qbittorrent"
  QBT_CLI=$(command -v qbittorrent-cli 2>/dev/null || true)
  for q_data in "/share/Download/qbittorrent" "/share/CACHEDEV1_DATA/Download/qbittorrent"; do
    if [ -d "$q_data" ]; then DATA_DIR="$q_data"; break; fi
  done
  for q_watch in "/share/Download/watch" "/share/Download/qbittorrent/watch"; do
    if [ -d "$q_watch" ]; then WATCH_DIR="$q_watch"; break; fi
  done
fi

# 3. Inspect rTorrent
if [ -z "$ENGINE" ] && ps | grep -v grep | grep -q "rtorrent"; then
  ENGINE="rtorrent"
  for r_data in "/share/Download/rtorrent" "/share/Download"; do
    if [ -d "$r_data" ]; then DATA_DIR="$r_data"; break; fi
  done
  for r_watch in "/share/Download/rtorrent/watch" "/share/Download/watch"; do
    if [ -d "$r_watch" ]; then WATCH_DIR="$r_watch"; break; fi
  done
fi

# 4. Inspect Download Station
if [ -z "$ENGINE" ]; then
  if [ -d "/share/Download" ] || [ -d "/share/CACHEDEV1_DATA/Download" ]; then
    ENGINE="download_station"
    DATA_DIR="/share/Download"
    if [ -d "/share/Download/watch" ]; then
      WATCH_DIR="/share/Download/watch"
    else
      WATCH_DIR="/share/Download"
    fi
  fi
fi

# 5. Fallback standard paths
if [ -z "$DATA_DIR" ]; then
  for d in "/share/homes/iyou/releases" "/share/Download" "/share/Public" "releases"; do
    if [ -d "$d" ]; then DATA_DIR="$d"; break; fi
  done
fi
if [ -z "$DATA_DIR" ]; then
  DATA_DIR="releases"
fi

if [ -z "$WATCH_DIR" ] && [ -d "$DATA_DIR/watch" ]; then
  WATCH_DIR="$DATA_DIR/watch"
fi
if [ -z "$WATCH_DIR" ]; then
  WATCH_DIR="$DATA_DIR"
fi

[ -n "$OVERRIDE_DATA" ] && DATA_DIR="$OVERRIDE_DATA"
[ -n "$OVERRIDE_WATCH" ] && WATCH_DIR="$OVERRIDE_WATCH"

echo "ENGINE=$ENGINE"
echo "DATA_DIR=$DATA_DIR"
echo "WATCH_DIR=$WATCH_DIR"
echo "TR_REMOTE=$TR_REMOTE"
'

  local detect_output
  detect_output="$(ssh "$SEED_HOST" "sh -s" <<< "$detect_script")"

  local remote_engine="" remote_data_dir="" remote_watch_dir="" remote_tr_remote=""
  while IFS='=' read -r k v; do
    case "$k" in
      ENGINE) remote_engine="$v" ;;
      DATA_DIR) remote_data_dir="$v" ;;
      WATCH_DIR) remote_watch_dir="$v" ;;
      TR_REMOTE) remote_tr_remote="$v" ;;
    esac
  done <<< "$detect_output"

  log "QNAP Torrent Client Resolution:"
  printf '  Target Host       : %s\n' "$SEED_HOST"
  printf '  Engine            : %s\n' "${remote_engine:-generic / watch-folder}"
  printf '  Data Directory    : %s\n' "$remote_data_dir"
  printf '  Watch Directory   : %s\n' "$remote_watch_dir"
  [[ -n "$remote_tr_remote" ]] && printf '  Client CLI        : %s\n' "$remote_tr_remote"

  local target_payload_dir="$remote_data_dir/iyou_home_${VERSION}"
  local target_symlink_dir="$remote_data_dir/iyou-home_${VERSION}"

  ssh "$SEED_HOST" "mkdir -p '$target_payload_dir' '$remote_watch_dir'"

  local payload_human="" payload_bytes=""
  if command -v du >/dev/null 2>&1; then
    payload_human="$(du -sh "$RELEASE_DIR" 2>/dev/null | awk '{print $1}' || echo "unknown")"
  fi
  if [[ -d "$RELEASE_DIR" ]]; then
    payload_bytes="$(find "$RELEASE_DIR" -type f -exec stat -f%z {} + 2>/dev/null | awk '{s+=$1} END {print s}' || true)"
  fi

  log "Syncing release payload to ${SEED_HOST}:${target_payload_dir} (Payload size: ${payload_human:-~116MB})..."

  local sync_success=0
  if command -v rsync >/dev/null 2>&1; then
    if rsync -avP --delete "$RELEASE_DIR/" "$SEED_HOST:$target_payload_dir/"; then
      sync_success=1
    else
      warn "rsync failed, falling back to scp..."
    fi
  fi

  if [[ "$sync_success" != "1" ]]; then
    if scp -r "$RELEASE_DIR/"* "$SEED_HOST:$target_payload_dir/"; then
      sync_success=1
    else
      warn "Failed to transfer payload to $SEED_HOST:$target_payload_dir"
      SEED_STATUS="failed (transfer failed to $SEED_HOST)"
      return 0
    fi
  fi

  # Ensure symlink iyou-home_${VERSION} -> iyou_home_${VERSION} for torrent client match
  ssh "$SEED_HOST" "ln -sfn '$target_payload_dir' '$target_symlink_dir'"
  log "[OK] Verified data symlink: ${target_symlink_dir} -> ${target_payload_dir}"

  # Stage .torrent into watch directory if distinct
  if [[ "$remote_watch_dir" != "$target_payload_dir" && "$remote_watch_dir" != "$remote_data_dir" ]]; then
    ssh "$SEED_HOST" "cp '$target_payload_dir/iyou-home_${VERSION}.torrent' '$remote_watch_dir/' 2>/dev/null || true"
    log "[OK] Staged .torrent into watch directory: $remote_watch_dir/iyou-home_${VERSION}.torrent"
  fi

  # Activate and verify seeding
  local seed_active=0
  if [[ "$remote_engine" == "transmission" || -n "$remote_tr_remote" ]]; then
    local tr_bin="${remote_tr_remote:-/opt/bin/transmission-remote}"
    log "Registering and verifying torrent in Transmission via ${tr_bin}..."

    local activation_output
    activation_output="$(ssh "$SEED_HOST" "sh -s -- '$tr_bin' '$remote_data_dir' '$target_payload_dir' '$target_payload_dir/iyou-home_${VERSION}.torrent' '$VERSION' '${BTIH:-}'" << 'EOF'
export PATH="/opt/bin:/opt/sbin:/usr/local/bin:/usr/bin:/bin:$PATH"
TR_BIN="$1"
DATA_DIR="$2"
PAYLOAD_DIR="$3"
TORRENT_FILE="$4"
VERSION="$5"
EXPECTED_BTIH="$6"

# 1. Clean up obsolete torrents matching this version with mismatched hash
existing_ids=$("$TR_BIN" 9091 -l 2>/dev/null | grep -E "iyou[-_]home_${VERSION}" | awk '{print $1}' || true)
for tid in $existing_ids; do
  t_hash=$("$TR_BIN" 9091 -t "$tid" -i 2>/dev/null | grep -i "^  Hash:" | awk '{print $2}')
  if [ -n "$EXPECTED_BTIH" ] && [ "$t_hash" != "$EXPECTED_BTIH" ]; then
    echo "  [CLEANUP] Removing obsolete torrent ID $tid (hash $t_hash != $EXPECTED_BTIH)"
    "$TR_BIN" 9091 -t "$tid" -r >/dev/null 2>&1 || true
  fi
done

# 2. Add torrent with target download directory
"$TR_BIN" 9091 -a "$TORRENT_FILE" -w "$DATA_DIR" 2>&1

# 3. Locate active torrent ID and request piece verification
active_id=$("$TR_BIN" 9091 -l 2>/dev/null | grep -E "iyou[-_]home_${VERSION}" | awk '{print $1}' | tail -n1)
if [ -n "$active_id" ]; then
  "$TR_BIN" 9091 -t "$active_id" --verify >/dev/null 2>&1 || true
  for wait_i in $(seq 1 15); do
    sleep 1
    status_info=$("$TR_BIN" 9091 -t "$active_id" -i 2>/dev/null || true)
    if echo "$status_info" | grep -q -E "Percent Done: 100%|Have:.*verified|State: Seeding"; then
      break
    fi
  done
  "$TR_BIN" 9091 -t "$active_id" --start >/dev/null 2>&1 || true
  "$TR_BIN" 9091 -t "$active_id" -i
else
  echo "[WARN] Could not find registered torrent ID for iyou-home_${VERSION}"
fi
EOF
)"
    printf '%s\n' "$activation_output"

    if echo "$activation_output" | grep -q -E "Percent Done: 100%|Have:.*verified|State: Seeding|State: Idle"; then
      seed_active=1
      SEED_STATUS="seeding on ${SEED_HOST} (${remote_engine}, 100% verified)"
      log "[OK] Transmission verified payload pieces at 100% and is actively seeding."
    else
      SEED_STATUS="registered on ${SEED_HOST} (${remote_engine})"
    fi
  else
    log "Torrent staged in watch directory: $remote_watch_dir"
    SEED_STATUS="queued in watch directory (${remote_watch_dir})"
    seed_active=1
  fi

  log "QNAP Seeding Summary:"
  printf '  Host          : %s\n' "$SEED_HOST"
  printf '  Engine        : %s\n' "${remote_engine:-watch directory}"
  printf '  Data Folder   : %s\n' "$target_payload_dir"
  printf '  Watch Folder  : %s\n' "$remote_watch_dir"
  printf '  Payload Size  : %s (%s bytes)\n' "${payload_human:-unknown}" "${payload_bytes:-unknown}"
  printf '  Torrent File  : %s\n' "$target_payload_dir/iyou-home_${VERSION}.torrent"
  printf '  BTIH          : %s\n' "${BTIH:-unknown}"
  printf '  Seeder Status : %s\n' "$SEED_STATUS"
}

# Print summary
print_release_summary() {
  if [[ -z "${TORRENT_FILE:-}" || -z "${RELEASE_DIR:-}" ]]; then
    return 0
  fi
  log "Release payload ready — ${RELEASE_DIR}"
  printf '\n═══════════════════════════════════════════════════════════════════\n'
  printf '  Release folder : %s\n'                 "$RELEASE_DIR"
  printf '  Torrent file   : %s\n'                 "$RELEASE_DIR/$TORRENT_FILE"
  printf '  Magnet URI     : %s\n'                 "${MAGNET_LINK:-[NOT_GENERATED]}"
  printf '  Verify against : iyou_idp _download_modal.html\n'
  printf '  Seed host      : %s:%s (remote payload %s/iyou_home_%s)\n' \
         "${SEED_HOST:-qnap}" "${SEED_DIR:-releases}" "${SEED_DIR:-releases}" "${VERSION:-}"
  printf '  Seeder status  : %s\n'                    "${SEED_STATUS:-not attempted}"
  printf '\n  SHA-256 Verification Table (matches iyou_idp modal):\n'
  printf '    Windows (.exe) : %s\n' "${PRIMARY_WIN_SHA:-[NOT_RESOLVED]}"
  printf '    macOS (.dmg)    : %s\n' "${PRIMARY_MAC_SHA:-[NOT_RESOLVED]}"
  printf '    Debian (.deb)   : %s\n' "${PRIMARY_DEB_SHA:-[NOT_RESOLVED]}"
  printf '    AppImage        : %s\n' "${PRIMARY_APP_SHA:-[NOT_RESOLVED]}"
  printf '\n  Seed immediately on this machine:\n'
  printf '    transmission-cli "%s/%s" -w "%s" &\n' "$RELEASE_DIR" "$TORRENT_FILE" "$RELEASE_DIR"
  printf '    # or: transmission-remote -a "%s/%s" -w "%s"\n' "$RELEASE_DIR" "$TORRENT_FILE" "$RELEASE_DIR"
  printf '    # or: aria2c --follow-torrent=mem "%s/%s" --dir="%s"\n' "$RELEASE_DIR" "$TORRENT_FILE" "$RELEASE_DIR"
  printf '\n  Mirror manifest (magnet + IPFS URIs, matches the release notes):\n'
  printf '    cat "%s/MIRRORS.txt"\n'              "$RELEASE_DIR"
  printf '═══════════════════════════════════════════════════════════════════\n'
}

# ---------------------------------------------------------------- configuration
SEED_HOST="${SEED_HOST:-qnap}"
SEED_DIR="${SEED_DIR:-releases}"
QNAP_TORRENT_DATA_DIR="${QNAP_TORRENT_DATA_DIR:-}"
QNAP_TORRENT_WATCH_DIR="${QNAP_TORRENT_WATCH_DIR:-}"
SKIP_SEED="${SKIP_SEED:-0}"
REMOTE_TRANSMISSION_REMOTE="${REMOTE_TRANSMISSION_REMOTE:-transmission-remote}"
DRY_RUN="${DRY_RUN:-0}"
NO_WAIT_WINDOWS="${NO_WAIT_WINDOWS:-0}"
SYNC_WINDOWS_ONLY="${SYNC_WINDOWS:-0}"
PATCH_IDP_ONLY="${PATCH_IDP:-0}"
SEED_QNAP_ONLY="${SEED_QNAP:-0}"
IDP_PATH="${IDP_PATH:-}"

# Parse auxiliary flags
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--idp-path" ]]; then
    IDP_PATH="$arg"
    prev=""
    continue
  fi
  case "$arg" in
    --no-seed|--skip-seed) SKIP_SEED=1 ;;
    --seed-qnap|--seed) SEED_QNAP_ONLY=1 ;;
    --dry-run) DRY_RUN=1; SKIP_UPLOAD=1; SKIP_SEED=1 ;;
    --no-wait-windows) NO_WAIT_WINDOWS=1 ;;
    --sync-windows) SYNC_WINDOWS_ONLY=1 ;;
    --patch-idp) PATCH_IDP_ONLY=1 ;;
    --package-only|--skip-build) PACKAGE_ONLY=1 ;;
    --skip-mac) SKIP_MAC=1 ;;
    --skip-linux) SKIP_LINUX=1 ;;
    --skip-windows) SKIP_WINDOWS=1 ;;
    --skip-upload) SKIP_UPLOAD=1 ;;
    --idp-path) prev="--idp-path" ;;
    --idp-path=*) IDP_PATH="${arg#*=}" ;;
  esac
done

# Resolve first positional argument that is not an auxiliary flag
BUMP_ARG="${BUMP:-patch}"
if [[ "${SYNC_WINDOWS_ONLY:-0}" == "1" || "${PATCH_IDP_ONLY:-0}" == "1" || "${SEED_QNAP_ONLY:-0}" == "1" || "${DRY_RUN:-0}" == "1" ]]; then
  BUMP_ARG="${BUMP:-current}"
fi
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--idp-path" ]]; then
    prev=""
    continue
  fi
  case "$arg" in
    --no-seed|--skip-seed|--seed-qnap|--seed|--dry-run|--no-wait-windows|--sync-windows|--patch-idp|--package-only|--skip-build|--skip-bump|--skip-mac|--skip-linux|--skip-windows|--skip-upload)
      continue
      ;;
    --idp-path)
      prev="--idp-path"
      continue
      ;;
    --idp-path=*)
      continue
      ;;
  esac
  BUMP_ARG="$arg"
  break
done

if [[ "${BUMP_ARG}" == "--help" || "${BUMP_ARG}" == "-h" ]]; then
  echo "iyou_home — One-Click Sovereign Release Pipeline"
  echo ""
  echo "Usage: $0 [patch|minor|major|<version>|current|--current|--package-only] [options]"
  echo ""
  echo "Arguments:"
  echo "  patch          Bump patch version (default, e.g. 0.2.0 -> 0.2.1)"
  echo "  minor          Bump minor version (e.g. 0.2.0 -> 0.3.0)"
  echo "  major          Bump major version (e.g. 0.2.0 -> 1.0.0)"
  echo "  X.Y.Z          Bump to explicit SemVer version"
  echo "  current        Build & publish current version without bumping (alias: none)"
  echo "  --current      Alias for: current (no version bump)"
  echo "  --package-only No bump, no rebuilds; stage already-built bundles only"
  echo ""
  echo "Options:"
  echo "  --dry-run      Evaluate tag/commit alignment and preview modal updates without mutations"
  echo "  --sync-windows Download & verify Windows binary from GitHub CI, regenerate checksums/torrent, upload, and seed"
  echo "  --seed-qnap    Seed release payload to QNAP NAS via SSH"
  echo "  --patch-idp    Compute SHA-256 sums and patch iyou_idp download modal directly"
  echo "  --no-wait-windows  Dispatch Windows build without blocking on completion"
  echo "  --no-seed      Skip rsync to the seed box and transmission registration"
  echo "  --idp-path DIR Explicit path to iyou_idp repository"
  echo ""
  echo "Environment variables:"
  echo "  BUMP          Alternative to positional argument"
  echo "  SKIP_MAC=1    Skip local macOS build"
  echo "  SKIP_LINUX=1  Skip remote dc13 Linux build"
  echo "  SKIP_WINDOWS=1 Skip Windows NSIS GitHub Actions build dispatch / sync"
  echo "  SKIP_UPLOAD=1 Stage and checksum only (no tag, no push, no publish)"
  echo "  DRY_RUN=1     Dry-run mode (no remote modifications, no file overwrites)"
  echo "  NO_WAIT_WINDOWS=1 Asynchronous Windows CI dispatch"
  echo "  IDP_PATH=DIR  Custom directory path to iyou_idp"
  echo "  WINDOWS_EXE=path   Stage this Windows NSIS .exe into the payload"
  echo "  SEED_HOST=target   SSH alias/host of seed box (default: qnap)"
  echo "  SEED_DIR=dir       Target directory holding release payloads (default: releases)"
  echo "  QNAP_TORRENT_DATA_DIR=dir  Override payload data directory on QNAP"
  echo "  QNAP_TORRENT_WATCH_DIR=dir Override .torrent watch directory on QNAP"
  echo "  SKIP_SEED=1   Skip seeding entirely"
  exit 0
fi

# Remote resolution
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
RELEASE_DIR=""
mkdir -p "$ROOT/release-artifacts"

# ---------------------------------------------------------------- version bump
case "$BUMP_ARG" in
  current|none|0|--current|--skip-bump)
    log "Releasing currently committed version without bumping"
    ;;
  --package-only|--skip-build)
    log "Package-only mode: no version bump and no rebuilds — staging existing bundles"
    PACKAGE_ONLY=1
    ;;
  --sync-windows)
    log "Windows synchronization mode: fetching fresh Windows binary from GitHub CI"
    SYNC_WINDOWS_ONLY=1
    ;;
  --patch-idp)
    log "IdP patch mode: updating SHA-256 table in iyou_idp _download_modal.html"
    PATCH_IDP_ONLY=1
    ;;
  patch|minor|major|[0-9]*)
    if [[ "${DRY_RUN:-0}" == "1" ]]; then
      log "[DRY-RUN] Skipping version bump commit."
    else
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
    fi
    ;;
  *)
    fail "unrecognized bump argument '$BUMP_ARG' (expected: patch, minor, major, explicit X.Y.Z, current, or flag)"
    ;;
esac

# ---------------------------------------------------------------- pre-flight
log "Pre-flight checks"

VERSION="$(node -p "require('./package.json').version")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "non-SemVer version '$VERSION' in package.json"
log "Version: ${VERSION} (tag v${VERSION})"

RELEASE_DIR="$ROOT/release-artifacts/iyou_home_${VERSION}"
mkdir -p "$RELEASE_DIR"
log "Release payload dir: ${RELEASE_DIR}"

if [[ "${DRY_RUN:-0}" != "1" && "${PATCH_IDP_ONLY:-0}" != "1" && "${SYNC_WINDOWS_ONLY:-0}" != "1" && "${SEED_QNAP_ONLY:-0}" != "1" ]]; then
  [[ -z "$(git status --porcelain)" ]] || fail "git working tree is dirty; commit or stash before releasing"
fi
git rev-parse --git-dir >/dev/null

command -v gh >/dev/null || fail "gh CLI not found"
gh auth status >/dev/null 2>&1 || fail "gh not authenticated"
command -v node >/dev/null || fail "node not found"

if [[ "${DRY_RUN:-0}" != "1" && "${PATCH_IDP_ONLY:-0}" != "1" && "${SYNC_WINDOWS_ONLY:-0}" != "1" && "${SEED_QNAP_ONLY:-0}" != "1" ]]; then
  command -v cargo >/dev/null || fail "cargo not found"
  if [[ "${SKIP_LINUX:-0}" != "1" && "${PACKAGE_ONLY:-0}" != "1" ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=15 dc13 "true" || fail "ssh dc13 unreachable"
  fi
fi

# If user invoked specifically with --patch-idp
if [[ "${PATCH_IDP_ONLY:-0}" == "1" ]]; then
  auto_patch_idp
  log "IdP download modal patched successfully."
  exit 0
fi

# If user invoked specifically with --seed-qnap
if [[ "${SEED_QNAP_ONLY:-0}" == "1" ]]; then
  log "QNAP Seeding Mode: Validating release payload and seeding to QNAP"
  generate_checksums
  generate_bittorrent_and_mirrors
  seed_qnap_torrent
  print_release_summary
  exit 0
fi

# If user invoked with --dry-run
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log "DRY RUN MODE: Evaluating alignment, Windows status, checksums, and modal updates"
  check_remote_windows_status
  auto_patch_idp
  if ssh -q -o ConnectTimeout=3 -o BatchMode=yes "$SEED_HOST" exit 2>/dev/null; then
    log "[DRY-RUN] SSH to $SEED_HOST succeeded. QNAP seeding would be active."
  else
    warn "[DRY-RUN] SSH to $SEED_HOST unreachable in BatchMode."
  fi
  print_release_summary
  log "Dry run complete. No mutations performed."
  exit 0
fi

# ---------------------------------------------------------------- stage
log "Staging directory: ${RELEASE_DIR}"
if [[ "${PACKAGE_ONLY:-0}" != "1" && "${SYNC_WINDOWS_ONLY:-0}" != "1" ]]; then
  if [[ "${SKIP_MAC:-0}" != "1" ]]; then
    rm -f "$RELEASE_DIR"/iyou-home_*_x64.dmg
  fi
  if [[ "${SKIP_LINUX:-0}" != "1" ]]; then
    rm -f "$RELEASE_DIR"/iyou-home_*_amd64.deb "$RELEASE_DIR"/iyou-home_*_amd64.AppImage "$RELEASE_DIR"/iyou-home-*.rpm
  fi
  rm -f "$RELEASE_DIR"/SHA256SUMS.txt "$RELEASE_DIR"/MIRRORS.txt "$RELEASE_DIR"/iyou-home_*.torrent
fi

# ---------------------------------------------------------------- Mac build
if [[ "${SKIP_MAC:-0}" != "1" && "${SYNC_WINDOWS_ONLY:-0}" != "1" ]]; then
  if [[ "${PACKAGE_ONLY:-0}" == "1" ]]; then
    log "Package-only: reusing existing macOS bundle (no rebuild)"
    staged_dmg="$RELEASE_DIR/iyou-home_${VERSION}_x64.dmg"
    if [[ -f "$staged_dmg" ]]; then
      log "macOS bundle already staged: ${staged_dmg##*/}"
    else
      dmg="$(find src-tauri/target/release/bundle/dmg -maxdepth 1 -name "iyou-home_${VERSION}_x64.dmg" -print -quit 2>/dev/null || true)"
      [[ -n "$dmg" && -f "$dmg" ]] \
        || fail "package-only: no existing iyou-home_${VERSION}_x64.dmg to stage"
      mkdir -p "$RELEASE_DIR"
      cp "$dmg" "$staged_dmg"
      log "macOS bundle staged: iyou-home_${VERSION}_x64.dmg"
    fi
  else
    log "Building macOS bundle (local)"
    npm run tauri build
    dmg="$(find src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -print -quit 2>/dev/null || true)"
    [[ -n "$dmg" && -f "$dmg" ]] || fail "no .dmg produced under src-tauri/target/release/bundle/dmg/"
    mkdir -p "$RELEASE_DIR"
    cp "$dmg" "$RELEASE_DIR/iyou-home_${VERSION}_x64.dmg"
    log "macOS bundle staged: iyou-home_${VERSION}_x64.dmg"
  fi
else
  log "Skipping macOS build"
  mkdir -p "$RELEASE_DIR"
  if [[ ! -f "$RELEASE_DIR/iyou-home_${VERSION}_x64.dmg" ]]; then
    log "Restoring iyou-home_${VERSION}_x64.dmg from existing release v${VERSION}..."
    gh release download "v${VERSION}" --repo "$REPO" --pattern "*_x64.dmg" --dir "$RELEASE_DIR" --clobber 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------- Linux build
if [[ "${SKIP_LINUX:-0}" != "1" && "${SYNC_WINDOWS_ONLY:-0}" != "1" ]]; then
  if [[ "${PACKAGE_ONLY:-0}" == "1" ]]; then
    log "Package-only: skipping dc13 Linux build; keeping any previously staged .deb/.AppImage"
  else
    log "Building Linux bundles on dc13 (streaming repository, clean build)"

    tar_flags=(--exclude='.git' --exclude='node_modules' --exclude='src-tauri/target' --exclude='dist')
    if tar --version 2>/dev/null | head -n1 | grep -qi bsdtar; then
      tar_flags+=(--no-xattrs)
    fi

    remote_cmd='set -euo pipefail; export PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games"; rm -rf ~/build-runner; mkdir -p ~/build-runner; tar -xzf - -C ~/build-runner; cd ~/build-runner; npm ci; npm run tauri build; ls -1 src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/appimage/*.AppImage'

    tar "${tar_flags[@]}" -czf - -C "$ROOT" . | ssh -o BatchMode=yes dc13 "$remote_cmd"

    mkdir -p "$RELEASE_DIR"
    scp "dc13:~/build-runner/src-tauri/target/release/bundle/deb/"*.deb "$RELEASE_DIR/"
    scp "dc13:~/build-runner/src-tauri/target/release/bundle/appimage/"*.AppImage "$RELEASE_DIR/"
    scp "dc13:~/build-runner/src-tauri/target/release/bundle/rpm/"*.rpm "$RELEASE_DIR/" 2>/dev/null || true

    log "Linux bundles staged: .deb, .AppImage (+ .rpm)"
  fi
else
  log "Skipping dc13 Linux build"
  mkdir -p "$RELEASE_DIR"
  for pattern in "*_amd64.deb" "*_amd64.AppImage" "*-1.x86_64.rpm"; do
    if [[ -z "$(find "$RELEASE_DIR" -maxdepth 1 -name "$pattern" 2>/dev/null | head -n1)" ]]; then
      log "Restoring $pattern from existing release v${VERSION}..."
      gh release download "v${VERSION}" --repo "$REPO" --pattern "$pattern" --dir "$RELEASE_DIR" --clobber 2>/dev/null || true
    fi
  done
fi

# ---------------------------------------------------------------- Initial tag & release
# Windows CI requires the GitHub Release to exist so it can upload the .exe.
# Ensure the tag and release exist on remote before dispatching/synchronizing Windows CI.
if [[ "${SKIP_UPLOAD:-0}" != "1" ]]; then
  log "Checking remote release status for v${VERSION} on ${REPO} (remote '${REMOTE}')"
  git push "$REMOTE" HEAD
  if ! git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null; then
    git tag "v${VERSION}"
    log "Created tag v${VERSION}"
  fi
  git push "$REMOTE" "refs/tags/v${VERSION}:refs/tags/v${VERSION}" || log "tag already present on remote"

  notes="${RELEASE_NOTES:-Automated Sovereign Desktop Build}"
  # Embed the P2P mirror metadata directly in the body so the CORS-friendly
  # `releases/latest` endpoint exposes the magnet link to mirror clients.
  notes="${notes}$(build_p2p_mirror_block)"
  initial_assets=(
    "$RELEASE_DIR/iyou-home_${VERSION}_amd64.deb"
    "$RELEASE_DIR/iyou-home_${VERSION}_amd64.AppImage"
    "$RELEASE_DIR/iyou-home_${VERSION}_x64.dmg"
    "$RELEASE_DIR"/iyou-home-*.rpm
  )
  initial_args=()
  for a in "${initial_assets[@]}"; do
    [[ -f "$a" ]] && initial_args+=("$a")
  done

  if ! gh release view "v${VERSION}" --repo "$REPO" >/dev/null 2>&1; then
    log "Creating initial release v${VERSION} with available macOS & Linux assets..."
    gh release create "v${VERSION}" "${initial_args[@]}" --repo "$REPO" --title "iyou_home v${VERSION}" --notes "$notes"
  else
    if (( ${#initial_args[@]} > 0 )); then
      gh release upload "v${VERSION}" "${initial_args[@]}" --repo "$REPO" --clobber
    fi
    # CI normally creates the release first (softprops/action-gh-release@v2), so
    # the `--notes` above is skipped and the existing body carries no magnet.
    sync_release_p2p_body
  fi
fi

# ---------------------------------------------------------------- Windows CI Sync
# Synchronize with the GitHub Actions windows-latest runner and download the fresh .exe
if [[ "${SKIP_WINDOWS:-0}" != "1" ]]; then
  sync_windows_exe
else
  log "Skipping Windows CI synchronization (SKIP_WINDOWS=1)"
fi

# If specifically invoked with --sync-windows, finalize checksums, torrent, mirrors, QNAP seed, and upload then exit
if [[ "${SYNC_WINDOWS_ONLY:-0}" == "1" ]]; then
  log "Windows synchronization complete. Updating master checksums, torrent, mirrors, QNAP seed, and GitHub release..."
  generate_checksums
  generate_bittorrent_and_mirrors
  if [[ "${SKIP_SEED:-0}" != "1" ]]; then
    seed_qnap_torrent
  fi
  if [[ "${SKIP_UPLOAD:-0}" != "1" ]]; then
    publish_release_assets
  fi
  auto_patch_idp
  print_release_summary
  log "Windows synchronization and downstream release assets updated successfully."
  exit 0
fi

# ---------------------------------------------------------------- payload check
log "Validating release payload completeness"
payload_missing=()
if [[ "${SKIP_MAC:-0}" != "1" ]]; then
  [[ -f "$RELEASE_DIR/iyou-home_${VERSION}_x64.dmg" ]] \
    || payload_missing+=("macOS .dmg (iyou-home_${VERSION}_x64.dmg)")
fi
if [[ "${SKIP_LINUX:-0}" != "1" ]]; then
  [[ -n "$(find "$RELEASE_DIR" -maxdepth 1 -name "*.deb" 2>/dev/null | head -n1)" ]] \
    || payload_missing+=("Linux .deb")
  [[ -n "$(find "$RELEASE_DIR" -maxdepth 1 -name "*.AppImage" 2>/dev/null | head -n1)" ]] \
    || payload_missing+=("Linux .AppImage")
fi
if [[ "${SKIP_WINDOWS:-0}" != "1" && "${NO_WAIT_WINDOWS:-0}" != "1" ]]; then
  [[ -f "$RELEASE_DIR/iyou-home_${VERSION}_x64-setup.exe" ]] \
    || payload_missing+=("Windows .exe (iyou-home_${VERSION}_x64-setup.exe)")
fi

if (( ${#payload_missing[@]} > 0 )); then
  log "Expected platform bundles missing from ${RELEASE_DIR}:"
  printf '  [MISSING] %s\n' "${payload_missing[@]}"
  if [[ "${FORCE_PARTIAL_TORRENT:-0}" == "1" ]]; then
    log "FORCE_PARTIAL_TORRENT=1 — continuing with a partial payload."
  else
    log "A partial torrent would silently omit these platforms from the release"
    log "and from the magnet URI verified by iyou_idp (_download_modal.html)."
    ans=""
    read -r -p "Proceed and generate a PARTIAL payload torrent? [y/N] " ans </dev/tty || ans=""
    if [[ ! "$ans" =~ ^[yY]$ ]]; then
      fail "aborted: stage the missing bundles (or set FORCE_PARTIAL_TORRENT=1) and re-run"
    fi
  fi
else
  log "All expected platform bundles present in the payload."
fi

# ---------------------------------------------------------------- checksums
generate_checksums

# ---------------------------------------------------------------- mirrors & bittorrent
generate_bittorrent_and_mirrors

# ---------------------------------------------------------------- seed box (QNAP)
if [[ "${SKIP_SEED:-0}" != "1" ]]; then
  seed_qnap_torrent
else
  log "Skipping seed box sync (SKIP_SEED=1)"
  SEED_STATUS="skipped (SKIP_SEED=1)"
fi

# ---------------------------------------------------------------- publish & update
publish_release_assets

# ---------------------------------------------------------------- automate iyou_idp update
auto_patch_idp

# ---------------------------------------------------------------- self-check
if [[ "${SKIP_UPLOAD:-0}" != "1" && ${#FINAL_RELEASE_ASSETS[@]} -gt 0 ]]; then
  log "Verifying published asset URLs (expect 302/200, not 404)"
  failed=0
  for a in "${FINAL_RELEASE_ASSETS[@]}"; do
    name="$(basename "$a")"
    code="$(curl -sI -o /dev/null -w '%{http_code}' "https://github.com/$REPO/releases/download/v${VERSION}/${name}" || true)"
    if [[ "$code" != "302" && "$code" != "200" ]]; then
      printf '  [FAIL] %-40s HTTP %s\n' "$name" "$code"
      failed=1
    else
      printf '  [OK]   %-40s HTTP %s\n' "$name" "$code"
    fi
  done
  [[ "$failed" == "0" ]] || warn "one or more assets returned a non-200/302 status"
fi

log "Release automation complete: https://github.com/$REPO/releases/tag/v${VERSION}"
print_release_summary
