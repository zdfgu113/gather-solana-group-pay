# Architecture and trust boundaries

## Product state model

Each activity has one Event PDA, one SPL Token vault PDA and at most one Participation PDA per participant wallet. The fixed-price flow is:

```text
OPEN
├─ join before deadline → OPEN or READY when capacity is reached
├─ organizer cancel before deadline → REFUNDING_CANCELLED or CLOSED_EMPTY
└─ after deadline
   ├─ minimum met → PAID after settlement
   ├─ below minimum → REFUNDING_FAILED
   └─ zero participants → CLOSED_EMPTY

REFUNDING_CANCELLED / REFUNDING_FAILED
└─ every participant claims once → REFUNDED
```

`READY` is irreversible and can be settled by any caller. The organizer can update only the payout Token Account, only while the Event is `OPEN` or `READY`, and only to another initialized classic SPL Token Account for the same Mint and original organizer.

The program tracks `expected_escrow` independently of the vault's raw balance. Direct third-party token transfers therefore do not increase participant count or organizer entitlement.

## Program instructions

- `create_event`
- `join_event`
- `update_payout_account`
- `cancel_event`
- `finalize_failed_or_empty`
- `settle_event`
- `claim_refund`

On-chain checks remain the security boundary. Frontend role, deadline and terminal-state checks exist for UX and to avoid pointless signature prompts; they do not replace program validation.

## Frontend modes

### Simulation

The default React state machine uses no wallet or network. It communicates the rules and supports English and Simplified Chinese. All identities, balances and records in this mode are illustrative.

### Fixed read-only Devnet display

The user must explicitly enter Devnet mode. For either allowlisted completed activity, the frontend calls only the same-origin `/.netlify/functions/read-event` endpoint. The Function fixes:

- cluster: Solana Devnet;
- Program and classic SPL Token Mint;
- the two Event, Vault and payout addresses;
- the allowed RPC methods and parameter shapes;
- request, upstream-response, output-size and total-time bounds.

One request performs three fixed `getAccountInfo` calls plus `getProgramAccounts`, `getSlot` and `getBlockTime`. It does not retry automatically and exposes no provider credential. Returned bytes are decoded with the committed IDL and rejected unless account ownership, PDAs, Mint, Token Program, payout ownership, terminal state, escrow accounting and participation records agree with the fixed public identities.

### Transaction paths

The repository retains the Devnet transaction client and pending-recovery logic. Signed transactions are recorded before broadcast; definite preflight rejection is separated from an unknown network result; unknown results remain pending; and confirmed transactions are distinguished from later legal state successors.

These paths are present for source review but were not exercised during the production read-only release. The public release claim is intentionally narrower than the source capability.

## Credential boundary

The provider key belongs only in the Function runtime as `HELIUS_DEVNET_API_KEY`. It must never be prefixed with `VITE_`, committed, printed, embedded in a URL visible to the browser, or copied into a static build. The checked-in examples contain no real value.

## Deliberate first-version limits

- Fixed classic SPL Token Mint and Devnet Program.
- Capacity is capped at 100 distinct wallets.
- No event editing beyond constrained payout-account recovery.
- No automatic refunds or scheduled settlement.
- No account closure or rent recovery.
- No surplus-token sweep.
- No fulfillment guarantee or dispute system.
- No mainnet deployment.
