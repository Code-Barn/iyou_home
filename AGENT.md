# AGENT.md — Project Zero Architecture & Invariants

This document serves as the canonical system reference and root operational contract for the `iyou_home` sovereign identity hub and Personal Data Store (PDS) enclave.

---

## 1. System Role & Core Invariants

`iyou_home` is a zero-custody, local-first identity enclave and background service switchboard built on Tauri v2 and Rust. It secures private key seeds, manages persona derivations, orchestrates local P2P microservices, and serves cryptographic signatures over a secure local WebSocket bridge (`127.0.0.1:9001`).

### 1.1 Non-Negotiable Core Invariants

1. **Zero Raw Key Leakage**:
   - Private keys and root seed entropy never cross the FFI boundary or leave the Rust enclave.
   - The React frontend receives only public DIDs (`did:key:z...`), Nostr public key hex strings, and cryptographically signed envelopes.
2. **Strict Loopback Binding (`127.0.0.1`)**:
   - All local daemons (Signature Bridge `:9001`, Blossom Server `:9002`, Nostr Relay `:9003`, XMPP Mesh `:5222`) bind exclusively to IPv4 loopback `127.0.0.1`.
   - No daemon ever listens on `0.0.0.0`, `[::]`, or public interfaces.
3. **BIP-340 Nostr Signing (`sign_raw`)**:
   - Nostr event IDs are already single SHA-256 hashes of the serialized event. Secp256k1 signing must invoke `k256::schnorr::SigningKey::sign_raw` to prevent double-hashing bugs.
4. **Air-Gapped Tier Isolation**:
   - **Level 0 Anchor** is permanently air-gapped from browser-initiated signing requests and public UI pickers.
   - External WebSocket bridge signing requests can only target **Level 1 Public** or **Level 2+ Burner** personas.
5. **Fail-Closed File Quarantine**:
   - Store files (`vault.json`, `contacts.json`, `preferences.json`, `auto_start.json`) write atomically via staging files (`.tmp`) and `sync_all()`.
   - Corrupt files are never silently overwritten; they are quarantined to `{filename}.corrupt_{timestamp}.bak` (retaining 5 most recent).

---

## 2. Identity Derivation Hierarchy & Persona Matrix

Identity keys are derived deterministically from a single 32-byte cryptographic root seed:
- **Ed25519 DID Key**: $\text{SHA-256}(\text{root\_seed} \parallel \text{LE}(\text{derivation\_index}))$
- **Nostr secp256k1 Key**: $\text{SHA-256}(\text{"secp256k1-nostr"} \parallel \text{root\_seed} \parallel \text{LE}(\text{derivation\_index}))$

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

### 2.1 Persona Tiers
1. **Level 0 (Anchor Sanctum — Index 0)**:
   - Reserved exclusively for private root P2P containment, high-assurance introductions, and selective disclosure signing.
   - `is_system_reserved = true`, `level = 0`, `derivation_index = 0`.
   - Air-gapped from all cross-origin bridge queries.
2. **Level 1 (Public Persona — Index 1)**:
   - Default persona for social broadcasting, public Nostr relays, W3C Verifiable Credentials, and external authentication challenges.
   - Initialized automatically at bootstrap with `profile_id: "primary"`.
   - Supports Break-Glass emergency rotation: tombstones current primary to Level 2 and advances index to $N = \max(\text{indices}) + 1$.
3. **Level 2+ (Contextual Burners — Index 2+)**:
   - Disposable, topic-specific identities for isolating interactions without linking to Level 1 or Level 0.
   - Can be freely created (`add_profile`) and deleted (`remove_profile`).

---

## 3. V2 Application Architecture (6 Tabs)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ iyou_home v2.0  ·  SigBridge 🟢  Nostr 🟢  Blossom 🟢  Sync 🟢  [👤 Primary] │
├─────────────────────────────────────────────────────────────────────────────┤
│ [🛡️ Enclave] [📜 Credentials] [🔑 Vault] [⚙️ Services] [🗳️ Governance] [🧪]│
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. 🛡️ Enclave: Project Zero Persona Matrix, Contact Enclave & Disclosures   │
│  2. 📜 Credentials: W3C VC Repository & Universal JSON/File Import         │
│  3. 🔑 Vault & Recovery: Master Seed Reveal, .iyoubackup & Kill-Switch      │
│  4. ⚙️ Services: Daemon Switchboard (:9001, :9002, :9003, :5222) & Sync     │
│  5. 🗳️ Governance Auditor: Poll Integrity & Cold Merkle Consensus          │
│  6. 🧪 Manual Signer: Raw Challenge Signer (Developer Mode Only)           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **`🛡️ Enclave` (`ProjectZero.tsx`)**:
   - Persona Matrix: Visual tier cards (L0 Anchor, L1 Public, L2+ Burners) with break-glass rotation.
   - Contact Enclave: 3-tier trust badges (`Inner Circle`, `Trusted Alliance`, `Peer`), alias management, and selective disclosure card issuance/import.
   - Sovereign Custody: WebAuthn PRF graduation import.
2. **`📜 Credentials` (`TrustAssets.tsx`)**:
   - W3C Verifiable Credential repository with persona filtering and keyword search.
   - Universal `[ + Import Credential ]` modal with W3C structural validation (`@context`, `type`, `issuer`, `credentialSubject`, `proof`).
3. **`🔑 Vault & Recovery` (`KeysManager.tsx`)**:
   - Master Seed Reveal (typed `REVEAL MY SEED` confirmation, 10s countdown, 30s auto-dismiss).
   - Encrypted `.iyoubackup` export and restore (HKDF-SHA256 + AES-256-GCM).
   - Global Session Revocation Kill-Switch (signs `GLOBAL_SESSION_REVOKE` token dispatched to IdP).
   - Collapsed Danger Zone for manual vault wipe & reset.
4. **`⚙️ Services` (`ServiceSwitchPanel.tsx`)**:
   - Daemon controls: Signature Bridge (`:9001`), Blossom Server (`:9002`), Nostr Relay (`:9003`), XMPP Mesh (`:5222`).
   - Sync-to-Home Local Mirroring Pipeline with live counts and `🔄 Sync Now` action.
5. **`🗳️ Governance Auditor` (`GovernanceAuditor.tsx`)**:
   - Multi-source vote auditor (IPFS CIDs and Blossom BUD-01 snapshots).
   - Local second-preimage resistant SHA-256 Merkle root verification.
6. **`🧪 Manual Signer` (`SovereignSigner.tsx`)**:
   - Raw cryptographic challenge verification gated behind the Developer Mode footer toggle.

---

## 4. WebSocket Bridge Protocol (`wss://home.iyou.me:9001`)

The Signature Bridge terminates TLS natively with runtime certificate loading from `{app_data}/certs/` (or ephemeral fallback in memory).

### 4.1 Inbound Frame Dispatch Matrix

| Inbound Wire Type | Protocol / Application | Enclave Behavior & Response |
|---|---|---|
| `get_profile` | All Satellites | Returns Level 1 Public metadata (`did`, `nostr_pubkey_hex`, `derivation_index`). Never exposes Level 0 Anchor. |
| `RESOLVE_PEER_ALIASES` | Contact Enclave Lens | Reads `contacts.json` (max 256 keys). Returns minimal `{ matches: {...}, unknown: [...] }` without touching root keys. |
| `sign` | OIDC / Auth | Prompts user via `WsSignPopup.tsx`, signs challenge with Ed25519, returns Verifiable Presentation. |
| `sign_event` | Nostr NIP-01 | Prompts user, signs with secp256k1 Schnorr (`sign_raw` over SHA-256 prehash), returns signed Nostr event. |
| `sign_credential` | W3C VCs | Prompts user, signs credential subject, returns signed Verifiable Credential. |
| `POLY_CREDENTIAL_REQUEST` | iyou_poly | Selects matching credential, orders by fidelity/expiration, acquires `PopupGuard`, prompts user, returns VP. |
| `OMNI_SIGN_REQUEST` (`POLY_V2`) | iyou_poly Headless | Validates schema, signs ballot with Ed25519 without popup, returns Kind 1112 envelope. |
| `SYNC_TO_HOME_REQUEST` | Satellite Mirroring | Ingests batch Nostr events into local SQLite (`:9003`), mirrors Blossom media blobs into local storage (`:9002`), updates sync high-water mark. |
| `ping` | Keepalive | Responds with `{"type":"pong"}`. |

---

## 5. Tauri IPC Command Reference

### Vault & Identity
- `generate_did`: Bootstraps dual identities (Level 0 Anchor + Level 1 Primary) from fresh root seed.
- `import_did`: Imports an existing identity from base58 seed.
- `get_active_did`: Returns active DID string (defaults to Level 1 Primary).
- `list_profiles`: Lists all personas with tier level and derivation indices.
- `add_profile`: Derives new Level 2+ burner persona at next unused index.
- `set_active_profile`: Sets active profile and persists to `preferences.json`.
- `remove_profile`: Deletes burner persona (structurally blocked on Level 0 / Anchor).
- `rotate_primary_persona`: Breaks glass, burns current Level 1 persona, and mints new primary.
- `reveal_master_seed`: Returns master hex root seed for high-assurance display.
- `create_vault_backup`: Exports password-encrypted `.iyoubackup` archive byte vector.
- `restore_vault_backup`: Restores vault, contacts, and preferences from encrypted archive bytes.
- `revoke_all_sessions`: Builds signed `GLOBAL_SESSION_REVOKE` token and posts to IdP.
- `sign_auth_challenge`: Signs authentication challenge string using active persona.
- `get_public_did_document`: Resolves public DID document JSON.

### Contact Enclave & Disclosure
- `list_contacts`: Loads all contacts from `contacts.json`.
- `upsert_contact`: Inserts or updates contact by `peer_id`, deduplicating aliases.
- `delete_contact`: Removes contact from `contacts.json`.
- `generate_disclosure_card`: Generates and signs a Verifiable Disclosure Card.
- `import_disclosure_card`: Verifies signature and imports peer disclosure card.
- `resolve_peer_aliases`: Resolves alias metadata for up to 256 pubkeys.

### Sovereign Custody Graduation
- `derive_prf_identity`: Derives deterministic public identity parameters from WebAuthn PRF output.
- `generate_transit_keypair`: Generates ephemeral X25519 keypair for sealed seed transit.
- `process_graduation_ingest`: Unwraps transit envelope, validates DID binding, and seals seed.
- `activate_sovereign_identity`: Promotes graduated identity to primary active persona.

### Credentials & Governance
- `import_verifiable_credential`: Validates W3C structural properties and saves credential to vault.
- `save_credential`: Validates and saves VC into persona credentials.
- `get_credentials`: Returns stored credentials for a persona.
- `delete_credential`: Deletes credential by `vc_id`.
- `sync_vote_records`: Ingests poll vote records to `poll_ledger.json`.
- `get_vote_history`: Returns local poll voting audit trail.
- `calculate_vote_merkle_root`: Computes SHA-256 Merkle root over ballot records.
- `sync_poll_ledger`: Offline timeline validation and Merkle checkpoint.

### Services & Sync
- `get_service_statuses`: Returns live running/stopped/starting status of all daemons.
- `toggle_service`: Starts or stops a specific background daemon.
- `get_auto_start_settings`: Returns map of daemon auto-start preferences.
- `set_auto_start`: Persists auto-start preference for a daemon.
- `get_sync_status`: Returns last synced timestamp and mirrored note/blob counts.
- `trigger_manual_sync`: Manually executes local mirroring sync pipeline.

---

## 6. Verification & Test Commands

```bash
# Rust Backend Unit & Integration Tests (66 tests)
cargo test --manifest-path src-tauri/Cargo.toml

# Frontend TypeScript Typecheck & Production Build
npx tsc --noEmit && npm run build

# Vitest Suite (30 unit tests)
npx vitest run
```
