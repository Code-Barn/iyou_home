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
    - `WsState` — holds the WebSocket response sender channel and a `pending_challenge: Mutex<Option<String>>` for polling-based challenge delivery. Both fields use `Mutex` for interior mutability.

### WebSocket Bridge (Port 9001)

The application runs a local WebSocket server on port 9001 that listens on **both IPv4 (`0.0.0.0`) and IPv6 (`[::]`)** via concurrent `tokio::net::TcpListener` instances joined with `tokio::join!`. This is started inside the Tauri `.setup()` hook using `tauri::async_runtime::spawn`.

#### CORS / Private Network Access (PNA)
Chrome and Brave require a PNA pre-flight (OPTIONS) before allowing a public website to connect to a private-network WebSocket. The handler:
1. Peeks the first 4 bytes via `TcpStream::peek()`.
2. If `b"OPTI"` — responds 200 with `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true`.
3. If `b"GET"` — passes the untouched stream to `accept_hdr_async` whose callback injects the same headers into the 101 Switching Protocols response.

#### Signing Flow
1. Browser sends `{"action":"sign","challenge":"..."}` over the WebSocket.
2. Rust saves the challenge to `WsState.pending_challenge` (global managed state), emits a `ws-sign-request` event on the `main` window, and brings the app to focus.
3. React polls `get_pending_ws_challenge` every 1 second as fallback.
4. On approval, React calls `submit_ws_response` which signs the challenge and sends the VP back over the WebSocket via the `mpsc::UnboundedSender<Message>` channel stored in `WsState.response_sender`.

#### Known Issue: State Shadowing Conflict
A recurring bug is that the WebSocket TCP task can end up writing to a **different instance** of `WsState` than the one the Tauri commands read from. The fix is to always pass `app_handle.clone()` into `handle_connection` and access state via `app_handle.state::<WsState>()`. Never capture state from outside the task closure.

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
- `test_pending_challenge_stress` — concurrent read/write stress test on `WsState.pending_challenge` (200 iterations each, 5-10ms intervals)
- `test_vault_encryption_decryption` — vault persistence round-trip

## Frontend (React)

The frontend is a React application located in the `src` directory.

*   **Main Component:** The main UI is defined in `src/App.tsx`.
*   **Communicating with the Backend:** The frontend uses the `@tauri-apps/api/core` package to `invoke` commands exposed by the Rust backend.
*   **WebSocket Sign Popup:** `src/components/WsSignPopup.tsx` listens for the `ws-sign-request` event (via `getCurrentWebviewWindow().listen`) AND polls `get_pending_ws_challenge` every 1 second. Shows a modal with challenge text, Approve/Deny buttons, and an auto-sign checkbox for development.
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

## WARNING: This Code Has Not Worked Once — 10,000 Attempts, All Day

Despite dozens of iterations across event models, state architectures, and communication patterns, the WebSocket bridge **has never successfully delivered a challenge from the browser to the React popup**. Every path tried has failed:

- Tauri events (`emit` / `listen`) — silent failures, permissions errors, scoping mismatches
- Polling (`get_pending_ws_challenge`) — always returns `None` because the WebSocket task was writing to a shadowed state instance
- `oneshot` channels — blocking architecture caused deadlocks
- `PrependStream` + manual `read` — 60-second hangs
- `accept_hdr_async` with custom callback — silent handshake rejections

### Known Risks Still Open

1. **State Shadowing may still be latent.** The tokio-spawned forwarder task and the WebSocket read loop both independently clear `ws_state.response_sender` on exit. If timings align wrong, `submit_ws_response` sees `None` even though a connection is alive.

2. **Event scoping is fragile.** The switch from global `listen` to `getCurrentWebviewWindow().listen` fixed a permission issue but may have broken the event delivery path entirely — polling is the only fallback.

3. **`submit_ws_response` lock race.** The `response_sender` Mutex is narrowly scoped now, but a concurrent `handle_connection` exit could clear the sender between the clone and the send, dropping the message silently.

4. **Heartbeat Ping has no backpressure or retry.** A single failed ping kills the forwarder task and the response path with it.

5. **IPv6 listener untested** — `[::]:9001` may fail on systems without IPv6.

**This code has never worked. Assume everything is broken until proven otherwise with a manual end-to-end test via `tauri dev`.**
