# iyou_home — Internal Developer Guide (v0.2.2)

This guide is the internal companion for engineers working on the `iyou_home`
sovereign identity enclave. It covers the three areas that shipped in the
v0.2.2 series after the RFC-001…RFC-006 specifications were implemented:

1. [Vault Lifecycle](#1-vault-lifecycle-rfc-001) — the four-state state
   machine and the daemon dormancy rules (RFC-001).
2. [Tauri IPC Commands](#2-tauri-ipc-commands) — the commands added across
   the six RFC implementations, grouped by subsystem.
3. [Port 9001 Bridge Wire Contracts](#3-port-9001-bridge-wire-contracts-rfc-006) —
   the `SET_PROFILE_METADATA` frame, the `profile_sync` fan-out broadcast, and
   the `ERR_AIR_GAP_VIOLATION` guard (RFC-006).

For the operational contract, security invariants, and the **complete** IPC
registry (including legacy commands), see [`AGENT.md`](../AGENT.md). The
full-length specifications live in [`docs/specs/`](specs/), and the external
wire/protocol deep-dive is [`docs/HOME_DEVELOPER_GUIDE.md`](HOME_DEVELOPER_GUIDE.md).

---

## 1. Vault Lifecycle (RFC-001)

### 1.1 Canonical Four-State Machine

`vault.json` is a `base64( JSON(VaultStore) )` envelope persisted atomically
(`.tmp` + rename). Every greenfield install flows through the first-run
gateway; **no code path silently creates a vault**.

| State | Disk condition | Meaning |
|:---|:---|:---|
| `Uninitialized` | no `vault.json` | Greenfield. The gateway must run; only `generate_did` / `bootstrap_from_seed` / `restore_vault_backup` may create a vault. |
| `Provisioning` | `vault.json` present | Vault is valid on disk but the cold-seed ceremony is incomplete (`preferences.seed_backup_confirmed == false`). |
| `Ready` | `vault.json` valid | Vault loaded and ceremony complete; main tabs render; daemons bind. |
| `Quarantined` | `vault.json.corrupt_<ts>.bak` | Load/parse failure moved the file aside (5 rotated backups kept). **Never auto-healed**, never regenerated. |

### 1.2 Legal Transitions

| From | To | Trigger | Guard (fail-closed) |
|:---|:---|:---|:---|
| `Uninitialized` | `Provisioning` | `generate_did` / `bootstrap_from_seed` / `restore_vault_backup` | Refuses if `vault.json` exists; atomic write. |
| `Provisioning` | `Ready` | `set_seed_backup_confirmed(true)` → `onInitialized()` → `start_ready_services` | Ceremony proof must pass first. |
| `Ready` | `Provisioning` | Reload with `seed_backup_confirmed == false` | Legacy `FirstRunSeedGate` overlay as recovery path. |
| `Ready` / `Provisioning` | `Quarantined` | `load_vault_from_path` fails (base64 / JSON / schema) | File renamed to `vault.json.corrupt_<UNIX>.bak`. |
| `Quarantined` | any | **FORBIDDEN** | Terminal warning screen; recovery only from backup/seed on a fresh install. |

### 1.3 Wire Projection

The canonical machine has four states, but the `VaultStatus` enum serialized
over IPC is a three-value projection: `"Uninitialized" | "Ready" | "Corrupt"`
(`[serde(rename_all = "PascalCase")]`). `Provisioning` is *derived* by the
frontend by combining `get_vault_status` with the persisted
`preferences.seed_backup_confirmed` flag. A v0.3 wire-breaking rename of
`"Corrupt"` → `"Quarantined"` is already balloted in RFC-001 §4.3 with a
one-release serde alias.

| Canonical state | `get_vault_status` IPC | `seed_backup_confirmed` | Frontend surface |
|:---|:---|:---|:---|
| `Uninitialized` | `"Uninitialized"` | n/a | Gateway landing |
| `Provisioning` | `"Ready"` | `false` | Gateway ceremony (`gatewayActive`) or legacy `FirstRunSeedGate` on reload |
| `Ready` | `"Ready"` | `true` | Main tabs |
| `Quarantined` | `"Corrupt"` | n/a | Terminal warning screen |

### 1.4 Daemon Dormancy Rules

**No loopback daemon binds or spawns before the vault is `Ready`.** The
Signature Bridge (`:9001`) is "alwaysOn" but its spawn is deferred until
`start_ready_services` runs; auto-start preferences take effect only for
`Ready` vaults.

| # | Rule | Enforcement point |
|:---|:---|:---|
| D1 | No daemon may bind or spawn while `vault_status != Ready`. | `setup()` auto-start loop + bridge spawn gated on `Ready` (`lib.rs`). |
| D2 | `generate_did` / `import_did` are the *only* bootstrap call sites; all other init paths use read-only `load_vault`. | Nostr arm, `l1_persona_jid`, `create_vault_backup`; Nestr arm defers on `VaultLoadError::NotFound`. |
| D3 | `start_ready_services` is the single entry point that brings up the fleet post-onboarding; it requires `Ready`. | `lib.rs` — returns `Err("Vault is not Ready; refusing to start services")` otherwise. |
| D4 | SigBridge must never double-bind. | `shutdown_signals.contains_key("SigBridge")` guard. |
| D5 | Auto-start preferences only apply to `Ready` vaults. | `setup()` gate. |
| D6 | The gateway never triggers services; `App.handleInitialized` does, after ceremony completion. | `src/App.tsx`. |

| Service | Port | Protocol | Bind |
|:---|:---|:---|:---|
| Signature Bridge | `:9001` | WSS | loopback |
| Blossom | `:9002` | HTTP / BUD-01 | loopback |
| Nostr Relay | `:9003` | WS / NIP-01 | loopback |
| XMPP | `:5222` | WSS / RFC 7395 | loopback |

---

## 2. Tauri IPC Commands

All commands below are `#[tauri::command]` functions invoked from the React
side via `invoke("command_name", args)`. The table lists the commands added
or formalized by RFC-001…RFC-006; the full registry (legacy + new) lives in
`AGENT.md`.

### 2.1 Vault Lifecycle & Onboarding (RFC-001)

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `get_vault_status` | — | `"Uninitialized" \| "Ready" \| "Corrupt"` | Read-only; **never** causes file creation. |
| `bootstrap_from_seed` | `seedPhraseOrHex: string` | Primary DID | Deterministic L0+L1 re-derivation from hex/`0x`-hex/base58 of exactly 32 bytes; refuses to overwrite an existing vault. |
| `start_ready_services` | — | `()` | Ready-gated single entry point; spawns SigBridge + enabled auto-start daemons (Blossom, Nostr, Chat). |

Related onboarding IPC (pre-existing, part of the gateway flow):
`generate_did`, `set_seed_backup_confirmed`, `restore_vault_backup`,
`reveal_master_seed`, `import_did`.

### 2.2 Compliance (RFC-004)

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `classify_age` | `birthMonth: u8, birthYear: u16` | `"child" \| "teen" \| "adult"` | Neutral gate computes the three-tier bracket (`AgeTier`); raw month/year stay local-only. |
| `get_age_tier` | — | `Option<AgeTier>` | Sealed bracket read back from `preferences.json` (`age_gate`), never the raw dates. |
| `record_disclaimer_audit` | `entry: DisclaimerAuditEntry` | `()` | Appends to the append-only `disclaimer_audit.json`; the enclave seals `entry_id`, `device_id`, and `presented_did` — client-supplied identity fields are never trusted. |

### 2.3 Invites (RFC-002)

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `create_invite_token` | `tier, maxUses: u32, validDays: u64, scope: string[], satelliteId?` | `InviteCapabilityToken` | L1-signed admission capability; fails closed while the enclave is locked. |
| `list_invites` | — | `Vec<InviteRecord>` | Newest first, each with a computed status pill. |
| `revoke_invite` | `nonce: string` | `()` | Tombstones the nonce + graph edge; refuses unknown nonces (fail-closed). |
| `validate_invite_token` | `tokenJson: string, presentingDid: string` | `ValidationResult` | Admission-gate preview: schema → expiry → signature → revocation → use budget → replay/self-claim, returning the RFC-002 denial code on failure. |

### 2.4 Moderation (RFC-003)

All `admin_*` commands require `require_admin()` authorization (non-admins
receive an error). `satellite_id` is accepted for routing but admin action is
enclave-local.

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `admin_probe` | `satelliteId` | `AdminProbeResult` | Authorization probe (`authorized`, `admin_did`, scoped `satellite_id`). |
| `admin_list_members` | `satelliteId` | `Vec<MemberRecord>` | Member directory projected from the RFC-002 invite graph. |
| `admin_list_bans` | `satelliteId` | `Vec<BanRecord>` | Active (non-expired, non-soft-deleted) ban rows. |
| `admin_list_actions` | `satelliteId, limit?: u32` | `Vec<ModerationAction>` | Append-only `moderation_actions` audit trail (default limit 100). |
| `admin_sever` | `satelliteId, targetDid` | `u32` | Severs live connections for the DID; returns the severed count. |
| `admin_ban` | `satelliteId, targetDid, reason, scope, expiresAt?, pruneBranch, purgeContent, evidenceHashes: string[]` | `BanReport` | Immutable ban row + live sever + kind:1604 announcement; prune/purge flags control content handling. |
| `admin_unban` | `satelliteId, targetDid` | `()` | Soft-deleted restore. |
| `admin_purge` | `satelliteId, targetDid, cascadeMedia: bool` | `PurgeReport` | T1/T2 event cascade + optional Blossom blob deletion + signed kind:1605 tombstone. |

### 2.5 Family & Delegations Enclave (RFC-005)

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `bind_child_pod` | `childDid, childPubkey, childDeviceId, custodyStage: u8` | `ChildPodEntry` | Binds metadata + **public keys only** (never a child seed); reuses an existing escrow `pod_id` if one exists for the DID. |
| `generate_pod_escrow_shares` | `podId, custodyStage: u8` | `PodEscrowCeremony` | Mints the child's root seed in-enclave, splits it into **3 Shamir shares**, persists share x=1 in `escrow_store.json`, zeroizes the seed; returns the satellite (x=2) and cold-sheet (x=3) payloads. |
| `create_supervisory_grant` | `podId, capabilities: GrantCapability[], validDays: u64` | `SupervisoryGrant` | Expiring supervisory capability `kind:9114`, JCS-signed with the parent's active L1 Ed25519 key. |
| `revoke_supervisory_grant` | `podId` | `()` | Revokes active grants for the pod. |
| `list_child_pods` | — | `Vec<ChildPodEntry>` | Pod registry from the vault. |
| `emancipate_child_pod` | `podId` | `()` | Two-stage emancipation lifecycle (RFC-005 §5). |
| `verify_and_reconstruct_escrow` | `podId, shareBytesB64: string` | Seed hex | **2-of-3 reconstruction** over GF(2⁸); combines the supplied share with the locally stored share x=1. |

### 2.6 Profile Sync (RFC-006)

| Command | Args | Returns | Notes |
|:---|:---|:---|:---|
| `set_profile_metadata` | `profileId?, handle?, displayName?, avatarUrl?, bannerUrl?, bio?` | `Profile` | Scoped write to public profile metadata. Empty/omitted `profileId` → active L1 public persona. Level 0 target → `ERR_AIR_GAP_VIOLATION` (fail-closed, no write). `nip05` always derived (`handle@iyou.me`). After persist, broadcasts `profile_sync` to every Port 9001 client and emits `profile://changed`. |

---

## 3. Port 9001 Bridge Wire Contracts (RFC-006)

### 3.1 Transport

The Signature Bridge terminates `wss://home.iyou.me:9001` on loopback
(`127.0.0.1`). Frames are JSON text messages; the handshake sets
`Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network:
true` (PNA pre-flight). Every frame carrying a payload is validated before any
state mutation — on failure the bridge replies with a typed `error` frame and
makes **no change**.

### 3.2 `SET_PROFILE_METADATA` (Ingress from satellite)

Claim or update profile metadata for a persona:

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

**Resolution order (RFC-006 §6.1):**

1. **Resolution.** `profile_id` is optional; empty defaults to the active L1
   Public Persona. A non-empty id must resolve via `get_profile_by_id`;
   otherwise `ERR_PROFILE_NOT_FOUND`.
2. **Air-gap guard.** If the resolved persona `is_anchor() ||
   is_system_reserved` → `ERR_AIR_GAP_VIOLATION` (fail-closed, no write).
3. **Normalization.** Trim whitespace on all string fields; strip a single
   leading `@` from `handle`; validate against `^[a-zA-Z0-9_-]{3,30}$`;
   compute `nip05 = f"{handle}@iyou.me"` (never client-supplied). Unsupplied
   fields are left untouched (partial-update semantics).
4. **Atomicity.** Persist `vault.json` via temp file + atomic rename — only
   after every validation gate passes.
5. **Broadcast.** Fan out `profile_sync` to every active Port 9001 client
   (the requester included, doubling as echo/ack), then emit
   `profile://changed` to the iyou_home UI.

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

### 3.3 `profile_sync` (Outbound Multi-Client Fan-Out)

`profile_sync` is the canonical propagation envelope. `broadcast_profile_sync`
(`bridge.rs`) iterates every registered connection in
`WsState.broadcast_clients` and sends the serialized frame to each one,
**pruning dead connections on send failure** (`retain`). Because the requester
is itself a registered client, the fan-out doubles as its ack.

A `profile_sync` frame is dispatched when:

- `SET_PROFILE_METADATA` completes (§3.2), or
- the user switches the active persona inside `iyou_home`
  (`set_active_profile`) — re-anchoring open satellite sessions to the newly
  active persona (RFC-006 §9).

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

Satellites MUST upsert their cache projection (keyed by `did`) and re-render
affected header badges, roster labels, and profile cards without reloading the
page. Delivery is best-effort: a satellite closed at broadcast time re-hydrates
from `get_profile` on its next connect (which returns the same envelope shape).

### 3.4 `ERR_AIR_GAP_VIOLATION` Guard and the Error Contract

The Level 0 Anchor is air-gapped from the bridge. `update_profile_metadata`
(`vault.rs`) fails closed with `ERR_AIR_GAP_VIOLATION` before any mutation
when `derivation_index == 0 || level == 0 || is_system_reserved`. The same
invariant holds for reads: `get_profile` and `profile_sync` only ever project
the public persona. `bridge_access_denial_reason` additionally blocks external
signing for dependents, role identities, and business identities, and **an
unloadable vault blocks ALL signing traffic — the bridge never fails open**.

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

### 3.5 No-Secret Invariant Over Port 9001

Bridge frames carry only the `PublicProfileProjection`, which deliberately
excludes `credentials` (raw W3C payloads) and the imported private-key leaves
(`imported_seed_b58`, `imported_nostr_sk_hex`). No root seed, derived private
key, or imported key material ever crosses Port 9001.