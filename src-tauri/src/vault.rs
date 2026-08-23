/*
 * Copyright (C) 2026 David Byers dba Byers Brands
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use ed25519_dalek::{SigningKey, VerifyingKey};
use k256::schnorr::SigningKey as SecpSigningKey;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Level 0 — immutable, air-gapped anchor identity (private P2P enclaves only).
pub const ANCHOR_PROFILE_ID: &str = "anchor";
/// Level 1 — default active persona for public social tasks.
pub const DEFAULT_PERSONA_PROFILE_ID: &str = "primary";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub profile_id: String,
    pub profile_name: String,
    pub derivation_index: u32,
    pub did: String,
    pub credentials: Vec<VaultCredential>,
    pub nostr_pubkey_hex: String,
    /// Identity tier: 0 = Anchor, 1 = Public Persona, 2+ = Burner/Contextual.
    #[serde(default)]
    pub level: u8,
    /// System-reserved profiles (Anchor) can never be deleted or externally used.
    #[serde(default)]
    pub is_system_reserved: bool,
}

impl Profile {
    pub fn is_anchor(&self) -> bool {
        self.level == 0 || self.derivation_index == 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultCredential {
    pub vc_id: String,
    pub issuer_did: String,
    pub subject_did: String,
    pub credential_type: String,
    pub fidelity_score: Option<f64>,
    pub expiration_date: Option<String>,
    pub raw_payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStore {
    pub root_seed_base58: String,
    pub profiles: Vec<Profile>,
}

impl VaultStore {
    /// The default public-facing identity: first profile at Level 1+ /
    /// derivation index 1+. Never returns the Level 0 anchor.
    pub fn public_persona(&self) -> Option<&Profile> {
        self.profiles
            .iter()
            .find(|p| p.level >= 1 || p.derivation_index >= 1)
            .or_else(|| self.profiles.iter().find(|p| p.derivation_index == 1))
    }

    /// Resolve a profile by id. An empty id resolves to the public persona
    /// (Level 1), never the air-gapped anchor.
    pub fn get_profile_by_id(&self, id: &str) -> Option<&Profile> {
        if id.is_empty() {
            self.public_persona()
        } else {
            self.profiles.iter().find(|p| p.profile_id == id)
        }
    }
}

pub struct DerivedKeypair {
    pub signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
    pub did: String,
}

fn ed25519_multibase(pubkey: &[u8]) -> String {
    let mut multicodec = Vec::with_capacity(2 + pubkey.len());
    multicodec.extend_from_slice(&[0xed, 0x01]);
    multicodec.extend_from_slice(pubkey);
    format!("z{}", bs58::encode(multicodec).into_string())
}

pub fn derive_deterministic_keypair(root_seed: &[u8], derivation_index: u32) -> DerivedKeypair {
    let mut hasher = Sha256::new();
    hasher.update(root_seed);
    hasher.update(&derivation_index.to_le_bytes());
    let hash = hasher.finalize();

    let mut arr = [0u8; 32];
    arr.copy_from_slice(&hash);
    let signing_key = SigningKey::from_bytes(&arr);
    let verifying_key = signing_key.verifying_key();
    let did = format!("did:key:{}", ed25519_multibase(verifying_key.as_bytes()));

    DerivedKeypair {
        signing_key,
        verifying_key,
        did,
    }
}

/// Derive a secp256k1 secret key from the vault root seed, domain-separated
/// from the Ed25519 derivation path to keep key material independent.
pub fn decode_root_seed(vault: &VaultStore) -> Result<Vec<u8>, String> {
    bs58::decode(&vault.root_seed_base58)
        .into_vec()
        .map_err(|_| "Invalid root seed encoding".to_string())
}

pub fn derive_secp256k1_secret_key(root_seed: &[u8], derivation_index: u32) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"secp256k1-nostr");
    hasher.update(root_seed);
    hasher.update(&derivation_index.to_le_bytes());
    let hash = hasher.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&hash);
    arr
}

pub fn derive_secp256k1_pubkey_hex(root_seed: &[u8], derivation_index: u32) -> String {
    let sk_bytes = derive_secp256k1_secret_key(root_seed, derivation_index);
    let key = SecpSigningKey::from_bytes(&sk_bytes)
        .expect("valid 32-byte secp256k1 secret key");
    hex::encode(key.verifying_key().to_bytes())
}

fn get_storage_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("vault.json");
    path
}

pub fn create_vault_at_path(path: &Path) -> Result<VaultStore, String> {
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    let root_seed_base58 = bs58::encode(seed).into_string();

    let vault = VaultStore {
        root_seed_base58,
        profiles: initial_profiles(&seed),
    };

    save_vault_inner(path, &vault)?;
    Ok(vault)
}

/// Bootstrap the reserved identity hierarchy from a root seed:
/// Level 0 Anchor at index 0 and the Level 1 public persona at index 1.
pub fn initial_profiles(seed: &[u8]) -> Vec<Profile> {
    let anchor_kp = derive_deterministic_keypair(seed, 0);
    let anchor_nostr_pk = derive_secp256k1_pubkey_hex(seed, 0);
    let persona_kp = derive_deterministic_keypair(seed, 1);
    let persona_nostr_pk = derive_secp256k1_pubkey_hex(seed, 1);

    vec![
        Profile {
            profile_id: ANCHOR_PROFILE_ID.to_string(),
            profile_name: "Anchor Identity".to_string(),
            derivation_index: 0,
            did: anchor_kp.did,
            credentials: vec![],
            nostr_pubkey_hex: anchor_nostr_pk,
            level: 0,
            is_system_reserved: true,
        },
        Profile {
            profile_id: DEFAULT_PERSONA_PROFILE_ID.to_string(),
            profile_name: "Primary Identity".to_string(),
            derivation_index: 1,
            did: persona_kp.did,
            credentials: vec![],
            nostr_pubkey_hex: persona_nostr_pk,
            level: 1,
            is_system_reserved: false,
        },
    ]
}

// ---------- Persistence: load, quarantine, atomic save ----------

/// Error taxonomy for vault loading. `NotFound` is the legitimate first-run
/// bootstrap signal; every other variant must NEVER trigger regeneration.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VaultLoadError {
    NotFound,
    Corrupt {
        quarantined_to: Option<PathBuf>,
        detail: String,
    },
    Io(String),
}

impl std::fmt::Display for VaultLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultLoadError::NotFound => write!(f, "No vault found at path"),
            VaultLoadError::Corrupt {
                quarantined_to,
                detail,
            } => write!(
                f,
                "Vault corrupt (quarantined: {:?}): {}",
                quarantined_to, detail
            ),
            VaultLoadError::Io(err) => write!(f, "Vault IO error: {}", err),
        }
    }
}

impl std::error::Error for VaultLoadError {}

impl From<VaultLoadError> for String {
    fn from(e: VaultLoadError) -> Self {
        e.to_string()
    }
}

/// Number of `vault.json.corrupt_*.bak` files retained after rotation.
const CORRUPT_BACKUPS_TO_KEEP: usize = 5;

fn corrupt_backup_prefix(original_file_name: &str) -> String {
    format!("{}.corrupt_", original_file_name)
}

/// Collect existing quarantine backups for a vault file, newest first.
/// Timestamps are fixed-width unix seconds embedded in the file name, so
/// lexicographic ordering matches chronological ordering.
pub(crate) fn existing_corrupt_backups(dir: &Path, original_file_name: &str) -> Vec<PathBuf> {
    let prefix = corrupt_backup_prefix(original_file_name);
    let mut backups: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(&prefix) && n.ends_with(".bak"))
                .unwrap_or(false)
        })
        .collect();
    backups.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    backups
}

/// Rename a damaged vault file out of harm's way as
/// `<name>.corrupt_<UNIX_TIMESTAMP>.bak` (with `_N` collision counter
/// within the same second), then prune older backups. Shared by the vault
/// and contact stores so a damaged file can never be destroyed by a
/// subsequent save.
pub(crate) fn quarantine_corrupt_vault(path: &Path) -> std::io::Result<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let original_file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("vault.json")
        .to_string();
    let dir = path.parent().unwrap_or_else(|| Path::new("."));

    let mut backup = dir.join(format!("{}.corrupt_{}.bak", original_file_name, timestamp));
    let mut collision = 0u32;
    while backup.exists() {
        collision += 1;
        backup = dir.join(format!(
            "{}.corrupt_{}_{}.bak",
            original_file_name, timestamp, collision
        ));
    }

    fs::rename(path, &backup)?;
    rotate_corrupt_backups(dir, &original_file_name)?;
    Ok(backup)
}

fn rotate_corrupt_backups(dir: &Path, original_file_name: &str) -> std::io::Result<()> {
    for stale in existing_corrupt_backups(dir, original_file_name)
        .into_iter()
        .skip(CORRUPT_BACKUPS_TO_KEEP)
    {
        let _ = fs::remove_file(stale);
    }
    Ok(())
}

/// Build a `Corrupt` error, quarantining the damaged file when possible so a
/// subsequent save can never destroy the only copy of the user's identities.
fn corrupt_error(path: &Path, detail: String) -> VaultLoadError {
    match quarantine_corrupt_vault(path) {
        Ok(quarantined_to) => VaultLoadError::Corrupt {
            quarantined_to: Some(quarantined_to),
            detail,
        },
        Err(q_err) => VaultLoadError::Corrupt {
            quarantined_to: None,
            detail: format!("{} (quarantine failed: {})", detail, q_err),
        },
    }
}

/// Read-only load from disk. Never creates or regenerates a vault.
pub fn load_vault_from_path(path: &Path) -> Result<VaultStore, VaultLoadError> {
    if !path.exists() {
        return Err(VaultLoadError::NotFound);
    }

    let raw = fs::read(path).map_err(|e| VaultLoadError::Io(e.to_string()))?;

    let text = match String::from_utf8(raw) {
        Ok(t) => t,
        Err(_) => return Err(corrupt_error(path, "File is not valid UTF-8".to_string())),
    };

    let decoded = match base64.decode(text.trim()) {
        Ok(d) => d,
        Err(e) => return Err(corrupt_error(path, format!("Base64 decode error: {}", e))),
    };

    let json = match String::from_utf8(decoded) {
        Ok(j) => j,
        Err(_) => {
            return Err(corrupt_error(
                path,
                "Decoded payload is not valid UTF-8".to_string(),
            ))
        }
    };

    serde_json::from_str::<VaultStore>(&json)
        .map_err(|e| corrupt_error(path, format!("Failed to parse vault: {}", e)))
}

pub fn load_vault(app: &AppHandle) -> Result<VaultStore, VaultLoadError> {
    load_vault_from_path(&get_storage_path(app))
}

/// Self-healing migration for legacy vaults that predate the dual-bootstrap
/// era. Two degenerate shapes are repaired:
///
///   1. Anchor-only vaults (single Index-0 profile) — the missing Level 1
///      Public Persona is provisioned at Index 1.
///   2. Vaults where a single pre-hierarchy identity squats the reserved
///      `"primary"` id at Index 0 with `level: 0` — the row is normalized
///      into proper Anchor form (`profile_id: "anchor"`, system-reserved)
///      before the canonical Level 1 persona is provisioned, keeping the
///      reserved id unique and resolution paths functional.
///
/// Safe because every key derives purely from `root_seed || LE(index)` —
/// the healed persona is byte-identical to the one `initial_profiles`
/// would have minted, so there is zero key rotation. Idempotent: healed
/// vaults satisfy the effective-persona predicate and are left untouched.
/// Returns `Ok(true)` when the vault was mutated and needs persisting.
pub fn heal_reserved_profiles(vault: &mut VaultStore) -> Result<bool, String> {
    let seed = decode_root_seed(vault)?;
    let mut changed = false;

    // An *effective* public persona must satisfy the same predicate the
    // resolution paths use (public_persona / empty-id lookups). A bare id
    // match is not enough: a legacy "primary"-labeled row at Index 0 /
    // Level 0 cannot serve as a public persona.
    let has_effective_persona = vault
        .profiles
        .iter()
        .any(|p| p.level >= 1 || p.derivation_index >= 1);

    // Normalize any Index-0 row into strict Anchor invariants (AGENT.md §1.1):
    // reserved id, level 0, system-reserved. Key material is untouched — the
    // DID derives from seed + index and is unaffected by metadata repair.
    for p in vault.profiles.iter_mut() {
        if p.derivation_index == 0 && !p.is_system_reserved {
            p.is_system_reserved = true;
            p.level = 0;
            if p.profile_id != ANCHOR_PROFILE_ID {
                p.profile_id = ANCHOR_PROFILE_ID.to_string();
            }
            changed = true;
        }
    }

    if !has_effective_persona {
        // After anchor normalization above, DEFAULT_PERSONA_PROFILE_ID is
        // guaranteed free for the canonical Index-1 persona.
        let kp = derive_deterministic_keypair(&seed, 1);
        vault.profiles.push(Profile {
            profile_id: DEFAULT_PERSONA_PROFILE_ID.to_string(),
            profile_name: "Primary Identity".to_string(),
            derivation_index: 1,
            did: kp.did,
            credentials: vec![],
            nostr_pubkey_hex: derive_secp256k1_pubkey_hex(&seed, 1),
            level: 1,
            is_system_reserved: false,
        });
        changed = true;
    }

    if changed {
        vault.profiles.sort_by_key(|p| p.derivation_index);
    }
    Ok(changed)
}

/// Path-based bootstrap loader: creates a fresh vault if and only if the
/// vault file does not exist, and self-heals partially-provisioned legacy
/// vaults (persisting atomically). Corruption and IO faults are returned
/// as-is — a damaged-but-quarantineable vault is never silently replaced.
pub fn load_or_bootstrap_vault_at_path(path: &Path) -> Result<VaultStore, VaultLoadError> {
    match load_vault_from_path(path) {
        Ok(mut vault) => {
            if heal_reserved_profiles(&mut vault).map_err(VaultLoadError::Io)? {
                save_vault_inner(path, &vault).map_err(VaultLoadError::Io)?;
            }
            Ok(vault)
        }
        Err(VaultLoadError::NotFound) => create_vault_at_path(path).map_err(VaultLoadError::Io),
        Err(other) => Err(other),
    }
}

pub fn load_or_bootstrap_vault(app: &AppHandle) -> Result<VaultStore, VaultLoadError> {
    load_or_bootstrap_vault_at_path(&get_storage_path(app))
}

/// Generic atomic write: stage to `<name>.tmp` in the same directory,
/// fsync, then rename over the target. On any failure the staging file is
/// removed and the existing file at `path` is left untouched. Shared by
/// the vault and contact stores.
pub(crate) fn atomic_write_bytes(path: &Path, payload: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }
    if path.is_dir() {
        return Err(format!("{} is a directory", path.display()));
    }

    let staging = path.with_file_name(format!(
        "{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("vault.json")
    ));

    let outcome = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&staging)?;
        file.write_all(payload)?;
        file.sync_all()?;
        fs::rename(&staging, path)?;
        Ok(())
    })();

    if let Err(e) = outcome {
        let _ = fs::remove_file(&staging);
        return Err(format!("Failed to write {} atomically: {}", path.display(), e));
    }

    Ok(())
}

fn save_vault_inner(path: &Path, vault: &VaultStore) -> Result<(), String> {
    let json = serde_json::to_string(vault).map_err(|e| format!("Serialization error: {}", e))?;
    let encrypted = base64.encode(json);
    atomic_write_bytes(path, encrypted.as_bytes())
}

pub fn save_vault(app: &AppHandle, vault: &VaultStore) -> Result<(), String> {
    save_vault_inner(&get_storage_path(app), vault)
}

pub fn get_profile_keypair(vault: &VaultStore, profile_id: &str) -> Result<DerivedKeypair, String> {
    let profile = vault
        .get_profile_by_id(profile_id)
        .ok_or_else(|| format!("Profile not found: '{}'", profile_id))?;

    let seed = bs58::decode(&vault.root_seed_base58)
        .into_vec()
        .map_err(|_| "Invalid root seed encoding".to_string())?;

    Ok(derive_deterministic_keypair(
        &seed,
        profile.derivation_index,
    ))
}

pub fn add_profile(
    vault: &mut VaultStore,
    profile_id: String,
    profile_name: String,
) -> Result<Profile, String> {
    if vault.profiles.iter().any(|p| p.profile_id == profile_id) {
        return Err(format!("Profile '{}' already exists", profile_id));
    }

    // Derivation indices 0 and 1 are reserved for the Anchor and the public
    // persona; user-created personas start at index 2.
    let max_index = vault
        .profiles
        .iter()
        .map(|p| p.derivation_index)
        .max()
        .unwrap_or(1);
    let next_index = std::cmp::max(2, max_index + 1);

    let seed = bs58::decode(&vault.root_seed_base58)
        .into_vec()
        .map_err(|_| "Invalid root seed encoding".to_string())?;

    let kp = derive_deterministic_keypair(&seed, next_index);
    let nostr_pk = derive_secp256k1_pubkey_hex(&seed, next_index);

    let profile = Profile {
        profile_id,
        profile_name,
        derivation_index: next_index,
        did: kp.did,
        credentials: vec![],
        nostr_pubkey_hex: nostr_pk,
        level: 2,
        is_system_reserved: false,
    };

    vault.profiles.push(profile.clone());
    Ok(profile)
}

pub fn remove_profile(vault: &mut VaultStore, profile_id: &str) -> Result<(), String> {
    let pos = vault
        .profiles
        .iter()
        .position(|p| p.profile_id == profile_id)
        .ok_or_else(|| format!("Profile not found: '{}'", profile_id))?;

    let target = &vault.profiles[pos];
    if target.is_system_reserved || target.derivation_index == 0 || target.level == 0 {
        return Err("Cannot delete system reserved profile".into());
    }

    vault.profiles.remove(pos);
    Ok(())
}

pub fn list_profiles(vault: &VaultStore) -> Vec<Profile> {
    vault.profiles.clone()
}

// ---------- Stream B: Poll Vote Ledger ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteRecord {
    pub poll_id: String,
    pub option_id: String,
    pub client_signature: String,
    pub voter_did: String,
    pub network_timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalPoll {
    pub poll_id: String,
    pub title: String,
    pub poll_type: String,
    pub starts_at: u64,
    pub ends_at: u64,
    pub is_ongoing: bool,
}

impl LocalPoll {
    pub fn validate_vote_timeline(&self, vote_timestamp: u64) -> Result<(), String> {
        if !self.is_ongoing {
            if vote_timestamp < self.starts_at {
                return Err(
                    "Vote rejected: Poll schedule has not initialized yet.".to_string(),
                );
            }
            if vote_timestamp > self.ends_at {
                return Err(
                    "Vote rejected: Cryptographic ledger state is closed/locked.".to_string(),
                );
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PollLedger {
    pub records: Vec<VoteRecord>,
}

fn get_ledger_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("poll_ledger.json");
    path
}

pub fn load_ledger(app: &AppHandle) -> PollLedger {
    let path = get_ledger_path(app);
    if !path.exists() {
        return PollLedger::default();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_ledger(app: &AppHandle, ledger: &PollLedger) -> Result<(), String> {
    let path = get_ledger_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create ledger directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(ledger)
        .map_err(|e| format!("Serialization error: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write ledger: {}", e))?;
    Ok(())
}

pub fn append_vote_records(app: &AppHandle, records: Vec<VoteRecord>) -> Result<(), String> {
    let mut ledger = load_ledger(app);
    ledger.records.extend(records);
    save_ledger(app, &ledger)
}

pub fn get_vote_records(app: &AppHandle) -> Result<Vec<VoteRecord>, String> {
    Ok(load_ledger(app).records)
}

// ---------- Cold Governance Anchoring: Merkle Root ----------
//
// Offline validation helper: accepts a slice of VoteRecord entries,
// extracts their Ed25519 `client_signature` fields, and computes a
// deterministic SHA-256 Merkle root.
//
// This root serves as a local validation artifact that users can
// compare against immutable ipfs_cid hashes generated by server-side
// Polly governance anchors.
//
// Second-preimage resistance is achieved via standard domain separation:
//   Leaf hash       = SHA-256(0x00 || signature_bytes)
//   Internal hash   = SHA-256(0x01 || left_hash || right_hash)
//
// If the leaf count is odd, the final node is duplicated to form
// a balanced binary tree at each layer.

pub fn calculate_vote_merkle_root(records: &[VoteRecord]) -> String {
    if records.is_empty() {
        return String::new();
    }

    let mut layer: Vec<[u8; 32]> = Vec::with_capacity(records.len());

    for record in records {
        let sig_bytes = hex::decode(&record.client_signature).unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update([0x00]);
        hasher.update(&sig_bytes);
        layer.push(hasher.finalize().into());
    }

    while layer.len() > 1 {
        let mut next: Vec<[u8; 32]> = Vec::with_capacity((layer.len() + 1) / 2);
        let mut i = 0;
        while i < layer.len() {
            let left = &layer[i];
            let right = if i + 1 < layer.len() {
                &layer[i + 1]
            } else {
                &layer[i]
            };
            let mut hasher = Sha256::new();
            hasher.update([0x01]);
            hasher.update(left);
            hasher.update(right);
            next.push(hasher.finalize().into());
            i += 2;
        }
        layer = next;
    }

    hex::encode(layer[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    #[test]
    fn test_derivation_is_deterministic() {
        let seed = [0xabu8; 32];
        let kp1 = derive_deterministic_keypair(&seed, 42);
        let kp2 = derive_deterministic_keypair(&seed, 42);
        assert_eq!(kp1.did, kp2.did);
        assert_eq!(kp1.signing_key.to_bytes(), kp2.signing_key.to_bytes());
    }

    #[test]
    fn test_different_index_different_key() {
        let seed = [0xabu8; 32];
        let kp0 = derive_deterministic_keypair(&seed, 0);
        let kp1 = derive_deterministic_keypair(&seed, 1);
        assert_ne!(kp0.did, kp1.did);
    }

    #[test]
    fn test_vault_round_trip() {
        let mut path = temp_dir();
        path.push("test_vault_profile.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");

        assert_eq!(vault.profiles.len(), 2);
        assert_eq!(vault.profiles[0].profile_id, ANCHOR_PROFILE_ID);
        assert_eq!(vault.profiles[1].profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert!(vault.profiles[0].did.starts_with("did:key:"));
        assert!(vault.profiles[1].did.starts_with("did:key:"));

        let raw = fs::read_to_string(&path).expect("Should read file");
        assert!(!raw.contains(vault.profiles[0].did.as_str()));
        assert!(!raw.contains(vault.profiles[1].did.as_str()));

        let loaded = load_vault_from_path(&path).expect("Should load vault");
        assert_eq!(loaded.profiles.len(), 2);
        assert_eq!(loaded.profiles[0].did, vault.profiles[0].did);
        assert_eq!(loaded.profiles[1].did, vault.profiles[1].did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_dual_did_initial_provisioning() {
        let mut path = temp_dir();
        path.push("test_vault_dual_did.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");

        assert_eq!(vault.profiles.len(), 2);

        let anchor = &vault.profiles[0];
        assert_eq!(anchor.profile_id, ANCHOR_PROFILE_ID);
        assert_eq!(anchor.profile_name, "Anchor Identity");
        assert_eq!(anchor.derivation_index, 0);
        assert_eq!(anchor.level, 0);
        assert!(anchor.is_system_reserved);
        assert!(anchor.is_anchor());
        assert!(anchor.did.starts_with("did:key:"));
        assert_eq!(anchor.nostr_pubkey_hex.len(), 64);

        let persona = &vault.profiles[1];
        assert_eq!(persona.profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert_eq!(persona.profile_name, "Primary Identity");
        assert_eq!(persona.derivation_index, 1);
        assert_eq!(persona.level, 1);
        assert!(!persona.is_system_reserved);
        assert!(!persona.is_anchor());
        assert!(persona.did.starts_with("did:key:"));
        assert_eq!(persona.nostr_pubkey_hex.len(), 64);

        // Anchor and persona must be cryptographically distinct identities.
        assert_ne!(anchor.did, persona.did);
        assert_ne!(anchor.nostr_pubkey_hex, persona.nostr_pubkey_hex);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_load_vault_not_found() {
        let mut path = temp_dir();
        path.push(format!("test_vault_missing_{}.json", std::process::id()));
        let _ = fs::remove_file(&path);

        assert!(!path.exists());
        let result = load_vault_from_path(&path);
        assert!(
            matches!(result, Err(VaultLoadError::NotFound)),
            "Missing file must yield NotFound, got {:?}",
            result
        );
        assert!(!path.exists(), "NotFound must not create a vault file");
    }

    #[test]
    fn test_load_vault_corrupt_quarantines_file() {
        let dir = temp_dir();

        // Case 1: binary garbage (invalid UTF-8).
        let path = dir.join("test_vault_corrupt_binary.json");
        let garbage: &[u8] = &[0x00, 0xFF, 0xDE, 0xAD, 0xBE, 0xEF];
        fs::write(&path, garbage).expect("Should write binary garbage");

        let err = load_vault_from_path(&path)
            .err()
            .expect("Corrupt vault must fail");
        let backup = match err {
            VaultLoadError::Corrupt {
                quarantined_to,
                detail,
            } => {
                assert!(!detail.is_empty());
                quarantined_to.expect("Corrupt file must be quarantined")
            }
            other => panic!("Expected Corrupt, got {:?}", other),
        };
        assert!(backup.to_string_lossy().contains(".corrupt_"));
        assert!(backup.to_string_lossy().ends_with(".bak"));
        assert_eq!(fs::read(&backup).expect("Backup must be readable"), garbage);
        assert!(!path.exists(), "Original corrupt file must be renamed away");
        let _ = fs::remove_file(&backup);

        // Case 2: valid UTF-8 but invalid base64 payload.
        let path = dir.join("test_vault_corrupt_text.json");
        fs::write(&path, "definitely not base64 !!!").expect("Should write bad text");

        let err = load_vault_from_path(&path)
            .err()
            .expect("Corrupt vault must fail");
        match err {
            VaultLoadError::Corrupt { quarantined_to, .. } => {
                let backup = quarantined_to.expect("Corrupt file must be quarantined");
                assert!(backup.exists());
                assert!(!path.exists());
                let _ = fs::remove_file(&backup);
            }
            other => panic!("Expected Corrupt, got {:?}", other),
        }
    }

    #[test]
    fn test_quarantine_rotation_keeps_recent_backups() {
        let dir = temp_dir();
        let original_name = format!("test_vault_rotate_{}.json", std::process::id());
        let path = dir.join(&original_name);

        // Seed seven fake older backups with ascending timestamps.
        for ts in 100..=106u64 {
            fs::write(
                dir.join(format!("{}.corrupt_{}.bak", original_name, ts)),
                b"old",
            )
            .expect("Should seed backup");
        }

        // Quarantine a fresh corrupt file — real timestamp sorts newest.
        fs::write(&path, b"\x00\xFFgarbage").expect("Should write garbage");
        let err = load_vault_from_path(&path)
            .err()
            .expect("Corrupt vault must fail");
        let fresh_backup = match err {
            VaultLoadError::Corrupt { quarantined_to, .. } => {
                quarantined_to.expect("Must quarantine")
            }
            other => panic!("Expected Corrupt, got {:?}", other),
        };

        let backups = existing_corrupt_backups(&dir, &original_name);
        assert_eq!(
            backups.len(),
            CORRUPT_BACKUPS_TO_KEEP,
            "Rotation must retain only the newest backups"
        );
        assert!(backups.contains(&fresh_backup));
        // The three oldest seeded backups must have been pruned.
        for ts in 100..=102u64 {
            assert!(
                !dir.join(format!("{}.corrupt_{}.bak", original_name, ts)).exists(),
                "Old backup {} must be pruned",
                ts
            );
        }
        for ts in 103..=106u64 {
            assert!(dir
                .join(format!("{}.corrupt_{}.bak", original_name, ts))
                .exists());
        }

        let _ = fs::remove_file(&fresh_backup);
        for backup in backups {
            let _ = fs::remove_file(backup);
        }
    }

    #[test]
    fn test_atomic_save_preserves_on_write_failure() {
        let mut path = temp_dir();
        path.push("test_vault_atomic.json");
        let _ = fs::remove_file(&path);

        let mut vault = create_vault_at_path(&path).expect("Should create vault");
        let original_persona_did = vault.profiles[1].did.clone();

        // Occupy the staging path with a directory so File::create fails
        // mid-save, simulating an interrupted/crashed write.
        let staging = path.with_file_name(format!("{}.tmp", path.file_name().unwrap().to_string_lossy()));
        fs::create_dir(&staging).expect("Should create staging blocker");

        add_profile(&mut vault, "burner".to_string(), "Burner".to_string())
            .expect("Should mutate in-memory state");
        let result = save_vault_inner(&path, &vault);
        assert!(result.is_err(), "Save must fail when staging is blocked");

        // The on-disk vault must be untouched and still fully loadable.
        let loaded = load_vault_from_path(&path).expect("Original vault must survive");
        assert_eq!(loaded.profiles.len(), 2, "Partial write must not land");
        assert_eq!(loaded.profiles[1].did, original_persona_did);

        let _ = fs::remove_dir(&staging);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn test_bootstrap_only_on_not_found() {
        let dir = temp_dir();
        let original_name = format!("test_vault_bootstrap_{}.json", std::process::id());
        let path = dir.join(&original_name);
        let _ = fs::remove_file(&path);

        // Missing → bootstraps the dual-DID hierarchy.
        assert!(!path.exists());
        let vault = load_or_bootstrap_vault_at_path(&path).expect("Should bootstrap");
        assert_eq!(vault.profiles.len(), 2);
        assert!(path.exists());

        // Corrupt → error + quarantine. Never regenerated, never overwritten.
        fs::write(&path, b"\x00\xFFcorrupted").expect("Should corrupt vault");
        let result = load_or_bootstrap_vault_at_path(&path);
        assert!(
            matches!(result, Err(VaultLoadError::Corrupt { .. })),
            "Corruption must surface as Corrupt, got {:?}",
            result
        );
        assert!(
            !path.exists(),
            "Quarantined vault must not be replaced by a fresh one"
        );

        for backup in existing_corrupt_backups(&dir, &original_name) {
            let _ = fs::remove_file(backup);
        }
    }

    // ---------- Self-Healing Migration Tests ----------

    /// Rewind a freshly minted vault to an anchor-only (Index 0) snapshot,
    /// simulating a pre-dual-bootstrap legacy dev vault on disk.
    fn write_legacy_anchor_only_vault(path: &Path) -> (VaultStore, Vec<u8>) {
        let full = create_vault_at_path(path).expect("Should create full vault");
        let legacy = VaultStore {
            root_seed_base58: full.root_seed_base58.clone(),
            profiles: vec![full.profiles[0].clone()],
        };
        save_vault_inner(path, &legacy).expect("Should persist legacy vault");
        let seed = bs58::decode(&legacy.root_seed_base58)
            .into_vec()
            .expect("Seed should decode");
        (legacy, seed)
    }

    #[test]
    fn test_legacy_single_profile_vault_self_heals() {
        let mut path = temp_dir();
        path.push("test_vault_heal_legacy.json");
        let _ = fs::remove_file(&path);

        let (legacy, seed) = write_legacy_anchor_only_vault(&path);
        assert_eq!(legacy.profiles.len(), 1);
        let anchor_did = legacy.profiles[0].did.clone();

        // Load through the bootstrapping loader: must heal and persist.
        let healed = load_or_bootstrap_vault_at_path(&path).expect("Should heal legacy vault");
        assert_eq!(healed.profiles.len(), 2, "Missing Level 1 persona must be provisioned");

        // The anchor is untouched.
        assert_eq!(healed.profiles[0].profile_id, ANCHOR_PROFILE_ID);
        assert_eq!(healed.profiles[0].did, anchor_did, "Anchor identity must not rotate");
        assert_eq!(healed.profiles[0].derivation_index, 0);

        // The healed persona sits at Index 1 with the deterministic identity
        // initial_profiles would have created — zero key rotation.
        let persona = &healed.profiles[1];
        let expected_kp = derive_deterministic_keypair(&seed, 1);
        assert_eq!(persona.profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert_eq!(persona.profile_name, "Primary Identity");
        assert_eq!(persona.derivation_index, 1);
        assert_eq!(persona.level, 1);
        assert!(!persona.is_system_reserved);
        assert_eq!(persona.did, expected_kp.did);
        assert_eq!(persona.nostr_pubkey_hex, derive_secp256k1_pubkey_hex(&seed, 1));

        // Healing must survive a cold reload: state was persisted to disk.
        let reloaded = load_vault_from_path(&path).expect("Healed vault must round-trip");
        assert_eq!(reloaded.profiles.len(), 2);
        assert_eq!(reloaded.profiles[1].did, expected_kp.did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_legacy_primary_squatting_index0_vault_self_heals() {
        // Regression for the observed dev-machine shape: a single pre-hierarchy
        // identity labeled "primary" sitting at Index 0 with serde-defaulted
        // level/is_system_reserved fields. The id alone must NOT satisfy the
        // effective-persona predicate.
        let mut path = temp_dir();
        path.push("test_vault_heal_squatting.json");
        let _ = fs::remove_file(&path);

        let full = create_vault_at_path(&path).expect("Should create vault");
        let seed = bs58::decode(&full.root_seed_base58)
            .into_vec()
            .expect("Seed should decode");
        let squatting = VaultStore {
            root_seed_base58: full.root_seed_base58.clone(),
            profiles: vec![Profile {
                profile_id: DEFAULT_PERSONA_PROFILE_ID.to_string(),
                profile_name: "Primary Identity".to_string(),
                derivation_index: 0,
                did: full.profiles[0].did.clone(),
                credentials: vec![],
                nostr_pubkey_hex: full.profiles[0].nostr_pubkey_hex.clone(),
                level: 0,
                is_system_reserved: false,
            }],
        };
        save_vault_inner(&path, &squatting).expect("Should persist squatting vault");
        let anchor_did = squatting.profiles[0].did.clone();

        let healed =
            load_or_bootstrap_vault_at_path(&path).expect("Squatting vault must self-heal");
        assert_eq!(healed.profiles.len(), 2);

        // The Index-0 row is normalized into strict Anchor invariants; key
        // material is untouched.
        let anchor = &healed.profiles[0];
        assert_eq!(anchor.profile_id, ANCHOR_PROFILE_ID, "Reserved id must be reclaimed");
        assert_eq!(anchor.derivation_index, 0);
        assert_eq!(anchor.level, 0);
        assert!(anchor.is_system_reserved);
        assert_eq!(anchor.did, anchor_did, "Anchor DID must not rotate");

        // The canonical Level 1 persona is provisioned at Index 1.
        let persona = &healed.profiles[1];
        assert_eq!(persona.profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert_eq!(persona.derivation_index, 1);
        assert_eq!(persona.level, 1);
        assert!(!persona.is_system_reserved);
        assert_eq!(persona.did, derive_deterministic_keypair(&seed, 1).did);

        // Empty-id resolution (the Nostr auto-start path) now succeeds.
        let kp = get_profile_keypair(&healed, "").expect("Empty id must resolve post-heal");
        assert_eq!(kp.did, persona.did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_heal_is_idempotent() {
        let mut path = temp_dir();
        path.push("test_vault_heal_idempotent.json");
        let _ = fs::remove_file(&path);

        let (_legacy, seed) = write_legacy_anchor_only_vault(&path);

        let first = load_or_bootstrap_vault_at_path(&path).expect("First load should heal");
        let second = load_or_bootstrap_vault_at_path(&path).expect("Second load must not duplicate");

        assert_eq!(first.profiles.len(), 2);
        assert_eq!(second.profiles.len(), 2);
        assert_eq!(
            first.profiles[1].did,
            derive_deterministic_keypair(&seed, 1).did
        );
        assert_eq!(first.profiles[1].did, second.profiles[1].did);

        // A healed vault reports no further mutations needed.
        let mut already_healed = second.clone();
        assert!(!heal_reserved_profiles(&mut already_healed).unwrap());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_get_profile_keypair_empty_id_after_heal() {
        let mut path = temp_dir();
        path.push("test_vault_heal_empty_id.json");
        let _ = fs::remove_file(&path);

        let (_legacy, seed) = write_legacy_anchor_only_vault(&path);

        // Regression guard for: Auto-start Nostr failed: Profile not found: ''
        let healed = load_or_bootstrap_vault_at_path(&path).expect("Should heal");
        let kp = get_profile_keypair(&healed, "").expect("Empty id must resolve post-heal");
        assert_eq!(kp.did, derive_deterministic_keypair(&seed, 1).did);
        assert_ne!(kp.did, healed.profiles[0].did, "Must never fall back to the anchor");

        // Public persona resolution agrees with the empty-id keypair path.
        let persona = healed.public_persona().expect("Persona should resolve");
        assert_eq!(persona.did, kp.did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_anchor_deletion_blocked() {
        let mut path = temp_dir();
        path.push("test_vault_anchor_guard.json");

        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        let result = remove_profile(&mut vault, ANCHOR_PROFILE_ID);
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("system reserved"),
            "Anchor deletion must be rejected as system-reserved"
        );
        assert_eq!(vault.profiles.len(), 2);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_default_resolution_targets_persona() {
        let mut path = temp_dir();
        path.push("test_vault_persona_resolution.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");

        let persona = vault.public_persona().expect("Should resolve persona");
        assert_eq!(persona.derivation_index, 1);
        assert_eq!(persona.profile_id, DEFAULT_PERSONA_PROFILE_ID);

        let by_empty = vault
            .get_profile_by_id("")
            .expect("Empty id should resolve to persona");
        assert_eq!(by_empty.derivation_index, 1);
        assert!(!by_empty.is_anchor());

        let kp = get_profile_keypair(&vault, "").expect("Should derive from default");
        assert_eq!(kp.did, vault.profiles[1].did);
        assert_ne!(kp.did, vault.profiles[0].did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_add_remove_profile() {
        let mut path = temp_dir();
        path.push("test_vault_profiles.json");

        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        let p = add_profile(
            &mut vault,
            "pseudo_1".to_string(),
            "Social Pseudonym".to_string(),
        )
        .expect("Should add profile");
        assert_eq!(p.derivation_index, 2);
        assert_eq!(p.level, 2);
        assert!(!p.is_system_reserved);
        assert!(p.did.starts_with("did:key:"));
        assert_ne!(p.did, vault.profiles[0].did);
        assert_ne!(p.did, vault.profiles[1].did);

        assert_eq!(vault.profiles.len(), 3);

        remove_profile(&mut vault, "pseudo_1").expect("Should remove");
        assert_eq!(vault.profiles.len(), 2);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_add_profile_index_floor() {
        let mut path = temp_dir();
        path.push("test_vault_index_floor.json");

        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        let p1 = add_profile(&mut vault, "burner_a".to_string(), "Burner A".to_string())
            .expect("Should add first burner");
        assert_eq!(p1.derivation_index, 2);

        let p2 = add_profile(&mut vault, "burner_b".to_string(), "Burner B".to_string())
            .expect("Should add second burner");
        assert_eq!(p2.derivation_index, 3);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_get_profile_by_id_defaults_to_first() {
        let mut path = temp_dir();
        path.push("test_vault_default.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");

        // Empty id resolves to the public persona (Level 1), not the anchor.
        let p = vault.get_profile_by_id("").expect("Should return persona");
        assert_eq!(p.profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert_eq!(p.derivation_index, 1);

        let p2 = vault
            .get_profile_by_id(DEFAULT_PERSONA_PROFILE_ID)
            .expect("Should find by id");
        assert_eq!(p2.profile_id, DEFAULT_PERSONA_PROFILE_ID);

        let anchor = vault
            .get_profile_by_id(ANCHOR_PROFILE_ID)
            .expect("Should find anchor");
        assert_eq!(anchor.derivation_index, 0);

        assert!(vault.get_profile_by_id("nonexistent").is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_get_profile_keypair() {
        let mut path = temp_dir();
        path.push("test_vault_keypair.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");
        let kp = get_profile_keypair(&vault, DEFAULT_PERSONA_PROFILE_ID)
            .expect("Should derive keypair");
        assert_eq!(kp.did, vault.profiles[1].did);

        let kp2 = get_profile_keypair(&vault, "").expect("Should derive from default");
        assert_eq!(kp2.did, vault.profiles[1].did);

        let anchor_kp = get_profile_keypair(&vault, ANCHOR_PROFILE_ID)
            .expect("Should derive anchor keypair");
        assert_eq!(anchor_kp.did, vault.profiles[0].did);
        assert_ne!(anchor_kp.did, kp.did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_vote_record_round_trip() {
        let dir = temp_dir();
        let ledger_path = dir.join("poll_ledger.json");

        let records = vec![
            VoteRecord {
                poll_id: "poll_abc".into(),
                option_id: "opt_1".into(),
                client_signature: "sig_hex_value".into(),
                voter_did: "did:key:zabc123".into(),
                network_timestamp: 1715000000,
            },
            VoteRecord {
                poll_id: "poll_abc".into(),
                option_id: "opt_2".into(),
                client_signature: "sig_hex_value_2".into(),
                voter_did: "did:key:zdef456".into(),
                network_timestamp: 1715000060,
            },
        ];

        let ledger = PollLedger {
            records: records.clone(),
        };
        let json = serde_json::to_string_pretty(&ledger).expect("Should serialize");
        std::fs::write(&ledger_path, &json).expect("Should write");

        let loaded_json = std::fs::read_to_string(&ledger_path).expect("Should read");
        let loaded: PollLedger =
            serde_json::from_str(&loaded_json).expect("Should deserialize");

        assert_eq!(loaded.records.len(), 2);
        assert_eq!(loaded.records[0].poll_id, "poll_abc");
        assert_eq!(loaded.records[0].option_id, "opt_1");
        assert_eq!(loaded.records[1].network_timestamp, 1715000060);

        let _ = std::fs::remove_file(&ledger_path);
    }

    #[test]
    fn test_credential_storage_fidelity() {
        let mut path = temp_dir();
        path.push("test_vault_creds.json");

        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        let cred1 = VaultCredential {
            vc_id: "vc-001".to_string(),
            issuer_did: "did:key:zissuer1".to_string(),
            subject_did: "did:key:zsubject1".to_string(),
            credential_type: "UniversityDegree".to_string(),
            fidelity_score: Some(0.95),
            expiration_date: Some("2027-06-01T00:00:00Z".to_string()),
            raw_payload: r#"{"@context":["https://www.w3.org/2018/credentials/v1"],"id":"vc-001","type":["VerifiableCredential","UniversityDegree"],"issuer":"did:key:zissuer1","issuanceDate":"2025-01-01T00:00:00Z","credentialSubject":{"id":"did:key:zsubject1","degree":"BSc"}}"#.to_string(),
        };

        let cred2 = VaultCredential {
            vc_id: "vc-002".to_string(),
            issuer_did: "did:key:zissuer2".to_string(),
            subject_did: "did:key:zsubject1".to_string(),
            credential_type: "Membership".to_string(),
            fidelity_score: None,
            expiration_date: None,
            raw_payload: r#"{"@context":["https://www.w3.org/2018/credentials/v1"],"id":"vc-002","type":["VerifiableCredential","Membership"],"issuer":"did:key:zissuer2","issuanceDate":"2025-03-15T00:00:00Z","credentialSubject":{"id":"did:key:zsubject1","memberSince":"2025"}}"#.to_string(),
        };

        // Add a second profile and push credentials to both
        let _p2 = add_profile(&mut vault, "alt".to_string(), "Alt Persona".to_string())
            .expect("Should add profile");

        vault.profiles[0].credentials.push(cred1.clone());
        vault.profiles[0].credentials.push(cred2.clone());

        save_vault_inner(&path, &vault).expect("Should save vault with credentials");

        // Reload and verify fields
        let mut loaded = load_vault_from_path(&path).expect("Should reload vault");
        let primary = &loaded.profiles[0];
        assert_eq!(primary.credentials.len(), 2);

        let c1 = &primary.credentials[0];
        assert_eq!(c1.vc_id, "vc-001");
        assert_eq!(c1.issuer_did, "did:key:zissuer1");
        assert_eq!(c1.subject_did, "did:key:zsubject1");
        assert_eq!(c1.credential_type, "UniversityDegree");
        assert_eq!(c1.fidelity_score, Some(0.95));
        assert_eq!(
            c1.expiration_date,
            Some("2027-06-01T00:00:00Z".to_string())
        );
        assert!(c1.raw_payload.contains("vc-001"));

        let c2 = &primary.credentials[1];
        assert_eq!(c2.vc_id, "vc-002");
        assert!(c2.fidelity_score.is_none());
        assert!(c2.expiration_date.is_none());
        assert_eq!(c2.credential_type, "Membership");

        // Verify alt profile has empty credentials
        assert!(loaded.profiles[2].credentials.is_empty());

        // --- Upsert: replace existing vc-001 with updated payload ---
        let cred1_updated = VaultCredential {
            vc_id: "vc-001".to_string(),
            issuer_did: "did:key:zissuer1".to_string(),
            subject_did: "did:key:zsubject1".to_string(),
            credential_type: "UniversityDegree".to_string(),
            fidelity_score: Some(0.98),
            expiration_date: Some("2028-06-01T00:00:00Z".to_string()),
            raw_payload: r#"{"@context":["https://www.w3.org/2018/credentials/v1"],"id":"vc-001","type":["VerifiableCredential","UniversityDegree"],"issuer":"did:key:zissuer1","issuanceDate":"2025-06-01T00:00:00Z","credentialSubject":{"id":"did:key:zsubject1","degree":"MSc"}}"#.to_string(),
        };

        if let Some(existing) = loaded.profiles[0]
            .credentials
            .iter_mut()
            .find(|c| c.vc_id == "vc-001")
        {
            *existing = cred1_updated;
        }

        save_vault_inner(&path, &loaded).expect("Should save after upsert");
        let reloaded = load_vault_from_path(&path).expect("Should reload after upsert");

        // Length should still be 2 (replaced, not appended)
        assert_eq!(reloaded.profiles[0].credentials.len(), 2);
        let replaced = &reloaded.profiles[0].credentials[0];
        assert_eq!(replaced.vc_id, "vc-001");
        assert_eq!(replaced.fidelity_score, Some(0.98));
        assert_eq!(
            replaced.expiration_date,
            Some("2028-06-01T00:00:00Z".to_string())
        );

        // --- Push a new unique credential ---
        let cred3 = VaultCredential {
            vc_id: "vc-003".to_string(),
            issuer_did: "did:key:zissuer3".to_string(),
            subject_did: "did:key:zsubject2".to_string(),
            credential_type: "Badge".to_string(),
            fidelity_score: None,
            expiration_date: None,
            raw_payload: r#"{"@context":["https://www.w3.org/2018/credentials/v1"],"id":"vc-003","type":["VerifiableCredential","Badge"],"issuer":"did:key:zissuer3","credentialSubject":{"id":"did:key:zsubject2","badge":"Contributor"}}"#.to_string(),
        };

        // Reload fresh from disk to test append
        let mut final_vault = load_vault_from_path(&path).expect("Should reload");
        final_vault.profiles[0].credentials.push(cred3);
        save_vault_inner(&path, &final_vault).expect("Should save after append");
        let final_loaded = load_vault_from_path(&path).expect("Should reload final");

        assert_eq!(final_loaded.profiles[0].credentials.len(), 3);
        assert_eq!(final_loaded.profiles[0].credentials[2].vc_id, "vc-003");

        // --- Zero regression: key derivation still works ---
        let kp = get_profile_keypair(&final_loaded, DEFAULT_PERSONA_PROFILE_ID)
            .expect("Key derivation should still work");
        assert_eq!(kp.did, final_loaded.profiles[1].did);
        let kp2 = get_profile_keypair(&final_loaded, "")
            .expect("Empty profile_id should default to public persona");
        assert_eq!(kp2.did, kp.did);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_legacy_vault_without_credentials_defaults_to_empty() {
        let mut path = temp_dir();
        path.push("test_vault_legacy.json");

        let _vault = create_vault_at_path(&path).expect("Should create vault");

        let raw_json = {
            let encrypted = std::fs::read_to_string(&path).expect("Should read");
            let decoded =
                base64::Engine::decode(&base64, encrypted.trim()).expect("Should decode");
            String::from_utf8(decoded).expect("Should be UTF-8")
        };

        let legacy: serde_json::Value =
            serde_json::from_str(&raw_json).expect("Should parse");
        let profile0 = &legacy["profiles"][0];
        assert!(
            profile0.get("credentials").is_some(),
            "New serialization must include credentials field"
        );
        assert!(
            profile0.get("level").is_some() && profile0.get("is_system_reserved").is_some(),
            "New serialization must include hierarchy fields"
        );
        assert_eq!(profile0["level"], 0);
        assert_eq!(profile0["is_system_reserved"], true);
        assert_eq!(legacy["profiles"][1]["level"], 1);
        assert_eq!(legacy["profiles"][1]["is_system_reserved"], false);

        let _ = std::fs::remove_file(&path);
    }

    // ---------- Merkle root tests ----------

    #[test]
    fn test_merkle_root_two_records_deterministic() {
        let records = vec![
            VoteRecord {
                poll_id: "poll_abc".into(),
                option_id: "opt_1".into(),
                client_signature: "abcd1234".into(),
                voter_did: "did:key:zabc".into(),
                network_timestamp: 1000,
            },
            VoteRecord {
                poll_id: "poll_abc".into(),
                option_id: "opt_2".into(),
                client_signature: "deadbeef".into(),
                voter_did: "did:key:zdef".into(),
                network_timestamp: 1001,
            },
        ];

        let root1 = calculate_vote_merkle_root(&records);
        let root2 = calculate_vote_merkle_root(&records);

        assert_eq!(root1, root2, "Merkle root must be deterministic");
        assert_eq!(root1.len(), 64, "Merkle root must be 64 hex chars (SHA-256)");
    }

    #[test]
    fn test_merkle_root_single_record() {
        let records = vec![VoteRecord {
            poll_id: "poll_single".into(),
            option_id: "opt_1".into(),
            client_signature: "ffeeddcc".into(),
            voter_did: "did:key:zsingle".into(),
            network_timestamp: 2000,
        }];

        let root = calculate_vote_merkle_root(&records);

        // Single leaf: root = SHA-256(0x00 || signature_bytes)
        let sig_bytes = hex::decode("ffeeddcc").unwrap();
        let mut hasher = Sha256::new();
        hasher.update([0x00]);
        hasher.update(&sig_bytes);
        let expected = hex::encode(hasher.finalize());

        assert_eq!(root, expected, "Single-record Merkle root must equal the leaf hash");
    }

    #[test]
    fn test_merkle_root_changing_signature_changes_root() {
        let mut a = vec![VoteRecord {
            poll_id: "poll_x".into(),
            option_id: "opt_1".into(),
            client_signature: "11111111".into(),
            voter_did: "did:key:za".into(),
            network_timestamp: 3000,
        }];
        let root_a = calculate_vote_merkle_root(&a);

        a[0].client_signature = "22222222".into();
        let root_b = calculate_vote_merkle_root(&a);

        assert_ne!(root_a, root_b, "Different signatures must produce different roots");
    }

    #[test]
    fn test_merkle_root_empty_records_returns_empty() {
        let records: Vec<VoteRecord> = vec![];
        let root = calculate_vote_merkle_root(&records);
        assert!(root.is_empty(), "Empty records must produce empty root");
    }

    #[test]
    fn test_merkle_root_three_records_odd_duplication() {
        let records = vec![
            VoteRecord {
                poll_id: "poll_odd".into(),
                option_id: "opt_1".into(),
                client_signature: "aabbccdd".into(),
                voter_did: "did:key:z1".into(),
                network_timestamp: 4000,
            },
            VoteRecord {
                poll_id: "poll_odd".into(),
                option_id: "opt_2".into(),
                client_signature: "eeff0011".into(),
                voter_did: "did:key:z2".into(),
                network_timestamp: 4001,
            },
            VoteRecord {
                poll_id: "poll_odd".into(),
                option_id: "opt_3".into(),
                client_signature: "22334455".into(),
                voter_did: "did:key:z3".into(),
                network_timestamp: 4002,
            },
        ];

        let root = calculate_vote_merkle_root(&records);
        assert_eq!(root.len(), 64, "Three records must still produce 64-char hex root");
        assert!(root.chars().all(|c| c.is_ascii_hexdigit()), "Root must be valid hex");
    }

    // ---------- LocalPoll Timeline Validation ----------

    fn make_poll(starts_at: u64, ends_at: u64, is_ongoing: bool) -> LocalPoll {
        LocalPoll {
            poll_id: "test_poll".into(),
            title: "Test Poll".into(),
            poll_type: "public".into(),
            starts_at,
            ends_at,
            is_ongoing,
        }
    }

    #[test]
    fn test_vote_before_starts_at_rejected() {
        let poll = make_poll(100, 200, false);
        let result = poll.validate_vote_timeline(50);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not initialized"));
    }

    #[test]
    fn test_vote_after_ends_at_rejected() {
        let poll = make_poll(100, 200, false);
        let result = poll.validate_vote_timeline(250);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("closed/locked"));
    }

    #[test]
    fn test_vote_within_window_accepted() {
        let poll = make_poll(100, 200, false);
        assert!(poll.validate_vote_timeline(150).is_ok());
        assert!(poll.validate_vote_timeline(100).is_ok());
        assert!(poll.validate_vote_timeline(200).is_ok());
    }

    #[test]
    fn test_is_ongoing_permits_out_of_bounds() {
        let poll = make_poll(100, 200, true);
        assert!(poll.validate_vote_timeline(50).is_ok());
        assert!(poll.validate_vote_timeline(250).is_ok());
        assert!(poll.validate_vote_timeline(9999999).is_ok());
    }
}
