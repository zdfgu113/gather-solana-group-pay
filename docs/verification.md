# Verification record and evidence boundaries

This document separates locally rerunnable tests, current production read-only evidence and historical Devnet transaction evidence. They are not interchangeable.

## Standalone package verification

The commands below were run on 2026-09-28 from the standalone package after its allowlisted files were copied. Results are recorded without treating a build, local validator or mock as a live-chain transaction:

| Command | Result |
| --- | --- |
| `npm ci` | Exit 0 with Node.js 26.3.0 and npm 11.16.0; 532 locked packages installed |
| `npm run verify` | Exit 0; 41 application/Function tests plus 1 seven-file artifact test passed, 0 failed or skipped; TypeScript and Vite production-shape build succeeded |
| `npm run test:browser` | Exit 0; 3 isolated Microsoft Edge scenarios passed at 390 px using mocked same-origin reads, with no wallet or Devnet access |
| `cd contract && bash scripts/verify-phase2b.sh` | Exit 0 in WSL; Anchor build, committed/generated IDL check and TypeScript typecheck passed; 6 Rust unit tests and 20 LiteSVM/local-validator integration tests passed |
| Public-package secret/path scan | Scanner self-test passed and the source package had 0 findings; no real `.env`, keypair, build, cache, log, browser-profile or Git metadata paths were present before dependency installation |

The contract scripts used their pinned Anchor CLI 1.2.0, Solana CLI 4.1.2 and Rust 1.89.0 toolchains. The local validator created a disposable temporary wallet and never contacted Devnet.

### Dependency-audit snapshot

`npm audit --omit=dev` reported no critical advisories, but did report 18 production dependency-tree findings for the frontend package (13 moderate, 5 high) and 12 for the contract test package (7 moderate, 5 high). These are primarily in the pinned Anchor/Solana dependency graph. No automatic audit fix was applied because it would change the reviewed lock graph and requires a separate compatibility and transaction-path review. Advisory counts are registry snapshots and can change after this record date.

## Current production read-only acceptance

- Site: https://gather-group-pay-devnet.netlify.app/
- Production deploy: `6ab9e4e92dcca9930a389028`
- Scope: simulation plus two fixed completed Devnet activities only.
- Paid Event: `SMhtCCQRnXFx2Zq7RVBRLnKDatpDd3oKvvZyome13dz`
- Refunded Event: `4SZ2XvXx4eEyNPQLfFbrQTLtfFVJ4SgoagVrTTWkc87S`

The release-window browser run used isolated 390 px contexts and verified:

- the homepage made no Function request before explicit Devnet selection;
- both fixed Events returned decoded terminal data from the deployed Function;
- refresh returned to simulation without an automatic read;
- an injected display failure did not retry automatically, showed English/Chinese failure UI and succeeded after one explicit retry;
- responses stayed below the client limit and used `no-store` and `nosniff` headers;
- the wallet remained disconnected;
- the browser made no direct Helius or Solana RPC request and contained no provider key.

This is current read-only evidence, not wallet or transaction evidence.

## Historical Devnet transaction evidence

The following public signatures were recorded in an earlier developer-controlled three-wallet acceptance run:

- [Full-group settlement](https://explorer.solana.com/tx/5LcT31dfair5tgvDU12JqQUPHZhTZnZwkyAmkaANk8VD3YEthKTK4h67VamHQXVDCy2utTFPzAnHkZiV1QZqFDdy?cluster=devnet)
- [Organizer cancellation](https://explorer.solana.com/tx/2fpyxoYmCeLRiLJCGLQSb1PBwCFrYS4qXpDf6i6GzGRQRCrsMXum8k8Dw5U1te9K8oz98oHMzC9AW4MjhTa2pyMJ?cluster=devnet)
- [Participant A refund](https://explorer.solana.com/tx/3jz1Ja5a8UyFkTSZcvfLwoCNpubfkquzBPpEU6w883mwu7kZMTzvHJibYaj79fR7CKucqzR7hKxPCANKJV6AcAvL?cluster=devnet)
- [Participant B refund](https://explorer.solana.com/tx/3rMJJyZBqH27NoMQHhjfNhSFs9dDApcnBgqEi34FkpRdgcXyyS4wg8tQiLdadjDEk93GkPhKAjmuC1VGdbeu2yAQ?cluster=devnet)

That run recorded final Event states `PAID` and `REFUNDED`, zero legitimate vault obligations, organizer balance `50 TEST`, participant balances `75 TEST` and total supply `200 TEST`. All wallets were controlled by the developer. The repository package does not claim that these transactions were repeated during packaging or production release.

## Explicitly not verified

- A fresh real-wallet create/join/settle/cancel/refund flow.
- A newly created Event read through the public Function; it intentionally rejects all but the two fixed Events.
- Independent users, customers, revenue or real-world fulfillment.
- Official-RPC/Helius account equality; the earlier official RPC read returned no account data.
- Mainnet behavior, production financial safety or a professional security audit.
