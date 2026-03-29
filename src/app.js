import express from 'express';
import cors from 'cors';
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

const app = express();

const corsOptions = {
  origin(origin, callback) {
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-User-Id',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
  ],
  exposedHeaders: [],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

app.use((req, res, next) => {
  let u = req.url || '';
  if (u.startsWith('/') && u.includes('//')) {
    const q = u.indexOf('?');
    const pathPart = q >= 0 ? u.slice(0, q) : u;
    const normalized = pathPart.replace(/\/+/g, '/');
    req.url = q >= 0 ? normalized + u.slice(q) : normalized;
  }
  next();
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
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

app.get('/', (_, res) => res.json({ ok: true, name: 'place-to-all-back' }));
app.get('/health', (_, res) => res.json({ ok: true }));

export default app;
