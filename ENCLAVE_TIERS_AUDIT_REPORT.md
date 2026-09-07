# ENCLAVE_TIERS_AUDIT_REPORT.md

**Diagnostic Audit: Collapsible Enclave Tiers & L3/L4 Structural Integration**  
**Repository:** `iyou_home`  
**Date:** September 7, 2026  
**Status:** Complete  
**Test Verification Baseline:** 87/87 Vitest unit tests passing across 11 suites.

---

## 1. Executive Summary & Core Invariants

This diagnostic audit evaluates the frontend layout, TypeScript type system, and backend Rust cryptographic engine of `iyou_home` to establish an implementation plan for:
1. **Collapsible Tier Accordions in `PersonaMatrix.tsx`**: Grouping persona tiers into interactive accordions with Level 0 (Anchor Sanctum) collapsed by default to maximize operational air-gap friction.
2. **Level 3 (Accredited Roles & Collectives) Integration**: Dedicated cryptographic derivation, isolated index allocation, and strict external bridge exclusion.
3. **Level 4 (Business & Commerce Entities) Integration**: Separate merchant/commerce identity structures with fail-closed access controls.

### 1.1 Non-Negotiable Core Invariants
- **Zero Raw Key Leakage**: Private key seeds and scalar bytes never leave the native Rust enclave or cross the FFI boundary into JavaScript runtime.
- **Air-Gapped Tier Isolation**:
  - **Level 0 (Anchor Sanctum)**: Strictly air-gapped from external signing requests, bridge discovery, and public pickers.
  - **Level 3 (Roles) & Level 4 (Businesses)**: Completely segregated from the Level 1 / Level 2 external signing bridge (`127.0.0.1:9001`) unless governed by explicit role/merchant authorization.
- **Decoupled Monotonic Index Allocation**: Derivation paths for L3/L4 must not collide with or alter the monotonic index progression of Level 2 contextual burners.

---

## 2. Frontend Layout & State Audit (`src/components/enclave/PersonaMatrix.tsx`)

### 2.1 Current Tier Rendering Architecture
`PersonaMatrix.tsx` currently partitions profiles into three arrays at lines 134–153:
- `anchorProfiles`: `p.level === 0 || p.derivation_index === 0 || p.is_system_reserved`
- `primaryProfiles`: `(p.level === 1 || p.derivation_index === 1) && !p.is_system_reserved && p.derivation_index !== 0`
- `burnerProfiles`: `p.level >= 2 || (p.derivation_index >= 2 && !p.is_system_reserved ...)`

#### Current JSX Sections:
1. **Level 0 (Anchor Sanctum)**: Lines 209–410
   - Styled with `borderLeft: "4px solid #7c3aed"`, background `rgba(124, 58, 237, 0.04)`.
   - Header row: Lines 217–248.
   - Warning callout: Lines 250–265.
   - Profile card mapping (`anchorProfiles.map`): Lines 267–409.
2. **Level 1 (Public Persona)**: Lines 412–622
   - Styled with `borderLeft: "4px solid #2563eb"`, background `rgba(37, 99, 235, 0.03)`.
   - Header row: Lines 420–448.
   - Subtitle & profile card mapping (`primaryProfiles.map`): Lines 450–621.
3. **Level 2+ (Contextual / Burner Personas)**: Lines 624–902
   - Styled with `borderLeft: "4px solid #059669"`, background `rgba(5, 150, 105, 0.03)`.
   - Header row: Lines 632–660.
   - Persona creation form (`handleCreatePersona`): Lines 668–707.
   - Persona card mapping (`burnerProfiles.map`): Lines 729–901.
4. **Modals (Mounted at Component Root)**:
   - **Anchor Shield Warning Modal**: Lines 904–1028 (`anchorWarningOpen !== null`).
   - **Delete Confirmation Modal**: Lines 1030–1078 (`deletingProfileId !== null`).
   - **Break-Glass Rotation Modal**: Lines 1080–1233 (`breakGlassModalOpen === true`).

### 2.2 Expansion / Collapse State Management
Introduce reactive accordion state at line 55 of `PersonaMatrix.tsx`:
```typescript
const [expandedTiers, setExpandedTiers] = useState<{
  level0: boolean;
  level1: boolean;
  level2: boolean;
  level3: boolean;
  level4: boolean;
}>({
  level0: false, // Default: COLLAPSED per security directive
  level1: true,
  level2: true,
  level3: true,
  level4: true,
});

const toggleTier = (tier: keyof typeof expandedTiers) => {
  setExpandedTiers((prev) => ({ ...prev, [tier]: !prev[tier] }));
};
```

### 2.3 Exact Insertion Points for Accordion Wrappers
1. **Trust Tier Summary Bar Insertion**:
   - **Target**: Line 208 (between action alerts and the Level 0 section).
   - **Implementation**: Utilize existing classes defined in `App.css` (lines 631–705):
     ```tsx
     <div className="trust-tier-bar" style={{ marginBottom: "1.5rem" }}>
       <div
         className={`trust-tier-card ${expandedTiers.level0 ? "active" : ""}`}
         onClick={() => toggleTier("level0")}
         role="button"
         tabIndex={0}
       >
         <div className="trust-tier-label">Level 0 · Anchor</div>
         <div className="trust-tier-count">{anchorProfiles.length}</div>
       </div>
       <div
         className={`trust-tier-card level-1 ${expandedTiers.level1 ? "active" : ""}`}
         onClick={() => toggleTier("level1")}
         role="button"
         tabIndex={0}
       >
         <div className="trust-tier-label">Level 1 · Primary</div>
         <div className="trust-tier-count">{primaryProfiles.length}</div>
       </div>
       <div
         className={`trust-tier-card level-2 ${expandedTiers.level2 ? "active" : ""}`}
         onClick={() => toggleTier("level2")}
         role="button"
         tabIndex={0}
       >
         <div className="trust-tier-label">Level 2+ · Burners</div>
         <div className="trust-tier-count">{burnerProfiles.length}</div>
       </div>
     </div>
     ```
2. **Level 0 Collapsible Wrapper**:
   - **Header Toggle**: Add toggle button / click handler to header at line 218: `onClick={() => toggleTier("level0")}` with chevron indicator (`{expandedTiers.level0 ? "▼" : "▶"}`).
   - **Body Wrapper**: Insert `{expandedTiers.level0 && (` at line 249.
   - **Closing Tag**: Insert `)}` before line 410.
3. **Level 1 Collapsible Wrapper**:
   - **Header Toggle**: Add click handler to header at line 421: `onClick={() => toggleTier("level1")}`.
   - **Body Wrapper**: Insert `{expandedTiers.level1 && (` at line 449.
   - **Closing Tag**: Insert `)}` before line 622.
4. **Level 2+ Collapsible Wrapper**:
   - **Header Toggle**: Add click handler to header at line 633: `onClick={() => toggleTier("level2")}`.
   - **Body Wrapper**: Insert `{expandedTiers.level2 && (` at line 661.
   - **Closing Tag**: Insert `)}` before line 902.
5. **Level 3 (Accredited Roles & Collectives) Section**:
   - **Target**: Line 903 (immediately below Level 2+ section, before modal declarations).
   - **Styling**: `borderLeft: "4px solid #d97706"`, background `rgba(217, 119, 6, 0.03)`.
6. **Level 4 (Business & Commerce Profiles) Section**:
   - **Target**: Immediately following Level 3 (before line 904).
   - **Styling**: `borderLeft: "4px solid #0891b2"`, background `rgba(8, 145, 178, 0.03)`.

### 2.4 Modal Friction & Height Constraints Analysis
- **Modal Decoupling**: The Anchor Shield modal (lines 904–1028) is rendered inside a portal-like `.modal-overlay` with `position: fixed; z-index: 1000`. It does not reside inside the Level 0 DOM hierarchy.
- **Air-Gap Security Gain**: Having Level 0 collapsed by default ensures that neither the Anchor DID nor the Anchor Nostr Hex is visible or copyable upon dashboard load, adding a necessary layer of intention before reaching the copy friction modal.
- **Height Constraints**: No restrictive `overflow: hidden` or fixed pixel heights exist on `.tab-content` or `.persona-matrix-container`. The container expands and contracts smoothly with accordion state changes.

---

## 3. Type System Audit (`src/lib/types.ts` & `src/lib/enclaveFilters.ts`)

### 3.1 Review of `isAnchor` and `isExternallySignable`
Currently, `src/lib/enclaveFilters.ts` specifies:
```typescript
export const isAnchor = (p: Profile): boolean =>
  p.level === 0 || p.derivation_index === 0 || Boolean(p.is_system_reserved);

export const isExternallySignable = (p: Profile): boolean => !isAnchor(p);
```

### 3.2 Vulnerability & Exposure Analysis
If Level 3 (Roles) and Level 4 (Businesses) were represented simply as `level: 3` and `level: 4` within `Profile`:
1. `isAnchor(p)` would return `false`.
2. `isExternallySignable(p)` would evaluate to `true`.
3. In `WsSignPopup.tsx` line 110:
   ```typescript
   const signable = (profilesList || []).filter((p) => !isAnchor(p));
   ```
   External WebSocket bridge requests from untrusted browser tabs could prompt signatures using corporate and accredited role keys without appropriate authorization.
4. In `SovereignSigner.tsx` line 57:
   ```typescript
   const signable = (list || []).filter(isExternallySignable);
   ```
   Dev-mode signers would conflate persona burners with enterprise signing keys.

### 3.3 Recommended TypeScript Definitions (`src/lib/types.ts`)
Maintain `Profile` for personal sovereign tiers (0, 1, 2) and introduce dedicated interfaces with a discriminated union:

```typescript
/** Level 0 Anchor, Level 1 Public, Level 2 Contextual Burner */
export interface Profile {
  profile_id: string;
  profile_name: string;
  name?: string;
  derivation_index: number;
  did: string;
  level: 0 | 1 | 2;
  is_system_reserved: boolean;
  active?: boolean;
  nostr_pubkey_hex?: string;
  credentials?: any[];
}

/** Level 3: Accredited Role & Collective Profile */
export interface RoleProfile {
  role_id: string;
  role_title: string;
  namespace: string; // e.g., "dao.governance", "clinic.staff"
  role_index: number;
  did: string;
  nostr_pubkey_hex: string;
  organization_did: string;
  accreditation_vc_id?: string;
  delegation_scope: string[];
  level: 3;
  created_at: number;
}

/** Level 4: Business & Commerce Profile */
export interface BusinessProfile {
  business_id: string;
  legal_name: string;
  business_index: number;
  did: string;
  nostr_pubkey_hex: string;
  jurisdiction: string;
  registration_number?: string;
  operating_currency: string;
  merchant_endpoints: string[];
  level: 4;
  created_at: number;
}

export type EnclaveProfile = Profile | RoleProfile | BusinessProfile;
```

### 3.4 Hardened Enclave Filters (`src/lib/enclaveFilters.ts`)
```typescript
import { Profile, EnclaveProfile, RoleProfile, BusinessProfile } from './types';

export const isAnchor = (p: Profile): boolean =>
  p.level === 0 || p.derivation_index === 0 || Boolean(p.is_system_reserved);

/**
 * Strict fail-closed gate: Only Level 1 Public and Level 2 Burner personas
 * are permitted targets for external browser dApp signatures.
 */
export const isExternallySignable = (p: Profile): boolean =>
  !isAnchor(p) && (p.level === 1 || p.level === 2);

export const isRoleProfile = (p: EnclaveProfile): p is RoleProfile => p.level === 3;
export const isBusinessProfile = (p: EnclaveProfile): p is BusinessProfile => p.level === 4;
```

---

## 4. Backend Vault Structure Audit (`src-tauri/src/vault.rs` & `src-tauri/src/bridge.rs`)

### 4.1 Schema Extension in `VaultStore`
Following the architecture of `DependentProfile` (commit `f5e9ea2`), segregated vectors with `#[serde(default)]` are required to maintain complete backward compatibility and structural air-gapping:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStore {
    pub root_seed_base58: String,
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub sovereign_identities: Vec<SovereignIdentity>,
    #[serde(default)]
    pub dependents: Vec<DependentProfile>,
    #[serde(default)]
    pub roles: Vec<RoleProfile>,           // Level 3
    #[serde(default)]
    pub businesses: Vec<BusinessProfile>, // Level 4
}
```

### 4.2 Namespaced L3 Derivation & Index Decoupling
1. **Derivation Spec**: `m/iyou/role/<namespace>/<index>`
   - Ed25519: `SHA-256(root_seed || "iyou/role/" || namespace || "/" || LE32(index))`
   - Nostr secp256k1: `SHA-256("secp256k1-nostr/role/" || root_seed || namespace || "/" || LE32(index))`
2. **Mathematical Independence**:
   Because domain separation constants `"iyou/role/"` and `"secp256k1-nostr/role/"` prepend the derivation hashing, generated keys are provably orthogonal to:
   - Level 0 Anchor (`LE32(0)`)
   - Level 1 Primary (`LE32(1)`)
   - Level 2 Burners (`LE32(i)`)
   - Dependent Identities (`"iyou/dependent/"`)
3. **Decoupled Index Allocation**:
   Monotonic burner index calculation in `add_profile` (`vault.rs:1110-1116`) uses:
   ```rust
   let max_index = vault.profiles.iter().map(|p| p.derivation_index).max().unwrap_or(1);
   let next_index = std::cmp::max(2, max_index + 1);
   ```
   Role indices must be allocated strictly within their respective namespace:
   ```rust
   let next_role_index = vault.roles.iter()
       .filter(|r| r.namespace == target_namespace)
       .map(|r| r.role_index)
       .max()
       .map(|m| m + 1)
       .unwrap_or(0);
   ```
   This ensures that burner creation, deletion, or break-glass rotation never conflicts with or exhausts role derivation indices.

### 4.3 Proposed Rust Structs & Signatures
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleProfile {
    pub role_id: String,
    pub role_title: String,
    pub namespace: String,
    pub role_index: u32,
    pub did: String,
    pub nostr_pubkey_hex: String,
    pub organization_did: String,
    pub accreditation_vc_id: Option<String>,
    pub delegation_scope: Vec<String>,
    #[serde(default = "default_role_level")]
    pub level: u8,
    pub created_at: u64,
}

fn default_role_level() -> u8 { 3 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusinessProfile {
    pub business_id: String,
    pub legal_name: String,
    pub business_index: u32,
    pub did: String,
    pub nostr_pubkey_hex: String,
    pub jurisdiction: String,
    pub registration_number: Option<String>,
    pub operating_currency: String,
    pub merchant_endpoints: Vec<String>,
    #[serde(default = "default_business_level")]
    pub level: u8,
    pub created_at: u64,
}

fn default_business_level() -> u8 { 4 }

pub fn derive_role_identity(
    root_seed: &[u8],
    namespace: &str,
    role_index: u32,
) -> Result<DerivedKeypair, String>;

pub fn derive_role_nostr_pubkey(
    root_seed: &[u8],
    namespace: &str,
    role_index: u32,
) -> Result<String, String>;

pub fn derive_business_identity(
    root_seed: &[u8],
    business_id: &str,
    business_index: u32,
) -> Result<DerivedKeypair, String>;
```

### 4.4 Signature Bridge Isolation (`src-tauri/src/bridge.rs`)
1. **Public Persona Discovery (`public_persona_summaries`)**:
   In `bridge.rs` line 77, `public_persona_summaries` maps over `vault.profiles`. Because `roles` and `businesses` reside in segregated vectors, they are never leaked over `get_profile` frames.
2. **Access Denial Gate (`bridge_access_denial_reason`)**:
   Extend `bridge_access_denial_reason` (`bridge.rs:125-150`) to enforce fail-closed isolation against L3/L4 IDs:
   ```rust
   if vault.roles.iter().any(|r| r.role_id == profile_id) {
       return Some("Access denied: Level 3 Role identity is air-gapped from external signing".to_string());
   }
   if vault.businesses.iter().any(|b| b.business_id == profile_id) {
       return Some("Access denied: Level 4 Business identity requires merchant bridge authorization".to_string());
   }
   ```
3. **Bridge Protection Predicate**:
   Update `is_bridge_protected` (`bridge.rs:72-74`) to reject any non-L1/L2 profile:
   ```rust
   fn is_bridge_protected(profile: &crate::vault::Profile) -> bool {
       profile.derivation_index == 0 || profile.level == 0 || profile.is_system_reserved || profile.level >= 3
   }
   ```

---

## 5. Implementation Roadmap

| Phase | Subsystem | Action | Target Files |
|---|---|---|---|
| **Phase 1** | UI State | Add accordion toggle state with `level0: false` by default | `src/components/enclave/PersonaMatrix.tsx` |
| **Phase 2** | UI Layout | Wrap L0, L1, L2+ sections in collapsible guards and mount `.trust-tier-bar` | `src/components/enclave/PersonaMatrix.tsx`, `src/App.css` |
| **Phase 3** | Type Hardening | Constrain `isExternallySignable` to levels 1 & 2; define `RoleProfile` & `BusinessProfile` | `src/lib/types.ts`, `src/lib/enclaveFilters.ts` |
| **Phase 4** | Backend Derivation | Implement namespaced subkey derivation in `did_rust` and `vault.rs` | `libs/did_rust/src/crypto.rs`, `src-tauri/src/vault.rs` |
| **Phase 5** | Bridge Air-Gap | Add fail-closed guards in `bridge_access_denial_reason` and `is_bridge_protected` | `src-tauri/src/bridge.rs` |
| **Phase 6** | UI Expansion | Render dedicated Level 3 and Level 4 accordion cards in `PersonaMatrix.tsx` | `src/components/enclave/PersonaMatrix.tsx` |
