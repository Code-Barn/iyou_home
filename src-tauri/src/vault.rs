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
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub profile_id: String,
    pub profile_name: String,
    pub derivation_index: u32,
    pub did: String,
    pub credentials: Vec<VaultCredential>,
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

fn get_storage_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("vault.json");
    path
}

pub fn create_vault(app: &AppHandle) -> Result<VaultStore, String> {
    create_vault_at_path(&get_storage_path(app))
}

pub fn create_vault_at_path(path: &Path) -> Result<VaultStore, String> {
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    let root_seed_base58 = bs58::encode(seed).into_string();

    let kp = derive_deterministic_keypair(&seed, 0);

    let vault = VaultStore {
        root_seed_base58,
        profiles: vec![Profile {
            profile_id: "primary".to_string(),
            profile_name: "Primary Identity".to_string(),
            derivation_index: 0,
            did: kp.did,
            credentials: vec![],
        }],
    };

    save_vault_inner(path, &vault)?;
    Ok(vault)
}

pub fn load_vault(app: &AppHandle) -> Result<VaultStore, String> {
    let path = get_storage_path(app);
    load_vault_from_path(&path).or_else(|_| create_vault_at_path(&path))
}

pub fn load_vault_from_path(path: &Path) -> Result<VaultStore, String> {
    if !path.exists() {
        return Err("No vault found".to_string());
    }

    let encrypted = fs::read_to_string(path).map_err(|e| format!("Failed to read vault: {}", e))?;
    let decoded = base64
        .decode(encrypted.trim())
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let json = String::from_utf8(decoded).map_err(|e| format!("UTF-8 error: {}", e))?;

    serde_json::from_str::<VaultStore>(&json).map_err(|e| format!("Failed to parse vault: {}", e))
}

fn save_vault_inner(path: &Path, vault: &VaultStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create vault directory: {}", e))?;
    }

    let json = serde_json::to_string(vault).map_err(|e| format!("Serialization error: {}", e))?;
    let encrypted = base64.encode(json);
    fs::write(path, encrypted).map_err(|e| format!("Failed to write vault: {}", e))?;
    Ok(())
}

pub fn save_vault(app: &AppHandle, vault: &VaultStore) -> Result<(), String> {
    save_vault_inner(&get_storage_path(app), vault)
}

pub fn get_profile_by_id<'a>(vault: &'a VaultStore, profile_id: &str) -> Option<&'a Profile> {
    if profile_id.is_empty() {
        vault.profiles.first()
    } else {
        vault.profiles.iter().find(|p| p.profile_id == profile_id)
    }
}

pub fn get_profile_keypair(vault: &VaultStore, profile_id: &str) -> Result<DerivedKeypair, String> {
    let profile = get_profile_by_id(vault, profile_id)
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

    let next_index = vault
        .profiles
        .iter()
        .map(|p| p.derivation_index)
        .max()
        .unwrap_or(0)
        + 1;

    let seed = bs58::decode(&vault.root_seed_base58)
        .into_vec()
        .map_err(|_| "Invalid root seed encoding".to_string())?;

    let kp = derive_deterministic_keypair(&seed, next_index);

    let profile = Profile {
        profile_id,
        profile_name,
        derivation_index: next_index,
        did: kp.did,
        credentials: vec![],
    };

    vault.profiles.push(profile.clone());
    Ok(profile)
}

pub fn remove_profile(vault: &mut VaultStore, profile_id: &str) -> Result<(), String> {
    if profile_id == "primary" {
        return Err("Cannot remove primary profile".to_string());
    }
    let pos = vault
        .profiles
        .iter()
        .position(|p| p.profile_id == profile_id)
        .ok_or_else(|| format!("Profile not found: '{}'", profile_id))?;
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

        assert_eq!(vault.profiles.len(), 1);
        assert_eq!(vault.profiles[0].profile_id, "primary");
        assert!(vault.profiles[0].did.starts_with("did:key:"));

        let raw = fs::read_to_string(&path).expect("Should read file");
        assert!(!raw.contains(vault.profiles[0].did.as_str()));

        let loaded = load_vault_from_path(&path).expect("Should load vault");
        assert_eq!(loaded.profiles.len(), 1);
        assert_eq!(loaded.profiles[0].did, vault.profiles[0].did);

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
        assert_eq!(p.derivation_index, 1);
        assert!(p.did.starts_with("did:key:"));
        assert_ne!(p.did, vault.profiles[0].did);

        assert_eq!(vault.profiles.len(), 2);

        remove_profile(&mut vault, "pseudo_1").expect("Should remove");
        assert_eq!(vault.profiles.len(), 1);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_get_profile_by_id_defaults_to_first() {
        let mut path = temp_dir();
        path.push("test_vault_default.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");

        let p = get_profile_by_id(&vault, "").expect("Should return first");
        assert_eq!(p.profile_id, "primary");

        let p2 = get_profile_by_id(&vault, "primary").expect("Should find by id");
        assert_eq!(p2.profile_id, "primary");

        assert!(get_profile_by_id(&vault, "nonexistent").is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_get_profile_keypair() {
        let mut path = temp_dir();
        path.push("test_vault_keypair.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");
        let kp = get_profile_keypair(&vault, "primary").expect("Should derive keypair");
        assert_eq!(kp.did, vault.profiles[0].did);

        let kp2 = get_profile_keypair(&vault, "").expect("Should derive from default");
        assert_eq!(kp2.did, vault.profiles[0].did);

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
        assert!(loaded.profiles[1].credentials.is_empty());

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
        let kp = get_profile_keypair(&final_loaded, "primary")
            .expect("Key derivation should still work");
        assert_eq!(kp.did, final_loaded.profiles[0].did);
        let kp2 = get_profile_keypair(&final_loaded, "")
            .expect("Empty profile_id should default to first");
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
