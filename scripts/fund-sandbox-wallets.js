/**
 * Request sandbox faucet (test ETH and USDC on Base Sepolia) for all CDP wallets in the DB.
 * So wallets show "Balances" in the Coinbase dashboard when viewed in sandbox.
 *
 * Run: npm run fund:sandbox   (or node scripts/fund-sandbox-wallets.js)
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CDP/COINBASE API keys in .env
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { requestSandboxFaucet } from '../src/lib/coinbase.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function log(msg, data = null) {
  console.log(msg);
  if (data != null) console.log(JSON.stringify(data, null, 2));
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }

  const { data: rows, error } = await supabase
    .from('coinbase_wallets')
    .select('user_id, wallet_id');
  if (error) throw new Error(`Supabase: ${error.message}`);
  if (!rows?.length) {
    log('No coinbase_wallets found.');
    return;
  }

  log(`Found ${rows.length} wallet(s). Requesting sandbox faucet (Base Sepolia) for each...\n`);

  for (const { user_id, wallet_id } of rows) {
    const address = wallet_id;
    if (!address || !address.startsWith('0x')) {
      log(`Skip ${user_id}: invalid wallet_id`);
      continue;
    }
    try {
      log(`Funding ${address} (user ${user_id.slice(0, 8)}...)`);
      const eth = await requestSandboxFaucet(address, 'eth');
      log(`  ETH: ${eth.transactionHash}`);
      const usdc = await requestSandboxFaucet(address, 'usdc');
      log(`  USDC: ${usdc.transactionHash}`);
    } catch (e) {
      log(`  Error: ${e.message}`);
    }
  }

  log('\nDone. Wallets should show test ETH and USDC on Base Sepolia in sandbox.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
