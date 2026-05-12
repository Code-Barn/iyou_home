use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;
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
    pub response_sender: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    pub pending_challenge: Mutex<Option<String>>,
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
fn get_pending_ws_challenge(ws_state: State<'_, WsState>) -> Option<String> {
    ws_state.pending_challenge.lock().unwrap().take()
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
async fn submit_ws_response(
    _id: String,
    challenge: String,
    approved: bool,
    app: AppHandle,
    ws_state: State<'_, WsState>,
) -> Result<(), String> {
    *ws_state.pending_challenge.lock().unwrap() = None;

    let guard = ws_state.response_sender.lock().unwrap();
    let sender = guard.as_ref().ok_or("No WebSocket connected")?;

    if !approved {
        let _ = sender.send(Message::Text("{\"status\":\"denied\"}".into()));
        println!("WS sign request denied by user");
        return Ok(());
    }

    let store = vault::load_identity(&app)?;
    let signed_vp = sign_auth_challenge_logic(&store, &challenge)?;

    let response = serde_json::json!({
        "type": "signature",
        "vp": signed_vp
    });

    println!("Sending signed VP back to browser");
    let _ = sender.send(Message::Text(response.to_string().into()));
    Ok(())
}

async fn handle_connection(mut stream: TcpStream, app_handle: AppHandle) {
    let mut peek_buf = [0u8; 4];
    let n = match stream.peek(&mut peek_buf).await {
        Ok(0) | Err(_) => return,
        Ok(n) => n,
    };

    if n >= 4 && &peek_buf[..4] == b"OPTI" {
        println!("OPTIONS pre-flight received");
        let response = b"HTTP/1.1 200 OK\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Allow-Private-Network: true\r\n\
            Access-Control-Allow-Methods: GET, OPTIONS\r\n\
            Access-Control-Allow-Headers: *\r\n\
            Content-Length: 0\r\n\
            Connection: keep-alive\r\n\r\n";
        let _ = stream.write_all(response).await;
        return;
    }

    if n < 3 || &peek_buf[..3] != b"GET" {
        return;
    }

    let cors_callback = |req: &tauri::http::Request<()>, mut res: tauri::http::Response<()>| {
        println!("DEBUG: Handshake callback triggered");
        println!("DEBUG: Request method: {:?}", req.method());
        res.headers_mut().insert(
            "Access-Control-Allow-Origin",
            tauri::http::HeaderValue::from_static("*"),
        );
        res.headers_mut().insert(
            "Access-Control-Allow-Private-Network",
            tauri::http::HeaderValue::from_static("true"),
        );
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
                if json["action"] == "sign" && json["challenge"].is_string() {
                    let challenge = json["challenge"].as_str().unwrap().to_string();
                    println!("Triggering Signature for Challenge: {}", challenge);

                    show_main_window(app_handle.clone());

                    let payload = SignRequestEvent {
                        id: Uuid::new_v4().to_string(),
                        challenge: challenge.clone(),
                    };

                    {
                        let ws_state = app_handle.state::<WsState>();
                        *ws_state.pending_challenge.lock().unwrap() = Some(challenge);
                    }

                    if let Some(window) = app_handle.get_webview_window("main") {
                        let res = window.emit("ws-sign-request", &payload);
                        println!("DEBUG: Window-direct emit result: {:?}", res);
                    } else {
                        println!("DEBUG: Could not find 'main' window to emit event!");
                    }
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
    tokio::join!(
        listen_on("0.0.0.0:9001", app.clone()),
        listen_on("[::]:9001", app),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_services = HashMap::new();
    let service_state = ServiceState {
        services: Mutex::new(initial_services),
        active_did: Mutex::new(None),
    };
    let ws_state = WsState {
        response_sender: Mutex::new(None),
        pending_challenge: Mutex::new(None),
    };

    let builder = tauri::Builder::default()
        .manage(service_state)
        .manage(ws_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
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
            show_main_window,
            get_pending_ws_challenge,
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
