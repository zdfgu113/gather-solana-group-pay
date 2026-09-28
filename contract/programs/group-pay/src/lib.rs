use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[cfg(feature = "devnet")]
declare_id!("96piBXGNG9Ga8ycf6cpEJCFugjqpCvhuGjQHJc4KvzVe");
#[cfg(not(feature = "devnet"))]
declare_id!("6JrQobtnXBeNv4khZhBGCLEEfXk7pJ8Dw1UozaEhXK8R");

pub const EVENT_SEED: &[u8] = b"event";
pub const VAULT_SEED: &[u8] = b"vault";
pub const PARTICIPATION_SEED: &[u8] = b"participation";
pub const MIN_LEAD_SECONDS: i64 = 30 * 60;
pub const MAX_LEAD_SECONDS: i64 = 90 * 24 * 60 * 60;
pub const MAX_CAPACITY: u16 = 100;
pub const TITLE_MAX_BYTES: usize = 64;
pub const DESCRIPTION_MAX_BYTES: usize = 280;
pub const VENUE_MAX_BYTES: usize = 160;
pub const TIME_ZONE_MAX_BYTES: usize = 64;
// Canonical IANA identifiers supported by this first client; no time-zone rules live on chain.
pub const SUPPORTED_TIME_ZONES: &[&str] = &[
    "UTC", "America/Los_Angeles", "America/New_York", "America/Chicago",
    "Europe/London", "Europe/Berlin", "Europe/Paris", "Asia/Shanghai",
    "Asia/Tokyo", "Asia/Singapore", "Asia/Kolkata", "Australia/Sydney",
];

// Each build fixes one worthless classic SPL Token Mint; local fixtures remain reproducible.
#[cfg(feature = "devnet")]
pub const FIXED_TEST_MINT: Pubkey = pubkey!("BAKZoZLZakRYowjaee7aXTSvTe4hVEwCybBNMAygp8nV");
#[cfg(not(feature = "devnet"))]
pub const FIXED_TEST_MINT: Pubkey = pubkey!("9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj");

#[program]
pub mod group_pay {
    use super::*;

    pub fn create_event(ctx: Context<CreateEvent>, args: CreateEventArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_create_args(&args, now)?;

        let event = &mut ctx.accounts.event;
        event.event_id = args.event_id;
        event.organizer = ctx.accounts.organizer.key();
        event.organizer_token_account = ctx.accounts.organizer_token_account.key();
        event.mint = ctx.accounts.mint.key();
        event.vault = ctx.accounts.vault.key();
        event.title = args.title;
        event.description = args.description;
        event.fulfillment_mode = args.fulfillment_mode;
        event.venue = args.venue;
        event.time_zone = args.time_zone;
        event.unit_price = args.unit_price;
        event.min_wallets = args.min_wallets;
        event.capacity = args.capacity;
        event.registration_deadline = args.registration_deadline;
        event.event_start = args.event_start;
        event.participant_count = 0;
        event.refunded_count = 0;
        event.expected_escrow = 0;
        event.status = EventStatus::Open;
        event.empty_close_reason = EmptyCloseReason::NotClosed;
        event.bump = ctx.bumps.event;
        Ok(())
    }

    pub fn join_event(ctx: Context<JoinEvent>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &ctx.accounts.event;

        require!(event.status == EventStatus::Open, GroupPayError::EventNotOpen);
        require!(registration_is_open(now, event.registration_deadline), GroupPayError::RegistrationClosed);
        require!(event.participant_count < event.capacity, GroupPayError::EventFull);

        let next_count = event
            .participant_count
            .checked_add(1)
            .ok_or(GroupPayError::ArithmeticOverflow)?;
        let next_obligation = event
            .expected_escrow
            .checked_add(event.unit_price)
            .ok_or(GroupPayError::ArithmeticOverflow)?;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.participant_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.participant.to_account_info(),
                },
            ),
            event.unit_price,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.vault.reload()?;
        checked_unexpected_surplus(ctx.accounts.vault.amount, next_obligation)?;

        let event = &mut ctx.accounts.event;
        event.participant_count = next_count;
        event.expected_escrow = next_obligation;
        if next_count == event.capacity {
            event.status = EventStatus::Ready;
        }

        let participation = &mut ctx.accounts.participation;
        participation.event = event.key();
        participation.participant = ctx.accounts.participant.key();
        participation.paid_amount = event.unit_price;
        participation.joined_at = now;
        participation.refunded = false;
        participation.bump = ctx.bumps.participation;
        Ok(())
    }

    pub fn update_payout_account(ctx: Context<UpdatePayoutAccount>) -> Result<()> {
        let event = &mut ctx.accounts.event;
        require!(matches!(event.status, EventStatus::Open | EventStatus::Ready), GroupPayError::PayoutUpdateClosed);
        require_keys_neq!(event.organizer_token_account, ctx.accounts.new_organizer_token_account.key(), GroupPayError::PayoutAccountUnchanged);
        event.organizer_token_account = ctx.accounts.new_organizer_token_account.key();
        Ok(())
    }

    pub fn cancel_event(ctx: Context<CancelEvent>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &mut ctx.accounts.event;
        require!(event.status == EventStatus::Open, GroupPayError::EventNotOpen);
        require!(registration_is_open(now, event.registration_deadline), GroupPayError::CancellationClosed);
        checked_unexpected_surplus(ctx.accounts.vault.amount, event.expected_escrow)?;
        if event.participant_count == 0 {
            event.status = EventStatus::ClosedEmpty;
            event.empty_close_reason = EmptyCloseReason::Cancelled;
        } else {
            event.status = EventStatus::RefundingCancelled;
        }
        Ok(())
    }

    pub fn finalize_failed_or_empty(ctx: Context<FinalizeFailedOrEmpty>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &mut ctx.accounts.event;
        require!(event.status == EventStatus::Open, GroupPayError::EventNotOpen);
        require!(now >= event.registration_deadline, GroupPayError::DeadlineNotReached);
        require!(event.participant_count < event.min_wallets, GroupPayError::ThresholdMet);
        checked_unexpected_surplus(ctx.accounts.vault.amount, event.expected_escrow)?;
        if event.participant_count == 0 {
            event.status = EventStatus::ClosedEmpty;
            event.empty_close_reason = EmptyCloseReason::Deadline;
        } else {
            event.status = EventStatus::RefundingFailed;
        }
        Ok(())
    }

    pub fn settle_event(ctx: Context<SettleEvent>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &ctx.accounts.event;
        require!(matches!(event.status, EventStatus::Open | EventStatus::Ready), GroupPayError::EventNotSettleable);
        require!(event.status == EventStatus::Ready || now >= event.registration_deadline, GroupPayError::DeadlineNotReached);
        require!(event.participant_count >= event.min_wallets, GroupPayError::ThresholdNotMet);
        let amount = event.expected_escrow;
        checked_unexpected_surplus(ctx.accounts.vault.amount, amount)?;

        let event_id = event.event_id.to_le_bytes();
        let bump = [event.bump];
        let signer_seeds: &[&[u8]] = &[EVENT_SEED, event.organizer.as_ref(), &event_id, &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.organizer_token_account.to_account_info(),
                    authority: event.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.vault.reload()?;
        checked_unexpected_surplus(ctx.accounts.vault.amount, 0)?;
        let event = &mut ctx.accounts.event;
        event.expected_escrow = 0;
        event.status = EventStatus::Paid;
        Ok(())
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        let event = &ctx.accounts.event;
        require!(matches!(event.status, EventStatus::RefundingFailed | EventStatus::RefundingCancelled), GroupPayError::RefundNotAvailable);
        require!(!ctx.accounts.participation.refunded, GroupPayError::AlreadyRefunded);
        let amount = ctx.accounts.participation.paid_amount;
        let next_obligation = event.expected_escrow.checked_sub(amount).ok_or(GroupPayError::ArithmeticOverflow)?;
        let next_refunded = event.refunded_count.checked_add(1).ok_or(GroupPayError::ArithmeticOverflow)?;
        require!(next_refunded <= event.participant_count, GroupPayError::RefundCountExceeded);
        checked_unexpected_surplus(ctx.accounts.vault.amount, event.expected_escrow)?;

        let event_id = event.event_id.to_le_bytes();
        let bump = [event.bump];
        let signer_seeds: &[&[u8]] = &[EVENT_SEED, event.organizer.as_ref(), &event_id, &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.participant_token_account.to_account_info(),
                    authority: event.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.vault.reload()?;
        checked_unexpected_surplus(ctx.accounts.vault.amount, next_obligation)?;
        let event = &mut ctx.accounts.event;
        event.expected_escrow = next_obligation;
        event.refunded_count = next_refunded;
        if next_refunded == event.participant_count {
            event.status = EventStatus::Refunded;
        }
        ctx.accounts.participation.refunded = true;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(args: CreateEventArgs)]
pub struct CreateEvent<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,
    #[account(address = FIXED_TEST_MINT @ GroupPayError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(
        constraint = organizer_token_account.mint == mint.key() @ GroupPayError::WrongTokenAccountMint,
        constraint = organizer_token_account.owner == organizer.key() @ GroupPayError::WrongTokenAccountOwner
    )]
    pub organizer_token_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = organizer,
        space = 8 + Event::INIT_SPACE,
        seeds = [EVENT_SEED, organizer.key().as_ref(), &args.event_id.to_le_bytes()],
        bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        init,
        payer = organizer,
        seeds = [VAULT_SEED, event.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = event
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinEvent<'info> {
    #[account(mut)]
    pub participant: Signer<'info>,
    #[account(address = FIXED_TEST_MINT @ GroupPayError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = participant_token_account.mint == mint.key() @ GroupPayError::WrongTokenAccountMint,
        constraint = participant_token_account.owner == participant.key() @ GroupPayError::WrongTokenAccountOwner
    )]
    pub participant_token_account: Account<'info, TokenAccount>,
    #[account(mut, has_one = mint, has_one = vault)]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        constraint = vault.mint == mint.key() @ GroupPayError::WrongTokenAccountMint,
        constraint = vault.owner == event.key() @ GroupPayError::WrongVaultAuthority
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = participant,
        space = 8 + Participation::INIT_SPACE,
        seeds = [PARTICIPATION_SEED, event.key().as_ref(), participant.key().as_ref()],
        bump
    )]
    pub participation: Account<'info, Participation>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePayoutAccount<'info> {
    pub organizer: Signer<'info>,
    #[account(mut, has_one = organizer)]
    pub event: Account<'info, Event>,
    #[account(
        constraint = new_organizer_token_account.mint == event.mint @ GroupPayError::WrongTokenAccountMint,
        constraint = new_organizer_token_account.owner == event.organizer @ GroupPayError::WrongTokenAccountOwner
    )]
    pub new_organizer_token_account: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct CancelEvent<'info> {
    pub organizer: Signer<'info>,
    #[account(mut, has_one = organizer, has_one = vault)]
    pub event: Account<'info, Event>,
    #[account(
        constraint = vault.mint == event.mint @ GroupPayError::WrongTokenAccountMint,
        constraint = vault.owner == event.key() @ GroupPayError::WrongVaultAuthority
    )]
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct FinalizeFailedOrEmpty<'info> {
    pub caller: Signer<'info>,
    #[account(mut, has_one = vault)]
    pub event: Account<'info, Event>,
    #[account(
        constraint = vault.mint == event.mint @ GroupPayError::WrongTokenAccountMint,
        constraint = vault.owner == event.key() @ GroupPayError::WrongVaultAuthority
    )]
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct SettleEvent<'info> {
    pub caller: Signer<'info>,
    #[account(address = FIXED_TEST_MINT @ GroupPayError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, has_one = mint, has_one = vault, has_one = organizer_token_account)]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        constraint = vault.mint == mint.key() @ GroupPayError::WrongTokenAccountMint,
        constraint = vault.owner == event.key() @ GroupPayError::WrongVaultAuthority
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = organizer_token_account.mint == mint.key() @ GroupPayError::WrongTokenAccountMint,
        constraint = organizer_token_account.owner == event.organizer @ GroupPayError::WrongTokenAccountOwner
    )]
    pub organizer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    pub participant: Signer<'info>,
    #[account(address = FIXED_TEST_MINT @ GroupPayError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, has_one = mint, has_one = vault)]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        constraint = vault.mint == mint.key() @ GroupPayError::WrongTokenAccountMint,
        constraint = vault.owner == event.key() @ GroupPayError::WrongVaultAuthority
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [PARTICIPATION_SEED, event.key().as_ref(), participant.key().as_ref()],
        bump = participation.bump,
        has_one = event,
        has_one = participant
    )]
    pub participation: Account<'info, Participation>,
    #[account(
        mut,
        constraint = participant_token_account.mint == mint.key() @ GroupPayError::WrongTokenAccountMint,
        constraint = participant_token_account.owner == participant.key() @ GroupPayError::WrongTokenAccountOwner
    )]
    pub participant_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct CreateEventArgs {
    pub event_id: u64,
    #[max_len(64)]
    pub title: String,
    #[max_len(280)]
    pub description: String,
    pub fulfillment_mode: FulfillmentMode,
    #[max_len(160)]
    pub venue: String,
    #[max_len(64)]
    pub time_zone: String,
    pub unit_price: u64,
    pub min_wallets: u16,
    pub capacity: u16,
    pub registration_deadline: i64,
    pub event_start: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Event {
    pub event_id: u64,
    pub organizer: Pubkey,
    pub organizer_token_account: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    #[max_len(64)]
    pub title: String,
    #[max_len(280)]
    pub description: String,
    pub fulfillment_mode: FulfillmentMode,
    #[max_len(160)]
    pub venue: String,
    #[max_len(64)]
    pub time_zone: String,
    pub unit_price: u64,
    pub min_wallets: u16,
    pub capacity: u16,
    pub registration_deadline: i64,
    pub event_start: i64,
    pub participant_count: u16,
    pub refunded_count: u16,
    pub expected_escrow: u64,
    pub status: EventStatus,
    pub empty_close_reason: EmptyCloseReason,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Participation {
    pub event: Pubkey,
    pub participant: Pubkey,
    pub paid_amount: u64,
    pub joined_at: i64,
    pub refunded: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum FulfillmentMode {
    Offline,
    Online,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum EventStatus {
    Open,
    Ready,
    Paid,
    RefundingFailed,
    RefundingCancelled,
    Refunded,
    ClosedEmpty,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum EmptyCloseReason {
    NotClosed,
    Cancelled,
    Deadline,
}

fn validate_create_args(args: &CreateEventArgs, now: i64) -> Result<()> {
    require!(!args.title.trim().is_empty(), GroupPayError::EmptyTitle);
    require!(!args.description.trim().is_empty(), GroupPayError::EmptyDescription);
    require!(!args.venue.trim().is_empty(), GroupPayError::EmptyVenue);
    require!(args.title.len() <= TITLE_MAX_BYTES, GroupPayError::TitleTooLong);
    require!(args.description.len() <= DESCRIPTION_MAX_BYTES, GroupPayError::DescriptionTooLong);
    require!(args.venue.len() <= VENUE_MAX_BYTES, GroupPayError::VenueTooLong);
    require!(args.time_zone.len() <= TIME_ZONE_MAX_BYTES, GroupPayError::TimeZoneTooLong);
    require!(SUPPORTED_TIME_ZONES.contains(&args.time_zone.as_str()), GroupPayError::UnsupportedTimeZone);
    require!(args.unit_price > 0, GroupPayError::InvalidPrice);
    require!(args.min_wallets >= 2, GroupPayError::InvalidMinimum);
    require!(args.capacity >= args.min_wallets, GroupPayError::InvalidCapacity);
    require!(args.capacity <= MAX_CAPACITY, GroupPayError::InvalidCapacity);

    let earliest = now
        .checked_add(MIN_LEAD_SECONDS)
        .ok_or(GroupPayError::ArithmeticOverflow)?;
    let latest = now
        .checked_add(MAX_LEAD_SECONDS)
        .ok_or(GroupPayError::ArithmeticOverflow)?;
    require!(args.registration_deadline >= earliest, GroupPayError::DeadlineTooSoon);
    require!(args.registration_deadline <= latest, GroupPayError::DeadlineTooFar);
    require!(args.event_start > args.registration_deadline, GroupPayError::EventNotAfterDeadline);
    Ok(())
}

fn registration_is_open(now: i64, registration_deadline: i64) -> bool {
    now < registration_deadline
}

pub fn checked_unexpected_surplus(actual_vault_balance: u64, legal_obligation: u64) -> Result<u64> {
    actual_vault_balance
        .checked_sub(legal_obligation)
        .ok_or_else(|| error!(GroupPayError::VaultBelowObligation))
}

#[error_code]
pub enum GroupPayError {
    #[msg("The supplied mint is not the fixed worthless test mint")]
    WrongMint,
    #[msg("The token account uses a different mint")]
    WrongTokenAccountMint,
    #[msg("The token account is not owned by the expected signer")]
    WrongTokenAccountOwner,
    #[msg("The vault authority is not the event PDA")]
    WrongVaultAuthority,
    #[msg("The event is not open")]
    EventNotOpen,
    #[msg("Registration is closed; joining requires now < deadline")]
    RegistrationClosed,
    #[msg("The event has no remaining seats")]
    EventFull,
    #[msg("The title is required")]
    EmptyTitle,
    #[msg("The description is required")]
    EmptyDescription,
    #[msg("The venue or online method is required")]
    EmptyVenue,
    #[msg("The UTF-8 title exceeds 64 bytes")]
    TitleTooLong,
    #[msg("The UTF-8 description exceeds 280 bytes")]
    DescriptionTooLong,
    #[msg("The UTF-8 venue exceeds 160 bytes")]
    VenueTooLong,
    #[msg("The IANA time zone identifier exceeds 64 UTF-8 bytes")]
    TimeZoneTooLong,
    #[msg("The IANA time zone is not supported by this version")]
    UnsupportedTimeZone,
    #[msg("The unit price must be greater than zero")]
    InvalidPrice,
    #[msg("The minimum number of wallets must be at least two")]
    InvalidMinimum,
    #[msg("Capacity must be between the minimum and 100")]
    InvalidCapacity,
    #[msg("The registration deadline must be at least 30 minutes away")]
    DeadlineTooSoon,
    #[msg("The registration deadline cannot be more than 90 days away")]
    DeadlineTooFar,
    #[msg("The event start must be later than the registration deadline")]
    EventNotAfterDeadline,
    #[msg("The actual vault balance is below the legal funding obligation")]
    VaultBelowObligation,
    #[msg("Checked arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Cancellation requires OPEN and now < deadline")]
    CancellationClosed,
    #[msg("The deadline has not been reached")]
    DeadlineNotReached,
    #[msg("The event has already met its minimum")]
    ThresholdMet,
    #[msg("The event has not met its minimum")]
    ThresholdNotMet,
    #[msg("The event cannot be settled in its current state")]
    EventNotSettleable,
    #[msg("Refunds are unavailable in the current state")]
    RefundNotAvailable,
    #[msg("This participation has already been refunded")]
    AlreadyRefunded,
    #[msg("Refund count exceeds the number of participants")]
    RefundCountExceeded,
    #[msg("The payout account can only change in OPEN or READY")]
    PayoutUpdateClosed,
    #[msg("The payout account is unchanged")]
    PayoutAccountUnchanged,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadline_boundary_is_exclusive() {
        let deadline = 1_000;
        assert!(registration_is_open(999, deadline));
        assert!(!registration_is_open(deadline, deadline));
        assert!(!registration_is_open(1_001, deadline));
    }

    fn valid_args(now: i64) -> CreateEventArgs {
        CreateEventArgs {
            event_id: 1,
            title: "Demo".into(),
            description: "Local test event".into(),
            fulfillment_mode: FulfillmentMode::Offline,
            venue: "Test venue".into(),
            time_zone: "Asia/Shanghai".into(),
            unit_price: 25,
            min_wallets: 2,
            capacity: 4,
            registration_deadline: now + MIN_LEAD_SECONDS,
            event_start: now + MIN_LEAD_SECONDS + 1,
        }
    }

    #[test]
    fn create_constraints_accept_inclusive_time_window_boundaries() {
        let now = 10_000;
        assert!(validate_create_args(&valid_args(now), now).is_ok());

        let mut latest = valid_args(now);
        latest.registration_deadline = now + MAX_LEAD_SECONDS;
        latest.event_start = latest.registration_deadline + 1;
        assert!(validate_create_args(&latest, now).is_ok());
    }

    #[test]
    fn create_constraints_reject_invalid_numbers_and_time_order() {
        let now = 10_000;
        let mut args = valid_args(now);
        args.unit_price = 0;
        assert!(validate_create_args(&args, now).is_err());

        let mut args = valid_args(now);
        args.capacity = args.min_wallets - 1;
        assert!(validate_create_args(&args, now).is_err());

        let mut args = valid_args(now);
        args.registration_deadline = now + MIN_LEAD_SECONDS - 1;
        assert!(validate_create_args(&args, now).is_err());

        let mut args = valid_args(now);
        args.event_start = args.registration_deadline;
        assert!(validate_create_args(&args, now).is_err());
    }

    #[test]
    fn surplus_uses_actual_balance_minus_obligation() {
        assert_eq!(checked_unexpected_surplus(107, 100).unwrap(), 7);
        assert_eq!(checked_unexpected_surplus(100, 100).unwrap(), 0);
    }

    #[test]
    fn time_zone_is_bounded_and_rejects_unknown_identifiers() {
        let now = 10_000;
        for zone in SUPPORTED_TIME_ZONES {
            let mut args = valid_args(now);
            args.time_zone = (*zone).into();
            assert!(validate_create_args(&args, now).is_ok(), "{zone}");
        }
        let mut unknown = valid_args(now);
        unknown.time_zone = "Mars/Olympus_Mons".into();
        assert!(validate_create_args(&unknown, now).is_err());
        let mut oversized = valid_args(now);
        oversized.time_zone = "x".repeat(TIME_ZONE_MAX_BYTES + 1);
        assert!(validate_create_args(&oversized, now).is_err());
    }

    #[test]
    fn shortage_is_an_explicit_error_not_unsigned_underflow() {
        assert!(checked_unexpected_surplus(99, 100).is_err());
    }
}
