# SCAFFOLDING_PLAN — Capability Scaffolding for Chat / Blossom Browser / Mobile Pairing

**Scope:** Read-only architecture audit + integration scaffolding plan for three new
capabilities on top of the existing V2 shell. No code changed in this audit.
**Date:** 2026-08-28
**Primary references:** `AGENT.md`, `HOME_DEVELOPER_GUIDE.md`, `docs/RELEASE_SPEC_V2.md`,
`TODO.md`, `src/App.tsx`, `src/**/enclave/*`, `src/components/KeysManager.tsx`,
`src/components/ServiceSwitchPanel.tsx`, `src-tauri/src/{prosody,blossom,vault,lib,contacts}.rs`.

---

## 0. Executive Findings (Read-Only)

| Area | Finding | Evidence |
|---|---|---|
| Shell | 6 tabs, container `max-width: 1024px`, default tab `enclave`. New capabilities embed as **sub-features in existing tabs** — no new top-level tab required. | `App.tsx:29,50`, `App.css:37-46` |
| Contacts | `contacts.json` stores `peer_id` (canonical DID **or** 64-hex Nostr pubkey), `disclosed_aliases` (may hold `hex@127.0.0.1` sockets). Selecting a peer for chat is a drop-in state addition in `ContactList`. | `contacts.rs:68-85`, `ContactList.tsx:480-519` |
| XMPP | `prosody.rs` is an RFC 7395 XMPP-over-WS server on `127.0.0.1:5222`. Auth is PLAIN with a **DID↔hex binding** (`parts[2] == extract_hex_from_did(parts[1])`). Message routing currently **echoes to self** only; no roster, no OMEMO. | `prosody.rs:295-384`, `prosody.rs:39-49` |
| Blossom | Blob store is flat files `{app_data}/blobs/{sha256_hex}` with **no index**. `get_sync_status` only *counts* files. `detect_mime_type()` is **private**. No IPC exposes blob metadata. | `blossom.rs:62-113,223-262`, `lib.rs:1790-1792` |
| Vault | Master seed reveal (`REVEAL MY SEED`, 10s countdown, 30s auto-dismiss) and `.iyoubackup` (HKDF-SHA256 + AES-256-GCM, `pack_backup_payload`) are self-contained and reusable patterns. **No QR/pairing crate** in either `Cargo.toml` or `package.json`. | `KeysManager.tsx:131-176`, `vault.rs:196-325`, `Cargo.toml:20-53` |
| Latent bug | Frontend calls `write_binary_file`/`read_binary_file` (`KeysManager.tsx:201,241`) but **neither is registered** in the Rust `invoke_handler` (grep: 0 matches in `src-tauri/src`). Export falls back to browser blob download; restore falls back to `fetch` (which fails on `tauri://` origin). | `lib.rs:1988-2037` |

---

## 1. Recommended Sub-Component Hierarchy

### 1.1 Native OMEMO/XMPP Chat in the Contact Enclave

```
ProjectZero.tsx                      (unchanged tab switch: matrix|contacts)
└── ContactList.tsx                  (add: onOpenChat(contact), activeChat state)
    ├── PeerChat.tsx                 [NEW] full-window override of the enclave list
    │   ├── ChatHeader.tsx           contact badge + trust pill + peer JID
    │   ├── MessageThread.tsx        [NEW] virtualized bubble list
    │   ├── MessageBubble.tsx        [NEW] own/peer, delivery states
    │   ├── ChatComposer.tsx         [NEW] textarea + send; OMEMO lock indicator
    │   └── OmemoTrustModal.tsx      [NEW] first-contact fingerprint verification
    ├── OmemoSession.ts  (lib)       [NEW] device list / prekey session store
    └── xmppClient.ts    (lib)       [NEW] RFC 7395 WS client for wss://home.iyou.me:5222
```

**Wiring without disrupting existing modals**
- `ContactList` already keys rows by `peer_id` (`ContactList.tsx:404`). Add a 💬 action
  button per row and a leaf state `const [chatPeer, setChatPeer] = useState<PeerContact|null>(null)`.
  When set, render `<PeerChat contact={chatPeer} onBack={() => setChatPeer(null)} />` in
  place of the list body. `DisclosureModal` and `GraduationWizard` remain mounted at
  `ProjectZero` level and are untouched.
- **Peer JID derivation** (`PeerChat` prop → connection):
  - `peer_id` is 64-hex Nostr pubkey → JID `{normalize_key(peer_id)}@127.0.0.1`
    (`normalize_key` at `contacts.rs:98`).
  - `peer_id` is `did:key:z…` → derive the underlying Ed25519 hex with the same math as
    `prosody.rs:extract_hex_from_did` (multibase decode, strip `0xed01` multicodec). Expose
    this as a shared helper.
  - Else scan `disclosed_aliases` for existing `…@127.0.0.1` socket entries.
- **Local JID/credentials:** prosody PLAIN accepts `username=did:key:z…`, `password = hex
  extracted from that DID` (`prosody.rs:315-319`). Level 1 persona's DID is already in
  React (via `list_profiles`) — **use the L1 persona for ALL peer chat by invariant**
  (`ContactList.tsx:336-338` already states "Live communications route through your
  Level 1 persona"). Never bind with the L0 Anchor DID.
- **PNA risk:** the WS upgrade path in `prosody.rs:157-173` does **not** return
  `Access-Control-Allow-Private-Network: true` (Blossom does at `blossom.rs:75-77`). If
  the webview is served from a non-loopback origin, the browser will block the upgrade.
  Plan fix: add the PNA header/`OPTIONS` pre-flight to `handle_xmpp_ws_connection`, or
  route chat through a Rust-side tungstenite client.
- **OMEMO is net-new work.** Nothing on this repo speaks OMEMO (XEP-0384). Scaffold as a
  Rust `omemo.rs` module owning prekey/session state in the existing rusqlite pattern
  (`nostr_relay.rs`), with device list + signed prekeys exchangeable as JSON over the
  existing message stanza surface.

### 1.2 Offline Blossom Media Browser in the Services Panel

```
ServiceSwitchPanel.tsx                (unchanged daemon rows + sync card)
└── BlossomBrowser.tsx                [NEW] card, placed below the daemon list / Sync card
    ├── BlobGrid.tsx                  [NEW] thumbnail grid (image previews via :9002 GET)
    ├── BlobRow.tsx / BlobMeta.tsx    [NEW] sha256, size, mime, created_at badges
    ├── BlobDetailDrawer.tsx          [NEW] full preview + copy sha256 + copy local URL
    └── BlobUploadDropper.tsx         [NEW] optional PUT to 127.0.0.1:9002/{sha256}
```

- Data source: new IPC `list_local_blobs` (see §2.1). Rendered fully offline — no network
  egress; all reads hit the loopback daemon or the local directory listing.
- Previewing fetches `http://127.0.0.1:9002/{sha256}` in the webview; Blossom already sets
  `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Private-Network: true`
  (`blossom.rs:69-77,115-130`), so this works cross-origin.
- Optional delete requires a `DELETE /:hash` route added to `blossom.rs` (only
  GET/HEAD/PUT/OPTIONS exist today, `blossom.rs:79-94`).

### 1.3 Mobile Device Pairing / QR Handshake in Vault

```
KeysManager.tsx                       (unchanged sections)
└── DevicePairing.tsx                 [NEW] section between "Sovereign Data Redundancy"
│                                     callout (KeysManager.tsx:402-454) and "Encrypted
│                                     Backup & Recovery" (KeysManager.tsx:456-471)
    ├── PairQrPanel.tsx               [NEW] QR modal rendering iyouhome://pair?x25519=…&nonce=…
    ├── PairingStatus.tsx             [NEW] waiting-for-scan + verified/revoked states
    └── PairedDeviceList.tsx          [NEW] per-device revoke buttons
```

- Reuses the exact seed-reveal "high friction" modal language already proven in
  `KeysManager.tsx:616-713` (typed confirmation + countdown) for any "unlock seed for
  mobile transit" step.
- Crypto scaffolding mirrors the graduation transit that is already shipped
  (`vault.rs:unseal_graduation_export`, X25519 + HKDF + AES-256-GCM, `x25519-dalek` is
  already a dependency `Cargo.toml:49`). New HKDF info domain
  `b"iyou-home/pair/v1"` must be byte-fixed alongside `GRADUATION_HKDF_INFO`
  (`vault.rs:415`).
- QR code renderer needs a new dependency (Rust `qrcode` crate **or** npm `qrcode`).
  Neither exists today. Recommend Rust `qrcode`, exposing QR PNG bytes via the pairing IPC
  so the key never touches JS.

---

## 2. Necessary Tauri IPC Commands

### 2.1 Local Blossom blobs (new `blossom.rs` helpers + `lib.rs` commands)

| Command | Signature | Implementation notes |
|---|---|---|
| `list_local_blobs` | `() -> Vec<LocalBlobInfo>` | Walk `{app_data}/blobs/`, `fs::metadata` for `size_bytes`/`modified_at`, `SystemTime→created_at`; make `blossom::detect_mime_type` `pub` and reuse for `mime_type`. `LocalBlobInfo { sha256, size_bytes, mime_type, created_at }`. |
| `read_local_blob` | `(sha256) -> Vec<u8>` | Fail-closed: regex-validate 64-hex (reuse `is_valid_hash`, `blossom.rs:219`), reject path traversal. Returns bytes for small media; large files should use the `:9002` fetch path instead. |
| `delete_local_blob` | `(sha256) -> bool` | Requires new `handle_delete` route + `Method::DELETE` in the CORS allow list. |
| `get_local_blobs_count` | `() -> u64` | Thin wrapper for status bar (replaces `count_files_in_dir` heuristic at `lib.rs:1753`). |

All of these touch only the blob directory — **no key material crosses FFI**.

### 2.2 Encrypted seed pairing frames (new `pairing.rs` + commands)

| Command | Signature | Implementation notes |
|---|---|---|
| `pair_begin` | `() -> PairFrame` | Generate ephemeral X25519 keypair (keep private in Rust `Mutex`/store keyed by `frame_id`, 5-min TTL). Return `{ frame_id, x25519_pub_hex, verification_code, qr_png_b64, expires_at }` — seed never in plaintext. |
| `pair_seal_seed_for_device` | `(frame_id, device_x25519_pub_hex, purpose) -> Vec<u8>` | X25519 ECDH → HKDF(info=`b"iyou-home/pair/v1"`, salt=nonce) → AES-256-GCM seal of the 32-byte root seed + device DID binding as AAD. Returns **sealed bytes only** — same pattern as `export_vault_backup` (`vault.rs:315-325`). |
| `pair_confirm` | `(frame_id, signed_mobile_envelope) -> DeviceRecord` | Verify mobile signature over the frame nonce, bind device DID, persist to `pairing.json` (atomic write matching the `contacts.json` pattern `contacts.rs:159-167`), emit `app.emit("pair://status", …)`. |
| `pair_list_devices` | `() -> Vec<DeviceRecord>` | `{ device_id, device_did, name, paired_at, last_seen_at }`. |
| `pair_revoke_device` | `(device_id) -> bool` | Marks device tombstone; future sealed frames for that device are refused. |

### 2.3 Chat / XMPP surface (scaffolding)

| Command | Signature | Notes |
|---|---|---|
| `get_chat_session_credentials` | `() -> { jid, wss_url }` | Returns L1 persona DID as JID + `wss://home.iyou.me:5222`. **Do not return the `xmpp_password.txt` secret to JS** — instead have the Rust side negotiate the PLAIN handshake, or return the DID-derived hex which is already public (prosody accepts it as password, `prosody.rs:315-319`). |
| `list_omemo_devices` | `(peer_jid) -> Vec<OmemoDevice>` | Reads prekey/session store (new `omemo.rs`). |
| `chat_message_sent` / events | push | Rust emits `app.emit("chat://message", payload)`; React subscribes via `@tauri-apps/api/event` — the existing pattern `WsSignPopup` uses for bridge frames. |

**Bug to fix while touching this area:** register `write_binary_file` / `read_binary_file`
(or migrate to `tauri-plugin-fs`) — currently invoked from `KeysManager.tsx:201,241`
but absent from `lib.rs:1988-2037`, forcing fragile browser fallbacks.

---

## 3. Proposed `TODO.md` Updates (new phases, appended after Phase 5)

```markdown
### Phase 6: Enclave Chat — OMEMO/XMPP Scaffold
- [ ] **6.1** Expose `prosody.rs` DID↔hex helper as a shared pub fn; add `get_chat_session_credentials` IPC
- [ ] **6.2** Add PNA pre-flight headers to the XMPP-over-WS upgrade path (`prosody.rs:handle_xmpp_ws_connection`)
- [ ] **6.3** Fix server-side message routing (roster target `to=` instead of self-echo `prosody.rs:368-377`)
- [ ] **6.4** New `omemo.rs`: device list + signed prekey exchange stored in rusqlite (reuse `nostr_relay.rs` DB pattern)
- [ ] **6.5** New frontend: `PeerChat.tsx` + `xmppClient.ts` embedded in `ContactList.tsx` (chat icon per row), bound to L1 persona only
- [ ] **6.6** First-contact fingerprint verification modal; OMEMO session establishment per peer
- [ ] **6.7** Tests: XMPP PLAIN auth round-trip, stanza routing, OMEMO device list serialize/deserialize

### Phase 7: Offline Blossom Media Browser
- [ ] **7.1** Make `detect_mime_type` pub; add `list_local_blobs` / `read_local_blob` / `delete_local_blob` IPC
- [ ] **7.2** Add `DELETE /:hash` route + `Method::DELETE` CORS to `blossom.rs`
- [ ] **7.3** `BlossomBrowser.tsx` card in `ServiceSwitchPanel.tsx` below Sync card (§RELEASE_SPEC 3.4.2)
- [ ] **7.4** Thumbnail grid + detail drawer (loopback fetch to :9002), copy sha256/URL, delete
- [ ] **7.5** Replace `count_files_in_dir` heuristic in `get_sync_status` with `get_local_blobs_count`
- [ ] **7.6** Tests: dir-less/empty store, mixed mime detection, oversized-hash rejection

### Phase 8: Vault Mobile Pairing — QR Handshake
- [ ] **8.1** Add `qrcode` crate (Rust); new `pairing.rs` with `pair_begin`/`pair_seal_seed_for_device`/`pair_confirm`/`pair_list_devices`/`pair_revoke_device`
- [ ] **8.2** Define HKDF info `b"iyou-home/pair/v1"` and wire-format envelope (`iyouhome://pair?x25519=…&nonce=…&ver=1`)
- [ ] **8.3** New `DevicePairing.tsx` section in `KeysManager.tsx` between Redundancy callout and Backup section
- [ ] **8.4** Pairing lifetime counting: frames expire at 5 min; sealed frames refuse revoked devices
- [ ] **8.5** Register `write_binary_file`/`read_binary_file` (or migrate to `tauri-plugin-fs`) — fixes backup fallback bug
- [ ] **8.6** Tests: seal/transit verify mirror of `test_reveal_master_seed_matches_decoded_root_seed` style coverage
```

### Standing Security Backlog additions
```markdown
- [ ] **SEC-007** — XMPP `xmpp_password.txt` is a shared local secret; evaluate per-client
      ephemeral creds or DID-bound SASL-EXTERNAL so the generated 24-char password is never
      exposed to JS.
- [ ] **SEC-008** — Enforce L0 Anchor exclusion from `get_chat_session_credentials` and pairing
      seal targets (mirror the bridge air-gap guard in `AGENT.md` §1.4).
```

---

## 4. Proposed `docs/RELEASE_SPEC_V2.md` Updates

1. **§2.1 Persistent Status Bar:** add "Chat `:5222`" dot to the daemon indicator row
   (matches `GlobalStatusBar.tsx:144` which already omits Chat) and document the 
   `list_local_blobs` count in the sync label.
2. **§3.1.2 Contact Enclave:** add a "💬 Open Chat" row action; document that chat binds to
   the **Level 1 persona** for every peer tier and that L0 peer keys remain masked inside
   the chat composer.
3. **§3.4 Services (new sub-sections):**
   - 3.4.4 `BlossomBrowser` — offline local media vault listing `{sha256, size_bytes,
     mime_type, created_at}` backed by `list_local_blobs`; delete routed through
     `DELETE /:hash`.
   - 3.4.5 XMPP Chat — WSS `:5222`, RFC 7395 framing, PLAIN auth with DID-derived hex,
     PNA pre-flight requirement, L1-only binding.
4. **§3.3 Vault & Recovery — new subsection 3.3.3 Mobile Device Pairing:** QR handshake
   flow (pair → seal → transit → verify), 5-min frame TTL, per-device revocation, HKDF
   info constant `iyou-home/pair/v1`, sealed-frame-only rule (seed never leaves Rust as
   plaintext — consistent with `§2.1` of `HOME_DEVELOPER_GUIDE.md`).
5. **§4 / Appendix A File Inventory:** add rows for `src-tauri/src/pairing.rs`,
   `src-tauri/src/omemo.rs`, `src/components/enclave/PeerChat.tsx`, `src/lib/xmppClient.ts`,
   `src/lib/omemoSession.ts`, `src/components/BlossomBrowser.tsx`,
   `src/components/DevicePairing.tsx`, and `src-tauri/src/lib.rs` (new IPC registrations).
6. **§7 Testing & Verification Checklist:** append rows for XMPP auth round-trip, chat
   PNA pre-flight, `list_local_blobs` on empty/non-empty store, and pair seal/transit
   round-trip (mobile decrypt → verify → revoke).

---

## 5. Sequencing & Dependency Order

1. **Fix the foundation first:** register `write_binary_file`/`read_binary_file`; add PNA to
   the XMPP WS upgrade; make `detect_mime_type` pub. Each is a 1-file, low-risk change that
   unblocks the rest.
2. **Phase 7 (Blossom Browser)** is the cheapest to ship — no new crypto, pure IPC + UI
   over an existing daemon. Good first increment.
3. **Phase 8 (Pairing)** reuses graduation-crypto patterns (`vault.rs:410-439`) and needs
   only one new crate (`qrcode`).
4. **Phase 6 (OMEMO Chat)** is the largest: server routing + OMEMO + WebSocket client +
   PNA. Its crypto and session-store scaffolding (`omemo.rs`) can land independently of the
   UI, paralleled against Phases 7–8.

---

## 6. Invariant Compliance Checklist (must hold while scaffolding)

- [ ] Seeds/private keys never cross FFI — pairing seals frames, never returns raw seed.
- [ ] New daemons/endpoints bind `127.0.0.1` only (pairing is IPC-only, not a socket).
- [ ] Chat/pairing surface for Level 0 Anchor is structurally blocked.
- [ ] All new store files (`pairing.json`) use `.tmp` staging + `sync_all()` + quarantine
  (pattern: `contacts.rs:159-167`, `vault.rs` atomic helpers).
- [ ] Blob listing rejects non-hex paths (reuse `is_valid_hash` fail-closed guard).