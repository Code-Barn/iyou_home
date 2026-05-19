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

The backend is located in the `src-tauri` directory and is organised into five modules:

| Module | File | Responsibility |
|---|---|---|
| **vault** | `src/vault.rs` | Encrypted profile registry, root seed management, deterministic Ed25519 key derivation |
| **bridge** | `src/bridge.rs` | WebSocket server on port 9001 — parses inbound frames, routes by `profile_id`, pipes signing requests to React |
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

| Type | Action | Description |
|---|---|---|
| Type | Action | Description | Optional Fields |
|---|---|---|---|---|
| `sign` | `"sign"` or `"action":"sign"` | OIDC/VP challenge — returns a Verifiable Presentation signed with the derived Ed25519 key | `profile_id` |
| `sign_event` | `"sign_event"` or `"type":"sign_event"` | Nostr event signing — returns `{"type":"signed_event","event":{...}}` with `id` and `sig` (Ed25519, deviates from NIP-01 secp256k1) | `profile_id` |
| `sign_credential` | `"type":"sign_credential"` | W3C Verifiable Credential issuance — returns `{"type":"signed_credential","vc":{...}}` | `profile_id` |
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

Current test suites — **commands**:
- `test_toggle_service_start` / `test_toggle_service_stop` — service state transitions
- `test_sign_auth_challenge_logic` — VP signing with proof validation via derived keypair

## Identity Model

**Passwords are deprecated.** The primary entry point is the OIDC/DID loop:

1. A browser-based identity provider (IdP) at WUN or Polly initiates the flow by connecting to the local Signature Bridge.
2. The IdP sends a challenge (`sign`), a Nostr event (`sign_event`), or a credential body (`sign_credential`) over the WebSocket, optionally specifying a `"profile_id"` to select which persona performs the signing.
3. The user approves or denies via the React popup (`WsSignPopup`).
4. The Rust backend loads the vault, looks up the profile (or defaults to derivation index 0), derives the deterministic Ed25519 keypair from the root seed + `derivation_index`, signs, and returns the result over the same WebSocket connection.

### Multi-Persona Architecture

The vault stores a single 32-byte root seed (`root_seed_base58`) and a `Vec<Profile>`. Each profile has a `profile_id`, `profile_name`, `derivation_index`, and a cached `did:key:` string. No per-profile private keys are stored — all keys are derived deterministically:

```
Ed25519 keypair = SHA-256(root_seed || LE(derivation_index))
```

| Tauri Command | Description |
|---|---|
| `list_profiles` | Returns all profiles (public DID only, no private material) |
| `add_profile(profileName)` | Creates a new persona at the next unused `derivation_index` |
| `get_active_did` | Returns the DID of the currently active profile |

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

### Greenfield Resets

If `vault.json` is missing, corrupt, or fails to deserialize as a valid `VaultStore`, `load_vault` immediately generates a fresh 32-byte root seed, creates a "Primary Identity" profile at index 0, and overwrites the file. No legacy format migration is attempted — the old single-key `IdentityStore` schema has been permanently removed.

There is no password-based authentication for the signing flow. The XMPP (Chat) service uses a locally-generated password file for SASL PLAIN (`{app_data}/xmpp_password.txt`) — this is a transport credential, not an identity credential. All higher-level identity operations go through the DID/Vault+WebSocket path.

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
2.  **Deterministic Derivation:** Per-persona Ed25519 keypairs are derived inside the Rust process via `SHA-256(root_seed || LE(derivation_index))`. Individual profile private keys are never stored.
3.  **The Switchboard (React Frontend):** The UI manages user interactions and orchestrates signing by passing challenges to the backend via Tauri IPC (`sign_auth_challenge`, `submit_ws_response`, etc.). The `profile_id` is threaded from the WebSocket frame through the React popup and back to the signing command.
4.  **Backend Cryptography:** VP signing and DID resolution is performed natively in Rust by the `did_rust` library.
5.  **WASM Utilities:** `did_rust` is compiled to WebAssembly (`src/lib/did_rust_wasm/`) only for non-sensitive parsing and validation in the frontend.

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
| **Wire protocol** | All signing frames accept `"profile_id"`. Absent/empty → defaults to index 0. |
| **Legacy removal** | `LegacyStore`, `migrate_from_legacy()`, `test_legacy_migration` — permanently deleted. Greenfield reset on any deserialization failure. |
| **Frontend awareness** | `KeysManager.tsx` displays all personas with truncated DIDs. `WsSignPopup.tsx` threads `profile_id` from the WS frame through to the Tauri signing command. |

## Known Risks

1. **`submit_ws_response` sender race.** A concurrent `handle_connection` exit could clear `response_sender` between the clone and the send, dropping the signed VP silently.

2. **No channel re-registration.** If React unmounts and remounts `WsSignPopup`, it creates a new `Channel` and re-registers it. The old channel in the backend `Mutex` is simply replaced — the WebSocket task always reads the latest.

3. **Heartbeat Ping has no backpressure or retry.** A single failed ping kills the forwarder task and the response path with it.

4. **Forwarder exit race.** The 50ms sleep + explicit flush in the forwarder task mitigates the race where the task exits before the last message reaches the TCP stack, but does not eliminate it entirely under extreme load.
