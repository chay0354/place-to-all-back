# Payments flow (intended design)

## 1. User payment (MoonPay)

- User buys crypto via **MoonPay** (card/bank). The app opens a signed MoonPay widget URL; the user completes payment on MoonPay.
- MoonPay sends crypto **directly to the user’s CDP wallet address** (we pass `walletAddress` when generating the URL).
- No webhook or ledger credit is required for the crypto delivery; MoonPay handles delivery to the address we provide.
- We still use **Coinbase CDP** to create and store the user’s wallet (address) and for **quotes/prices** on the Buy page.

## 2. Optional: internal ledger and “instant test”

- The **instant test (dev)** button uses POST `/api/buy` to credit the user’s internal ledger (treasury → user) without going through MoonPay. Useful for development.
- For production, the primary flow is **MoonPay only**: user pays on MoonPay → crypto is sent to their CDP wallet by MoonPay.
