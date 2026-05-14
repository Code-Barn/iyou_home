# iYou Home: Sovereign Local Service Hub

A Tauri v2 desktop companion that manages local sovereign services (Nostr relay, Blossom, XMPP) and provides a **Signature Bridge** for browser-based identity providers (WUN, Polly) to sign Verifiable Credentials, Nostr events, and OIDC challenges using a local Ed25519 vault.

## Features

- **Signature Bridge** (port 9001, always on) — WebSocket gateway for cross-origin signing: `sign`, `sign_event`, `sign_credential`, `ping`.
- **Nostr Relay** (port 9003) — NIP-01 relay with SQLite storage, Ed25519 signature verification, vault-pubkey whitelist.
- **Blossom Server** (port 9002) — BUD-01 blob store with SHA-256 content addressing.
- **XMPP Chat** (port 5222) — Minimal embedded XMPP server with SASL PLAIN, TCP and WebSocket transports.
- **Auto-Start** — Service preferences persisted to `{app_data}/auto_start.json`, restored on launch.
- **Vault Identity** — Ed25519 keypair stored locally, never exposed to the frontend context.
- **PNA Compliant** — `Access-Control-Allow-Private-Network: true` on all preflight responses (required by Safari/Chrome).

## Signature Bridge Protocol

All messages are JSON over WebSocket to `ws://127.0.0.1:9001`.

| Type | Incoming | Outgoing |
|---|---|---|
| `sign` | `{"type":"sign","challenge":"..."}` | `{"type":"signature","vp":{...}}` |
| `sign_event` | `{"type":"sign_event","event":{...}}` | `{"type":"signed_event","event":{...}}` |
| `sign_credential` | `{"type":"sign_credential","credential":{...},"holder_did":"..."}` | `{"type":"signed_credential","vc":{...}}` |
| `ping` | `{"type":"ping"}` | `{"type":"pong"}` |

- `holder_did` is optional — defaults to the vault DID when omitted.
- `sign_credential` credential type array is parsed for a human-readable title (e.g. `"family_membership"` → `"Family Membership Signing Request"`).

## Networking

**All services bind to `127.0.0.1` only.** No public or LAN exposure.

Private Network Access (PNA) headers (`Access-Control-Allow-Private-Network: true`) are injected into every OPTIONS preflight and WebSocket upgrade response, required by Safari and Chrome when a public HTTPS origin connects to a local endpoint.

## Identity Model

**Passwords are deprecated.** The primary authentication flow is the OIDC/DID loop through the Signature Bridge. The XMPP service uses a local auto-generated password file for SASL PLAIN transport auth only — all higher-level identity operations use the vault Ed25519 keypair.

## Project Structure

```
src-tauri/src/
├── lib.rs          — Core: WS dispatcher, Tauri commands, auto-start, shutdown
├── vault.rs        — Ed25519 keypair persistence (loaded DID)
├── blossom.rs      — BUD-01 blob server on 127.0.0.1:9002
├── nostr_relay.rs  — NIP-01 WebSocket relay on 127.0.0.1:9003
└── prosody.rs      — Minimal XMPP server on 127.0.0.1:5222

src/
├── App.tsx                     — Service switch panel UI
├── components/
│   ├── WsSignPopup.tsx         — Signing approval modal
│   └── SovereignSigner.tsx     — Manual challenge paste UI
└── __tests__/
    └── App.test.tsx
```

## Getting Started

See [HOME_DEVELOPER_GUIDE.md](./HOME_DEVELOPER_GUIDE.md) for setup instructions, architecture details, and known risks.
