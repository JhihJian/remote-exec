//! 共享 TLS 客户端信任策略：CA PEM 首证书同时作为 pin 与信任锚。
//!
//! - 服务端叶子与首证书逐字节一致 → 按 pin 校验（SAN + 有效期），
//!   兼容自签叶子（Node 布局凭据）。
//! - 否则委托 WebPKI 按 CA 链校验。
//!
//! daemon relay 目标校验与 rex 客户端连接共用本策略，避免两套语义。

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use std::sync::Arc;

#[derive(Debug)]
pub struct PinnedOrCaVerifier {
    certificate: Vec<u8>,
    delegate: Arc<rustls::client::WebPkiServerVerifier>,
}

impl ServerCertVerifier for PinnedOrCaVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if end_entity.as_ref() == self.certificate.as_slice() {
            let cert = webpki::EndEntityCert::try_from(end_entity)
                .map_err(|e| rustls::Error::General(format!("目标证书无效: {e}")))?;
            cert.verify_is_valid_for_subject_name(server_name)
                .map_err(|e| rustls::Error::General(format!("目标证书主机名不匹配: {e}")))?;
            // pin 分支同样校验有效期，避免过期证书因 pin 绕过时间约束。
            let (not_before, not_after) = certificate_validity(end_entity.as_ref())
                .ok_or_else(|| rustls::Error::General("目标证书有效期不可解析".to_string()))?;
            let now = now.as_secs();
            if now < not_before {
                return Err(rustls::Error::General("目标证书尚未生效".to_string()));
            }
            if now > not_after {
                return Err(rustls::Error::General("目标证书已过期".to_string()));
            }
            return Ok(ServerCertVerified::assertion());
        }
        self.delegate.verify_server_cert(
            end_entity,
            _intermediates,
            server_name,
            ocsp_response,
            now,
        )
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.delegate.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.delegate.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.delegate.supported_verify_schemes()
    }
}

/// 以 CA PEM 构建客户端配置：首证书既作 pin 又作信任锚。
pub fn pinned_or_ca_client_config(ca_pem: &str) -> Result<ClientConfig, String> {
    if !ca_pem.contains("BEGIN CERTIFICATE") {
        return Err("CA PEM 必须包含证书文本".to_string());
    }
    let mut reader = std::io::BufReader::new(ca_pem.as_bytes());
    let certs = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("CA PEM 无效: {e}"))?;
    if certs.is_empty() {
        return Err("CA PEM 不包含证书".to_string());
    }
    let certificate = certs
        .first()
        .ok_or_else(|| "CA PEM 不包含证书".to_string())?
        .clone();
    let mut roots = RootCertStore::empty();
    roots.roots.push(
        webpki::anchor_from_trusted_cert(&certificate)
            .map_err(|e| format!("CA 无效: {e}"))?
            .to_owned(),
    );
    let delegate = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
        .build()
        .map_err(|e| format!("CA 无效: {e}"))?;
    let verifier = PinnedOrCaVerifier {
        certificate: certificate.as_ref().to_vec(),
        delegate,
    };
    Ok(ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}

// ---- 证书有效期解析（仅用于 pin 分支补齐 WebPKI 不覆盖的时间校验） ----

/// 读取一个 DER TLV，返回 (tag, 内容, 含头总长度)。
fn der_split(input: &[u8]) -> Option<(u8, &[u8], usize)> {
    let (&tag, rest) = input.split_first()?;
    let (&len_byte, rest) = rest.split_first()?;
    let (content_len, body_start) = if len_byte & 0x80 == 0 {
        (len_byte as usize, 0)
    } else {
        let n = (len_byte & 0x7f) as usize;
        if n == 0 || n > 4 || rest.len() < n {
            return None;
        }
        let mut v = 0_usize;
        for &b in &rest[..n] {
            v = (v << 8) | b as usize;
        }
        (v, n)
    };
    let content = rest.get(body_start..body_start + content_len)?;
    Some((tag, content, 2 + body_start + content_len))
}

/// UTCTime(YYMMDDHHMMSSZ) / GeneralizedTime(YYYYMMDDHHMMSSZ) 转为 Unix 秒。
fn asn1_time(tag: u8, body: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(body).ok()?;
    let (year, rest) = if tag == 0x17 {
        let y: i64 = text.get(0..2)?.parse().ok()?;
        ((if y >= 50 { 1900 + y } else { 2000 + y }), &text[2..])
    } else if tag == 0x18 {
        (text.get(0..4)?.parse().ok()?, &text[4..])
    } else {
        return None;
    };
    if rest.as_bytes().last() != Some(&b'Z') || rest.len() < 11 {
        return None;
    }
    let two = |range: std::ops::Range<usize>| -> Option<i64> { rest.get(range)?.parse().ok() };
    let month = two(0..2)?;
    let day = two(2..4)?;
    let hour = two(4..6)?;
    let minute = two(6..8)?;
    let second = two(8..10)?;
    // Howard Hinnant 的 civil 日期算法。
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) as u64)
}

/// 从 DER 证书中提取 Validity 的 (not_before, not_after) Unix 秒。
fn certificate_validity(cert: &[u8]) -> Option<(u64, u64)> {
    let body = match der_split(cert) {
        Some((0x30, body, _)) => body,
        _ => return None,
    };
    // tbsCertificate 是证书 SEQUENCE 的第一个子元素，Validity 位于其内部。
    let tbs = match der_split(body) {
        Some((0x30, tbs, _)) => tbs,
        _ => return None,
    };
    let mut rest = tbs;
    while !rest.is_empty() {
        let (tag, child, consumed) = der_split(rest)?;
        rest = &rest[consumed..];
        // Validity 是唯一由两个 Time 组成的 SEQUENCE。
        if tag == 0x30 {
            let Some((time_tag, first, used)) = der_split(child) else {
                continue;
            };
            if matches!(time_tag, 0x17 | 0x18) {
                let Some((_, tail, tail_used)) = der_split(&child[used..]) else {
                    continue;
                };
                if tail_used == child.len() - used {
                    return Some((asn1_time(time_tag, first)?, asn1_time(time_tag, tail)?));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_asn1_time() {
        assert_eq!(asn1_time(0x17, b"250101000000Z"), Some(1_735_689_600));
        assert_eq!(asn1_time(0x18, b"19700101000000Z"), Some(0));
    }

    #[test]
    fn rejects_plain_text_ca() {
        assert!(pinned_or_ca_client_config("not a pem").is_err());
    }

    #[test]
    fn parses_openssl_certificate_validity() {
        let dir = std::env::temp_dir().join(format!("tls-validity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert_path = dir.join("cert.pem");
        let status = std::process::Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-keyout",
                dir.join("key.pem").to_str().unwrap(),
                "-out",
                cert_path.to_str().unwrap(),
                "-subj",
                "/CN=localhost",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if let Ok(status) = status
            && status.success()
        {
            let pem = std::fs::read_to_string(&cert_path).unwrap();
            let der = rustls_pemfile::certs(&mut std::io::BufReader::new(pem.as_bytes()))
                .next()
                .expect("openssl 证书应可解析")
                .unwrap();
            let (not_before, not_after) =
                certificate_validity(der.as_ref()).expect("openssl 证书应可解析有效期");
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            assert!(now >= not_before);
            assert!(now <= not_after + 60);
            assert!(not_after - not_before <= 90_000);
            // 自签叶子可以构建 pin 配置。
            assert!(pinned_or_ca_client_config(&pem).is_ok());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
