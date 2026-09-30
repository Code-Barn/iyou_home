// Shared TLS certificate loading and stream buffering utilities
// used by both the Signature Bridge (bridge.rs) and the XMPP server (prosody.rs).

use serde::{Deserialize, Serialize};
use std::io::{self, BufReader};
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

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
// SEC-002 was a Critical finding: the release Mach-O/PE binary embedded the
// production TLS private key via `include_bytes!`, making it trivially
// extractable with `strings`. That is now structurally impossible here — this
// module contains **no `include_bytes!`, no `include_str!`, and no bundled
// key material of any kind**. There is nothing to extract because nothing is
// compiled in.
//
// Strategy, in priority order:
//
//   1. Operator-provisioned domain certificates (default on a configured
//      install): `{app_local_data_dir}/certs/production.crt` +
//      `production.key`, resolved strictly at runtime from an
//      access-controlled external path. BOTH files must be present.
//      Fail-closed: if either file exists but the pair is incomplete,
//      unreadable, or corrupt, this is a hard error — TLS servers must not
//      silently fall back to a different identity.
//   2. Ephemeral self-signed local authority (default fallback): generated
//      in-memory via `rcgen` (SANs: home.iyou.me, 127.0.0.1, localhost).
//      The keypair lives only in process memory for the lifetime of the
//      process, is never written to disk, never serialized, and dies with
//      the daemon. It is regenerated on every launch.
//
// The certificate directory is READ-ONLY from this module's perspective:
// nothing in the resolution path creates it or writes to it outside of the
// dev-only `#[cfg]` convenience block documented on `resolve_tls_assets`.
// ---------------------------------------------------------------------------

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
        } else if key_path.exists() {
            // Half-provisioned: resolution fails closed, it does NOT silently
            // fall back to the ephemeral authority. Report it honestly.
            format!("incomplete: {} missing", RUNTIME_CERT_FILE)
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

/// Generate an ephemeral self-signed certificate authority for loopback
/// binding.
///
/// **SEC-002 invariant: this is an in-memory-only identity.** The keypair is
/// minted with `rcgen::KeyPair::generate()` (CSPRNG-backed), used to build a
/// `ServerConfig` that the caller holds for the process lifetime, and then
/// dropped. It is never written to disk, never persisted, never exported, and
/// never embedded in a build artifact. Each call returns a distinct identity,
/// so restarting the daemon rotates the ephemeral key automatically.
pub fn generate_ephemeral_certs(
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
    let key_pair =
        rcgen::KeyPair::generate().map_err(|e| format!("Ephemeral key generation failed: {}", e))?;

    let mut params = rcgen::CertificateParams::new(vec![
        "home.iyou.me".to_string(),
        "localhost".to_string(),
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

    println!("TLS: using ephemeral self-signed local authority (in-memory only, valid for this session)");
    Ok((certs, key))
}

/// Resolve TLS assets at runtime (SEC-002).
///
/// **Never** bundles or unpacks key material. Exactly two outcomes:
///
/// 1. `{cert_dir}/production.crt` **and** `{cert_dir}/production.key` both
///    exist — the operator has manually provisioned a real domain identity.
///    Both are read and parsed from disk via `rustls_pemfile`. Any incomplete,
///    unreadable, or corrupt pair is a hard error (fail-closed): a TLS server
///    must never silently downgrade to a different identity than the one the
///    operator intended to serve.
/// 2. Neither exists — an ephemeral self-signed authority is generated in
///    memory and returned. Nothing is written to disk.
pub fn resolve_tls_assets(
    cert_dir: &std::path::Path,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
    #[cfg(all(debug_assertions, not(test)))]
    {
        // Developer convenience ONLY (never compiled into release builds):
        // if the operator has placed dev certs in the repo's `certs/`
        // directory, stage them into the runtime directory so `tauri dev`
        // serves a real domain certificate. This is a dynamic runtime read of
        // an on-disk path — not a compile-time embed — and it is skipped
        // entirely when the staged key is empty (e.g. a gitignored
        // placeholder), which would otherwise poison the cert directory with
        // an unparseable key.
        let cert_dest = cert_dir.join(RUNTIME_CERT_FILE);
        let key_dest = cert_dir.join(RUNTIME_KEY_FILE);
        if !cert_dest.exists() || !key_dest.exists() {
            let repo_cert_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("certs");
            let repo_cert = repo_cert_dir.join(RUNTIME_CERT_FILE);
            let repo_key = repo_cert_dir.join(RUNTIME_KEY_FILE);
            let repo_key_is_usable = std::fs::metadata(&repo_key)
                .map(|m| m.len() > 0)
                .unwrap_or(false);
            if repo_cert.exists() && repo_key_is_usable {
                let _ = std::fs::create_dir_all(cert_dir);
                let _ = std::fs::copy(&repo_cert, &cert_dest);
                let _ = std::fs::copy(&repo_key, &key_dest);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&key_dest, std::fs::Permissions::from_mode(0o600));
                    let _ = std::fs::set_permissions(&cert_dest, std::fs::Permissions::from_mode(0o600));
                }
                eprintln!("TLS: staged dev certs from {} to {:?}", repo_cert_dir.display(), cert_dir);
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
        println!("TLS: loading operator-provisioned certificates from {}", cert_dir.display());
        return parse_runtime_certs(&cert_path, &key_path);
    }

    // Default: ephemeral in-memory authority. No directory is created and no
    // key material is persisted (SEC-002).
    generate_ephemeral_certs()
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
    fn test_empty_cert_dir_generates_ephemeral_in_memory() {
        let dir = temp_cert_dir("empty");
        let (certs, key) =
            resolve_tls_assets(&dir).expect("Empty dir should yield an ephemeral identity");
        assert!(!certs.is_empty(), "Should have generated a certificate");
        assert!(matches!(key, PrivateKeyDer::Pkcs8(_)), "Ephemeral key must be PKCS#8");

        // SEC-002: the ephemeral path must not create the cert directory or
        // leave any key material behind on disk.
        assert!(
            !dir.join(RUNTIME_CERT_FILE).exists(),
            "Ephemeral certificates must NEVER be written to disk"
        );
        assert!(
            !dir.join(RUNTIME_KEY_FILE).exists(),
            "Ephemeral private keys must NEVER be written to disk"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_nonexistent_cert_dir_yields_ephemeral_and_writes_nothing() {
        // The app data `certs/` directory usually does not exist at all on a
        // fresh install. Resolution must still succeed in memory and must NOT
        // create the directory as a side effect.
        let dir = temp_cert_dir("absent").join("nested").join("certs");
        assert!(!dir.exists());

        let (certs, _) = resolve_tls_assets(&dir).expect("Absent dir should fall back to ephemeral");
        assert!(!certs.is_empty());
        assert!(
            !dir.exists(),
            "Resolution must not create the cert directory on the ephemeral path"
        );

        let _ = std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn test_no_private_key_is_embedded_at_compile_time() {
        // SEC-002 regression guard. The original finding was a production key
        // baked into the shipped binary via a compile-time `include_` directive,
        // recoverable with `strings`. Scan every Rust source in the crate and
        // fail if anything could reintroduce compile-time key material.
        //
        // Needles are assembled from fragments at runtime so this test's own
        // source does not match itself.
        let embed_bytes = format!("include_{}!", "bytes");
        let embed_str = format!("include_{}!", "str");
        let pem_headers = [
            ["BEGIN", "PRIVATE KEY"].join(" "),
            ["BEGIN", "RSA PRIVATE KEY"].join(" "),
            ["BEGIN", "EC PRIVATE KEY"].join(" "),
            ["BEGIN", "OPENSSH PRIVATE KEY"].join(" "),
        ];
        // A compile-time embed is only a secret leak if it targets key-shaped
        // material; embedding an icon or a schema is legitimate.
        let key_shaped = [".key", ".pem", "PRIVATE"];

        let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders: Vec<String> = Vec::new();
        let mut stack = vec![src_root.clone()];

        while let Some(dir) = stack.pop() {
            let entries = std::fs::read_dir(&dir)
                .unwrap_or_else(|e| panic!("Cannot scan {:?}: {}", dir, e));
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let source = std::fs::read_to_string(&path).expect("Read source");
                for (n, line) in source.lines().enumerate() {
                    let trimmed = line.trim_start();
                    // Documentation and comments may name the directives.
                    if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') {
                        continue;
                    }
                    let embeds = line.contains(&embed_bytes) || line.contains(&embed_str);
                    let literal_pem = pem_headers.iter().any(|h| line.contains(h));
                    let targets_key_material = key_shaped.iter().any(|k| line.contains(k));
                    if literal_pem || (embeds && targets_key_material) {
                        offenders.push(format!(
                            "{}:{}: {}",
                            path.strip_prefix(&src_root).unwrap_or(&path).display(),
                            n + 1,
                            line.trim()
                        ));
                    }
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "SEC-002 violation: compile-time key material reintroduced:\n{}",
            offenders.join("\n")
        );
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

        // 1. Empty dir: ephemeral in-memory authority, not a production cert.
        let status = check_tls_status_in_dir(&dir);
        assert!(!status.is_production_cert);
        assert_eq!(status.domain, "home.iyou.me");
        assert_eq!(status.cert_path, "ephemeral (in-memory)");

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

    #[test]
    fn test_tls_status_reports_half_provisioned_state_honestly() {
        let dir = temp_cert_dir("status_half");

        // A key with no cert is NOT a silent fallback to the ephemeral
        // authority — resolution fails closed, so the status must say so
        // rather than advertising a working in-memory cert.
        std::fs::write(dir.join(RUNTIME_KEY_FILE), b"junk").expect("Write key");
        let status = check_tls_status_in_dir(&dir);
        assert!(!status.is_production_cert);
        assert!(
            status.cert_path.contains("incomplete"),
            "Half-provisioned state must be reported, got: {}",
            status.cert_path
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
