/**
 * Check Sepolia balance and transaction history for an address.
 * Run from back/: node scripts/check-sepolia-balance.js [address]
 * Requires ETHERSCAN_API_KEY in .env (get free key at https://etherscan.io/apidashboard).
 * Default address: 0xA557F9afae65237Aac8A5B3AF1644DaE0FA9e6D1
 */

import 'dotenv/config';

const address = process.argv[2] || '0xA557F9afae65237Aac8A5B3AF1644DaE0FA9e6D1';
const SEPOLIA_CHAIN_ID = 11155111;
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

function getApiKey() {
  return process.env.ETHERSCAN_API_KEY || process.env.ETHERSCAN_SEPOLIA_API_KEY || '';
}

async function main() {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log('Missing ETHERSCAN_API_KEY. Add it to back/.env (get free key at https://etherscan.io/apidashboard)');
    console.log('Then run: node scripts/check-sepolia-balance.js', address);
    process.exit(1);
  }

  console.log('Sepolia (Ethereum testnet) — Balance & history (Etherscan V2 API)');
  console.log('Address:', address);
  console.log('');

  // 1. Balance
  const balanceParams = new URLSearchParams({
    chainid: String(SEPOLIA_CHAIN_ID),
    module: 'account',
    action: 'balance',
    address,
    tag: 'latest',
    apikey: apiKey,
  });
  const balanceUrl = `${ETHERSCAN_V2}?${balanceParams.toString().replace(apiKey, '***')}`;
  console.log('Balance request:', balanceUrl);
  const balanceRes = await fetch(`${ETHERSCAN_V2}?${balanceParams.toString()}`);
  const balanceData = await balanceRes.json().catch(() => ({}));
  console.log('Balance response:', JSON.stringify({ ...balanceData, result: balanceData.result != null ? String(balanceData.result).slice(0, 30) + (String(balanceData.result).length > 30 ? '...' : '') : balanceData.result }, null, 2));
  if (balanceData.status === '1' && balanceData.result != null) {
    const wei = BigInt(balanceData.result);
    const eth = Number(wei) / 1e18;
    console.log('→ ETH balance:', eth);
  } else {
    console.log('→ Error or no balance:', balanceData.message || balanceData.result);
  }
  console.log('');

  // 2. Transaction list
  const txParams = new URLSearchParams({
    chainid: String(SEPOLIA_CHAIN_ID),
    module: 'account',
    action: 'txlist',
    address,
    startblock: '0',
    endblock: '99999999',
    sort: 'desc',
    page: '1',
    offset: '20',
    apikey: apiKey,
  });
  const txUrl = `${ETHERSCAN_V2}?${txParams.toString().replace(apiKey, '***')}`;
  console.log('Tx list request:', txUrl);
  const txRes = await fetch(`${ETHERSCAN_V2}?${txParams.toString()}`);
  const txData = await txRes.json().catch(() => ({}));
  console.log('Tx list response status:', txData.status, 'message:', txData.message);
  if (txData.result && Array.isArray(txData.result)) {
    console.log('→ Transactions count:', txData.result.length);
    txData.result.slice(0, 10).forEach((tx, i) => {
      const valueWei = BigInt(tx.value || 0);
      const eth = Number(valueWei) / 1e18;
      const date = new Date(parseInt(tx.timeStamp, 10) * 1000).toISOString();
      const dir = (tx.to || '').toLowerCase() === address.toLowerCase() ? 'IN ' : 'OUT';
      console.log(`  ${i + 1}. ${date} ${dir} ${eth} ETH  hash=${tx.hash?.slice(0, 18)}...`);
    });
    if (txData.result.length > 10) {
      console.log('  ... and', txData.result.length - 10, 'more');
    }
  } else {
    console.log('→ Raw result:', typeof txData.result, Array.isArray(txData.result) ? 'array' : txData.result);
    if (txData.result && typeof txData.result === 'string') {
      console.log('   (message):', txData.result);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
