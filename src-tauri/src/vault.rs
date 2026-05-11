use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct IdentityStore {
    pub did: String,
    // In a production app, this should be strongly encrypted via AEAD (e.g., aes-gcm)
    // using a user-provided passphrase or OS Keychain.
    pub private_key_base58: String,
}

fn get_storage_path(app: &AppHandle) -> PathBuf {
    // Uses the OS-specific local app data directory
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("vault.json");
    path
}

pub fn save_identity(
    app: &AppHandle,
    did: String,
    private_key_base58: String,
) -> Result<(), String> {
    save_identity_to_path(&get_storage_path(app), did, private_key_base58)
}

pub fn load_identity(app: &AppHandle) -> Result<IdentityStore, String> {
    load_identity_from_path(&get_storage_path(app))
}

// Logic separated from AppHandle for testing
pub fn save_identity_to_path(
    path: &Path,
    did: String,
    private_key_base58: String,
) -> Result<(), String> {
    let store = IdentityStore {
        did,
        private_key_base58,
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create vault directory: {}", e))?;
    }

    let json = serde_json::to_string(&store).map_err(|e| format!("Serialization error: {}", e))?;

    // Use base64 as a simple mock for encryption to ensure the file isn't plaintext JSON
    let encrypted = base64.encode(json);
    fs::write(path, encrypted).map_err(|e| format!("Failed to write to vault: {}", e))?;

    Ok(())
}

pub fn load_identity_from_path(path: &Path) -> Result<IdentityStore, String> {
    if !path.exists() {
        return Err("No identity found in vault".to_string());
    }

    let encrypted = fs::read_to_string(path).map_err(|e| format!("Failed to read vault: {}", e))?;

    let decoded_bytes = base64
        .decode(encrypted)
        .map_err(|e| format!("Decryption (decode) error: {}", e))?;
    let json = String::from_utf8(decoded_bytes).map_err(|e| format!("UTF8 error: {}", e))?;

    let store: IdentityStore =
        serde_json::from_str(&json).map_err(|e| format!("Deserialization error: {}", e))?;

    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    #[test]
    fn test_vault_encryption_decryption() {
        let mut path = temp_dir();
        path.push("test_vault.json");

        let did = "did:key:z6MkhaXgBZDvotDkL5257faiztiuC2ZXPu25YpPt729Vz9sU".to_string();
        let priv_key = "SecretKeyBase58Placeholder".to_string();

        // 1. Save identity
        save_identity_to_path(&path, did.clone(), priv_key.clone()).expect("Should save identity");

        // 2. Verify it is NOT plaintext JSON
        let raw_file_content = fs::read_to_string(&path).expect("Should read file");
        assert!(!raw_file_content.contains("did:key"));
        assert!(!raw_file_content.contains("SecretKeyBase58Placeholder"));

        // 3. Load identity and verify values
        let loaded = load_identity_from_path(&path).expect("Should load identity");
        assert_eq!(loaded.did, did);
        assert_eq!(loaded.private_key_base58, priv_key);

        // Cleanup
        let _ = fs::remove_file(path);
    }
}
