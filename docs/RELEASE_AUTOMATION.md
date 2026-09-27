# Release Automation — `iyou_home`

This document describes the one-command sovereign release pipeline for `iyou_home`.
A single script (`scripts/release.sh`) builds, checksums, publishes, and verifies
the GitHub Release for every version tag — eliminating manual staging and the
"404 on the download modal" failure class.

---

## 1. Architecture

```
┌────────────────────────── local (developer machine) ──────────────────────────┐
│  scripts/release.sh                                                            │
│   ├─ pre-flight    (clean git, SemVer, gh auth, ssh dc13)                      │
│   ├─ macOS build   (npm run tauri build → .dmg → release-artifacts/)           │
│   ├─ Linux build   (tar . | ssh dc13 → npm ci && tauri build → deb/AppImage)  │
│   ├─ initial pub   (tag vX.Y.Z, gh release create/upload macOS & Linux)        │
│   ├─ Windows sync  (gh run watch / gh release download --pattern "*.exe")     │
│   ├─ checksums     (release-artifacts/SHA256SUMS.txt with all 4 platforms)    │
│   ├─ mirrors       (BitTorrent .torrent, magnet URI & IPFS root CID)           │
│   ├─ QNAP seed     (rsync payload, stage .torrent, transmission-remote 9091)   │
│   ├─ final pub     (upload updated SHA256SUMS.txt, .torrent, MIRRORS.txt)      │
│   ├─ patch IdP     (atomic SHA-256 update in iyou_idp _download_modal.html)    │
│   └─ self-check    (curl HEAD each asset URL → [OK]/[FAIL])                    │
└────────────────────────────────────────────────────────────────────────────────┘
          │ ssh dc13 (self-hosted runner)       │ gh workflow dispatch / sync
          ▼                                     ▼
┌────────────────── dc13 metal runner ┐ ┌────────────── GitHub Actions (windows-latest) ─┐
│  ~/build-runner/                    │ │  .github/workflows/build-windows.yml             │
│  npm ci && npm run tauri build      │ │  npm ci && npm run tauri build -- --bundles nsis │
│  → deb/*.deb, appimage/*.AppImage,  │ │  → bundle/nsis/*-setup.exe                       │
│    rpm/*.rpm                        │ │  → SHA256SUMS_WINDOWS.txt (gh release upload)    │
└─────────────────────────────────────┘ └─────────────────────────────────────────────────┘
```

Linux bundles are produced on the sovereign self-hosted runner (`dc13`,
`[self-hosted, linux, dc13, tauri-builder]`) matching `.github/workflows/release.yml`;
macOS bundles are produced locally via `npm run tauri build`; Windows NSIS installer
`.exe` bundles are compiled on GitHub Actions (`windows-latest`) via
`.github/workflows/build-windows.yml`. The release script synchronizes with the Windows runner,
downloads the verified `.exe` installer directly into the staging payload, computes all
consolidated SHA-256 checksums, seeds the complete release bundle to the QNAP NAS via
BitTorrent (`transmission-remote`), publishes final assets to GitHub Releases, and
automatically updates the verification table in `iyou_idp`'s `_download_modal.html`.

---

## 2. Prerequisites

| Requirement | Check |
|---|---|
| `gh` CLI authenticated | `gh auth status` |
| `ssh dc13` configured (runner reachable) | `ssh dc13 "true"` |
| Rust/Cargo + Node ≥ 20 + npm | `rustc --version`, `node --version` |
| macOS Tauri prerequisites | Xcode CLT, `xcode-select --install` |
| Git remote for `Code-Barn/iyou_home` | `git remote -v` (script auto-detects `origin`/`gh`/`pushall`) |

The script refuses to run when the working tree is dirty (so a release always
corresponds to a committed, reviewable state).

---

## 3. Version Bumps & Automated Release

`iyou_home` synchronizes versioning across all **five** required manifests:

| File | Field | Purpose |
|---|---|---|
| `package.json` | `"version"` | Node / Frontend package definition |
| `package-lock.json` | root + `packages[""]` `version` | NPM dependency lockfile |
| `src-tauri/tauri.conf.json` | `"version"` | Tauri app bundle version & metadata |
| `src-tauri/Cargo.toml` | `[package] version` | Rust crate manifest |
| `src-tauri/Cargo.lock` | `[[package]] name = "iyou-home"` `version` | Cargo dependency lockfile |

The release script (`scripts/release.sh`) provides an **automated bumping engine** that
updates all 5 manifests atomically, creates the bump commit, tags `vX.Y.Z`, and pushes
the changes to the repository remote before initiating builds.

### Usage Examples

```bash
# 1. Default patch bump (0.2.0 -> 0.2.1)
./scripts/release.sh

# 2. Explicit patch bump
./scripts/release.sh patch

# 3. Minor version bump (0.2.0 -> 0.3.0)
./scripts/release.sh minor

# 4. Major version bump (0.2.0 -> 1.0.0)
./scripts/release.sh major

# 5. Explicit target version
./scripts/release.sh 0.3.5

# 6. Re-run release pipeline on current version without bumping
./scripts/release.sh current
# or:
BUMP=none ./scripts/release.sh
```

The version string MUST be plain SemVer (`X.Y.Z`). The script validates this rule
and rejects anything else because Debian/RPM/AppImage/DMG/NSIS bundle filenames
depend strictly on the canonical SemVer format.

---

## 4. Triggering a Release

```bash
./scripts/release.sh [patch|minor|major|<version>|current] [options]
```

What it does, in order:

1. **Version bump (automated)** — unless running `current`/`none`, checks that the working
   tree is clean, executes `npm version <target> --no-git-tag-version`, updates
   `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, runs `cargo check` to update
   `src-tauri/Cargo.lock`, and commits all 5 manifests with
   `chore(release): bump version to v${NEW_VERSION}`.
2. **Pre-flight** — verifies clean tree, extracts `VERSION` from `package.json`,
   confirms `gh` auth, `node`, `cargo`, and `ssh dc13` connectivity.
3. **macOS build** — `npm run tauri build`; stages the DMG as
   `release-artifacts/iyou-home_${VERSION}_x64.dmg`.
4. **Linux build** — streams the repository (excluding `.git`, `node_modules`,
   `src-tauri/target`, `dist`) to `dc13:~/build-runner/`, runs
   `npm ci && npm run tauri build`, and pulls back `.deb`, `.AppImage` (and `.rpm`).
   *Note:* the stream uses `--no-xattrs` on macOS `bsdtar` — without it the pipe
   stalls on per-file extended-attribute headers.
5. **Initial publish & Windows build dispatch** — tags `v${VERSION}`, publishes initial
   macOS/Linux assets, and dispatches `.github/workflows/build-windows.yml` on GitHub Actions
   `windows-latest` (unless `SKIP_WINDOWS=1`).
6. **Windows sync (`sync_windows_exe`)** — monitors the GitHub Actions Windows CI runner,
   downloads the freshly built `iyou-home_${VERSION}_x64-setup.exe` directly into the release
   payload folder, and validates that its commit matches the release tag.
7. **Checksums (`generate_checksums`)** — compiled *after* the Windows `.exe` is retrieved.
   Writes the canonical `release-artifacts/SHA256SUMS.txt` with verified SHA-256 digests
   across all 4 primary platforms (macOS DMG, Windows EXE, Debian DEB, AppImage) plus RPM.
8. **Peer-to-Peer Mirrors & BEP 19 Web Seeding (`generate_bittorrent_and_mirrors`)** — packages all installer
   binaries into `release-artifacts/iyou-home_${VERSION}.torrent` embedded with public trackers
   (`udp://tracker.opentrackr.org:1337/announce`, `udp://open.demonii.com:1337/announce`,
   `udp://tracker.torrent.eu.org:451/announce`) and **BEP 19 Web Seeding** (`url-list` pointing to
   `https://github.com/Code-Barn/iyou_home/releases/download/v${VERSION}/`). Computes the 40-character BitTorrent
   Info Hash (BTIH) and standard Magnet URI (with `&ws=` parameter), computes the deterministic IPFS root
   CID via `dc13` or local `ipfs`, and writes `release-artifacts/MIRRORS.txt` including `WEB_SEED_URL`.
9. **QNAP BitTorrent Seeding (`seed_qnap_torrent`)** — executed automatically by default on every release
   and `--current` run unless skipped via `--skip-seed` or `SKIP_SEED=1`. Probes SSH connectivity
   (`ssh -q -o ConnectTimeout=3 -o BatchMode=yes qnap exit`), rsyncs the full payload directory (~125 MB)
   to the QNAP NAS at `/share/homes/iyou/releases`, ensures client data symlinks (`iyou-home_${VERSION}`),
   stages the `.torrent` into the watch folder, registers the torrent with `transmission-remote 9091 -a`,
   purges any obsolete torrents with mismatched hashes, verifies 100% piece integrity, and activates
   immediate seeding.
10. **Final publish (`publish_release_assets`)** — updates the live GitHub Release with the authentic
   master `SHA256SUMS.txt`, `.torrent`, and `MIRRORS.txt` via `gh release upload --clobber`.
11. **IdP download modal patch (`auto_patch_idp`)** — locates `../iyou_idp` and performs atomic
   in-place updates on both `_download_modal.html` and `download_modal.js` (`MAGNET_FALLBACK_URI`) for all
   4 platform SHA-256 digests and the fresh BTIH magnet URI with web seed.
12. **Self-check** — issues a `curl -I HEAD` against every published asset URL and
   logs `[OK]` (HTTP 302/200), `[ASYNC]` (for Windows build underway), or `[FAIL]`.

### CLI Options

| Flag | Purpose |
|---|---|
| `--current` | Re-run pipeline for currently committed version without bumping |
| `--sync-windows` | Download fresh Windows binary from GitHub Actions, re-hash, re-generate torrent, seed to QNAP, clobber release, and patch IdP modal |
| `--seed-qnap` | Re-hash staged payload, generate `.torrent`, sync payload to QNAP via rsync, and verify 100% seeding in Transmission |
| `--patch-idp` | Calculate SHA-256 digests of release payload and patch `_download_modal.html` in `iyou_idp` |
| `--dry-run` | Inspect commit/tag alignment, check Windows build status, preview IdP modal diff, and test QNAP SSH reachability without making changes |
| `--no-seed` / `--skip-seed` | Skip copying payload to QNAP and skip transmission registration |
| `--no-wait-windows` | Dispatch Windows build on GitHub Actions without blocking on completion |
| `--package-only` | Stage already-built local bundles without triggering rebuilds |
| `--idp-path DIR` | Explicit path to `iyou_idp` repository |

### Environment overrides

| Variable | Effect |
|---|---|
| `BUMP` | SemVer bump type: `patch` (default), `minor`, `major`, `X.Y.Z`, or `current`/`none` |
| `SKIP_MAC=1` | skip the local macOS build (uses existing `release-artifacts` DMG) |
| `SKIP_LINUX=1` | skip the remote dc13 Linux build |
| `SKIP_WINDOWS=1` | skip the Windows NSIS GitHub Actions build dispatch |
| `SKIP_UPLOAD=1` | stage + checksum only; no tag, no push, no publish |
| `SKIP_SEED=1` | skip QNAP NAS payload transfer and transmission registration |
| `SEED_HOST` | SSH alias / hostname for torrent seed box (default: `qnap`) |
| `QNAP_TORRENT_DATA_DIR` | Override target payload data folder on QNAP (default: auto-detected or `/share/homes/iyou/releases`) |
| `QNAP_TORRENT_WATCH_DIR` | Override `.torrent` watch folder on QNAP (default: auto-detected or `/share/Download/watch`) |
| `IDP_PATH` | Explicit path to `iyou_idp` repository (default: auto-detects `../iyou_idp`) |
| `RELEASE_NOTES` | custom GitHub Release notes text |
| `RELEASE_REMOTE` | git remote to push the tag to (default: auto-detected) |

### Asset matrix produced

```
release-artifacts/
├── iyou-home_<V>_amd64.deb          # Debian/Ubuntu package
├── iyou-home_<V>_amd64.AppImage     # standalone Linux image
├── iyou-home-<V>-1.x86_64.rpm       # Fedora/openSUSE package (best effort)
├── iyou-home_<V>_x64.dmg            # macOS Intel disk image
├── iyou-home_<V>_x64-setup.exe      # Windows NSIS standalone installer
├── iyou-home_<V>.torrent            # BitTorrent metainfo bundle
├── MIRRORS.txt                      # P2P mirrors manifest (magnet & IPFS)
├── SHA256SUMS.txt                   # Local/Linux manifest
├── SHA256SUMS_LINUX.txt             # Linux CI manifest
└── SHA256SUMS_WINDOWS.txt           # Windows CI manifest
```

Verify a download against the published manifest:

```bash
curl -sLO https://github.com/Code-Barn/iyou_home/releases/download/v0.2.0/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt
```

### Peer-to-Peer Mirrors & IPFS Manifest (`MIRRORS.txt`)

Every release automatically generates and publishes `MIRRORS.txt` containing direct
decentralized retrieval URIs:

```ini
RELEASE_VERSION=v0.2.0
MAGNET_LINK=magnet:?xt=urn:btih:d96ed3eb2faf...&dn=iyou-home_0.2.0&tr=udp%3A%2F%2Ftracker.opentrackr.org...&ws=https%3A%2F%2Fgithub.com%2FCode-Barn%2Fiyou_home%2Freleases%2Fdownload%2Fv0.2.0%2F
TORRENT_FILE=iyou-home_0.2.0.torrent
WEB_SEED_URL=https://github.com/Code-Barn/iyou_home/releases/download/v0.2.0/
IPFS_ROOT_CID=Qm...
IPFS_GATEWAY_URL=https://ipfs.io/ipfs/Qm.../
IPFS_ALT_GATEWAY_URL=https://dweb.link/ipfs/Qm.../
IPFS_NATIVE_URI=ipfs://Qm.../
```

- **BitTorrent Client:** Open `iyou-home_<V>.torrent` or copy `MAGNET_LINK` into any standard client (Transmission, qBittorrent, aria2c).
- **IPFS Gateways:** Fetch directly via public gateway (`IPFS_GATEWAY_URL`) or natively via Brave/IPFS daemon (`IPFS_NATIVE_URI`).

### QNAP BitTorrent Seeding & Storage Automation

To ensure immediate swarm availability upon release publication, `scripts/release.sh` integrates automated seeding to a local or remote QNAP NAS (reachable via SSH alias `qnap`):

1. **Host Reachability & Detection:**
   The script checks SSH connectivity (`ssh -q -o ConnectTimeout=3 -o BatchMode=yes qnap exit`). If reachable, it inspects running processes and filesystem paths on the NAS to detect the active engine:
   - **Transmission:** Looks for `transmission-daemon` or `/opt/bin/transmission-remote`. Connects to RPC port 9091.
   - **qBittorrent / rTorrent / Download Station:** Discovers native and containerized watch/data directories under `/share/Download` or `/share/CACHEDEV1_DATA/Download`.
2. **Payload Syncing:**
   Uses `rsync -avP --delete` (falling back to `scp`) to transfer the staged release folder (`release-artifacts/iyou_home_${VERSION}`) to the QNAP storage path (default: `/share/homes/iyou/releases/iyou_home_${VERSION}`).
   A symlink `iyou-home_${VERSION}` is maintained so torrent clients looking for hyphenated directory names resolve the payload seamlessly.
3. **Torrent Registration & Verification:**
   - Cleans up obsolete torrents registered under the same version tag whose BTIH does not match the newly generated metainfo.
   - Adds the `.torrent` file to Transmission targeting the data folder (`transmission-remote 9091 -a <TORRENT> -w <DATA_DIR>`).
   - Issues `--verify` to trigger cryptographic piece checking across the 116 MB payload.
   - Verifies 100% completion (`Have: 116.5 MB verified`) and starts active seeding (`--start`).
4. **Standalone Operations:**
   Run `./scripts/release.sh --seed-qnap` at any time to re-verify the local payload, re-hash, re-generate the torrent metainfo, and ensure the NAS seeder is 100% active.

---

## 5. Troubleshooting

### Windows build manual recovery / re-dispatch
If the Windows GitHub Actions runner fails, times out, or needs to be compiled independently of macOS/Linux:
```bash
gh workflow run build-windows.yml -f tag=v0.2.0
```
To monitor the build progress:
```bash
gh run list --workflow="build-windows.yml"
gh run watch <RUN_ID>
```
Once complete, verify the uploaded executable asset on the release:
```bash
gh release view v0.2.0 --json assets
```
When iterating on macOS or Linux builds locally without needing a Windows binary rebuilt, pass `SKIP_WINDOWS=1`:
```bash
SKIP_WINDOWS=1 ./scripts/release.sh
```

### Uploads fail / the release stays a draft
- `gh release create` uploads assets **sequentially**; a 100 MB+ AppImage can exceed
  an impatient SSH/tool timeout. The release object is created first (as a draft
  while assets stream) — if your client times out, the release may be left as a
  **draft** with a temporary `untagged-<hash>` URL. Resume with:
  ```bash
  gh release upload v0.2.0 <missing-asset> --repo Code-Barn/iyou_home --clobber
  gh api --method PATCH repos/Code-Barn/iyou_home/releases/<ID> -f draft=false
  ```
  Asset uploads must target `uploads.github.com`; use `gh release upload` (not a raw
  `gh api POST` to the uploads path). Find the release ID with
  `gh api repos/Code-Barn/iyou_home/releases --jq '.[] | {id, tag_name, draft}'`.

### Asset stuck in `starter` / half-uploaded
Delete the incomplete asset and re-upload (`--clobber`):
```bash
gh api repos/Code-Barn/iyou_home/releases/assets/<ASSET_ID> --method DELETE
gh release upload v0.2.0 release-artifacts/* --repo Code-Barn/iyou_home --clobber
```

### `ssh dc13` disconnects mid-pipeline
- Fail-fast pre-flight (`ssh -o BatchMode=yes -o ConnectTimeout=15 dc13 "true"`) runs
  before any expensive work, so a dead runner aborts early.
- If a mid-build disconnect leaves `dc13:~/build-runner` half-extracted, the next run
  `rm -rf`'s it and streams a fresh copy — the script is fully safe to re-run.
- The `did_rust` build requires the runner PATH to include `~/.cargo/bin`
  (the script exports it explicitly on the remote).

### Result/version "wrong filename" (e.g. `..._0.2.0-SOVEREIGN-RELEASE_...`)
Checksum and bundle names derive from `Cargo.toml`/`tauri.conf.json` versions.
Restore plain SemVer across **all five** files from §3 or the script's version
validation will abort.

### Checksum tooling on macOS
`/sbin/sha256sum` and `shasum -a 256` are both accepted; the script auto-detects.

---

## 6. Reference: GitHub Actions workflows

- `.github/workflows/release.yml` mirrors the Linux half of this pipeline on
  push of `v*` tags (self-hosted `dc13` runner, `npm ci`, `npm run tauri build`,
  checksum staging, optional asset publish on tag push).
- `.github/workflows/build-windows.yml` compiles the native Windows standalone
  installer (`.exe`) via NSIS on GitHub-hosted `windows-latest` runners, stages
  TLS assets, computes SHA-256 sums, and uploads `iyou-home_<V>_x64-setup.exe` and
  `SHA256SUMS_WINDOWS.txt` to the release.
- `scripts/release.sh` is the unified, interactive one-command entry point that
  coordinates macOS local compilation, Linux dc13 streaming, GitHub release publishing,
  and the Windows CI build dispatch.