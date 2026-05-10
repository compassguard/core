use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, system_instruction};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("G6RB5XQwcnXXp34vDot3ERcbGS8RcXUtacMhgXAM8P7n");

const VAULT_CONFIG_SEED: &[u8] = b"vault-config";
const ORDER_SEED: &[u8] = b"order";
const ESCROW_AUTHORITY_SEED: &[u8] = b"escrow-authority";
const SOL_VAULT_SEED: &[u8] = b"sol-vault";

const PYTH_PRICE_ACCOUNT_SIZE: usize = 3312;
const PYTH_MAGIC: u32 = 0xa1b2c3d4;
const PYTH_VERSION: u32 = 2;
const PYTH_PRICE_TYPE: u32 = 3;
const PYTH_STATUS_TRADING: u32 = 1;

const STATUS_OPEN: u8 = 1;
const STATUS_EXECUTED: u8 = 2;
const STATUS_CANCELLED: u8 = 3;
const STATUS_EXPIRED: u8 = 4;
const STATUS_RECLAIMED: u8 = 5;

const MIN_SOL_VAULT_MARGIN_LAMPORTS: u64 = 5_000_000;

#[program]
pub mod conditional_escrow_buy {
    use super::*;

    pub fn initialize_vault_config(
        ctx: Context<InitializeVaultConfig>,
        params: InitializeVaultConfigParams,
    ) -> Result<()> {
        require!(!params.paused, ErrorCode::VaultPaused);
        require!(params.max_confidence_bps <= 10_000, ErrorCode::InvalidConfidenceBpsRange);
        require!(params.max_oracle_age_seconds >= 1, ErrorCode::InvalidOracleAge);
        require!(params.usdc_decimals <= 18, ErrorCode::InvalidUsdcDecimals);

        let vault_config = &mut ctx.accounts.vault_config;
        vault_config.admin = ctx.accounts.admin.key();
        vault_config.treasury_usdc_ata = params.treasury_usdc_ata;
        vault_config.usdc_test_mint = params.usdc_test_mint;
        vault_config.oracle_feed = params.oracle_feed;
        vault_config.usdc_decimals = params.usdc_decimals;
        vault_config.max_oracle_age_seconds = params.max_oracle_age_seconds;
        vault_config.max_confidence_bps = params.max_confidence_bps;
        vault_config.paused = false;
        vault_config.vault_bump = params.vault_bump;
        vault_config.bump = ctx.bumps.vault_config;

        Ok(())
    }

    pub fn fund_sol_vault(ctx: Context<FundSolVault>, params: FundSolVaultParams) -> Result<()> {
        require!(!ctx.accounts.vault_config.paused, ErrorCode::VaultPaused);
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.vault_config.admin,
            ErrorCode::Unauthorized
        );
        require!(params.amount > 0, ErrorCode::InvalidFundAmount);

        let transfer_ix =
            system_instruction::transfer(&ctx.accounts.admin.key(), &ctx.accounts.sol_vault.key(), params.amount);
        let accounts = &[
            ctx.accounts.admin.to_account_info(),
            ctx.accounts.sol_vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ];

        invoke(&transfer_ix, accounts).map_err(|_| ErrorCode::VaultTransferFailed)?;
        Ok(())
    }

    pub fn create_order_and_deposit(
        ctx: Context<CreateOrderAndDeposit>,
        params: CreateOrderAndDepositParams,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;

        require!(!ctx.accounts.vault_config.paused, ErrorCode::VaultPaused);
        require!(params.client_order_id > 0, ErrorCode::InvalidClientOrderId);
        require!(params.desired_sol_lamports > 0, ErrorCode::InvalidDesiredSolAmount);
        require!(params.max_usdc_in > 0, ErrorCode::InvalidMaxUsdcIn);
        require!(params.max_usdc_in >= params.deposit_amount, ErrorCode::DepositExceedsMaxUsdc);
        require!(params.target_price_usd_e8 > 0, ErrorCode::InvalidTargetPrice);
        require!(params.deposit_amount > 0, ErrorCode::InvalidDepositAmount);
        require!(params.expires_at > now, ErrorCode::OrderExpired);
        require!(params.recipient != Pubkey::default(), ErrorCode::InvalidRecipient);
        require!(params.max_oracle_age_seconds > 0, ErrorCode::InvalidOracleAge);
        require!(params.max_confidence_bps > 0, ErrorCode::InvalidConfidenceBps);
        require!(
            ctx.accounts.user_usdc_token_account.mint == ctx.accounts.vault_config.usdc_test_mint,
            ErrorCode::InvalidMint
        );
        require!(
            ctx.accounts.escrow_token_account.mint == ctx.accounts.vault_config.usdc_test_mint,
            ErrorCode::InvalidMint
        );
        require_keys_eq!(
            ctx.accounts.oracle_price_feed.key(),
            ctx.accounts.vault_config.oracle_feed,
            ErrorCode::OracleFeedMismatch
        );

        let order = &mut ctx.accounts.order;
        order.user = ctx.accounts.user.key();
        order.recipient = params.recipient;
        order.client_order_id = params.client_order_id;
        order.usdc_test_mint = ctx.accounts.vault_config.usdc_test_mint;
        order.escrow_token_account = ctx.accounts.escrow_token_account.key();
        order.treasury_usdc_ata = ctx.accounts.treasury_usdc_ata.key();
        order.sol_vault_pda = ctx.accounts.sol_vault_pda.key();
        order.oracle_feed = params.oracle_feed;
        order.desired_sol_lamports = params.desired_sol_lamports;
        order.max_usdc_in = params.max_usdc_in;
        order.target_price_usd_e8 = params.target_price_usd_e8;
        order.max_oracle_age_seconds = params.max_oracle_age_seconds;
        order.max_confidence_bps = params.max_confidence_bps;
        order.escrowed_usdc_amount = params.deposit_amount;
        order.executed_usdc_amount = 0;
        order.executed_sol_lamports = 0;
        order.created_at = now;
        order.expires_at = params.expires_at;
        order.escrow_authority_bump = ctx.bumps.escrow_authority;
        order.status = STATUS_OPEN;
        order.bump = ctx.bumps.order;

        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_usdc_token_account.to_account_info(),
                to: ctx.accounts.escrow_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
            },
        );
        token::transfer_checked(
            transfer_ctx,
            params.deposit_amount,
            ctx.accounts.vault_config.usdc_decimals,
        )?;

        Ok(())
    }

    pub fn execute_order(ctx: Context<ExecuteOrder>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let order = &mut ctx.accounts.order;
        require!(order.status == STATUS_OPEN, ErrorCode::OrderNotOpen);
        require!(now <= order.expires_at, ErrorCode::OrderExpired);
        require!(
            order.oracle_feed == ctx.accounts.oracle_price_feed.key(),
            ErrorCode::OracleFeedMismatch
        );
        require!(
            order.escrow_token_account == ctx.accounts.escrow_token_account.key(),
            ErrorCode::InvalidEscrowAccount
        );
        require!(
            order.sol_vault_pda == ctx.accounts.sol_vault.key(),
            ErrorCode::VaultMismatchConfig
        );
        require!(
            ctx.accounts.treasury_usdc_ata.mint == ctx.accounts.vault_config.usdc_test_mint,
            ErrorCode::InvalidMint
        );
        require!(!ctx.accounts.vault_config.paused, ErrorCode::VaultPaused);

        let oracle_feed_data = ctx.accounts.oracle_price_feed.try_borrow_data()?;
        let (price_value, price_confidence, exponent, price_ts) = parse_pyth_price(&oracle_feed_data)?;

        let age_seconds = (now - price_ts).max(0);
        require!(
            age_seconds <= i64::from(order.max_oracle_age_seconds),
            ErrorCode::OracleDataStale
        );
        require!(price_ts >= 0, ErrorCode::OracleDataStale);
        require!(price_value > 0, ErrorCode::InvalidOraclePrice);

        let max_confidence = u64::from(order.max_confidence_bps);
        let conf_bps = confidence_bps(price_confidence, price_value)?;
        require!(conf_bps <= max_confidence, ErrorCode::OracleConfidenceTooHigh);

        let oracle_price_e8 = pyth_price_to_e8(price_value, exponent)?;
        let target_price_e8 =
            u64::try_from(oracle_price_e8).map_err(|_| ErrorCode::InvalidOraclePrice)?;
        require!(
            target_price_e8 <= order.target_price_usd_e8,
            ErrorCode::OraclePriceTooHigh
        );

        let required_usdc = compute_required_usdc(
            order.desired_sol_lamports,
            target_price_e8,
            u32::from(ctx.accounts.vault_config.usdc_decimals),
        )?;
        require!(required_usdc > 0, ErrorCode::InvalidRequiredUsdc);
        require!(required_usdc <= order.max_usdc_in, ErrorCode::RequiredUsdcExceedsLimit);
        require!(
            required_usdc <= order.escrowed_usdc_amount,
            ErrorCode::EscrowInsufficient
        );

        let min_vault_balance = MIN_SOL_VAULT_MARGIN_LAMPORTS
            .checked_add(order.desired_sol_lamports)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(
            ctx.accounts.sol_vault.to_account_info().lamports() >= min_vault_balance,
            ErrorCode::VaultInsufficientSol
        );

        let escrow_authority_seeds = [
            ESCROW_AUTHORITY_SEED,
            ctx.accounts.order.to_account_info().key.as_ref(),
            &[order.escrow_authority_bump],
        ];

        let to_treasury_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.treasury_usdc_ata.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
            },
            &[&escrow_authority_seeds],
        );
        token::transfer_checked(
            to_treasury_ctx,
            required_usdc,
            ctx.accounts.vault_config.usdc_decimals,
        )?;

        let leftover = order
            .escrowed_usdc_amount
            .saturating_sub(required_usdc);
        if leftover > 0 {
            let to_user_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_token_account.to_account_info(),
                    to: ctx.accounts.user_usdc_token_account.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                },
                &[&escrow_authority_seeds],
            );
            token::transfer_checked(
                to_user_ctx,
                leftover,
                ctx.accounts.vault_config.usdc_decimals,
            )?;
        }

        let sol_vault_seeds = [
            SOL_VAULT_SEED,
            ctx.accounts.vault_config.to_account_info().key.as_ref(),
            &[ctx.accounts.vault_config.vault_bump],
        ];
        let transfer_ix = system_instruction::transfer(
            &ctx.accounts.sol_vault.key(),
            &ctx.accounts.recipient.key(),
            order.desired_sol_lamports,
        );
        let sol_vault_accounts = [
            ctx.accounts.sol_vault.to_account_info(),
            ctx.accounts.recipient.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ];
        invoke_signed(&transfer_ix, &sol_vault_accounts, &[&sol_vault_seeds])?;

        order.status = STATUS_EXECUTED;
        order.executed_usdc_amount = required_usdc;
        order.executed_sol_lamports = order.desired_sol_lamports;
        order.escrowed_usdc_amount = 0;

        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        require!(!ctx.accounts.vault_config.paused, ErrorCode::VaultPaused);
        require!(ctx.accounts.order.status == STATUS_OPEN, ErrorCode::OrderNotOpen);
        require_keys_eq!(ctx.accounts.user.key(), ctx.accounts.order.user, ErrorCode::SignerMismatch);
        require!(
            Clock::get()?.unix_timestamp <= ctx.accounts.order.expires_at,
            ErrorCode::OrderNotExpired
        );
        require!(
            ctx.accounts.order.escrowed_usdc_amount > 0,
            ErrorCode::EscrowInsufficient
        );

        let order = &mut ctx.accounts.order;
        let order_key = order.key();
        refund_escrow_to_user(
            order,
            &order_key,
            &ctx.accounts.order_user_escrow_authority.to_account_info(),
            &ctx.accounts.token_program,
            &ctx.accounts.escrow_token_account,
            &ctx.accounts.user_usdc_token_account,
            &ctx.accounts.usdc_mint,
            ctx.accounts.vault_config.usdc_decimals,
        )?;

        order.status = STATUS_CANCELLED;
        Ok(())
    }

    pub fn reclaim_expired_order(ctx: Context<CancelOrder>) -> Result<()> {
        require!(!ctx.accounts.vault_config.paused, ErrorCode::VaultPaused);
        require!(ctx.accounts.order.status == STATUS_OPEN, ErrorCode::OrderNotOpen);
        require_keys_eq!(ctx.accounts.user.key(), ctx.accounts.order.user, ErrorCode::SignerMismatch);
        require!(
            Clock::get()?.unix_timestamp > ctx.accounts.order.expires_at,
            ErrorCode::OrderExpired
        );
        require!(
            ctx.accounts.order.escrowed_usdc_amount > 0,
            ErrorCode::EscrowInsufficient
        );

        let order = &mut ctx.accounts.order;
        let order_key = order.key();
        refund_escrow_to_user(
            order,
            &order_key,
            &ctx.accounts.order_user_escrow_authority.to_account_info(),
            &ctx.accounts.token_program,
            &ctx.accounts.escrow_token_account,
            &ctx.accounts.user_usdc_token_account,
            &ctx.accounts.usdc_mint,
            ctx.accounts.vault_config.usdc_decimals,
        )?;

        order.status = STATUS_RECLAIMED;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeVaultConfigParams {
    pub treasury_usdc_ata: Pubkey,
    pub usdc_test_mint: Pubkey,
    pub oracle_feed: Pubkey,
    pub usdc_decimals: u8,
    pub max_oracle_age_seconds: u32,
    pub max_confidence_bps: u16,
    pub vault_bump: u8,
    pub paused: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct FundSolVaultParams {
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateOrderAndDepositParams {
    pub client_order_id: u64,
    pub desired_sol_lamports: u64,
    pub max_usdc_in: u64,
    pub target_price_usd_e8: u64,
    pub expires_at: i64,
    pub recipient: Pubkey,
    pub oracle_feed: Pubkey,
    pub max_oracle_age_seconds: u32,
    pub max_confidence_bps: u16,
    pub deposit_amount: u64,
}

#[account]
pub struct VaultConfig {
    pub admin: Pubkey,
    pub treasury_usdc_ata: Pubkey,
    pub usdc_test_mint: Pubkey,
    pub oracle_feed: Pubkey,
    pub usdc_decimals: u8,
    pub max_oracle_age_seconds: u32,
    pub max_confidence_bps: u16,
    pub paused: bool,
    pub vault_bump: u8,
    pub bump: u8,
}

impl VaultConfig {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 1 + 4 + 2 + 1 + 1 + 1;
}

#[account]
pub struct Order {
    pub user: Pubkey,
    pub recipient: Pubkey,
    pub client_order_id: u64,
    pub usdc_test_mint: Pubkey,
    pub escrow_token_account: Pubkey,
    pub treasury_usdc_ata: Pubkey,
    pub sol_vault_pda: Pubkey,
    pub oracle_feed: Pubkey,
    pub desired_sol_lamports: u64,
    pub max_usdc_in: u64,
    pub target_price_usd_e8: u64,
    pub max_oracle_age_seconds: u32,
    pub max_confidence_bps: u16,
    pub escrowed_usdc_amount: u64,
    pub executed_usdc_amount: u64,
    pub executed_sol_lamports: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub escrow_authority_bump: u8,
    pub status: u8,
    pub bump: u8,
}

impl Order {
    pub const LEN: usize = 32
        + 32
        + 8
        + 32
        + 32
        + 32
        + 32
        + 32
        + 8
        + 8
        + 8
        + 4
        + 2
        + 8
        + 8
        + 8
        + 8
        + 8
        + 1
        + 1
        + 1;
}

#[derive(Accounts)]
pub struct InitializeVaultConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + VaultConfig::LEN,
        seeds = [VAULT_CONFIG_SEED],
        bump
    )]
    pub vault_config: Account<'info, VaultConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: FundSolVaultParams)]
pub struct FundSolVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [VAULT_CONFIG_SEED],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        init_if_needed,
        payer = admin,
        space = 0,
        seeds = [SOL_VAULT_SEED, vault_config.key().as_ref()],
        bump = vault_config.vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: CreateOrderAndDepositParams)]
pub struct CreateOrderAndDeposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_usdc_token_account.owner == user.key() @ ErrorCode::InvalidTokenOwner,
        constraint = user_usdc_token_account.mint == vault_config.usdc_test_mint @ ErrorCode::InvalidMint,
    )]
    pub user_usdc_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = user,
        space = 8 + Order::LEN,
        seeds = [ORDER_SEED, user.key().as_ref(), &params.client_order_id.to_le_bytes()],
        bump,
    )]
    pub order: Account<'info, Order>,

    #[account(
        seeds = [ESCROW_AUTHORITY_SEED, order.key().as_ref()],
        bump
    )]
    pub escrow_authority: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::authority = escrow_authority,
        associated_token::mint = vault_config.usdc_test_mint,
        associated_token::token_program = token_program,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [VAULT_CONFIG_SEED],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        constraint = treasury_usdc_ata.key() == vault_config.treasury_usdc_ata @ ErrorCode::TreasuryAtaMismatch,
        token::mint = vault_config.usdc_test_mint,
    )]
    pub treasury_usdc_ata: Account<'info, TokenAccount>,

    #[account(address = vault_config.usdc_test_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        seeds = [SOL_VAULT_SEED, vault_config.key().as_ref()],
        bump = vault_config.vault_bump,
    )]
    pub sol_vault_pda: SystemAccount<'info>,

    #[account(address = vault_config.oracle_feed)]
    pub oracle_price_feed: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteOrder<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,

    #[account(mut)]
    pub order: Account<'info, Order>,

    #[account(
        seeds = [VAULT_CONFIG_SEED],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(mut)]
    pub recipient: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, vault_config.key().as_ref()],
        bump = vault_config.vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        mut,
        constraint = escrow_token_account.key() == order.escrow_token_account @ ErrorCode::InvalidEscrowAccount,
        token::mint = vault_config.usdc_test_mint,
        associated_token::authority = escrow_authority,
        associated_token::mint = vault_config.usdc_test_mint,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = vault_config.usdc_test_mint,
        constraint = treasury_usdc_ata.key() == vault_config.treasury_usdc_ata @ ErrorCode::TreasuryAtaMismatch,
    )]
    pub treasury_usdc_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = vault_config.usdc_test_mint,
        constraint = user_usdc_token_account.owner == order.user @ ErrorCode::InvalidTokenOwner,
    )]
    pub user_usdc_token_account: Account<'info, TokenAccount>,

    #[account(address = vault_config.usdc_test_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(address = order.oracle_feed)]
    pub oracle_price_feed: AccountInfo<'info>,

    #[account(
        seeds = [ESCROW_AUTHORITY_SEED, order.key().as_ref()],
        bump = order.escrow_authority_bump,
    )]
    pub escrow_authority: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub order: Account<'info, Order>,

    #[account(
        seeds = [VAULT_CONFIG_SEED],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        constraint = escrow_token_account.key() == order.escrow_token_account @ ErrorCode::InvalidEscrowAccount
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = vault_config.usdc_test_mint,
        constraint = user_usdc_token_account.owner == order.user @ ErrorCode::InvalidTokenOwner,
    )]
    pub user_usdc_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [ESCROW_AUTHORITY_SEED, order.key().as_ref()],
        bump = order.escrow_authority_bump,
    )]
    pub order_user_escrow_authority: SystemAccount<'info>,

    #[account(address = vault_config.usdc_test_mint)]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

fn refund_escrow_to_user(
    order: &mut Account<Order>,
    order_account_key: &Pubkey,
    escrow_authority: &AccountInfo,
    token_program: &Program<Token>,
    escrow_token_account: &Account<TokenAccount>,
    user_token_account: &Account<TokenAccount>,
    usdc_mint: &Account<Mint>,
    usdc_decimals: u8,
) -> Result<()> {
    if order.escrowed_usdc_amount == 0 {
        return Ok(());
    }

    let seeds = [
        ESCROW_AUTHORITY_SEED,
        order_account_key.as_ref(),
        &[order.escrow_authority_bump],
    ];

    let refund_ctx = CpiContext::new_with_signer(
        token_program.to_account_info(),
        TransferChecked {
            from: escrow_token_account.to_account_info(),
            to: user_token_account.to_account_info(),
            authority: escrow_authority.to_account_info(),
            mint: usdc_mint.to_account_info(),
        },
        &[&seeds],
    );

    token::transfer_checked(
        refund_ctx,
        order.escrowed_usdc_amount,
        usdc_decimals,
    )?;
    order.escrowed_usdc_amount = 0;
    Ok(())
}

fn parse_pyth_price(data: &[u8]) -> Result<(i64, u64, i32, i64)> {
    if data.len() < PYTH_PRICE_ACCOUNT_SIZE {
        return Err(ErrorCode::InvalidOracleFeed.into());
    }

    let magic = u32::from_le_bytes(
        data[0..4]
            .try_into()
            .map_err(|_| ErrorCode::InvalidOracleFeed)?,
    );
    require!(magic == PYTH_MAGIC, ErrorCode::InvalidOracleFeed);

    let version = u32::from_le_bytes(
        data[4..8]
            .try_into()
            .map_err(|_| ErrorCode::InvalidOracleFeed)?,
    );
    require!(version == PYTH_VERSION, ErrorCode::InvalidOracleFeed);

    let price_type = u32::from_le_bytes(
        data[8..12]
            .try_into()
            .map_err(|_| ErrorCode::InvalidOracleFeed)?,
    );
    require!(price_type == PYTH_PRICE_TYPE, ErrorCode::InvalidOracleFeed);

    let exponent = i32::from_le_bytes(
        data[20..24]
            .try_into()
            .map_err(|_| ErrorCode::InvalidOracleFeed)?,
    );

    let status = u32::from_le_bytes(
        data[224..228]
            .try_into()
            .map_err(|_| ErrorCode::InvalidOracleFeed)?,
    );
    require!(status == PYTH_STATUS_TRADING, ErrorCode::OracleDataStale);

    let price = i64::from_le_bytes(
        data[208..216]
            .try_into()
            .map_err(|_| ErrorCode::InvalidOracleFeed)?,
    );
    let confidence = u64::from_le_bytes(
        data[216..224]
            .try_into()
            .map_err(|_| ErrorCode::InvalidOracleFeed)?,
    );
    let timestamp = i64::from_le_bytes(
        data[296..304]
            .try_into()
            .map_err(|_| ErrorCode::InvalidOracleFeed)?,
    );

    Ok((price, confidence, exponent, timestamp))
}

fn pyth_price_to_e8(price: i64, exponent: i32) -> Result<i64> {
    let as_128 = i128::from(price);
    require!(as_128 > 0, ErrorCode::InvalidOraclePrice);

    let normalized = if exponent == -8 {
        as_128
    } else if exponent < -8 {
        let delta = usize::try_from((-exponent - 8) as i64).map_err(|_| ErrorCode::OraclePowOverflow)?;
        let factor = 10_i128
            .checked_pow(delta as u32)
            .ok_or(ErrorCode::OraclePowOverflow)?;
        as_128
            .checked_div(factor)
            .ok_or(ErrorCode::OraclePowOverflow)?
    } else {
        let delta = usize::try_from(exponent + 8).map_err(|_| ErrorCode::OraclePowOverflow)?;
        let factor = 10_i128
            .checked_pow(delta as u32)
            .ok_or(ErrorCode::OraclePowOverflow)?;
        as_128
            .checked_mul(factor)
            .ok_or(ErrorCode::OraclePowOverflow)?
    };

    i64::try_from(normalized).map_err(|_| ErrorCode::OracleInvalidPrecision.into())
}

fn confidence_bps(confidence: u64, price: i64) -> Result<u64> {
    let price_abs = i128::from(price).abs();
    require!(price_abs > 0, ErrorCode::OracleInvalidPrecision);

    let conf = u128::from(confidence);
    let scaled = conf
        .checked_mul(10_000)
        .ok_or(ErrorCode::OracleInvalidPrecision)?;
    let bps = scaled
        .checked_div(price_abs as u128)
        .ok_or(ErrorCode::OracleInvalidPrecision)?;
    u64::try_from(bps).map_err(|_| ErrorCode::OracleInvalidPrecision.into())
}

fn compute_required_usdc(
    desired_sol_lamports: u64,
    oracle_price_e8: u64,
    usdc_decimals: u32,
) -> Result<u64> {
    let lamports_u128 = u128::from(desired_sol_lamports);
    let price_u128 = u128::from(oracle_price_e8);
    let usdc_scale = 10_u128
        .checked_pow(usdc_decimals)
        .ok_or(ErrorCode::InvalidUsdcDecimals)?;
    let denominator = LAMPORTS_PER_SOL
        .checked_mul(10_00000000u64)
        .ok_or(ErrorCode::MathOverflow)? as u128;

    let numerator = lamports_u128
        .checked_mul(price_u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_mul(usdc_scale)
        .ok_or(ErrorCode::MathOverflow)?;

    let rounded = numerator
        .checked_add(denominator.saturating_sub(1))
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(denominator)
        .ok_or(ErrorCode::MathOverflow)?;

    u64::try_from(rounded).map_err(|_| ErrorCode::MathOverflow.into())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Vault config is paused")]
    VaultPaused,
    #[msg("Invalid client order id")]
    InvalidClientOrderId,
    #[msg("Invalid desired SOL amount")]
    InvalidDesiredSolAmount,
    #[msg("Invalid max USDC amount")]
    InvalidMaxUsdcIn,
    #[msg("Invalid target price")]
    InvalidTargetPrice,
    #[msg("Invalid deposit amount")]
    InvalidDepositAmount,
    #[msg("Deposit exceeds max USDC")]
    DepositExceedsMaxUsdc,
    #[msg("Invalid oracle age")]
    InvalidOracleAge,
    #[msg("Invalid confidence bps")]
    InvalidConfidenceBps,
    #[msg("Order has already been processed")]
    OrderNotOpen,
    #[msg("Order expired")]
    OrderExpired,
    #[msg("Order not yet expired")]
    OrderNotExpired,
    #[msg("Invalid recipient")]
    InvalidRecipient,
    #[msg("Oracle feed mismatch")]
    OracleFeedMismatch,
    #[msg("Invalid oracle account data")]
    InvalidOracleAccountData,
    #[msg("Invalid oracle feed format")]
    InvalidOracleFeed,
    #[msg("Oracle data stale")]
    OracleDataStale,
    #[msg("Invalid oracle price")]
    InvalidOraclePrice,
    #[msg("Oracle price above target")]
    OraclePriceTooHigh,
    #[msg("Invalid token mint")]
    InvalidMint,
    #[msg("Invalid token account owner")]
    InvalidTokenOwner,
    #[msg("Escrow token account mismatch")]
    InvalidEscrowAccount,
    #[msg("Treasury ATA mismatch")]
    TreasuryAtaMismatch,
    #[msg("Required USDC is invalid")]
    InvalidRequiredUsdc,
    #[msg("Confidence cap out of range")]
    InvalidConfidenceBpsRange,
    #[msg("Required USDC exceeds configured max")]
    RequiredUsdcExceedsLimit,
    #[msg("Escrow doesn't have enough USDC")]
    EscrowInsufficient,
    #[msg("SOL vault lacks liquidity")]
    VaultInsufficientSol,
    #[msg("USDC decimals are unsupported")]
    InvalidUsdcDecimals,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Oracle power overflow")]
    OraclePowOverflow,
    #[msg("Oracle precision error")]
    OracleInvalidPrecision,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid fund amount")]
    InvalidFundAmount,
    #[msg("Vault transfer failed")]
    VaultTransferFailed,
    #[msg("Oracle confidence too high")]
    OracleConfidenceTooHigh,
    #[msg("Invalid vault config")]
    VaultMismatchConfig,
    #[msg("Invalid system account for execution")]
    InvalidSolVault,
    #[msg("Signer mismatch")]
    SignerMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_required_usdc_math_rounding_up() {
        let required = compute_required_usdc(1_000_000_000, 120_00000000, 6).unwrap();
        assert_eq!(required, 120_000_000);
    }

    #[test]
    fn test_required_usdc_small_amount_rounds_up() {
        let required = compute_required_usdc(1, 150_00000000, 6).unwrap();
        assert_eq!(required, 2);
    }

    #[test]
    fn test_pyth_price_to_e8_applies_decimal_shift() {
        assert_eq!(pyth_price_to_e8(150_00000000, -8).unwrap(), 150_00000000);
        assert_eq!(pyth_price_to_e8(2_00000000, -7).unwrap(), 200_00000000);
        assert_eq!(pyth_price_to_e8(2_500000000, -9).unwrap(), 250000000);
    }

    #[test]
    fn test_confidence_bps_calculation() {
        let bps = confidence_bps(500_000000, 100_00000000).unwrap();
        assert_eq!(bps, 0);
    }

    #[test]
    fn test_invalid_oracle_price_is_rejected() {
        let err = pyth_price_to_e8(-1, -8);
        assert!(err.is_err());
    }
}
