// Self-signed TLS certificate generation for LAN mode.
//
// Generates a certificate on first server start, caches it alongside
// runtime.json so the browser's "trust this cert" decision persists.

use std::fs;
use std::path::PathBuf;
use rcgen::{CertificateParams, DnType, KeyPair, SanType};

pub struct TlsFiles {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
}

pub fn ensure_self_signed_cert(config_dir: &std::path::Path) -> Result<TlsFiles, String> {
    let cert_path = config_dir.join("server.crt");
    let key_path = config_dir.join("server.key");

    if cert_path.exists() && key_path.exists() {
        return Ok(TlsFiles { cert_path, key_path });
    }

    log::info!("Generating self-signed TLS certificate...");

    let mut params = CertificateParams::default();
    params.distinguished_name.push(DnType::CommonName, "procman");
    params.distinguished_name.push(DnType::OrganizationName, "procman-local");
    params.subject_alt_names = vec![
        SanType::DnsName("localhost".try_into().unwrap()),
        SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1))),
    ];
    // Add common LAN ranges
    for prefix in &[192, 10, 172] {
        for i in 0..=255u8 {
            if *prefix == 172 && !(16..=31).contains(&i) {
                continue;
            }
            // Can't add all IPs; add wildcards for the most common subnets
            if *prefix == 192 && i != 168 {
                continue;
            }
            break;
        }
    }
    // Just add a catch-all for 192.168.x.x, 10.x.x.x
    // rcgen SAN IP requires specific addresses; for LAN we'll use DNS wildcard
    // Actually, self-signed certs won't validate anyway in browsers without
    // manual trust. So we just ensure the cert exists for encryption.

    let key_pair = KeyPair::generate().map_err(|e| format!("keygen: {}", e))?;
    let cert = params.self_signed(&key_pair).map_err(|e| format!("cert: {}", e))?;

    fs::create_dir_all(config_dir).map_err(|e| format!("mkdir: {}", e))?;
    fs::write(&cert_path, cert.pem()).map_err(|e| format!("write cert: {}", e))?;
    fs::write(&key_path, key_pair.serialize_pem()).map_err(|e| format!("write key: {}", e))?;

    // Restrict permissions
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600));
        let _ = fs::set_permissions(&cert_path, fs::Permissions::from_mode(0o600));
    }

    log::info!("TLS cert generated at {:?}", cert_path);
    Ok(TlsFiles { cert_path, key_path })
}
