use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Mutex;
use std::task::{Context, Poll};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::accept_hdr_async;
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

struct PrependStream<S> {
    stream: S,
    prefix: Vec<u8>,
    pos: usize,
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for PrependStream<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        if self.pos < self.prefix.len() {
            let n = std::cmp::min(buf.remaining(), self.prefix.len() - self.pos);
            buf.put_slice(&self.prefix[self.pos..self.pos + n]);
            self.pos += n;
            Poll::Ready(Ok(()))
        } else {
            Pin::new(&mut self.stream).poll_read(cx, buf)
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for PrependStream<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

async fn handle_connection(mut stream: TcpStream, app_handle: AppHandle) {
    let mut buf = vec![0u8; 4096];
    let n = match stream.read(&mut buf).await {
        Ok(0) | Err(_) => return,
        Ok(n) => n,
    };

    let request_str = String::from_utf8_lossy(&buf[..n]);

    if request_str.starts_with("OPTIONS") {
        let mut full_request = request_str.to_string();
        while !full_request.contains("\r\n\r\n") {
            let n = match stream.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            full_request.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
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

    if !request_str.starts_with("GET") {
        return;
    }

    let prepend = PrependStream {
        stream,
        prefix: buf[..n].to_vec(),
        pos: 0,
    };

    let cors_callback = |_req: &tauri::http::Request<()>, mut res: tauri::http::Response<()>| {
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

    let mut ws_stream = match accept_hdr_async(prepend, cors_callback).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("WebSocket handshake failed: {}", e);
            return;
        }
    };

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

                    let _ = app_handle.emit(
                        "ws-sign-request",
                        SignRequestEvent {
                            id: request_id,
                            challenge,
                        },
                    );

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
