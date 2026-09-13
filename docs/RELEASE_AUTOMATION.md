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
│   └─ self-check   (curl HEAD each asset URL → [OK]/[FAIL])                     │
└────────────────────────────────────────────────────────────────────────────────┘
                              │ ssh dc13 (self-hosted runner)
                              ▼
┌────────────────────────── dc13 metal runner ──────────────────────────────────┐
│  ~/build-runner/  (fresh copy of repo each run)                                │
│  npm ci && npm run tauri build                                                 │
│  → bundle/deb/*.deb, bundle/appimage/*.AppImage, bundle/rpm/*.rpm              │
└────────────────────────────────────────────────────────────────────────────────┘
```

Linux bundles are produced on the sovereign self-hosted runner (`dc13`,
`[self-hosted, linux, dc13, tauri-builder]`) matching `.github/workflows/release.yml`;
macOS bundles are produced locally via `npm run tauri build`.

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
6. **Self-check** — issues a `curl -I HEAD` against every uploaded asset URL and
   logs `[OK]` (HTTP 302/200) or `[FAIL]`.

### Environment overrides

| Variable | Effect |
|---|---|
| `SKIP_MAC=1` | skip the local macOS build (uses existing `release-artifacts` DMG) |
| `SKIP_LINUX=1` | skip the remote dc13 Linux build |
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
├── SHA256SUMS.txt                   # all of the above
└── SHA256SUMS_LINUX.txt             # Linux-only manifest (from CI workflow)
```

Verify a download against the published manifest:

```bash
curl -sLO https://github.com/Code-Barn/iyou_home/releases/download/v0.2.0/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt
```

---

## 5. Troubleshooting

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

## 6. Reference: existing GitHub Release workflow

`.github/workflows/release.yml` mirrors the Linux half of this pipeline on
push of `v*` tags (self-hosted `dc13` runner, `npm ci`, `npm run tauri build`,
checksum staging, optional asset publish on tag push). `scripts/release.sh` is the
interactive/manual equivalent used for production releases, and also handles the
macOS DMG that the CI workflow does not build.