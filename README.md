# iyou_home: Sovereign Local Service Hub & Identity Enclave (v0.2.0)

`iyou_home` is a zero-custody, local-first sovereign identity enclave, Personal Data Store (PDS), and P2P service switchboard built on Tauri v2 and Rust. It secures cryptographic root seeds, derives multi-tier persona keys, orchestrates local loopback microservices, and serves cryptographic signatures to satellite applications over an authenticated local WebSocket bridge (`wss://home.iyou.me:9001`).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       iyou_home Desktop Node Architecture                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   React 19 + TypeScript Frontend (Tauri v2 Desktop Shell & System Tray)      │
│   ├── 💬 Messages          (Split-Pane OMEMO Double Ratchet Chat)          │
│   ├── 🛡️ Enclave           (Project Zero Persona Matrix & Trust Lenses)     │
│   ├── 📜 Credentials       (W3C Verifiable Credential Repository)           │
│   ├── 🔑 Vault & Recovery  (Master Seed Reveal, .iyoubackup, Mobile Pair)   │
│   ├── ⚙️ Services          (Sovereignty HUD, Daemon Switchboard, Sync)     │
│   ├── 📊 Governance        (Blossom BUD-01 & IPFS Merkle Poll Auditor)      │
│   └── ✍️ Dispatcher        (Notes, Blossom Media, Civic Poll Publisher)     │
│                                                                             │
│   ─────────── IPC Boundary (Zero Raw Key Leakage / Strict FFI) ─────────── │
│                                                                             │
│   Rust Sovereign Enclave (Air-Gapped Root Seed & Dual-Curve Derivation)     │
│   ├── Dual Curve: Ed25519 (did:key) + secp256k1 (BIP-340 Schnorr)          │
│   ├── Level 0 Air-Gapped Anchor Sanctum (Strict Isolation from Satellites)  │
│   ├── Level 1 Public Persona & Level 2+ Contextual Disposable Burners       │
│   ├── Memory-Only Cryptographic Signatures & Dynamic Ledger Sealing         │
│   └── Background Process Persistence (macOS Monochrome Tray Menu)           │
│                                                                             │
│   ────────── Loopback Microservice Switchboard (127.0.0.1 Only) ────────── │
│                                                                             │
│   ├── :9001 Signature Bridge   (WSS / PNA Headers / OIDC & Satellite Auth)  │
│   ├── :9002 Blossom Media PDS  (BUD-01 Content-Addressed Blob Storage)      │
│   ├── :9003 Nostr Ingress Relay(SQLite Event Cache: Kinds 1, 1063, 30023)   │
│   └── :5222 Prosody XMPP Mesh  (RFC 7395 / OMEMO E2EE Chat Messaging)      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Capabilities

- **💬 Split-Pane OMEMO Encrypted Messaging**: Local XMPP-over-WebSocket daemon (`:5222`) paired with OMEMO Double Ratchet session management for peer-to-peer end-to-end encrypted messaging.
- **🛡️ Project Zero Enclave & 3-Tier Persona Matrix**:
  - **Level 0 (Anchor Sanctum)**: Air-gapped immutable identity for high-assurance root custody.
  - **Level 1 (Public Persona)**: Default active persona for social publishing and satellite authentication, with Break-Glass emergency rotation.
  - **Level 2+ (Contextual Burners)**: Disposable, topic-specific identities.
  - **Contact Enclave**: 3-tier trust badges (`Inner Circle`, `Trusted Alliance`, `Peer`) with Selective Disclosure card generation and import.
- **🛡️ Private Enclave Sovereignty HUD**: Real-time capability matrix evaluating Key Custody, Local Nostr Ingress, Blossom Media PDS, Relay Gossip Mesh, and Encrypted Backup freshness with one-click resolution.
- **📱 Mobile QR Pairing Station**: Encrypted ECDH X25519 sealed seed transit (`iyouhome://pair`) using HKDF domain `iyou-home/pair/v1` for instant onboarding to mobile companions.
- **🔒 App Lock & First-Run Security Gate**: Interactive 3-word master seed confirmation gate on greenfield vaults; OS biometric or PIN app lock screen guard with configurable inactivity auto-lock.
- **✍️ Quick Dispatcher**: Top-bar action for publishing plaintext notes (Kind 1), Blossom media attachments (Kind 1063), and civic poll definitions (Kind 30023) with dual loopback and public relay broadcasting.
- **📜 Trust Assets & Credential Repository**: Sovereign W3C Verifiable Credential vault with persona filtering, keyword search, and universal JSON/file import with structural validation.
- **🔑 Disaster Recovery & Global Revocation**: Master seed reveal (with typed confirmation & auto-dismiss), password-encrypted `.iyoubackup` archive export/restore (bundling core JSON ledgers and `{app_data}/ledgers/`), and Global Session Revocation Kill-Switch (`GLOBAL_SESSION_REVOKE`).
- **⚙️ Sovereign Service Switchboard**: Loopback daemon controls (`:9001`, `:9002`, `:9003`, `:5222`), embedded Offline Media Vault (`BlossomBrowser`), and Sync-to-Home local mirroring pipeline.
- **📊 Governance Auditor**: Cold poll integrity verification with local second-preimage resistant SHA-256 Merkle root computation over Blossom BUD-01 snapshots and IPFS CIDs.
- **🖥️ System Tray Persistence**: Background daemon lifecycle with macOS template mode monochrome menu bar icon and `Hide on Close` execution.

---

## Prerequisites

- **Rust & Cargo**: `>= 1.78.0`
- **Node.js & npm**: `>= 20.x`
- **Tauri v2 CLI**: System build tools (Xcode Command Line Tools on macOS, `build-essential` / `webkit2gtk` on Linux)

---

## Getting Started

```bash
# 1. Clone the repository
git clone https://github.com/byers-brands/iyou_home.git
cd iyou_home

# 2. Install frontend dependencies
npm install

# 3. Launch the Tauri desktop application in development mode
npm run tauri dev
```

---

## Production Build & Packaging

```bash
# Compile and package native release bundle (.dmg, .AppImage, .deb, or .msi)
npm run tauri build
```

---

## Verification & Test Suites

```bash
# Execute backend Rust unit and integration test suite (90 tests)
cargo test --manifest-path src-tauri/Cargo.toml

# Run TypeScript typechecking & Vite production build
npx tsc --noEmit && npm run build

# Run Vitest frontend test runner (74 unit tests across 10 test files)
npx vitest run
```

---

## Network Architecture & Invariants

All local daemons bind strictly to IPv4 loopback `127.0.0.1`. No service ever listens on `0.0.0.0` or public network interfaces.

| Service | Port | Wire Protocol | Binding | Purpose |
|---|---|---|---|---|
| **Signature Bridge** | `9001` | WSS (RFC 6455 over TLS) | `127.0.0.1` | Cross-origin signing and satellite bridge with PNA headers |
| **Blossom Server** | `9002` | HTTP / BUD-01 | `127.0.0.1` | Local SHA-256 media and file blob store |
| **Nostr Relay** | `9003` | WS / NIP-01 | `127.0.0.1` | Local SQLite-backed Nostr event relay |
| **Prosody XMPP Mesh** | `5222` | WSS (RFC 7395) | `127.0.0.1` | P2P mesh chat and OMEMO Double Ratchet signaling |

---

## Documentation

- [AGENT.md](./AGENT.md) — Root operational contract, security invariants, and complete Tauri IPC command registry.
- [HOME_DEVELOPER_GUIDE.md](./docs/HOME_DEVELOPER_GUIDE.md) — Comprehensive technical reference, cryptographic derivation engine, wire protocols, and pairing specifications.
- [RELEASE_SPEC_V2.md](./docs/RELEASE_SPEC_V2.md) — V2.0 sovereign release baseline and subsystem specifications.
- [TODO.md](./TODO.md) — Release roadmap tracking completed Phases 1 through 10.
