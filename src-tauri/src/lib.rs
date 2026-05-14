use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;
use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use ed25519_dalek::Signer;
use sha2::{Digest, Sha256};
mod vault;
mod blossom;
mod nostr_relay;
mod prosody;

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
    pub shutdown_signals: Mutex<HashMap<String, watch::Sender<bool>>>,
}

// State for WS requests
#[derive(Default)]
pub struct WsState {
    pub response_sender: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    pub challenge_channel: Mutex<Option<tauri::ipc::Channel<String>>>,
}

// ... existing commands ...
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
            *status = ServiceStatus::Running;
        }
        "stop" => {
            *status = ServiceStatus::Stopped;
        }
        _ => return Err("Invalid action".to_string()),
    }
    Ok(status.clone())
}

async fn start_service_internal(name: &str, app: &AppHandle, state: &ServiceState) -> Result<(), String> {
    {
        let shutdown_signals = state.shutdown_signals.lock().unwrap();
        if shutdown_signals.contains_key(name) {
            return Err("Service already running".to_string());
        }
    }

    let tx = match name {
        "Nostr" => {
            let app_data = app.path().app_local_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?;
            let store = vault::load_identity(app)?;
            let pubkey = nostr_relay::derive_vault_pubkey(&store)?;
            let db_path = app_data.join("nostr_events.db");
            let listener = TcpListener::bind("127.0.0.1:9003").await
                .map_err(|e| format!("Failed to bind Nostr relay: {}", e))?;
            let (tx, rx) = watch::channel(false);
            tauri::async_runtime::spawn(async move {
                nostr_relay::start_relay(db_path, listener, rx, pubkey).await;
            });
            tx
        }
        "Blossom" => {
            let app_data = app.path().app_local_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?;
            let blobs_dir = app_data.join("blobs");
            let (tx, rx) = watch::channel(false);
            tauri::async_runtime::spawn(async move {
                blossom::start_blossom_server(blobs_dir, rx).await;
            });
            tx
        }
        "Chat" => {
            let app_data = app.path().app_local_data_dir()
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
            let listener = TcpListener::bind("127.0.0.1:5222").await
                .map_err(|e| format!("Failed to bind XMPP: {}", e))?;
            let (tx, rx) = watch::channel(false);
            tauri::async_runtime::spawn(async move {
                prosody::start_xmpp_server(listener, rx, password).await;
            });
            tx
        }
        _ => return Ok(()),
    };

    state.shutdown_signals.lock().unwrap().insert(name.to_string(), tx);
    Ok(())
}

fn stop_service_internal(name: &str, state: &ServiceState) {
    let mut shutdown_signals = state.shutdown_signals.lock().unwrap();
    if let Some(tx) = shutdown_signals.remove(name) {
        let _ = tx.send(true);
    }
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
    sign_auth_challenge_logic(&store, &challenge)
}

fn sign_auth_challenge_logic(
    store: &vault::IdentityStore,
    challenge: &str,
) -> Result<String, String> {
    let presentation = serde_json::json!({
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "type": ["VerifiablePresentation"],
        "holder": store.did,
        "challenge": challenge,
        "verifiableCredential": []
    });
    let vp_json = presentation.to_string();
    did_rust::issue_vc(&vp_json, &store.did, &store.private_key_base58)
        .map_err(|e| format!("Failed to sign presentation: {}", e))
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
    *state.challenge_channel.lock().unwrap() = Some(channel);
    println!("DEBUG: Challenge channel registered by React");
}

#[tauri::command]
async fn submit_ws_response(
    _id: String,
    challenge: String,
    approved: bool,
    app: AppHandle,
    ws_state: State<'_, WsState>,
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

    let store = vault::load_identity(&app)?;
    let signed_vp = sign_auth_challenge_logic(&store, &challenge)?;
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

    let store = vault::load_identity(&app)?;

    let mut event: serde_json::Value = serde_json::from_str(&event_json)
        .map_err(|e| format!("Failed to parse event JSON: {}", e))?;

    let pubkey = event["pubkey"].as_str().unwrap_or("");
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

    let key_bytes = bs58::decode(&store.private_key_base58)
        .into_vec()
        .map_err(|_| "Invalid base58 private key".to_string())?;

    if key_bytes.len() != 32 {
        return Err("Invalid private key length".to_string());
    }

    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key_bytes);
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&arr);
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

    let store = vault::load_identity(&app)?;

    let credential_value: serde_json::Value = serde_json::from_str(&credential_json)
        .map_err(|e| format!("Failed to parse credential JSON: {}", e))?;

    let credential_envelope = serde_json::json!({
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "type": ["VerifiableCredential"],
        "issuer": holder_did,
        "credentialSubject": credential_value
    });

    let envelope_str = credential_envelope.to_string();
    let signed_vc = did_rust::issue_vc(&envelope_str, &holder_did, &store.private_key_base58)
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

fn is_websocket_upgrade_request(data: &[u8]) -> bool {
    let text = String::from_utf8_lossy(data);
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() || !lines[0].starts_with("GET") {
        return false;
    }
    let lowercase_headers: Vec<String> = lines.iter().map(|l| l.trim().to_lowercase()).collect();

    let has_upgrade = lowercase_headers.iter().any(|l| l.starts_with("upgrade:"));
    let has_connection_upgrade = lowercase_headers
        .iter()
        .any(|l| l.starts_with("connection:") && l.contains("upgrade"));
    let has_ws_key = lowercase_headers
        .iter()
        .any(|l| l.starts_with("sec-websocket-key:"));

    has_upgrade && has_connection_upgrade && has_ws_key
}

async fn handle_connection(stream: TcpStream, app_handle: AppHandle) {
    let mut peek_buf = [0u8; 1024];
    let n = match stream.peek(&mut peek_buf).await {
        Ok(0) | Err(_) => return,
        Ok(n) => n,
    };

    let data = &peek_buf[..n];

    // First-Match-Wins dispatcher
    if data.starts_with(b"OPTIONS") {
        handle_options_preflight(stream).await;
    } else if is_websocket_upgrade_request(data) {
        handle_ws_connection(stream, app_handle).await;
    }
    // else: silently drop non-matching connections (non-GET, non-WS GET, etc.)
}

async fn handle_options_preflight(mut stream: TcpStream) {
    println!("OPTIONS pre-flight received");
    let response = b"HTTP/1.1 200 OK\r\n\
        Access-Control-Allow-Origin: *\r\n\
        Access-Control-Allow-Private-Network: true\r\n\
        Access-Control-Allow-Methods: GET, OPTIONS\r\n\
        Access-Control-Allow-Headers: *\r\n\
        Content-Length: 0\r\n\
        Connection: keep-alive\r\n\r\n";
    let _ = stream.write_all(response).await;
}

async fn handle_ws_connection(stream: TcpStream, app_handle: AppHandle) {
    let cors_callback = |req: &tauri::http::Request<()>, mut res: tauri::http::Response<()>| {
        println!("DEBUG: Handshake callback triggered");
        println!("DEBUG: Request method: {:?}", req.method());
        res.headers_mut()
            .insert("Access-Control-Allow-Origin",
                tauri::http::HeaderValue::from_static("*"));
        res.headers_mut()
            .insert("Access-Control-Allow-Private-Network",
                tauri::http::HeaderValue::from_static("true"));
        Ok(res)
    };

    let ws_stream = match accept_hdr_async(stream, cors_callback).await {
        Ok(ws) => {
            println!("DEBUG: WebSocket Upgrade Complete");
            ws
        }
        Err(e) => {
            eprintln!("WebSocket handshake failed: {}", e);
            return;
        }
    };

    let (response_tx, response_rx) = mpsc::unbounded_channel::<Message>();

    {
        let ws_state = app_handle.state::<WsState>();
        *ws_state.response_sender.lock().unwrap() = Some(response_tx.clone());
    }

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    let app_clone = app_handle.clone();
    tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(10));
        tokio::pin!(response_rx);
        loop {
            tokio::select! {
                msg = response_rx.recv() => {
                    let msg = match msg {
                        Some(msg) => msg,
                        None => break,
                    };
                    println!("Sending response over WebSocket: {:?}", msg);
                    if let Err(e) = ws_sender.send(msg).await {
                        eprintln!("Failed to send WS message: {}", e);
                        break;
                    }
                }
                _ = heartbeat.tick() => {
                    if let Err(e) = ws_sender.send(Message::Ping(vec![])).await {
                        eprintln!("Failed to send Ping: {}", e);
                        break;
                    }
                    println!("Heartbeat Ping sent");
                }
            }
        }
        let ws_state = app_clone.state::<WsState>();
        *ws_state.response_sender.lock().unwrap() = None;
        println!("DEBUG: Forwarder Task Exited");
    });

    while let Some(Ok(msg)) = ws_receiver.next().await {
        if msg.is_text() {
            let text = msg.to_text().unwrap().to_string();
            println!("Received Message: {:?}", text);
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                let is_sign = json["action"] == "sign" || json["type"] == "sign";
                if is_sign && json["challenge"].is_string() {
                    let challenge = json["challenge"].as_str().unwrap().to_string();
                    println!("Triggering Signature for Challenge: {}", challenge);
                    println!("DEBUG: Spawning background task to handle sign challenge...");

                    let app_handle = app_handle.clone();
                    tokio::spawn(async move {
                        let app = app_handle;

                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }

                        {
                            let state = app.state::<WsState>();
                            let pipe = state.challenge_channel.lock().unwrap();
                            if let Some(channel) = pipe.as_ref() {
                                let msg = serde_json::json!({
                                    "__type__": "sign",
                                    "challenge": challenge
                                });
                                let _ = channel.send(msg.to_string());
                                println!("!!! SUCCESS: CHALLENGE PIPED TO REACT BACKGROUND TASK !!!");
                            } else {
                                println!("!!! CRITICAL ERROR: REACT HAS NOT REGISTERED THE PIPE !!!");
                            }
                        }
                    });
                } else if json["type"] == "sign_event" || json["action"] == "sign_event" {
                    if json["event"].is_object() {
                        let event = json["event"].clone();
                        println!("Triggering Nostr Event signing");

                        let app_handle = app_handle.clone();
                        tokio::spawn(async move {
                            let app = app_handle;

                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }

                            {
                                let state = app.state::<WsState>();
                                let pipe = state.challenge_channel.lock().unwrap();
                                if let Some(channel) = pipe.as_ref() {
                                    let msg = serde_json::json!({
                                        "__type__": "sign_event",
                                        "event": event
                                    });
                                    let _ = channel.send(msg.to_string());
                                    println!("!!! NOSTR EVENT SENT TO REACT FOR SIGNING !!!");
                                } else {
                                    println!("!!! CRITICAL ERROR: REACT HAS NOT REGISTERED THE PIPE !!!");
                                }
                            }
                        });
                    } else {
                        println!("DEBUG: Received sign_event without event object: {}", text);
                    }
                } else if json["type"] == "sign_credential" {
                    if json["credential"].is_object() && json["holder_did"].is_string() {
                        let credential = json["credential"].clone();
                        let holder_did = json["holder_did"].as_str().unwrap().to_string();
                        println!("Triggering Credential signing for holder: {}", holder_did);

                        let app_handle = app_handle.clone();
                        tokio::spawn(async move {
                            let app = app_handle;

                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }

                            {
                                let state = app.state::<WsState>();
                                let pipe = state.challenge_channel.lock().unwrap();
                                if let Some(channel) = pipe.as_ref() {
                                    let msg = serde_json::json!({
                                        "__type__": "sign_credential",
                                        "credential": credential,
                                        "holder_did": holder_did
                                    });
                                    let _ = channel.send(msg.to_string());
                                    println!("!!! CREDENTIAL SENT TO REACT FOR SIGNING !!!");
                                } else {
                                    println!("!!! CRITICAL ERROR: REACT HAS NOT REGISTERED THE PIPE !!!");
                                }
                            }
                        });
                    } else {
                        println!("DEBUG: Received sign_credential without credential object or holder_did: {}", text);
                    }
                } else {
                    println!("DEBUG: Received unknown JSON structure: {}", text);
                }
            }
        } else if msg.is_pong() {
            println!("Heartbeat Pong received");
        }
    }
    println!("DEBUG: WebSocket Read Loop Exited");

    let ws_state = app_handle.state::<WsState>();
    *ws_state.response_sender.lock().unwrap() = None;
}

async fn listen_on(addrs: &str, app: AppHandle) {
    let listener = TcpListener::bind(addrs).await.unwrap_or_else(|e| {
        panic!("Failed to bind WS on {}: {}", addrs, e);
    });
    println!("WebSocket server listening on ws://{}", addrs);

    while let Ok((stream, peer)) = listener.accept().await {
        println!("TCP Connection received from: {:?}", peer);
        let app_handle = app.clone();
        tokio::spawn(async move {
            handle_connection(stream, app_handle).await;
        });
    }
}

async fn start_ws_server(app: AppHandle) {
    listen_on("[::]:9001", app).await;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_services = HashMap::new();
    let service_state = ServiceState {
        services: Mutex::new(initial_services),
        active_did: Mutex::new(None),
        shutdown_signals: Mutex::new(HashMap::new()),
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

            let ws_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                start_ws_server(ws_handle).await;
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
            submit_ws_event_response,
            submit_ws_credential_response,
            show_main_window,
            register_challenge_pipe,
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

#[cfg(test)]
mod tests {
    use super::*;
    fn create_test_state() -> ServiceState {
        let initial_services = HashMap::new();
        ServiceState {
            services: Mutex::new(initial_services),
            active_did: Mutex::new(None),
            shutdown_signals: Mutex::new(HashMap::new()),
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
        // Generate a real DID for testing the signing logic
        let generated_json_str = did_rust::generate_did("key").expect("Should generate DID");
        let parsed: serde_json::Value = serde_json::from_str(&generated_json_str).unwrap();

        let store = vault::IdentityStore {
            did: parsed["did"].as_str().unwrap().to_string(),
            private_key_base58: parsed["private_key_base58"].as_str().unwrap().to_string(),
        };

        let challenge = "test-challenge-uuid-1234";

        let vp_json_str =
            sign_auth_challenge_logic(&store, challenge).expect("Should sign successfully");

        let vp: serde_json::Value =
            serde_json::from_str(&vp_json_str).expect("Should be valid JSON");

        assert_eq!(vp["challenge"].as_str().unwrap(), challenge);
        assert_eq!(vp["holder"].as_str().unwrap(), store.did);
        assert!(
            vp.get("proof").is_some(),
            "VP should contain a proof object"
        );
    }
}
