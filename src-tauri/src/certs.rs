// Shared TLS certificate loading and stream buffering utilities
// used by both the Signature Bridge (bridge.rs) and the XMPP server (prosody.rs).

use std::io::{self, BufReader};
use std::path::PathBuf;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};

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
// Production Let's Encrypt certificate loading
// ---------------------------------------------------------------------------
pub fn load_production_certs(
) -> (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>) {
    let cert_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("certs")
        .join("production.crt");
    let key_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("certs")
        .join("production.key");

    println!(
        "Sovereign Release: Loading authentic Let's Encrypt keys from {:?}",
        cert_path
    );

    let mut cert_file =
        BufReader::new(std::fs::File::open(&cert_path).expect("Failed to open production cert"));
    let mut key_file =
        BufReader::new(std::fs::File::open(&key_path).expect("Failed to open production key"));

    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_file)
        .collect::<Result<Vec<_>, _>>()
        .expect("Failed to parse production certificate chain");

    let key = rustls_pemfile::private_key(&mut key_file)
        .expect("Failed to parse production private key")
        .expect("Missing private key asset structure");

    println!("Loaded authentic Let's Encrypt keys for home.iyou.me");

    (certs, key)
}
