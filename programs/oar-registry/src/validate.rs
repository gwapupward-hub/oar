use crate::{error::OarError, state::MAX_URI_LEN};
use anchor_lang::prelude::*;

/// 1..=256 bytes, every byte printable ASCII 0x21..=0x7E (no spaces, no controls).
/// Scheme rules (`ar://`, `ipfs://`, `https://`) are enforced by clients, not onchain.
pub fn validate_uri(uri: &str) -> Result<()> {
    let bytes = uri.as_bytes();
    require!(!bytes.is_empty(), OarError::UriEmpty);
    require!(bytes.len() <= MAX_URI_LEN, OarError::UriTooLong);
    require!(
        bytes.iter().all(|b| (0x21..=0x7e).contains(b)),
        OarError::UriInvalidChar
    );
    Ok(())
}

pub fn validate_hash(hash: &[u8; 32]) -> Result<()> {
    require!(hash.iter().any(|b| *b != 0), OarError::ZeroManifestHash);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(r: Result<()>) -> u32 {
        match r {
            Err(anchor_lang::error::Error::AnchorError(e)) => e.error_code_number,
            other => panic!("expected AnchorError, got {other:?}"),
        }
    }

    #[test]
    fn accepts_typical_uris() {
        assert!(validate_uri("ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U").is_ok());
        assert!(
            validate_uri("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")
                .is_ok()
        );
        assert!(validate_uri("https://gwapspot.fun/oar.json").is_ok());
        assert!(validate_uri(&"a".repeat(MAX_URI_LEN)).is_ok());
    }

    #[test]
    fn rejects_bad_uris() {
        assert_eq!(code(validate_uri("")), 6000 + OarError::UriEmpty as u32);
        assert_eq!(
            code(validate_uri(&"a".repeat(MAX_URI_LEN + 1))),
            6000 + OarError::UriTooLong as u32
        );
        for bad in [
            "https://x.y/a b",
            "https://x.y/\n",
            "https://x.y/é",
            "\u{7f}",
        ] {
            assert_eq!(
                code(validate_uri(bad)),
                6000 + OarError::UriInvalidChar as u32,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn rejects_zero_hash() {
        assert_eq!(
            code(validate_hash(&[0u8; 32])),
            6000 + OarError::ZeroManifestHash as u32
        );
        let mut h = [0u8; 32];
        h[31] = 1;
        assert!(validate_hash(&h).is_ok());
    }
}
