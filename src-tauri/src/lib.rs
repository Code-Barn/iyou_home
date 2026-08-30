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


use chrono::{DateTime, Utc};
use ed25519_dalek::Signer;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;
use x25519_dalek::StaticSecret;
use zeroize::Zeroizing;
mod blossom;
mod bridge;
mod certs;
mod contacts;
mod nostr_relay;
mod omemo;
mod pairing;
mod prosody;
mod tray;
mod vault;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceStatus {
    Running,
    Stopped,
    Starting,
}

pub struct ServiceState {
    pub services: Mutex<HashMap<String, ServiceStatus>>,
    pub active_did: Mutex<Option<String>>,
    pub shutdown_signals: Mutex<HashMap<String, watch::Sender<bool>>>,
    pub auto_start_settings: Mutex<HashMap<String, bool>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct UserPreferences {
    pub active_profile_id: String,
    pub default_signing_profile: String,
    pub auto_sign: bool,
    pub last_active_tab: String,
    /// Set when a graduated sovereign identity is the active signer. Takes
    /// precedence over `active_profile_id` during DID resolution.
    #[serde(default)]
    pub active_sovereign_did: Option<String>,
    /// Unix timestamp of the last successful Sync-to-Home operation.
    #[serde(default)]
    pub last_synced_at: u64,
    /// True once the user has completed the first-run master seed backup
    /// ceremony. Defaults to false on a fresh vault so the dashboard stays
    /// gated until the seed is verified.
    #[serde(default)]
    pub seed_backup_confirmed: bool,
    /// Whether the OS biometric / PIN app-lock screen guard is enabled.
    #[serde(default)]
    pub app_lock_enabled: bool,
    /// Inactivity auto-lock timeout in minutes (5, 15, 60, or 0 = disabled).
    #[serde(default)]
    pub inactivity_timeout_minutes: u32,
    /// SHA-256 of the local 6-digit PIN, never the PIN itself.
    #[serde(default)]
    pub app_lock_pin_hash: Option<String>,
    /// SHA-256 of the WebAuthn PRF seed hex, never the PRF seed itself.
    #[serde(default)]
    pub app_lock_prf_hash: Option<String>,
    /// Unix timestamp of the last exported encrypted vault backup.
    #[serde(default)]
    pub last_backup_at: u64,
    /// List of configured public Nostr relays for the gossip mesh.
    #[serde(default = "default_relay_mesh")]
    pub relay_mesh: Vec<String>,
}

pub fn default_relay_mesh() -> Vec<String> {
    vec![
        "wss://relay.iyou.me".to_string(),
        "wss://nos.lol".to_string(),
        "wss://relay.damus.io".to_string(),
    ]
}

impl Default for UserPreferences {
    fn default() -> Self {
        Self {
            active_profile_id: vault::DEFAULT_PERSONA_PROFILE_ID.to_string(),
            default_signing_profile: vault::DEFAULT_PERSONA_PROFILE_ID.to_string(),
            auto_sign: false,
            last_active_tab: "services".to_string(),
            active_sovereign_did: None,
            last_synced_at: 0,
            seed_backup_confirmed: false,
            app_lock_enabled: false,
            inactivity_timeout_minutes: 15,
            app_lock_pin_hash: None,
            app_lock_prf_hash: None,
            last_backup_at: 0,
            relay_mesh: default_relay_mesh(),
        }
    }
}

pub struct WsState {
    pub response_sender: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    pub challenge_channel: Mutex<Option<tauri::ipc::Channel<String>>>,
    pub pending_messages: Mutex<Vec<String>>,
    pub popup_active: Mutex<bool>,
}

/// Short-lived cache for the graduation transit handshake. The client's
/// ephemeral X25519 scalar lives here only between `generate_transit_keypair`
/// and `process_graduation_ingest`; it is taken (removed) on use and wrapped
/// in `Zeroizing` so it is wiped from memory when dropped. It never crosses
/// back over the IPC boundary.
pub struct TransitState {
    pub client_ephemeral_priv: Mutex<Option<Zeroizing<[u8; 32]>>>,
}

impl Default for TransitState {
    fn default() -> Self {
        Self {
            client_ephemeral_priv: Mutex::new(None),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DerivedIdentityPublic {
    pub did: String,
    pub nostr_pubkey_hex: String,
}

#[derive(Debug, Serialize)]
pub struct TransitKeypairPublic {
    pub client_ephemeral_pub_hex: String,
}

#[derive(Debug, Serialize)]
pub struct GraduationConfirmPayload {
    pub receipt: serde_json::Value,
    pub signature: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncSummary {
    pub events_ingested: usize,
    pub blobs_mirrored: usize,
    pub last_synced_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncStatus {
    pub last_synced_at: u64,
    pub local_notes_count: usize,
    pub local_blobs_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalBlobInfo {
    pub sha256: String,
    pub size_bytes: u64,
    pub mime_type: String,
    pub created_at: u64,
}

impl Default for WsState {
    fn default() -> Self {
        Self {
            response_sender: Mutex::new(None),
            challenge_channel: Mutex::new(None),
            pending_messages: Mutex::new(Vec::new()),
            popup_active: Mutex::new(false),
        }
    }
}

// ---------- signing helpers ----------

fn sign_challenge_with_keypair(
    signing_key: &ed25519_dalek::SigningKey,
    did: &str,
    challenge: &str,
) -> Result<String, String> {
    let presentation = serde_json::json!({
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "type": ["VerifiablePresentation"],
        "holder": did,
        "challenge": challenge,
        "verifiableCredential": []
    });
    let vp_json = presentation.to_string();
    let key_b58 = bs58::encode(signing_key.to_bytes()).into_string();
    did_rust::issue_vc(&vp_json, did, &key_b58)
        .map_err(|e| format!("Failed to sign presentation: {}", e))
}

pub fn sign_omni_payload(
    app: &AppHandle,
    payload: &serde_json::Value,
    profile_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let poll_id = payload["poll_id"]
        .as_str()
        .ok_or("Missing poll_id")?
        .to_string();
    let option_id = payload["option_id"]
        .as_str()
        .ok_or("Missing option_id")?
        .to_string();
    let _ts = payload["timestamp"]
        .as_i64()
        .ok_or("Missing or invalid timestamp")?;

    let (signing_key, did) = resolve_profile_keypair(app, profile_id)?;

    // Canonicalize: BTreeMap guarantees alphabetical key order, serde_json::to_string gives zero spacing
    let canonical_map: BTreeMap<String, serde_json::Value> =
        serde_json::from_value(serde_json::json!({
            "option_id": option_id,
            "poll_id": poll_id,
            "timestamp": _ts,
        }))
        .map_err(|_| "Failed to canonicalize payload")?;
    let canonical_str = serde_json::to_string(&canonical_map)
        .map_err(|_| "Failed to serialize canonical payload")?;

    // SHA-256 of canonical payload, then Ed25519 sign
    let payload_hash = Sha256::digest(canonical_str.as_bytes());
    let signature = signing_key.sign(&payload_hash);
    let sig_hex = hex::encode(signature.to_bytes());

    // id = SHA-256(canonical payload)
    let id_hex = hex::encode(payload_hash);

    // pubkey as lowercase hex
    let pubkey_hex = hex::encode(signing_key.verifying_key().to_bytes());

    // created_at = current wall-clock UNIX epoch
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Time went backwards")?
        .as_secs() as i64;

    let tags: Vec<serde_json::Value> = vec![
        serde_json::json!(["poll", poll_id]),
        serde_json::json!(["p", did]),
    ];

    let envelope = serde_json::json!({
        "kind": 1112,
        "pubkey": pubkey_hex,
        "created_at": created_at,
        "tags": tags,
        "content": canonical_str,
        "id": id_hex,
        "sig": sig_hex,
    });

    Ok(envelope)
}

fn resolve_profile_keypair(
    app: &AppHandle,
    profile_id: Option<String>,
) -> Result<(ed25519_dalek::SigningKey, String), String> {
    let vault = vault::load_vault(app)?;
    let pid = profile_id.unwrap_or_default();
    let kp = vault::get_profile_keypair(&vault, &pid)?;
    Ok((kp.signing_key, kp.did))
}

// ---------- existing commands ----------

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn toggle_service(
    name: String,
    action: String,
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<ServiceStatus, String> {
    let status = toggle_service_logic(name.clone(), action.clone(), &state)?;

    match action.as_str() {
        "start" => start_service_internal(&name, &app, &state).await?,
        "stop" => stop_service_internal(&name, &state),
        _ => {}
    }

    Ok(status)
}

fn toggle_service_logic(
    name: String,
    action: String,
    state: &ServiceState,
) -> Result<ServiceStatus, String> {
    let mut services = state.services.lock().unwrap();
    let status = services
        .entry(name.clone())
        .or_insert(ServiceStatus::Stopped);

    match action.as_str() {
        "start" => {
            *status = ServiceStatus::Running;
        }
        "stop" => {
            *status = ServiceStatus::Stopped;
        }
        _ => return Err("Invalid action".to_string()),
    }
    Ok(status.clone())
}

async fn start_service_internal(
    name: &str,
    app: &AppHandle,
    state: &ServiceState,
) -> Result<(), String> {
    {
        let shutdown_signals = state.shutdown_signals.lock().unwrap();
        if shutdown_signals.contains_key(name) {
            return Err("Service already running".to_string());
        }
    }

    let tx = match name {
        "Nostr" => {
            let app_data = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?;
            // Self-healing loader: provisions the missing Level 1 persona on
            // legacy single-profile vaults before relay identity resolution.
            let vault = match vault::load_or_bootstrap_vault(app) {
                Ok(v) => v,
                // Fresh install: defer identity creation to onboarding
                // (generate_did) instead of failing auto-start.
                Err(vault::VaultLoadError::NotFound) => {
                    eprintln!("Nostr relay deferred: vault not yet provisioned (onboarding pending)");
                    return Ok(());
                }
                Err(e) => return Err(e.to_string()),
            };
            let kp = vault::get_profile_keypair(&vault, "")?;
            let pubkey = nostr_relay::derive_vault_pubkey_from_verifying(&kp.verifying_key)?;
            let db_path = app_data.join("nostr_events.db");
            let listener = TcpListener::bind("127.0.0.1:9003")
                .await
                .map_err(|e| format!("Failed to bind Nostr relay: {}", e))?;
            let (tx, rx) = watch::channel(false);
            tauri::async_runtime::spawn(async move {
                nostr_relay::start_relay(db_path, listener, rx, pubkey).await;
            });
            tx
        }
        "Blossom" => {
            let app_data = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?;
            let blobs_dir = app_data.join("blobs");
            std::fs::create_dir_all(&blobs_dir)
                .map_err(|e| format!("Failed to create blobs directory: {}", e))?;
            let (tx, rx) = watch::channel(false);
            tauri::async_runtime::spawn(async move {
                blossom::start_blossom_server(blobs_dir, rx).await;
            });
            tx
        }
        "Chat" => {
            let app_data = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?;
            let pass_file = app_data.join("xmpp_password.txt");
            let password = if pass_file.exists() {
                std::fs::read_to_string(&pass_file)
                    .map_err(|e| format!("Failed to read password: {}", e))?
            } else {
                let pwd = prosody::generate_password();
                std::fs::write(&pass_file, &pwd)
                    .map_err(|e| format!("Failed to save password: {}", e))?;
                pwd
            };
            let listener = TcpListener::bind("127.0.0.1:5222")
                .await
                .map_err(|e| format!("Failed to bind XMPP: {}", e))?;
            let (tx, rx) = watch::channel(false);
            tauri::async_runtime::spawn(async move {
                prosody::start_xmpp_server(listener, rx, password, app_data.join("certs")).await;
            });
            tx
        }
        _ => return Ok(()),
    };

    state
        .services
        .lock()
        .unwrap()
        .insert(name.to_string(), ServiceStatus::Running);
    state
        .shutdown_signals
        .lock()
        .unwrap()
        .insert(name.to_string(), tx);
    Ok(())
}

fn stop_service_internal(name: &str, state: &ServiceState) {
    let mut shutdown_signals = state.shutdown_signals.lock().unwrap();
    if let Some(tx) = shutdown_signals.remove(name) {
        let _ = tx.send(true);
    }
    state
        .services
        .lock()
        .unwrap()
        .insert(name.to_string(), ServiceStatus::Stopped);
}

#[tauri::command]
fn get_service_statuses(state: State<'_, ServiceState>) -> HashMap<String, ServiceStatus> {
    state.services.lock().unwrap().clone()
}

#[tauri::command]
fn generate_did(app: AppHandle, state: State<'_, ServiceState>) -> Result<String, String> {
    // Bootstrap is legitimate here: this is the first-run onboarding entry
    // point. Corruption is surfaced, never silently regenerated.
    let vault = vault::load_or_bootstrap_vault(&app).map_err(|e| e.to_string())?;

    let did = vault
        .public_persona()
        .ok_or("No public persona found in vault")?
        .did
        .clone();
    let mut active = state.active_did.lock().unwrap();
    *active = Some(did.clone());
    Ok(did)
}

#[tauri::command]
fn import_did(
    app: AppHandle,
    did: String,
    private_key: String,
    state: State<'_, ServiceState>,
) -> Result<(), String> {
    let mut vault = match vault::load_vault(&app) {
        Ok(v) => v,
        // Only a genuinely missing vault may be seeded from the imported key.
        Err(vault::VaultLoadError::NotFound) => {
            let seed = bs58::decode(&private_key)
                .into_vec()
                .map_err(|_| "Invalid base58 private key".to_string())?;
            let mut arr = [0u8; 32];
            if seed.len() != 32 {
                return Err("Private key must be 32 bytes".to_string());
            }
            arr.copy_from_slice(&seed);
            vault::VaultStore {
                root_seed_base58: bs58::encode(arr).into_string(),
                profiles: vault::initial_profiles(&arr),
                sovereign_identities: Vec::new(),
            }
        }
        Err(e) => return Err(e.to_string()),
    };

    if vault.get_profile_by_id(&did).is_none() {
        let profile = vault::add_profile(
            &mut vault,
            format!("imported_{}", did.chars().take(8).collect::<String>()),
            "Imported Identity".to_string(),
        )?;
        vault::save_vault(&app, &vault)?;
        let mut active = state.active_did.lock().unwrap();
        *active = Some(profile.did);
    } else {
        let mut active = state.active_did.lock().unwrap();
        *active = Some(did);
    }

    Ok(())
}

#[tauri::command]
fn get_active_did(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<Option<String>, String> {
    {
        let active = state.active_did.lock().unwrap();
        if let Some(did) = active.clone() {
            return Ok(Some(did));
        }
    }

    // Try to load preferences and find the active profile
    let prefs = load_preferences(&app);
    match vault::load_vault(&app) {
        Ok(vault) => {
            // A graduated sovereign identity outranks derived personas when
            // the user has claimed custody.
            if let Some(sovereign_did) = &prefs.active_sovereign_did {
                if vault::get_sovereign_identity(&vault, sovereign_did).is_some() {
                    let mut active = state.active_did.lock().unwrap();
                    *active = Some(sovereign_did.clone());
                    return Ok(Some(sovereign_did.clone()));
                }
            }
            if let Some(profile) = vault
                .get_profile_by_id(&prefs.active_profile_id)
                .filter(|p| !p.is_anchor())
            {
                let mut active = state.active_did.lock().unwrap();
                *active = Some(profile.did.clone());
                return Ok(Some(profile.did.clone()));
            }
            // Fallback to the public persona (Level 1) if preferred profile not found
            if let Some(profile) = vault.public_persona() {
                let mut active = state.active_did.lock().unwrap();
                *active = Some(profile.did.clone());
                return Ok(Some(profile.did.clone()));
            }
            Ok(None)
        }
        // First-run: no vault yet is a normal empty state, not an error.
        Err(vault::VaultLoadError::NotFound) => Ok(None),
        // Corruption/IO faults must surface, never masquerade as "no DID".
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn list_profiles(app: AppHandle) -> Result<Vec<vault::Profile>, String> {
    let vault = vault::load_vault(&app)?;
    Ok(vault::list_profiles(&vault))
}

#[tauri::command]
fn add_profile(
    app: AppHandle,
    profile_name: String,
    state: State<'_, ServiceState>,
) -> Result<vault::Profile, String> {
    let mut vault = vault::load_vault(&app)?;
    let profile_id = profile_name
        .to_lowercase()
        .replace(char::is_whitespace, "_")
        .replace(|c: char| !c.is_alphanumeric() && c != '_', "");
    let profile = vault::add_profile(&mut vault, profile_id, profile_name)?;
    vault::save_vault(&app, &vault)?;
    let mut active = state.active_did.lock().unwrap();
    *active = Some(profile.did.clone());
    Ok(profile)
}

#[tauri::command]
fn set_active_profile(
    app: AppHandle,
    state: State<'_, ServiceState>,
    profile_id: String,
) -> Result<(), String> {
    let vault = vault::load_vault(&app)?;

    // Validate that the profile exists
    let profile = vault
        .get_profile_by_id(&profile_id)
        .ok_or_else(|| format!("Profile '{}' not found", profile_id))?;

    // Update the active DID in memory
    let mut active = state.active_did.lock().unwrap();
    *active = Some(profile.did.clone());

    // Update preferences and save. Selecting a derived persona deactivates
    // any graduated sovereign identity.
    let mut prefs = load_preferences(&app);
    prefs.active_profile_id = profile_id;
    prefs.active_sovereign_did = None;
    save_preferences(&app, &prefs)?;

    Ok(())
}

#[tauri::command]
fn remove_profile(
    app: AppHandle,
    state: State<'_, ServiceState>,
    profile_id: String,
) -> Result<(), String> {
    let mut vault = vault::load_vault(&app)?;

    // Structural deletion guard: system-reserved / Level 0 profiles are
    // protected regardless of their id string.
    if let Some(target) = vault.get_profile_by_id(&profile_id) {
        if target.is_system_reserved || target.level == 0 || target.derivation_index == 0 {
            return Err("Cannot delete system reserved profile".to_string());
        }
    }

    // Check if this is the currently active profile
    let prefs = load_preferences(&app);
    let was_active = prefs.active_profile_id == profile_id;

    // Remove the profile
    vault::remove_profile(&mut vault, &profile_id)?;
    vault::save_vault(&app, &vault)?;

    // If we removed the active profile, reset to the public persona
    if was_active {
        let mut prefs = load_preferences(&app);
        prefs.active_profile_id = vault::DEFAULT_PERSONA_PROFILE_ID.to_string();
        save_preferences(&app, &prefs)?;

        // Update in-memory state
        let mut active = state.active_did.lock().unwrap();
        if let Some(profile) = vault.public_persona() {
            *active = Some(profile.did.clone());
        }
    }

    Ok(())
}

#[tauri::command]
fn sign_auth_challenge(
    app: AppHandle,
    challenge: String,
    did_id: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    let (signing_key, did) = resolve_profile_keypair(&app, profile_id)?;
    if !did_id.is_empty() && did != did_id {
        return Err("Requested DID does not match the active Vault identity".to_string());
    }
    sign_challenge_with_keypair(&signing_key, &did, &challenge)
}

#[tauri::command]
fn get_public_did_document(did: String) -> Result<String, String> {
    did_rust::resolve_did(&did).map_err(|e| format!("Failed to resolve DID document: {}", e))
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn register_challenge_pipe(channel: tauri::ipc::Channel<String>, state: State<'_, WsState>) {
    let pending = state
        .pending_messages
        .lock()
        .unwrap()
        .drain(..)
        .collect::<Vec<_>>();
    *state.challenge_channel.lock().unwrap() = Some(channel.clone());
    let count = pending.len();
    for msg in &pending {
        let _ = channel.send(msg.clone());
    }
    println!(
        "DEBUG: Challenge channel registered by React (flushed {} queued)",
        count
    );
}

#[tauri::command]
async fn submit_ws_response(
    _id: String,
    challenge: String,
    approved: bool,
    app: AppHandle,
    ws_state: State<'_, WsState>,
    profile_id: Option<String>,
) -> Result<(), String> {
    let sender = {
        let guard = ws_state.response_sender.lock().unwrap();
        guard.clone().ok_or("No WebSocket connected")?
    };

    if !approved {
        let _ = sender.send(Message::Text("{\"status\":\"denied\"}".into()));
        println!("WS sign request denied by user");
        return Ok(());
    }

    let (signing_key, did) = resolve_profile_keypair(&app, profile_id)?;
    let signed_vp = sign_challenge_with_keypair(&signing_key, &did, &challenge)?;
    let vp_value: serde_json::Value = serde_json::from_str(&signed_vp)
        .map_err(|e| format!("Failed to parse signed VP as JSON: {}", e))?;

    let response = serde_json::json!({
        "type": "signature",
        "vp": vp_value
    });

    println!("Sending signed VP back to browser");
    let _ = sender.send(Message::Text(response.to_string().into()));
    Ok(())
}

#[tauri::command]
async fn submit_ws_event_response(
    event_json: String,
    approved: bool,
    app: AppHandle,
    ws_state: State<'_, WsState>,
    _profile_id: Option<String>,
) -> Result<(), String> {
    let sender = {
        let guard = ws_state.response_sender.lock().unwrap();
        guard.clone().ok_or("No WebSocket connected")?
    };

    if !approved {
        let _ = sender.send(Message::Text("{\"status\":\"denied\"}".into()));
        println!("WS event sign request denied by user");
        return Ok(());
    }

    let mut event: serde_json::Value = serde_json::from_str(&event_json)
        .map_err(|e| format!("Failed to parse event JSON: {}", e))?;

    let kind = event["kind"].as_i64().unwrap_or(1);
    let pubkey = event["pubkey"].as_str().unwrap_or("").to_string();
    let created_at = event["created_at"].as_i64().unwrap_or(0);
    let tags = event.get("tags").cloned().unwrap_or(serde_json::json!([]));
    let content = event["content"].as_str().unwrap_or("");

    let canonical = serde_json::json!([
        0, pubkey, created_at, kind, tags, content
    ]);
    let canonical_json = serde_json::to_string(&canonical)
        .map_err(|e| format!("Failed to serialize event: {}", e))?;

    // SHA-256 of canonical NIP-01 event array
    let event_hash = Sha256::digest(canonical_json.as_bytes());
    let id_hex = hex::encode(event_hash);

    let event_pubkey = event["pubkey"]
        .as_str()
        .ok_or_else(|| "Missing pubkey field in event".to_string())?
        .to_string();

    let vault = vault::load_vault(&app)?;
    let seed = vault::decode_root_seed(&vault)?;

    // All Nostr events use secp256k1 Schnorr (NIP-01 standard).
    // Find the persona whose secp256k1 pubkey matches the event's pubkey.
    use k256::schnorr::SigningKey as SecpSigningKey;

    let (secp_key, _index) = vault
        .profiles
        .iter()
        .filter_map(|profile| {
            let sk_bytes =
                vault::derive_secp256k1_secret_key(&seed, profile.derivation_index);
            let key = SecpSigningKey::from_bytes(&sk_bytes).ok()?;
            let pubkey_hex = hex::encode(key.verifying_key().to_bytes());
            if pubkey_hex == event_pubkey {
                Some((key, profile.derivation_index))
            } else {
                None
            }
        })
        .next()
        .ok_or_else(|| {
            format!(
                "Persona not found: no secp256k1 keypair matches pubkey `{}`",
                event_pubkey
            )
        })?;

    // sign_raw signs the 32-byte prehash directly (BIP-340 message).
    // DO NOT use sign() here — it applies an extra SHA-256, producing
    // a double-hash that the verifier won't match.
    let schnorr_sig = secp_key
        .sign_raw(&event_hash, &Default::default())
        .map_err(|_| "Schnorr signing failed".to_string())?;
    let sig_hex = hex::encode(schnorr_sig.to_bytes());

    event["id"] = serde_json::Value::String(id_hex);
    event["sig"] = serde_json::Value::String(sig_hex);

    println!(
        "[SIGN_DEBUG] Kind {} signed with secp256k1 pubkey `{}`",
        kind, event_pubkey
    );

    let response = serde_json::json!({
        "type": "signed_event",
        "event": event
    });

    println!("Sending signed Nostr event back to browser");
    let _ = sender.send(Message::Text(response.to_string().into()));
    Ok(())
}

#[tauri::command]
async fn submit_ws_credential_response(
    credential_json: String,
    holder_did: String,
    approved: bool,
    app: AppHandle,
    ws_state: State<'_, WsState>,
    profile_id: Option<String>,
) -> Result<(), String> {
    let sender = {
        let guard = ws_state.response_sender.lock().unwrap();
        guard.clone().ok_or("No WebSocket connected")?
    };

    if !approved {
        let _ = sender.send(Message::Text("{\"status\":\"denied\"}".into()));
        println!("WS credential sign request denied by user");
        return Ok(());
    }

    let (signing_key, did) = resolve_profile_keypair(&app, profile_id)?;

    let credential_value: serde_json::Value = serde_json::from_str(&credential_json)
        .map_err(|e| format!("Failed to parse credential JSON: {}", e))?;

    let credential_envelope = serde_json::json!({
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "type": ["VerifiableCredential"],
        "issuer": holder_did,
        "credentialSubject": credential_value
    });

    let envelope_str = credential_envelope.to_string();
    let key_b58 = bs58::encode(signing_key.to_bytes()).into_string();
    let signed_vc = did_rust::issue_vc(&envelope_str, &did, &key_b58)
        .map_err(|e| format!("Failed to sign credential: {}", e))?;

    let vc_value: serde_json::Value = serde_json::from_str(&signed_vc)
        .map_err(|e| format!("Failed to parse signed VC as JSON: {}", e))?;

    let response = serde_json::json!({
        "type": "signed_credential",
        "vc": vc_value
    });

    println!("Sending signed VC back to browser");
    let _ = sender.send(Message::Text(response.to_string().into()));
    Ok(())
}

// ---------- POLY_CREDENTIAL_REQUEST response ----------

struct PopupGuard {
    ws: *const WsState,
    cleared: bool,
}

impl PopupGuard {
    fn acquire(ws: &WsState) -> Result<Self, String> {
        let mut popup = ws.popup_active.lock().unwrap();
        if *popup {
            return Err("A popup request is already being processed".to_string());
        }
        *popup = true;
        Ok(Self { ws: ws as *const WsState, cleared: false })
    }

    fn release(&mut self) {
        if !self.cleared {
            let ws = unsafe { &*self.ws };
            let mut popup = ws.popup_active.lock().unwrap();
            *popup = false;
            self.cleared = true;
            let pending = ws.pending_messages.lock().unwrap().clone();
            if let Some(channel) = ws.challenge_channel.lock().unwrap().as_ref() {
                for msg in &pending {
                    let _ = channel.send(msg.clone());
                }
                ws.pending_messages.lock().unwrap().clear();
                if !pending.is_empty() {
                    println!("!!! FLUSHED {} queued messages after popup release !!!", pending.len());
                }
            }
        }
    }
}

impl Drop for PopupGuard {
    fn drop(&mut self) {
        self.release();
    }
}

#[tauri::command]
async fn submit_ws_credential_presentation(
    credential_type: String,
    challenge: String,
    approved: bool,
    app: AppHandle,
    ws_state: State<'_, WsState>,
    profile_id: Option<String>,
) -> Result<(), String> {
    if credential_type.is_empty() {
        return Err("credential_type must not be empty".to_string());
    }
    if challenge.is_empty() {
        return Err("challenge must not be empty".to_string());
    }

    let mut guard = PopupGuard::acquire(&*ws_state)?;

    let sender = {
        let guard = ws_state.response_sender.lock().unwrap();
        guard.clone().ok_or("No WebSocket connected")?
    };

    if !approved {
        let _ = sender.send(Message::Text("{\"status\":\"denied\"}".into()));
        println!("WS credential presentation denied by user");
        guard.release();
        return Ok(());
    }

    let (signing_key, did) = resolve_profile_keypair(&app, profile_id.clone())?;

    let vault = vault::load_vault(&app)?;
    let pid = profile_id.unwrap_or_default();
    // Empty/omitted profile_id resolves to the public persona (Level 1).
    let profile = vault
        .get_profile_by_id(&pid)
        .ok_or_else(|| format!("Profile '{}' not found", pid))?;

    let mut candidates: Vec<&vault::VaultCredential> = profile
        .credentials
        .iter()
        .filter(|c| c.credential_type == credential_type)
        .collect();

    if candidates.is_empty() {
        let err = serde_json::json!({
            "status": "error",
            "reason": "no_matching_credential",
            "credential_type": credential_type
        });
        let _ = sender.send(Message::Text(err.to_string().into()));
        guard.release();
        return Ok(());
    }

    // Prefer non-expired credentials; sort by fidelity descending
    candidates.sort_by(|a, b| {
        let a_expired = a.expiration_date.as_ref().map_or(false, |exp| {
            DateTime::parse_from_rfc3339(exp)
                .map(|t| Utc::now() > t.with_timezone(&Utc))
                .unwrap_or(false)
        });
        let b_expired = b.expiration_date.as_ref().map_or(false, |exp| {
            DateTime::parse_from_rfc3339(exp)
                .map(|t| Utc::now() > t.with_timezone(&Utc))
                .unwrap_or(false)
        });
        a_expired.cmp(&b_expired).then(
            b.fidelity_score.unwrap_or(0.0)
                .partial_cmp(&a.fidelity_score.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    let chosen = candidates[0];

    // Reject if all candidates are expired
    if chosen.expiration_date.as_ref().map_or(false, |exp| {
            DateTime::parse_from_rfc3339(exp)
                .map(|t| Utc::now() > t.with_timezone(&Utc))
            .unwrap_or(false)
    }) {
        let err = serde_json::json!({
            "status": "error",
            "reason": "all_credentials_expired",
            "credential_type": credential_type
        });
        let _ = sender.send(Message::Text(err.to_string().into()));
        guard.release();
        return Ok(());
    }

    // Parse raw_payload as structured JSON — mod req #2
    let vc_value: serde_json::Value = serde_json::from_str(&chosen.raw_payload)
        .map_err(|e| format!("Failed to parse stored credential JSON: {}", e))?;

    let key_b58 = bs58::encode(signing_key.to_bytes()).into_string();
    let signed_vp = did_rust::issue_vp(
        &vc_value.to_string(),
        &did,
        &challenge,
        &key_b58,
    )
    .map_err(|e| format!("Failed to sign VP: {}", e))?;

    let vp_value: serde_json::Value = serde_json::from_str(&signed_vp)
        .map_err(|e| format!("Failed to parse signed VP as JSON: {}", e))?;

    let response = serde_json::json!({
        "type": "POLY_CREDENTIAL_PRESENTATION",
        "vp": vp_value,
        "challenge": challenge
    });

    println!("Signed credential presentation for type: {}", credential_type);
    let _ = sender.send(Message::Text(response.to_string().into()));

    guard.release();
    Ok(())
}

// ---------- auto-start settings ----------
//
// IMPORTANT — PDS Boundary Invariant:
// This client application is a lean Personal Data Store (PDS). It MUST
// NOT initialize or spawn any IPFS node, DHT discovery service, or
// heavy P2P transport process. IPFS belongs strictly at cloud/server
// boundaries (iyou_idp downloads, server-side governance anchors).
//
// Only lightweight local services (Blossom on :9002, Nostr relay on
// :9003, Chat/XMPP on :5222) are valid auto-start targets. Do NOT add
// IPFS or other P2P daemon entries to this list.

fn auto_start_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("auto_start.json");
    path
}

fn load_auto_start_settings(app: &AppHandle) -> HashMap<String, bool> {
    let path = auto_start_path(app);
    if !path.exists() {
        return HashMap::new();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_auto_start_settings(app: &AppHandle, settings: &HashMap<String, bool>) {
    let path = auto_start_path(app);
    if let Ok(json) = serde_json::to_string(settings) {
        let _ = std::fs::write(&path, &json);
    }
}

// ---------- user preferences ----------

fn preferences_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("preferences.json");
    path
}

pub(crate) fn load_preferences(app: &AppHandle) -> UserPreferences {
    let path = preferences_path(app);
    if !path.exists() {
        let prefs = UserPreferences::default();
        if let Err(e) = save_preferences(app, &prefs) {
            eprintln!("Failed to save default preferences: {}", e);
        }
        return prefs;
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| {
            eprintln!("Failed to parse preferences, using defaults");
            UserPreferences::default()
        })
}

pub(crate) fn save_preferences(app: &AppHandle, prefs: &UserPreferences) -> Result<(), String> {
    let path = preferences_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create preferences directory: {}", e))?;
    }
    let json = serde_json::to_string(prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write preferences: {}", e))?;
    Ok(())
}

#[tauri::command]
fn get_auto_start_settings(state: State<'_, ServiceState>) -> HashMap<String, bool> {
    state.auto_start_settings.lock().unwrap().clone()
}

#[tauri::command]
fn get_user_preferences(app: AppHandle) -> Result<UserPreferences, String> {
    Ok(load_preferences(&app))
}

#[tauri::command]
fn save_user_preferences(app: AppHandle, preferences: UserPreferences) -> Result<(), String> {
    save_preferences(&app, &preferences)
}

#[tauri::command]
fn set_auto_start(
    name: String,
    enabled: bool,
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<(), String> {
    state
        .auto_start_settings
        .lock()
        .unwrap()
        .insert(name.clone(), enabled);
    let settings = state.auto_start_settings.lock().unwrap().clone();
    save_auto_start_settings(&app, &settings);
    Ok(())
}

// ---------- Stream B: Vote Ledger Commands ----------

#[tauri::command]
fn sync_vote_records(app: AppHandle, records: Vec<vault::VoteRecord>) -> Result<(), String> {
    vault::append_vote_records(&app, records)
}

#[tauri::command]
fn get_vote_history(app: AppHandle) -> Result<Vec<vault::VoteRecord>, String> {
    vault::get_vote_records(&app)
}

// ---------- Cold Governance Anchoring ----------

#[tauri::command]
fn calculate_vote_merkle_root(records: Vec<vault::VoteRecord>) -> String {
    vault::calculate_vote_merkle_root(&records)
}

// ---------- Local Poll Sync & Ingestion ----------

#[tauri::command]
fn sync_poll_ledger(
    poll: vault::LocalPoll,
    records: Vec<vault::VoteRecord>,
) -> Result<String, String> {
    let valid_records: Vec<vault::VoteRecord> = records
        .into_iter()
        .filter(|r| {
            poll.validate_vote_timeline(r.network_timestamp as u64)
                .is_ok()
        })
        .collect();
    Ok(vault::calculate_vote_merkle_root(&valid_records))
}

// ---------- Credential Vault Commands ----------

#[tauri::command]
fn import_verifiable_credential(
    app: AppHandle,
    profile_id: String,
    vc_payload: String,
) -> Result<vault::Profile, String> {
    if profile_id.is_empty() {
        return Err("profile_id must not be empty".to_string());
    }

    let vc_json: serde_json::Value = serde_json::from_str(&vc_payload)
        .map_err(|e| format!("Invalid JSON payload: {}", e))?;

    let mut vault = vault::load_vault(&app).map_err(|e| e.to_string())?;
    let updated_profile = vault::add_credential_to_profile(&mut vault, &profile_id, vc_json)?;
    vault::save_vault(&app, &vault)?;

    Ok(updated_profile)
}

#[tauri::command]
fn save_credential(
    app: AppHandle,
    profile_id: String,
    vc_json: String,
) -> Result<(), String> {
    if profile_id.is_empty() {
        return Err("profile_id must not be empty".to_string());
    }

    let verification = did_rust::verify_vc(&vc_json);
    let result: serde_json::Value = serde_json::from_str(&verification)
        .map_err(|_| "Failed to parse verification result".to_string())?;
    if !result["valid"].as_bool().unwrap_or(false) {
        return Err(format!(
            "Credential verification failed: {}",
            result["error"].as_str().unwrap_or("unknown error")
        ));
    }

    let vc: serde_json::Value = serde_json::from_str(&vc_json)
        .map_err(|_| "Invalid VC JSON".to_string())?;

    let vc_id = vc["id"].as_str().unwrap_or("").to_string();
    if vc_id.is_empty() {
        return Err("VC missing required 'id' field".to_string());
    }

    let vault_credential = vault::VaultCredential {
        vc_id: vc_id.clone(),
        issuer_did: vc["issuer"].as_str().unwrap_or("").to_string(),
        subject_did: vc["credentialSubject"]["id"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        credential_type: vc["type"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|t| t.as_str())
            .unwrap_or("VerifiableCredential")
            .to_string(),
        fidelity_score: None,
        expiration_date: vc["expirationDate"].as_str().map(String::from),
        raw_payload: vc_json,
    };

    let mut vault = vault::load_vault(&app)?;
    let profile = vault
        .profiles
        .iter_mut()
        .find(|p| p.profile_id == profile_id)
        .ok_or_else(|| format!("Profile '{}' not found", profile_id))?;

    if let Some(existing) = profile
        .credentials
        .iter_mut()
        .find(|c| c.vc_id == vc_id)
    {
        *existing = vault_credential;
    } else {
        profile.credentials.push(vault_credential);
    }

    vault::save_vault(&app, &vault)
}

#[tauri::command]
fn get_credentials(
    app: AppHandle,
    profile_id: String,
) -> Result<Vec<vault::VaultCredential>, String> {
    if profile_id.is_empty() {
        return Err("profile_id must not be empty".to_string());
    }
    let vault = vault::load_vault(&app)?;
    let profile = vault
        .profiles
        .iter()
        .find(|p| p.profile_id == profile_id)
        .ok_or_else(|| format!("Profile '{}' not found", profile_id))?;
    Ok(profile.credentials.clone())
}

#[tauri::command]
fn store_credential(
    app: AppHandle,
    profile_id: String,
    credential: vault::VaultCredential,
) -> Result<(), String> {
    if profile_id.is_empty() {
        return Err("profile_id must not be empty".to_string());
    }
    let mut vault = vault::load_vault(&app)?;
    let profile = vault
        .profiles
        .iter_mut()
        .find(|p| p.profile_id == profile_id)
        .ok_or_else(|| format!("Profile '{}' not found", profile_id))?;

    if let Some(existing) = profile
        .credentials
        .iter_mut()
        .find(|c| c.vc_id == credential.vc_id)
    {
        *existing = credential;
    } else {
        profile.credentials.push(credential);
    }

    vault::save_vault(&app, &vault)
}

#[tauri::command]
fn delete_credential(
    app: AppHandle,
    profile_id: String,
    vc_id: String,
) -> Result<(), String> {
    if profile_id.is_empty() {
        return Err("profile_id must not be empty".to_string());
    }
    if vc_id.is_empty() {
        return Err("vc_id must not be empty".to_string());
    }
    let mut vault = vault::load_vault(&app)?;
    let profile = vault
        .profiles
        .iter_mut()
        .find(|p| p.profile_id == profile_id)
        .ok_or_else(|| format!("Profile '{}' not found", profile_id))?;

    let len_before = profile.credentials.len();
    profile.credentials.retain(|c| c.vc_id != vc_id);

    if profile.credentials.len() == len_before {
        return Err(format!(
            "Credential '{}' not found in profile '{}'",
            vc_id, profile_id
        ));
    }

    vault::save_vault(&app, &vault)
}

// ---------- Contact Enclave Commands ----------

#[tauri::command]
fn list_contacts(app: AppHandle) -> Result<Vec<contacts::PeerContact>, String> {
    let store = contacts::load_contact_store(&app)?;
    Ok(store.contacts)
}

#[tauri::command]
fn upsert_contact(
    app: AppHandle,
    contact: contacts::PeerContact,
) -> Result<contacts::PeerContact, String> {
    let mut store = contacts::load_contact_store(&app)?;
    let stored = contacts::upsert_contact(&mut store, contact)?;
    contacts::save_contact_store(&app, &store)?;
    Ok(stored)
}

#[tauri::command]
fn delete_contact(app: AppHandle, peer_id: String) -> Result<(), String> {
    if peer_id.trim().is_empty() {
        return Err("peer_id must not be empty".to_string());
    }
    let mut store = contacts::load_contact_store(&app)?;
    contacts::remove_contact(&mut store, &peer_id)?;
    contacts::save_contact_store(&app, &store)
}

#[tauri::command]
fn generate_disclosure_card(
    app: AppHandle,
    profile_id: Option<String>,
    target_peer_did: Option<String>,
    display_name: String,
    disclosed_aliases: Vec<String>,
    tier: Option<String>,
) -> Result<String, String> {
    let (signing_key, did) = resolve_profile_keypair(&app, profile_id)?;
    let card_id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();

    let mut subject = serde_json::json!({
        "id": did,
        "name": display_name,
        "disclosed_aliases": disclosed_aliases,
    });
    if let Some(ref target) = target_peer_did {
        if !target.is_empty() {
            subject["target_peer_did"] = serde_json::Value::String(target.clone());
        }
    }
    if let Some(ref t) = tier {
        if !t.is_empty() {
            subject["tier"] = serde_json::Value::String(t.clone());
        }
    }

    let payload = serde_json::json!({
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "id": card_id,
        "type": ["VerifiableCredential", "SelectiveDisclosureCard"],
        "issuanceDate": now,
        "credentialSubject": subject,
    });

    let payload_str = payload.to_string();
    let key_b58 = bs58::encode(signing_key.to_bytes()).into_string();
    let signed_vc = did_rust::issue_vc(&payload_str, &did, &key_b58)
        .map_err(|e| format!("Failed to sign disclosure card: {}", e))?;

    Ok(signed_vc)
}

#[tauri::command]
fn import_disclosure_card(
    app: AppHandle,
    disclosure_json: Option<String>,
    card_json: Option<String>,
) -> Result<contacts::PeerContact, String> {
    let raw = disclosure_json
        .or(card_json)
        .ok_or_else(|| "Missing disclosure card JSON".to_string())?;

    let card: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "Invalid disclosure card JSON".to_string())?;

    // A disclosure card is a signed VC / presentation. Verify the signature
    // before trusting any of its contents.
    let verification = did_rust::verify_vc(&raw);
    let result: serde_json::Value = serde_json::from_str(&verification)
        .map_err(|_| "Failed to parse verification result".to_string())?;
    if !result["valid"].as_bool().unwrap_or(false) {
        return Err(format!(
            "Disclosure card verification failed: {}",
            result["error"].as_str().unwrap_or("unknown error")
        ));
    }

    let subject = &card["credentialSubject"];
    let peer_id = subject["id"]
        .as_str()
        .map(String::from)
        .or_else(|| card["holder"].as_str().map(String::from))
        .unwrap_or_default();
    if peer_id.is_empty() {
        return Err("Disclosure card missing subject id".to_string());
    }

    let display_name = subject["name"]
        .as_str()
        .or_else(|| subject["nickname"].as_str())
        .unwrap_or("Unnamed Peer")
        .to_string();

    let disclosed_aliases: Vec<String> = subject["disclosed_aliases"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let trust_level = if let Some(tier_str) = subject["tier"].as_str() {
        let lower = tier_str.to_lowercase();
        if lower.contains("0.5") || lower.contains("alliance") {
            contacts::TrustLevel::Level0_5
        } else if lower.contains("tier 0") || lower.contains("level 0") || lower.contains("inner") {
            contacts::TrustLevel::Level0
        } else {
            contacts::TrustLevel::Level1
        }
    } else {
        contacts::TrustLevel::Level1
    };

    let contact = contacts::PeerContact {
        peer_id,
        display_name,
        trust_level,
        disclosed_aliases,
        attestation_receipt: Some(raw),
        created_at: 0,
        updated_at: 0,
    };

    let mut store = contacts::load_contact_store(&app)?;
    let stored = contacts::upsert_contact(&mut store, contact)?;
    contacts::save_contact_store(&app, &store)?;
    Ok(stored)
}

#[tauri::command]
fn resolve_peer_aliases(app: AppHandle, pubkeys: Vec<String>) -> Result<serde_json::Value, String> {
    if pubkeys.is_empty() {
        return Err("pubkeys must not be empty".to_string());
    }
    if pubkeys.len() > contacts::MAX_RESOLVE_KEYS {
        return Err(format!(
            "Too many pubkeys (max {})",
            contacts::MAX_RESOLVE_KEYS
        ));
    }
    let store = contacts::load_contact_store(&app)?;
    Ok(contacts::resolution_json(&store, &pubkeys))
}

// ---------- WebAuthn PRF & Identity Graduation Commands ----------

/// Derives the dual-curve sovereign identity (Ed25519 DID + Nostr pubkey)
/// deterministically from a browser-supplied WebAuthn PRF seed. Only public
/// key material is returned — the derived private scalars stay in Rust and
/// are zeroized when `DerivedIdentity` drops.
#[tauri::command]
fn derive_prf_identity(
    prf_seed_hex: String,
    derivation_index: u32,
) -> Result<DerivedIdentityPublic, String> {
    let decoded = hex::decode(prf_seed_hex.trim())
        .map_err(|_| "Invalid PRF seed hex encoding".to_string())?;
    let prf_seed = Zeroizing::new(
        <[u8; 32]>::try_from(decoded.as_slice())
            .map_err(|_| "PRF seed must be exactly 32 bytes (64 hex chars)".to_string())?,
    );

    let identity = did_rust::derive_identity_from_prf(&prf_seed, derivation_index)
        .map_err(|e| format!("PRF identity derivation failed: {}", e))?;

    Ok(DerivedIdentityPublic {
        did: identity.did.clone(),
        nostr_pubkey_hex: identity.nostr_pubkey_hex.clone(),
    })
}

/// Mints an ephemeral X25519 transit keypair for the graduation handshake.
/// The private scalar is cached in a short-lived managed state (single use:
/// consumed by `process_graduation_ingest`) and never leaves the backend.
#[tauri::command]
fn generate_transit_keypair(state: State<'_, TransitState>) -> Result<TransitKeypairPublic, String> {
    let mut sk_bytes = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(sk_bytes.as_mut());

    let secret = StaticSecret::from(*sk_bytes);
    let public = x25519_dalek::PublicKey::from(&secret);

    *state.client_ephemeral_priv.lock().unwrap() = Some(sk_bytes);

    Ok(TransitKeypairPublic {
        client_ephemeral_pub_hex: hex::encode(public.as_bytes()),
    })
}

/// Unwraps the IdP's sealed custodial identity export, re-seals the raw
/// Ed25519 seed under the WebAuthn PRF KEK (ChaCha20Poly1305) inside
/// `vault.json`, then signs the canonical graduation receipt with the
/// unsealed key. All intermediate secrets are zeroized before returning;
/// only the receipt and its signature cross the IPC boundary.
#[tauri::command]
fn process_graduation_ingest(
    app: AppHandle,
    transit: State<'_, TransitState>,
    server_ephemeral_pub_hex: String,
    nonce_hex: String,
    ciphertext_hex: String,
    custodial_did: String,
    prf_kek_hex: String,
) -> Result<GraduationConfirmPayload, String> {
    let custodial_did = custodial_did.trim().to_string();
    if custodial_did.is_empty() {
        return Err("custodial_did must not be empty".to_string());
    }

    let client_priv = transit
        .client_ephemeral_priv
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| {
            "No cached transit keypair: call generate_transit_keypair first".to_string()
        })?;

    let server_pub_vec = hex::decode(server_ephemeral_pub_hex.trim())
        .map_err(|_| "Server ephemeral public key is not valid hex".to_string())?;
    let server_pub: [u8; 32] = server_pub_vec
        .try_into()
        .map_err(|_| "Server ephemeral public key must be 32 bytes".to_string())?;
    let nonce =
        hex::decode(nonce_hex.trim()).map_err(|_| "Export nonce is not valid hex".to_string())?;
    let ciphertext = hex::decode(ciphertext_hex.trim())
        .map_err(|_| "Export ciphertext is not valid hex".to_string())?;

    let kek_decoded = hex::decode(prf_kek_hex.trim())
        .map_err(|_| "PRF KEK is not valid hex".to_string())?;
    let prf_kek = Zeroizing::new(
        <[u8; 32]>::try_from(kek_decoded.as_slice())
            .map_err(|_| "PRF KEK must be exactly 32 bytes".to_string())?,
    );

    // ECDH → HKDF-SHA256 → AES-256-GCM unwrap of the custodial Ed25519 seed.
    let seed = vault::unseal_graduation_export(
        &client_priv,
        &server_pub,
        &nonce,
        &ciphertext,
        &custodial_did,
    )?;

    // Persist the persona sealed under the PRF KEK. The plaintext seed never
    // touches disk and never returns to TypeScript.
    let mut vault_store = vault::load_vault(&app)?;
    let record = vault::ingest_graduated_identity(
        &mut vault_store,
        &custodial_did,
        &seed,
        &prf_kek,
    )?;
    vault::save_vault(&app, &vault_store)?;

    // Canonical receipt JSON: alphabetical keys, zero whitespace — byte
    // compatible with the IdP verifier (`json.dumps(sort_keys=True,
    // separators=(",", ":"))`).
    let issued_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Time went backwards".to_string())?
        .as_secs();
    let mut canonical_map: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    canonical_map.insert("action".to_string(), serde_json::json!("graduate"));
    canonical_map.insert("did".to_string(), serde_json::json!(custodial_did));
    canonical_map.insert("issued_at".to_string(), serde_json::json!(issued_at));
    let canonical_str = serde_json::to_string(&canonical_map)
        .map_err(|e| format!("Failed to serialize graduation receipt: {}", e))?;

    // Sign via the persisted record: proves the ChaCha20Poly1305 sealed blob
    // round-trips under the PRF KEK before we ever report success.
    let signing_key = vault::unseal_sovereign_identity(&record, &prf_kek)?;
    let signature = signing_key.sign(canonical_str.as_bytes());

    Ok(GraduationConfirmPayload {
        receipt: serde_json::Value::Object(canonical_map.into_iter().collect()),
        signature: hex::encode(signature.to_bytes()),
    })
}

/// Switches the active signer to a graduated sovereign identity and persists
/// the pointer so it survives restarts.
#[tauri::command]
fn activate_sovereign_identity(
    app: AppHandle,
    state: State<'_, ServiceState>,
    did: String,
) -> Result<(), String> {
    let vault_store = vault::load_vault(&app)?;
    if vault::get_sovereign_identity(&vault_store, &did).is_none() {
        return Err(format!("Sovereign identity '{}' not found in vault", did));
    }

    {
        let mut active = state.active_did.lock().unwrap();
        *active = Some(did.clone());
    }

    let mut prefs = load_preferences(&app);
    prefs.active_sovereign_did = Some(did);
    save_preferences(&app, &prefs)
}

// ---------- Break-Glass Emergency Rotation ----------

/// Burns the active Level 1 Public Persona and provisions a fresh one at the
/// next available derivation index. The Level 0 Anchor and all other profiles
/// remain untouched.
#[tauri::command]
fn rotate_primary_persona(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<vault::Profile, String> {
    let mut vault = vault::load_vault(&app)?;
    let new_profile = vault::rotate_public_persona(&mut vault)?;
    vault::save_vault(&app, &vault)?;

    // Point the active signer at the new primary.
    {
        let mut active = state.active_did.lock().unwrap();
        *active = Some(new_profile.did.clone());
    }

    let mut prefs = load_preferences(&app);
    prefs.active_profile_id = vault::DEFAULT_PERSONA_PROFILE_ID.to_string();
    prefs.active_sovereign_did = None;
    save_preferences(&app, &prefs)?;

    Ok(new_profile)
}

// ---------- Vault Disaster Recovery ----------

#[tauri::command]
fn reveal_master_seed(app: AppHandle) -> Result<String, String> {
    let vault = vault::load_vault(&app)?;
    vault::reveal_root_seed_hex(&vault)
}

#[tauri::command]
fn get_vault_status(app: AppHandle) -> Result<bool, String> {
    match vault::load_vault(&app) {
        Ok(_) => Ok(true),
        // First-run: no vault yet is a normal empty state, not an error.
        Err(vault::VaultLoadError::NotFound) => Ok(false),
        // Corruption/IO faults must surface, never be masked.
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn set_seed_backup_confirmed(app: AppHandle, confirmed: bool) -> Result<(), String> {
    let mut prefs = load_preferences(&app);
    prefs.seed_backup_confirmed = confirmed;
    save_preferences(&app, &prefs)
}

// ---------- Device pairing ----------

#[tauri::command]
fn pair_begin(state: State<'_, pairing::PairFrameState>) -> Result<pairing::PairFrameResponse, String> {
    pairing::begin_pairing(&state)
}

#[tauri::command]
fn pair_seal_seed_for_device(
    app: AppHandle,
    state: State<'_, pairing::PairFrameState>,
    frame_id: String,
    mobile_x25519_pub_hex: String,
    device_did: String,
    verification_code: String,
) -> Result<Vec<u8>, String> {
    pairing::seal_seed_for_device(
        &app,
        &state,
        &frame_id,
        &mobile_x25519_pub_hex,
        &device_did,
        &verification_code,
    )
}

#[tauri::command]
fn pair_confirm(
    app: AppHandle,
    state: State<'_, pairing::PairFrameState>,
    frame_id: String,
    device_did: String,
    device_name: String,
) -> Result<pairing::PairedDeviceRecord, String> {
    pairing::confirm_pairing(&app, &state, &frame_id, &device_did, &device_name)
}

#[tauri::command]
fn pair_list_devices(app: AppHandle) -> Result<Vec<pairing::PairedDeviceRecord>, String> {
    pairing::list_devices(&app)
}

#[tauri::command]
fn pair_revoke_device(app: AppHandle, device_id: String) -> Result<bool, String> {
    pairing::revoke_device(&app, &device_id)
}

// ---------------------------------------------------------------------------
// OMEMO / XMPP chat: Level 1 persona fail-closed guard for every command.
// The raw anchor (Level 0) can never be used for live communication.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatSessionCredentials {
    pub jid: String,
    pub pubkey_hex: String,
    pub wss_url: String,
}

fn require_l1_persona(vault: &vault::VaultStore) -> Result<vault::Profile, String> {
    let persona = vault
        .public_persona()
        .ok_or_else(|| "No Level 1 public persona available — create one before using chat".to_string())?;
    if persona.is_anchor() || persona.derivation_index == 0 {
        return Err("Level 0 anchor persona cannot be used for chat".to_string());
    }
    Ok(persona.clone())
}

fn l1_persona_jid(
    app: &AppHandle,
) -> Result<(vault::Profile, String, String), String> {
    let vault = vault::load_or_bootstrap_vault(app)
        .map_err(|e| format!("Failed to load vault: {}", e))?;
    let persona = require_l1_persona(&vault)?;
    let keypair = vault::get_profile_keypair(&vault, &persona.profile_id)
        .map_err(|e| format!("Failed to derive persona keypair: {}", e))?;
    let pubkey_hex = keypair.verifying_key.to_bytes();
    let pubkey_hex = hex::encode(pubkey_hex);
    let jid = format!("{}@127.0.0.1", pubkey_hex);
    Ok((persona, jid, pubkey_hex))
}

#[tauri::command]
fn get_chat_session_credentials(app: AppHandle) -> Result<ChatSessionCredentials, String> {
    let (_persona, jid, pubkey_hex) = l1_persona_jid(&app)?;
    Ok(ChatSessionCredentials {
        jid,
        pubkey_hex,
        wss_url: "wss://home.iyou.me:5222".to_string(),
    })
}

/// Publish this enclave's OMEMO bundle under its own Level 1 JID.
///
/// `bundle_json` may be empty (generate + publish the enclave device bundle)
/// or an already-signed bundle payload to validate and re-record.
#[tauri::command]
fn omemo_publish_bundle(app: AppHandle, bundle_json: String) -> Result<bool, String> {
    let (_persona, jid, _pubkey_hex) = l1_persona_jid(&app)?;
    if bundle_json.trim().is_empty() {
        omemo::publish_local_bundle(&app, &jid)?;
        return Ok(true);
    }
    let mut store = omemo::load_omemo_store(&app)?;
    omemo::publish_bundle_in_memory(&mut store, &jid, &bundle_json)?;
    omemo::save_omemo_store(&app, &store)?;
    Ok(true)
}

#[tauri::command]
fn omemo_fetch_peer_bundle(app: AppHandle, peer_jid: String) -> Result<Option<String>, String> {
    let bare = prosody::normalize_bare_jid(&peer_jid);
    omemo::fetch_bundle_for(&app, &bare)
}

#[tauri::command]
fn omemo_list_devices(
    app: AppHandle,
    peer_jid: String,
) -> Result<Vec<omemo::OmemoDeviceInfo>, String> {
    let bare = prosody::normalize_bare_jid(&peer_jid);
    omemo::list_peer_devices(&app, &bare)
}

#[tauri::command]
fn create_vault_backup(app: AppHandle, password: String) -> Result<Vec<u8>, String> {
    let app_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let vault = vault::load_or_bootstrap_vault(&app)
        .map_err(|e| format!("Failed to load vault: {}", e))?;
    let backup_bytes = vault::export_vault_backup(&vault, &app_data, &password)?;

    let mut prefs = load_preferences(&app);
    let now = chrono::Utc::now().timestamp() as u64;
    prefs.last_backup_at = now;
    let _ = save_preferences(&app, &prefs);

    Ok(backup_bytes)
}

#[tauri::command]
fn write_binary_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    if path.is_empty() {
        return Err("Path must not be empty".to_string());
    }
    let dest = std::path::Path::new(&path);
    vault::atomic_write_bytes(dest, &contents)
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    if path.is_empty() {
        return Err("Path must not be empty".to_string());
    }
    let src = std::path::Path::new(&path);
    if src.is_dir() {
        return Err(format!("{} is a directory", path));
    }
    std::fs::read(src).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn restore_vault_backup(
    app: AppHandle,
    state: State<'_, ServiceState>,
    backup_bytes: Vec<u8>,
    password: String,
) -> Result<bool, String> {
    let app_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let result = vault::import_vault_backup(&app_data, &backup_bytes, &password)?;

    // Reload vault into memory so the running state stays consistent.
    if let Ok(v) = vault::load_vault(&app) {
        if let Some(profile) = v.public_persona() {
            let mut active = state.active_did.lock().unwrap();
            *active = Some(profile.did.clone());
        }
    }

    Ok(result)
}

#[tauri::command]
async fn revoke_all_sessions(
    app: AppHandle,
    idp_url: Option<String>,
) -> Result<String, String> {
    let vault = vault::load_vault(&app).map_err(|e| e.to_string())?;
    let envelope = vault::build_session_revocation_payload(&vault)?;

    let target_url = idp_url
        .unwrap_or_else(|| "https://iyou.me/api/auth/revoke-all/".to_string());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = client
        .post(&target_url)
        .json(&envelope)
        .send()
        .await
        .map_err(|e| format!("Network error contacting IdP ({}): {}", target_url, e))?;

    let status = response.status();
    if status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "All active web sessions revoked successfully.".to_string());
        Ok(body)
    } else {
        let err_text = response.text().await.unwrap_or_default();
        Err(format!("IdP returned error ({}): {}", status, err_text))
    }
}

// ---------- sync-to-home ----------

/// Count plain files whose names are valid 64-char lowercase SHA-256 hex
/// hashes. Replaces the previous dir-walk heuristic so `get_sync_status`
/// only counts real blobs, never stray files in the blobs directory.
fn count_valid_local_blobs(blobs_dir: &std::path::Path) -> usize {
    if !blobs_dir.exists() {
        return 0;
    }
    match std::fs::read_dir(blobs_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter(|e| {
                let file_name = e.file_name();
                let name = file_name.to_string_lossy();
                blossom::is_valid_hash(&name) && name == name.to_ascii_lowercase()
            })
            .count(),
        Err(_) => 0,
    }
}

// ---------- local blob browser ----------

/// Best-effort file creation timestamp (Unix epoch seconds). Prefers the
/// platform birth time (macOS), falling back to the modification time.
fn file_created_at(meta: &std::fs::Metadata) -> u64 {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        let birth = meta.st_birthtime();
        if birth > 0 {
            return birth as u64;
        }
    }
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
fn list_local_blobs(app: AppHandle) -> Result<Vec<LocalBlobInfo>, String> {
    let blobs_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("blobs");

    let mut blobs = Vec::new();
    if !blobs_dir.exists() {
        return Ok(blobs);
    }

    for entry in std::fs::read_dir(&blobs_dir).map_err(|e| format!("Failed to read blobs dir: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if !blossom::is_valid_hash(&name) || name != name.to_ascii_lowercase() {
            continue;
        }
        let path = entry.path();
        let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to stat {}: {}", path.display(), e))?;

        let size_bytes = meta.len();
        let created_at = file_created_at(&meta);

        let mut head = vec![0u8; 64];
        let read_len = {
            use std::io::Read;
            match std::fs::File::open(&path).and_then(|mut f| f.read(&mut head)) {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("Blossom head read failed for {}: {}", path.display(), e);
                    0
                }
            }
        };
        head.truncate(read_len);
        let mime_type = blossom::detect_mime_type(&head).to_string();

        blobs.push(LocalBlobInfo {
            sha256: name.to_string(),
            size_bytes,
            mime_type,
            created_at,
        });
    }

    blobs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(blobs)
}

#[tauri::command]
fn delete_local_blob(app: AppHandle, sha256: String) -> Result<bool, String> {
    if !blossom::is_valid_hash(&sha256) || sha256 != sha256.to_ascii_lowercase() {
        return Err("Invalid blob hash format".to_string());
    }
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("blobs")
        .join(&sha256);

    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => {
            std::fs::remove_file(&path).map_err(|e| format!("Failed to delete blob: {}", e))?;
            Ok(true)
        }
        Ok(_) => Err("Path is not a blob file".to_string()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
fn get_local_blobs_count(app: AppHandle) -> Result<u64, String> {
    let blobs_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("blobs");
    Ok(count_valid_local_blobs(&blobs_dir) as u64)
}

#[tauri::command]
fn get_sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    let prefs = load_preferences(&app);
    let last_synced_at = prefs.last_synced_at;

    let app_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;

    // Count local Nostr events
    let db_path = app_data.join("nostr_events.db");
    let local_notes_count = if db_path.exists() {
        match rusqlite::Connection::open(&db_path) {
            Ok(conn) => {
                let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
                nostr_relay::count_events(&db).unwrap_or(0)
            }
            Err(_) => 0,
        }
    } else {
        0
    };

    // Count local Blossom blobs (validated 64-hex filenames only)
    let blobs_dir = app_data.join("blobs");
    let local_blobs_count = count_valid_local_blobs(&blobs_dir);

    Ok(SyncStatus {
        last_synced_at,
        local_notes_count,
        local_blobs_count,
    })
}

#[tauri::command]
async fn trigger_manual_sync(
    app: AppHandle,
    remote_relay_url: Option<String>,
    remote_blossom_url: Option<String>,
) -> Result<SyncSummary, String> {
    let _ = remote_relay_url;
    let remote_blossom = remote_blossom_url
        .unwrap_or_else(|| "https://cdn.iyou.me".to_string());

    let app_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;

    let blobs_dir = app_data.join("blobs");
    let _ = std::fs::create_dir_all(&blobs_dir);

    // Fetch manifest of blob hashes from the remote Blossom server's
    // Blossom List endpoint (BUD-03). If unreachable, degrade gracefully.
    let blobs_mirrored = match fetch_and_mirror_blobs(&remote_blossom, &blobs_dir).await {
        Ok(n) => n,
        Err(e) => {
            eprintln!("Sync: blob mirror failed (offline?): {}", e);
            0
        }
    };

    let now = chrono::Utc::now().timestamp() as u64;
    let mut prefs = load_preferences(&app);
    prefs.last_synced_at = now;
    let _ = save_preferences(&app, &prefs);

    Ok(SyncSummary {
        events_ingested: 0, // Event ingestion is handled by bridge SYNC_TO_HOME_REQUEST
        blobs_mirrored,
        last_synced_at: now,
    })
}

/// Fetch the blob hash manifest from a remote Blossom server and mirror
/// any missing blobs locally. Returns the count of newly mirrored blobs.
async fn fetch_and_mirror_blobs(
    remote_url: &str,
    blobs_dir: &PathBuf,
) -> Result<usize, String> {
    // Try the Blossom List endpoint (BUD-03) first
    let list_url = format!("{}/list", remote_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&list_url)
        .send()
        .await
        .map_err(|e| format!("Failed to reach remote Blossom: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Remote Blossom returned {}", response.status()));
    }

    let items: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse blob manifest: {}", e))?;

    let mut mirrored = 0usize;
    for item in items {
        if let Some(hash) = item["sha256"].as_str() {
            if let Ok(true) = blossom::mirror_blob_from_remote(hash, remote_url, blobs_dir).await {
                // Only count if the file is new (was just written)
                let path = blobs_dir.join(hash);
                // Simple heuristic: file mod time < 5 seconds ago = newly written
                if let Ok(meta) = std::fs::metadata(&path) {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(elapsed) = modified.elapsed() {
                            if elapsed.as_secs() < 5 {
                                mirrored += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(mirrored)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EcosystemFootprint {
    pub social_notes_count: usize,
    pub governance_ballots_count: usize,
    pub evidence_records_count: usize,
    pub kinship_entries_count: usize,
    pub media_blobs_count: usize,
    pub media_storage_bytes: u64,
    pub registered_ledgers_count: usize,
}

#[tauri::command]
fn get_ecosystem_footprint(app: AppHandle) -> Result<EcosystemFootprint, String> {
    let app_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;

    // 1. Social notes / events count in nostr_events.db or nostr.db
    let mut social_notes_count = 0;
    for db_name in &["nostr_events.db", "nostr.db"] {
        let db_path = app_data.join(db_name);
        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
                social_notes_count += nostr_relay::count_events(&db).unwrap_or(0);
            }
        }
    }

    // 2. Media blobs count & byte size in blobs/
    let blobs_dir = app_data.join("blobs");
    let mut media_blobs_count = 0;
    let mut media_storage_bytes: u64 = 0;
    if blobs_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&blobs_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if blossom::is_valid_hash(&name) && name == name.to_ascii_lowercase() {
                    media_blobs_count += 1;
                    if let Ok(meta) = entry.metadata() {
                        media_storage_bytes += meta.len();
                    }
                }
            }
        }
    }

    // 3. Count governance ballots & polls
    let mut governance_ballots_count = 0;
    let poll_ledger_candidates = [
        app_data.join("poll_ledger.json"),
        app_data.join("ledgers").join("poll_ledger.json"),
    ];
    for path in &poll_ledger_candidates {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(arr) = val.as_array() {
                        governance_ballots_count = arr.len();
                        break;
                    } else if let Some(obj) = val.as_object() {
                        if let Some(arr) = obj.get("votes").and_then(|v| v.as_array()) {
                            governance_ballots_count = arr.len();
                            break;
                        } else if let Some(arr) = obj.get("records").and_then(|v| v.as_array()) {
                            governance_ballots_count = arr.len();
                            break;
                        } else {
                            governance_ballots_count = obj.len();
                            break;
                        }
                    }
                }
            }
        }
    }

    // 4. Evidence vault records count (hive_ledger.json)
    let mut evidence_records_count = 0;
    let hive_ledger_candidates = [
        app_data.join("hive_ledger.json"),
        app_data.join("ledgers").join("hive_ledger.json"),
    ];
    for path in &hive_ledger_candidates {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(arr) = val.as_array() {
                        evidence_records_count = arr.len();
                        break;
                    } else if let Some(obj) = val.as_object() {
                        evidence_records_count = obj.len();
                        break;
                    }
                }
            }
        }
    }

    // 5. Kinship registry entries count (name_ledger.json)
    let mut kinship_entries_count = 0;
    let name_ledger_candidates = [
        app_data.join("name_ledger.json"),
        app_data.join("ledgers").join("name_ledger.json"),
    ];
    for path in &name_ledger_candidates {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(arr) = val.as_array() {
                        kinship_entries_count = arr.len();
                        break;
                    } else if let Some(obj) = val.as_object() {
                        kinship_entries_count = obj.len();
                        break;
                    }
                }
            }
        }
    }

    // 6. Scan registered ledgers in ledgers/ and app_data
    let mut registered_ledgers = std::collections::HashSet::new();
    let ledgers_dir = app_data.join("ledgers");
    if ledgers_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&ledgers_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".json") {
                    registered_ledgers.insert(name);
                }
            }
        }
    }
    let known_ledger_files = [
        "vault.json",
        "preferences.json",
        "poll_ledger.json",
        "hive_ledger.json",
        "name_ledger.json",
        "talk_journal.json",
        "pairing.json",
        "contacts.json",
        "credentials.json",
    ];
    for filename in &known_ledger_files {
        if app_data.join(filename).exists() {
            registered_ledgers.insert(filename.to_string());
        }
    }

    Ok(EcosystemFootprint {
        social_notes_count,
        governance_ballots_count,
        evidence_records_count,
        kinship_entries_count,
        media_blobs_count,
        media_storage_bytes,
        registered_ledgers_count: registered_ledgers.len(),
    })
}

#[tauri::command]
fn dispatch_nostr_event(
    app: AppHandle,
    kind: u32,
    content: String,
    tags: Vec<Vec<String>>,
    profile_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let (signing_key, _did) = resolve_profile_keypair(&app, profile_id)?;
    let verifying_key = signing_key.verifying_key();
    let pubkey_bytes = verifying_key.to_bytes();
    let pubkey_hex = hex::encode(pubkey_bytes);

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Time went backwards")?
        .as_secs() as i64;

    // NIP-01 serialized array for event id computation: [0, pubkey, created_at, kind, tags, content]
    let tags_val = serde_json::to_value(&tags).map_err(|e| e.to_string())?;
    let serialized = serde_json::to_string(&serde_json::json!([
        0,
        pubkey_hex,
        created_at,
        kind,
        tags_val,
        content
    ]))
    .map_err(|e| format!("Serialization failed: {}", e))?;

    let event_id_hash = Sha256::digest(serialized.as_bytes());
    let event_id_hex = hex::encode(event_id_hash);

    // Ed25519 signature over event_id raw bytes
    let signature = signing_key.sign(&event_id_hash);
    let sig_hex = hex::encode(signature.to_bytes());

    let event = serde_json::json!({
        "id": event_id_hex,
        "pubkey": pubkey_hex,
        "created_at": created_at,
        "kind": kind,
        "tags": tags,
        "content": content,
        "sig": sig_hex,
    });

    // Store in local nostr_events.db if available
    let app_data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data.join("nostr_events.db");
    if let Ok(conn) = rusqlite::Connection::open(&db_path) {
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                pubkey TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                kind INTEGER NOT NULL,
                tags TEXT NOT NULL,
                content TEXT NOT NULL,
                sig TEXT NOT NULL
            );",
            [],
        );
        let _ = conn.execute(
            "INSERT OR REPLACE INTO events (id, pubkey, created_at, kind, tags, content, sig) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                event_id_hex,
                pubkey_hex,
                created_at,
                kind as i64,
                serde_json::to_string(&tags).unwrap_or_default(),
                content,
                sig_hex
            ],
        );
    }

    Ok(event)
}

#[tauri::command]
fn get_enclave_diagnostics(
    app: AppHandle,
    _state: State<'_, ServiceState>,
) -> Result<serde_json::Value, String> {
    Ok(bridge::build_enclave_diagnostics(&app))
}

#[tauri::command]
fn record_backup_timestamp(app: AppHandle) -> Result<u64, String> {
    let mut prefs = load_preferences(&app);
    let now = chrono::Utc::now().timestamp() as u64;
    prefs.last_backup_at = now;
    save_preferences(&app, &prefs)?;
    Ok(now)
}

#[tauri::command]
fn get_relay_mesh(app: AppHandle) -> Result<Vec<String>, String> {
    let prefs = load_preferences(&app);
    Ok(prefs.relay_mesh)
}

#[tauri::command]
fn add_mesh_relay(app: AppHandle, relay_url: String) -> Result<Vec<String>, String> {
    let trimmed = relay_url.trim().to_string();
    if !trimmed.starts_with("ws://") && !trimmed.starts_with("wss://") {
        return Err("Relay URL must start with ws:// or wss://".to_string());
    }
    let mut prefs = load_preferences(&app);
    if !prefs.relay_mesh.contains(&trimmed) {
        prefs.relay_mesh.push(trimmed);
        save_preferences(&app, &prefs)?;
    }
    Ok(prefs.relay_mesh)
}

#[tauri::command]
fn remove_mesh_relay(app: AppHandle, relay_url: String) -> Result<Vec<String>, String> {
    let trimmed = relay_url.trim().to_string();
    let mut prefs = load_preferences(&app);
    prefs.relay_mesh.retain(|r| r != &trimmed);
    save_preferences(&app, &prefs)?;
    Ok(prefs.relay_mesh)
}

#[tauri::command]
fn reset_mesh_relays(app: AppHandle) -> Result<Vec<String>, String> {
    let mut prefs = load_preferences(&app);
    prefs.relay_mesh = default_relay_mesh();
    save_preferences(&app, &prefs)?;
    Ok(prefs.relay_mesh)
}

// ---------- app entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the process-level crypto provider for rustls 0.23+
    let _ = rustls::crypto::ring::default_provider().install_default();

    let initial_services = HashMap::new();
    let service_state = ServiceState {
        services: Mutex::new(initial_services),
        active_did: Mutex::new(None),
        shutdown_signals: Mutex::new(HashMap::new()),
        auto_start_settings: Mutex::new(HashMap::new()),
    };
    let ws_state = WsState::default();
    let transit_state = TransitState::default();
    let pairing_state = pairing::PairFrameState::default();

    let builder = tauri::Builder::default()
        .manage(service_state)
        .manage(ws_state)
        .manage(transit_state)
        .manage(pairing_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            let auto_start = load_auto_start_settings(&app_handle);
            {
                let state = app_handle.state::<ServiceState>();
                *state.auto_start_settings.lock().unwrap() = auto_start.clone();
            }
            // Auto-start configured local services. This loop intentionally
            // only starts lightweight PDS services (Blossom, Nostr relay,
            // Chat).  IPFS node/DHT initialization must NEVER be added here
            // — that responsibility belongs to server-side infrastructure.
            for (name, enabled) in &auto_start {
                if *enabled {
                    let app = app_handle.clone();
                    let name = name.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<ServiceState>();
                        if let Err(e) = start_service_internal(&name, &app, &state).await {
                            eprintln!("Auto-start {} failed: {}", name, e);
                        }
                    });
                }
            }

            let ws_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                bridge::start_ws_server(ws_handle).await;
            });

            // Native System Tray
            tray::build_tray(app)?;

            // Native Application Menu (macOS Native Menu Bar & desktop shortcuts)
            let app_menu = tray::build_app_menu(app)?;
            let _ = app.set_menu(app_menu);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            toggle_service,
            generate_did,
            import_did,
            get_active_did,
            list_profiles,
            add_profile,
            set_active_profile,
            remove_profile,
            sign_auth_challenge,
            get_public_did_document,
            submit_ws_response,
            submit_ws_event_response,
            submit_ws_credential_response,
            show_main_window,
            register_challenge_pipe,
            get_auto_start_settings,
            set_auto_start,
            get_user_preferences,
            save_user_preferences,
            get_service_statuses,
            sync_vote_records,
            get_vote_history,
            calculate_vote_merkle_root,
            sync_poll_ledger,
            save_credential,
            import_verifiable_credential,
            get_credentials,
            store_credential,
            delete_credential,
            submit_ws_credential_presentation,
            list_contacts,
            upsert_contact,
            delete_contact,
            import_disclosure_card,
            generate_disclosure_card,
            resolve_peer_aliases,
            derive_prf_identity,
            generate_transit_keypair,
            process_graduation_ingest,
            activate_sovereign_identity,
            rotate_primary_persona,
            reveal_master_seed,
            get_vault_status,
            set_seed_backup_confirmed,
            pair_begin,
            pair_seal_seed_for_device,
            pair_confirm,
            pair_list_devices,
            pair_revoke_device,
            get_chat_session_credentials,
            omemo_publish_bundle,
            omemo_fetch_peer_bundle,
            omemo_list_devices,
            create_vault_backup,
            restore_vault_backup,
            revoke_all_sessions,
            write_binary_file,
            read_binary_file,
            list_local_blobs,
            delete_local_blob,
            get_local_blobs_count,
            get_sync_status,
            trigger_manual_sync,
            get_ecosystem_footprint,
            dispatch_nostr_event,
            get_enclave_diagnostics,
            record_backup_timestamp,
            get_relay_mesh,
            add_mesh_relay,
            remove_mesh_relay,
            reset_mesh_relays,
        ]);

    builder
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if label == "main" {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    api.prevent_close();
                }
            }
            RunEvent::Exit => {
                let state = app_handle.state::<ServiceState>();
                let shutdown_signals = state.shutdown_signals.lock().unwrap();
                for (_, tx) in shutdown_signals.iter() {
                    let _ = tx.send(true);
                }
            }
            _ => {}
        });
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    fn create_test_state() -> ServiceState {
        let initial_services = HashMap::new();
        ServiceState {
            services: Mutex::new(initial_services),
            active_did: Mutex::new(None),
            shutdown_signals: Mutex::new(HashMap::new()),
            auto_start_settings: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn test_toggle_service_start() {
        let state = create_test_state();
        let service_name = "TestService".to_string();
        let result = toggle_service_logic(service_name.clone(), "start".to_string(), &state);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), ServiceStatus::Running);
    }

    #[test]
    fn test_toggle_service_stop() {
        let state = create_test_state();
        let service_name = "TestService".to_string();
        let _ = toggle_service_logic(service_name.clone(), "start".to_string(), &state);
        let result = toggle_service_logic(service_name.clone(), "stop".to_string(), &state);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), ServiceStatus::Stopped);
    }

    #[test]
    fn test_sign_auth_challenge_logic() {
        let mut path = temp_dir();
        path.push("test_vault_sign_logic.json");

        let vault_store = vault::create_vault_at_path(&path).expect("Should create vault");
        let kp =
            vault::get_profile_keypair(&vault_store, "primary").expect("Should derive keypair");

        let challenge = "test-challenge-uuid-1234";
        let vp_json_str = sign_challenge_with_keypair(&kp.signing_key, &kp.did, challenge)
            .expect("Should sign successfully");
        let vp: serde_json::Value =
            serde_json::from_str(&vp_json_str).expect("Should be valid JSON");

        assert_eq!(vp["challenge"].as_str().unwrap(), challenge);
        assert_eq!(vp["holder"].as_str().unwrap(), kp.did);
        assert!(
            vp.get("proof").is_some(),
            "VP should contain a proof object"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_preferences_round_trip() {
        let mut path = temp_dir();
        path.push("test_preferences.json");

        let prefs = UserPreferences {
            active_profile_id: "test_profile".to_string(),
            default_signing_profile: "signing_profile".to_string(),
            auto_sign: true,
            last_active_tab: "keys".to_string(),
            active_sovereign_did: None,
            last_synced_at: 1756241000,
            seed_backup_confirmed: true,
            app_lock_enabled: true,
            inactivity_timeout_minutes: 5,
            app_lock_pin_hash: Some("deadbeef".to_string()),
            app_lock_prf_hash: None,
            last_backup_at: 1700000000,
            relay_mesh: vec!["wss://custom.relay.io".to_string()],
        };

        let json = serde_json::to_string(&prefs).expect("Should serialize");
        std::fs::write(&path, &json).expect("Should write");

        let loaded_json = std::fs::read_to_string(&path).expect("Should read");
        let loaded: UserPreferences =
            serde_json::from_str(&loaded_json).expect("Should deserialize");

        assert_eq!(loaded.active_profile_id, "test_profile");
        assert_eq!(loaded.default_signing_profile, "signing_profile");
        assert!(loaded.auto_sign);
        assert_eq!(loaded.last_active_tab, "keys");
        assert_eq!(loaded.last_synced_at, 1756241000);
        assert!(loaded.seed_backup_confirmed);
        assert!(loaded.app_lock_enabled);
        assert_eq!(loaded.inactivity_timeout_minutes, 5);
        assert_eq!(loaded.app_lock_pin_hash.as_deref(), Some("deadbeef"));
        assert_eq!(loaded.last_backup_at, 1700000000);
        assert_eq!(loaded.relay_mesh, vec!["wss://custom.relay.io"]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_preferences_defaults() {
        let prefs = UserPreferences::default();
        assert_eq!(prefs.active_profile_id, "primary");
        assert_eq!(prefs.default_signing_profile, "primary");
        assert!(!prefs.auto_sign);
        assert_eq!(prefs.last_active_tab, "services");
        assert_eq!(prefs.last_synced_at, 0);
        assert!(!prefs.seed_backup_confirmed);
        assert!(!prefs.app_lock_enabled);
        assert_eq!(prefs.inactivity_timeout_minutes, 15);
        assert!(prefs.app_lock_pin_hash.is_none());
        assert!(prefs.app_lock_prf_hash.is_none());
        assert_eq!(prefs.last_backup_at, 0);
        assert_eq!(prefs.relay_mesh.len(), 3);
        assert!(prefs.relay_mesh.contains(&"wss://relay.iyou.me".to_string()));
    }

    #[test]
    fn test_set_active_profile_validation() {
        let mut path = temp_dir();
        path.push("test_vault_profile_switch.json");

        let vault_store = vault::create_vault_at_path(&path).expect("Should create vault");
        let profile = vault::add_profile(
            &mut vault_store.clone(),
            "test_profile".to_string(),
            "Test Profile".to_string(),
        )
        .expect("Should add profile");

        // Test successful profile switch
        let mut prefs = UserPreferences::default();
        prefs.active_profile_id = profile.profile_id.clone();

        // Verify the profile was created with expected properties
        assert!(
            !profile.profile_id.is_empty(),
            "Profile ID should not be empty"
        );
        assert!(
            profile.profile_id.contains("test_profile"),
            "Profile ID should contain test_profile"
        );
        assert_eq!(profile.derivation_index, 2, "Should be derivation index 2");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_profile_removal_fallback() {
        let mut path = temp_dir();
        path.push("test_vault_profile_remove.json");

        let mut vault_store = vault::create_vault_at_path(&path).expect("Should create vault");
        let profile = vault::add_profile(
            &mut vault_store,
            "temp_profile".to_string(),
            "Temp Profile".to_string(),
        )
        .expect("Should add profile");

        // Verify profile was added
        assert_eq!(vault_store.profiles.len(), 3);

        // Remove the profile
        vault::remove_profile(&mut vault_store, &profile.profile_id)
            .expect("Should remove profile");

        // Verify profile was removed
        assert_eq!(vault_store.profiles.len(), 2);
        assert_eq!(vault_store.profiles[0].profile_id, vault::ANCHOR_PROFILE_ID);
        assert_eq!(
            vault_store.profiles[1].profile_id,
            vault::DEFAULT_PERSONA_PROFILE_ID
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_ecosystem_footprint_structure() {
        let footprint = EcosystemFootprint {
            social_notes_count: 42,
            governance_ballots_count: 5,
            evidence_records_count: 12,
            kinship_entries_count: 3,
            media_blobs_count: 7,
            media_storage_bytes: 1048576,
            registered_ledgers_count: 6,
        };

        let json = serde_json::to_string(&footprint).expect("Should serialize");
        let parsed: EcosystemFootprint = serde_json::from_str(&json).expect("Should deserialize");
        assert_eq!(parsed.social_notes_count, 42);
        assert_eq!(parsed.media_storage_bytes, 1048576);
        assert_eq!(parsed.registered_ledgers_count, 6);
    }
}
