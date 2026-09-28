# Gather — English demo video script (about 85 seconds)

Record the moving create/join flow in **Simulation only**. For the historical proof, switch explicitly to Devnet and open the two completed Event links without connecting a wallet. Keep the mode badge visible. Do not show a seed phrase, keypair file, wallet approval popup or private browser data; no new on-chain transaction is needed for this video.

| Time | Screen | Voiceover |
| --- | --- | --- |
| 0:00–0:10 | Activity cover, time, online method, 25 TEST price and group progress. Badge: `SIMULATION`. | “Group activities often need enough people to commit before an organizer can receive the participation funds. Gather makes that condition visible.” |
| 0:10–0:25 | Create form: 25 TEST per place, minimum two distinct wallets, capacity two, deadline, event time and time zone. | “An organizer defines the price, minimum wallet count, available places and registration deadline. The event time and location are shown separately.” |
| 0:25–0:39 | Simulated A then B join. Show 1/2 then 2/2 and Vault status. | “Participants pay first into a program-controlled Vault. One wallet reserves one place; two wallets do not prove two distinct people.” |
| 0:39–0:52 | Simulated settlement, then read-only Devnet full-group Event and its Explorer settlement link. Badge: `DEVNET · TEST ONLY`. | “When all places fill, settlement can release the legitimate 50 TEST to the original organizer. This completed Devnet activity shows that payout.” |
| 0:52–1:09 | Separate completed Devnet Event: cancellation, two Participation records, A and B refund links, final `All refunds claimed`. | “Here the organizer cancelled while registration was still open. Refunds were not automatic: A and B each signed an individual claim for 25 TEST.” |
| 1:09–1:25 | Final side-by-side statuses `Funds released` / `All refunds claimed`; show Program and Mint identifiers. | “These are worthless Devnet TEST tokens. The two flows were tested with three developer-controlled wallets and independently checked on-chain. Gather does not guarantee that an event happens, and this is not real-user validation.” |

Caption rules: label every simulated scene `Simulation only — no chain transaction`; label each historical account view `Completed Devnet test — read-only`. Say **registration conditions met or missed**, not that the real-world event succeeded or failed. Say **claim refund**, never “automatic refund.” Do not imply the organizer can cancel after the Event is full or after the deadline. End on the read-only examples and README, not on a wallet-signing call to action.
