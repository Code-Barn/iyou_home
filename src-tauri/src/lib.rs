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

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;
use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use ed25519_dalek::Signer;
use sha2::{Digest, Sha256};
mod vault;
mod bridge;
mod blossom;
mod nostr_relay;
mod prosody;

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

pub struct WsState {
    pub response_sender: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    pub challenge_channel: Mutex<Option<tauri::ipc::Channel<String>>>,
    pub pending_messages: Mutex<Vec<String>>,
}

impl Default for WsState {
    fn default() -> Self {
        Self {
            response_sender: Mutex::new(None),
            challenge_channel: Mutex::new(None),
            pending_messages: Mutex::new(Vec::new()),
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
            let vault = vault::load_vault(app)?;
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
                prosody::start_xmpp_server(listener, rx, password).await;
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
    let vault = if let Ok(v) = vault::load_vault(&app) {
        v
    } else {
        vault::create_vault(&app)?
    };

    let did = vault.profiles[0].did.clone();
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
    let mut vault = if let Ok(v) = vault::load_vault(&app) {
        v
    } else {
        let seed = bs58::decode(&private_key)
            .into_vec()
            .map_err(|_| "Invalid base58 private key".to_string())?;
        let mut arr = [0u8; 32];
        if seed.len() != 32 {
            return Err("Private key must be 32 bytes".to_string());
        }
        arr.copy_from_slice(&seed);
        let root_seed_base58 = bs58::encode(arr).into_string();
        let kp = vault::derive_deterministic_keypair(&arr, 0);
        vault::VaultStore {
            root_seed_base58,
            profiles: vec![vault::Profile {
                profile_id: "primary".to_string(),
                profile_name: "Primary Identity".to_string(),
                derivation_index: 0,
                did: kp.did,
            }],
        }
    };

    if vault::get_profile_by_id(&vault, &did).is_none() {
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
fn get_active_did(app: AppHandle, state: State<'_, ServiceState>) -> Option<String> {
    {
        let active = state.active_did.lock().unwrap();
        if let Some(did) = active.clone() {
            return Some(did);
        }
    }
    if let Ok(vault) = vault::load_vault(&app) {
        if let Some(profile) = vault.profiles.first() {
            let mut active = state.active_did.lock().unwrap();
            *active = Some(profile.did.clone());
            return Some(profile.did.clone());
        }
    }
    None
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
    profile_id: Option<String>,
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

    let (signing_key, did) = resolve_profile_keypair(&app, profile_id)?;

    let mut event: serde_json::Value = serde_json::from_str(&event_json)
        .map_err(|e| format!("Failed to parse event JSON: {}", e))?;

    let pubkey = event["pubkey"].as_str().unwrap_or(&did);
    let created_at = event["created_at"].as_i64().unwrap_or(0);
    let kind = event["kind"].as_i64().unwrap_or(1);
    let tags = event.get("tags").cloned().unwrap_or(serde_json::json!([]));
    let content = event["content"].as_str().unwrap_or("");

    let serialized = serde_json::to_string(&serde_json::json!([
        0, pubkey, created_at, kind, tags, content
    ]))
    .map_err(|e| format!("Failed to serialize event: {}", e))?;

    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    let id_bytes = hasher.finalize();
    let id_b64 = base64.encode(id_bytes);

    let signature = signing_key.sign(&id_bytes);
    let sig_bytes = signature.to_bytes();
    let sig_b64 = base64.encode(sig_bytes);

    event["id"] = serde_json::Value::String(id_b64);
    event["sig"] = serde_json::Value::String(sig_b64);

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
    let signed_vc =
        did_rust::issue_vc(&envelope_str, &did, &key_b58)
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

// ---------- auto-start settings ----------

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

#[tauri::command]
fn get_auto_start_settings(state: State<'_, ServiceState>) -> HashMap<String, bool> {
    state.auto_start_settings.lock().unwrap().clone()
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

// ---------- app entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_services = HashMap::new();
    let service_state = ServiceState {
        services: Mutex::new(initial_services),
        active_did: Mutex::new(None),
        shutdown_signals: Mutex::new(HashMap::new()),
        auto_start_settings: Mutex::new(HashMap::new()),
    };
    let ws_state = WsState::default();

    let builder = tauri::Builder::default()
        .manage(service_state)
        .manage(ws_state)
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

            let quit_i =
                tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i =
                tauri::menu::MenuItem::with_id(app, "show", "Show Hub", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show_i, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;

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
            sign_auth_challenge,
            get_public_did_document,
            submit_ws_response,
            submit_ws_event_response,
            submit_ws_credential_response,
            show_main_window,
            register_challenge_pipe,
            get_auto_start_settings,
            set_auto_start,
            get_service_statuses,
        ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if label == "main" {
                    let window = app_handle.get_webview_window("main").unwrap();
                    let _ = window.hide();
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

        let vault_store =
            vault::create_vault_at_path(&path).expect("Should create vault");
        let kp = vault::get_profile_keypair(&vault_store, "primary")
            .expect("Should derive keypair");

        let challenge = "test-challenge-uuid-1234";
        let vp_json_str =
            sign_challenge_with_keypair(&kp.signing_key, &kp.did, challenge)
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
}
