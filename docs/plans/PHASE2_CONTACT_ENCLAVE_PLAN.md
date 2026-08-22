# Phase 2 Plan — Contact Enclave & Peer Alias Resolution

**Repository:** `iyou_home`
**Status:** Implementation specification v1 — updated with privacy safeguards & resolved decisions
**Files in scope:** `src-tauri/src/bridge.rs`, `src-tauri/src/vault.rs`, `src-tauri/src/lib.rs`, `src/components/WsSignPopup.tsx`, new `src-tauri/src/contacts.rs`

---

## Context

Project Zero's **Peer Trust & Alias Lens**: satellite apps (e.g. `iyou_wun`) query the local `iyou_home` bridge (WSS port 9001) with `RESOLVE_PEER_ALIASES` to resolve unknown Nostr pubkeys / DIDs into locally stored human nicknames and trust badges, derived from peer attestations and contact cards. This phase also reconciles the `POLLY` → `POLY` wire naming between `bridge.rs` and `WsSignPopup.tsx`.

Greenfield confirmed: zero existing contact / alias / attestation code in `src-tauri/` or `src/`.

---

## 1. Audit Findings

### Bridge dispatch loop (`src-tauri/src/bridge.rs:179-341`)

Frames parse in order:

1. `ping` (:186) — answered inline via `response_tx`.
2. `get_profile` (:190) — answered inline via `response_tx`, **before any gating**; returns `public_persona()` only.
3. `profile_id` extraction (:222) — `.unwrap_or("")`.
4. Fail-closed air-gap guard (:231) — `bridge_access_denial_reason` blocks anchor-targeted frames AND all traffic when the vault is unloadable.
5. Signing branches (`sign`, `sign_event`, `sign_credential`, `POLY/POLLY_CREDENTIAL_REQUEST`) — `pipe_or_queue` to React popup.
6. `OMNI_SIGN_REQUEST` (:354) — headless auto-sign inside the Rust bridge.

**Placement decision:** a read-only, key-material-free query like `RESOLVE_PEER_ALIASES` belongs in the **pre-gate tier alongside `get_profile`** (inserted after :220). It must never consume the air-gap guard or touch the popup pipeline.

### POLLY wire inventory (exact occurrences)

| Location | Occurrence | Status |
|---|---|---|
| `bridge.rs:343-344` | inbound accepts `POLY_CREDENTIAL_REQUEST` + legacy `POLLY_CREDENTIAL_REQUEST` | done (Phase 1) |
| `bridge.rs:375` | piped `__type__: "POLLY_CREDENTIAL_REQUEST"` to React | wire contract with popup |
| `bridge.rs:464` | OMNI handler rejects `protocol != "POLLY_V2"` | external contract |
| `bridge.rs:495` | response hardcodes `"protocol": "POLLY_V2"` | external contract |
| `lib.rs:905` | outbound `"type": "POLLY_CREDENTIAL_PRESENTATION"` | external contract |
| `WsSignPopup.tsx:38, 85, 87, 158, 224, 342, 429` | type union member + channel dispatch + UI branches (7 sites) | must move in lockstep |
| `HOME_DEVELOPER_GUIDE.md` (~15 refs) | documentation | update in same pass |

---

## 2. Contact Enclave Storage Architecture

**Location:** dedicated `contacts.json` beside `vault.json`, loaded by a new `src-tauri/src/contacts.rs` module. Deliberately **separate from `VaultStore`** so that un-scoped bridge alias queries never load root seed material.

Persistence reuses the Phase-2 anti-corruption engine:
- Extract the staging writer from `save_vault_inner` into a generic `atomic_write_bytes(path: &Path, payload: &[u8]) -> Result<(), String>` (`.tmp` stage → `sync_all` → atomic rename → cleanup on failure).
- Generalize `quarantine_corrupt_vault` / rotation helpers (already filename-parameterized) so `contacts.json.corrupt_<ts>.bak` behaves identically (5 newest retained).

### Proposed structs

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    Level0,    // "Inner Circle"
    Level0_5,  // "Trusted Alliance"
    Level1,    // "Peer"
}

impl TrustLevel {
    pub fn badge(&self) -> &'static str {
        match self {
            TrustLevel::Level0 => "Inner Circle",
            TrustLevel::Level0_5 => "Trusted Alliance",
            TrustLevel::Level1 => "Peer",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerContact {
    pub peer_id: String,                     // canonical: primary DID or 64-hex nostr pubkey
    pub display_name: String,
    #[serde(default)]
    pub trust_level: TrustLevel,
    #[serde(default)]
    pub disclosed_aliases: Vec<String>,      // L2 sock DIDs, burner nostr hex, external handles
    #[serde(default)]
    pub attestation_receipt: Option<String>, // raw signed VC / VP JSON
    pub created_at: i64,                     // unix seconds
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContactStore {
    pub contacts: Vec<PeerContact>,
}
```

> ⚠️ Naming flag: peer `TrustLevel::Level0/0_5/1` collides semantically with the identity hierarchy's `Profile.level` (0 = anchor, 1 = persona, 2+ = burner). Different domains, same vocabulary — resolved: names kept, see Decisions.

---

## 3. Resolution Logic & Alias Lookup

**Normalization:** trim whitespace on every token at write and query time; lowercase **only pure 64-char hex** tokens (Nostr x-only keys are case-insensitive). DID identifiers are matched case-sensitively (base58/multibase is case-sensitive). Matching is exact-string over the union index `peer_id ∪ disclosed_aliases`. v1 accepts 64-hex keys and literal DID strings — see *Normalization & Case Sensitivity* above for rationale.

**Engine:** pure, unit-testable function:

```rust
pub fn resolve_peer_aliases(store: &ContactStore, queries: &[String]) -> BTreeMap<String, ResolvedPeer>
```

### Wire format

Inbound:

```json
{"type": "RESOLVE_PEER_ALIASES", "pubkeys": ["<hex64|did:key:...>", "..."]}
```

Outbound (minimal, privacy-safe projection):

```json
{
  "type": "peer_aliases_resolved",
  "matches": {
    "<queried_key>": {
      "nickname": "Alice",
      "trust_level": "Level0",
      "badge": "Inner Circle"
    }
  },
  "unknown": ["<no-hit>", "..."]
}
```

Note: the bridge response deliberately carries **only** `nickname`, `trust_level`, and `badge` — never `peer_id`, `disclosed_aliases`, attestation receipts, or timestamps. The full record is available exclusively via Tauri IPC inside the app.

**Dispatch flow (pre-gate):**

1. Validate `pubkeys`: must be array of strings, capped at 256 entries × 128 chars.
2. Normalize tokens.
3. Load `ContactStore` from `contacts.json`: missing file ⇒ empty store ⇒ all `unknown`; corrupt ⇒ quarantine (same engine as vault) + error frame.
4. Answer directly over `response_tx` (consistent with inline `get_profile` handling).
5. Optional enhancement: also index our own persona/burner secp256k1 pubkeys with `source: "self"` so satellites can render "you".

### Privacy Safeguards (port 9001 exposure)

The bridge binds `127.0.0.1` but answers any origin (`Access-Control-Allow-Origin: *` + PNA), so **any website in any local browser can open frames against it**. The contact book is therefore exposed under a strict minimal-disclosure contract:

1. **Exact-match only.** Resolution is keyed lookup; there is no enumeration, listing, prefix, or fuzzy endpoint over the bridge. `list_contacts` exists solely as Tauri IPC and is never bridged.
2. **Minimal projection.** A hit yields `nickname` + `trust_level` + `badge` for the *queried key* — never canonical `peer_id`, alias lists, receipts, or metadata. Callers cannot pivot from one alias to a peer's other identities.
3. **Harvesting cost.** Frames are capped at 256 keys (`MAX_RESOLVE_KEYS`); oversized frames are rejected outright. Unknown keys return only their own echo in `unknown`, revealing nothing about other entries.
4. **No secret adjacency.** `contacts.json` is a standalone store — resolving aliases never loads `vault.json`, so seed/key material is unreachable from this path.
5. **Residual risk (documented):** exact probes still reveal whether a specific known key is in someone's contacts ("Alice knows Bob"). This is inherent to the Alias Lens feature; mitigations beyond caps (e.g. per-origin rate limiting) are deferred until a threat model justifies them.

### Normalization & Case Sensitivity

Trim whitespace on every token at write time and query time. Additionally lowercase a token **only if it is pure 64-char hex** (Nostr x-only pubkeys are case-insensitive). DID identifiers (e.g. `did:key:z6Mk...`) use case-sensitive base58/multibase encodings and must be matched verbatim — blanket lowercasing would corrupt identity matching. Matching is exact-string over the union index `peer_id ∪ disclosed_aliases`; v1 accepts 64-hex keys and literal DID strings (bech32/npub decoding deferred).

---

## 4. Tauri IPC Commands (`src-tauri/src/lib.rs`)

```rust
fn list_contacts(app: AppHandle) -> Result<Vec<PeerContact>, String>
fn save_contact(app: AppHandle, contact: PeerContact) -> Result<(), String>
//   upsert by peer_id, stamps updated_at, dedupes aliases
fn delete_contact(app: AppHandle, peer_id: String) -> Result<(), String>
fn import_disclosure_card(app: AppHandle, card_json: String) -> Result<PeerContact, String>
//   gated by did_rust::verify_vc; derives peer_id / aliases from VC subject
fn resolve_peer_aliases(app: AppHandle, pubkeys: Vec<String>) -> Result<serde_json::Value, String>
//   IPC twin of the bridge query
```

All registered in `invoke_handler` (`lib.rs:1305-1332` region). All writes route through the shared atomic writer; corruption paths route through the shared quarantine engine.

---

## 5. Coordinated POLY Wire Cutover (single atomic commit)

1. **`bridge.rs`**
   - Piped `__type__` → `"POLY_CREDENTIAL_REQUEST"` (:375).
   - OMNI handler accepts `protocol ∈ {"POLY_V2", "POLLY_V2"}` but **echoes the inbound protocol value** back instead of hardcoding (:464, :495).
2. **`lib.rs`**
   - Outbound presentation type → `"POLY_CREDENTIAL_PRESENTATION"` (:905).
3. **`WsSignPopup.tsx`**
   - Rename type-union member + all 7 references (:38, :85, :87, :158, :224, :342, :429).

Legacy inbound `POLLY_CREDENTIAL_REQUEST` tolerance remains indefinitely (already built in Phase 1). Since every consumer is first-party (`iyou_wun`, Polly; pre-release), recommendation is **hard cutover — no dual-emit transition window**. Update `HOME_DEVELOPER_GUIDE.md` alongside.

---

## 6. Test Plan (new, `contacts.rs`)

| Test | Asserts |
|---|---|
| `test_alias_resolution_matches_primary_and_disclosed` | query hits on both canonical id and disclosed alias |
| `test_resolution_normalizes_case_and_no_match_is_unknown` | case-insensitive matching; misses land in `unknown` |
| `test_contact_round_trip_persistence` | save → load → identical store |
| `test_save_contact_upsert_semantics` | same `peer_id` replaces, stamps `updated_at`, dedupes aliases |
| `test_corrupt_contacts_quarantines_and_errors` | garbage `contacts.json` quarantined to `.bak`, loader errors |

Bridge-level integration is out of scope for the unit suite (consistent with existing coverage); resolution logic stays pure/testable in Rust.

---

## Decisions — RESOLVED (as implemented)

1. **Trust-level naming:** kept `Level0 / Level0_5 / Level1` verbatim per protocol spec (wire values `"Level0_5"` etc.). The semantic collision with identity-hierarchy `Profile.level` is acknowledged; badges ("Inner Circle", "Trusted Alliance", "Peer") carry the human meaning.
2. **POLY cutover:** hard cutover executed. Bridge piped `__type__` is now `POLY_CREDENTIAL_REQUEST`, OMNI accepts `POLY_V2 | POLLY_V2` inbound but echoes the caller's protocol back, `lib.rs` emits `POLY_CREDENTIAL_PRESENTATION`, `WsSignPopup.tsx` renamed (7 occurrences), guide updated. Legacy inbound tolerance remains indefinitely.
3. **npub/bech32 decoding:** deferred to v1.1. Hex/DID-only matching ships now; bech32 decoding can be added to `normalize_key` later without schema changes.
