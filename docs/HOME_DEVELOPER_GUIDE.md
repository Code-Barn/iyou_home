# Developer Guide — iyou_home (v0.2.2 Sovereign Release)

This guide provides technical specifications, architecture patterns, cryptographic invariants, vault lifecycle state machines, Tauri IPC commands (RFC-001…RFC-006), wire protocol contracts, and subsystem manuals for the `iyou_home` sovereign identity hub and Personal Data Store (PDS).

For the operational contract, security invariants, and complete IPC registry, see [`AGENT.md`](../AGENT.md). Full architectural specifications live in [`docs/specs/`](specs/). For external satellite development, see the canonical [`docs/ecosystem_shared/DEVELOPER_TRANSLATION_MANUAL.md`](ecosystem_shared/DEVELOPER_TRANSLATION_MANUAL.md) (`OMNI-DEV-MANUAL-V1`).

---

## 1. Getting Started

### 1.1 Prerequisites
- **Rust & Cargo**: `>= 1.78.0`
- **Node.js & npm**: `>= 20.x`
- **Tauri v2 CLI & Prerequisites**: See [Tauri v2 documentation](https://v2.tauri.app/start/prerequisites/)

### 1.2 Development Boot
```bash
# Install frontend dependencies
npm install

# Launch Tauri v2 desktop application with live reload
npm run tauri dev
```

### 1.3 Verification & Test Commands
```bash
# Execute full backend Rust test suite (176 tests)
cargo test --manifest-path src-tauri/Cargo.toml

# Run TypeScript typecheck & production bundle build
npx tsc --noEmit && npm run build

# Run Vitest test runner (139 unit tests across 18 test files)
npx vitest run
```

---

## 2. Cryptographic Architecture & Derivation Engine

`iyou_home` employs a Level 2 Sovereign Enclave posture. All cryptographic keys derive deterministically from a single 32-byte master root seed. **Private key bytes never cross the FFI boundary or enter the JavaScript runtime.**

### 2.1 Dual-Curve Deterministic Derivation

Every persona profile derived at index $i$ deterministically generates both Ed25519 and secp256k1 keypairs:

$$\text{Ed25519 Seed}_i = \text{SHA-256}(\text{root\_seed} \parallel \text{LE32}(i))$$
$$\text{secp256k1 Seed}_i = \text{SHA-256}(\text{"secp256k1-nostr"} \parallel \text{root\_seed} \parallel \text{LE32}(i))$$

| Curve / Purpose | Derivation Prefix / Formula | Multibase / Encoding | Typical Use Case |
|---|---|---|---|
| **Ed25519 (W3C DID)** | `SHA-256(root_seed \|\| LE(index))` | `did:key:z6Mk...` | OIDC challenges, W3C VCs/VPs, poll votes, session revocation, OMEMO identity signatures |
| **secp256k1 (NIP-01)** | `SHA-256("secp256k1-nostr" \|\| root_seed \|\| LE(index))` | 64-char lowercase hex | Nostr event signatures (BIP-340 Schnorr `sign_raw`), Prosody SASL password |

### 2.2 Persona Hierarchy & Air-Gap Invariants

```
                     ┌────────────────────────────────┐
                     │   32-byte Root Master Seed     │
                     └───────────────┬────────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           ▼                         ▼                         ▼
  Derivation Index #0       Derivation Index #1       Derivation Index #2+
┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│ Level 0: Anchor       │ │ Level 1: Primary      │ │ Level 2+: Burners     │
│ profile_id: "anchor"  │ │ profile_id: "primary" │ │ Contextual / Sockets  │
│ 🛡️ Air-Gapped Sanctum │ │ 👤 Public Persona     │ │ 🎭 Disposable Anons   │
│ is_system_reserved: true│ │ Default Active Signer │ │ Deletable             │
└───────────────────────┘ └───────────────────────┘ └───────────────────────┘
```

1. **Level 0 Anchor Sanctum (`index: 0`, `profile_id: "anchor"`)**:
   - `is_system_reserved: true`, `level: 0`.
   - **Air-Gap Invariant**: Excluded from external WebSocket signing requests, public persona dropdowns, chat JID bindings, and social broadcasting. Used strictly for high-assurance root introductions, selective disclosures, and air-gapped identity anchoring.
   - Deletion is structurally rejected by backend guards.
2. **Level 1 Public Persona (`index: 1`, `profile_id: "primary"`)**:
   - `is_system_reserved: false`, `level: 1`.
   - Default active persona for social broadcasting, Nostr events, W3C credentials, XMPP chat sessions, and browser signing challenges.
3. **Level 2+ Contextual Burners (`index: 2+`)**:
   - Disposable, context-isolated identities created dynamically (`add_profile`) and deleted at will (`remove_profile`).

### 2.3 Break-Glass Emergency Persona Rotation

If the Level 1 Public Persona is compromised or needs retirement:
1. `rotate_primary_persona` tombstones the existing primary:
   - Sets `profile_id: format!("retired_primary_{}", old_index)`
   - Changes `level = 2` (tombstoned burner)
2. Derives a fresh Level 1 Public Persona at $N = \max(\text{indices}) + 1$.
3. Preserves the Level 0 Anchor and all other contacts/credentials intact.

---

## 3. Vault Lifecycle & Daemon Dormancy (RFC-001)

### 3.1 Canonical Four-State Machine

`vault.json` is a `base64( JSON(VaultStore) )` envelope persisted atomically (`.tmp` + rename). Every greenfield install flows through the first-run gateway; **no code path silently creates a vault**.

| State | Disk condition | Meaning |
|:---|:---|:---|
| `Uninitialized` | no `vault.json` | Greenfield. The gateway must run; only `generate_did` / `bootstrap_from_seed` / `restore_vault_backup` may create a vault. |
| `Provisioning` | `vault.json` present | Vault is valid on disk but the cold-seed ceremony is incomplete (`preferences.seed_backup_confirmed == false`). |
| `Ready` | `vault.json` valid | Vault loaded and ceremony complete; main tabs render; daemons bind. |
| `Quarantined` | `vault.json.corrupt_<ts>.bak` | Load/parse failure moved the file aside (5 rotated backups kept). **Never auto-healed**, never regenerated. |

### 3.2 Legal Transitions

| From | To | Trigger | Guard (fail-closed) |
|:---|:---|:---|:---|
| `Uninitialized` | `Provisioning` | `generate_did` / `bootstrap_from_seed` / `restore_vault_backup` | Refuses if `vault.json` exists; atomic write. |
| `Provisioning` | `Ready` | `set_seed_backup_confirmed(true)` → `onInitialized()` → `start_ready_services` | Ceremony proof must pass first. |
| `Ready` | `Provisioning` | Reload with `seed_backup_confirmed == false` | Legacy `FirstRunSeedGate` overlay as recovery path. |
| `Ready` / `Provisioning` | `Quarantined` | `load_vault_from_path` fails (base64 / JSON / schema) | File renamed to `vault.json.corrupt_<UNIX>.bak`. |
| `Quarantined` | any | **FORBIDDEN** | Terminal warning screen; recovery only from backup/seed on a fresh install. |

### 3.3 Wire Projection

The canonical machine has four states, but the `VaultStatus` enum serialized over IPC is a three-value projection: `"Uninitialized" | "Ready" | "Corrupt"` (`[serde(rename_all = "PascalCase")]`). `Provisioning` is *derived* by the frontend by combining `get_vault_status` with the persisted `preferences.seed_backup_confirmed` flag. A v0.3 wire-breaking rename of `"Corrupt"` → `"Quarantined"` is already balloted in RFC-001 §4.3 with a one-release serde alias.

| Canonical state | `get_vault_status` IPC | `seed_backup_confirmed` | Frontend surface |
|:---|:---|:---|:---|
| `Uninitialized` | `"Uninitialized"` | n/a | Gateway landing |
| `Provisioning` | `"Ready"` | `false` | Gateway ceremony (`gatewayActive`) or legacy `FirstRunSeedGate` on reload |
| `Ready` | `"Ready"` | `true` | Main tabs |
| `Quarantined` | `"Corrupt"` | n/a | Terminal warning screen |

### 3.4 Daemon Dormancy Rules

**No loopback daemon binds or spawns before the vault is `Ready`.** The Signature Bridge (`:9001`) is "alwaysOn" but its spawn is deferred until `start_ready_services` runs; auto-start preferences take effect only for `Ready` vaults.

| # | Rule | Enforcement point |
|:---|:---|:---|
| D1 | No daemon may bind or spawn while `vault_status != Ready`. | `setup()` auto-start loop + bridge spawn gated on `Ready` (`lib.rs`). |
| D2 | `generate_did` / `import_did` are the *only* bootstrap call sites; all other init paths use read-only `load_vault`. | Nostr arm, `l1_persona_jid`, `create_vault_backup`; Nestr arm defers on `VaultLoadError::NotFound`. |
| D3 | `start_ready_services` is the single entry point that brings up the fleet post-onboarding; it requires `Ready`. | `lib.rs` — returns `Err("Vault is not Ready; refusing to start services")` otherwise. |
| D4 | SigBridge must never double-bind. | `shutdown_signals.contains_key("SigBridge")` guard. |
| D5 | Auto-start preferences only apply to `Ready` vaults. | `setup()` gate. |
| D6 | The gateway never triggers services; `App.handleInitialized` does, after ceremony completion. | `src/App.tsx`. |

---

## 4. Tauri IPC Commands (RFC-001…RFC-006)

All commands below are `#[tauri::command]` functions invoked from the React side via `invoke("command_name", args)`. The tables list commands added or formalized across RFC-001…RFC-006; the complete legacy + current registry lives in [`AGENT.md`](../AGENT.md).

### 4.1 Vault Lifecycle & Onboarding (RFC-001)

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `get_vault_status` | — | `"Uninitialized" \| "Ready" \| "Corrupt"` | Read-only; **never** causes file creation. |
| `bootstrap_from_seed` | `seedPhraseOrHex: string` | Primary DID | Deterministic L0+L1 re-derivation from hex/`0x`-hex/base58 of exactly 32 bytes; refuses to overwrite an existing vault. |
| `start_ready_services` | — | `()` | Ready-gated single entry point; spawns SigBridge + enabled auto-start daemons (Blossom, Nostr, Chat). |

*Related onboarding IPC (pre-existing, part of the gateway flow)*: `generate_did`, `set_seed_backup_confirmed`, `restore_vault_backup`, `reveal_master_seed`, `import_did`.

### 4.2 Compliance & Age Gate (RFC-004)

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `classify_age` | `birthMonth: u8, birthYear: u16` | `"child" \| "teen" \| "adult"` | Neutral gate computes the three-tier bracket (`AgeTier`); raw month/year stay local-only. Automatically applies teen protective defaults (`mutual_contacts_only_dm: true`, `restricted_feed_indexing: true`, `public_persona_broadcast: false`). |
| `get_age_tier` | — | `Option<AgeTier>` | Sealed bracket read back from `preferences.json` (`age_gate`), never the raw dates. |
| `record_disclaimer_audit` | `entry: DisclaimerAuditEntry` | `()` | Appends to the append-only `disclaimer_audit.json`; the enclave seals `entry_id`, `device_id` (anon 8-hex), and `presented_did` — client-supplied identity fields are never trusted. |

### 4.3 Invites & Capabilities (RFC-002)

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `create_invite_token` | `tier, maxUses: u32, validDays: u64, scope: string[], satelliteId?` | `InviteCapabilityToken` | L1-signed admission capability; enforces issuance policy (Admin unlimited / Member vetted max 3 per 30 days / Guest rejected); fails closed while the enclave is locked. |
| `list_invites` | — | `Vec<InviteRecord>` | Newest first, each with a computed status pill. |
| `revoke_invite` | `nonce: string` | `()` | Tombstones the nonce + graph edge in `invites.db`; refuses unknown nonces (fail-closed). |
| `validate_invite_token` | `tokenJson: string, presentingDid: string` | `ValidationResult` | Admission-gate preview: schema → expiry → signature → revocation → use budget → replay/self-claim, returning the RFC-002 denial code (`INVALID`, `EXPIRED`, `USED`, `REVOKED`) on failure. |
| `get_issuer_status` | — | `IssuerStatus` | Returns the active L1 DID's role (`Admin`, `Member`, `Guest`), quota allowance, and vetting attributes. |
| `set_issuer_role` | `did: string, role: string` | `()` | Enclave-local administrative role assignment in `invites.db`. |
| `render_invite_qr` | `tokenJson: string` | `String` (data URL) | Generates QR code matrix data URL for direct mobile invite ingestion. |

### 4.4 Moderation & Admin (RFC-003)

All `admin_*` commands require `require_admin()` authorization (non-admins receive an error). `satellite_id` is accepted for routing but admin action is enclave-local.

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `admin_probe` | `satelliteId` | `AdminProbeResult` | Authorization probe (`authorized`, `admin_did`, scoped `satellite_id`). |
| `admin_list_members` | `satelliteId` | `Vec<MemberRecord>` | Member directory projected from the RFC-002 invite graph. |
| `admin_list_bans` | `satelliteId` | `Vec<BanRecord>` | Active (non-expired, non-soft-deleted) ban rows from `moderation.db`. |
| `admin_list_actions` | `satelliteId, limit?: u32` | `Vec<ModerationAction>` | Append-only `moderation_actions` audit trail (default limit 100). |
| `admin_sever` | `satelliteId, targetDid` | `u32` | Severs live connections for the DID via typed termination frames; returns the severed count. |
| `admin_ban` | `satelliteId, targetDid, reason, scope, expiresAt?, pruneBranch, purgeContent, evidenceHashes: string[]` | `BanReport` | Immutable ban row + live sever + kind:1604 announcement; prune/purge flags control content handling and recursive invite subtree revocation. |
| `admin_unban` | `satelliteId, targetDid` | `()` | Soft-deleted restore with audit entry. |
| `admin_purge` | `satelliteId, targetDid, cascadeMedia: bool` | `PurgeReport` | T1/T2 event cascade + optional Blossom blob deletion + signed kind:1605 tombstone broadcast. |

### 4.5 Family & Delegations Enclave (RFC-005)

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `bind_child_pod` | `childDid, childPubkey, childDeviceId, custodyStage: u8` | `ChildPodEntry` | Binds metadata + **public keys only** (never a child seed); reuses an existing escrow `pod_id` if one exists for the DID. |
| `generate_pod_escrow_shares` | `podId, custodyStage: u8` | `PodEscrowCeremony` | Mints the child's root seed in-enclave, splits it into **3 Shamir shares**, persists share x=1 in `escrow_store.json`, zeroizes the seed; returns the satellite (x=2) and cold-sheet (x=3) payloads. |
| `create_supervisory_grant` | `podId, capabilities: GrantCapability[], validDays: u64` | `SupervisoryGrant` | Expiring supervisory capability `kind:9114`, JCS-signed with the parent's active L1 Ed25519 key. |
| `revoke_supervisory_grant` | `podId` | `()` | Revokes active grants for the pod. |
| `list_child_pods` | — | `Vec<ChildPodEntry>` | Pod registry from the vault. |
| `emancipate_child_pod` | `podId` | `()` | Two-stage emancipation lifecycle (RFC-005 §5). |
| `verify_and_reconstruct_escrow` | `podId, shareBytesB64: string` | Seed hex | **2-of-3 reconstruction** over GF(2⁸); combines the supplied share with the locally stored share x=1. |
| `generate_transit_keypair` | — | `TransitKeypairPublic` | Ephemeral X25519 transit keypair for graduation handshake; secret held in `TransitState` (zeroized on use). |
| `process_graduation_ingest` | `satelliteEphemPubHex: string, encryptedPayloadHex: string, nonceHex: string` | `GraduationConfirmPayload` | Ingests encrypted child seed during sovereign graduation ceremony. |
| `activate_sovereign_identity` | `receiptJson: string, signature: string` | `PrimaryDid` | Completes graduation and activates the graduated identity as an independent sovereign vault. |

### 4.6 Profile Metadata & Sync (RFC-006)

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `set_profile_metadata` | `profileId?, handle?, displayName?, avatarUrl?, bannerUrl?, bio?` | `Profile` | Scoped write to public profile metadata. Empty/omitted `profileId` → active L1 public persona. Level 0 target → `ERR_AIR_GAP_VIOLATION` (fail-closed, no write). `nip05` always derived (`handle@iyou.me`). After persist, broadcasts `profile_sync` to every Port 9001 client and emits `profile://changed`. |

---

## 5. Wire Protocols & Service Architecture

All local daemons bind strictly to IPv4 loopback `127.0.0.1`.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Local Daemon Switchboard                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Signature Bridge   :9001  (WSS / TLS)  wss://home.iyou.me:9001           │
│ 2. Blossom Media PDS  :9002  (BUD-01)     http://127.0.0.1:9002             │
│ 3. Nostr Ingress Relay:9003  (NIP-01)     ws://127.0.0.1:9003               │
│ 4. Prosody XMPP Mesh  :5222  (RFC 7395)   wss://127.0.0.1:5222/xmpp-ws      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Signature Bridge Protocol (`wss://home.iyou.me:9001`)

The Signature Bridge terminates TLS natively with runtime certificate resolution (`{app_data}/certs/production.crt` and `production.key`) and provides Private Network Access (PNA) header pre-flights:
`Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true`.

Frames are JSON text messages. Every frame carrying a payload is validated before any state mutation — on failure the bridge replies with a typed `error` frame and makes **no change**.

#### Inbound Frame Dispatch Matrix

| Inbound Wire Type | Protocol / Trigger | Response Frame / Action | Security & Enclave Behavior |
|---|---|---|---|
| `ping` | Keepalive | `{"type": "pong"}` | Heartbeat check. |
| `get_profile` | Satellite Connect | `profile_sync` | Returns secret-free `PublicProfileProjection` of active L1 persona. Never exposes Level 0 Anchor. |
| `list_profiles` / `LIST_PERSONAS` | Satellite Selector | `personas_list` | Lists bridge-exposable personas (`level >= 1`, non-anchor, non-reserved). |
| `set_active_profile` / `switch_persona` | Persona Switch | `profile_sync` broadcast | Switches active persona and broadcasts `profile_sync` to all open satellite tabs (RFC-006 §9). |
| `SET_PROFILE_METADATA` | Satellite Profile Claim | `profile_sync` echo + broadcast | Updates public metadata (`handle`, `display_name`, `avatar_url`, etc.), derives NIP-05, persists atomically, and fans out `profile_sync`. Air-gapped from Level 0 (`ERR_AIR_GAP_VIOLATION`). |
| `sign` / `sign_raw` | OIDC / Auth Challenge | `signed` | Acquires `PopupGuard`, prompts user, signs challenge with Ed25519, returns W3C VP. |
| `sign_event` | Nostr NIP-01 | `event_signed` | Prompts user, signs event ID via BIP-340 Schnorr (`sign_raw` over SHA-256 prehash), returns signed Nostr event. |
| `sign_credential` | W3C VCs | `credential_signed` | Prompts user, signs credential subject, returns signed Verifiable Credential. |
| `POLY_CREDENTIAL_REQUEST` | iyou_poly | `POLY_CREDENTIAL_PRESENTATION` | Selects matching credential, orders by fidelity/expiration, prompts user via `PopupGuard`, returns VP. |
| `OMNI_SIGN_REQUEST` (`POLY_V2`) | iyou_poly Headless | `OMNI_SIGN_RESPONSE` | Validates schema, signs ballot hash with Ed25519 without popup, returns Kind 1112 envelope. |
| `RESOLVE_PEER_ALIASES` | Contact Enclave Lens | `peer_aliases_resolved` | Reads `contacts.json` (bounded $1 \le N \le 256$). Returns `{matches, unknown}` without touching root keys. |
| `SYNC_TO_HOME_REQUEST` | Satellite Mirroring | `sync_to_home_completed` | Ingests batch Nostr events into local SQLite (`:9003`), mirrors Blossom media blobs into local storage (`:9002`). |
| `ENCLAVE_DIAGNOSTIC_QUERY` | Diagnostic Probes | `ENCLAVE_DIAGNOSTIC_RESPONSE` | Evaluates daemon statuses, key custody readiness, gossip mesh count, and backup freshness without leaking private keys. |

#### 5.1.1 `SET_PROFILE_METADATA` Ingress (RFC-006)

Claim or update profile metadata for a persona from an external satellite client:

```json
{
  "type": "SET_PROFILE_METADATA",
  "profile_id": "",
  "handle": "@dcbyers13",
  "display_name": "Dan Byers",
  "avatar_url": "http://127.0.0.1:9002/<sha256hex>",
  "banner_url": "https://cdn.iyou.me/banners/b.png",
  "bio": "Independent systems researcher."
}
```

**Resolution Order (RFC-006 §6.1):**
1. **Resolution.** `profile_id` is optional; empty defaults to the active L1 Public Persona. A non-empty id must resolve via `get_profile_by_id`; otherwise `ERR_PROFILE_NOT_FOUND`.
2. **Air-gap guard.** If the resolved persona `is_anchor() || is_system_reserved` → `ERR_AIR_GAP_VIOLATION` (fail-closed, no write).
3. **Normalization.** Trim whitespace on all string fields; strip a single leading `@` from `handle`; validate against `^[a-zA-Z0-9_-]{3,30}$`; compute `nip05 = f"{handle}@iyou.me"` (never client-supplied). Unsupplied fields are left untouched (partial-update semantics).
4. **Atomicity.** Persist `vault.json` via temp file + atomic rename — only after every validation gate passes.
5. **Broadcast.** Fan out `profile_sync` to every active Port 9001 client (the requester included, doubling as echo/ack), then emit `profile://changed` to the iyou_home UI.

The requester receives the same `profile_sync` envelope it caused as the echo:

```json
{
  "type": "profile_sync",
  "profile": {
    "did": "did:key:z6Mk…primary",
    "nostr_pubkey_hex": "02…",
    "handle": "dcbyers13",
    "display_name": "Dan Byers",
    "avatar_url": "http://127.0.0.1:9002/<sha256hex>",
    "banner_url": "https://cdn.iyou.me/banners/b.png",
    "bio": "Independent systems researcher.",
    "nip05": "dcbyers13@iyou.me"
  }
}
```

#### 5.1.2 `profile_sync` Outbound Multi-Client Fan-Out

`profile_sync` is the canonical propagation envelope. `broadcast_profile_sync` (`bridge.rs`) iterates every registered connection in `WsState.broadcast_clients` and sends the serialized frame to each one, **pruning dead connections on send failure** (`retain`). Because the requester is itself a registered client, the fan-out doubles as its ack.

A `profile_sync` frame is dispatched when:
- `SET_PROFILE_METADATA` completes (§5.1.1), or
- the user switches the active persona inside `iyou_home` (`set_active_profile`) — re-anchoring open satellite sessions to the newly active persona (RFC-006 §9).

```json
{
  "type": "profile_sync",
  "profile": {
    "profile_id": "primary",
    "derivation_index": 1,
    "did": "did:key:z6Mk…",
    "nostr_pubkey_hex": "02…",
    "handle": "dcbyers13",
    "display_name": "Dan Byers",
    "avatar_url": "http://127.0.0.1:9002/<sha256hex>",
    "banner_url": null,
    "bio": "Independent systems researcher.",
    "nip05": "dcbyers13@iyou.me"
  }
}
```

Satellites MUST upsert their cache projection (keyed by `did`) and re-render affected header badges, roster labels, and profile cards without reloading the page. Delivery is best-effort: a satellite closed at broadcast time re-hydrates from `get_profile` on its next connect (which returns the same envelope shape).

#### 5.1.3 `ERR_AIR_GAP_VIOLATION` Guard & Error Contract

The Level 0 Anchor is air-gapped from the bridge. `update_profile_metadata` (`vault.rs`) fails closed with `ERR_AIR_GAP_VIOLATION` before any mutation when `derivation_index == 0 || level == 0 || is_system_reserved`. The same invariant holds for reads: `get_profile` and `profile_sync` only ever project the public persona. `bridge_access_denial_reason` additionally blocks external signing for dependents, role identities, and business identities, and **an unloadable vault blocks ALL signing traffic — the bridge never fails open**.

```json
{
  "type": "error",
  "code": "ERR_AIR_GAP_VIOLATION",
  "message": "Level 0 identity is air-gapped from public profile metadata"
}
```

| Code | Condition |
|:---|:---|
| `ERR_AIR_GAP_VIOLATION` | Target persona is Level 0 (`anchor` / `is_system_reserved`). |
| `ERR_PROFILE_NOT_FOUND` | Non-empty `profile_id` does not resolve in the vault. |
| `ERR_INVALID_HANDLE` | Normalized handle fails `^[a-zA-Z0-9_-]{3,30}$`. |
| `ERR_ENCLAVE_LOCKED` | Enclave app-lock engaged; signing/scoped ops fail closed. |
| `ERR_INVALID_FRAME` | Malformed JSON or missing required `type` field. |

#### 5.1.4 No-Secret Invariant Over Port 9001

Bridge frames carry only the `PublicProfileProjection`, which deliberately excludes `credentials` (raw W3C payloads) and the imported private-key leaves (`imported_seed_b58`, `imported_nostr_sk_hex`). No root seed, derived private key, or imported key material ever crosses Port 9001.

---

### 5.2 Prosody XMPP & OMEMO Messaging (`:5222`)

The Messages subsystem provides decentralized, end-to-end encrypted messaging using XMPP over WebSocket (RFC 7395) and OMEMO Double Ratchet encryption.

- **JID Scheme**: `{nostr_pubkey_hex}@127.0.0.1`.
- **SASL Authentication**: Plaintext SASL against embedded Prosody using Level 1 persona hex key.
- **Address Resolution**: Supports npub (`npub1...`), did:key (`did:key:z6Mk...`), raw 64-char hex, and bare JID formats.
- **OMEMO Device Bundles**: Stored in `omemo_store.json`. Each device mints distinct numerical device IDs, an identity key (`Ik`), a signed prekey (`Spk`) signed with Ed25519, and a pool of one-time prekeys (`Opks`).
- **JID Sanitization**: Bare JID localparts MUST be 64-character lowercase hex strings derived via `did_to_pubkey` to satisfy RFC 7622 / XEP-0106 nodeprep rules.

### 5.3 Mobile QR Pairing Protocol (`iyouhome://pair`)

Allows mobile satellite devices to establish an authenticated, encrypted channel to ingest the root master seed.

```
Desktop App (iyou_home)                        Mobile Device (iOS / Android)
        │                                                     │
        │─── Generate Ephemeral X25519 Keypair ───────────────│
        │─── Render QR Code (iyouhome://pair?...) ───────────>│
        │                                                     │
        │<── Mobile Scans QR & Posts Device X25519 Pubkey ───│
        │                                                     │
        │─── ECDH Key Agreement ──────────────────────────────│
        │─── HKDF-SHA256(ikm, salt, info="iyou-home/pair/v1")─│
        │─── AES-256-GCM Seal Root Master Seed ──────────────>│
        │                                                     │
        │<── Mobile Decrypts & Acknowledges Handshake ────────│
        │─── Confirm Registration into pairing.json ──────────│
```

- **Deep Link Schema**: `iyouhome://pair?frame_id={uuid}&x25519={hex}&nonce={hex}&ver=1`
- **HKDF Domain Separation**: `iyou-home/pair/v1`
- **AAD Binding**: `frame_id || device_id || timestamp`

### 5.4 Quick Dispatcher Pipeline

Top-bar `[ ✍️ Dispatch ]` station allowing rapid publishing:
- **Kind 1 (Notes)**: Plaintext / Markdown micro-posts signed via BIP-340 Schnorr.
- **Kind 1063 (File Uploads)**: Media upload to local Blossom BUD-01 server (`:9002`) followed by publishing a Kind 1063 NIP-94 file metadata event.
- **Kind 30023 (Civic Polls)**: Long-form poll parameter definitions containing poll title, choices, closing timestamp, and Blossom Merkle snapshot URI.
- **Dual Broadcast**: Automatically dispatches events to the local loopback relay (`ws://127.0.0.1:9003`) and the configured public gossip mesh (`wss://relay.iyou.me`, `wss://nos.lol`, `wss://relay.damus.io`).

---

## 6. Disaster Recovery & Sovereign Data Redundancy

Identity continuity is anchored across 3 independent redundancy paths:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       3-Tier Sovereign Redundancy                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Local Encrypted Archive (.iyoubackup)                                    │
│    • Password-encrypted container (HKDF-SHA256 + AES-256-GCM)               │
│    • Bundles vault.json, contacts.json, pairing.json, preferences.json,    │
│      and dynamic ledgers directory ({app_data}/ledgers/)                    │
│                                                                             │
│ 2. Self-Hosted Blossom Node (Port 9002)                                     │
│    • Local SHA-256 content-addressed media blob repository                  │
│    • Automatic background mirroring of user uploads and attachments         │
│                                                                             │
│ 3. Decentralized Nostr Relays (Port 9003 & Upstream Mesh)                   │
│    • Signed notes, long-form articles, and social graphs                    │
│    • Reconstructable from public relays using deterministic root seed       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 `.iyoubackup` Container Specification

- **KDF**: `HKDF-SHA256` over the user password with a 16-byte random salt.
- **Cipher**: `AES-256-GCM` with a 12-byte random nonce.
- **Payload Archive**:
  - `manifest.json`: Version metadata, creation timestamp, profile count.
  - `vault.json`: Base64-encoded `VaultStore`.
  - `contacts.json`: Peer contacts and trust levels.
  - `pairing.json`: Paired device registry.
  - `preferences.json`: Active persona and UI settings.
  - `ledgers/*`: All dynamic ledger documents in `{app_data}/ledgers/` (`poll_ledger.json`, civic records).

---

## 7. System Tray & Window Lifecycle

`iyou_home` operates as a persistent desktop daemon:
- **Hide on Close (`WindowEvent::CloseRequested`)**: Closing the main window hides the window rather than terminating the process, allowing background daemons (SigBridge, Blossom, Nostr, Prosody) to continue serving requests uninterrupted.
- **Monochrome Menu Bar Icon**: Configured with macOS `template: true` mode for seamless dark/light menu bar integration.
- **Tray Menu Actions**:
  - `Open Enclave` — Restores and focuses the main window.
  - `Lock App` — Immediately triggers app lock screen guard.
  - `Quit` — Gracefully halts all background daemons and exits.

---

## 8. Service Port & Network Architecture Summary

All local daemons bind strictly to IPv4 loopback `127.0.0.1`. No service ever listens on `0.0.0.0` or public network interfaces.

| Service | Port | Wire Protocol | Binding | Purpose |
|---|---|---|---|---|
| **Signature Bridge** | `9001` | WSS (RFC 6455 over TLS) | `127.0.0.1` | Cross-origin signing and satellite bridge with PNA headers |
| **Blossom Server** | `9002` | HTTP / BUD-01 | `127.0.0.1` | Local SHA-256 media and file blob store |
| **Nostr Relay** | `9003` | WS / NIP-01 | `127.0.0.1` | Local SQLite-backed Nostr event relay |
| **XMPP Mesh** | `5222` | WSS (RFC 7395) | `127.0.0.1` | P2P mesh chat and OMEMO Double Ratchet signaling |
