# TODO — iyou_home (Tauri/Rust Local Enclave)

**Codified from:** `docs/RELEASE_SPEC_V2.md`  
**Last updated:** 2026-08-29 (V2.0 Sovereign Release Complete)

---

## Day 1 Release Roadmap (Phases 1–10 Complete)

All execution phases are complete and verified across both backend and frontend.

---

### Phase 1: Shell Harmonization & Tab Reordering

> Unify the global frame, reorder tabs by user importance, and gate developer controls.

- [x] **1.1** Add persistent top status bar with live daemon indicators (Bridge, Nostr, Blossom) and active persona pill — visible on all tabs
- [x] **1.2** Expand container width from `800px` to `1024px` (`max-w-5xl`)
- [x] **1.3** Reorder tabs: Messages → Enclave → Credentials → Vault → Services → Governance → Signer
- [x] **1.4** Set default active tab to `enclave` on launch
- [x] **1.5** Extract `ServiceSwitchPanel` from `App.tsx` into `src/components/ServiceSwitchPanel.tsx`
- [x] **1.6** Remove "Coming Soon" entries (IPFS Cloud Archive, Polly) from service list
- [x] **1.7** Hide port numbers behind "Technical Details" disclosure in Services tab
- [x] **1.8** Add service descriptions under each daemon name
- [x] **1.9** Add Developer Mode toggle (footer or `Cmd+Shift+D`) — gates Tab 6/7 visibility and debug controls
- [x] **1.10** Hide "Auto-sign (dev)" checkbox in `WsSignPopup.tsx` behind dev mode
- [x] **1.11** Gate `console.log` statements in `WsSignPopup.tsx` behind `import.meta.env.DEV`
- [x] **1.12** Add icons to all tab labels for visual consistency
- [x] **1.13** Migrate Enclave design tokens (tier colors, status colors, surface colors) into CSS custom properties in `:root`
- [x] **1.14** Migrate Tabs to use shared CSS design tokens

**Verification:** Status bar renders on all tabs. Tab order matches spec. Dev mode toggle hides/shows Manual Signer.

---

### Phase 2: Vault Disaster Recovery Engine

> Build encrypted backup/restore and master seed reveal for identity continuity.

- [x] **2.1** Rename tab from "Backup & Recovery" to "Vault & Recovery"; update heading to "Identity Vault"
- [x] **2.2** Replace "Generate did:key" button with "Create New Vault" + explanatory copy
- [x] **2.3** Remove multi-persona redirect banner from `KeysManager.tsx`
- [x] **2.4** Show persona context (name, level, index) alongside active DID display
- [x] **2.5** Implement Master Seed Reveal modal: typed confirmation (`REVEAL MY SEED`), 10-second countdown, one-time display, auto-dismiss after 30s
- [x] **2.6** Implement `.iyoubackup` encrypted archive export: password-protected (HKDF-SHA256 + AES-256-GCM) packaging of `vault.json` + `contacts.json` + `pairing.json` + `preferences.json` + `ledgers/`
- [x] **2.7** Implement `.iyoubackup` import: password-derived decryption, manifest validation, user-confirmed merge/replace
- [x] **2.8** Move seed import form (DID + Base58 key) behind "Advanced" disclosure toggle
- [x] **2.9** Add unit tests for `.iyoubackup` round-trip: create → export → fresh import → verify profiles match

**Verification:** Export produces valid `.iyoubackup`; import on fresh vault restores all profiles, contacts, and companion files.

---

### Phase 3: Governance & Merkle Consensus Station

> Replace the developer IPFS viewer with a user-facing poll integrity auditor.

- [x] **3.1** Create `src/components/GovernanceAuditor.tsx` with plain-language UI
- [x] **3.2** Implement source selector: Blossom BUD-01 vote snapshot (default) or IPFS CID (advanced)
- [x] **3.3** Implement snapshot fetch and poll summary display (title, vote count, asserted Merkle root)
- [x] **3.4** Implement local Merkle root computation via `invoke("calculate_vote_merkle_root")`
- [x] **3.5** Implement audit result display: green "Verified" badge (match) or red "Tampered" alert with root comparison
- [x] **3.6** Rename tab from "IPFS Cloud Archive" to "Governance Auditor" with ballot icon
- [x] **3.7** Deprecate `IpfsArchiveViewer.tsx` (remove import from `App.tsx`, retain file for reference)
- [x] **3.8** Add persona selector to `TrustAssets.tsx` for browsing credentials across all personas
- [x] **3.9** Add credential type search/filter to `TrustAssets.tsx`
- [x] **3.10** Improve TrustAssets empty state with "How to get credentials" guidance

**Verification:** Governance tab renders with Blossom/IPFS inputs. Merkle audit produces match/mismatch result. TrustAssets shows persona dropdown and filters credentials by type.

---

### Phase 4: Sync-to-Home Local Mirroring Pipeline

> Enable offline-first data residency by mirroring remote events into local daemons.

- [x] **4.1** Implement Bridge batch event ingestion: fetch remote Nostr events (Kinds 1, 1063, 1111, 30023) from upstream relay and write to local SQLite (`:9003`)
- [x] **4.2** Implement Bridge media blob mirroring: fetch content-addressed blobs from upstream Blossom and store locally (`:9002`)
- [x] **4.3** Add sync status indicator to Services tab and Global Status Bar: "Last synced: {timestamp}"
- [x] **4.4** Implement incremental sync: track high-water mark timestamp, ingest missing events/blobs
- [x] **4.5** Add error handling for upstream unreachable: graceful degradation with local cache fallback

**Verification:** Local Nostr relay contains remote events. Local Blossom contains mirrored blobs. Sync status visible in Services tab and Global Status Bar.

---

### Phase 5: Global Session Revocation & Universal Credential Ingest

> Sovereign session kill-switch and W3C VC structural validation import.

- [x] **5.1** Implement `build_session_revocation_payload` in `vault.rs`: generates signed `GLOBAL_SESSION_REVOKE` token using Level 1 Ed25519 key
- [x] **5.2** Add `revoke_all_sessions` Tauri IPC command: HTTP POST signed revocation envelope to `https://iyou.me/api/auth/revoke-all/`
- [x] **5.3** Add "Active Web Sessions" Kill-Switch card and confirmation modal in `KeysManager.tsx`
- [x] **5.4** Add Sovereign Data Redundancy banner to `KeysManager.tsx` explaining local export, home Blossom node, and public Nostr relays
- [x] **5.5** Move manual vault re-initialization into high-friction collapsed Danger Zone at bottom of `KeysManager.tsx`
- [x] **5.6** Implement `add_credential_to_profile` in `vault.rs`: verifies W3C structural integrity (`@context`, `type`, `issuer`, `credentialSubject`, `proof`) with deduplication
- [x] **5.7** Add `import_verifiable_credential` Tauri IPC command
- [x] **5.8** Add `[ + Import Credential ]` modal in `TrustAssets.tsx` with JSON textarea and `.json` file upload support

**Verification:** Revocation dispatches signed envelope. W3C VCs import cleanly with validation.

---

### Phase 6: Split-Pane OMEMO Chat & XMPP Mesh

> Peer-to-peer encrypted messaging over local loopback Prosody daemon.

- [x] **6.1** Embedded Prosody XMPP daemon with WebSocket transport (`:5222`)
- [x] **6.2** OMEMO Double Ratchet session negotiation and bundle publishing (`omemo_publish_bundle`, `omemo_fetch_peer_bundle`)
- [x] **6.3** Split-pane Messages tab UI (`MessagesTab.tsx`) with real-time thread persistence and JID resolution
- [x] **6.4** SASL PLAIN authentication bound to Level 1 persona hex key

---

### Phase 7: Mobile QR Pairing Station

> ECDH-sealed root seed transfer to mobile satellites.

- [x] **7.1** `pair_begin` ephemeral X25519 keypair generation and `iyouhome://pair` deep link formatting
- [x] **7.2** `pair_seal_seed_for_device` HKDF-SHA256 domain separated AES-256-GCM encryption
- [x] **7.3** `pair_confirm`, `pair_list_devices`, and `pair_revoke_device` in `pairing.rs`
- [x] **7.4** `PairingModal.tsx` QR code rendering and paired device management UI

---

### Phase 8: Offline Media Vault (Blossom Browser)

> Content-addressed personal data store browser.

- [x] **8.1** Embedded `BlossomBrowser.tsx` in Services tab
- [x] **8.2** Local blob enumeration (`list_local_blobs`), deletion (`delete_local_blob`), and storage tallying
- [x] **8.3** Copyable SHA-256 BUD-01 media links and direct browser preview

---

### Phase 9: Enclave Access Security & Vault Preservation

> Gate device and vault access behind physical identity checks; make disaster recovery archives complete.

- [x] **9.1** First-Run Master Seed Confirmation: Interactive onboarding challenge (`FirstRunSeedGate.tsx`) requiring users to verify seed words or acknowledgment before dashboard access.
- [x] **9.2** OS Biometric / PIN App Lock: Local screen guard (`AppLockOverlay.tsx`) on launch and wake; configurable inactivity auto-lock (5m, 15m, 1h, Never).
- [x] **9.3** Dynamic `.iyoubackup` Ledger Bundling: Archives all files in `{app_data}/ledgers/` dynamically alongside vault, contacts, pairing, and preferences.
- [x] **9.4** Vault Re-Authentication Gate: Prompts for PIN or biometric verification on high-stakes actions.

---

### Phase 10: Mesh Publishing, Governance & Data Footprint

> Publish to the local mesh, verify integrity from the default Blossom-first lens, and surface the sovereign data footprint.

- [x] **10.1** Quick Dispatch Modal (`QuickDispatchModal.tsx`): Top-bar `[ ✍️ Dispatch ]` action supporting Kind 1 text notes, Kind 1063 Blossom uploads, and Kind 30023 civic polls (dual-broadcast to `:9003` and remote mesh).
- [x] **10.2** Blossom-First Governance Auditor: Blossom BUD-01 / local Merkle root verification as default, with IPFS toggle.
- [x] **10.3** Offline Sovereign Footprint (`SovereignFootprint.tsx`): Metric tile matrix displaying local counts across satellites with deep links.
- [x] **10.4** Private Enclave Sovereignty HUD (`SovereigntyStatusPanel.tsx`): 5-check capability matrix with one-click fix buttons and loopback diagnostic probes.

---

## Active Roadmap (Phases 11 & 12)

### Phase 11: Services Layout Reorganization & Dynamic TLS Maintenance
- [x] **11.1** Collapsible Sovereignty HUD: Compact 40px summary banner default (`🟢 Sovereign Node Healthy · 5/5 Checks Passed`), expanding to full diagnostic matrix on toggle.
- [x] **11.2** Sovereign Footprint Grid Elevation: Position the local data matrix prominently at the top of the Services tab directly beneath the HUD banner.
- [x] **11.3** Segmented Sub-Tabs in Services: 2-segment sub-view switcher below the footprint grid:
  - `[ ⚙️ Daemons & Protocols ]`: Status cards and toggle switches for `:9001`, `:9002`, `:9003`, `:5222` and Sync-to-Home controls.
  - `[ 🗄️ Offline Media Vault ]`: Blossom media browser thumbnail grid, details drawer, and delete routes.
- [x] **11.4** Dev-Mode TLS Certificate Auto-Staging: Ensure `certs.rs` automatically stages bundled cert/key assets to `~/Library/Application Support/com.byers-brands.iyou-home/certs/` with `0o600` permissions on boot in debug environments.
- [ ] **11.5** Over-The-Air (OTA) Certificate Refresher: Background task checking `production.crt` expiration on boot and weekly; if validity is `< 20 days`, securely fetch the updated cert bundle from `https://iyou.me/api/v1/enclave/cert-bundle/`, stage atomically, and reload TLS acceptors.

### Phase 12: Sovereign Auto-Updater & Cryptographic Release Vetting
- [x] **12.1** Tauri v2 Updater Integration: Add `tauri-plugin-updater` backed by Minisign public key verification against `updates.iyou.me/home/latest.json`.
- [x] **12.2** User-Configurable Update Policies: Store update preferences in `preferences.json`:
  - `Air-Gapped / Locked`: Never polls update servers.
  - `Manual Review (Notify Only)`: Polls only on explicit menu click or surfaces a subtle non-intrusive status badge.
  - `Automatic`: Background fetch with prompt to restart.
- [x] **12.3** Pre-Install Cryptographic Vetting Modal: High-transparency release dialog displaying version, git commit hash, binary SHA-256 hash, raw Minisign signature, and commit diff link (`[ View Source Diff ↗ ]`) before executing installation.
- [x] **12.4** One-Click Binary Rollback: Stage the prior binary to `{app_data}/bin/iyou-home.previous` during updates, providing a recovery rollback button in the Danger Zone.

---

## Standing Security Backlog

- [x] **SEC-002** — Runtime domain certificate loading (`production.crt` / `production.key`) from `{app_data}/certs/` with ephemeral self-signed in-memory fallback.
- [x] **SEC-003** — Submodule commit-hash alignment between `iyou_home` and `did_rust`.
- [x] **Tray Lifecycle** — Monochrome menu bar icon with macOS template mode and hide-on-close daemon persistence.

---

## Test & Build Verification

- **Rust Backend Suite (`cargo test`)**: **94 passed, 0 failed**
- **Frontend Test Suite (`vitest`)**: **85 passed across 11 test files**
- **TypeScript Typecheck (`tsc`)**: **Clean compilation, 0 errors**
