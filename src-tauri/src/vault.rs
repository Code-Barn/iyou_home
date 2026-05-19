/*
 * Copyright (C) 2026 Byers Brands, LLC
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

pub fn derive_deterministic_keypair(
    root_seed: &[u8],
    derivation_index: u32,
) -> DerivedKeypair {
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

    let encrypted =
        fs::read_to_string(path).map_err(|e| format!("Failed to read vault: {}", e))?;
    let decoded = base64
        .decode(encrypted.trim())
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let json =
        String::from_utf8(decoded).map_err(|e| format!("UTF-8 error: {}", e))?;

    serde_json::from_str::<VaultStore>(&json)
        .map_err(|e| format!("Failed to parse vault: {}", e))
}

fn save_vault_inner(path: &Path, vault: &VaultStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create vault directory: {}", e))?;
    }

    let json =
        serde_json::to_string(vault).map_err(|e| format!("Serialization error: {}", e))?;
    let encrypted = base64.encode(json);
    fs::write(path, encrypted).map_err(|e| format!("Failed to write vault: {}", e))?;
    Ok(())
}

pub fn save_vault(app: &AppHandle, vault: &VaultStore) -> Result<(), String> {
    save_vault_inner(&get_storage_path(app), vault)
}

pub fn get_profile_by_id<'a>(
    vault: &'a VaultStore,
    profile_id: &str,
) -> Option<&'a Profile> {
    if profile_id.is_empty() {
        vault.profiles.first()
    } else {
        vault.profiles.iter().find(|p| p.profile_id == profile_id)
    }
}

pub fn get_profile_keypair(
    vault: &VaultStore,
    profile_id: &str,
) -> Result<DerivedKeypair, String> {
    let profile = get_profile_by_id(vault, profile_id)
        .ok_or_else(|| format!("Profile not found: '{}'", profile_id))?;

    let seed = bs58::decode(&vault.root_seed_base58)
        .into_vec()
        .map_err(|_| "Invalid root seed encoding".to_string())?;

    Ok(derive_deterministic_keypair(&seed, profile.derivation_index))
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
        assert_eq!(
            kp1.signing_key.to_bytes(),
            kp2.signing_key.to_bytes()
        );
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
}
