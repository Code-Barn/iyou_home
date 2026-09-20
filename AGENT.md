# AGENT.md — Project Zero Architecture & Invariants (v0.2.2 Sovereign Release)

This document serves as the canonical system reference, architecture specification, and root operational contract for the `iyou_home` sovereign identity hub and Personal Data Store (PDS) enclave.

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
4. **Air-Gapped Tier Isolation & Profile Metadata Guard (`ERR_AIR_GAP_VIOLATION`)**:
   - **Level 0 Anchor** is permanently air-gapped from browser-initiated signing requests, public UI pickers, chat JID bindings, and public profile metadata (RFC-006).
   - Any external bridge attempt to read or mutate Level 0 metadata immediately fails closed with `ERR_AIR_GAP_VIOLATION`.
   - External WebSocket bridge signing requests can only target **Level 1 Public** or **Level 2+ Burner** personas.
5. **Fail-Closed File Quarantine**:
   - Store files (`vault.json`, `contacts.json`, `preferences.json`, `auto_start.json`, `pairing.json`, `ledgers/`) write atomically via staging files (`.tmp`) and `sync_all()`.
   - Corrupt files are never silently overwritten or auto-healed; they are quarantined to `{filename}.corrupt_{timestamp}.bak` (retaining the 5 most recent backups) and place the application into the terminal `Quarantined` state.
6. **First-Run Gateway & Neutral Age Gate (RFC-001 & RFC-004)**:
   - Greenfield vaults require interactive master seed verification before dashboard access.
   - The first-run onboarding path routes through the Neutral Age Gate (`NeutralAgeGate.tsx`), computing a sealed `AgeTier` (`child`, `teen`, `adult`) without leaking raw birth month/year over IPC. Teen brackets automatically enforce protective defaults (`mutual_contacts_only_dm: true`, `restricted_feed_indexing: true`, `public_persona_broadcast: false`).
7. **Daemon Dormancy Invariant (RFC-001 Rules D1–D6)**:
   - No daemon binds or spawns while `vault_status != Ready`.
   - Greenfield installs and uninitialized states defer all daemon startup until `start_ready_services` is invoked post-ceremony.
8. **Zero-Custody Escrow & Shamir Secrecy (RFC-005)**:
   - Child pod root seeds are minted in-enclave, split into 3 Shamir shares over GF(2⁸), and immediately zeroized.
   - The enclave only retains share $x=1$ in `escrow_store.json`. Reconstructing the seed requires an external 2-of-3 threshold ceremony and never retains child seed material post-ceremony.
9. **Sovereign Capabilities & Denial Codes (RFC-002)**:
   - Invites are cryptographically signed capability tokens (`InviteCapabilityToken`).
   - Token validation fails closed and evaluates schema $\rightarrow$ expiry $\rightarrow$ signature $\rightarrow$ revocation $\rightarrow$ budget $\rightarrow$ replay, returning canonical RFC-002 denial codes (`INVALID`, `EXPIRED`, `USED`, `REVOKED`).
10. **Operator Moderation & Live Severing (RFC-003)**:
    - Operator actions are persisted to an append-only `moderation.db` ledger.
    - Ban enforcement severs live connections via typed termination frames, blocks event ingestion at relay ingress, and cascades tombstones (T1 events, T2 media blobs, T3 kind:1605 broadcasts).

---

## 2. Daemon Matrix & Port Registry

All daemons are orchestrated within the native Tauri process and managed via `ServiceState`.

| Service | Port | Wire Protocol | Loopback URI | Security & Feature Capabilities |
|---|---|---|---|---|
| **Signature Bridge** | `:9001` | WSS (RFC 6455 over TLS) | `wss://home.iyou.me:9001` | Private Network Access (PNA) headers, OIDC signing, `OMNI_SIGN_REQUEST`, `POLY_CREDENTIAL_REQUEST`, `RESOLVE_PEER_ALIASES`, `SYNC_TO_HOME_REQUEST`, `ENCLAVE_DIAGNOSTIC_QUERY`, `SET_PROFILE_METADATA`, multi-client `profile_sync` fan-out. |
| **Blossom Server** | `:9002` | HTTP / BUD-01 | `http://127.0.0.1:9002` | SHA-256 content-addressed media store, GET/PUT/DELETE, PNA pre-flights, Axum `GET /` and `GET /health` diagnostic probes. |
| **Nostr Relay** | `:9003` | WS / NIP-01 | `ws://127.0.0.1:9003` | Embedded SQLite relay (`nostr_events.db`), Kinds 1 (notes), 1063 (files), 1112 (ballots), 30023 (polls). NIP-11 probe status, RFC-003 ban-gate filtering. |
| **Prosody XMPP-over-WS** | `:5222` | WSS (RFC 7395) | `wss://127.0.0.1:5222/xmpp-websocket` | OMEMO Double Ratchet end-to-end encryption, SASL PLAIN authentication bound to Level 1 persona hex key, JID `{nostr_pubkey_hex}@127.0.0.1` (RFC 7622 / XEP-0106 nodeprep sanitized). |

---

## 3. Identity Derivation Hierarchy & Persona Matrix

Identity keys are derived deterministically from a single 32-byte cryptographic root seed:
- **Ed25519 DID Key**: $\text{SHA-256}(\text{root\_seed} \parallel \text{LE32}(\text{derivation\_index}))$
- **Nostr secp256k1 Key**: $\text{SHA-256}(\text{"secp256k1-nostr"} \parallel \text{root\_seed} \parallel \text{LE32}(\text{derivation\_index}))$

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

### 3.1 Persona Tiers
1. **Level 0 (Anchor Sanctum — Index 0)**:
   - Reserved exclusively for private root P2P containment, high-assurance introductions, and selective disclosure signing.
   - `is_system_reserved = true`, `level = 0`, `derivation_index = 0`.
   - Air-gapped from all cross-origin bridge queries, public feeds, and profile metadata endpoints.
2. **Level 1 (Public Persona — Index 1)**:
   - Default persona for social broadcasting, public Nostr relays, W3C Verifiable Credentials, and external authentication challenges.
   - Initialized automatically at bootstrap with `profile_id: "primary"`.
   - Supports Break-Glass emergency rotation: tombstones current primary to Level 2 and advances index to $N = \max(\text{indices}) + 1$.
3. **Level 2+ (Contextual Burners — Index 2+)**:
   - Disposable, topic-specific identities for isolating interactions without linking to Level 1 or Level 0.
   - Can be freely created (`add_profile`) and deleted (`remove_profile`).
4. **Roles & Businesses (`level >= 3`)**:
   - Specialized identity profiles for organizations, business entities, and administrative roles.
   - Bridge signing for dependent, role, and business identities is blocked by `bridge_access_denial_reason` unless authorized.

---

## 4. Application Architecture & Subsystems

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ iyou_home v0.2.2 · SigBridge 🟢  Nostr 🟢  Blossom 🟢  Sync 🟢  [👤 Primary] │
├─────────────────────────────────────────────────────────────────────────────┤
│ [💬 Messages] [🛡️ Enclave] [📜 Credentials] [🔑 Vault] [⚙️ Services] [📊] [🧪]│
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. 💬 Messages: Split-Pane OMEMO Encrypted Chat Inbox & Peer Composer     │
│  2. 🛡️ Enclave: Project Zero Persona Matrix, Contact Enclave & Disclosures   │
│  3. 📜 Credentials: W3C VC Repository & Universal JSON/File Import         │
│  4. 🔑 Vault & Recovery: Master Seed Reveal, .iyoubackup & Family Enclave   │
│  5. ⚙️ Services: Daemon Switchboard (:9001-:9003, :5222), Invites & Admin   │
│  6. 📊 Governance Auditor: Poll Integrity & Blossom BUD-01 Merkle Consensus │
│  7. 🧪 Manual Signer: Raw Challenge Signer (Developer Mode Only)           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **`💬 Messages` (`MessagesTab.tsx`)**:
   - Split-pane E2EE chat inbox powered by XMPP over WebSocket (`:5222`) and OMEMO Double Ratchet.
   - JID resolution from contact addresses (`npub`, `did:key`, raw hex, or bare JID).
   - Device bundle publishing (`omemo_publish_bundle`) and peer bundle fetch (`omemo_fetch_peer_bundle`).
2. **`🛡️ Enclave` (`ProjectZero.tsx`)**:
   - Persona Matrix: Visual tier cards (L0 Anchor, L1 Public, L2+ Burners) with break-glass rotation.
   - Contact Enclave: 3-tier trust badges (`Inner Circle`, `Trusted Alliance`, `Peer`), alias management, and selective disclosure card issuance/import.
   - Sovereign Custody: WebAuthn PRF graduation import.
3. **`📜 Credentials` (`TrustAssets.tsx`)**:
   - W3C Verifiable Credential repository with persona filtering and keyword search.
   - Universal `[ + Import Credential ]` modal with W3C structural validation (`@context`, `type`, `issuer`, `credentialSubject`, `proof`).
4. **`🔑 Vault & Recovery` (`KeysManager.tsx`)**:
   - Master Seed Reveal (typed `REVEAL MY SEED` confirmation, 10s countdown, 30s auto-dismiss).
   - Encrypted `.iyoubackup` export and restore (HKDF-SHA256 + AES-256-GCM) with full `ledgers/` archive.
   - Mobile Pairing Station (`PairingModal.tsx` / `DevicePairing.tsx`): QR-based ECDH X25519 sealed seed transit.
   - **Family & Delegations Enclave (`FamilyEnclave.tsx` & `PodBindingModal.tsx`, RFC-005)**:
     - Custodial child pods, 3-share Shamir escrow distribution, supervisory grants (`kind:9114`), and 2-of-3 seed recovery.
   - Global Session Revocation Kill-Switch (signs `GLOBAL_SESSION_REVOKE` token dispatched to IdP).
5. **`⚙️ Services` (`ServiceSwitchPanel.tsx`)**:
   - **4 Sub-Views**:
     1. `⚙️ Daemons & Protocols`: Daemon switchboard (:9001, :9002, :9003, :5222), Sovereignty HUD (`SovereigntyStatusPanel.tsx`), and Sync-to-Home pipeline.
     2. `🗄️ Offline Media Vault`: Blossom local blob browser (`BlossomBrowser.tsx`).
     3. `📨 Invites & Referrals`: RFC-002 capability tokens and admission ledger (`InviteManager.tsx`).
     4. `🛡️ Admin`: RFC-003 operator moderation panel (`AdminPanel.tsx` & `BanModal.tsx`).
6. **`📊 Governance Auditor` (`GovernanceAuditor.tsx`)**:
   - Blossom BUD-01 and IPFS vote snapshot verification.
   - Local second-preimage resistant SHA-256 Merkle root computation over ballot records.
7. **`🧪 Manual Signer` (`SovereignSigner.tsx`)**:
   - Raw cryptographic challenge verification gated behind the Developer Mode footer toggle.

---

## 5. WebSocket Bridge Protocol (`wss://home.iyou.me:9001`)

The Signature Bridge terminates TLS natively with runtime certificate loading from `{app_data}/certs/` (or ephemeral fallback in memory) and provides PNA pre-flights:
`Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true`.

### 5.1 Inbound Frame Dispatch Matrix

| Inbound Wire Type | Protocol / Application | Enclave Behavior & Response |
|---|---|---|
| `ping` | Keepalive | Responds with `{"type":"pong"}`. |
| `get_profile` | All Satellites | Returns secret-free `PublicProfileProjection` (`did`, `nostr_pubkey_hex`, `handle`, `avatar_url`, etc.). Never exposes Level 0 Anchor. |
| `list_profiles` / `LIST_PERSONAS` | Satellite Selector | Returns `personas_list` array of bridge-exposable personas (`level >= 1`, non-anchor). |
| `set_active_profile` / `switch_persona` | Satellite Re-anchoring | Switches active persona in vault, emits `profile://changed`, and broadcasts `profile_sync` to all open satellite tabs (RFC-006 §9). |
| `SET_PROFILE_METADATA` | Satellite Profile Claim | Validates handle regex, computes `nip05`, persists atomically to `vault.json`, emits `profile_sync` echo + broadcast. Fails closed with `ERR_AIR_GAP_VIOLATION` if targeting Level 0. |
| `RESOLVE_PEER_ALIASES` | Contact Enclave Lens | Reads `contacts.json` (max 256 keys). Returns minimal `{ matches: {...}, unknown: [...] }` without touching root keys. |
| `sign` / `sign_raw` | OIDC / Auth | Prompts user via `WsSignPopup.tsx`, signs challenge with Ed25519, returns Verifiable Presentation. |
| `sign_event` | Nostr NIP-01 | Prompts user, signs with secp256k1 Schnorr (`sign_raw` over SHA-256 prehash), returns signed Nostr event. |
| `sign_credential` | W3C VCs | Prompts user, signs credential subject, returns signed Verifiable Credential. |
| `POLY_CREDENTIAL_REQUEST` | iyou_poly | Selects matching credential, orders by fidelity/expiration, acquires `PopupGuard`, prompts user, returns VP. |
| `OMNI_SIGN_REQUEST` (`POLY_V2`) | iyou_poly Headless | Validates schema, signs ballot with Ed25519 without popup, returns Kind 1112 envelope. |
| `SYNC_TO_HOME_REQUEST` | Satellite Mirroring | Ingests batch Nostr events into local SQLite (`:9003`), mirrors Blossom media blobs into local storage (`:9002`), updates sync high-water mark. |
| `ENCLAVE_DIAGNOSTIC_QUERY` | Enclave Diagnostic Probes | Evaluates local daemon statuses, key custody readiness, gossip mesh count, and backup freshness without leaking private keys. |

### 5.2 Outbound Multi-Client Fan-Out (`profile_sync`)

When profile metadata updates or the active persona changes, `broadcast_profile_sync` iterates every connection in `WsState.broadcast_clients` and dispatches the canonical `profile_sync` envelope, pruning disconnected clients.

---

## 6. Complete Tauri IPC Command Reference

All commands below are registered in `tauri::generate_handler!` (`src-tauri/src/lib.rs`).

### Vault Lifecycle & Onboarding (RFC-001)
- `get_vault_status`: Read-only query returning `"Uninitialized" | "Ready" | "Corrupt"`. Never causes file creation.
- `generate_did`: Bootstraps dual identities (Level 0 Anchor + Level 1 Primary) from a fresh root seed.
- `import_did`: Imports an existing identity from base58 seed.
- `bootstrap_from_seed`: Re-derives L0+L1 deterministically from a 32-byte hex/0x-hex/base58 seed string; refuses if vault exists.
- `start_ready_services`: Ready-gated single entry point; spawns SigBridge and enabled auto-start daemons.
- `set_seed_backup_confirmed`: Records user completion of the cold seed backup ceremony.
- `reveal_master_seed`: Returns master hex root seed for high-assurance display (typed confirmation).
- `create_vault_backup`: Exports password-encrypted `.iyoubackup` archive byte vector (includes `ledgers/`).
- `restore_vault_backup`: Restores vault, contacts, preferences, and ledgers from encrypted archive bytes.

### Persona & Identity Derivations
- `get_active_did`: Returns active DID string (defaults to Level 1 Primary).
- `get_active_profile`: Returns active `Profile` object.
- `list_profiles`: Lists all personas with tier level, derivation index, and metadata.
- `add_profile`: Derives new Level 2+ burner persona at next unused index.
- `set_active_profile`: Sets active profile, persists to `preferences.json`, and fans out `profile_sync`.
- `activate_persona`: Activates a persona profile by `profile_id`.
- `remove_profile`: Deletes burner persona (structurally blocked on Level 0 / Anchor).
- `rotate_primary_persona`: Breaks glass, tombstones current Primary to Level 2, and derives new Primary at $N = \max(\text{indices}) + 1$.
- `sign_auth_challenge`: Signs authentication challenge string using active persona.
- `get_public_did_document`: Resolves public W3C DID document JSON.
- `list_roles`: Lists specialized role profiles (`level >= 3`).
- `create_role_profile`: Creates a role-specific identity profile.
- `list_businesses`: Lists business identity profiles.
- `create_business_profile`: Creates a business identity profile.

### Compliance & Neutral Age Gate (RFC-004)
- `classify_age`: Computes three-tier bracket (`child`, `teen`, `adult`) with 1st-of-birth-month math; sets teen protective defaults.
- `get_age_tier`: Returns sealed `Option<AgeTier>` from `preferences.json`.
- `record_disclaimer_audit`: Appends sealed audit entry to `disclaimer_audit.json` with enclave-stamped IDs.

### Invites & Capability Tokens (RFC-002)
- `create_invite_token`: Mints an L1-signed `InviteCapabilityToken` (Admin unlimited / Member quota-capped).
- `list_invites`: Lists all invite records from `invites.db` with computed status pills.
- `revoke_invite`: Tombstones invite nonce and prunes graph edge in `invites.db`.
- `validate_invite_token`: Admission-gate preview checking schema, expiry, signature, revocation, budget, and replay.
- `get_issuer_status`: Returns caller's role (`Admin`, `Member`, `Guest`), quota allowance, and vetting attributes.
- `set_issuer_role`: Admin role assignment in `invites.db`.
- `render_invite_qr`: Generates QR code data URL for mobile invite transit.

### Operator Moderation & Admin (RFC-003)
- `admin_probe`: Verifies operator admin status for a satellite.
- `admin_list_members`: Member directory projected from the RFC-002 invite graph.
- `admin_list_bans`: Lists active (non-expired, non-soft-deleted) ban records from `moderation.db`.
- `admin_list_actions`: Returns append-only `moderation_actions` audit trail.
- `admin_sever`: Severs live satellite WebSocket connections for a target DID.
- `admin_ban`: Executes immutable ban, severs connections, broadcasts kind:1604, and optionally prunes branches.
- `admin_unban`: Soft-deletes ban record with audit trail entry.
- `admin_purge`: Purges T1/T2 events, deletes Blossom blobs, and broadcasts signed kind:1605 tombstones.

### Family, Custodial Pods & Sovereign Graduation (RFC-005)
- `bind_child_pod`: Registers child DID, device ID, and public keys in the parent vault.
- `generate_pod_escrow_shares`: Mints child root seed in-enclave, splits into 3 Shamir shares, persists share x=1, zeroizes seed.
- `create_supervisory_grant`: Issues expiring supervisory capability `kind:9114` signed with parent L1 key.
- `revoke_supervisory_grant`: Revokes active supervisory grants for a pod.
- `list_child_pods`: Lists registered child pods from vault.
- `emancipate_child_pod`: Initiates or advances two-stage child emancipation.
- `verify_and_reconstruct_escrow`: 2-of-3 threshold reconstruction over GF(2⁸) to recover seed.
- `generate_transit_keypair`: Generates ephemeral X25519 transit keypair for graduation handshake.
- `process_graduation_ingest`: Ingests encrypted child seed during sovereign graduation ceremony.
- `activate_sovereign_identity`: Completes graduation and activates sovereign identity vault.
- `create_dependent_profile`: Creates a dependent persona profile in the vault.
- `export_dependent_leaf_bundle`: Exports dependent key bundle for device provisioning.
- `graduate_dependent_to_sovereign`: Promotes dependent identity to sovereign status.

### Profile Metadata & Cross-Satellite Sync (RFC-006)
- `set_profile_metadata`: Scoped write to public profile metadata; fails closed on Level 0 (`ERR_AIR_GAP_VIOLATION`); broadcasts `profile_sync`.

### Contact Enclave & Selective Disclosure
- `list_contacts`: Loads all contacts from `contacts.json`.
- `upsert_contact`: Inserts or updates contact by `peer_id`, deduplicating aliases.
- `delete_contact`: Removes contact from `contacts.json`.
- `generate_disclosure_card`: Generates and signs a Verifiable Disclosure Card.
- `import_disclosure_card`: Verifies signature and imports peer disclosure card.
- `resolve_peer_aliases`: Resolves alias metadata for up to 256 pubkeys.

### Sovereign Custody (WebAuthn PRF)
- `derive_prf_identity`: Derives deterministic public identity parameters from WebAuthn PRF output.

### Mobile Pairing
- `pair_begin`: Initiates QR pairing session, generates ephemeral X25519 keypair, returns `iyouhome://pair` deep link.
- `pair_seal_seed_for_device`: Encrypts master root seed for mobile device using HKDF `iyou-home/pair/v1` and AES-256-GCM.
- `pair_confirm`: Finalizes device registration and records paired device in `pairing.json`.
- `pair_list_devices`: Returns all active paired mobile devices.
- `pair_revoke_device`: Revokes paired mobile device by `device_id`.

### Messaging & OMEMO
- `get_chat_session_credentials`: Resolves XMPP credentials for local Prosody connection (`:5222`).
- `omemo_publish_bundle`: Signs and publishes identity key, signed prekey, and OTPK bundle to `omemo_store.json`.
- `omemo_fetch_peer_bundle`: Fetches OMEMO device bundle for a peer JID.
- `omemo_list_devices`: Lists registered OMEMO devices for a peer JID.

### Credentials & Governance
- `import_verifiable_credential`: Validates W3C structural properties and saves credential to vault.
- `save_credential`: Validates and saves VC into persona credentials.
- `store_credential`: Stores a raw verifiable credential in the vault.
- `get_credentials`: Returns stored credentials for a persona.
- `delete_credential`: Deletes credential by `vc_id`.
- `sync_vote_records`: Ingests poll vote records to `poll_ledger.json`.
- `get_vote_history`: Returns local poll voting audit trail.
- `calculate_vote_merkle_root`: Computes SHA-256 Merkle root over ballot records.
- `sync_poll_ledger`: Offline timeline validation and Merkle checkpoint.

### Services, Sync & Media
- `get_service_statuses`: Returns live running/stopped/starting status of all daemons.
- `toggle_service`: Starts or stops a specific background daemon.
- `get_auto_start_settings`: Returns map of daemon auto-start preferences.
- `set_auto_start`: Persists auto-start preference for a daemon.
- `get_sync_status`: Returns last synced timestamp and mirrored note/blob counts.
- `trigger_manual_sync`: Manually executes local mirroring sync pipeline.
- `list_local_blobs`: Lists stored Blossom blobs with hashes, MIME types, and sizes.
- `delete_local_blob`: Deletes local Blossom media blob by SHA-256 hash.
- `get_local_blobs_count`: Returns total stored blob count.

### Mesh Relays & Nostr Dispatch
- `dispatch_nostr_event`: Dispatches Kind 1, 1063, or 30023 events to local relay and remote mesh.
- `get_ecosystem_footprint`: Aggregates notes, blobs, credentials, contacts, and poll audit counts.
- `get_enclave_diagnostics`: Returns full Sovereignty HUD diagnostic matrix.
- `record_backup_timestamp`: Updates `last_backup_at` preference timestamp.
- `get_relay_mesh`: Returns configured public Nostr relays for the gossip mesh.
- `add_mesh_relay`: Adds a new public relay URL to the mesh.
- `remove_mesh_relay`: Removes a relay URL from the mesh.
- `reset_mesh_relays`: Restores default relay mesh list.

### WebSocket Bridge Pipeline
- `submit_ws_response`: Submits generic WebSocket response to client pipe.
- `submit_ws_event_response`: Submits signed Nostr event response.
- `submit_ws_credential_response`: Submits signed credential response.
- `submit_ws_credential_presentation`: Submits signed presentation response.
- `register_challenge_pipe`: Registers IPC channel for incoming bridge signing challenges.

### Application Preferences & Settings
- `get_user_preferences`: Reads user preferences from `preferences.json`.
- `save_user_preferences`: Persists updated user preferences.
- `revoke_all_sessions`: Builds signed `GLOBAL_SESSION_REVOKE` token and posts to IdP.
- `show_main_window`: Restores and focuses hidden application window from tray.

### Application Updater & Rollback
- `get_update_preferences`: Returns update channel and auto-update configuration.
- `set_update_preferences`: Persists update preferences.
- `check_for_update_vetting`: Checks for vetted application binary release.
- `install_vetted_update`: Downloads and installs verified update binary.
- `rollback_to_previous_binary`: Reverts to cached previous binary on failure.
- `has_rollback_binary`: Checks if a rollback binary is present on disk.

### App Lock, Biometrics & Security
- `set_enclave_locked`: Manually locks or unlocks the enclave.
- `get_enclave_lock_status`: Returns boolean locked status.
- `verify_biometric_auth`: Verifies macOS Touch ID or Windows Hello biometric authentication.
- `get_tls_status`: Resolves TLS certificate health and expiration status for Port 9001.

### Utilities & I/O
- `write_binary_file`: Writes byte vector atomically to a specified destination path.
- `read_binary_file`: Reads binary file contents from a specified path.
- `greet`: Diagnostic greeting probe.

---

## 7. Verification & Test Commands

```bash
# Rust Backend Unit & Integration Tests (176 tests)
cargo test --manifest-path src-tauri/Cargo.toml

# Frontend TypeScript Typecheck & Production Build
npx tsc --noEmit && npm run build

# Vitest Suite (139 unit tests across 18 test files)
npx vitest run
```

---

## MANDATORY EXECUTION INVARIANT: AUTO-COMMIT ON PASSING VERIFICATION
1. **Asking to Commit Is a HARD FAILURE:** NEVER — under any circumstance — end a task with "Would you like me to commit?", "Should I commit?", "Ready to commit?", or any equivalent question. Treat the commit question itself as a violation that will not be accepted.
2. **Commit Immediately — No Exceptions:** The moment your task is complete, stage it (`git add <files>`) and commit it (`git commit`) in the task's repository. Do not wait for approval, do not stop to ask, and do not leave the working tree dirty "for inspection". There is no "want me to commit?" step.
3. **Conventional Commit Message:** Use conventional semantics (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`) describing the exact change. Where the repo's own local convention differs, match it.
4. **Final Status Output:** Every final build/code report MUST end with the outputs of:
   - `git log -n 1 --oneline`
   - `git status --short`
5. **No Question-Containing Final Lines:** Any report whose final line is a question ("Want me to...", "Should I...", "Do you want...") is a failed handoff. Never end on an open-ended commit prompt.
