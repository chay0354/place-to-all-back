# Going live: real wallets, real payments, real crypto

This doc outlines how to switch from sandbox/test to **live**: production CDP wallets, real card payments (MoonPay), and crypto sent to the user’s CDP wallet by MoonPay.

---

## 1. Live wallets (CDP production, mainnet)

**Goal:** New users get a real CDP wallet on a mainnet (e.g. Base), not testnet.

**What to change:**

| Env / config | Sandbox (current) | Live |
|--------------|-------------------|-----|
| `COINBASE_WALLET_BASE` | `https://api.cdp.coinbase.com/platform` (already prod for wallets) | Keep `https://api.cdp.coinbase.com/platform` |
| `COINBASE_WALLET_NETWORK` | `base-sepolia` (if set) | **`base-mainnet`** (or desired mainnet) |
| `COINBASE_SANDBOX` | `true` | **`false`** (so quotes/prices use production where applicable) |
| CDP keys | Sandbox/project keys | **Production CDP API keys** from [CDP Portal](https://portal.cdp.coinbase.com) (same Wallet Secret can be used for Server Wallet v2) |

**Code:** Wallet creation already uses `COINBASE_WALLET_BASE` and `COINBASE_WALLET_NETWORK`. Ensure migrations and RLS are applied on your live Supabase project.

---

## 2. Live user payment (MoonPay production)

**Goal:** Real card/bank payments; MoonPay sends crypto to the user’s CDP wallet.

**What to change:**

| Env / config | Sandbox | Live |
|--------------|---------|------|
| `MOONPAY_PUBLISHABLE_KEY` / `MOONPAY_SECRET_KEY` | Sandbox keys from MoonPay Dashboard | **Production keys** from MoonPay |
| `MOONPAY_SANDBOX` | `true` (optional) | **`false`** or unset for production |
| `FRONTEND_URL` | `http://localhost:3000` | **`https://app.yourdomain.com`** (used for redirect after purchase: `.../dashboard?moonpay=success`) |

**MoonPay:** In the MoonPay dashboard, configure your redirect URL and ensure your account is approved for live payments (KYC/compliance as required). The backend signs widget URLs with `MOONPAY_SECRET_KEY` when `walletAddress` is present.

---

## 3. Real coin (MoonPay → user wallet)

**Goal:** MoonPay sends crypto directly to the user’s CDP wallet address (we pass it in the signed widget URL). No separate “bank → Coinbase” leg for the buy flow.

Two common patterns:

### Option A: Operational (manual or batched)

1. **Fund Coinbase from your bank**  
   Use [Coinbase Prime](https://prime.coinbase.com/) or [Coinbase Exchange](https://www.coinbase.com/exchange) to wire/ACH fiat and buy crypto (e.g. BTC, ETH, USDC) into a custody/treasury account you control.

2. **Create a “treasury” CDP wallet**  
   In your app, create one (or more) CDP Server Wallet accounts used only as treasury (e.g. account name `treasury-btc`, `treasury-eth`). Fund these by transferring from your Coinbase Prime/Exchange balance to the treasury wallet address (via Coinbase UI or API).

3. **When a user has paid (e.g. via MoonPay or another source you’ve credited in your ledger):**  
   Run a process (cron or manual) that:
   - Reads ledger/transactions for “buy” events not yet settled on-chain,
   - For each: call **CDP transfer** from your treasury account to the user’s CDP wallet address (from `coinbase_wallets.wallet_id`), for the correct asset and amount.
   - Mark the transaction as “settled” so you don’t double-send.

**Implementation:** Add a function in `coinbase.js` that uses the CDP SDK to transfer from a treasury account to a destination address (you already have `requestSandboxFaucet`; the same SDK has `account.transfer({ to, amount, token, network })`). Use a treasury account created with `cdp.evm.createAccount({ name: 'treasury' })` and fund it from Coinbase. Then add a route or script that, for a given user and amount, performs this transfer and records it.

### Option B: Coinbase Onramp / Commerce

Use [Coinbase Commerce](https://www.coinbase.com/commerce) or [Onramp APIs](https://docs.cdp.coinbase.com/onramp-&-offramp/onramp-apis/onramp-overview) so that when the user pays (e.g. card or bank), Coinbase handles the fiat and credits the user’s wallet directly. That replaces “Rapyd + your own bank → Coinbase” with “user pays via Coinbase” and simplifies compliance, but changes the product flow (e.g. redirect to Coinbase-hosted flow).

---

## 4. Checklist before going live

- [ ] **Env:** Production Supabase, Rapyd, and CDP keys; `COINBASE_SANDBOX=false`, `COINBASE_WALLET_NETWORK=base-mainnet` (or chosen mainnet).
- [ ] **MoonPay:** Production keys; redirect URL in MoonPay dashboard points to your live frontend (e.g. `https://app.yourdomain.com/dashboard?moonpay=success`).
- [ ] **Wallets:** New signups create mainnet CDP wallets; no testnet in production.
- [ ] **Ledger:** If you use internal ledger (e.g. for instant test or other flows), ensure idempotency and error handling for production traffic.
- [ ] **Leg 2 (real coin):** Either Option A (treasury + CDP transfer) or Option B (Coinbase Onramp/Commerce) is implemented and tested with small amounts.
- [ ] **Compliance:** KYC/AML and any required licenses for your jurisdiction (card acquisition, crypto distribution, etc.).
- [ ] **Monitoring:** Logs and alerts for failed webhooks, failed transfers, and balance reconciliation (ledger vs on-chain).

---

## 5. Summary

| Area | Action |
|------|--------|
| **Live wallets** | Production CDP keys, `COINBASE_WALLET_NETWORK=base-mainnet`, `COINBASE_SANDBOX=false`. |
| **Live payment** | MoonPay production keys; `FRONTEND_URL` set for redirect after purchase. |
| **Real coin** | MoonPay sends crypto to the user’s CDP wallet address. Optionally: fund a CDP treasury and use CDP transfer for other flows (Option A in §3); or use Coinbase Onramp/Commerce (Option B). |

Primary flow: **user pays with card/bank (MoonPay) → MoonPay sends crypto to their CDP wallet.** No ledger credit or webhook required for the buy flow.
