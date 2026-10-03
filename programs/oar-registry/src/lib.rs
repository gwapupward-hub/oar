//! Open App Registry (OAR) — onchain application identity for Solana.
//!
//! One `AppRecord` PDA per app. The PDA address is the App ID. The record
//! commits to an offchain manifest by URI + SHA-256 of its RFC 8785
//! canonical form. Link proofs (Program Metadata backlinks, domain and repo
//! files) and attestations (Solana Attestation Service) live outside this
//! program by design. See the spec, sections "AppRecord account" and
//! "Instructions, events and errors".

use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod state;
pub mod validate;

use error::OarError;
use events::*;
use state::*;
use validate::{validate_hash, validate_uri};

declare_id!("oarWKQoXgxp69Vupf883Pr1PvN35rAyZJeFu8q4pae5");

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "Open App Registry (OAR)",
    project_url: "https://github.com/gwapupward-hub/oar",
    contacts: "link:https://github.com/gwapupward-hub/oar/security/advisories/new",
    policy: "https://github.com/gwapupward-hub/oar/blob/main/SECURITY.md",
    source_code: "https://github.com/gwapupward-hub/oar"
}

#[program]
pub mod oar_registry {
    use super::*;

    /// Create a new App ID. The creator signs and pays rent; `authority` may be
    /// any key, e.g. a Squads vault.
    pub fn register(
        ctx: Context<Register>,
        nonce: u64,
        authority: Pubkey,
        manifest_uri: String,
        manifest_hash: [u8; 32],
    ) -> Result<()> {
        validate_uri(&manifest_uri)?;
        validate_hash(&manifest_hash)?;
        require!(authority != Pubkey::default(), OarError::ZeroAuthority);

        let slot = Clock::get()?.slot;
        let record = &mut ctx.accounts.app_record;
        record.layout_version = LAYOUT_VERSION;
        record.bump = ctx.bumps.app_record;
        record.status = STATUS_ACTIVE;
        record.creator = ctx.accounts.creator.key();
        record.nonce = nonce;
        record.authority = authority;
        record.pending_authority = Pubkey::default();
        record.manifest_hash = manifest_hash;
        record.revision = 0;
        record.created_slot = slot;
        record.updated_slot = slot;
        record.manifest_uri = manifest_uri;

        emit!(AppRegistered {
            app: record.key(),
            creator: record.creator,
            authority,
            manifest_hash,
        });
        Ok(())
    }

    /// Replace the manifest pointer; revision += 1.
    pub fn update_manifest(
        ctx: Context<AuthorityOnly>,
        manifest_uri: String,
        manifest_hash: [u8; 32],
    ) -> Result<()> {
        let record = &mut ctx.accounts.app_record;
        require!(!record.is_retired(), OarError::AppRetired);
        validate_uri(&manifest_uri)?;
        validate_hash(&manifest_hash)?;

        record.revision = record
            .revision
            .checked_add(1)
            .ok_or(OarError::RevisionOverflow)?;
        record.manifest_uri = manifest_uri;
        record.manifest_hash = manifest_hash;
        record.updated_slot = Clock::get()?.slot;

        emit!(ManifestUpdated {
            app: record.key(),
            revision: record.revision,
            manifest_hash,
        });
        Ok(())
    }

    /// Step 1 of 2 of an authority transfer. All-zeros cancels a pending transfer.
    pub fn propose_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        let record = &mut ctx.accounts.app_record;
        require!(!record.is_retired(), OarError::AppRetired);
        require!(new_authority != record.authority, OarError::SameAuthority);

        record.pending_authority = new_authority;
        record.updated_slot = Clock::get()?.slot;

        emit!(AuthorityProposed {
            app: record.key(),
            pending_authority: new_authority,
        });
        Ok(())
    }

    /// Step 2 of 2: the pending authority signs to take over.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let record = &mut ctx.accounts.app_record;
        require!(!record.is_retired(), OarError::AppRetired);
        require!(
            record.pending_authority != Pubkey::default(),
            OarError::NoPendingAuthority
        );
        require_keys_eq!(
            record.pending_authority,
            ctx.accounts.new_authority.key(),
            OarError::Unauthorized
        );

        let previous = record.authority;
        record.authority = record.pending_authority;
        record.pending_authority = Pubkey::default();
        record.updated_slot = Clock::get()?.slot;

        emit!(AuthorityAccepted {
            app: record.key(),
            previous,
            authority: record.authority,
        });
        Ok(())
    }

    /// Change status. Retired (2) is terminal and clears any pending authority.
    pub fn set_status(ctx: Context<AuthorityOnly>, status: u8) -> Result<()> {
        let record = &mut ctx.accounts.app_record;
        require!(!record.is_retired(), OarError::AppRetired);
        require!(status <= STATUS_RETIRED, OarError::InvalidStatus);

        let previous = record.status;
        record.status = status;
        if status == STATUS_RETIRED {
            record.pending_authority = Pubkey::default();
        }
        record.updated_slot = Clock::get()?.slot;

        emit!(StatusChanged {
            app: record.key(),
            previous,
            status,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Register<'info> {
    #[account(
        init,
        payer = creator,
        space = AppRecord::SPACE,
        seeds = [APP_SEED, creator.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub app_record: Account<'info, AppRecord>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    #[account(mut, has_one = authority @ OarError::Unauthorized)]
    pub app_record: Account<'info, AppRecord>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut)]
    pub app_record: Account<'info, AppRecord>,
    pub new_authority: Signer<'info>,
}
