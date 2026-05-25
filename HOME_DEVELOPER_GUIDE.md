# Developer Guide

This guide provides instructions for setting up the development environment, running the application, and understanding the project structure.

## Getting Started

### Prerequisites

*   [Rust](https://www.rust-lang.org/tools/install) and Cargo
*   [Node.js](https://nodejs.org/) and npm
*   Tauri v2 development prerequisites (see the [official Tauri documentation](https://beta.tauri.app/develop/prerequisites/))

### Installation and Running

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd iyou-home
    ```

2.  **Install frontend dependencies:**
    ```bash
    npm install
    ```

3.  **Run the application in development mode:**
    ```bash
    npm run tauri dev
    ```
    This will start the frontend development server and the Tauri application, with hot-reloading enabled for both.

## Backend (Rust)

The backend is located in the `src-tauri` directory and is organised into five source modules plus a build script:

| Module | File | Responsibility |
|---|---|---|
| **vault** | `src/vault.rs` | Encrypted profile registry, root seed management, deterministic Ed25519 key derivation, **Poll Vote Ledger** (`PollLedger` / `VoteRecord`) |
| **bridge** | `src/bridge.rs` | WebSocket server on port 9001 — parses inbound frames (incl. `OMNI_SIGN_REQUEST` / `POLLY_V2`), routes by `profile_id`, pipes signing requests to React |
| **nostr_relay** | `src/nostr_relay.rs` | NIP-01 Nostr relay (port 9003) |
| **blossom** | `src/blossom.rs` | BUD-01 blob server (port 9002) |
| **prosody** | `src/prosody.rs` | XMPP server (port 5222) |

*   **Main Logic & Commands:** `src/lib.rs` wire up Tauri commands, service lifecycle, and state management.
*   **State Management:** Two state structs are managed by Tauri:
    - `ServiceState` — holds service status map and the active profile DID.
    - `WsState` — holds the WebSocket response sender (`mpsc::UnboundedSender<Message>`) for sending signed payloads back, and the `challenge_channel` (`tauri::ipc::Channel<String>`) registered by React. All fields use `Mutex` for interior mutability.

### Networking & Binding

All local services bind exclusively to `127.0.0.1` (IPv4 loopback). **No service listens on `0.0.0.0`, `[::]`, or any public interface.** This ensures:

- No accidental exposure to LAN or WAN.
- Consistent behaviour across macOS, Linux, and Windows.
- PNA pre-flight is the only cross-origin path — via the Signature Bridge on port 9001.

| Service | Port | Protocol | Bind Address |
|---|---|---|---|
| Signature Bridge | 9001 | WebSocket / HTTP | 127.0.0.1 |
| Blossom (BUD-01) | 9002 | HTTP (GET/PUT/HEAD/OPTIONS) | 127.0.0.1 |
| Nostr Relay (NIP-01) | 9003 | WebSocket | 127.0.0.1 |
| XMPP (Chat) | 5222 | TCP / WebSocket | 127.0.0.1 |

### Auto-Start Persistence

Service auto-start preferences are persisted to `{app_data}/auto_start.json` as a flat JSON map (`{"Nostr": true, "Blossom": false}`). On startup, `.setup()` loads this file and spawns any service with `true`. The frontend can query and update these via `get_auto_start_settings` and `set_auto_start` Tauri commands.

### Signature Bridge (Port 9001) — Protocol

The application runs a local WebSocket server on port 9001 that binds `127.0.0.1:9001` (IPv4 only — all local services standardised to 127.0.0.1). This is started inside the Tauri `.setup()` hook using `tauri::async_runtime::spawn`.

The Signature Bridge is **always on** (not togglable) and is the sole cross-origin entry point for browser-based identity providers (WUN, Polly, etc.).

#### CORS / Private Network Access (PNA)

Safari, Chrome, and Brave all require a PNA pre-flight (OPTIONS) before a public HTTPS origin is allowed to connect to a private-network WebSocket. The handler implements First-Match-Wins:

1. Peeks the first 4 bytes via `TcpStream::peek()`.
2. If `b"OPTI"` — responds 200 with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Private-Network: true`, and `Access-Control-Allow-Methods: GET, PUT, POST, OPTIONS`.
3. If `b"GET"` + WebSocket upgrade headers — passes the stream to `accept_hdr_async` whose callback injects the same PNA headers into the 101 Switching Protocols response.
4. All other connections are silently dropped.

#### Supported Message Types

| Type | Action | Description | Optional Fields |
|---|---|---|---|---|
| `sign` | `"sign"` or `"action":"sign"` | OIDC/VP challenge — returns a Verifiable Presentation signed with the derived Ed25519 key | `profile_id` |
| `sign_event` | `"sign_event"` or `"type":"sign_event"` | Nostr event signing — returns `{"type":"signed_event","event":{...}}` with `id` and `sig` (Ed25519, deviates from NIP-01 secp256k1) | `profile_id` |
| `sign_credential` | `"type":"sign_credential"` | W3C Verifiable Credential issuance — returns `{"type":"signed_credential","vc":{...}}` | `profile_id` |
| `OMNI_SIGN_REQUEST` | `"type":"OMNI_SIGN_REQUEST"` with `"protocol":"POLLY_V2"` | Polly V2 poll vote — canonicalises the inner `payload` (alphabetical key order, zero spacing), hashes with SHA-256, signs with vault Ed25519 key, returns a Nostr Kind 1112 envelope | `profile_id` |
| `ping` | `"type":"ping"` | Smoke test — immediately responds `{"type":"pong"}` via the response channel | — |

All signing message types accept an optional `"profile_id"` string. If present, the bridge looks up the matching persona in the vault registry and derives its keypair at the profile's `derivation_index`. If absent or empty, the bridge defaults to derivation index 0 (Primary Identity).

#### Signing Flow (v2 Channel Architecture)
1. React mounts `WsSignPopup.tsx`, creates a `new Channel<string>()`, sets `channel.onmessage`, and registers it with the backend via `invoke('register_challenge_pipe', { channel })`. Any queued messages from before registration are flushed to the new channel.
2. Browser sends a JSON message over the WebSocket. The message may include an optional `"profile_id"` field to select which persona performs the signing.
3. The bridge (`bridge.rs`) parses the inbound JSON, extracts the `profile_id` (defaulting to `""` for index 0), and spawns a background task via `tokio::spawn` (see *Async Logic Strike* below).
4. The background task brings the app window to focus, then sends the request (including the `profile_id`) through the registered `Channel` — this fires `onmessage` in React instantly.
5. React shows a modal with the request details and Approve/Deny buttons.
6. On approval, React calls the appropriate command (`submit_ws_response`, `submit_ws_event_response`, or `submit_ws_credential_response`) passing the `profile_id` back to Rust.
7. The Rust command calls `resolve_profile_keypair` which loads the vault, looks up the profile (or defaults to index 0), derives the deterministic Ed25519 keypair from the root seed + derivation index, signs the payload, and sends the response back over the WebSocket via the `mpsc::UnboundedSender<Message>` stored in `WsState.response_sender`.
8. On denial, a `{"status":"denied"}` message is sent.

#### OMNI_SIGN_REQUEST / POLLY_V2 Auto-Signing Flow

The `OMNI_SIGN_REQUEST`/`POLLY_V2` message type is designed for headless poll-vote signing from external portal applications (iyou_wun, Polly). Unlike the user-facing `sign`/`sign_event`/`sign_credential` types, the entire signing cycle is handled **entirely within the Rust bridge** — no React popup is involved, keeping the critical path fast and automatic.

**Incoming schema:**
```json
{
  "type": "OMNI_SIGN_REQUEST",
  "protocol": "POLLY_V2",
  "payload": {
    "poll_id": "string",
    "option_id": "string",
    "timestamp": 1234567890
  },
  "profile_id": "optional"
}
```

**Signing pipeline (`handle_omni_sign_request` → `sign_omni_payload`):**
1. Validate that `protocol == "POLLY_V2"` and the payload contains `poll_id`, `option_id`, and a valid `timestamp`.
2. Resolve the vault Ed25519 keypair via `resolve_profile_keypair` (profile defaults to index 0 if absent).
3. **Canonicalise** the inner `{option_id, poll_id, timestamp}` object using a `BTreeMap<String, Value>` — guarantees alphabetical key order — then serialise with `serde_json::to_string` (zero spacing, no newlines).
4. Hash the canonical string with SHA-256 and produce an Ed25519 signature over the digest.
5. Wrap the result in a **Nostr Kind 1112** envelope with lowercase-hex-encoded `pubkey`, `id`, and `sig` fields (matching NIP-01 formatting conventions) and the wall-clock Unix epoch as `created_at`.

**Response sent back over the same WebSocket:**
```json
{
  "type": "OMNI_SIGN_RESPONSE",
  "protocol": "POLLY_V2",
  "envelope": {
    "kind": 1112,
    "pubkey": "<64-char lowercase hex>",
    "created_at": 1748130000,
    "tags": [["poll", "<poll_id>"], ["p", "<voter_did>"]],
    "content": "{\"option_id\":\"...\",\"poll_id\":\"...\",\"timestamp\":1234567890}",
    "id": "<64-char lowercase hex>",
    "sig": "<128-char lowercase hex>"
  }
}
```

The response envelope can be double-broadcast or proxied as a valid Nostr event. The `id` is the SHA-256 hash of the canonical content string; `sig` is the Ed25519 signature over the same hash. Verification: recover the content, hash it, and verify the Ed25519 signature against the voter's `did:key:` public key.

#### Critical Pattern: State Shadowing Fix
The WebSocket TCP task runs in a different async context than Tauri IPC commands. Any reference to managed state captured before a `tokio::spawn` or `tokio::spawn` boundary points to a **local shadow copy**, not the singleton managed by Tauri.

**Fix:** Always pass `app_handle: tauri::AppHandle` (cloned from `app.handle()`) into async tasks, and access managed state exclusively through `app_handle.state::<WsState>()`. This ensures the WebSocket handler, the React-polled commands, and the Channel pipe all resolve to the same memory location.

**NEVER** do this:
```rust
// BAD — captures a local reference before spawn
let state = app.state::<WsState>();
tokio::spawn(async move {
    state.do_something();  // ← this is a shadow copy!
});
```

**ALWAYS** do this:
```rust
// GOOD — resolves state inside the spawned task
let app_handle = app.handle().clone();
tokio::spawn(async move {
    let state = app_handle.state::<WsState>();
    state.do_something();  // ← this is THE singleton
});
```

#### Critical Pattern: Async Logic Strike
The WebSocket read loop must never block. If challenge processing (window focus, state access, channel send) runs inline, the loop cannot receive the next message or respond to heartbeats.

**Fix:** When a sign message arrives, extract the challenge string and immediately `tokio::spawn` a background task. The spawned task owns `app_handle.clone()` and handles all React communication. The read loop returns to listening in <1µs.

```rust
while let Some(Ok(msg)) = ws_receiver.next().await {
    if /* sign message */ {
        let challenge = extract_challenge(&msg);
        let app_handle = app_handle.clone();
        tokio::spawn(async move {
            // All slow work here:
            window.unminimize/show/set_focus();
            let state = app_handle.state::<WsState>();
            state.challenge_channel.lock()...
            channel.send(challenge);
        });
        // Loop returns to listening immediately
    }
}
```

### Testing the Backend

Unit tests are in `src-tauri/src/lib.rs` and `src-tauri/src/vault.rs`.

To run all Rust tests:
```bash
cd src-tauri
cargo test
```

Current test suites — **vault**:
- `test_derivation_is_deterministic` — same seed + index always yields the same DID
- `test_different_index_different_key` — different indices produce different keypairs
- `test_vault_round_trip` — create, persist, load, verify base64-encrypted storage
- `test_add_remove_profile` — profile CRUD operations on `VaultStore`
- `test_get_profile_by_id_defaults_to_first` — empty `profile_id` resolves to index 0
- `test_get_profile_keypair` — `get_profile_keypair` returns correct DID for a profile
- `test_vote_record_round_trip` — serialise/deserialise cycle for `PollLedger` / `VoteRecord`

Current test suites — **commands**:
- `test_toggle_service_start` / `test_toggle_service_stop` — service state transitions
- `test_sign_auth_challenge_logic` — VP signing with proof validation via derived keypair

## Identity Model

**Passwords are deprecated.** The primary entry point is the OIDC/DID loop:

1. A browser-based identity provider (IdP) at WUN or Polly initiates the flow by connecting to the local Signature Bridge.
2. The IdP sends a challenge (`sign`), a Nostr event (`sign_event`), a credential body (`sign_credential`), or a poll vote (`OMNI_SIGN_REQUEST` / `POLLY_V2`) over the WebSocket, optionally specifying a `"profile_id"` to select which persona performs the signing.
3. For user-facing types (`sign`/`sign_event`/`sign_credential`), the user approves or denies via the React popup (`WsSignPopup`). For the headless `OMNI_SIGN_REQUEST` type, signing is fully automatic within the Rust bridge — no React popup appears.
4. The Rust backend loads the vault, looks up the profile (or defaults to derivation index 0), derives the deterministic Ed25519 keypair from the root seed + `derivation_index`, signs, and returns the result over the same WebSocket connection. For `OMNI_SIGN_REQUEST` responses, the signed payload is wrapped in a Nostr Kind 1112 envelope.

### Multi-Persona Architecture

The vault stores a single 32-byte root seed (`root_seed_base58`) and a `Vec<Profile>`. Each profile has a `profile_id`, `profile_name`, `derivation_index`, and a cached `did:key:` string. No per-profile private keys are stored — all keys are derived deterministically:

```
Ed25519 keypair = SHA-256(root_seed || LE(derivation_index))
```

| Tauri Command | Description |
|---|---|---|
| `list_profiles` | Returns all profiles (public DID only, no private material) |
| `add_profile(profileName)` | Creates a new persona at the next unused `derivation_index` |
| `get_active_did` | Returns the DID of the currently active profile |
| `sync_vote_records(records)` | Ingests and appends an array of `VoteRecord` objects to the local Poll Vote Ledger |
| `get_vote_history` | Returns the full array of stored `VoteRecord` entries from the local Poll Vote Ledger |

The `Profile` struct is safe to send to the frontend (no private key material):

```rust
pub struct Profile {
    pub profile_id: String,
    pub profile_name: String,
    pub derivation_index: u32,
    pub did: String,
}
```

**Zero UI Leakage:** Private key bytes never cross the Rust/TypeScript boundary. All signing happens inside the compiled Rust process using `ed25519-dalek` via the derived keypair. The frontend sees only `did:key:` strings.

### Greenfield Resets & Backward Compatibility Policy

**Architectural Decision**: This application has dropped all backward compatibility support in favor of a clean, greenfield-only approach. This decision eliminates technical debt and simplifies the codebase since the application is currently in pre-release with a single user base.

#### Reset Behavior

If `vault.json` is missing, corrupt, or fails to deserialize as a valid `VaultStore`, `load_vault` immediately:

1. Generates a fresh 32-byte root seed
2. Creates a "Primary Identity" profile at derivation index 0
3. Overwrites the existing file with the new schema

**No legacy format migration is attempted** — the old single-key `IdentityStore` schema has been permanently removed.

#### Benefits of Greenfield-Only Approach

- **Simplified Code**: No migration logic, version checks, or schema compatibility layers
- **Predictable Testing**: Single code path for initialization
- **Clean State**: Users always start with known-good configuration
- **Easy Reset**: Delete `vault.json` to start fresh at any time

#### User Impact

- **Existing Users**: Delete `vault.json` to migrate to v3 schema (one-time operation)
- **New Users**: Automatic clean initialization on first run
- **Multi-User Systems**: Each OS user gets independent greenfield initialization

This approach aligns with the Level 2 Secure Enclave model by ensuring all users start with a cryptographically sound, deterministic configuration.

There is no password-based authentication for the signing flow. The XMPP (Chat) service uses a locally-generated password file for SASL PLAIN (`{app_data}/xmpp_password.txt`) — this is a transport credential, not an identity credential. All higher-level identity operations go through the DID/Vault+WebSocket path.

### Poll Vote Ledger

A local audit trail for poll voting history is maintained as a JSON file at `{app_data}/poll_ledger.json`. This creates a permanent, immutable, un-deplatformable offline audit trail on the user's local machine.

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteRecord {
    pub poll_id: String,
    pub option_id: String,
    pub client_signature: String,
    pub voter_did: String,
    pub network_timestamp: i64,
}
```

| Function | Description |
|---|---|
| `load_ledger(app)` | Reads and deserialises `poll_ledger.json`; returns an empty `PollLedger` if the file is missing |
| `save_ledger(app, ledger)` | Serialises (pretty-printed JSON) and writes to `poll_ledger.json` |
| `append_vote_records(app, records)` | Loads the ledger, appends an array of `VoteRecord`, and persists the result |
| `get_vote_records(app)` | Loads and returns the full `Vec<VoteRecord>` from the ledger |

The ledger file is stored as plain (unencrypted) JSON — unlike `vault.json` which is base64-encoded — to remain human-readable and machine-portable as an immutable local audit trail.

## Frontend (React)

The frontend is a React application located in the `src` directory.

*   **Main Component:** The main UI is defined in `src/App.tsx`.
*   **Communicating with the Backend:** The frontend uses the `@tauri-apps/api/core` package to `invoke` commands exposed by the Rust backend.
*   **WebSocket Sign Popup:** `src/components/WsSignPopup.tsx` creates a `Channel<string>` on mount, sets `channel.onmessage` to show the challenge modal, and registers it via `invoke('register_challenge_pipe', { channel })`. Shows a modal with challenge text, Approve/Deny buttons, and an auto-sign checkbox for development. This is the **only** delivery path — polling and event-based approaches have been removed.
*   **Sovereign Signer:** `src/components/SovereignSigner.tsx` provides a manual challenge paste UI as an alternative to the WebSocket flow.
*   **Styling:** CSS is located in `src/App.css`.

### Testing the Frontend

Frontend tests use [Vitest](https://vitest.dev/) and [@testing-library/react](https://testing-library.com/docs/react-testing-library/intro/) in `src/__tests__/`.

```bash
npm test          # run tests
npm run coverage  # run tests with coverage
```

## Building for Production

```bash
npm run tauri build
```

Creates a standalone executable in `src-tauri/target/release/bundle/`.

## Architecture: The Secure Enclave

This application strictly employs a Level 2 (Sovereign) security posture using a "Secure Enclave" model:

1.  **The Vault (Rust Backend):** A 32-byte root seed and a vector of profile descriptors are persisted in base64-encrypted JSON at `{app_data}/vault.json`. All access is managed exclusively by Rust (`src-tauri/src/vault.rs`). **No private key material — derived or stored — is ever exposed to the JavaScript frontend context.** The frontend receives only `did:key:` strings via `Profile.did`.
2.  **Poll Vote Ledger (Rust Backend):** An immutable local audit trail of poll voting history is persisted as plain JSON at `{app_data}/poll_ledger.json`. The ledger is managed by the same `vault.rs` module and exposed to the frontend via `sync_vote_records` and `get_vote_history` Tauri commands. No private key material is stored in the ledger — only Ed25519 signatures over canonicalised poll payloads.
3.  **Deterministic Derivation:** Per-persona Ed25519 keypairs are derived inside the Rust process via `SHA-256(root_seed || LE(derivation_index))`. Individual profile private keys are never stored.
4.  **The Switchboard (React Frontend):** The UI manages user interactions and orchestrates signing by passing challenges to the backend via Tauri IPC (`sign_auth_challenge`, `submit_ws_response`, etc.). The `profile_id` is threaded from the WebSocket frame through the React popup and back to the signing command. Vote history retrieval is handled via `get_vote_history` / `sync_vote_records`. Headless `OMNI_SIGN_REQUEST` / `POLLY_V2` signing bypasses the React layer entirely and is handled directly in the Rust bridge.
5.  **Backend Cryptography:** VP signing, DID resolution, and OMNI payload canonicalisation + signing are performed natively in Rust by the combined `ed25519-dalek`, `sha2`, and `did_rust` libraries.
6.  **WASM Utilities:** `did_rust` is compiled to WebAssembly (`src/lib/did_rust_wasm/`) only for non-sensitive parsing and validation in the frontend.

---

## Architecture Evolution: What Was Removed

The v2 Channel architecture replaced two earlier approaches that were removed from the codebase:

| Approach | Problem | Removed |
|---|---|---|
| **Tauri Events** (`window.emit` / `listen`) | Silent permission failures, scoping mismatches between global and window listeners | ✅ Removed |
| **Polling** (`get_pending_ws_challenge`) | State shadowing — the WebSocket task wrote to a different `WsState` memory location than the command thread read from | ✅ Removed |

The `pending_challenge` field, `get_pending_ws_challenge` command, `UpdatePayload` struct, and `Emitter` import have all been deleted. The only challenge delivery path is `Channel<String>`.

### v3 Profile-Indexed Key Derivation

The vault was upgraded from a single `IdentityStore { did, private_key_base58 }` to a multi-persona `VaultStore { root_seed_base58, profiles: Vec<Profile> }`. Each profile at `derivation_index N` yields a unique Ed25519 keypair via `SHA-256(root_seed || LE(N))`.

| Change | Details |
|---|---|
| **Single key → root seed + profiles** | One 32-byte seed, N derived personas. No per-profile private keys stored. |
| **Deterministic derivation** | `derive_deterministic_keypair(root_seed, derivation_index)` — tested, same seed+index → same DID every time. |
| **Wire protocol** | All signing frames (`sign`, `sign_event`, `sign_credential`, `OMNI_SIGN_REQUEST`) accept `"profile_id"`. Absent/empty → defaults to index 0. |
| **Legacy removal** | `LegacyStore`, `migrate_from_legacy()`, `test_legacy_migration` — permanently deleted. Greenfield reset on any deserialization failure. |
| **Frontend awareness** | `KeysManager.tsx` displays all personas with truncated DIDs. `WsSignPopup.tsx` threads `profile_id` from the WS frame through to the Tauri signing command. |

## v3 Multi-Persona Configuration & Preference Persistence

The application maintains user state and settings globally inside `{app_data}/preferences.json` which is mapped dynamically per OS user account to enforce strict local environment security and multi-user isolation.

### State Persistence Layout

```json
{
  "activeProfileId": "primary",
  "defaultSigningProfile": "",
  "autoSign": false,
  "lastActiveTab": "services"
}
```

### Critical Behavioral Patterns

#### Active DID Resolution Hierarchy

When fetching the current identity via `get_active_did`, the system:

1. Polls the active runtime memory structure.
2. Falls back to looking up `active_profile_id` inside `preferences.json`.
3. Defaults cleanly to derivation index 0 (Primary Identity) if preferences are uninitialized or corrupt.

#### Persona Deletion & Safety Fallbacks

- The absolute Primary Identity (`profile_id: "primary"`, derivation index 0) is protected from deletion at both the frontend UI boundary and backend core validation layer.
- If an active custom persona is explicitly deleted, the state automatically cascades back to resetting the global active reference to the Primary Identity.

#### Headless Bridge Processing Limitations

**CRITICAL**: Headless protocol requests (`OMNI_SIGN_REQUEST` / `POLLY_V2`) bypass the React context state. If an incoming message contains an empty `profile_id`, the signing bridge continues to default strictly to derivation index 0 (Primary Identity) **regardless of what is currently selected inside the UI's user preference layer**. 

This is a **cryptographic distinction** that external applications must understand:

- **Empty/absent `profile_id`** → Always defaults to Primary Identity (Index 0)
- **Explicit `profile_id`** → Uses the specified persona
- **UI active profile preference** → Only applies to interactive React-based signing flows

Portals must provide explicit profile identifiers to target alternative identities. The headless bridge does not consult `preferences.json` and operates independently of the UI's active profile selection.

## Known Risks

1. **`submit_ws_response` sender race.** A concurrent `handle_connection` exit could clear `response_sender` between the clone and the send, dropping the signed VP silently.

2. **No channel re-registration.** If React unmounts and remounts `WsSignPopup`, it creates a new `Channel` and re-registers it. The old channel in the backend `Mutex` is simply replaced — the WebSocket task always reads the latest.

3. **Heartbeat Ping has no backpressure or retry.** A single failed ping kills the forwarder task and the response path with it.

4. **Forwarder exit race.** The 50ms sleep + explicit flush in the forwarder task mitigates the race where the task exits before the last message reaches the TCP stack, but does not eliminate it entirely under extreme load.
