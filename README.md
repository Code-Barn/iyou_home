# iYou Home: Tauri Service Switch Panel

This is a Tauri v2 companion application designed to manage local services like Nostr, Prosody, Blossom, and IPFS via a graphical user interface. The application features a React + TypeScript frontend and a Rust backend.

## Features

*   **Service Management:** Start and stop local services.
*   **Status Indicators:** Visual feedback on the current status of each service (Running, Stopped, Starting).
*   **WebSocket Bridge:** Accepts signature challenges from a browser-based IdP and signs them using the local Vault identity.
*   **Cross-Platform:** Built with Tauri for desktop compatibility.

## Project Structure

*   `src-tauri/`: Contains the Rust backend code and Tauri configuration.
*   `src/`: Contains the React + TypeScript frontend code.

## WebSocket Bridge (Port 9001)

The application runs a local WebSocket server on **port 9001** that listens on **both IPv4 (`0.0.0.0`) and IPv6 (`[::]`)** for browser-based identity provider handshakes.

### Dual-Stack Listener

Two concurrent `tokio::net::TcpListener` instances are started via `tokio::join!`:

- `0.0.0.0:9001` — IPv4
- `[::]:9001` — IPv6

This ensures that browsers resolving `localhost` to `127.0.0.1` or `[::1]` both connect immediately without a 60-second timeout.

### CORS / Private Network Access (PNA)

Chrome and Firefox require a CORS pre-flight (OPTIONS) before allowing a public网站 to connect to a private-network WebSocket. The server:

1. **Peek** reads the first 4 bytes of the TCP stream using `TcpStream::peek()`.
2. If `b"OPTI"` — responds with HTTP 200 and headers:
   - `Access-Control-Allow-Origin: *`
   - `Access-Control-Allow-Private-Network: true`
3. If `b"GET"` — passes the untouched stream to `tokio_tungstenite::accept_hdr_async()` with a callback that injects the same CORS headers into the 101 Switching Protocols response.

### Signing Flow

1. Browser sends `{"action":"sign","challenge":"..."}` over the WebSocket.
2. Rust saves the challenge to **Global Managed State** (`WsState.pending_challenge`), emits a `ws-sign-request` event on the `main` window, and brings the app to focus.
3. React polls `get_pending_ws_challenge` every 1 second as a fallback.
4. On approval, React calls `submit_ws_response` which signs the challenge and sends the VP back over the WebSocket via an `mpsc::UnboundedSender<Message>` channel.

## State Management Architecture

### State Shadowing Conflict (Historical)

A significant bug was encountered where the WebSocket task and the Tauri IPC commands operated on **different instances** of `WsState`. The dedicated TCP/WebSocket task was writing to a local or shadowed copy, while the React-polled command read from the Tauri-managed singleton — always seeing `None`.

**Fix:** All signing data must be written to the **Global Managed State** via `app_handle.state::<WsState>()`. The `AppHandle` is cloned from the `.setup()` closure and passed into the spawned `handle_connection` task. Both the WebSocket handler and the `get_pending_ws_challenge` command resolve to the same `WsState` instance registered via `.manage(WsState::default())`.

### Pull-Based Synchronization

Events (`ws-sign-request`) are emitted as a fast path, but the reliable path is a **1-second poll** where React calls `invoke('get_pending_ws_challenge')`. This ensures the popup appears even if:
- The Tauri event is blocked by permissions.
- The frontend reloads mid-handshake.
- The event system has a scoping mismatch.

## Getting Started

To get started with development or to run the application, please refer to the `DEVELOPER_GUIDE.md`.

## Recommended IDE Setup

*   [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
