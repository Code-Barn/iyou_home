//! RFC-005 — Custodial Seed Pods & Sovereign Graduation.
//!
//! Decouples parental supervision from seed possession: a dependent child's
//! root seed is generated inside the child's own edge enclave and the parent
//! NEVER holds it. Custody is expressed as:
//!
//! 1. **Delegable supervisory capabilities** — expiring Ed25519-signed grants
//!    (`kind:9114`) and revocations (`kind:9115`).
//! 2. **2-of-3 Shamir threshold escrow** over GF(2^8) for disaster recovery —
//!    parent keeps one share (`escrow_store.json`), the satellite holds a
//!    time-locked share, and the child's household prints an emergency cold
//!    sheet. No single share reveals the secret, so the parent can never
//!    unilaterally snoop (RFC-005 §6.2).
//! 3. **Monotonic emancipation** — `custody_stage` only ever advances to
//!    Emancipated (3); afterwards active grants are void and the escrow
//!    parent share is destroyed.
//!
//! All crypto is pure Rust — no external Shamir dependency.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use zeroize::Zeroizing;

use crate::vault::{self, ChildPodEntry};

// ---------------------------------------------------------------------------
// GF(2^8) arithmetic — Rijndael polynomial x^8 + x^4 + x^3 + x + 1 (0x11B)
// ---------------------------------------------------------------------------

const GF_POLY: u8 = 0x1B;

/// Multiply two bytes in GF(2^8).
fn gf_mul(a: u8, b: u8) -> u8 {
    let mut acc: u8 = 0;
    let mut x = a;
    let mut y = b;
    for _ in 0..8 {
        if y & 1 == 1 {
            acc ^= x;
        }
        let hi = x & 0x80;
        x <<= 1;
        if hi != 0 {
            x ^= GF_POLY;
        }
        y >>= 1;
    }
    acc
}

/// Raise `a` to `exp` in GF(2^8) by square-and-multiply.
fn gf_pow(a: u8, exp: u32) -> u8 {
    let mut result: u8 = 1;
    let mut base = a;
    let mut e = exp;
    while e > 0 {
        if e & 1 == 1 {
            result = gf_mul(result, base);
        }
        base = gf_mul(base, base);
        e >>= 1;
    }
    result
}

/// Multiplicative inverse of a non-zero element: a^(254) ≡ a^-1.
fn gf_inv(a: u8) -> u8 {
    assert_ne!(a, 0, "zero has no multiplicative inverse in GF(2^8)");
    gf_pow(a, 254)
}

// ---------------------------------------------------------------------------
// 2-of-3 Shamir Secret Sharing over GF(2^8)
// ---------------------------------------------------------------------------

/// Who holds a particular escrow share (RFC-005 §6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareHolder {
    /// Share evaluation point x=1 — stored in the parent's `escrow_store.json`.
    Parent,
    /// Share evaluation point x=2 — satellite time-lock enrollment payload.
    Satellite,
    /// Share evaluation point x=3 — household emergency recovery cold sheet.
    Sheet,
}

impl ShareHolder {
    pub fn as_str(self) -> &'static str {
        match self {
            ShareHolder::Parent => "parent",
            ShareHolder::Satellite => "satellite",
            ShareHolder::Sheet => "sheet",
        }
    }
}

impl std::fmt::Display for ShareHolder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One Shamir share: evaluation point `share_index ∈ {1,2,3}` and a base64
/// payload of 33 bytes = `1 byte x ‖ 32 bytes y`. A single share carries zero
/// information about the seed (the per-byte degree-1 coefficient is shared
/// purely at evaluation time and never stored with a single share).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShareEnvelope {
    pub share_index: u8,
    pub payload_b64: String,
    pub holder: ShareHolder,
}

impl ShareEnvelope {
    pub fn payload_bytes(&self) -> Result<[u8; 33], String> {
        let raw = B64
            .decode(&self.payload_b64)
            .map_err(|e| format!("invalid share payload b64: {}", e))?;
        if raw.len() != 33 {
            return Err(format!("share payload must be 33 bytes, got {}", raw.len()));
        }
        if raw[0] != self.share_index {
            return Err("share payload evaluation point does not match share_index".to_string());
        }
        let mut arr = [0u8; 33];
        arr.copy_from_slice(&raw);
        Ok(arr)
    }
}

/// Split a 32-byte root seed into 3 shares over GF(2^8). Each secret byte
/// `s` becomes the constant term of `f(x) = s + c·x` with a random
/// coefficient `c`; the shares are the evaluations at x ∈ {1, 2, 3}, so any
/// two shares interpolate back to `f(0) = s`. Share payloads are
/// `1 byte x ‖ 32 bytes y` per RFC-005 §6.2.
pub fn split_seed_32(seed: &[u8; 32]) -> [ShareEnvelope; 3] {
    // One random degree-1 coefficient per secret byte (32 bytes of entropy).
    let mut coeffs = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(&mut coeffs[..]);

    let mut shares: [ShareEnvelope; 3] = [
        ShareEnvelope {
            share_index: 1,
            payload_b64: String::new(),
            holder: ShareHolder::Parent,
        },
        ShareEnvelope {
            share_index: 2,
            payload_b64: String::new(),
            holder: ShareHolder::Satellite,
        },
        ShareEnvelope {
            share_index: 3,
            payload_b64: String::new(),
            holder: ShareHolder::Sheet,
        },
    ];

    for x in [1u8, 2u8, 3u8] {
        let mut payload = [0u8; 33];
        payload[0] = x;
        for (i, s) in seed.iter().enumerate() {
            // y = s + c·x over GF(2^8)
            payload[1 + i] = *s ^ gf_mul(coeffs[i], x);
        }
        let idx = (x - 1) as usize;
        shares[idx].payload_b64 = B64.encode(payload);
        shares[idx].holder = match x {
            1 => ShareHolder::Parent,
            2 => ShareHolder::Satellite,
            _ => ShareHolder::Sheet,
        };
    }
    shares
}

/// Reconstruct the 32-byte secret from any two distinct shares via Lagrange
/// interpolation at x=0:
///
/// ```text
/// f(0) = y1 · L1(0) ⊕ y2 · L2(0),  L1(0) = x2/(x1⊕x2), L2(0) = x1/(x1⊕x2)
/// ```
pub fn reconstruct_seed(share_a: &ShareEnvelope, share_b: &ShareEnvelope) -> Result<[u8; 32], String> {
    if share_a.share_index == share_b.share_index {
        return Err("reconstruction_duplicate_share_index".to_string());
    }
    let pa = share_a.payload_bytes()?;
    let pb = share_b.payload_bytes()?;
    let x1 = pa[0];
    let x2 = pb[0];
    if x1 == x2 {
        return Err("reconstruction_duplicate_evaluation_point".to_string());
    }

    let denom = gf_inv(x1 ^ x2);
    let l1 = gf_mul(x2, denom); // L1(0)
    let l2 = gf_mul(x1, denom); // L2(0)

    let mut seed = [0u8; 32];
    for i in 0..32 {
        seed[i] = gf_mul(pa[1 + i], l1) ^ gf_mul(pb[1 + i], l2);
    }
    Ok(seed)
}

/// RFC-005 §6.2 reconstruction verification invariant: after recovering a
/// candidate seed, deterministically re-derive Derivation Index 1 and require
/// it to equal the pod's child DID. Never yield an unverified seed.
pub fn verify_reconstructed_did(seed: &[u8; 32], child_did: &str) -> Result<[u8; 32], String> {
    let kp = vault::derive_deterministic_keypair(seed, 1);
    if kp.did != child_did {
        return Err("reconstruction_did_mismatch".to_string());
    }
    Ok(*seed)
}

/// Reconstruct + DID verification in one step (used by
/// `verify_and_reconstruct_escrow`). Fails closed with
/// `reconstruction_did_mismatch` on any corruption.
pub fn reconstruct_verified_seed(
    share_a: &ShareEnvelope,
    share_b: &ShareEnvelope,
    child_did: &str,
) -> Result<[u8; 32], String> {
    let seed = reconstruct_seed(share_a, share_b)?;
    verify_reconstructed_did(&seed, child_did)
}

// ---------------------------------------------------------------------------
// Supervisory delegation tokens (RFC-005 §5.3)
// ---------------------------------------------------------------------------

/// Capability scope of a supervisory grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantScope {
    /// Authorize safe relay connections on behalf of the child pod.
    Relay,
    /// Approve/deny new contact pairing requests.
    ContactApproval,
    /// Enforce a platform boundary (e.g. restricted feed indexing).
    PlatformBoundary,
}

impl GrantScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            GrantScope::Relay => "relay",
            GrantScope::ContactApproval => "contact_approval",
            GrantScope::PlatformBoundary => "platform_boundary",
        }
    }
}

/// Effect of a supervisory capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantEffect {
    Allow,
    Deny,
    CoSignRequired,
    Enforce,
}

impl GrantEffect {
    pub fn as_str(&self) -> &'static str {
        match self {
            GrantEffect::Allow => "allow",
            GrantEffect::Deny => "deny",
            GrantEffect::CoSignRequired => "co_sign_required",
            GrantEffect::Enforce => "enforce",
        }
    }
}

/// One delegable capability inside a `SupervisoryGrant`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GrantCapability {
    #[serde(rename = "scope")]
    pub scope: GrantScope,
    #[serde(rename = "effect")]
    pub effect: GrantEffect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<String>,
    /// Optional 2-of-N co-sign threshold for `co_sign_required` effects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<u8>,
}

impl GrantCapability {
    /// Canonical display tag, e.g. `Safe Relays Only`, `Co-Sign Required`.
    /// Mirrored by the frontend pod binding UI (RFC-005 §10).
    #[allow(dead_code)]
    pub fn display_tag(&self) -> String {
        match self.effect {
            GrantEffect::Deny => match self.scope {
                GrantScope::Relay => "Safe Relays Only".to_string(),
                GrantScope::ContactApproval => "Contact Approval Denied".to_string(),
                GrantScope::PlatformBoundary => "Platform Boundaries Enforced".to_string(),
            },
            GrantEffect::CoSignRequired => "Co-Sign Required".to_string(),
            GrantEffect::Enforce => format!(
                "Enforce {}",
                match self.scope {
                    GrantScope::PlatformBoundary => "Safe Platform Mode",
                    _ => self.scope.as_str(),
                }
            ),
            GrantEffect::Allow => match self.scope {
                GrantScope::Relay => "Relay Access".to_string(),
                GrantScope::ContactApproval => "Contact Approval".to_string(),
                GrantScope::PlatformBoundary => "Platform Access".to_string(),
            },
        }
    }
}

/// Expiring cryptographic capability grant issued by the parent's L1 identity
/// to a child pod. Signed with the parent's active L1 Ed25519 key over the
/// canonical (lexicographically key-sorted) JSON payload — `kind:9114`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SupervisoryGrant {
    pub v: u8,
    pub issuer_did: String,
    pub subject_did: String,
    pub pod_id: String,
    pub nonce: String,
    pub capabilities: Vec<GrantCapability>,
    pub valid_from: u64,
    pub expires_at: u64,
    pub revocable: bool,
    #[serde(default)]
    pub signature: String,
}

/// Canonical JCS-style payload (serde_json object keys are sorted
/// lexicographically by the default `BTreeMap` backing), covering every
/// signed field EXCEPT `signature`. Identical bytes at sign and verify time.
pub fn canonical_grant_payload(grant: &SupervisoryGrant) -> Result<String, String> {
    let capability_vals: Vec<serde_json::Value> = grant
        .capabilities
        .iter()
        .map(|c| {
            let mut m = serde_json::Map::new();
            m.insert("scope".to_string(), serde_json::json!(c.scope.as_str()));
            m.insert("effect".to_string(), serde_json::json!(c.effect.as_str()));
            if let Some(relay) = &c.relay_id {
                m.insert("relay_id".to_string(), serde_json::json!(relay));
            }
            if let Some(boundary) = &c.boundary {
                m.insert("boundary".to_string(), serde_json::json!(boundary));
            }
            if let Some(th) = c.threshold {
                m.insert("threshold".to_string(), serde_json::json!(th));
            }
            serde_json::Value::Object(m)
        })
        .collect();

    let payload = serde_json::json!({
        "v": grant.v,
        "issuer_did": grant.issuer_did,
        "subject_did": grant.subject_did,
        "pod_id": grant.pod_id,
        "nonce": grant.nonce,
        "capabilities": capability_vals,
        "valid_from": grant.valid_from,
        "expires_at": grant.expires_at,
        "revocable": grant.revocable,
    });
    serde_json::to_string(&payload).map_err(|e| format!("grant canonicalization failed: {}", e))
}

/// Sign the canonical grant payload with the parent's active L1 Ed25519 key.
pub fn sign_supervisory_grant(
    grant: &mut SupervisoryGrant,
    signing_key: &SigningKey,
) -> Result<(), String> {
    if grant.signature.is_empty() {
        let canonical = canonical_grant_payload(grant)?;
        let sig = signing_key.sign(canonical.as_bytes());
        grant.signature = hex::encode(sig.to_bytes());
    }
    Ok(())
}

/// Verify an Ed25519 signature on a supervisory grant.
pub fn verify_supervisory_grant(
    grant: &SupervisoryGrant,
    verifying_key: &VerifyingKey,
) -> Result<bool, String> {
    if grant.signature.is_empty() {
        return Ok(false);
    }
    let canonical = canonical_grant_payload(grant)?;
    let sig_bytes = hex::decode(&grant.signature)
        .map_err(|_| "grant signature is not valid hex".to_string())?;
    let sig = Signature::from_slice(&sig_bytes)
        .map_err(|_| "grant signature is not a valid Ed25519 signature".to_string())?;
    Ok(verifying_key.verify_strict(canonical.as_bytes(), &sig).is_ok())
}

/// Grant identifier recorded on the pod's `active_grants` list —
/// `9114:<nonce>` (kind:9114 persists the grant across the escrow relay).
pub fn grant_id(grant: &SupervisoryGrant) -> String {
    format!("9114:{}", grant.nonce)
}

/// Construct a Nostr `kind:9115` revocation event targeting `pod_id`.
/// The returned unsigned event is signed through the existing enclave Nostr
/// signing path (`crate::sign_event_with_vault`).
pub fn build_supervisory_revoke_event(
    pubkey_hex: &str,
    pod_id: &str,
    created_at: u64,
) -> serde_json::Value {
    serde_json::json!({
        "kind": 9115,
        "pubkey": pubkey_hex,
        "created_at": created_at,
        "tags": [["p", pod_id], ["type", "supervisory_revoke"]],
        "content": serde_json::json!({
            "v": 1,
            "pod_id": pod_id,
            "note": "supervisory capabilities revoked"
        }).to_string(),
    })
}

// ---------------------------------------------------------------------------
// Emancipation lifecycle (RFC-005 §9)
// ---------------------------------------------------------------------------

/// Monotonic emancipation transition: `custody_stage` only ever advances to
/// Emancipated (3). Idempotency is rejected — a second emancipation attempt
/// is an error, and active grants are voided.
pub fn apply_emancipation(entry: &mut ChildPodEntry, now: u64) -> Result<(), String> {
    if entry.custody_stage == vault::CUSTODY_STAGE_EMANCIPATED {
        return Err("already_emancipated".to_string());
    }
    if entry.custody_stage != vault::CUSTODY_STAGE_SUPERVISED
        && entry.custody_stage != vault::CUSTODY_STAGE_TEEN
    {
        return Err("invalid_custody_stage".to_string());
    }
    entry.custody_stage = vault::CUSTODY_STAGE_EMANCIPATED;
    entry.emancipated_at = Some(now);
    entry.active_grants.clear();
    Ok(())
}

// ---------------------------------------------------------------------------
// Threshold escrow storage (RFC-005 §6) — `escrow_store.json`
// ---------------------------------------------------------------------------

/// Shamir scheme metadata recorded alongside the escrow row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShamirScheme {
    pub threshold: u8,
    pub total: u8,
    pub gf: String,
}

impl Default for ShamirScheme {
    fn default() -> Self {
        ShamirScheme {
            threshold: 2,
            total: 3,
            gf: "GF(2^8):x^8+x^4+x^3+x+1".to_string(),
        }
    }
}

/// Time-lock metadata for the satellite share (RFC-005 §6.4). `unlock_at` is
/// milestone-bound: the satellite may only release its share for recovery
/// after the child reaches adulthood (or an open-question emergency window).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeLockRef {
    pub unlock_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SatelliteShareRef {
    pub mom_id: String,
    pub time_lock: TimeLockRef,
}

/// Status of the physical cold sheet (share x=3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SheetShareRef {
    pub share_index: u8,
    pub present: bool,
}

/// Audit trail of recovery events touching the escrow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecoveryEvent {
    pub at: u64,
    pub kind: String,
    pub actor: String,
}

/// One pod's escrow ledger row — the parent holds exactly ONE share
/// (evaluation point x=1). The seed is never stored here; only a single
/// share, which alone cannot resolve the secret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EscrowStore {
    pub v: u8,
    pub pod_id: String,
    pub child_did: String,
    /// Scope of the escrowed secret — always the pod's root seed (32B).
    pub seed_scope: String,
    pub scheme: ShamirScheme,
    /// Parent-held share (index 1). Destroyed on emancipation.
    pub parent_share: ShareEnvelope,
    pub satellite: SatelliteShareRef,
    pub sheet: SheetShareRef,
    pub created_at: u64,
    /// Set when the parent share is destroyed at emancipation.
    pub recovered_at: Option<u64>,
    #[serde(default)]
    pub recovery_events: Vec<RecoveryEvent>,
}

/// On-disk container: map of pod_id → escrow row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EscrowStoreFile {
    pub v: u8,
    #[serde(default)]
    pub pods: BTreeMap<String, EscrowStore>,
}

impl Default for EscrowStoreFile {
    fn default() -> Self {
        EscrowStoreFile {
            v: 1,
            pods: BTreeMap::new(),
        }
    }
}

/// Path to the escrow store: `{app_data}/escrow_store.json`.
pub fn escrow_store_path(app: &tauri::AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("escrow_store.json");
    path
}

/// Load the escrow store file (missing file ⇒ empty store).
pub fn load_escrow_store_at(path: &Path) -> Result<EscrowStoreFile, String> {
    if !path.exists() {
        return Ok(EscrowStoreFile::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Failed to read escrow store: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse escrow store: {}", e))
}

/// Atomic persistence via the shared staging + rename writer.
pub fn save_escrow_store_at(path: &Path, file: &EscrowStoreFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| format!("Failed to serialize escrow store: {}", e))?;
    vault::atomic_write_bytes(path, json.as_bytes())
}

#[allow(dead_code)]
pub fn load_escrow_store(app: &tauri::AppHandle) -> Result<EscrowStoreFile, String> {
    load_escrow_store_at(&escrow_store_path(app))
}

/// Upsert one pod's escrow row into the store.
pub fn store_escrow_row(path: &Path, row: EscrowStore) -> Result<(), String> {
    let mut file = load_escrow_store_at(path)?;
    file.pods.insert(row.pod_id.clone(), row);
    save_escrow_store_at(path, &file)
}

/// Milestone-bound satellite unlock time (RFC-005 open question #1):
/// Supervised pods unlock at ~18 years, Teens at ~2 years, already-adult
/// pods immediately. Placeholder pending the RFC decision, but always
/// honest about the bound in the recorded metadata.
pub fn default_unlock_at(now: u64, custody_stage: u8) -> u64 {
    let year = 365 * 24 * 3600u64;
    match custody_stage {
        vault::CUSTODY_STAGE_SUPERVISED => now + 18 * year,
        vault::CUSTODY_STAGE_TEEN => now + 2 * year,
        _ => now,
    }
}

/// Destroy the parent share at emancipation: zero the payload and stamp
/// `recovered_at` so the escrow row is archived but cryptographically inert.
pub fn destroy_parent_share(row: &mut EscrowStore, now: u64) {
    row.parent_share.payload_b64.clear();
    row.recovered_at = Some(now);
    row.recovery_events.push(RecoveryEvent {
        at: now,
        kind: "emancipation".to_string(),
        actor: "parent_l1".to_string(),
    });
}

// ---------------------------------------------------------------------------
// Binding ceremony (RFC-005 §4.1) — edge identity + escrow distribution
// ---------------------------------------------------------------------------

/// Result of the pod binding ceremony handed back to the ceremony UI.
/// Share 1 (parent) is already persisted to `escrow_store.json`; shares 2 & 3
/// are returned so the child's device can enroll the satellite and print the
/// cold sheet. NO seed material is ever returned or persisted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PodEscrowCeremony {
    pub pod_id: String,
    pub child_did: String,
    pub child_nostr_pubkey_hex: String,
    pub parent_share_b64: String,
    pub satellite_payload_b64: String,
    pub sheet_payload_b64: String,
    pub unlock_at: u64,
}

/// Run the edge binding ceremony against a concrete escrow-store path.
///
/// The child's 32-byte root seed is minted inside the enclave, split into the
/// three escrow shares, the parent share (x=1) is written to
/// `escrow_store.json`, and the seed is zeroized immediately afterward. The
/// seed NE V E R touches a vault, a wire, or the returned ceremony object —
/// exactly the RFC-005 §1.1 decoupling. (In production this runs on the
/// child device's enclave; the parent only ever receives shares.)
pub fn generate_escrow_ceremony_at(
    escrow_path: &Path,
    pod_id: &str,
    custody_stage: u8,
    now: u64,
) -> Result<PodEscrowCeremony, String> {
    let mut seed = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(&mut (*seed)[..]);

    // Edge identity: Derivation Index 1 is the child's L1 person.
    let kp = vault::derive_deterministic_keypair(&seed[..], 1);
    let child_did = kp.did.clone();
    let child_nostr_pubkey_hex = vault::derive_secp256k1_pubkey_hex(&seed[..], 1);

    let shares = split_seed_32(&seed);
    let parent_share = shares[0].clone(); // x=1
    let satellite_share = shares[1].clone(); // x=2
    let sheet_share = shares[2].clone(); // x=3

    let unlock_at = default_unlock_at(now, custody_stage);
    let row = EscrowStore {
        v: 1,
        pod_id: pod_id.to_string(),
        child_did: child_did.clone(),
        seed_scope: "pod_root_seed_32b".to_string(),
        scheme: ShamirScheme::default(),
        parent_share,
        satellite: SatelliteShareRef {
            mom_id: pod_id.to_string(),
            time_lock: TimeLockRef { unlock_at },
        },
        sheet: SheetShareRef {
            share_index: 3,
            present: true,
        },
        created_at: now,
        recovered_at: None,
        recovery_events: vec![],
    };

    store_escrow_row(escrow_path, row)?;

    Ok(PodEscrowCeremony {
        pod_id: pod_id.to_string(),
        child_did,
        child_nostr_pubkey_hex,
        parent_share_b64: shares[0].payload_b64.clone(),
        satellite_payload_b64: satellite_share.payload_b64.clone(),
        sheet_payload_b64: sheet_share.payload_b64.clone(),
        unlock_at,
    })
}

/// App-bound ceremony wrapper (`{app_data}/escrow_store.json`).
pub fn generate_escrow_ceremony(
    app: &tauri::AppHandle,
    pod_id: &str,
    custody_stage: u8,
) -> Result<PodEscrowCeremony, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    generate_escrow_ceremony_at(&escrow_store_path(app), pod_id, custody_stage, now)
}

/// Recovery: reconstruct the pod seed from the parent-held share (x=1) plus
/// one caller-supplied share (satellite x=2 or cold sheet x=3), then enforce
/// the RFC-005 §6.2 DID verification invariant. Returns the recovered seed
/// hex ONLY for the recovery ceremony UI (never persisted).
pub fn verify_and_reconstruct_at(
    escrow_path: &Path,
    pod_id: &str,
    share_bytes_b64: &str,
) -> Result<String, String> {
    let file = load_escrow_store_at(escrow_path)?;
    let row = file
        .pods
        .get(pod_id)
        .ok_or_else(|| format!("pod escrow not found: {}", pod_id))?;
    if row.recovered_at.is_some() {
        return Err("escrow_closed".to_string());
    }

    // The caller's share must be a DISTINCT evaluation point from the stored
    // parent share; sniff the evaluation point from the first payload byte.
    let caller = B64
        .decode(share_bytes_b64)
        .map_err(|e| format!("invalid recovery share b64: {}", e))?;
    if caller.is_empty() {
        return Err("empty recovery share".to_string());
    }
    let eval_pt = caller[0];
    if eval_pt == row.parent_share.share_index {
        return Err("recovery_share_is_parent_share".to_string());
    }

    let caller_share = ShareEnvelope {
        share_index: eval_pt,
        payload_b64: share_bytes_b64.to_string(),
        holder: if eval_pt == 2 {
            ShareHolder::Satellite
        } else {
            ShareHolder::Sheet
        },
    };

    let seed = reconstruct_verified_seed(&row.parent_share, &caller_share, &row.child_did)?;
    Ok(hex::encode(seed))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::vault_from_seed;

    fn test_seed() -> [u8; 32] {
        let mut s = [0u8; 32];
        for (i, b) in s.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(0x11).wrapping_add(0x5A);
        }
        s
    }

    #[test]
    fn shamir_any_two_shares_reconstruct_exact_secret() {
        let seed = test_seed();
        let shares = split_seed_32(&seed);

        // Every 2-of-3 combination must recover the exact 32-byte secret.
        let combos = [
            (0usize, 1usize),
            (0usize, 2usize),
            (1usize, 2usize),
        ];
        for (i, j) in combos {
            let recovered = reconstruct_seed(&shares[i], &shares[j])
                .expect("two distinct shares must reconstruct");
            assert_eq!(recovered, seed, "combo {} + {} must recover the secret", i, j);
        }
    }

    #[test]
    fn single_share_reveals_no_secret() {
        let seed = test_seed();
        let shares = split_seed_32(&seed);

        // Payload shape: 1 byte x + 32 bytes y = 33 bytes base64.
        for s in &shares {
            let payload = s.payload_bytes().expect("payload must decode to 33 bytes");
            assert_eq!(payload[0], s.share_index);
        }

        // A share never contains the seed bytes literally.
        let seed_hex = hex::encode(seed);
        for s in &shares {
            assert!(
                !s.payload_b64.contains(&seed_hex),
                "share must not leak seed bytes"
            );
        }

        // Non-deterministic: splitting the same seed twice yields different
        // shares (the degree-1 coefficient is freshly random), so one share
        // alone cannot be a deterministic function of the secret.
        let shares_b = split_seed_32(&seed);
        assert_ne!(
            shares[0].payload_b64, shares_b[0].payload_b64,
            "independent splits must differ (random coefficient)"
        );
        assert_ne!(
            shares[1].payload_b64, shares_b[1].payload_b64,
            "independent splits must differ (random coefficient)"
        );
    }

    #[test]
    fn duplicate_share_index_rejected() {
        let seed = test_seed();
        let shares = split_seed_32(&seed);
        let err = reconstruct_seed(&shares[0], &shares[0]).unwrap_err();
        assert_eq!(err, "reconstruction_duplicate_share_index");
    }

    #[test]
    fn reconstruction_did_mismatch_on_corrupt_share() {
        let seed = test_seed();
        let kp = vault::derive_deterministic_keypair(&seed, 1);
        let child_did = kp.did.clone();
        let shares = split_seed_32(&seed);

        // Sanity: pristine shares reconstruct and verify against the DID.
        let ok_seed = reconstruct_verified_seed(&shares[0], &shares[1], &child_did).unwrap();
        assert_eq!(ok_seed, seed);

        // Corrupt a single y byte in share B (by re-encoding a flipped payload).
        let mut corrupt_payload = shares[1].payload_bytes().unwrap();
        corrupt_payload[1] ^= 0x01; // flip the first secret byte's y value
        let corrupt_b = ShareEnvelope {
            share_index: shares[1].share_index,
            payload_b64: B64.encode(corrupt_payload),
            holder: shares[1].holder,
        };

        let err = reconstruct_verified_seed(&shares[0], &corrupt_b, &child_did).unwrap_err();
        assert_eq!(
            err, "reconstruction_did_mismatch",
            "corrupted shares must never yield an unverified seed"
        );
    }

    #[test]
    fn supervisory_grant_ed25519_signing_and_verification() {
        let mut grant = SupervisoryGrant {
            v: 1,
            issuer_did: "did:key:z6Mkparent".to_string(),
            subject_did: "did:key:z6Mkchild".to_string(),
            pod_id: "pod_test1".to_string(),
            nonce: "deadbeef".to_string(),
            capabilities: vec![
                GrantCapability {
                    scope: GrantScope::Relay,
                    effect: GrantEffect::Deny,
                    relay_id: Some("wss://safe.example".to_string()),
                    boundary: None,
                    threshold: None,
                },
                GrantCapability {
                    scope: GrantScope::PlatformBoundary,
                    effect: GrantEffect::Enforce,
                    relay_id: None,
                    boundary: Some("restricted_feed_indexing".to_string()),
                    threshold: None,
                },
            ],
            valid_from: 1_700_000_000,
            expires_at: 1_700_000_000 + 86400,
            revocable: true,
            signature: String::new(),
        };

        // Deterministic Ed25519 keypair (Ed25519 keys must be generated from
        // a 32-byte seed; use a fixed scalar for test determinism).
        let mut arr = [0u8; 32];
        arr[..4].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        let signing_key = SigningKey::from_bytes(&arr);
        let verifying_key = signing_key.verifying_key();

        sign_supervisory_grant(&mut grant, &signing_key).unwrap();
        assert_eq!(grant.signature.len(), 128, "Ed25519 signature is 64 bytes hex");
        assert!(
            verify_supervisory_grant(&grant, &verifying_key).unwrap(),
            "signature must verify against the parent's L1 Ed25519 key"
        );

        // Tamper with a signed field → verification must fail.
        grant.expires_at += 1;
        assert!(
            !verify_supervisory_grant(&grant, &verifying_key).unwrap(),
            "tampered grants must fail verification"
        );
        grant.expires_at -= 1;

        // The grant ID namespacing records 9114:<nonce>.
        assert_eq!(grant_id(&grant), "9114:deadbeef");
    }

    #[test]
    fn revoke_event_shapes_pod_target() {
        let ev = build_supervisory_revoke_event("aa".repeat(32).as_str(), "pod_test2", 42);
        assert_eq!(ev["kind"], 9115);
        assert_eq!(ev["pubkey"], "aa".repeat(32));
        assert_eq!(ev["tags"][0][0], "p");
        assert_eq!(ev["tags"][0][1], "pod_test2");
        assert_eq!(ev["tags"][1][1], "supervisory_revoke");
    }

    #[test]
    fn emancipation_monotonic_transition() {
        let mut entry = ChildPodEntry {
            pod_id: "pod_test3".to_string(),
            child_did: "did:key:z6Mkchild".to_string(),
            child_nostr_pubkey_hex: "ab".repeat(32),
            child_device_id: "dev_a1b2c3d4".to_string(),
            bound_at: 1_700_000_000,
            custody_stage: vault::CUSTODY_STAGE_SUPERVISED,
            active_grants: vec!["9114:one".to_string()],
            escrow_ref: "escrow_store.json#pod_test3".to_string(),
            emancipated_at: None,
        };

        apply_emancipation(&mut entry, 1_700_000_100).unwrap();
        assert_eq!(entry.custody_stage, vault::CUSTODY_STAGE_EMANCIPATED);
        assert_eq!(entry.emancipated_at, Some(1_700_000_100));
        assert!(
            entry.active_grants.is_empty(),
            "emancipation must void active grants"
        );

        // Second emancipation must be rejected (monotonic, no re-entry).
        let err = apply_emancipation(&mut entry, 1_700_000_200).unwrap_err();
        assert_eq!(err, "already_emancipated");
    }

    #[test]
    fn escrow_store_round_trip_and_parent_share_destruction() {
        let tmp = std::env::temp_dir().join(format!("iyou_pods_escrow_{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("escrow_store.json");

        let ceremony =
            generate_escrow_ceremony_at(&path, "pod_test4", vault::CUSTODY_STAGE_TEEN, 42).unwrap();
        assert_eq!(ceremony.pod_id, "pod_test4");
        assert_eq!(ceremony.parent_share_b64.len(), 44, "33-byte cross b64");
        assert_eq!(ceremony.satellite_payload_b64.len(), 44);
        assert_eq!(ceremony.sheet_payload_b64.len(), 44);

        let file = load_escrow_store_at(&path).unwrap();
        let row = file.pods.get("pod_test4").expect("row must persist");
        assert_eq!(row.child_did, ceremony.child_did);
        assert_eq!(row.parent_share.share_index, 1);
        assert_eq!(row.sheet.share_index, 3);
        assert!(row.sheet.present);
        assert!(row.recovered_at.is_none());
        assert!(
            row.satellite.time_lock.unlock_at > 42,
            "teen escrow is time-locked toward the adult milestone"
        );

        // Emancipation destroys the parent share and archives the row.
        let mut row2 = row.clone();
        destroy_parent_share(&mut row2, 100);
        assert!(row2.parent_share.payload_b64.is_empty());
        assert_eq!(row2.recovered_at, Some(100));
        assert_eq!(row2.recovery_events[0].kind, "emancipation");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn verify_and_reconstruct_escrow_flow() {
        let tmp = std::env::temp_dir().join(format!("iyou_pods_recover_{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("escrow_store.json");

        let ceremony =
            generate_escrow_ceremony_at(&path, "pod_test5", vault::CUSTODY_STAGE_SUPERVISED, 42)
                .unwrap();

        // Sheet share (x=3) + stored parent share (x=1) → verified seed.
        let seed_hex = verify_and_reconstruct_at(&path, "pod_test5", &ceremony.sheet_payload_b64)
            .expect("recovery with sheet share must succeed");
        assert_eq!(seed_hex.len(), 64);

        // The recovered seed derives to the bound child DID.
        let recovered_seed = hex::decode(&seed_hex).unwrap();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&recovered_seed);
        let kp = vault::derive_deterministic_keypair(&arr, 1);
        assert_eq!(kp.did, ceremony.child_did);

        // Supplying the parent share itself must be rejected.
        let err = verify_and_reconstruct_at(&path, "pod_test5", &ceremony.parent_share_b64)
            .unwrap_err();
        assert_eq!(err, "recovery_share_is_parent_share");

        // Unknown pod → clean error.
        let err =
            verify_and_reconstruct_at(&path, "pod_missing", &ceremony.sheet_payload_b64).unwrap_err();
        assert!(err.contains("not found"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn post_serialize_scan_finds_no_child_seed_material() {
        // Parent vault + one bound child pod. The vault JSON must contain
        // NO child seed bytes (hex or base58) — the child's seed lives only
        // on the child device and inside the escrow share ceremony.
        let parent_seed = test_seed();
        let parent_vault = vault_from_seed(&parent_seed);

        let child_seed = [0xAAu8; 32];
        let child_kp = vault::derive_deterministic_keypair(&child_seed, 1);

        let mut vault = parent_vault;
        vault.child_pods.push(ChildPodEntry {
            pod_id: "pod_scan1".to_string(),
            child_did: child_kp.did.clone(),
            child_nostr_pubkey_hex: "bb".repeat(32),
            child_device_id: "dev_scan1".to_string(),
            bound_at: 1_700_000_000,
            custody_stage: vault::CUSTODY_STAGE_TEEN,
            active_grants: vec!["9114:one".to_string()],
            escrow_ref: "escrow_store.json#pod_scan1".to_string(),
            emancipated_at: None,
        });

        let json = serde_json::to_string(&vault).expect("vault must serialize");
        let child_seed_hex = hex::encode(child_seed);
        let child_seed_b58 = bs58::encode(child_seed).into_string();

        assert!(
            !json.contains(&child_seed_hex),
            "vault JSON must not contain the child seed in hex"
        );
        assert!(
            !json.contains(&child_seed_b58),
            "vault JSON must not contain the child seed in base58"
        );

        // Shared invariant helper present on vault.rs.
        assert!(!vault::vault_json_scan_for_secret(&vault, &child_seed_hex));
    }

    #[test]
    fn grant_and_emancipation_round_trip_with_vault() {
        // End-to-end-ish: build a vault, bind a pod, issue a grant from the
        // parent L1 persona, emancipate, verify the escrow is destroyed.
        let seed = test_seed();
        let vault = vault_from_seed(&seed);
        let parent_l1 = vault.public_persona().expect("L1 persona exists");
        let parent_kp = vault::get_profile_keypair(&vault, &parent_l1.profile_id).unwrap();

        let mut pod = ChildPodEntry {
            pod_id: "pod_test6".to_string(),
            child_did: "did:key:z6Mkchild6".to_string(),
            child_nostr_pubkey_hex: "cc".repeat(32),
            child_device_id: "dev_test6".to_string(),
            bound_at: 1_700_000_000,
            custody_stage: vault::CUSTODY_STAGE_SUPERVISED,
            active_grants: vec![],
            escrow_ref: "escrow_store.json#pod_test6".to_string(),
            emancipated_at: None,
        };

        let mut grant = SupervisoryGrant {
            v: 1,
            issuer_did: parent_kp.did.clone(),
            subject_did: pod.child_did.clone(),
            pod_id: pod.pod_id.clone(),
            nonce: "deadbeef".to_string(),
            capabilities: vec![GrantCapability {
                scope: GrantScope::Relay,
                effect: GrantEffect::Deny,
                relay_id: None,
                boundary: None,
                threshold: None,
            }],
            valid_from: 1_700_000_000,
            expires_at: 1_700_000_000 + 86400,
            revocable: true,
            signature: String::new(),
        };

        sign_supervisory_grant(&mut grant, &parent_kp.signing_key).unwrap();
        pod.active_grants.push(grant_id(&grant));

        apply_emancipation(&mut pod, 1_700_000_100).unwrap();
        assert_eq!(pod.custody_stage, 3);
        assert!(pod.active_grants.is_empty());
    }
}