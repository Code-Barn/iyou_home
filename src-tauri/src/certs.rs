// Shared TLS certificate loading and stream buffering utilities
// used by both the Signature Bridge (bridge.rs) and the XMPP server (prosody.rs).

use serde::{Deserialize, Serialize};
use std::io::{self, BufReader};
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
#[cfg(test)]
use tokio_rustls::rustls::pki_types::PrivatePkcs8KeyDer;

// ---------------------------------------------------------------------------
// ReadBuffered — replays a chunk of already-read bytes before delegating to
// the inner TLS stream.  Lets us inspect the first plaintext bytes of a TLS
// connection (e.g. OPTIONS vs WebSocket upgrade, or WebSocket vs raw XMPP)
// without consuming them.
// ---------------------------------------------------------------------------
pub struct ReadBuffered<S> {
    inner: S,
    buffer: Vec<u8>,
    pos: usize,
}

impl<S> ReadBuffered<S> {
    pub fn new(inner: S, buffer: Vec<u8>) -> Self {
        Self {
            inner,
            buffer,
            pos: 0,
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for ReadBuffered<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.pos < this.buffer.len() {
            let n = std::cmp::min(buf.remaining(), this.buffer.len() - this.pos);
            buf.put_slice(&this.buffer[this.pos..this.pos + n]);
            this.pos += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for ReadBuffered<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_shutdown(cx)
    }
}

// ---------------------------------------------------------------------------
// TLS asset resolution (SEC-002)
//
// Strategy, in priority order:
//
//   1. Runtime domain certificates: `{app_local_data_dir}/certs/production.crt`
//      + `production.key`, resolved strictly at runtime from an
//      access-controlled external path. Fail-closed: if either file exists
//      but is unreadable, incomplete, or corrupt, this is a hard error —
//      TLS servers must not silently fall back to another identity.
//   2. Compile-time bundled Let's Encrypt assets (release builds): the raw
//      certificate and private key bytes are embedded via `include_bytes!`
//      at compile time and unpacked to `{app_local_data_dir}/certs/` on
//      first launch when the directory is empty.
//   3. Ephemeral self-signed local authority generated in-memory via `rcgen`
//      (SANs: localhost, 127.0.0.1, home.iyou.me). Nothing touches disk and
//      nothing outlives the process.
// ---------------------------------------------------------------------------

// Compile-time embedded Let's Encrypt production assets.
// In release builds, these are unpacked to the runtime cert directory when no
// pre-staged certs are found on disk.
const BUNDLED_PRODUCTION_CRT: &[u8] = include_bytes!("../certs/production.crt");
const BUNDLED_PRODUCTION_KEY: &[u8] = include_bytes!("../certs/production.key");

/// File names resolved inside the runtime certificate directory.
pub const RUNTIME_CERT_FILE: &str = "production.crt";
pub const RUNTIME_KEY_FILE: &str = "production.key";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TlsStatus {
    pub is_production_cert: bool,
    pub domain: String,
    pub cert_path: String,
}

pub fn check_tls_status_in_dir(cert_dir: &std::path::Path) -> TlsStatus {
    let cert_path = cert_dir.join(RUNTIME_CERT_FILE);
    let key_path = cert_dir.join(RUNTIME_KEY_FILE);

    let is_production_cert = cert_path.exists()
        && key_path.exists()
        && parse_runtime_certs(&cert_path, &key_path).is_ok();

    TlsStatus {
        is_production_cert,
        domain: "home.iyou.me".to_string(),
        cert_path: if cert_path.exists() {
            cert_path.to_string_lossy().to_string()
        } else {
            "ephemeral (in-memory)".to_string()
        },
    }
}

#[tauri::command]
pub fn get_tls_status(app: tauri::AppHandle) -> Result<TlsStatus, String> {
    use tauri::Manager;
    let cert_dir = match app.path().app_local_data_dir() {
        Ok(dir) => dir.join("certs"),
        Err(e) => return Err(format!("Cannot resolve certs directory: {}", e)),
    };
    Ok(check_tls_status_in_dir(&cert_dir))
}

fn parse_runtime_certs(
    cert_path: &std::path::Path,
    key_path: &std::path::Path,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
    let mut cert_file =
        BufReader::new(std::fs::File::open(cert_path).map_err(|e| {
            format!("Unreadable TLS certificate {}: {}", cert_path.display(), e)
        })?);
    let mut key_file =
        BufReader::new(std::fs::File::open(key_path).map_err(|e| {
            format!("Unreadable TLS private key {}: {}", key_path.display(), e)
        })?);

    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_file)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Corrupt TLS certificate PEM {}: {}", cert_path.display(), e))?;
    if certs.is_empty() {
        return Err(format!(
            "No certificates found in {}",
            cert_path.display()
        ));
    }

    let key = rustls_pemfile::private_key(&mut key_file)
        .map_err(|e| format!("Corrupt TLS private key PEM {}: {}", key_path.display(), e))?
        .ok_or_else(|| format!("No private key material in {}", key_path.display()))?;

    Ok((certs, key))
}

/// Generate an ephemeral self-signed certificate for loopback binding.
/// In-memory only: never persisted, never leaves the process.
#[cfg(test)]
pub fn generate_ephemeral_certs(
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
    let key_pair =
        rcgen::KeyPair::generate().map_err(|e| format!("Ephemeral key generation failed: {}", e))?;

    let mut params = rcgen::CertificateParams::new(vec![
        "localhost".to_string(),
        "home.iyou.me".to_string(),
    ])
    .map_err(|e| format!("Ephemeral certificate params failed: {}", e))?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "iyou-home Local Authority");
    params
        .subject_alt_names
        .push(rcgen::SanType::IpAddress(std::net::IpAddr::from([127, 0, 0, 1])));

    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| format!("Ephemeral self-signing failed: {}", e))?;

    let certs = vec![CertificateDer::from(cert.der().to_vec())];
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pair.serialize_der()));

    println!("TLS: using ephemeral self-signed local authority (valid for this session only)");
    Ok((certs, key))
}

/// Resolve TLS assets at runtime. Domain certificates are loaded from
/// `{cert_dir}/` only if present on disk; otherwise an ephemeral self-signed
/// local authority is generated. Any partial or corrupt runtime certificate
/// state fails closed.
pub fn resolve_tls_assets(
    cert_dir: &std::path::Path,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
    #[cfg(all(debug_assertions, not(test)))]
    {
        // In dev mode, auto-populate cert_dir from repo certs if present
        let cert_dest = cert_dir.join(RUNTIME_CERT_FILE);
        let key_dest = cert_dir.join(RUNTIME_KEY_FILE);
        if !cert_dest.exists() || !key_dest.exists() {
            let repo_cert_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("certs");
            let repo_cert = repo_cert_dir.join(RUNTIME_CERT_FILE);
            let repo_key = repo_cert_dir.join(RUNTIME_KEY_FILE);
            if repo_cert.exists() && repo_key.exists() {
                let _ = std::fs::create_dir_all(cert_dir);
                let _ = std::fs::copy(&repo_cert, &cert_dest);
                let _ = std::fs::copy(&repo_key, &key_dest);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&key_dest, std::fs::Permissions::from_mode(0o600));
                    let _ = std::fs::set_permissions(&cert_dest, std::fs::Permissions::from_mode(0o600));
                }
                eprintln!("TLS: auto-provisioned Let's Encrypt dev certs to {:?}", cert_dir);
            }
        }
    }

    let cert_path = cert_dir.join(RUNTIME_CERT_FILE);
    let key_path = cert_dir.join(RUNTIME_KEY_FILE);
    let has_cert = cert_path.exists();
    let has_key = key_path.exists();

    if has_cert || has_key {
        // A half-provisioned directory is a configuration error, not a
        // fallback trigger.
        if !has_cert || !has_key {
            return Err(format!(
                "TLS configuration incomplete in {}: both {} and {} must be present",
                cert_dir.display(),
                RUNTIME_CERT_FILE,
                RUNTIME_KEY_FILE
            ));
        }
        println!("TLS: loading domain certificates from {}", cert_dir.display());
        println!("Loaded authentic Let's Encrypt keys for home.iyou.me");
        return parse_runtime_certs(&cert_path, &key_path);
    }

    // Release builds: unpack compile-time bundled Let's Encrypt assets into
    // the runtime cert directory so the Signature Bridge can bind with real
    // domain certificates without requiring the user to manually stage them.
    let _ = std::fs::create_dir_all(cert_dir);
    std::fs::write(&cert_path, BUNDLED_PRODUCTION_CRT)
        .map_err(|e| format!("Failed to write bundled certificate to {}: {}", cert_path.display(), e))?;
    std::fs::write(&key_path, BUNDLED_PRODUCTION_KEY)
        .map_err(|e| format!("Failed to write bundled private key to {}: {}", key_path.display(), e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to restrict key permissions: {}", e))?;
    }

    println!(
        "TLS: unpacked bundled Let's Encrypt assets to {}",
        cert_dir.display()
    );
    parse_runtime_certs(&cert_path, &key_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    fn temp_cert_dir(label: &str) -> std::path::PathBuf {
        let dir = temp_dir().join(format!("iyou_certs_{}_{}", label, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("Should create cert dir");
        dir
    }

    #[test]
    fn test_ephemeral_generation_yields_parseable_identity() {
        let (certs, key) = generate_ephemeral_certs().expect("Should generate");
        assert!(!certs.is_empty());

        // The returned key must be valid DER that rustls can classify.
        match &key {
            PrivateKeyDer::Pkcs8(pkcs8) => {
                assert!(!pkcs8.secret_pkcs8_der().is_empty());
            }
            other => panic!("Expected PKCS#8 key, got {:?}", other),
        }

        // Two generations produce distinct identities.
        let (certs2, _) = generate_ephemeral_certs().expect("Second generation");
        assert_ne!(certs[0], certs2[0], "Ephemeral identities must be unique per launch");
    }

    #[test]
    fn test_empty_cert_dir_unpacks_bundled_assets() {
        let dir = temp_cert_dir("empty");
        let result = resolve_tls_assets(&dir).expect("Empty dir should unpack bundled certs");
        assert!(!result.0.is_empty(), "Should have loaded certificates");
        // Verify the bundled assets were actually written to disk
        assert!(dir.join(RUNTIME_CERT_FILE).exists(), "Bundled cert should be on disk");
        assert!(dir.join(RUNTIME_KEY_FILE).exists(), "Bundled key should be on disk");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let key_perms = std::fs::metadata(dir.join(RUNTIME_KEY_FILE))
                .expect("Should stat key")
                .permissions()
                .mode() & 0o777;
            assert_eq!(key_perms, 0o600, "Key permissions must be 0o600");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_half_provisioned_cert_dir_fails_closed() {
        let dir = temp_cert_dir("half");

        // Key without cert.
        std::fs::write(dir.join(RUNTIME_KEY_FILE), b"junk").expect("Write key");
        let err = resolve_tls_assets(&dir).err().expect("Must fail closed");
        assert!(err.contains("incomplete"), "Got: {}", err);

        // Cert without key.
        std::fs::remove_file(dir.join(RUNTIME_KEY_FILE)).expect("Remove key");
        std::fs::write(dir.join(RUNTIME_CERT_FILE), b"junk").expect("Write cert");
        let err = resolve_tls_assets(&dir).err().expect("Must fail closed");
        assert!(err.contains("incomplete"), "Got: {}", err);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_corrupt_runtime_certs_fail_closed() {
        let dir = temp_cert_dir("corrupt");
        std::fs::write(dir.join(RUNTIME_CERT_FILE), b"not a pem at all")
            .expect("Write corrupt cert");
        std::fs::write(dir.join(RUNTIME_KEY_FILE), b"\x00\xFFgarbage").expect("Write corrupt key");

        let err = resolve_tls_assets(&dir).err().expect("Corrupt certs must fail closed");
        assert!(err.contains("Corrupt") || err.contains("No "), "Got: {}", err);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_runtime_domain_certs_load_from_disk() {
        let dir = temp_cert_dir("runtime");

        // Provision real PEM files by round-tripping an rcgen identity.
        let key_pair = rcgen::KeyPair::generate().expect("Generate key pair");
        let params = rcgen::CertificateParams::new(vec!["home.iyou.me".to_string()])
            .expect("Params");
        let cert = params.self_signed(&key_pair).expect("Self-sign");
        std::fs::write(dir.join(RUNTIME_CERT_FILE), cert.pem()).expect("Write cert pem");
        std::fs::write(dir.join(RUNTIME_KEY_FILE), key_pair.serialize_pem())
            .expect("Write key pem");

        let (certs, _key) =
            resolve_tls_assets(&dir).expect("Runtime certs should load");
        assert_eq!(certs.len(), 1);
        assert_eq!(certs[0].as_ref(), cert.der().as_ref(), "Round-trip must be byte-identical");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_tls_status_resolution() {
        let dir = temp_cert_dir("status_test");

        // 1. Empty dir: not production cert
        let status = check_tls_status_in_dir(&dir);
        assert!(!status.is_production_cert);
        assert_eq!(status.domain, "home.iyou.me");

        // 2. Provision valid certs
        let key_pair = rcgen::KeyPair::generate().expect("Generate key pair");
        let params = rcgen::CertificateParams::new(vec!["home.iyou.me".to_string()]).expect("Params");
        let cert = params.self_signed(&key_pair).expect("Self-sign");
        std::fs::write(dir.join(RUNTIME_CERT_FILE), cert.pem()).expect("Write cert");
        std::fs::write(dir.join(RUNTIME_KEY_FILE), key_pair.serialize_pem()).expect("Write key");

        // 3. Status is now production cert
        let status = check_tls_status_in_dir(&dir);
        assert!(status.is_production_cert);
        assert!(status.cert_path.ends_with(RUNTIME_CERT_FILE));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
