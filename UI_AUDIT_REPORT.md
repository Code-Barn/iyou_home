# UI/UX Comprehensive Audit Report — `iyou_home`

**Date:** 2026-08-26  
**Scope:** All 6 navigation tabs, global shell, modals, popups  
**Method:** 100% read-only inspection of component trees, state hooks, and JSX markup

---

## 1. Executive UX Summary

**Overall Verdict: Pre-release polish required across 4 of 6 tabs; 2 tabs are release-ready.**

The application has two distinct UI quality tiers. **Tab 6 (Project Zero / Enclave)** is the standout — polished, well-structured, with consistent security UX patterns (masked keys, copy friction, break-glass). **Tab 4 (Assets)** is functional and clean. The remaining four tabs carry significant developer-facing artifacts, inconsistent visual language, and misaligned naming that would confuse non-technical users.

**Critical issues:**
- No global header, daemon status bar, or app branding beyond a bare `<h1>iyou_home</h1>` — the app has no persistent identity frame.
- Tab 1 (Services) and Tab 5 (Archive) are developer utilities masquerading as user-facing features.
- Tab 2 (Backup & Recovery) title does not match its content — it is an identity vault, not a backup tool.
- Tab 3 (Signer) is a manual challenge-testing tool with no clear end-user workflow.
- The `WsSignPopup` "Auto-sign (dev)" checkbox is a debug control shipped to production.

---

## 2. 6-Tab Inventory Matrix

| Tab | Route ID | Primary Component | Intended User Persona | Readiness Verdict |
|---|---|---|---|---|
| Services | `services` | `ServiceSwitchPanel` (inline in App.tsx) | Developer / System Admin | **Rethink** |
| Backup & Recovery | `keys` | `KeysManager.tsx` | Identity Owner (Recovery) | **Polish** |
| Signer | `signer` | `SovereignSigner.tsx` | Developer / Power User | **Rethink** |
| Assets | `assets` | `TrustAssets.tsx` | Identity Owner (Credentials) | **Ready** (minor polish) |
| Project Zero | `enclave` | `ProjectZero.tsx` → `PersonaMatrix` / `ContactList` | Identity Owner (Core) | **Ready** |
| IPFS Cloud Archive | `archive` | `IpfsArchiveViewer.tsx` | Developer / Governance Auditor | **Rethink** |

---

## 3. Itemized Tab Breakdowns

### Tab 1: Services (`services`)

**Component:** `ServiceSwitchPanel` — defined inline inside `App.tsx:55-166`, not a separate file.

**What it does:** Lists 6 daemon entries (SigBridge, Blossom, Nostr, Chat, IPFS Cloud Archive, Polly), shows status lights, autostart toggles, and start/stop buttons.

**Issues:**

| # | Severity | Finding | Location |
|---|---|---|---|
| 1.1 | **High** | No global daemon status bar — the status of running services is only visible when this tab is active. Users have no persistent indication of whether core services (SigBridge, Nostr) are online. | `App.tsx` — no status bar exists |
| 1.2 | **High** | `ServiceSwitchPanel` is defined inline inside `App.tsx` rather than as a separate component file. This is a code organization smell and prevents reuse. | `App.tsx:55-166` |
| 1.3 | **Medium** | "IPFS Cloud Archive" and "Polly" show "Coming Soon" badges — dead entries that add clutter with no value. | `App.tsx:46-47` |
| 1.4 | **Medium** | Port numbers (`:9001`, `:9002`, etc.) are developer-centric details. End users do not need to know that SigBridge runs on port 9001. | `App.tsx:132` |
| 1.5 | **Low** | `SigBridge` is hardcoded as `alwaysOn: true` with no explanation of why it cannot be stopped. The "Always On" badge provides no context. | `App.tsx:38, 151-153` |
| 1.6 | **Low** | The CSS comment `/* Service Switch Panel (Legacy) */` at `App.css:181` signals this tab may be slated for replacement but is still live. | `App.css:181` |

**Recommendation:** Extract `ServiceSwitchPanel` to its own file. Add a persistent status bar in the global header showing at minimum SigBridge/Nostr/Blossom status. Remove "Coming Soon" entries or move them to a separate "Roadmap" section. Hide port numbers behind an expandable "Technical Details" disclosure.

---

### Tab 2: Backup & Recovery (`keys`)

**Component:** `KeysManager.tsx` (209 lines)

**What it does:** Displays the active DID, provides copy/export, vault bootstrap ("Generate did:key"), and seed import/recovery.

**Issues:**

| # | Severity | Finding | Location |
|---|---|---|---|
| 2.1 | **High** | Title says "Vault Backup & Identity Recovery" but the primary action is "Generate did:key" which bootstraps a new vault. "Backup" implies exporting existing data; this tab generates new identity material. The name is misleading. | `KeysManager.tsx:114, 152-161` |
| 2.2 | **High** | The "Generate did:key" button label is misleading — it actually derives a full dual-identity hierarchy (Level 0 Anchor + Level 1 Public Persona), not just a `did:key`. | `KeysManager.tsx:159` |
| 2.3 | **Medium** | The "Multi-Persona Management" redirect banner (`KeysManager.tsx:190-206`) is a permanent fixture that says "this feature moved to Project Zero." This is a migration artifact that should be removed once users are trained. | `KeysManager.tsx:190-206` |
| 2.4 | **Medium** | Import form requires raw `DID` + `Private Key (Base58)` — this is a developer/power-user flow. No guidance on where a user would obtain these values. | `KeysManager.tsx:164-188` |
| 2.5 | **Medium** | The "Active Identity" section shows the raw DID string with no persona context (which level? which profile name?). The user cannot tell which identity tier they are looking at. | `KeysManager.tsx:126-148` |
| 2.6 | **Low** | "Export Public DID Document" button downloads `did.json` — reasonable, but there is no indication of what this file is for or where to use it. | `KeysManager.tsx:141-143` |
| 2.7 | **Low** | "Vault Mode Active" badge (`KeysManager.tsx:116-120`) provides no actionable information — it just confirms a technical state. | `KeysManager.tsx:116-120` |

**Recommendation:** Rename to "Identity Vault" or "Recovery & Import." Replace "Generate did:key" with "Create New Vault" with explanatory copy. Remove the migration banner. Show persona context (level, name) alongside the active DID. Consider whether the import flow should be behind an "Advanced" disclosure.

---

### Tab 3: Signer (`signer`)

**Component:** `SovereignSigner.tsx` (210 lines)

**What it does:** Manual challenge signing — paste a challenge, select a profile, sign, get a Verifiable Presentation JSON output.

**Issues:**

| # | Severity | Finding | Location |
|---|---|---|---|
| 3.1 | **High** | This tab is a developer utility for manually testing challenge signing. There is no clear end-user workflow that requires pasting raw JSON challenges. Regular users sign challenges via the `WsSignPopup` overlay, not this tab. | Entire component |
| 3.2 | **High** | "Signing in Secure Enclave..." button text is misleading — there is no hardware secure enclave involved; the signing happens in the Rust process in software. | `SovereignSigner.tsx:197` |
| 3.3 | **Medium** | The "Signer Identity" display shows the raw DID with "No active identity (Check Keys tab)" as fallback — this cross-tab reference is confusing. | `SovereignSigner.tsx:137-139` |
| 3.4 | **Medium** | "IdP Challenge (JSON or String)" label uses internal jargon — "IdP" is not defined for end users. | `SovereignSigner.tsx:174` |
| 3.5 | **Low** | The "📋 Paste" button reads from clipboard but the error handling exposes permission-denied OS-level messages. | `SovereignSigner.tsx:86-97` |

**Recommendation:** Either hide this tab behind an "Advanced / Developer" toggle, or rebrand it as "Manual Sign" with clear copy explaining when/why a user would need it. Replace "Secure Enclave" with "Vault." Replace "IdP Challenge" with "Authentication Challenge."

---

### Tab 4: Assets (`assets`)

**Component:** `TrustAssets.tsx` (249 lines)

**What it does:** Displays Verifiable Credentials stored for the active persona, with fidelity tier badges, expiration warnings, identity mismatch alerts, and a raw payload inspector modal.

**Issues:**

| # | Severity | Finding | Location |
|---|---|---|---|
| 4.1 | **Medium** | No persona/profile selector — credentials are auto-loaded for whichever profile matches `activeDid`. If the user has multiple personas, there is no way to browse credentials for other personas. | `TrustAssets.tsx:93-104` |
| 4.2 | **Medium** | No filtering, sorting, or search for credentials. With many VCs this becomes unwieldy. | Entire component |
| 4.3 | **Low** | "Inspect Cryptographic Evidence Document" button text is verbose. | `TrustAssets.tsx:218-219` |
| 4.4 | **Low** | The empty state message "No credentials stored for this persona" is accurate but bland — could suggest how to obtain credentials. | `TrustAssets.tsx:154-156` |

**Recommendation:** Add a persona selector dropdown (like the one in `SovereignSigner`). Add search/filter for credential type. Add a "How to get credentials" helper link in the empty state. Minor polish only — this tab is functionally sound.

---

### Tab 5: IPFS Cloud Archive (`archive`)

**Component:** `IpfsArchiveViewer.tsx` (213 lines)

**What it does:** Fetches a governance snapshot JSON from an IPFS gateway by CID, displays poll data, and locally recomputes the Merkle root for audit verification.

**Issues:**

| # | Severity | Finding | Location |
|---|---|---|---|
| 5.1 | **High** | This is a developer/governance-auditor tool, not an end-user feature. The concepts (CID, Merkle root, gateway selection, cryptographic audit) are entirely technical. | Entire component |
| 5.2 | **High** | The vault badge says "Stateless Gateway Audit" — meaningless jargon to non-developers. | `IpfsArchiveViewer.tsx:105` |
| 5.3 | **Medium** | The tab label in the nav is "IPFS Cloud Archive" but the component title is "IPFS Cloud Archive Viewer" — minor inconsistency. | `App.tsx:214` vs `IpfsArchiveViewer.tsx:104` |
| 5.4 | **Medium** | Gateway URLs are hardcoded (`ipfs.io`, `dweb.link`, `cloudflare-ipfs.com`). No explanation of why a user would choose one over another. | `IpfsArchiveViewer.tsx:34-38` |
| 5.5 | **Low** | "Audit Ledger Locally" button text implies the data is a "ledger" — it is actually a poll snapshot. | `IpfsArchiveViewer.tsx:172` |

**Recommendation:** Move behind an "Advanced / Developer" toggle or merge into a governance dashboard. If kept as a user-facing tab, replace technical copy with plain-language explanations. At minimum, rebrand the badge and audit button.

---

### Tab 6: Project Zero / Enclave (`enclave`)

**Component tree:** `ProjectZero.tsx` → `PersonaMatrix.tsx` + `ContactList.tsx` + `DisclosureModal.tsx` + `GraduationWizard.tsx`

**What it does:** The core identity management hub — persona hierarchy (L0/L1/L2+), peer contacts, selective disclosure, sovereign graduation.

**Issues:**

| # | Severity | Finding | Location |
|---|---|---|---|
| 6.1 | **Medium** | The banner subtitle "Multi-Tier Persona Matrix & Cryptographic Peer Trust Enclave" is developer-heavy jargon. | `ProjectZero.tsx:129` |
| 6.2 | **Medium** | `anchorCount` / `personaCount` / `burnerCount` computation in `ProjectZero.tsx:59-69` duplicates the same filtering logic in `PersonaMatrix.tsx:128-146`. This is a DRY violation that could cause drift. | `ProjectZero.tsx:59-69` vs `PersonaMatrix.tsx:128-146` |
| 6.3 | **Medium** | Level 1 DID is displayed in full plaintext (`PersonaMatrix.tsx:554`) while Level 0 is masked. Level 1 is the "public" persona so this is intentional, but there is no explanation to the user of why L0 is masked and L1 is not. | `PersonaMatrix.tsx:554` |
| 6.4 | **Low** | "Derivation Index: #" badge uses a `#` prefix (`PersonaMatrix.tsx:291`) that is inconsistent with "Index #N" used elsewhere (`PersonaMatrix.tsx:483, 761`). | `PersonaMatrix.tsx:291` vs `:483` |
| 6.5 | **Low** | The "Claim Sovereign Custody" button is always visible in the banner even after graduation. Post-graduation, this button should be hidden or replaced with a "Sovereign" status badge. | `ProjectZero.tsx:141-158` |

**This tab is the strongest in the application.** The Anchor Shield modal, Break-Glass rotation, peer key masking, and copy friction patterns are well-implemented and consistent. The sub-tab navigation (Persona Matrix / Contact Enclave) is clean.

---

## 4. Cross-Cutting Issues

### 4.1 Global Shell & Navigation

| # | Severity | Finding |
|---|---|---|
| G.1 | **High** | No persistent header or status bar. The only global element is `<h1>iyou_home</h1>` — no logo, no daemon status, no active persona indicator. Users have no persistent orientation. |
| G.2 | **High** | Tab ordering is inconsistent with importance: the most-used tab (Enclave) is 5th; developer tabs (Services, Archive) occupy positions 1 and 6. |
| G.3 | **Medium** | Tab label "Project Zero 🛡️" uses an emoji while others do not — visual inconsistency. |
| G.4 | **Medium** | No tab has an icon except "Project Zero." Adding icons to all tabs would improve scannability. |
| G.5 | **Medium** | The `max-width: 800px` container (`App.css:19`) constrains all content to a narrow column. The Enclave tab (which has 3-column stats and complex modals) would benefit from a wider layout. |

### 4.2 Visual Language Inconsistencies

| Pattern | Tabs 1-5 | Tab 6 (Enclave) |
|---|---|---|
| Styling approach | CSS classes from `App.css` | Inline `style={{}}` objects |
| Color system | Browser defaults + `.vault-badge` green | Indigo/blue/green/purple tiered palette |
| Modal design | `.modal-overlay` / `.modal-content` from CSS | Custom dark-themed modals with blur |
| Card design | `.section` class (flat grey) | Colored left-border cards with tier semantics |

**Impact:** Tab 6 looks like a different application from Tabs 1-5. The Enclave has a premium, intentional design language; the other tabs look like a Bootstrap prototype.

### 4.3 `WsSignPopup` (Global Overlay)

| # | Severity | Finding | Location |
|---|---|---|---|
| W.1 | **High** | "Auto-sign (dev)" checkbox is a debug control visible to all users. It bypasses the approval flow entirely. | `WsSignPopup.tsx:410-416` |
| W.2 | **Medium** | The popup displays raw JSON for Nostr events and credentials — overwhelming for non-technical users. | `WsSignPopup.tsx:284-347` |
| W.3 | **Medium** | "Profile ID: {id}" is shown in the persona context display — internal identifiers exposed to users. | `WsSignPopup.tsx:255` |
| W.4 | **Low** | Extensive `console.log` statements throughout (`WsSignPopup.tsx:67, 97, 138, 148, 156, 164, 172, 180`) — should be removed or gated behind a debug flag before release. | Multiple locations |

### 4.4 Modals Inventory

| Modal | Component | Purpose | Quality |
|---|---|---|---|
| Anchor Shield Copy | `PersonaMatrix.tsx:898-1022` | Intercept L0 copy with tier recommendation | Excellent — dark theme, clear hierarchy |
| Break-Glass Rotation | `PersonaMatrix.tsx:1074-1227` | Emergency L1 key rotation with typed confirmation | Excellent — high friction, clear consequences |
| Delete Persona | `PersonaMatrix.tsx:1024-1072` | Confirm persona deletion | Good — standard pattern |
| Level 0 Peer Copy | `ContactList.tsx:853-967` | Confirm L0 peer key copy | Good — consistent with Anchor Shield |
| Delete Contact | `ContactList.tsx:752-803` | Confirm contact deletion | Good — standard pattern |
| View Attestation | `ContactList.tsx:805-851` | Display raw attestation JSON | Adequate |
| Upsert Contact | `ContactList.tsx:640-750` | Add/edit peer contact form | Adequate |
| Selective Disclosure | `DisclosureModal.tsx` | Generate/import disclosure cards | Good — well-structured dual-tab |
| Sovereign Graduation | `GraduationWizard.tsx` | IdP-to-sovereign key migration | Excellent — step-by-step, clear irreversible warning |
| Ws Sign Popup | `WsSignPopup.tsx` | Approve/deny bridge signing requests | Adequate (debug artifacts) |

---

## 5. Streamlining Recommendations

### Pre-Release Critical (Must-Fix)

1. **Add a persistent global status bar** showing daemon health (at minimum: SigBridge, Nostr, Blossom) and the active persona name/level. This provides orientation across all tabs.

2. **Hide "Auto-sign (dev)" in WsSignPopup** behind a `DEBUG` env flag or remove entirely. This is a security risk in production.

3. **Reorder tabs by user importance:**
   - 1. Project Zero (Enclave) — primary hub
   - 2. Assets — credential browsing
   - 3. Backup & Recovery — vault/identity management
   - 4. Signer — manual signing (or hide)
   - 5. Services — daemon controls (or collapse into settings)
   - 6. IPFS Cloud Archive — (or hide behind Advanced)

4. **Unify the design language** — migrate Tabs 1-5 to use the Enclave's inline-style tiered color system and card patterns, or extract the Enclave's design tokens into shared CSS variables.

### Pre-Release Important (Should-Fix)

5. **Rename Tab 2** from "Backup & Recovery" to "Identity Vault" or similar. Update the `h2` and section headings to match.

6. **Extract `ServiceSwitchPanel`** from `App.tsx` into its own component file. Remove "Coming Soon" entries or move to a non-tab location.

7. **Remove or hide the multi-persona redirect banner** in `KeysManager.tsx:190-206` once the Enclave tab is established.

8. **Add a persona selector to TrustAssets** so users can browse credentials across all personas.

9. **Gate developer tabs** (Services, Signer, IPFS Archive) behind an "Advanced" or "Developer" mode toggle in the tab bar or settings.

### Post-Release Polish (Nice-to-Have)

10. Add icons to all tab labels for visual consistency.
11. Widen the container from 800px to 960px or 1024px to give the Enclave room.
12. Remove `console.log` statements from `WsSignPopup.tsx`.
13. Add a "Sovereign Graduated" status badge to the Enclave banner post-graduation, and hide the "Claim Sovereign Custody" button.
14. De-duplicate the profile filtering logic between `ProjectZero.tsx` and `PersonaMatrix.tsx`.
15. Standardize the derivation index label format (`Index #N` everywhere).
