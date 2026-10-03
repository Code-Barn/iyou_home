# Release Pipeline — P2P / IPFS Findings

**Date:** 2026-10-03
**Release under investigation:** `v0.2.3` (tag `15ad9cd3`… BTIH)
**Scope:** findings from running `scripts/release.sh` for `v0.2.3`, plus latent bugs found while verifying the P2P release-body embed.

---

## 1. IPFS root CID is not reproducible (HIGH)

**Symptom.** Three consecutive release runs over an *identical* payload produced three
different root CIDs, despite the script logging the value as "deterministic":

| Run | IPFS Root CID |
|-----|---------------|
| 1 | `QmZUBkJc5LBtuvSZEjm3ZwpjRzF5uKLd7oRGgK31P49ctg` |
| 2 | `QmVN5nYDc8hgyUVHNHwRvUsySLBuVU6AqSDetwjjHLnmMb` |
| 3 | `QmVBnUBRU74yHu8j84QCgyxjHnhLXbitYmFS5dp7nwz2` |

The BitTorrent infohash was **identical** every run (`15ad9cd3027a50fd54147fc5583e3121ea5b55a1`).

### Root cause (confirmed)

The torrent metainfo embeds a wall-clock timestamp at the **top level** of the
metainfo dict, outside the `info` dict (`scripts/release.sh`, `torrent_dict`):

```python
info_dict = {
    "files": files_info,
    "name": f"iyou-home_{version}",
    "piece length": piece_len,
    "pieces": bytes(pieces),
}

torrent_dict = {
    ...
    "creation date": int(time.time()),   # <-- changes every run
    "info": info_dict,
    ...
}

btih = hashlib.sha1(bencode(info_dict)).hexdigest()   # info_dict has NO timestamp
fh.write(bencode(torrent_dict))                      # but the FILE does
```

So the `.torrent` **file bytes change on every run** while the **infohash does not** —
exactly the pattern observed.

That file then feeds the IPFS hash. The IPFS tar excludes only two files:

```bash
local tar_flags=(--exclude='.DS_Store' --exclude='MIRRORS.txt')
tar "${tar_flags[@]}" -czf - -C "$RELEASE_DIR" . | ssh dc13 '... ipfs add -r -Q --only-hash "$TMPDIR"'
```

`iyou-home_0.2.3.torrent` is **not** excluded, so a byte-change in the torrent
propagates straight into the root CID.

### Impact

- The `IPFS_GATEWAY_URL` published in the release body is only valid for the run that
  produced it. Any later re-run **silently repoints it**, with no code change and no
  diff to review.
- An IPFS pin taken against an earlier CID becomes inconsistent with the release notes.
- Release bodies are not reproducible, so the IPFS link cannot be cited as a stable
  identifier for a build.

### Suggested fix

Exclude the generated `.torrent` from the IPFS tar alongside `MIRRORS.txt`:

```bash
local tar_flags=(--exclude='.DS_Store' --exclude='MIRRORS.txt' --exclude='*.torrent')
```

This makes the CID a pure function of the shipped bundles. Alternative: make the
torrent deterministic by pinning `creation date` to a fixed value (e.g. derived from
the version tag or `SOURCE_DATE_EPOCH`), which additionally makes the `.torrent`
itself reproducible for seeding.

---

## 2. The IPFS CID is computed but never pinned (HIGH — needs confirmation)

The CID is produced with:

```bash
ipfs add -r -Q --only-hash "$TMPDIR"
```

`--only-hash` computes the CID **without storing or uploading anything**. Nothing is
written to the IPFS network by this script. The script even has a
`[PENDING_CLUSTER_PIN]` fallback for when the IPFS CLI is *absent* — implying that when
it is *present* the data is considered published, but `--only-hash` does not publish it.

**Consequence:** the `IPFS Gateway` / `IPFS CID` lines in the release body may point at
content no gateway can serve. If pinning is handled by an out-of-band cluster job, this
needs to be documented; otherwise the IPFS mirror is advertised but does not exist.

**Verification attempted:** querying `https://ipfs.io/ipfs/<cid>/` for all three CIDs
returned HTTP **429 (rate limited)** for each, so this is **not yet confirmed** — a 429
distinguishes nothing between "exists" and "does not exist". Re-check from a
non-throttled client, or check the pinning cluster directly.

---

## 3. Two divergent IPFS code paths, one of them self-referential (MEDIUM)

There are two mutually exclusive branches that compute the root CID:

```bash
if command -v ipfs >/dev/null 2>&1; then
  IPFS_ROOT_CID="$(ipfs add -r -Q --only-hash "$RELEASE_DIR")"   # local: NO excludes
elif ssh dc13 'which ipfs'; then
  ... tar with excludes ... | ssh dc13 'ipfs add ...'             # remote: has excludes
fi
```

Two problems with the local branch:

1. **It applies no excludes.** It hashes `MIRRORS.txt`, which the remote branch
   deliberately excludes — and `MIRRORS.txt` *contains the CID itself*. Including it
   makes the computation self-referential (or, on a re-run, dependent on the previous
   run's CID).
2. **It hashes the named directory** (`"$RELEASE_DIR"`), while the remote branch tars
   the *contents* (`-C "$RELEASE_DIR" .`). Different wrapping ⇒ different root CID.

So the same commit produces **different CIDs depending on whether the operator happens
to have `ipfs` installed locally**. `dc13` did not have it, which is why the remote
branch ran here. This is latent and will surface the first time someone runs a release
from a machine with the IPFS CLI installed.

**Suggested fix:** delete the local branch and always use the single tar-and-stream
implementation, so there is exactly one definition of the CID.

---

## 4. Release body could publish `[NOT_GENERATED]` placeholders (FIXED)

`v0.2.3` was initially published with literal placeholders in the body:

```
- **Magnet URI**: `[NOT_GENERATED]`
- **IPFS Gateway**: [NOT_GENERATED]
- **IPFS CID**: `[NOT_GENERATED]`
```

The create path embedded the P2P block unconditionally, but on that branch
`generate_bittorrent_and_mirrors()` had not run yet, so the shell `${VAR:-default}`
defaults resolved and the placeholders were baked into an already-public release.

**Fix:** `1494090` — embed only when `MAGNET_LINK` is populated; otherwise defer to
`sync_release_p2p_body()`, which runs from `publish_release_assets()` after the
BitTorrent/IPFS stages.

---

## 5. Magnet URI was corrupted by markdown backticks (FIXED)

The point of the body embed is that `iyou_idp`'s `download_modal.js` scrapes the magnet
out of the release body. It does so with (`download_modal.js:269`):

```js
const magnetMatch = release.body && release.body.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s"'<>]*/);
```

The trailing character class excludes whitespace, quotes and angle brackets — **but not
the backtick**. Rendering the magnet as markdown `` `code` `` therefore made the client
copy a trailing `` ` `` into the URI:

```
extracted len : 327   expected len : 326
MISMATCH — trailing junk: "`"
```

A magnet with a trailing backtick in its `ws=` parameter is a broken magnet; the web
seed would fail for every client that scraped it.

**Fix:** `5191465` — emit the magnet bare and document the regex constraint so the
backticks are not reintroduced. Verified against the live body: 326/326 exact match.

---

## 6. QNAP seed path is not durable (MEDIUM)

Seeding failed on first run:

```
mkdir: can't create directory '/opt/downloads/': Permission denied
```

Cause: `transmission-daemon` runs as `admin` and is configured with
`Download directory: /opt/downloads/torrent`, which **did not exist**. `/opt` is a
symlink into Entware (`/share/CACHEDEV1_DATA/.qpkg/Entware`, mode `755 admin:administrators`,
group has no write), and Entware was rebuilt on **Oct 2 17:18** — which is what removed
the directory. The daemon has been unable to save torrents since then.

Resolved for now by creating the directory with `sudo`. **Not durable**: the next Entware
rebuild will remove `/opt/downloads` again and silently break seeding the same way.
A durable path is a real share (e.g. `/share/homes/iyou/releases`), which additionally
needs the daemon's `admin` user granted traverse access — the home share is `0700`.

---

## 7. Checksum manifests are untracked but documented as canonical (MEDIUM)

`SHA256SUMS.txt` was untracked by `1fcbddc` (correct — it is a build artifact), but two
documents still describe it as canonical:

- `docs/RELEASE_SPEC_V2.md:534` — "canonical"
- `docs/RELEASE_AUTOMATION.md:139` — "canonical"

For `v0.2.3` the manifests are still published as release assets, so checksum consumers
have a source. The **documentation contract is now wrong** and should be updated to say
the canonical location is the release asset.

---

## 8. Cross-repo side effects left uncommitted (LOW)

`auto_patch_idp` modifies the sibling `iyou_idp` repository. After the run,
`../iyou_idp` has two dirty, unstaged files:

```
 M auth_bridge/static/auth_bridge/js/download_modal.js
 M auth_bridge/templates/auth_bridge/_download_modal.html
```

These are legitimate auto-updates (new SHA-256s + magnet), but they are unreviewed and
uncommitted in another repository. Worth a look before they are pushed.

---

## 9. `npm test` runs vitest in watch mode (LOW)

`npm test` is a bare `vitest` invocation, which defaults to **watch mode** — it never
exits. This presents as a hang and has already caused at least one abandoned run. Use
`npx vitest run` for a one-shot run in CI and in agent workflows.

---

## 10. `cargo check --quiet` in the version-bump path looks like a freeze (LOW)

The version-bump path runs:

```bash
cargo check --manifest-path src-tauri/Cargo.toml --quiet
```

`--quiet` suppresses progress output, so a multi-minute check is indistinguishable from
a hang. This is what stalled the first `v0.2.3` attempt; the script was not hung, it was
building silently. Consider dropping `--quiet` (or adding `--message-format short`) so
long builds show progress.

---

## Summary table

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | IPFS CID changes every run (torrent `creation date` inside IPFS tar) | HIGH | Open |
| 2 | CID computed with `--only-hash`, never pinned — mirror may not exist | HIGH | Unconfirmed (429) |
| 3 | Two divergent IPFS paths; local one is self-referential | MEDIUM | Open |
| 4 | `[NOT_GENERATED]` published in release body | HIGH | Fixed `1494090` |
| 5 | Magnet corrupted by backticks; client scrapes broken URI | HIGH | Fixed `5191465` |
| 6 | QNAP seed dir inside Entware; wiped by rebuild | MEDIUM | Worked around |
| 7 | Checksum manifests untracked but documented canonical | MEDIUM | Open |
| 8 | `../iyou_idp` left dirty by `auto_patch_idp` | LOW | Open |
| 9 | `npm test` = watch mode, presents as a hang | LOW | Open |
| 10 | `cargo check --quiet` presents as a freeze | LOW | Open |