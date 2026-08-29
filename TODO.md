# TODO — iyou_home (Tauri/Rust Local Enclave)

**Codified from:** `docs/RELEASE_SPEC_V2.md`  
**Last updated:** 2026-08-29

---

## Day 1 Release Roadmap

Execution phases ordered by dependency. Each phase produces a shippable increment.

---

### Phase 1: Shell Harmonization & Tab Reordering

> Unify the global frame, reorder tabs by user importance, and gate developer controls.

- [x] **1.1** Add persistent top status bar with live daemon indicators (Bridge, Nostr, Blossom) and active persona pill — visible on all tabs
- [x] **1.2** Expand container width from `800px` to `1024px` (`max-w-5xl`)
- [x] **1.3** Reorder tabs: Enclave → Credentials → Vault → Services → Governance → Signer
- [x] **1.4** Set default active tab to `enclave` on launch
- [x] **1.5** Extract `ServiceSwitchPanel` from `App.tsx` into `src/components/ServiceSwitchPanel.tsx`
- [x] **1.6** Remove "Coming Soon" entries (IPFS Cloud Archive, Polly) from service list
- [x] **1.7** Hide port numbers behind "Technical Details" disclosure in Services tab
- [x] **1.8** Add service descriptions under each daemon name
- [x] **1.9** Add Developer Mode toggle (footer or `Cmd+Shift+D`) — gates Tab 6 visibility and debug controls
- [x] **1.10** Hide "Auto-sign (dev)" checkbox in `WsSignPopup.tsx` behind dev mode
- [x] **1.11** Gate `console.log` statements in `WsSignPopup.tsx` behind `import.meta.env.DEV`
- [x] **1.12** Add icons to all tab labels for visual consistency
- [x] **1.13** Migrate Enclave design tokens (tier colors, status colors, surface colors) into CSS custom properties in `:root`
- [x] **1.14** Migrate Tabs 1–5 to use shared CSS design tokens

**Verification:** `npx tsc --noEmit` clean, `npm run build` succeeds, `npx vitest run` 22/22 pass. Status bar renders on all tabs. Tab order matches spec. Dev mode toggle hides/shows Tab 6.

---

### Phase 2: Vault Disaster Recovery Engine

> Build encrypted backup/restore and master seed reveal for identity continuity.

- [x] **2.1** Rename tab from "Backup & Recovery" to "Vault & Recovery"; update heading to "Identity Vault"
- [x] **2.2** Replace "Generate did:key" button with "Create New Vault" + explanatory copy
- [x] **2.3** Remove multi-persona redirect banner from `KeysManager.tsx`
- [x] **2.4** Show persona context (name, level, index) alongside active DID display
- [x] **2.5** Implement Master Seed Reveal modal: typed confirmation (`REVEAL MY SEED`), 10-second countdown, one-time display, auto-dismiss after 30s
- [x] **2.6** Implement `.iyoubackup` encrypted archive export: password-protected (HKDF-SHA256 + AES-256-GCM) packaging of `vault.json` + `contacts.json` + `preferences.json` + manifest
- [x] **2.7** Implement `.iyoubackup` import: password-derived decryption, manifest validation, user-confirmed merge/replace
- [x] **2.8** Move seed import form (DID + Base58 key) behind "Advanced" disclosure toggle
- [x] **2.9** Add unit tests for `.iyoubackup` round-trip: create → export → fresh import → verify profiles match

**Verification:** `cargo test` 60/60 pass. Seed reveal modal requires typed confirmation. Export produces valid `.iyoubackup`; import on fresh vault restores all profiles and contacts.

---

### Phase 3: Governance & Merkle Consensus Station

> Replace the developer IPFS viewer with a user-facing poll integrity auditor.

- [x] **3.1** Create `src/components/GovernanceAuditor.tsx` with plain-language UI
- [x] **3.2** Implement source selector: IPFS CID (manual) or Blossom BUD-01 vote snapshot (browse/paste)
- [x] **3.3** Implement snapshot fetch and poll summary display (title, vote count, asserted Merkle root)
- [x] **3.4** Implement local Merkle root computation via `invoke("calculate_vote_merkle_root")`
- [x] **3.5** Implement audit result display: green "Verified" badge (match) or red "Tampered" alert with root comparison
- [x] **3.6** Rename tab from "IPFS Cloud Archive" to "Governance Auditor" with ballot icon
- [x] **3.7** Deprecate `IpfsArchiveViewer.tsx` (remove import from `App.tsx`, retain file for reference)
- [x] **3.8** Add persona selector to `TrustAssets.tsx` for browsing credentials across all personas
- [x] **3.9** Add credential type search/filter to `TrustAssets.tsx`
- [x] **3.10** Improve TrustAssets empty state with "How to get credentials" guidance

**Verification:** Governance tab renders with CID input and snapshot display. Merkle audit produces match/mismatch result. TrustAssets shows persona dropdown and filters credentials by type.

---

### Phase 4: Sync-to-Home Local Mirroring Pipeline

> Enable offline-first data residency by mirroring remote events into local daemons.

- [x] **4.1** Implement Bridge batch event ingestion: fetch remote Nostr events (Kinds 1, 1063, 1111, 30023) from upstream relay and write to local SQLite (`:9003`)
- [x] **4.2** Implement Bridge media blob mirroring: fetch content-addressed blobs from upstream Blossom and store locally (`:9002`)
- [x] **4.3** Add sync status indicator to Services tab and Global Status Bar: "Last synced: {timestamp}"
- [x] **4.4** Implement incremental sync: track high-water mark timestamp, ingest missing events/blobs
- [x] **4.5** Add error handling for upstream unreachable: graceful degradation with local cache fallback

**Verification:** After sync, local Nostr relay contains remote events. Local Blossom contains mirrored blobs. Sync status visible in Services tab and Global Status Bar.

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

**Verification:** `cargo test` 66/66 pass, `npx vitest run` 30/30 pass. Revocation dispatches signed envelope. W3C VCs import cleanly with validation.

---

### Phase 9: Enclave Access Security & Vault Preservation

> Gate device and vault access behind physical identity checks; make disaster recovery archives complete.

- [ ] **9.1** First-Run Master Seed Confirmation: Interactive onboarding challenge requiring users to type back 3 random seed words or verify typed acknowledgment before gaining dashboard access.
- [ ] **9.2** OS Biometric / PIN App Lock: Local screen guard on launch and wake; configurable inactivity auto-lock (default: 15 min; 5m, 15m, 1h, Never).
- [ ] **9.3** Dynamic `.iyoubackup` Ledger Bundling: Ensure `export_vault_backup` archives all files in `{app_data}/ledgers/` dynamically alongside `vault.json`, `contacts.json`, `pairing.json`, and `preferences.json`.
- [ ] **9.4** Vault Re-Authentication Gate: Force biometric / PIN check on high-stakes actions (revealing seed, exporting vault, Danger Zone purge) regardless of active session grace period.

**Verification:** Fresh install blocks Enclave until seed confirmation passes. App lock engages on launch/wake and at configured inactivity timeout. `.iyoubackup` export contains every `ledgers/` file; import on a fresh vault restores all profiles, contacts, and ledgers. Seed reveal / export / purge each require a fresh biometric or PIN check.

---

### Phase 10: Mesh Publishing, Governance & Data Footprint

> Publish to the local mesh, verify integrity from the default Blossom-first lens, and surface the sovereign data footprint.

- [ ] **10.1** Quick Dispatch Modal: Top-bar `[ ✍️ Dispatch ]` action supporting Kind 1 text notes, Kind 1063 Blossom uploads, and Kind 30023 civic poll definitions (double-broadcast to `:9003` and remote relays).
- [ ] **10.2** Blossom-First Governance Auditor: Make Blossom BUD-01 / local Merkle root verification the default view, demoting IPFS to an advanced toggle.
- [ ] **10.3** Offline Sovereign Footprint: Metric tile matrix displaying local counts across satellites (`nostr.db` events, Blossom media, poll records, ledger documents) with deep links.

**Verification:** Dispatch modal publishes Kinds 1 / 1063 / 30023 to `:9003` and remote relays, with 1063 uploads landed in local Blossom. Governance Auditor defaults to BUD-01 verification with IPFS behind an advanced toggle. Footprint matrix reflects live local counts and deep-links into each satellite view.

---

## Standing Security Backlog

Carried forward from previous TODO. Not phased — to be addressed as capacity allows.

- [x] **SEC-002** — Runtime domain certificate loading (`production.crt` / `production.key`) from `{app_data}/certs/` with ephemeral self-signed in-memory fallback.
- [ ] **SEC-003** — Enforce `did_rust` submodule commit-hash alignment between `iyou_home` and `iyou_idp` via CI.
- [ ] **SEC-006** — Evaluate certificate pinning or mTLS for `wss://home.iyou.me:9001`.
- [x] **Ecosystem Doc Organization** — Standardize repo layout: root `AGENT.md`, `README.md`, `HOME_DEVELOPER_GUIDE.md`; `docs/`: `HOME_DEVELOPER_GUIDE.md`, `RELEASE_SPEC_V2.md`.
