use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, State};

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

    println!("Service '{}' action: {}", name, action);

    match action.as_str() {
        "start" => {
            *status = ServiceStatus::Starting;
            // Simulate starting the service
            println!("Simulating starting service: {}", name);
            // In a real app, you would spawn a process here.
            *status = ServiceStatus::Running;
        }
        "stop" => {
            // Simulate stopping the service
            println!("Simulating stopping service: {}", name);
            *status = ServiceStatus::Stopped;
        }
        _ => return Err("Invalid action".to_string()),
    }

    println!("Service '{}' new status: {:?}", name, status);

    Ok(status.clone())
}

#[tauri::command]
fn generate_did(app: AppHandle, state: State<'_, ServiceState>) -> Result<String, String> {
    // We'll generate a did:key by default for the Sovereign Signer
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
    // First, check memory state
    {
        let active = state.active_did.lock().unwrap();
        if let Some(did) = active.clone() {
            return Some(did);
        }
    }

    // Fallback: try loading from vault
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

    // Construct the Presentation payload from the challenge
    let presentation = serde_json::json!({
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "type": ["VerifiablePresentation"],
        "holder": store.did,
        "challenge": challenge,
        "verifiableCredential": []
    });

    // The did_rust library's issue_vc can sign arbitrary JSON objects to create a Proof
    let vp_json = presentation.to_string();
    let signed_vp = did_rust::issue_vc(&vp_json, &store.did, &store.private_key_base58)
        .map_err(|e| format!("Failed to sign presentation: {}", e))?;

    // Return the completed VP string to the frontend
    Ok(signed_vp)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_services = HashMap::new();
    let service_state = ServiceState {
        services: Mutex::new(initial_services),
        active_did: Mutex::new(None),
    };

    tauri::Builder::default()
        .manage(service_state)
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            toggle_service,
            generate_did,
            import_did,
            get_active_did,
            sign_auth_challenge
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // Helper to create a ServiceState for testing
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

        // Initial status should be Stopped
        {
            let services = state.services.lock().unwrap();
            assert_eq!(
                *services
                    .get(&service_name)
                    .unwrap_or(&ServiceStatus::Stopped),
                ServiceStatus::Stopped
            );
        }

        // Test starting the service
        let result = toggle_service_logic(service_name.clone(), "start".to_string(), &state);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), ServiceStatus::Running);

        // Verify state after starting
        {
            let services = state.services.lock().unwrap();
            assert_eq!(
                *services.get(&service_name).unwrap(),
                ServiceStatus::Running
            );
        }
    }

    #[test]
    fn test_toggle_service_stop() {
        let state = create_test_state();
        let service_name = "TestService".to_string();

        // First, start the service so we can stop it
        let _ = toggle_service_logic(service_name.clone(), "start".to_string(), &state);
        {
            let services = state.services.lock().unwrap();
            assert_eq!(
                *services.get(&service_name).unwrap(),
                ServiceStatus::Running
            );
        }

        // Test stopping the service
        let result = toggle_service_logic(service_name.clone(), "stop".to_string(), &state);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), ServiceStatus::Stopped);

        // Verify state after stopping
        {
            let services = state.services.lock().unwrap();
            assert_eq!(
                *services.get(&service_name).unwrap(),
                ServiceStatus::Stopped
            );
        }
    }

    #[test]
    fn test_toggle_service_invalid_action() {
        let state = create_test_state();
        let service_name = "TestService".to_string();

        let result =
            toggle_service_logic(service_name.clone(), "invalid_action".to_string(), &state);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Invalid action".to_string());

        // State should remain stopped (or unchanged if it wasn't there before)
        {
            let services = state.services.lock().unwrap();
            assert_eq!(
                *services
                    .get(&service_name)
                    .unwrap_or(&ServiceStatus::Stopped),
                ServiceStatus::Stopped
            );
        }
    }
}
