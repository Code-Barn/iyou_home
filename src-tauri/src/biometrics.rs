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

#[cfg(target_os = "macos")]
extern "C" {
    fn verify_biometric_auth_macos(
        reason: *const std::os::raw::c_char,
        error_out: *mut *mut std::os::raw::c_char,
        error_code_out: *mut i32,
    ) -> i32;
    fn free_biometric_error_string(ptr: *mut std::os::raw::c_char);
}

/// Native Biometric / Touch ID verification for application lock and authentication.
/// On macOS, directly invokes LocalAuthentication `evaluatePolicy` for native Touch ID UI.
/// On other platforms, returns `Ok(true)` as fallback.
#[tauri::command]
pub async fn verify_biometric_auth(reason: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::{CStr, CString};
        tokio::task::spawn_blocking(move || {
            let c_reason = CString::new(reason).unwrap_or_else(|_| CString::new("Authenticate with Touch ID").unwrap());
            let mut error_ptr: *mut std::os::raw::c_char = std::ptr::null_mut();
            let mut error_code: i32 = 0;

            let status = unsafe {
                verify_biometric_auth_macos(
                    c_reason.as_ptr(),
                    &mut error_ptr,
                    &mut error_code,
                )
            };

            if status == 0 {
                Ok(true)
            } else {
                let err_msg = if !error_ptr.is_null() {
                    let msg = unsafe { CStr::from_ptr(error_ptr).to_string_lossy().into_owned() };
                    unsafe { free_biometric_error_string(error_ptr) };
                    msg
                } else {
                    "Biometric authentication failed".to_string()
                };

                // -7 corresponds to LAErrorBiometryNotEnrolled
                if error_code == -7 {
                    Err(format!("LAErrorBiometryNotEnrolled: {}", err_msg))
                } else {
                    Err(err_msg)
                }
            }
        })
        .await
        .map_err(|e| format!("Authentication task failed: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = reason;
        Ok(true)
    }
}
