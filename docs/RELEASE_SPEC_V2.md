# Release Specification V2 — `iyou_home`

**Status:** DRAFT  
**Date:** 2026-08-26  (Revised: 2026-08-29 — Phases 9 & 10 Launch Readiness codified)  
**Supersedes:** UI Audit Report (2026-08-26), RELEASE_SPEC_V1 (if exists)  
**Codifies:** Day 1 public release baseline for `iyou_home` Tauri desktop application

---

## 1. Design Principles

1. **Enclave-first.** Every feature routes through the sovereign vault. No data leaves the device without explicit user action.
2. **Tiered trust.** Level 0 (Anchor) is permanently air-gapped from public surfaces. Level 1 (Public) is the default signing persona. Level 2+ (Burner) are disposable contextual identities.
3. **Progressive disclosure.** Developer utilities are hidden behind opt-in toggles. The default view shows only what an identity owner needs.
4. **Copy friction for secrets.** Any action that copies a Level 0 key (DID or Nostr hex) to the clipboard passes through a confirmation modal with explicit warnings and a recommended Level 1 alternative.

---

## 2. Global Frame & Shell Standards

### 2.1 Persistent Status Bar

A fixed top status bar is rendered above the tab navigation, visible on all tabs.

| Element | Source | Behavior |
|---|---|---|
| **App wordmark** | `iyou_home` | Left-aligned, links to default tab (Enclave) |
| **Daemon indicators** | `invoke("get_service_statuses")` | Three live dots: Bridge `:9001` (always green), Nostr `:9003`, Blossom `:9002`. Green = running, red = stopped, amber = starting. |
| **Active persona pill** | `invoke("get_active_did")` + `invoke("list_profiles")` | Right-aligned pill showing `🛡️ Anchor` or `👤 {profile_name} (L{level})`. Clicking opens the Enclave tab. |

Status is polled every 10 seconds via `setInterval` + `invoke("get_service_statuses")`. The active persona is refreshed on every `onRefresh()` callback from child components.

### 2.2 Container Layout

```css
.container {
  max-width: 1024px;  /* expanded from 800px */
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
```

The wider container accommodates the Enclave's 3-column stats bar and the Governance Auditor's side-by-side Merkle comparison without horizontal scrolling.

### 2.3 Tab Navigation Order

The tab bar renders in this exact order, with icons:

| Position | Route ID | Label | Icon | Visibility |
|---|---|---|---|---|
| 1 | `enclave` | Enclave | 🛡️ | Always |
| 2 | `assets` | Credentials | 📜 | Always |
| 3 | `vault` | Vault & Recovery | 🔑 | Always |
| 4 | `services` | Services | ⚙️ | Always |
| 5 | `governance` | Governance Auditor | 🗳️ | Always |
| 6 | `signer` | Manual Signer | 🧪 | Developer mode only |

The default active tab on launch is `enclave` (position 1).

### 2.4 Developer Mode Toggle

A small toggle switch in the application footer (or a keyboard shortcut, e.g. `Cmd+Shift+D`) controls visibility of the Manual Signer tab and any future debug controls. When disabled (default):

- Tab 6 (Manual Signer) is hidden from the tab bar.
- The `WsSignPopup` "Auto-sign (dev)" checkbox is hidden.
- `console.log` statements in `WsSignPopup.tsx` are suppressed in production builds via `#[cfg(debug_assertions)]` gating or a Vite `define` flag.

---

## 3. Tab Specifications

### Tab 1: Enclave (Project Zero) — `enclave`

**Primary Component:** `ProjectZero.tsx`  
**Sub-components:** `PersonaMatrix.tsx`, `ContactList.tsx`, `DisclosureModal.tsx`, `GraduationWizard.tsx`  
**User Persona:** Identity Owner — the primary workspace for managing personas and peer trust.

#### 3.1.1 Sub-Tab: Persona Matrix

Renders the three-tier identity hierarchy:

| Tier | Card Color | Controls | Security Model |
|---|---|---|---|
| **Level 0 — Anchor Sanctum** | Purple left-border | DID copy (shielded), Nostr hex copy (shielded), 👁️/🙈 toggle | Permanently masked. Copy routes through Anchor Shield modal with L1 recommendation. Air-gapped from public feeds. |
| **Level 1 — Primary Identity** | Blue left-border | DID copy (direct), Nostr hex copy (direct), Set Active, 🚨 Break-Glass | Public-facing default. Copy is frictionless. Break-Glass triggers emergency rotation with typed confirmation. |
| **Level 2+ — Contextual / Burners** | Green left-border | DID copy (direct), Set Active, Delete, Create new burner | Disposable pseudonyms. No copy friction. Create form accepts a human-readable name. |

**Break-Glass Rotation Modal:**
- Requires typed confirmation: `ROTATE PUBLIC IDENTITY`
- Warns: OIDC sessions severed, public feeds orphaned
- Assures: L0 Anchor and Inner Circle contacts remain intact
- Calls `invoke("rotate_primary_persona")` which tombstones the old L1 and derives a fresh one

#### 3.1.2 Sub-Tab: Contact Enclave

- **Peer list** with trust badge (Inner Circle / Trusted Alliance / Peer)
- **Level 0 peer keys** are masked by default with per-peer 👁️/🙈 toggle
- **Level 0 copy** routes through confirmation modal with handling warning and L1 routing note
- **Micro-copy banner** explains masking behavior when any L0 contacts exist
- **Selective Disclosure Cards** button opens the DisclosureModal
- **Add/Edit/Delete** contact forms with trust level selection

#### 3.1.3 Disclosure Modal

Dual-tab modal:

- **Generate tab:** Select signing profile, disclosure tier (Tier 0 Inner Circle / Tier 0.5 Trusted Alliance), target peer DID (with autocomplete from contacts), select persona aliases via checkboxes, add custom aliases. Produces a signed JSON card with Download and Copy actions.
- **Import tab:** Paste peer's JSON disclosure card payload. Cryptographically verifies signature, extracts peer identity and aliases, stores as a contact.

#### 3.1.4 Sovereign Graduation Wizard

6-step modal for migrating an IdP-managed identity into full sovereign custody:

1. Initiation (IdP URL input, irreversible warning)
2. Biometric Challenge (WebAuthn PRF)
3. Key Handshake (X25519 ECDH transit)
4. Local Decryption & Ingest (AES-256-GCM unseal into vault)
5. Confirmation & Shred (signed receipt submitted to IdP)
6. Sovereign Custody Claimed (completion grid)

Secrets live in React refs only — zero UI leakage. Completion grid confirms: Biometric PRF KEK, Sealed Transit, Local Vault Ingest, IdP Shred Confirmed.

---

### Tab 2: Credentials (Assets) — `assets`

**Primary Component:** `TrustAssets.tsx`  
**User Persona:** Identity Owner — browse and inspect stored Verifiable Credentials.

#### 3.2.1 Release Changes (from current state)

| Change | Rationale |
|---|---|
| **Add persona selector dropdown** | Current implementation auto-loads creds for active DID only. Users with multiple personas need to browse all. |
| **Add credential type search/filter** | With many VCs, scrolling is insufficient. |
| **Empty state improvement** | Add "How to get credentials" guidance pointing to Selective Disclosure import. |
| **Rename button** | "Inspect Cryptographic Evidence Document" → "View Raw Credential" (concise). |

#### 3.2.2 Existing Features (retained)

- Active Persona badge showing current profile name
- Fidelity tier badges (Tier 1: Social Peer Vouched / Tier 2: Institutional Registry / Tier 3: Secure Hardware Anchor)
- EXPIRED banner with red badge and grayscale filter
- Identity Mismatch critical alert when credential subject DID ≠ active profile DID
- Raw payload inspector modal (dark JSON display)

---

### Tab 3: Vault & Recovery (Keys) — `vault`

**Primary Component:** `KeysManager.tsx` (renamed from current)  
**User Persona:** Identity Owner — backup, recovery, and vault management.

#### 3.3.1 Release Changes (from current state)

| Change | Rationale |
|---|---|
| **Rename tab** from "Backup & Recovery" to "Vault & Recovery" | Matches the actual function — this is a vault, not a backup tool. |
| **Rename heading** from "Vault Backup & Identity Recovery" to "Identity Vault" | Clarity. |
| **Replace "Generate did:key" button** with "Create New Vault" | The current label implies generating a single key; it actually bootstraps the entire dual-identity hierarchy. New label + explanatory copy: "Derives a fresh root seed with Level 0 Anchor + Level 1 Public Persona. Only works when no vault exists." |
| **Remove multi-persona redirect banner** | The "Personas moved to Project Zero" banner is a migration artifact. After tab reorder, the Enclave is Tab 1 and users will find it naturally. |
| **Add Master Seed Reveal modal** | High-friction modal (typed confirmation `REVEAL MY SEED`, screen blur, 10-second countdown before reveal button activates) that displays the hex-encoded root seed. One-time display only — no copy button to discourage screenshots. |
| **Add `.vault` encrypted export/import** | Password-protected archive export (`.vault` file) using the existing ChaCha20-Poly1305 vault sealing. Import reads and unseals. This is the primary disaster recovery mechanism. |
| **Show persona context** alongside active DID | Display `{profile_name} (Level {level}, Index #{derivation_index})` above the raw DID string. |

#### 3.3.2 Retained Features

- Active DID display with copy and export buttons
- Export Public DID Document (`did.json` download)
- Seed import form (DID + Base58 private key) — moved behind "Advanced" disclosure

---

### Tab 4: Services (Daemons) — `services`

**Primary Component:** `ServiceSwitchPanel.tsx` (extracted from `App.tsx`)  
**User Persona:** Identity Owner / System Admin — control local daemon processes.

#### 3.4.1 Release Changes (from current state)

| Change | Rationale |
|---|---|
| **Extract to separate file** | Currently defined inline in `App.tsx`. Must be a standalone component. |
| **Remove "Coming Soon" entries** | "IPFS Cloud Archive" and "Polly" are dead entries. Remove from the service list entirely. |
| **Hide port numbers by default** | Move `:9001`, `:9002`, `:9003`, `:5222` behind an expandable "Technical Details" disclosure. End users do not need port info. |
| **Add service descriptions** | One-line description under each service name explaining what it does (e.g., "Signature Bridge: Routes external signing requests to your vault"). |

#### 3.4.2 Service Registry

| Service | Port | Default | Description |
|---|---|---|---|
| SigBridge | `:9001` | Always On | Routes external signing requests from iyou_idp and satellite apps to your local vault. Cannot be stopped. |
| Blossom | `:9002` | Autostart On | Content-addressed media blob storage (BUD-01). Stores encrypted media locally. |
| Nostr | `:9003` | Autostart On | Local Nostr relay for personal event storage (Kinds 1, 30023, 10002). |
| Chat | `:5222` | Autostart On | End-to-end encrypted mesh messaging daemon. |

#### 3.4.3 Controls per Service

- Status light (green/red/amber) — always visible
- Service name + description — always visible
- Autostart toggle — for non-Always-On services
- Start/Stop button — for non-Always-On services
- "Always On" badge — for SigBridge only

---

### Tab 5: Governance Auditor — `governance`

**Primary Component:** `GovernanceAuditor.tsx` (new, migrated from `IpfsArchiveViewer.tsx`)  
**User Persona:** Identity Owner / Governance Participant — verify poll integrity.

#### 3.5.1 Purpose

Replace the developer-oriented IPFS Cloud Archive Viewer with a governance-focused audit station. The core functionality (fetch snapshot, compute Merkle root, compare) is retained but wrapped in plain-language UI.

#### 3.5.2 Flow

1. **Source selector:** Choose between IPFS CID (manual entry) or Blossom BUD-01 vote snapshot (browse local Blossom directory or paste CID).
2. **Fetch snapshot:** Retrieves the JSON poll snapshot from the selected source.
3. **Display poll summary:** Title, vote count, asserted Merkle root — in a human-readable card layout, not raw JSON.
4. **Audit:** "Verify Locally" button computes the Merkle root from vote records and compares to the asserted root.
5. **Result:** Green "Verified" badge (match) or red "Tampered" alert with computed vs. asserted root comparison.

#### 3.5.3 Naming

- Tab label: "Governance Auditor" with 🗳️ icon
- Component heading: "Poll Integrity Auditor"
- Remove all references to "IPFS Cloud Archive" — the user should not need to know or care that the data comes from IPFS.

---

### Tab 6: Manual Signer (Dev) — `signer`

**Primary Component:** `SovereignSigner.tsx`  
**Visibility:** Developer mode only (hidden by default)  
**User Persona:** Developer — manual challenge signing for testing.

#### 3.6.1 Release Changes (from current state)

| Change | Rationale |
|---|---|
| **Gate behind Developer Mode toggle** | This is a developer utility, not an end-user feature. Only visible when developer mode is enabled. |
| **Rename heading** from "Sovereign Signer" to "Manual Challenge Signer" | Clarifies purpose — this is for manual testing, not the primary signing flow. |
| **Replace "Secure Enclave" copy** | "Signing in Secure Enclave..." → "Signing with Vault..." — there is no hardware enclave. |
| **Replace "IdP Challenge" label** | "IdP Challenge (JSON or String)" → "Authentication Challenge" — jargon removal. |
| **Remove success raw JSON display by default** | The raw VP JSON is developer output. Show a green "Signed Successfully" summary with a "View Raw VP" disclosure toggle. |

---

## 4. Data Persistence & Sovereign Backup Model

### 4.1 Data Categories

| Category | Storage | Format | Egress |
|---|---|---|---|
| **Text/Posts** | Local Nostr relay (`:9003`) | SQLite (Kinds 1, 30023) | Nostr protocol only, on user publish |
| **Media Blobs** | Local Blossom directory (`:9002`) | Content-addressed SHA-256 files | BUD-01 protocol only, on user share |
| **Private Enclave** | App data directory | Flat JSON ledgers (`vault.json`, `contacts.json`, `preferences.json`) | Never — isolated from network |
| **Credentials** | Embedded in `vault.json` | W3C VC JSON within profile credential arrays | Never — sealed under vault encryption |

### 4.2 Vault Encryption Model

```
vault.json (plaintext envelope)
  └── sealed_seed: ChaCha20-Poly1305(root_seed, aad=device_binding)
  └── profiles[]: derived keypairs per index
  └── credentials[]: W3C VCs per profile
```

- Root seed is sealed under a device-binding AAD (application-specific data) derived from the WebAuthn PRF key or a user-supplied password.
- Individual profile keypairs are deterministically derived from the root seed via `derive_deterministic_keypair(seed, index)`.
- The sealed vault is atomically saved: a backup of the previous file is kept during writes and restored on write failure.

### 4.3 Disaster Recovery: `.iyoubackup` Archive

A full vault export creates a `.iyoubackup` file containing:

1. **Encrypted vault** (`vault.json` sealed under user-supplied password via Argon2id → XChaCha20-Poly1305)
2. **Contacts ledger** (`contacts.json` encrypted with same key)
3. **Preferences** (`preferences.json` plaintext — non-sensitive UI state)
4. **Manifest** (JSON: export timestamp, app version, profile count, device binding hash)

Import reads the manifest, derives the key from the user-supplied password, decrypts vault and contacts, and merges/replaces the local state with user confirmation.

### 4.4 Master Seed Reveal

A one-time reveal flow gated behind:

1. User clicks "Reveal Master Seed" in Vault tab
2. Confirmation modal appears with `REVEAL MY SEED` typed confirmation
3. 10-second countdown before the reveal button activates
4. Seed is displayed once in a monospace block — no copy button (discourages screenshots)
5. Modal auto-dismisses after 30 seconds
6. Reveal is logged in preferences for audit trail (timestamp only, not the seed)

---

## 5. WsSignPopup Production Standards

The global WebSocket signing overlay (`WsSignPopup.tsx`) is the primary approval surface for external bridge requests. Production requirements:

| Requirement | Current State | Target State |
|---|---|---|
| Remove "Auto-sign (dev)" checkbox | Visible to all users | Hidden behind `DEBUG` env flag or removed |
| Suppress `console.log` in production | 10+ console.log statements | Gated behind `import.meta.env.DEV` or removed |
| Replace "Profile ID: {id}" display | Shows internal identifier | Show profile name + level only |
| Simplify event display | Raw JSON dump for all request types | Structured card layout with key fields extracted; raw JSON behind "Show Details" disclosure |

---

## 6. CSS & Design Token Migration

### 6.1 Current State

- Tabs 1–5 use CSS classes from `App.css` (flat grey `.section` cards, browser-default colors)
- Tab 6 (Enclave) uses inline `style={{}}` objects with a tiered indigo/blue/green/purple color system

### 6.2 Target State

Extract the Enclave's color system into shared CSS custom properties in `:root`:

```css
:root {
  /* Trust tier colors */
  --color-anchor: #7c3aed;
  --color-anchor-bg: rgba(124, 58, 237, 0.04);
  --color-primary: #2563eb;
  --color-primary-bg: rgba(37, 99, 235, 0.03);
  --color-burner: #059669;
  --color-burner-bg: rgba(5, 150, 105, 0.03);

  /* Status colors */
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-danger: #dc2626;

  /* Surface colors */
  --color-surface: #f9fafb;
  --color-surface-border: #e5e7eb;
  --color-text-primary: #111827;
  --color-text-secondary: #4b5563;
  --color-text-muted: #6b7280;
}
```

Tabs 1–5 are migrated to use these tokens via CSS classes, eliminating the visual gap between the polished Enclave and the prototype-quality legacy tabs.

---

## 7. Testing & Verification Checklist

Before Day 1 release, all of the following must pass:

| # | Category | Check |
|---|---|---|
| 1 | Build | `cargo test` — all Rust unit tests pass |
| 2 | Build | `npx tsc --noEmit` — TypeScript typecheck clean |
| 3 | Build | `npm run build` — Vite production build succeeds |
| 4 | Build | `npx vitest run` — all frontend tests pass |
| 5 | UX | Status bar renders on all 6 tabs with live daemon indicators |
| 6 | UX | Tab reorder matches spec (Enclave first, Signer last/hidden) |
| 7 | UX | Developer Mode toggle hides/shows Tab 6 and debug controls |
| 8 | UX | Anchor Shield modal fires on all L0 DID/hex copy actions |
| 9 | UX | Break-Glass modal requires typed confirmation and completes rotation |
| 10 | UX | L0 peer key masking works in Contact Enclave |
| 11 | UX | L0 peer copy routes through confirmation modal |
| 12 | Security | "Auto-sign (dev)" is not visible in production builds |
| 13 | Security | `console.log` statements are not emitted in production builds |
| 14 | Security | Master Seed Reveal requires typed confirmation + countdown |
| 15 | Persistence | Vault round-trip: create → export `.iyoubackup` → import on fresh data → verify profiles match |
| 16 | Governance | Merkle root audit: fetch snapshot → compute → compare → verify match/mismatch display |
| 17 | Security | First-Run Master Seed Confirmation gates Enclave access until seed words verified |
| 18 | Security | OS biometric / PIN app lock engages on launch, wake, and configured inactivity auto-lock |
| 19 | Persistence | `.iyoubackup` export bundles all `{app_data}/ledgers/` files plus core JSON ledgers |
| 20 | Security | Vault re-authentication gate fires on seed reveal, `.iyoubackup` export, and Danger Zone purge |
| 21 | Mesh | Quick Dispatch publishes Kinds 1 / 1063 / 30023 to local `:9003` and remote relays |
| 22 | Governance | Governance Auditor defaults to Blossom BUD-01 verification (IPFS demoted to advanced) |
| 23 | UX | Offline Sovereign Footprint tile matrix reflects live local satellite counts with deep links |

---

## 8. Launch Readiness: Phases 9 & 10

The final release milestones harden device access, mesh publishing, and offline data residency. Phases proceed in order — access gating (Phase 9) must land before the publishing surfaces of Phase 10.

### 8.1 Phase 9: Enclave Access Security & Vault Preservation

> Gate device and vault access behind physical identity checks; make disaster recovery archives complete.

#### 9.1 First-Run Master Seed Confirmation

On first launch, the dashboard remains locked until the user demonstrates custody of the root seed:

1. Onboarding challenge displays 3 randomly selected seed words from the freshly minted vault.
2. User must type the words back — or verify a typed acknowledgment — before the Enclave dashboard becomes accessible.
3. A failed challenge resets with a fresh random selection; the full seed is never revealed during this step.
4. Success writes `first_run_seed_confirmed` (timestamp only) to `preferences.json` for audit.

#### 9.2 OS Biometric / PIN App Lock

Local screen guard protecting the app on launch and on wake:

- Uses the OS biometric prompt (macOS Touch ID / Windows Hello) or a user-configured device PIN as fallback.
- Configurable inactivity auto-lock: **15 min (default)**, 5 min, 1 hour, or Never.
- The lock screen re-engages on launch and on wake from sleep.
- The lock gate controls UI rendering only — it never asserts vault decryption.

#### 9.3 Dynamic `.iyoubackup` Ledger Bundling

`export_vault_backup` enumerates `{app_data}/ledgers/` at export time and bundles every file found there alongside `vault.json`, `contacts.json`, `pairing.json`, and `preferences.json`:

| Item | Handling |
|---|---|
| `vault.json`, `contacts.json`, `pairing.json`, `preferences.json` | Sealed exactly as today |
| `{app_data}/ledgers/*` | New `ledgers/` directory inside the archive, every file included dynamically |
| Manifest | Gains `ledger_entries` array (relative path + SHA-256 per file) |
| Import | Bundled ledgers restored only on user-confirmed full replace |

#### 9.4 Vault Re-Authentication Gate

High-stakes actions force a fresh biometric / PIN check regardless of any active session grace period:

- Master Seed reveal
- `.iyoubackup` export
- Danger Zone purge / vault re-initialization

The gate reuses the 9.2 local biometric / PIN prompt and writes a timestamped audit entry on success.

### 8.2 Phase 10: Mesh Publishing, Governance & Data Footprint

> Publish to the local mesh, verify integrity from the default Blossom-first lens, and surface the sovereign data footprint.

#### 10.1 Quick Dispatch Modal

Top-bar **[ ✍️ Dispatch ]** action supporting three publish surfaces:

| Kind | Type | Composer |
|---|---|---|
| 1 | Text note | Plain text compose |
| 1063 | Blossom media | File upload to local Blossom, live-tracked, then referenced in the event |
| 30023 | Civic poll definition | Structured poll composer |

Every dispatch double-broadcasts to the local relay (`:9003`) and configured remote relays.

#### 10.2 Blossom-First Governance Auditor

- Blossom BUD-01 snapshot ingest + local Merkle-root verification becomes the default view.
- IPFS CID entry is demoted behind an "Advanced" disclosure toggle.

#### 10.3 Offline Sovereign Footprint

Metric tile matrix reporting live local counts with deep links into each satellite view:

- `nostr.db` event count (local relay, Kinds 1 / 1063 / 30023 / 10002)
- Blossom media blob count
- Poll records (Kind 30023 definitions + vote snapshots)
- Ledger documents in `{app_data}/ledgers/`

---

## Appendix A: File Inventory (Post-Release)

| File | Status | Notes |
|---|---|---|
| `src/App.tsx` | Modified | Global shell, status bar, tab reorder, dev mode toggle |
| `src/App.css` | Modified | Design tokens, expanded container, migrated styles |
| `src/components/ServiceSwitchPanel.tsx` | **New** | Extracted from `App.tsx` |
| `src/components/GovernanceAuditor.tsx` | **New** | Migrated from `IpfsArchiveViewer.tsx` |
| `src/components/KeysManager.tsx` | Modified | Renamed sections, seed reveal modal, `.vault` export/import |
| `src/components/TrustAssets.tsx` | Modified | Persona selector, search/filter, empty state improvement |
| `src/components/SovereignSigner.tsx` | Modified | Renamed, copy fixes, gated behind dev mode |
| `src/components/WsSignPopup.tsx` | Modified | Dev controls hidden, console.log gated |
| `src/components/enclave/ProjectZero.tsx` | Modified | Status bar integration, post-graduation badge |
| `src/components/enclave/PersonaMatrix.tsx` | Modified | De-duplicate profile filtering |
| `src/components/enclave/ContactList.tsx` | No change | Already release-ready |
| `src/components/enclave/DisclosureModal.tsx` | No change | Already release-ready |
| `src/components/enclave/GraduationWizard.tsx` | No change | Already release-ready |
| `src/components/IpfsArchiveViewer.tsx` | **Deprecated** | Replaced by `GovernanceAuditor.tsx` |
| `docs/RELEASE_SPEC_V2.md` | **New** | This document |
