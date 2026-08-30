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

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_UPDATE_MANIFEST_URL: &str = "https://updates.iyou.me/home/latest.json";
#[allow(dead_code)]
pub const MINISIGN_PUBLIC_KEY: &str = "RWQUVz81iYkLd...ByersBrandsSovereignReleaseKey";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePolicy {
    Locked, // "Air-Gapped / Locked": Never queries update servers
    Manual, // "Manual Review (Notify Only)": Default
    Auto,   // "Automatic": Background fetch and prompt
}

impl Default for UpdatePolicy {
    fn default() -> Self {
        Self::Manual
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UpdatePreferences {
    pub policy: UpdatePolicy,
    pub release_channel: String, // "stable" | "beta"
    pub custom_manifest_url: Option<String>,
    pub last_checked_at: Option<u64>,
    pub ignored_version: Option<String>,
}

impl Default for UpdatePreferences {
    fn default() -> Self {
        Self {
            policy: UpdatePolicy::Manual,
            release_channel: "stable".to_string(),
            custom_manifest_url: None,
            last_checked_at: None,
            ignored_version: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UpdateMetadata {
    pub current_version: String,
    pub target_version: String,
    pub git_commit_hash: String,
    pub binary_sha256: String,
    pub minisign_signature: String,
    pub release_notes: String,
    pub published_at: u64,
    pub download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteManifestPlatform {
    pub signature: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteManifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pub_date: Option<String>,
    #[serde(default)]
    pub git_commit: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub platforms: Option<std::collections::HashMap<String, RemoteManifestPlatform>>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn get_rollback_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("bin").join("iyou-home.previous")
}

pub fn stage_binary_for_rollback(app_data_dir: &Path) -> Result<PathBuf, String> {
    let bin_dir = app_data_dir.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create binary staging directory: {}", e))?;

    let previous_path = bin_dir.join("iyou-home.previous");

    if let Ok(current_exe) = std::env::current_exe() {
        if current_exe.exists() {
            std::fs::copy(&current_exe, &previous_path)
                .map_err(|e| format!("Failed to stage current binary for rollback: {}", e))?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&previous_path, std::fs::Permissions::from_mode(0o755));
            }
        }
    }

    Ok(previous_path)
}

pub fn execute_binary_rollback(app_data_dir: &Path) -> Result<bool, String> {
    let previous_path = get_rollback_path(app_data_dir);
    if !previous_path.exists() {
        return Err("No prior binary backup found in bin/iyou-home.previous".to_string());
    }

    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Failed to resolve current binary path: {}", e))?;

    // Copy previous binary back to active executable path
    std::fs::copy(&previous_path, &current_exe)
        .map_err(|e| format!("Failed to restore previous binary: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&current_exe, std::fs::Permissions::from_mode(0o755));
    }

    Ok(true)
}

pub fn is_rollback_available(app_data_dir: &Path) -> bool {
    get_rollback_path(app_data_dir).exists()
}

pub async fn query_update_metadata(
    prefs: &UpdatePreferences,
    force: bool,
) -> Result<Option<UpdateMetadata>, String> {
    if prefs.policy == UpdatePolicy::Locked && !force {
        return Ok(None);
    }

    let current_ver = env!("CARGO_PKG_VERSION");
    let manifest_url = prefs
        .custom_manifest_url
        .as_deref()
        .unwrap_or(DEFAULT_UPDATE_MANIFEST_URL);

    // Fetch manifest over HTTPS
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = match client.get(manifest_url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            return Err(format!("Manifest returned status {}", r.status()));
        }
        Err(e) => {
            // If network is offline or unresolvable in dev/offline mode, return None gracefully
            eprintln!("Update manifest check unreachable ({}): {}", manifest_url, e);
            return Ok(None);
        }
    };

    let manifest: RemoteManifest = resp
        .json()
        .await
        .map_err(|e| format!("Corrupt update manifest: {}", e))?;

    if manifest.version == current_ver {
        return Ok(None);
    }

    if let Some(ignored) = &prefs.ignored_version {
        if ignored == &manifest.version && !force {
            return Ok(None);
        }
    }

    let git_commit_hash = manifest.git_commit.unwrap_or_else(|| "release-head".to_string());
    let binary_sha256 = manifest.sha256.unwrap_or_default();
    let minisign_signature = manifest.signature.unwrap_or_default();
    let release_notes = manifest.notes.unwrap_or_else(|| "Sovereign release improvements".to_string());

    Ok(Some(UpdateMetadata {
        current_version: current_ver.to_string(),
        target_version: manifest.version,
        git_commit_hash,
        binary_sha256,
        minisign_signature,
        release_notes,
        published_at: now_unix(),
        download_url: manifest_url.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    #[test]
    fn test_update_preferences_defaults() {
        let prefs = UpdatePreferences::default();
        assert_eq!(prefs.policy, UpdatePolicy::Manual);
        assert_eq!(prefs.release_channel, "stable");
        assert!(prefs.custom_manifest_url.is_none());
        assert!(prefs.last_checked_at.is_none());
        assert!(prefs.ignored_version.is_none());
    }

    #[test]
    fn test_update_preferences_serialization_roundtrip() {
        let prefs = UpdatePreferences {
            policy: UpdatePolicy::Locked,
            release_channel: "beta".to_string(),
            custom_manifest_url: Some("https://custom.updates.iyou.me".to_string()),
            last_checked_at: Some(1700000000),
            ignored_version: Some("0.2.1".to_string()),
        };

        let json = serde_json::to_string(&prefs).expect("Serialize prefs");
        let deserialized: UpdatePreferences = serde_json::from_str(&json).expect("Deserialize");
        assert_eq!(deserialized, prefs);
    }

    #[tokio::test]
    async fn test_locked_policy_suppresses_checks() {
        let prefs = UpdatePreferences {
            policy: UpdatePolicy::Locked,
            release_channel: "stable".to_string(),
            custom_manifest_url: None,
            last_checked_at: None,
            ignored_version: None,
        };

        let result = query_update_metadata(&prefs, false)
            .await
            .expect("Should not error on locked policy");
        assert!(result.is_none(), "Locked policy must return None immediately");
    }

    #[test]
    fn test_rollback_staging_and_detection() {
        let dir = temp_dir().join(format!("iyou_updater_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("Create test dir");

        assert!(!is_rollback_available(&dir));

        let bin_dir = dir.join("bin");
        std::fs::create_dir_all(&bin_dir).expect("Create bin dir");
        let prev_bin = bin_dir.join("iyou-home.previous");
        std::fs::write(&prev_bin, b"mock_prior_binary").expect("Write mock binary");

        assert!(is_rollback_available(&dir));
        assert_eq!(get_rollback_path(&dir), prev_bin);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
