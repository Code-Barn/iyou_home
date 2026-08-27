# Developer Guide — iyou_home (V2 Release)

This guide provides technical specifications, architecture patterns, cryptographic invariants, and wire protocol details for the `iyou_home` sovereign identity hub and Personal Data Store (PDS).

---

## 1. Getting Started

### 1.1 Prerequisites
- **Rust & Cargo**: >= 1.78.0
- **Node.js & npm**: >= 20.x
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
# Execute full backend Rust test suite (66 tests)
cargo test --manifest-path src-tauri/Cargo.toml

# Run TypeScript typecheck & production bundle build
npx tsc --noEmit && npm run build

# Run Vitest test runner (30 unit tests)
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
| **Ed25519 (W3C DID)** | `SHA-256(root_seed \|\| LE(index))` | `did:key:z6Mk...` | OIDC challenges, W3C VCs/VPs, poll votes, session revocation |
| **secp256k1 (NIP-01)** | `SHA-256("secp256k1-nostr" \|\| root_seed \|\| LE(index))` | 64-char lowercase hex | Nostr event signatures (BIP-340 Schnorr) |

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
   - **Air-Gap Invariant**: Excluded from external WebSocket signing requests, public persona dropdowns, and social broadcasting. Used strictly for high-assurance root introductions, selective disclosures, and air-gapped identity anchoring.
   - Deletion is structurally rejected by backend guards.
2. **Level 1 Public Persona (`index: 1`, `profile_id: "primary"`)**:
   - `is_system_reserved: false`, `level: 1`.
   - Default active persona for social broadcasting, Nostr events, W3C credentials, and browser signing challenges.
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

## 3. Wire Protocol Handshakes (`wss://home.iyou.me:9001`)

The Signature Bridge binds exclusively to `127.0.0.1:9001` over TLS. Modern browsers connect via `wss://home.iyou.me:9001` (which resolves via DNS to `127.0.0.1`).

### 3.1 Supported Frame Matrix

```
Browser / Satellite App                       iyou_home Rust Bridge (:9001)
         │                                                │
         │─── OPTIONS (PNA Pre-flight) ──────────────────>│
         │<── 200 OK (Access-Control-Allow-Private-Net) ──│
         │                                                │
         │─── GET (Upgrade: websocket) ──────────────────>│
         │<── 101 Switching Protocols ────────────────────│
         │                                                │
         │─── Frame Dispatch ────────────────────────────>│
         │    • OMNI_SIGN_REQUEST                         │
         │    • POLY_CREDENTIAL_REQUEST                   │
         │    • RESOLVE_PEER_ALIASES                      │
         │    • SYNC_TO_HOME_REQUEST                      │
         │    • GLOBAL_SESSION_REVOKE                     │
         │<── Response Envelope ──────────────────────────│
```

#### 1. `OMNI_SIGN_REQUEST` (`protocol: "POLY_V2"`)
- **Purpose**: Headless poll vote signing for `iyou_poly` without UI modal interruption.
- **Payload**: `{"poll_id": "...", "option_id": "...", "timestamp": 1234567890}`.
- **Canonicalization**: Alphabetical key order via `BTreeMap`, serialized to compact JSON.
- **Output**: Returns a Nostr Kind 1112 envelope signed with the persona's Ed25519 key.

#### 2. `POLY_CREDENTIAL_REQUEST`
- **Purpose**: Credential presentation handshake for external apps requesting proof of a specific credential.
- **Flow**: Prompts user via `WsSignPopup.tsx` with `PopupGuard` anti-trample concurrency control.
- **Output**: Returns `POLY_CREDENTIAL_PRESENTATION` containing a signed W3C Verifiable Presentation wrapping the chosen credential.

#### 3. `RESOLVE_PEER_ALIASES`
- **Purpose**: Contact Enclave privacy pre-gate lens.
- **Constraint**: Accepts up to 256 pubkeys/DIDs. Performs exact-match lookup in `contacts.json`.
- **Output**: Returns `{ matches: { "<key>": { "nickname": "...", "trust_level": "...", "badge": "..." } }, "unknown": [...] }`.
- **Security**: Loads only `contacts.json`; never touches `vault.json` or root key material.

#### 4. `SYNC_TO_HOME_REQUEST`
- **Purpose**: Sync-to-Home Local Mirroring Pipeline.
- **Payload**: Batch of Nostr events (Kinds 1, 1063, 1111, 30023) and list of missing Blossom blob SHA-256 hashes.
- **Engine**: Idempotently inserts Nostr events into local SQLite (`127.0.0.1:9003`) and mirrors remote blobs from `https://cdn.iyou.me/` into local storage (`127.0.0.1:9002`).

#### 5. `GLOBAL_SESSION_REVOKE`
- **Purpose**: Invalidate all active web logins across satellite apps (`iyou_wun`, `iyou_poly`, `iyou_talk`).
- **Engine**: Generates a timestamped nonce envelope signed with Level 1 Ed25519 key and posts to `https://iyou.me/api/auth/revoke-all/`.

---

## 4. Disaster Recovery & Sovereign Data Redundancy

Identity continuity is anchored across 3 independent redundancy paths:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       3-Tier Sovereign Redundancy                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Local Encrypted Archive (.iyoubackup)                                    │
│    • Password-encrypted container (HKDF-SHA256 + AES-256-GCM)               │
│    • Bundles vault.json, contacts.json, preferences.json, manifest.json     │
│                                                                             │
│ 2. Self-Hosted Blossom Node (Port 9002)                                     │
│    • Local SHA-256 content-addressed media blob repository                  │
│    • Automatic background mirroring of user uploads and attachments         │
│                                                                             │
│ 3. Decentralized Nostr Relays (Port 9003 & Upstream)                        │
│    • Signed notes, long-form articles, and social graphs                    │
│    • Reconstructable from public relays using deterministic root seed       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 `.iyoubackup` Container Specification

- **KDF**: `HKDF-SHA256` over the user-provided password with a 16-byte random salt.
- **Cipher**: `AES-256-GCM` with a 12-byte random nonce.
- **Payload**: ZIP archive containing:
  - `manifest.json`: Version metadata, creation timestamp, profile count.
  - `vault.json`: Base64-encoded `VaultStore`.
  - `contacts.json`: Peer contacts and trust levels.
  - `preferences.json`: Active persona and UI settings.

---

## 5. Governance & Consensus Engine

`iyou_home` provides cold governance verification for decentralized polls (e.g. in `iyou_poly`).

### 5.1 Local Merkle Root Computation

The Merkle tree is computed over ballot signatures (`VoteRecord.client_signature`) with second-preimage resistant domain separation:

- **Leaf Hash**: $\text{SHA-256}(0\text{x}00 \parallel \text{client\_signature})$
- **Internal Node Hash**: $\text{SHA-256}(0\text{x}01 \parallel \text{left\_hash} \parallel \text{right\_hash})$
- **Odd Layer Handling**: Duplicates the trailing node to maintain full binary tree balance.
- **Empty Set**: Yields an empty string `""`.

### 5.2 Poll Schedule & Timeline Validation

`LocalPoll::validate_vote_timeline(timestamp)` verifies that votes fall strictly within $[starts\_at, ends\_at]$ unless `is_ongoing == true`.

---

## 6. Service Port & Network Architecture

| Service | Port | Protocol | Binding | Purpose |
|---|---|---|---|---|
| **Signature Bridge** | `9001` | WSS (TLS) | `127.0.0.1` | Cross-origin signing and satellite bridge |
| **Blossom Server** | `9002` | HTTP / BUD-01 | `127.0.0.1` | Local SHA-256 media and file blob store |
| **Nostr Relay** | `9003` | WS / NIP-01 | `127.0.0.1` | Local SQLite-backed Nostr event relay |
| **XMPP Mesh** | `5222` | WSS (TLS) | `127.0.0.1` | P2P mesh chat and real-time signaling |
