use hyper::HeaderMap;
use sha2::{Digest, Sha256};

pub fn load_hash(text: &str) -> Result<[u8; 32], crate::AnyError> {
    let text = text.trim();
    if text.len() != 64 || !text.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("token sha256 必须是 64 位 hex".into());
    }
    let mut hash = [0; 32];
    for (i, item) in hash.iter_mut().enumerate() {
        *item = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16)?;
    }
    Ok(hash)
}

pub fn authorized(headers: &HeaderMap, expected: &[u8; 32]) -> bool {
    let mut values = headers.get_all(hyper::header::AUTHORIZATION).iter();
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    let Ok(value) = value.to_str() else {
        return false;
    };
    let Some(prefix) = value.get(..7) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case("Bearer ") {
        return false;
    }
    let token = value[7..].trim();
    if token.is_empty() {
        return false;
    }
    let actual = Sha256::digest(token.as_bytes());
    actual
        .iter()
        .zip(expected)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_hash_and_ambiguous_auth() {
        assert!(load_hash(&"é".repeat(32)).is_err());
        let hash: [u8; 32] = Sha256::digest(b"secret").into();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "bEaReR secret ".parse().unwrap());
        assert!(authorized(&headers, &hash));
        headers.append("authorization", "Bearer secret".parse().unwrap());
        assert!(!authorized(&headers, &hash));
    }
}
