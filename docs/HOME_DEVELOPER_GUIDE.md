# Developer Guide — iyou_home (V2.0 Sovereign Release)

This guide provides technical specifications, architecture patterns, cryptographic invariants, wire protocol details, and subsystem manuals for the `iyou_home` sovereign identity hub and Personal Data Store (PDS).

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
# Execute full backend Rust test suite (90 tests)
cargo test --manifest-path src-tauri/Cargo.toml

# Run TypeScript typecheck & production bundle build
npx tsc --noEmit && npm run build

# Run Vitest test runner (74 unit tests across 10 test files)
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

## 3. Wire Protocols & Service Architecture

All local daemons bind strictly to `127.0.0.1`.

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

### 3.1 Signature Bridge Protocol (`wss://home.iyou.me:9001`)

The Signature Bridge terminates TLS natively with runtime certificate resolution (`{app_data}/certs/production.crt` and `production.key`) and provides Private Network Access (PNA) header pre-flights.

#### Supported Wire Messages:
1. `OMNI_SIGN_REQUEST` (`protocol: "POLY_V2"`): Headless poll vote signing for `iyou_poly`. Serializes canonicalized ballot payload and returns a signed Nostr Kind 1112 envelope.
2. `POLY_CREDENTIAL_REQUEST`: Prompts user with `PopupGuard` anti-trample concurrency control and returns a signed W3C Verifiable Presentation.
3. `RESOLVE_PEER_ALIASES`: Privacy pre-gate looking up up to 256 peer pubkeys in `contacts.json` without touching root keys.
4. `SYNC_TO_HOME_REQUEST`: Ingests Nostr events into local SQLite (`:9003`) and mirrors Blossom media blobs into local storage (`:9002`).
5. `ENCLAVE_DIAGNOSTIC_QUERY`: Diagnostic probe returning local service availability, key custody status, gossip mesh count, and backup freshness without leaking secrets.

### 3.2 Prosody XMPP & OMEMO Messaging (`:5222`)

The Messages subsystem provides decentralized, end-to-end encrypted messaging using XMPP over WebSocket (RFC 7395) and OMEMO Double Ratchet encryption.

- **JID Scheme**: `{nostr_pubkey_hex}@127.0.0.1`.
- **SASL Authentication**: Plaintext SASL against embedded Prosody using Level 1 persona hex key.
- **Address Resolution**: Supports npub (`npub1...`), did:key (`did:key:z6Mk...`), raw 64-char hex, and bare JID formats.
- **OMEMO Device Bundles**: Stored in `omemo_store.json`. Each device mints distinct numerical device IDs, an identity key (`Ik`), a signed prekey (`Spk`) signed with Ed25519, and a pool of one-time prekeys (`Opks`).

### 3.3 Mobile QR Pairing Protocol (`iyouhome://pair`)

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

### 3.4 Quick Dispatcher Pipeline

Top-bar `[ ✍️ Dispatch ]` station allowing rapid publishing:
- **Kind 1 (Notes)**: Plaintext / Markdown micro-posts signed via BIP-340 Schnorr.
- **Kind 1063 (File Uploads)**: Media upload to local Blossom BUD-01 server (`:9002`) followed by publishing a Kind 1063 NIP-94 file metadata event.
- **Kind 30023 (Civic Polls)**: Long-form poll parameter definitions containing poll title, choices, closing timestamp, and Blossom Merkle snapshot URI.
- **Dual Broadcast**: Automatically dispatches events to the local loopback relay (`ws://127.0.0.1:9003`) and the configured public gossip mesh (`wss://relay.iyou.me`, `wss://nos.lol`, `wss://relay.damus.io`).

---

## 4. Disaster Recovery & Sovereign Data Redundancy

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

### 4.1 `.iyoubackup` Container Specification

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

## 5. System Tray & Window Lifecycle

`iyou_home` operates as a persistent desktop daemon:
- **Hide on Close (`WindowEvent::CloseRequested`)**: Closing the main window hides the window rather than terminating the process, allowing background daemons (SigBridge, Blossom, Nostr, Prosody) to continue serving requests uninterrupted.
- **Monochrome Menu Bar Icon**: Configured with macOS `template: true` mode for seamless dark/light menu bar integration.
- **Tray Menu Actions**:
  - `Open Enclave` — Restores and focuses the main window.
  - `Lock App` — Immediately triggers app lock screen guard.
  - `Quit` — Gracefully halts all background daemons and exits.

---

## 6. Service Port & Network Architecture Summary

| Service | Port | Protocol | Binding | Purpose |
|---|---|---|---|---|
| **Signature Bridge** | `9001` | WSS (TLS) | `127.0.0.1` | Cross-origin signing and satellite bridge |
| **Blossom Server** | `9002` | HTTP / BUD-01 | `127.0.0.1` | Local SHA-256 media and file blob store |
| **Nostr Relay** | `9003` | WS / NIP-01 | `127.0.0.1` | Local SQLite-backed Nostr event relay |
| **XMPP Mesh** | `5222` | WSS (TLS) | `127.0.0.1` | P2P mesh chat and real-time signaling |
