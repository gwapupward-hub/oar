use anchor_lang::prelude::*;

/// PDA seed prefix: `["app", creator, nonce_le]`.
pub const APP_SEED: &[u8] = b"app";

/// Maximum manifest URI length in bytes.
pub const MAX_URI_LEN: usize = 256;

/// Account layout version written by this program.
pub const LAYOUT_VERSION: u8 = 1;

pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_DEPRECATED: u8 = 1;
pub const STATUS_RETIRED: u8 = 2;

/// One record per application. The account address is the App ID.
///
/// Field order is part of the spec: fixed-size fields come first so indexers
/// can filter with `memcmp` at stable offsets (creator @ 11, authority @ 51).
#[account]
pub struct AppRecord {
    /// Layout version, `1` for spec v0.1.
    pub layout_version: u8,
    /// Canonical PDA bump.
    pub bump: u8,
    /// 0 Active, 1 Deprecated, 2 Retired (terminal).
    pub status: u8,
    /// Signer of `register`; part of the PDA seeds; never changes.
    pub creator: Pubkey,
    /// Creator-chosen nonce; part of the PDA seeds.
    pub nonce: u64,
    /// Key allowed to update this record.
    pub authority: Pubkey,
    /// Proposed next authority; all zeros means none.
    pub pending_authority: Pubkey,
    /// SHA-256 of the RFC 8785 canonical manifest.
    pub manifest_hash: [u8; 32],
    /// 0 at register, +1 per manifest update.
    pub revision: u32,
    pub created_slot: u64,
    /// Slot of the last change of any kind.
    pub updated_slot: u64,
    /// Where the manifest lives (`ar://`, `ipfs://` or `https://`).
    pub manifest_uri: String,
}

impl AppRecord {
    /// 8 discriminator + 167 fixed + 4 length prefix + 256 URI bytes = 427.
    pub const SPACE: usize = 8 + 1 + 1 + 1 + 32 + 8 + 32 + 32 + 32 + 4 + 8 + 8 + 4 + MAX_URI_LEN;

    pub fn is_retired(&self) -> bool {
        self.status == STATUS_RETIRED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_matches_spec() {
        assert_eq!(AppRecord::SPACE, 427);
    }
}
