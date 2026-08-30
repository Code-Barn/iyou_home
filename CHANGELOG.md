# Changelog

All notable changes to the `iyou_home` sovereign desktop node are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semantic-versioning.org/spec/v2.0.0.html).

---

## [v0.2.0-sovereign] - 2026-08-29

### 🎉 Initial Sovereign Desktop Release (Phases 1–10 Complete)

#### 💬 Decentralized OMEMO Messaging & XMPP Mesh (Port 5222)
- **Split-Pane Chat Inbox (`MessagesTab.tsx`)**: Real-time peer-to-peer chat interface with contact address resolution (`npub`, `did:key`, raw hex, and bare JID formats).
- **Embedded Prosody XMPP Daemon**: WebSocket transport (RFC 7395) bound strictly to loopback `:5222` with SASL PLAIN authentication against the Level 1 persona.
- **OMEMO Double Ratchet Session Engine**: Identity key, signed prekey, and one-time prekey bundle management (`omemo_publish_bundle`, `omemo_fetch_peer_bundle`, `omemo_list_devices`).

#### 🛡️ Project Zero Enclave & Identity Hierarchy
- **3-Tier Persona Matrix (`ProjectZero.tsx`)**:
  - **Level 0 (Anchor Sanctum)**: Immutable air-gapped root identity for high-assurance custody and selective disclosures.
  - **Level 1 (Public Persona)**: Default active persona for social publishing, W3C credentials, and satellite authentication.
  - **Level 2+ (Contextual Burners)**: Disposable contextual identities.
- **Break-Glass Rotation**: Emergency rotation mechanism that burns the active Level 1 persona and mints a fresh primary without affecting the Level 0 Anchor.
- **Contact Enclave & Selective Disclosure**: 3-tier peer trust badges (`Inner Circle`, `Trusted Alliance`, `Peer`), alias resolution, and signed disclosure card generation/import.
- **WebAuthn PRF Graduation**: 6-step Sovereign Custody Graduation Wizard with X25519 sealed seed transit.

#### 🛡️ Private Enclave Sovereignty HUD
- **Diagnostic Matrix (`SovereigntyStatusPanel.tsx`)**: Real-time checklist evaluating Key Custody, Local Nostr Ingress (`:9003`), Blossom Media PDS (`:9002`), Relay Gossip Mesh ($\ge 3$ relays), and Encrypted Vault Backup freshness (< 30 days).
- **One-Click Remediation**: Inline buttons to start daemons, ping the gossip mesh, add custom relays, and trigger encrypted backups.
- **Loopback Diagnostic Probes (`bridge.rs`)**: Secure WebSocket query handlers (`ENCLAVE_DIAGNOSTIC_QUERY`, `DIAGNOSTIC_PROBE`) exposing service availability without leaking private keys.

#### 📱 Mobile QR Pairing Station
- **ECDH X25519 Transit (`PairingModal.tsx`)**: QR-based root seed transfer (`iyouhome://pair?frame_id=...&x25519=...&nonce=...&ver=1`) using HKDF domain `iyou-home/pair/v1` and AES-256-GCM.
- **Paired Device Management**: Registration and revocation of mobile companions in `pairing.json`.

#### 🔒 App Lock & First-Run Security Gate
- **First-Run Seed Confirmation (`FirstRunSeedGate.tsx`)**: Interactive onboarding challenge requiring users to confirm 3 random seed words or verified typed acknowledgment before dashboard access.
- **OS Biometric / PIN App Lock (`AppLockOverlay.tsx`)**: Local screen guard on launch, wake, and configurable inactivity auto-lock (5m, 15m, 1h, Never).
- **High-Stakes Re-Authentication**: Enforces fresh biometric or PIN check on seed reveal, vault export, and danger zone resets.

#### ✍️ Quick Dispatcher & Mesh Publishing
- **Top-Bar Dispatcher (`QuickDispatchModal.tsx`)**: Publish plain text notes (Kind 1), Blossom media attachments (Kind 1063), and civic poll definitions (Kind 30023).
- **Dual Broadcast**: Automatically broadcasts published events to the loopback relay (`ws://127.0.0.1:9003`) and the configured public gossip mesh.

#### 📜 Trust Assets & Credential Repository
- **W3C Verifiable Credential Vault (`TrustAssets.tsx`)**: Credential browsing with persona filtering, keyword search, fidelity badges, and raw JSON payload inspection.
- **Universal Import Modal**: Ingests W3C VCs from JSON text or file uploads with full structural verification (`@context`, `type`, `issuer`, `credentialSubject`, `proof`).

#### 🔑 Vault Recovery & Redundancy
- **Master Seed Reveal**: High-friction reveal flow with typed confirmation (`REVEAL MY SEED`), 10-second countdown, and 30-second auto-dismiss.
- **Dynamic `.iyoubackup` Archive**: Password-encrypted container (HKDF-SHA256 + AES-256-GCM) bundling `vault.json`, `contacts.json`, `pairing.json`, `preferences.json`, and all files in `{app_data}/ledgers/`.
- **Global Session Kill-Switch**: Signed `GLOBAL_SESSION_REVOKE` token dispatch to IdP to terminate all active web sessions across satellites.

#### ⚙️ Service Switchboard, Media PDS & Mirroring
- **Daemon Switchboard (`ServiceSwitchPanel.tsx`)**: Controls for Signature Bridge (`:9001`), Blossom Server (`:9002`), Nostr Relay (`:9003`), and XMPP Mesh (`:5222`).
- **Offline Media Vault (`BlossomBrowser.tsx`)**: Local Blossom BUD-01 blob browser with SHA-256 links, size metrics, and deletion.
- **Sync-to-Home Local Mirroring Pipeline**: Batch ingestion of Nostr events into local SQLite and background media mirroring from remote Blossom CDNs.

#### 📊 Governance Auditor
- **Poll Integrity Station (`GovernanceAuditor.tsx`)**: Blossom BUD-01 and IPFS vote snapshot auditor with local second-preimage resistant SHA-256 Merkle root computation over ballot records.
- **Offline Sovereign Footprint (`SovereignFootprint.tsx`)**: Metric tile matrix reporting live local counts for notes, media blobs, credentials, contacts, and poll audit records.

#### 🖥️ Desktop Shell & System Tray
- **Background Daemon Persistence**: `Hide on Close` window lifecycle keeping background services active.
- **macOS Monochrome Menu Bar Icon**: Built in macOS template mode with quick menu actions (`Open Enclave`, `Lock App`, `Quit`).