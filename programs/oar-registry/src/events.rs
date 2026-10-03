use anchor_lang::prelude::*;

// Indexers must treat account state as the source of truth; logs can be truncated.

#[event]
pub struct AppRegistered {
    pub app: Pubkey,
    pub creator: Pubkey,
    pub authority: Pubkey,
    pub manifest_hash: [u8; 32],
}

#[event]
pub struct ManifestUpdated {
    pub app: Pubkey,
    pub revision: u32,
    pub manifest_hash: [u8; 32],
}

#[event]
pub struct AuthorityProposed {
    pub app: Pubkey,
    pub pending_authority: Pubkey,
}

#[event]
pub struct AuthorityAccepted {
    pub app: Pubkey,
    pub previous: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct StatusChanged {
    pub app: Pubkey,
    pub previous: u8,
    pub status: u8,
}
