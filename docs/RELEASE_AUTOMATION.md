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
│   ├─ pre-flight   (clean git, SemVer, gh auth, ssh dc13)                       │
│   ├─ macOS build  (npm run tauri build → .dmg → release-artifacts/)            │
│   ├─ Linux build  (tar . | ssh dc13 → npm ci && tauri build → deb/AppImage)   │
│   ├─ checksums    (release-artifacts/SHA256SUMS.txt)                           │
│   ├─ publish      (tag vX.Y.Z, gh release create|upload --clobber)             │
│   ├─ Windows CI   (gh workflow run build-windows.yml -f tag=vX.Y.Z)            │
│   └─ self-check   (curl HEAD each asset URL → [OK]/[ASYNC]/[FAIL])             │
└────────────────────────────────────────────────────────────────────────────────┘
          │ ssh dc13 (self-hosted runner)       │ gh workflow dispatch
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
`.github/workflows/build-windows.yml` and attached directly to the release upon completion.

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

## 3. Version Bumps

`iyou_home` keeps the version in three manifests plus two lockfiles. Bump **all**
of them together (a mismatch breaks `npm ci` or the Cargo build):

| File | Field | Example |
|---|---|---|
| `package.json` | `"version"` | `"0.2.0"` |
| `src-tauri/tauri.conf.json` | `"version"` | `"0.2.0"` |
| `src-tauri/Cargo.toml` | `[package] version` | `version = "0.2.0"` |
| `package-lock.json` | root + `packages[""]` `version` | `"0.2.0"` |
| `src-tauri/Cargo.lock` | `[[package]] name = "iyou-home"` `version` | `0.2.0` |

The version string MUST be plain SemVer (`X.Y.Z`). The script rejects anything
else (e.g. the legacy `-SOVEREIGN-RELEASE` suffix) because Debian/AppImage bundle
names and the iyou.me download modal depend on exactly `iyou-home_X.Y.Z_amd64.deb`
and `iyou-home_X.Y.Z_x64.dmg`.

Commit the bump, push, then tag. The script can create/push the tag itself.

---

## 4. Triggering a Release

```bash
./scripts/release.sh
```

What it does, in order:

1. **Pre-flight** — verifies clean tree, extracts `VERSION` from `package.json`,
   confirms `gh` auth and `ssh dc13` connectivity.
2. **macOS build** — `npm run tauri build`; stages the DMG as
   `release-artifacts/iyou-home_${VERSION}_x64.dmg`.
3. **Linux build** — streams the repository (excluding `.git`, `node_modules`,
   `src-tauri/target`, `dist`) to `dc13:~/build-runner/`, runs
   `npm ci && npm run tauri build`, and pulls back `.deb`, `.AppImage` (and `.rpm`).
   *Note:* the stream uses `--no-xattrs` on macOS `bsdtar` — without it the pipe
   stalls on per-file extended-attribute headers.
4. **Checksums** — writes `release-artifacts/SHA256SUMS.txt`.
5. **Publish** — tags `v${VERSION}` (if absent), pushes the tag, then
   `gh release create` (asset upload). If the release already exists it falls back to
   `gh release upload --clobber`, making the script **idempotent**.
6. **Windows build dispatch** — unless `SKIP_WINDOWS=1`, dispatches
   `.github/workflows/build-windows.yml` on the GitHub Actions `windows-latest` runner
   for `v${VERSION}`. Compilation runs asynchronously (~9-10 mins) and uploads the
   `.exe` installer and `SHA256SUMS_WINDOWS.txt` directly to the release.
7. **Self-check** — issues a `curl -I HEAD` against every published asset URL and
   logs `[OK]` (HTTP 302/200), `[ASYNC]` (for Windows build underway), or `[FAIL]`.

### Environment overrides

| Variable | Effect |
|---|---|
| `SKIP_MAC=1` | skip the local macOS build (uses existing `release-artifacts` DMG) |
| `SKIP_LINUX=1` | skip the remote dc13 Linux build |
| `SKIP_WINDOWS=1` | skip the Windows NSIS GitHub Actions build dispatch |
| `SKIP_UPLOAD=1` | stage + checksum only; no tag, no publish |
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
├── SHA256SUMS.txt                   # Local/Linux manifest
├── SHA256SUMS_LINUX.txt             # Linux CI manifest
└── SHA256SUMS_WINDOWS.txt           # Windows CI manifest
```

Verify a download against the published manifest:

```bash
curl -sLO https://github.com/Code-Barn/iyou_home/releases/download/v0.2.0/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt
```

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