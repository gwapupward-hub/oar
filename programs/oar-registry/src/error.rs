use anchor_lang::prelude::*;

#[error_code]
pub enum OarError {
    #[msg("Manifest URI is empty")]
    UriEmpty,
    #[msg("Manifest URI exceeds 256 bytes")]
    UriTooLong,
    #[msg("Manifest URI contains a byte outside printable ASCII (0x21-0x7E)")]
    UriInvalidChar,
    #[msg("Manifest hash must not be all zeros")]
    ZeroManifestHash,
    #[msg("Authority must not be the all-zeros key")]
    ZeroAuthority,
    #[msg("Signer is not the authority for this record")]
    Unauthorized,
    #[msg("No pending authority to accept")]
    NoPendingAuthority,
    #[msg("New authority equals the current authority")]
    SameAuthority,
    #[msg("Record is retired and frozen")]
    AppRetired,
    #[msg("Status must be 0 (Active), 1 (Deprecated) or 2 (Retired)")]
    InvalidStatus,
    #[msg("Manifest revision overflowed")]
    RevisionOverflow,
}
