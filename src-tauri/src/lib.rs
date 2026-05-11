use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::accept_async;
use uuid::Uuid;

mod vault;

// Define the service status enum
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceStatus {
    Running,
    Stopped,
    Starting,
}

// Create a state management struct
pub struct ServiceState {
    pub services: Mutex<HashMap<String, ServiceStatus>>,
    pub active_did: Mutex<Option<String>>,
}

// State for WS requests
pub struct WsState {
    pub pending_requests: Mutex<HashMap<String, oneshot::Sender<Option<String>>>>,
}

#[derive(Serialize, Clone)]
struct SignRequestEvent {
    id: String,
    challenge: String,
}

// ... existing commands ...
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn toggle_service(
    name: String,
    action: String,
    state: State<'_, ServiceState>,
) -> Result<ServiceStatus, String> {
    toggle_service_logic(name, action, &state)
}

// Core logic separated for testability
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
            *status = ServiceStatus::Starting;
            *status = ServiceStatus::Running;
        }
        "stop" => {
            *status = ServiceStatus::Stopped;
        }
        _ => return Err("Invalid action".to_string()),
    }
    Ok(status.clone())
}

#[tauri::command]
fn generate_did(app: AppHandle, state: State<'_, ServiceState>) -> Result<String, String> {
    let generated_json_str =
        did_rust::generate_did("key").map_err(|e| format!("Generation failed: {}", e))?;
    let parsed: serde_json::Value = serde_json::from_str(&generated_json_str)
        .map_err(|_| "Failed to parse generated DID".to_string())?;
    let did = parsed["did"].as_str().unwrap_or("").to_string();
    let priv_key = parsed["private_key_base58"]
        .as_str()
        .unwrap_or("")
        .to_string();

    vault::save_identity(&app, did.clone(), priv_key)?;

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
    vault::save_identity(&app, did.clone(), private_key)?;
    let mut active = state.active_did.lock().unwrap();
    *active = Some(did);
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
    if let Ok(store) = vault::load_identity(&app) {
        let mut active = state.active_did.lock().unwrap();
        *active = Some(store.did.clone());
        return Some(store.did);
    }
    None
}

#[tauri::command]
fn sign_auth_challenge(
    app: AppHandle,
    challenge: String,
    did_id: String,
) -> Result<String, String> {
    let store = vault::load_identity(&app)?;
    if store.did != did_id {
        return Err("Requested DID does not match the active Vault identity".to_string());
    }
    let presentation = serde_json::json!({
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "type": ["VerifiablePresentation"],
        "holder": store.did,
        "challenge": challenge,
        "verifiableCredential": []
    });
    let vp_json = presentation.to_string();
    let signed_vp = did_rust::issue_vc(&vp_json, &store.did, &store.private_key_base58)
        .map_err(|e| format!("Failed to sign presentation: {}", e))?;
    Ok(signed_vp)
}

#[tauri::command]
fn get_public_did_document(did: String) -> Result<String, String> {
    did_rust::resolve_did(&did).map_err(|e| format!("Failed to resolve DID document: {}", e))
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// Improved command that handles the signing
#[tauri::command]
async fn submit_ws_response(
    id: String,
    challenge: String,
    approved: bool,
    app: AppHandle,
    ws_state: State<'_, WsState>,
) -> Result<(), String> {
    let mut requests = ws_state.pending_requests.lock().unwrap();
    if let Some(tx) = requests.remove(&id) {
        if approved {
            let did =
                get_active_did(app.clone(), app.state::<ServiceState>()).ok_or("No active DID")?;
            let signed_vp = sign_auth_challenge(app, challenge, did)?;
            let _ = tx.send(Some(signed_vp));
        } else {
            let _ = tx.send(None);
        }
    }
    Ok(())
}

async fn start_ws_server(app: AppHandle) {
    let listener = TcpListener::bind("127.0.0.1:9001")
        .await
        .expect("Failed to bind WS");
    println!("WebSocket server listening on ws://127.0.0.1:9001");

    while let Ok((stream, _)) = listener.accept().await {
        let app_handle = app.clone();
        tokio::spawn(async move {
            if let Ok(mut ws_stream) = accept_async(stream).await {
                while let Some(Ok(msg)) = ws_stream.next().await {
                    if msg.is_text() {
                        let text = msg.to_text().unwrap();
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
                            if json["action"] == "sign" && json["challenge"].is_string() {
                                let challenge = json["challenge"].as_str().unwrap().to_string();
                                let request_id = Uuid::new_v4().to_string();

                                let (tx, rx) = oneshot::channel();
                                {
                                    let ws_state = app_handle.state::<WsState>();
                                    ws_state
                                        .pending_requests
                                        .lock()
                                        .unwrap()
                                        .insert(request_id.clone(), tx);
                                }

                                // Emit event to frontend
                                let _ = app_handle.emit(
                                    "ws-sign-request",
                                    SignRequestEvent {
                                        id: request_id,
                                        challenge: challenge,
                                    },
                                );

                                // Wait for user approval
                                if let Ok(Some(signed_vp)) = rx.await {
                                    let response = serde_json::json!({
                                        "status": "success",
                                        "vp": signed_vp
                                    });
                                    let _ = ws_stream
                                        .send(tokio_tungstenite::tungstenite::Message::Text(
                                            response.to_string().into(),
                                        ))
                                        .await;
                                } else {
                                    let _ = ws_stream
                                        .send(tokio_tungstenite::tungstenite::Message::Text(
                                            "{\"status\":\"denied\"}".into(),
                                        ))
                                        .await;
                                }
                            }
                        }
                    }
                }
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_services = HashMap::new();
    let service_state = ServiceState {
        services: Mutex::new(initial_services),
        active_did: Mutex::new(None),
    };
    let ws_state = WsState {
        pending_requests: Mutex::new(HashMap::new()),
    };

    let builder = tauri::Builder::default()
        .manage(service_state)
        .manage(ws_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            tokio::spawn(async move {
                start_ws_server(app_handle).await;
            });

            let quit_i = tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
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
            sign_auth_challenge,
            get_public_did_document,
            submit_ws_response,
            show_main_window
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
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn create_test_state() -> ServiceState {
        let initial_services = HashMap::new();
        ServiceState {
            services: Mutex::new(initial_services),
            active_did: Mutex::new(None),
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
}
