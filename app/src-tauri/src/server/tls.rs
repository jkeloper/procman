// Self-signed TLS certificate generation for LAN mode.
//
// Generates a cert on first server start, caches it in the procman config
// directory so the same key survives across restarts. Pairing metadata carries
// the SHA-256 fingerprint enforced by the Capacitor iOS native transport for
// both REST and WebSocket. Browser/PWA clients cannot inspect this certificate
// and therefore use the publicly trusted Cloudflare Tunnel path instead.

use rcgen::{CertificateParams, DnType, KeyPair, SanType};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub struct TlsFiles {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
}

pub fn ensure_self_signed_cert(config_dir: &std::path::Path) -> Result<TlsFiles, String> {
    let cert_path = config_dir.join("server.crt");
    let key_path = config_dir.join("server.key");

    if cert_path.exists() && key_path.exists() {
        return Ok(TlsFiles {
            cert_path,
            key_path,
        });
    }

    log::info!("Generating self-signed TLS certificate...");

    let mut params = CertificateParams::default();
    params
        .distinguished_name
        .push(DnType::CommonName, "procman");
    params
        .distinguished_name
        .push(DnType::OrganizationName, "procman-local");
    // Keep the stable local identities we can enumerate. A trusted browser
    // still hostname-matches, so LAN-IP SAN generation/trust distribution is
    // tracked separately from this certificate bootstrap.
    params.subject_alt_names = vec![
        SanType::DnsName("localhost".try_into().unwrap()),
        SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1))),
    ];

    let key_pair = KeyPair::generate().map_err(|e| format!("keygen: {}", e))?;
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| format!("cert: {}", e))?;

    fs::create_dir_all(config_dir).map_err(|e| format!("mkdir: {}", e))?;
    fs::write(&cert_path, cert.pem()).map_err(|e| format!("write cert: {}", e))?;
    fs::write(&key_path, key_pair.serialize_pem()).map_err(|e| format!("write key: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600));
        let _ = fs::set_permissions(&cert_path, fs::Permissions::from_mode(0o600));
    }

    log::info!("TLS cert generated at {:?}", cert_path);
    Ok(TlsFiles {
        cert_path,
        key_path,
    })
}

/// SHA-256 fingerprint of the cert's DER-encoded form, formatted as
/// uppercase colon-separated hex (the format `openssl x509 -fingerprint`
/// emits). Included in mobile pairing metadata and enforced by the Capacitor
/// iOS native transport.
pub fn fingerprint_sha256(cert_pem: &str) -> Result<String, String> {
    let der = pem_to_der(cert_pem).ok_or("invalid PEM")?;
    let digest = Sha256::digest(&der);
    let hex: Vec<String> = digest.iter().map(|b| format!("{:02X}", b)).collect();
    Ok(hex.join(":"))
}

pub fn fingerprint_sha256_file(cert_path: &Path) -> Result<String, String> {
    let pem = fs::read_to_string(cert_path).map_err(|e| format!("read cert: {}", e))?;
    fingerprint_sha256(&pem)
}

fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose, Engine as _};
    let start = pem.find("-----BEGIN CERTIFICATE-----")?;
    let end = pem.find("-----END CERTIFICATE-----")?;
    let body = &pem[start + "-----BEGIN CERTIFICATE-----".len()..end];
    let cleaned: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    general_purpose::STANDARD.decode(cleaned).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_cert_creates_files() {
        let dir = tempfile::tempdir().unwrap();
        let files = ensure_self_signed_cert(dir.path()).unwrap();
        assert!(files.cert_path.exists());
        assert!(files.key_path.exists());
        // Idempotent: second call returns the same paths without regenerating.
        let meta1 = fs::metadata(&files.cert_path).unwrap();
        let files2 = ensure_self_signed_cert(dir.path()).unwrap();
        let meta2 = fs::metadata(&files2.cert_path).unwrap();
        assert_eq!(meta1.len(), meta2.len());
    }

    #[test]
    fn fingerprint_of_generated_cert_is_hex_colons() {
        let dir = tempfile::tempdir().unwrap();
        let files = ensure_self_signed_cert(dir.path()).unwrap();
        let pem = fs::read_to_string(&files.cert_path).unwrap();
        let fp = fingerprint_sha256(&pem).unwrap();
        // 32 bytes * 2 hex + 31 colons = 95 chars
        assert_eq!(fp.len(), 95);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit() || c == ':'));
    }
}
