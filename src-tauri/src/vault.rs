use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct IdentityStore {
    pub did: String,
    // In a production app, this should be strongly encrypted via AEAD (e.g., aes-gcm)
    // using a user-provided passphrase or OS Keychain. For this prototype, we store it directly,
    // but the architecture ensures it never leaves the Rust backend.
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
    let store = IdentityStore {
        did,
        private_key_base58,
    };

    let path = get_storage_path(app);

    // Ensure directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create vault directory: {}", e))?;
    }

    let json = serde_json::to_string(&store).map_err(|e| format!("Serialization error: {}", e))?;

    // TODO: Add actual AEAD encryption here before writing to disk
    fs::write(&path, json).map_err(|e| format!("Failed to write to vault: {}", e))?;

    Ok(())
}

pub fn load_identity(app: &AppHandle) -> Result<IdentityStore, String> {
    let path = get_storage_path(app);

    if !path.exists() {
        return Err("No identity found in vault".to_string());
    }

    let json = fs::read_to_string(&path).map_err(|e| format!("Failed to read vault: {}", e))?;

    // TODO: Add actual AEAD decryption here after reading from disk
    let store: IdentityStore =
        serde_json::from_str(&json).map_err(|e| format!("Deserialization error: {}", e))?;

    Ok(store)
}
