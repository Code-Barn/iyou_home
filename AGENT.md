# AGENT.md — Project Zero Architecture & Invariants

This document serves as the canonical system reference for the `iyou_home` sovereign identity hub and Personal Data Store (PDS) enclave.

---

## 1. System Role & Core Invariants

`iyou_home` is a zero-custody, local-first identity enclave and background service switchboard built on Tauri v2 and Rust. It secures private key seeds, manages persona derivations, orchestrates local P2P microservices, and serves cryptographic signatures over a secure local WebSocket bridge (`127.0.0.1:9001`).

### 1.1 Identity Derivation Hierarchy

Identity keys are derived deterministically from a single 32-byte cryptographic root seed:
- **Ed25519 DID Key**: `SHA-256(root_seed || LE(derivation_index))`
- **Nostr secp256k1 Key**: `SHA-256("secp256k1-nostr" || root_seed || LE(derivation_index))`

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

#### Hierarchy Invariants:
1. **Level 0 (Anchor Sanctum — Index 0)**:
   - Reserved exclusively for private root P2P containment, high-assurance introductions, and selective disclosure signing.
   - **Air-Gap Invariant**: Level 0 profiles are completely filtered out and blocked from external public pickers, standard UI dropdowns, and browser-initiated WebSocket signing requests.
   - `is_system_reserved = true`, `level = 0`, `derivation_index = 0`.
2. **Level 1 (Public Persona — Index 1)**:
   - Default persona for social broadcasting, public Nostr relays, W3C Verifiable Credentials, and external authentication challenges.
   - Initialized automatically at bootstrap with `profile_id: "primary"`.
   - Returned by default by `public_persona()` and pre-gate `get_profile` bridge queries.
3. **Level 2+ (Contextual Burners — Index 2+)**:
   - Disposable, topic-specific identities for isolating interactions without linking to Level 1 or Level 0.
   - Can be freely created (`add_profile`) and deleted (`remove_profile`).

### 1.2 Structural Deletion Guards
- Backend deletion (`remove_profile`) structurally rejects any target where `is_system_reserved == true || derivation_index == 0 || level == 0`.
- Deleting the currently active custom persona automatically falls back to resetting the active profile pointer to Level 1 Primary (`"primary"`).

### 1.3 Persistence Safety & Anti-Corruption Engine
- **Atomic Staging**: All file writes (`vault.json`, `contacts.json`, `preferences.json`, `auto_start.json`) write to a `.tmp` file, execute `sync_all()`, and perform an atomic filesystem rename.
- **Corrupt File Auto-Quarantine**: If a store file fails to parse, it is never silently overwritten. The corrupted file is renamed to `{filename}.corrupt_{timestamp}.bak` (retaining up to 5 newest backups), and an explicit error is surfaced.

---

## 2. WebSocket Bridge Protocol (Port 9001)

The Signature Bridge binds exclusively to `127.0.0.1:9001` with TLS termination (`wss://home.iyou.me:9001`).

```
Browser / Satellite App                   iyou_home Rust Bridge (:9001)
         │                                            │
         │─── OPTIONS (PNA Pre-flight) ──────────────>│
         │<── 200 OK (PNA headers) ───────────────────│
         │                                            │
         │─── GET (Upgrade: websocket) ──────────────>│
         │<── 101 Switching Protocols ────────────────│
         │                                            │
         │─── get_profile ───────────────────────────>│
         │<── profile_sync (Level 1 Primary Only) ────│
         │                                            │
         │─── RESOLVE_PEER_ALIASES [pubkeys] ────────>│
         │<── peer_aliases_resolved (Minimal) ────────│
         │                                            │
         │─── POLY_CREDENTIAL_REQUEST ───────────────>│
         │                                            │──> PopupGuard acquire
         │                                            │──> React Approval Modal
         │                                            │<── User Approves
         │<── POLY_CREDENTIAL_PRESENTATION (VP) ──────│
```

### 2.1 Pre-Gate Queries
- **`get_profile`**: Returns public persona metadata (`did`, `nostr_pubkey_hex`, `derivation_index`). Never returns Level 0 Anchor.
- **`RESOLVE_PEER_ALIASES`**:
  - Read-only exact-match lookup against `contacts.json`.
  - Harvesting Guard: Capped at `MAX_RESOLVE_KEYS = 256` keys per frame.
  - Minimal Privacy Projection: Returns `{ matches: { "<key>": { "nickname": "...", "trust_level": "...", "badge": "..." } }, "unknown": [...] }`.
  - Secret Adjacency Guard: Loads only `contacts.json`; never touches `vault.json` or root seed material.

### 2.2 User-Gated Signing Flows
- **`sign`**: Signs an OIDC/VP challenge string; returns signed Verifiable Presentation.
- **`sign_event`**: Signs NIP-01 Nostr event using secp256k1 Schnorr (`k256::schnorr::SigningKey::sign_raw` over single SHA-256 prehash).
- **`sign_credential`**: Issues a W3C Verifiable Credential.
- **`POLY_CREDENTIAL_REQUEST`**: Credential presentation handshake. Filters matching vault credentials, orders by validity/fidelity, issues a Verifiable Presentation with `PopupGuard` anti-trample concurrency control, and returns `POLY_CREDENTIAL_PRESENTATION`.

### 2.3 Headless Auto-Signing Flow
- **`OMNI_SIGN_REQUEST` (`POLY_V2`)**: Canonicalizes payload (`poll_id`, `option_id`, `timestamp`), hashes with SHA-256, signs with Ed25519, and returns a Nostr Kind 1112 envelope directly without user popups.

---

## 3. Contact Enclave & Trust Tiers

Stored in `{app_data}/contacts.json`, completely isolated from key storage.

### 3.1 Trust Tiers
| Trust Level | Wire Token | Badge Label | UI Theme | Intended Scope |
|---|---|---|---|---|
| `level0` / `Level0` | `"Level0"` | **Inner Circle** | Violet / Crimson | Air-gapped peers, cryptographic anchors |
| `level0_5` / `Level0_5` | `"Level0_5"` | **Trusted Alliance** | Emerald Green | Vouched collaborators, ecosystem nodes |
| `level1` / `Level1` | `"Level1"` | **Peer** | Slate Gray | Standard public contacts |

### 3.2 Selective Disclosure Cards
- **Generation**: User selects signing persona (Level 0 or Level 1), target peer DID, trust tier, and checks off personas/aliases to include. Issues a signed Verifiable Credential (`SelectiveDisclosureCard`).
- **Import**: Validates the cryptographic signature on the disclosure card using `did_rust::verify_vc`, extracts subject DID and aliases, and upserts into `contacts.json`.

---

## 4. Tauri IPC Command Reference

### Vault & Persona Management
| Command | Arguments | Return | Description |
|---|---|---|---|
| `generate_did` | — | `String` | Bootstraps dual identities (Level 0 Anchor + Level 1 Primary) from fresh root seed |
| `import_did` | `did`, `private_key` | `()` | Imports an existing identity from base58 seed |
| `get_active_did` | — | `Option<String>` | Returns active DID (defaults to Level 1 Primary) |
| `list_profiles` | — | `Vec<Profile>` | Lists all personas including level and derivation indices |
| `add_profile` | `profile_name` | `Profile` | Derives new Level 2+ burner persona at next unused index |
| `set_active_profile` | `profile_id` | `()` | Sets active profile and persists to `preferences.json` |
| `remove_profile` | `profile_id` | `()` | Deletes persona (blocked on Level 0 / Anchor) |
| `sign_auth_challenge` | `challenge`, `did_id`, `profile_id` | `String` | Signs authentication challenge |
| `get_public_did_document` | `did` | `String` | Resolves public DID document |

### Contact Enclave & Selective Disclosure
| Command | Arguments | Return | Description |
|---|---|---|---|
| `list_contacts` | — | `Vec<PeerContact>` | Loads all contacts from `contacts.json` |
| `upsert_contact` | `contact` | `PeerContact` | Inserts or updates contact by `peer_id`, dedupes aliases |
| `delete_contact` | `peer_id` | `()` | Removes contact from `contacts.json` |
| `generate_disclosure_card` | `profile_id`, `target_peer_did`, `display_name`, `disclosed_aliases`, `tier` | `String` | Generates and signs a Verifiable Disclosure Card |
| `import_disclosure_card` | `disclosure_json` / `card_json` | `PeerContact` | Cryptographically verifies and imports peer card |
| `resolve_peer_aliases` | `pubkeys` | `Value` | IPC counterpart for alias lens resolution |

### Credentials & Governance
| Command | Arguments | Return | Description |
|---|---|---|---|
| `save_credential` | `profile_id`, `vc_json` | `()` | Verifies and stores VC in persona credentials |
| `get_credentials` | `profile_id` | `Vec<VaultCredential>` | Returns stored credentials for a profile |
| `delete_credential` | `profile_id`, `vc_id` | `()` | Deletes credential from profile |
| `sync_vote_records` | `records` | `()` | Ingests poll vote records to `poll_ledger.json` |
| `get_vote_history` | — | `Vec<VoteRecord>` | Returns local poll voting audit trail |
| `calculate_vote_merkle_root` | `records` | `String` | Computes SHA-256 Merkle root for cold governance |
| `sync_poll_ledger` | `poll`, `records` | `String` | Offline timeline validation & Merkle checkpoint |

---

## 5. Verification & Test Commands

### Backend Rust Tests
```bash
cd src-tauri
cargo test
```
*Current test suite: 41 unit tests covering vault derivation, deletion guards, Merkle roots, timeline validation, and contact persistence.*

### Frontend Vitest Tests
```bash
npx vitest run
```
*Current test suite: 22 unit tests covering `ProjectZero`, `PersonaMatrix`, `ContactList`, `DisclosureModal`, `TrustAssets`, and `enclaveFilters`.*

### Production Build Verification
```bash
npm run build
```
*Executes `tsc` typecheck and `vite build` asset bundling.*
