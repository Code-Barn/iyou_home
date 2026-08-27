# iyou_home: Sovereign Local Service Hub & Identity Enclave (v2.0)

`iyou_home` is a zero-custody, local-first identity enclave, Personal Data Store (PDS), and service switchboard built on Tauri v2 and Rust. It secures private key seeds, manages multi-tier persona derivations, orchestrates local P2P microservices, and serves cryptographic signatures to satellite web applications over a secure local WebSocket bridge (`wss://home.iyou.me:9001`).

---

## Key Features

- **🛡️ Project Zero Enclave**: Multi-tier persona management (Level 0 Air-Gapped Anchor, Level 1 Public Persona, Level 2+ Contextual Burners), Break-Glass persona rotation, and Contact Enclave with 3-tier trust badges.
- **📜 Trust Assets & Credential Vault**: Sovereign W3C Verifiable Credential repository with persona filtering, keyword search, and universal JSON/file import with W3C structural validation.
- **🔑 Disaster Recovery & Global Revocation**: Master seed reveal (with typed confirmation & auto-dismiss), password-encrypted `.iyoubackup` export/restore, and Global Session Revocation Kill-Switch (`GLOBAL_SESSION_REVOKE`).
- **⚙️ Sovereign Service Switchboard**:
  - **Signature Bridge** (`127.0.0.1:9001` / `wss://home.iyou.me:9001`) — Cross-origin signing gateway for `iyou_wun`, `iyou_poly`, `iyou_talk`.
  - **Nostr Relay** (`127.0.0.1:9003`) — Embedded NIP-01 SQLite relay with BIP-340 Schnorr signature verification.
  - **Blossom Server** (`127.0.0.1:9002`) — BUD-01 content-addressed blob server.
  - **XMPP Mesh** (`127.0.0.1:5222`) — Embedded local XMPP communication mesh.
- **🔄 Sync-to-Home Local Mirroring Pipeline**: Ingests batch Nostr events and content-addressed Blossom media blobs from upstream servers into local residency.
- **🗳️ Governance Auditor**: Cold poll integrity auditor with local second-preimage resistant SHA-256 Merkle root computation over IPFS and Blossom BUD-01 vote snapshots.

---

## Prerequisites

- **Rust & Cargo**: `>= 1.78.0`
- **Node.js & npm**: `>= 20.x`
- **Tauri v2 CLI**: System build tools (Xcode CLI on macOS, build-essential / webkit2gtk on Linux)

---

## Getting Started

```bash
# 1. Clone the repository
git clone https://github.com/byers-brands/iyou_home.git
cd iyou_home

# 2. Install frontend dependencies
npm install

# 3. Launch the Tauri desktop app in development mode
npm run tauri dev
```

---

## Verification & Testing

```bash
# Execute backend Rust unit and integration tests (66 tests)
cargo test --manifest-path src-tauri/Cargo.toml

# Run TypeScript typechecking & Vite production build
npx tsc --noEmit && npm run build

# Run Vitest test runner (30 unit tests)
npx vitest run
```

---

## Network Architecture & Invariants

All local daemons bind strictly to IPv4 loopback `127.0.0.1`. No service ever listens on `0.0.0.0` or public network interfaces.

| Service | Port | Protocol | Binding | Purpose |
|---|---|---|---|---|
| **Signature Bridge** | `9001` | WSS (TLS) | `127.0.0.1` | Cross-origin signing and satellite bridge |
| **Blossom Server** | `9002` | HTTP / BUD-01 | `127.0.0.1` | Local SHA-256 media and file blob store |
| **Nostr Relay** | `9003` | WS / NIP-01 | `127.0.0.1` | Local SQLite-backed Nostr event relay |
| **XMPP Mesh** | `5222` | WSS (TLS) | `127.0.0.1` | P2P mesh chat and real-time signaling |

---

## Documentation

- [AGENT.md](./AGENT.md) — Root operational contract, invariants, and Tauri IPC command registry.
- [HOME_DEVELOPER_GUIDE.md](./docs/HOME_DEVELOPER_GUIDE.md) — Comprehensive technical reference, cryptographic derivation engine, and wire protocol details.
- [TODO.md](./TODO.md) — Release roadmap and completed implementation phases.
