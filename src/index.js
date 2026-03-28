import express from 'express';
import cors from 'cors';
import { supabase } from './db.js';
import { walletsRouter } from './routes/wallets.js';
import { transferRouter } from './routes/transfer.js';
import { buySellRouter } from './routes/buy-sell.js';
import { moonpayRouter } from './routes/moonpay.js';
import { transactionsRouter } from './routes/transactions.js';
import { coinbaseRouter } from './routes/coinbase.js';
import { authRouter } from './routes/auth.js';
import { profileRouter } from './routes/profile.js';
import { paymentLinksRouter } from './routes/payment-links.js';
import { systemRouter } from './routes/system.js';
import { rapydRouter, rapydWebhookHandler } from './routes/rapyd.js';
import { adminRouter } from './routes/admin.js';

export { supabase };

const app = express();
const port = process.env.PORT || 4000;

app.use(cors({ origin: true, credentials: true }));
// Rapyd webhook needs raw body for signature verification; register before json parser
app.post('/api/rapyd/webhook', express.raw({ type: 'application/json' }), rapydWebhookHandler);
app.use(express.json());

app.use('/api/wallets', walletsRouter);
app.use('/api/transfer', transferRouter);
app.use('/api', buySellRouter);
app.use('/api/moonpay', moonpayRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/coinbase', coinbaseRouter);
app.use('/api/auth', authRouter);
app.use('/api/profile', profileRouter);
app.use('/api/payment-links', paymentLinksRouter);
app.use('/api/system', systemRouter);
app.use('/api/rapyd', rapydRouter);
app.use('/api/admin', adminRouter);

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(port, () => {
  console.log(`Backend running at http://localhost:${port}`);
});
