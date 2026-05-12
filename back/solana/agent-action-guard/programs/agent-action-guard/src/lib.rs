declare_id!("9a7RVaEU5pnrVTodHHn6NHnfgdWisXv6kgJJskDxxsSk");

use anchor_lang::prelude::*;

// Pyth price account structure (simplified for reading)
// Based on pyth-sdk-solana PriceAccount layout
const PYTH_PRICE_ACCOUNT_SIZE: usize = 3312;
const PYTH_MAGIC: u32 = 0xa1b2c3d4;
const PYTH_VERSION: u32 = 2;
const PYTH_PRICE_TYPE: u32 = 3;
const TARGET_PRICE_EXPONENT: i32 = -8;
const BPS_DENOMINATOR: i128 = 10_000;

fn read_pyth_price(data: &[u8]) -> Result<(i64, u64, i32, i64)> {
    // Validate minimum size
    if data.len() < PYTH_PRICE_ACCOUNT_SIZE {
        return err!(GuardError::InvalidOracleFeed);
    }

    // Check magic number (offset 0)
    let magic = u32::from_le_bytes(data[0..4].try_into().unwrap());
    if magic != PYTH_MAGIC {
        return err!(GuardError::InvalidOracleFeed);
    }

    // Check version (offset 4)
    let version = u32::from_le_bytes(data[4..8].try_into().unwrap());
    if version != PYTH_VERSION {
        return err!(GuardError::InvalidOracleFeed);
    }

    // Check account type (offset 8)
    let atype = u32::from_le_bytes(data[8..12].try_into().unwrap());
    if atype != PYTH_PRICE_TYPE {
        return err!(GuardError::InvalidOracleFeed);
    }

    // Exponent (offset 20, i32)
    let expo = i32::from_le_bytes(data[20..24].try_into().unwrap());

    // Aggregate price info starts at offset 208
    // Price (i64) at 208
    let price = i64::from_le_bytes(data[208..216].try_into().unwrap());
    // Conf (u64) at 216
    let conf = u64::from_le_bytes(data[216..224].try_into().unwrap());
    // Status (u32) at 224
    let status = u32::from_le_bytes(data[224..228].try_into().unwrap());

    // Check status is Trading (1)
    if status != 1 {
        return err!(GuardError::OracleDataStale);
    }

    // Timestamp at offset 296 (last_slot timestamp approximation)
    // Actually use valid_slot at 240 and derive timestamp
    // For simplicity, use pub_slot at 232 and current slot comparison
    // Timestamp (i64) at offset 296
    let timestamp = i64::from_le_bytes(data[296..304].try_into().unwrap());

    Ok((price, conf, expo, timestamp))
}

fn convert_price_to_e8(price_value: i64, price_expo: i32) -> Result<i128> {
    let price_i128 = price_value as i128;
    let oracle_price_e8 = if price_expo == TARGET_PRICE_EXPONENT {
        price_i128
    } else if price_expo < TARGET_PRICE_EXPONENT {
        let shift = (TARGET_PRICE_EXPONENT - price_expo) as u32;
        let factor = 10i128
            .checked_pow(shift)
            .ok_or(error!(GuardError::ArithmeticOverflow))?;
        price_i128
            .checked_div(factor)
            .ok_or(error!(GuardError::ArithmeticOverflow))?
    } else {
        let shift = (price_expo - TARGET_PRICE_EXPONENT) as u32;
        let factor = 10i128
            .checked_pow(shift)
            .ok_or(error!(GuardError::ArithmeticOverflow))?;
        price_i128
            .checked_mul(factor)
            .ok_or(error!(GuardError::ArithmeticOverflow))?
    };

    Ok(oracle_price_e8)
}

fn compute_confidence_bps(price_conf: u64, price_value: i64) -> Result<u64> {
    let price_abs = (price_value as i128).abs();
    require!(price_abs > 0, GuardError::InvalidOraclePrice);

    let conf_bps_i128 = (price_conf as i128)
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(error!(GuardError::ArithmeticOverflow))?
        .checked_div(price_abs)
        .ok_or(error!(GuardError::ArithmeticOverflow))?;

    Ok(conf_bps_i128 as u64)
}

fn compute_deviation_bps(quoted_price_e8: u64, oracle_price_e8: i128) -> Result<u64> {
    require!(quoted_price_e8 > 0, GuardError::InvalidQuotedPrice);
    require!(oracle_price_e8 > 0, GuardError::InvalidOraclePrice);

    let quoted_i128 = quoted_price_e8 as i128;
    let diff = quoted_i128
        .checked_sub(oracle_price_e8)
        .ok_or(error!(GuardError::ArithmeticOverflow))?
        .abs();

    let deviation_bps_i128 = diff
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(error!(GuardError::ArithmeticOverflow))?
        .checked_div(oracle_price_e8)
        .ok_or(error!(GuardError::ArithmeticOverflow))?;

    Ok(deviation_bps_i128 as u64)
}

#[program]
pub mod agent_action_guard {
    use super::*;

    pub fn initialize_policy(
        ctx: Context<InitializePolicy>,
        params: InitPolicyParams,
    ) -> Result<()> {
        let policy = &mut ctx.accounts.user_policy;
        policy.user = ctx.accounts.user.key();
        policy.max_transfer_lamports = params.max_transfer_lamports;
        policy.max_swap_usd = params.max_swap_usd;
        policy.max_slippage_bps = params.max_slippage_bps;
        policy.allow_private_actions = params.allow_private_actions;
        policy.require_confirmation = params.require_confirmation;
        policy.enabled = params.enabled;
        policy.bump = ctx.bumps.user_policy;
        Ok(())
    }

    pub fn update_policy(ctx: Context<UpdatePolicy>, params: InitPolicyParams) -> Result<()> {
        let policy = &mut ctx.accounts.user_policy;
        require_keys_eq!(
            policy.user,
            ctx.accounts.user.key(),
            GuardError::Unauthorized
        );
        policy.max_transfer_lamports = params.max_transfer_lamports;
        policy.max_swap_usd = params.max_swap_usd;
        policy.max_slippage_bps = params.max_slippage_bps;
        policy.allow_private_actions = params.allow_private_actions;
        policy.require_confirmation = params.require_confirmation;
        policy.enabled = params.enabled;
        Ok(())
    }

    pub fn initialize_attestor_config(
        ctx: Context<InitializeAttestorConfig>,
        initial_attestor: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.attestor_config;
        config.admin = ctx.accounts.admin.key();
        config.attestor = initial_attestor;
        config.bump = ctx.bumps.attestor_config;
        Ok(())
    }

    pub fn update_attestor(ctx: Context<UpdateAttestor>, attestor: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.attestor_config;
        require_keys_eq!(
            config.admin,
            ctx.accounts.admin.key(),
            GuardError::Unauthorized
        );
        config.attestor = attestor;
        Ok(())
    }

    pub fn upsert_wallet_safety_attestation(
        ctx: Context<UpsertWalletSafetyAttestation>,
        params: UpsertWalletSafetyAttestationParams,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(params.expires_at > now, GuardError::AttestationExpired);

        let attestation = &mut ctx.accounts.wallet_safety_attestation;
        attestation.user = params.user;
        attestation.recipient = params.recipient;
        attestation.action_hash = params.action_hash;
        attestation.attestor = ctx.accounts.attestor.key();
        attestation.issued_at = now;
        attestation.expires_at = params.expires_at;
        attestation.risk_score_bps = params.risk_score_bps;
        attestation.active = true;
        attestation.bump = ctx.bumps.wallet_safety_attestation;
        Ok(())
    }

    pub fn create_action_approval(
        ctx: Context<CreateActionApproval>,
        params: CreateActionApprovalParams,
    ) -> Result<()> {
        let policy = &ctx.accounts.user_policy;
        require!(policy.enabled, GuardError::PolicyDisabled);

        if params.action_type == ActionType::TransferSol as u8
            || params.action_type == ActionType::TransferSolGuarded as u8
        {
            require!(
                params.input_amount <= policy.max_transfer_lamports,
                GuardError::TransferAmountTooHigh
            );
        }

        if params.action_type == ActionType::SimulatedSwap as u8
            || params.action_type == ActionType::BuySol as u8
            || params.action_type == ActionType::BuySolOracleConditional as u8
        {
            require!(
                params.max_slippage_bps <= policy.max_slippage_bps,
                GuardError::SlippageTooHigh
            );
        }

        if params.action_type == ActionType::PrivateTransfer as u8 {
            require!(
                policy.allow_private_actions,
                GuardError::PrivateActionsDisabled
            );
        }

        let now = Clock::get()?.unix_timestamp;
        require!(params.expires_at > now, GuardError::ApprovalExpired);

        let approval = &mut ctx.accounts.action_approval;
        approval.user = ctx.accounts.user.key();
        approval.agent = params.agent;
        approval.action_hash = params.action_hash;
        approval.action_type = params.action_type;
        approval.input_amount = params.input_amount;
        approval.min_output_amount = params.min_output_amount;
        approval.max_slippage_bps = params.max_slippage_bps;
        approval.recipient = params.recipient;
        approval.target_price_usd_e8 = params.target_price_usd_e8;
        approval.oracle_feed = params.oracle_feed;
        approval.expires_at = params.expires_at;
        approval.executed = false;
        approval.revoked = false;
        approval.bump = ctx.bumps.action_approval;

        Ok(())
    }

    pub fn revoke_action_approval(ctx: Context<MutateApproval>) -> Result<()> {
        let approval = &mut ctx.accounts.action_approval;
        require_keys_eq!(
            approval.user,
            ctx.accounts.user.key(),
            GuardError::Unauthorized
        );
        require!(!approval.executed, GuardError::AlreadyExecuted);
        approval.revoked = true;
        Ok(())
    }

    pub fn mark_executed(ctx: Context<MutateApproval>) -> Result<()> {
        let approval = &mut ctx.accounts.action_approval;
        require_keys_eq!(
            approval.user,
            ctx.accounts.user.key(),
            GuardError::Unauthorized
        );
        check_approval_active(approval)?;
        approval.executed = true;
        Ok(())
    }

    pub fn mark_executed_if_price_below(
        ctx: Context<MarkExecutedIfPriceBelow>,
        staleness_seconds: u64,
        max_confidence_bps: u64,
    ) -> Result<()> {
        let approval = &mut ctx.accounts.action_approval;
        require_keys_eq!(
            approval.user,
            ctx.accounts.user.key(),
            GuardError::Unauthorized
        );
        check_approval_active(approval)?;
        require!(
            approval.action_type == ActionType::BuySolOracleConditional as u8,
            GuardError::InvalidActionType
        );
        require_keys_eq!(
            approval.oracle_feed,
            ctx.accounts.oracle_price_feed.key(),
            GuardError::OracleFeedMismatch
        );

        let current_time = Clock::get()?.unix_timestamp;

        // Read Pyth price data directly from account
        let oracle_data = ctx.accounts.oracle_price_feed.try_borrow_data()?;
        let (price_value, price_conf, price_expo, price_timestamp) = read_pyth_price(&oracle_data)?;

        // Check staleness
        let age = current_time.saturating_sub(price_timestamp);
        require!(age <= staleness_seconds as i64, GuardError::OracleDataStale);

        // Convert to e8 for consistent compare
        let oracle_price_e8 = convert_price_to_e8(price_value, price_expo)?;

        require!(oracle_price_e8 > 0, GuardError::InvalidOraclePrice);
        require!(
            oracle_price_e8 as u64 <= approval.target_price_usd_e8,
            GuardError::PriceConditionNotMet
        );

        // confidence bps relative to price
        let conf_bps = compute_confidence_bps(price_conf, price_value)?;
        require!(
            conf_bps <= max_confidence_bps,
            GuardError::OracleConfidenceTooHigh
        );

        approval.executed = true;
        Ok(())
    }

    pub fn guarded_transfer(
        ctx: Context<GuardedTransfer>,
        params: GuardedTransferParams,
    ) -> Result<()> {
        let policy = &ctx.accounts.user_policy;
        require!(policy.enabled, GuardError::PolicyDisabled);

        let approval = &mut ctx.accounts.action_approval;
        check_approval_active(approval)?;
        require_keys_eq!(
            approval.user,
            ctx.accounts.user.key(),
            GuardError::ActionApprovalUserMismatch
        );
        require!(
            approval.action_type == ActionType::TransferSol as u8
                || approval.action_type == ActionType::TransferSolGuarded as u8,
            GuardError::InvalidActionType
        );
        require_keys_eq!(
            approval.recipient,
            params.recipient,
            GuardError::ActionApprovalRecipientMismatch
        );
        require!(
            approval.input_amount == params.amount_lamports,
            GuardError::ApprovalAmountMismatch
        );
        require!(
            approval.action_hash == params.action_hash,
            GuardError::ActionApprovalActionHashMismatch
        );

        let attestation = &ctx.accounts.wallet_safety_attestation;
        require!(
            attestation.active,
            GuardError::WalletSafetyAttestationRevoked
        );
        require!(
            attestation.expires_at > Clock::get()?.unix_timestamp,
            GuardError::WalletSafetyAttestationExpired
        );
        require_keys_eq!(
            attestation.user,
            ctx.accounts.user.key(),
            GuardError::WalletSafetyAttestationUserMismatch
        );
        require_keys_eq!(
            attestation.recipient,
            params.recipient,
            GuardError::WalletSafetyAttestationRecipientMismatch
        );
        require!(
            attestation.action_hash == params.action_hash,
            GuardError::WalletSafetyAttestationActionHashMismatch
        );

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, params.amount_lamports)?;

        approval.executed = true;
        Ok(())
    }

    /// Oracle-gated swap execution safety check.
    ///
    /// Compares the quoted swap price against Pyth oracle price and rejects
    /// execution when deviation exceeds max_deviation_bps.
    pub fn mark_executed_if_swap_price_within_band(
        ctx: Context<MarkExecutedIfPriceBelow>,
        quoted_price_usd_e8: u64,
        max_deviation_bps: u16,
        staleness_seconds: u64,
        max_confidence_bps: u64,
    ) -> Result<()> {
        let approval = &mut ctx.accounts.action_approval;
        require_keys_eq!(
            approval.user,
            ctx.accounts.user.key(),
            GuardError::Unauthorized
        );
        check_approval_active(approval)?;
        require!(
            approval.action_type == ActionType::SimulatedSwap as u8,
            GuardError::InvalidActionType
        );
        require_keys_eq!(
            approval.oracle_feed,
            ctx.accounts.oracle_price_feed.key(),
            GuardError::OracleFeedMismatch
        );

        let current_time = Clock::get()?.unix_timestamp;

        let oracle_data = ctx.accounts.oracle_price_feed.try_borrow_data()?;
        let (price_value, price_conf, price_expo, price_timestamp) = read_pyth_price(&oracle_data)?;

        let age = current_time.saturating_sub(price_timestamp);
        require!(age <= staleness_seconds as i64, GuardError::OracleDataStale);

        let oracle_price_e8 = convert_price_to_e8(price_value, price_expo)?;
        require!(oracle_price_e8 > 0, GuardError::InvalidOraclePrice);

        let conf_bps = compute_confidence_bps(price_conf, price_value)?;
        require!(
            conf_bps <= max_confidence_bps,
            GuardError::OracleConfidenceTooHigh
        );

        let deviation_bps = compute_deviation_bps(quoted_price_usd_e8, oracle_price_e8)?;
        require!(
            deviation_bps <= max_deviation_bps as u64,
            GuardError::PriceDeviationTooHigh
        );

        approval.executed = true;
        Ok(())
    }
}

fn check_approval_active(approval: &ActionApproval) -> Result<()> {
    require!(!approval.executed, GuardError::AlreadyExecuted);
    require!(!approval.revoked, GuardError::ApprovalRevoked);
    require!(
        approval.expires_at > Clock::get()?.unix_timestamp,
        GuardError::ApprovalExpired
    );
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitPolicyParams {
    pub max_transfer_lamports: u64,
    pub max_swap_usd: u64,
    pub max_slippage_bps: u16,
    pub allow_private_actions: bool,
    pub require_confirmation: bool,
    pub enabled: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateActionApprovalParams {
    pub agent: Pubkey,
    pub action_hash: [u8; 32],
    pub action_type: u8,
    pub input_amount: u64,
    pub min_output_amount: u64,
    pub max_slippage_bps: u16,
    pub recipient: Pubkey,
    pub target_price_usd_e8: u64,
    pub oracle_feed: Pubkey,
    pub expires_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpsertWalletSafetyAttestationParams {
    pub user: Pubkey,
    pub action_hash: [u8; 32],
    pub recipient: Pubkey,
    pub expires_at: i64,
    pub risk_score_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GuardedTransferParams {
    pub action_hash: [u8; 32],
    pub amount_lamports: u64,
    pub recipient: Pubkey,
}

#[account]
pub struct UserPolicy {
    pub user: Pubkey,
    pub max_transfer_lamports: u64,
    pub max_swap_usd: u64,
    pub max_slippage_bps: u16,
    pub allow_private_actions: bool,
    pub require_confirmation: bool,
    pub enabled: bool,
    pub bump: u8,
}

#[account]
pub struct ActionApproval {
    pub user: Pubkey,
    pub agent: Pubkey,
    pub action_hash: [u8; 32],
    pub action_type: u8,
    pub input_amount: u64,
    pub min_output_amount: u64,
    pub max_slippage_bps: u16,
    pub recipient: Pubkey,
    pub target_price_usd_e8: u64,
    pub oracle_feed: Pubkey,
    pub expires_at: i64,
    pub executed: bool,
    pub revoked: bool,
    pub bump: u8,
}

#[account]
pub struct WalletSafetyAttestation {
    pub user: Pubkey,
    pub recipient: Pubkey,
    pub action_hash: [u8; 32],
    pub attestor: Pubkey,
    pub issued_at: i64,
    pub expires_at: i64,
    pub risk_score_bps: u16,
    pub active: bool,
    pub bump: u8,
}

#[account]
pub struct AttestorConfig {
    pub admin: Pubkey,
    pub attestor: Pubkey,
    pub bump: u8,
}

impl UserPolicy {
    pub const LEN: usize = 32 + 8 + 8 + 2 + 1 + 1 + 1 + 1;
}

impl ActionApproval {
    pub const LEN: usize = 32 + 32 + 32 + 1 + 8 + 8 + 2 + 32 + 8 + 32 + 8 + 1 + 1 + 1;
}

impl WalletSafetyAttestation {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 8 + 8 + 2 + 1 + 1;
}

impl AttestorConfig {
    pub const LEN: usize = 32 + 32 + 1;
}

#[derive(Accounts)]
pub struct InitializePolicy<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + UserPolicy::LEN,
        seeds = [b"user_policy", user.key().as_ref()],
        bump
    )]
    pub user_policy: Account<'info, UserPolicy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"user_policy", user.key().as_ref()],
        bump = user_policy.bump
    )]
    pub user_policy: Account<'info, UserPolicy>,
}

#[derive(Accounts)]
#[instruction(params: CreateActionApprovalParams)]
pub struct CreateActionApproval<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"user_policy", user.key().as_ref()],
        bump = user_policy.bump,
        constraint = user_policy.user == user.key() @ GuardError::Unauthorized
    )]
    pub user_policy: Account<'info, UserPolicy>,
    #[account(
        init,
        payer = user,
        space = 8 + ActionApproval::LEN,
        seeds = [b"action_approval", user.key().as_ref(), params.action_hash.as_ref()],
        bump
    )]
    pub action_approval: Account<'info, ActionApproval>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeAttestorConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + AttestorConfig::LEN,
        seeds = [b"attestor_config"],
        bump
    )]
    pub attestor_config: Account<'info, AttestorConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAttestor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"attestor_config"],
        bump = attestor_config.bump,
        constraint = attestor_config.admin == admin.key() @ GuardError::Unauthorized
    )]
    pub attestor_config: Account<'info, AttestorConfig>,
}

#[derive(Accounts)]
#[instruction(params: UpsertWalletSafetyAttestationParams)]
pub struct UpsertWalletSafetyAttestation<'info> {
    #[account(mut)]
    pub attestor: Signer<'info>,
    #[account(
        seeds = [b"user_policy", params.user.as_ref()],
        bump = user_policy.bump,
        constraint = user_policy.user == params.user @ GuardError::Unauthorized
    )]
    pub user_policy: Account<'info, UserPolicy>,
    #[account(
        init_if_needed,
        payer = attestor,
        space = 8 + WalletSafetyAttestation::LEN,
        seeds = [b"wallet_safety_attestation", params.user.as_ref(), params.recipient.as_ref(), params.action_hash.as_ref()],
        bump
    )]
    pub wallet_safety_attestation: Account<'info, WalletSafetyAttestation>,
    #[account(
        seeds = [b"attestor_config"],
        bump = attestor_config.bump,
        constraint = attestor_config.attestor == attestor.key() @ GuardError::Unauthorized
    )]
    pub attestor_config: Account<'info, AttestorConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MutateApproval<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = action_approval.user == user.key() @ GuardError::Unauthorized)]
    pub action_approval: Account<'info, ActionApproval>,
}

#[derive(Accounts)]
pub struct MarkExecutedIfPriceBelow<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, constraint = action_approval.user == user.key() @ GuardError::Unauthorized)]
    pub action_approval: Account<'info, ActionApproval>,
    /// CHECK: validated by key match and parsed manually from raw bytes
    pub oracle_price_feed: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(params: GuardedTransferParams)]
pub struct GuardedTransfer<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"user_policy", user.key().as_ref()],
        bump = user_policy.bump,
        constraint = user_policy.user == user.key() @ GuardError::Unauthorized
    )]
    pub user_policy: Account<'info, UserPolicy>,
    #[account(
        mut,
        seeds = [b"action_approval", user.key().as_ref(), params.action_hash.as_ref()],
        bump = action_approval.bump,
        constraint = action_approval.action_hash == params.action_hash @ GuardError::ActionApprovalActionHashMismatch,
        constraint = action_approval.user == user.key() @ GuardError::ActionApprovalUserMismatch,
        constraint = action_approval.recipient == params.recipient @ GuardError::ActionApprovalRecipientMismatch,
        constraint = action_approval.input_amount == params.amount_lamports @ GuardError::ApprovalAmountMismatch,
        constraint = action_approval.action_type == ActionType::TransferSol as u8 || action_approval.action_type == ActionType::TransferSolGuarded as u8 @ GuardError::InvalidActionType
    )]
    pub action_approval: Account<'info, ActionApproval>,
    #[account(
        seeds = [b"wallet_safety_attestation", user.key().as_ref(), params.recipient.as_ref(), params.action_hash.as_ref()],
        bump = wallet_safety_attestation.bump,
        constraint = wallet_safety_attestation.action_hash == params.action_hash @ GuardError::WalletSafetyAttestationActionHashMismatch,
        constraint = wallet_safety_attestation.user == user.key() @ GuardError::WalletSafetyAttestationUserMismatch,
        constraint = wallet_safety_attestation.recipient == params.recipient @ GuardError::WalletSafetyAttestationRecipientMismatch
    )]
    pub wallet_safety_attestation: Account<'info, WalletSafetyAttestation>,
    /// CHECK: recipient key is constrained against params.recipient and ActionApproval before CPI transfer.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[repr(u8)]
pub enum ActionType {
    TransferSol = 0,
    SimulatedSwap = 1,
    BuySol = 2,
    PrivateTransfer = 3,
    BuySolOracleConditional = 4,
    TransferSolGuarded = 5,
}

#[error_code]
pub enum GuardError {
    #[msg("Invalid oracle feed")]
    InvalidOracleFeed,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Policy disabled")]
    PolicyDisabled,
    #[msg("Transfer amount exceeds policy")]
    TransferAmountTooHigh,
    #[msg("Slippage exceeds policy")]
    SlippageTooHigh,
    #[msg("Private actions disabled")]
    PrivateActionsDisabled,
    #[msg("Approval expired")]
    ApprovalExpired,
    #[msg("Approval already executed")]
    AlreadyExecuted,
    #[msg("Approval revoked")]
    ApprovalRevoked,
    #[msg("Invalid action type for this instruction")]
    InvalidActionType,
    #[msg("Oracle feed mismatch")]
    OracleFeedMismatch,
    #[msg("Oracle data stale")]
    OracleDataStale,
    #[msg("Price condition not met")]
    PriceConditionNotMet,
    #[msg("Oracle confidence too high")]
    OracleConfidenceTooHigh,
    #[msg("Invalid oracle price")]
    InvalidOraclePrice,
    #[msg("Invalid quoted swap price")]
    InvalidQuotedPrice,
    #[msg("Swap price deviation above allowed threshold")]
    PriceDeviationTooHigh,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Action approval user mismatch")]
    ActionApprovalUserMismatch,
    #[msg("Action approval recipient mismatch")]
    ActionApprovalRecipientMismatch,
    #[msg("Action approval action hash mismatch")]
    ActionApprovalActionHashMismatch,
    #[msg("Action approval amount mismatch")]
    ApprovalAmountMismatch,
    #[msg("Wallet safety attestation user mismatch")]
    WalletSafetyAttestationUserMismatch,
    #[msg("Wallet safety attestation recipient mismatch")]
    WalletSafetyAttestationRecipientMismatch,
    #[msg("Wallet safety attestation action hash mismatch")]
    WalletSafetyAttestationActionHashMismatch,
    #[msg("Wallet safety attestation expired")]
    WalletSafetyAttestationExpired,
    #[msg("Wallet safety attestation revoked")]
    WalletSafetyAttestationRevoked,
    #[msg("Wallet safety attestation is expired")]
    AttestationExpired,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_deviation_bps_within_band() {
        // oracle=100, quoted=101 => 1%
        let oracle_e8 = 10_000_000_000i128;
        let quoted_e8 = 10_100_000_000u64;
        let deviation = compute_deviation_bps(quoted_e8, oracle_e8).unwrap();
        assert_eq!(deviation, 100);
    }

    #[test]
    fn computes_deviation_bps_above_band() {
        // oracle=95, quoted=140 => 47.36%
        let oracle_e8 = 9_500_000_000i128;
        let quoted_e8 = 14_000_000_000u64;
        let deviation = compute_deviation_bps(quoted_e8, oracle_e8).unwrap();
        assert!(deviation > 3000);
    }

    #[test]
    fn converts_price_to_e8_with_negative_exponent() {
        // 95.123456 with expo=-6 => 95_123_456, convert to e8 => 9_512_345_600
        let price = 95_123_456i64;
        let converted = convert_price_to_e8(price, -6).unwrap();
        assert_eq!(converted, 9_512_345_600i128);
    }
}
