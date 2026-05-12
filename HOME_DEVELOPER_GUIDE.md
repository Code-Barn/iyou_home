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

The backend is located in the `src-tauri` directory.

*   **Main Logic:** The core application logic is in `src-tauri/src/lib.rs`.
*   **Tauri Commands:** Rust functions exposed to the frontend are defined using the `#[tauri::command]` attribute.
*   **State Management:** Two state structs are managed by Tauri:
    - `ServiceState` — holds service status map and active DID.
    - `WsState` — holds the WebSocket response sender (`mpsc::UnboundedSender<Message>`) for sending signed VPs back, and the `challenge_channel` (`tauri::ipc::Channel<String>`) registered by React. All fields use `Mutex` for interior mutability.

### WebSocket Bridge (Port 9001)

The application runs a local WebSocket server on port 9001 that binds a single dual-stack `[::]:9001` socket (accepting both IPv4 and IPv6 connections). This is started inside the Tauri `.setup()` hook using `tauri::async_runtime::spawn`.

#### CORS / Private Network Access (PNA)
Chrome and Brave require a PNA pre-flight (OPTIONS) before allowing a public website to connect to a private-network WebSocket. The handler:
1. Peeks the first 4 bytes via `TcpStream::peek()`.
2. If `b"OPTI"` — responds 200 with `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true`.
3. If `b"GET"` — passes the untouched stream to `accept_hdr_async` whose callback injects the same headers into the 101 Switching Protocols response.

#### Signing Flow (v2 Channel Architecture)
1. React mounts `WsSignPopup.tsx`, creates a `new Channel<string>()`, sets `channel.onmessage`, and registers it with the backend via `invoke('register_challenge_pipe', { channel })`.
2. Browser sends `{"type":"sign","challenge":"..."}` (or `{"action":"sign",...}`) over the WebSocket.
3. The read loop spawns a background task via `tokio::spawn` (see *Async Logic Strike* below).
4. The background task brings the app window to focus, then sends the challenge through the registered `Channel` — this fires `onmessage` in React instantly.
5. React shows a modal with the challenge text and Approve/Deny buttons.
6. On approval, React calls `submit_ws_response` which signs the challenge and sends the VP back over the WebSocket via the `mpsc::UnboundedSender<Message>` stored in `WsState.response_sender`.

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

Current test suites:
- `test_toggle_service_start` / `test_toggle_service_stop` — service state transitions
- `test_sign_auth_challenge_logic` — DID generation + VP signing with proof validation
- `test_vault_encryption_decryption` — vault persistence round-trip

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

1.  **The Vault (Rust Backend):** Identity keys (DIDs and private seeds) are stored securely on the local filesystem and managed exclusively by Rust (`src-tauri/src/vault.rs`). **The private key is never exposed to the JavaScript frontend context.**
2.  **The Switchboard (React Frontend):** The UI manages user interactions and orchestrates signing by passing challenges to the backend via Tauri IPC (`sign_auth_challenge` command).
3.  **Backend Cryptography:** DID generation and VP signing is performed natively in Rust by the `did_rust` library.
4.  **WASM Utilities:** `did_rust` is compiled to WebAssembly (`src/lib/did_rust_wasm/`) only for non-sensitive parsing and validation in the frontend.

---

## Architecture Evolution: What Was Removed

The v2 Channel architecture replaced two earlier approaches that were removed from the codebase:

| Approach | Problem | Removed |
|---|---|---|
| **Tauri Events** (`window.emit` / `listen`) | Silent permission failures, scoping mismatches between global and window listeners | ✅ Removed |
| **Polling** (`get_pending_ws_challenge`) | State shadowing — the WebSocket task wrote to a different `WsState` memory location than the command thread read from | ✅ Removed |

The `pending_challenge` field, `get_pending_ws_challenge` command, `UpdatePayload` struct, and `Emitter` import have all been deleted. The only challenge delivery path is `Channel<String>`.

## Known Risks

1. **`submit_ws_response` sender race.** A concurrent `handle_connection` exit could clear `response_sender` between the clone and the send, dropping the signed VP silently.

2. **No channel re-registration.** If React unmounts and remounts `WsSignPopup`, it creates a new `Channel` and re-registers it. The old channel in the backend `Mutex` is simply replaced — the WebSocket task always reads the latest.

3. **Heartbeat Ping has no backpressure or retry.** A single failed ping kills the forwarder task and the response path with it.

4. **IPv6 dual-stack assumption.** Binding `[::]:9001` works on Linux/macOS but may fail on systems without IPv6.**
