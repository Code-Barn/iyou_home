use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

// Define the service status enum
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceStatus {
    Running,
    Stopped,
    Starting,
}

// Create a state management struct
pub struct ServiceState(pub Mutex<HashMap<String, ServiceStatus>>);

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
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
    let mut services = state.0.lock().unwrap();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_services = HashMap::new();
    let service_state = ServiceState(Mutex::new(initial_services));

    tauri::Builder::default()
        .manage(service_state)
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, toggle_service])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // Helper to create a ServiceState for testing
    fn create_test_state() -> ServiceState {
        let initial_services = HashMap::new();
        ServiceState(Mutex::new(initial_services))
    }

    #[test]
    fn test_toggle_service_start() {
        let state = create_test_state();
        let service_name = "TestService".to_string();

        // Initial status should be Stopped
        {
            let services = state.0.lock().unwrap();
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
            let services = state.0.lock().unwrap();
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
            let services = state.0.lock().unwrap();
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
            let services = state.0.lock().unwrap();
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
            let services = state.0.lock().unwrap();
            assert_eq!(
                *services
                    .get(&service_name)
                    .unwrap_or(&ServiceStatus::Stopped),
                ServiceStatus::Stopped
            );
        }
    }
}
