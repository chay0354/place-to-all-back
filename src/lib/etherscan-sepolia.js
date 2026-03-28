/**
 * Etherscan Sepolia API (V2): balance and transaction list for testing.
 * Used when MOONPAY_SANDBOX=true so dashboard and profile show Sepolia data (where MoonPay sandbox sends funds).
 * Requires ETHERSCAN_API_KEY (V1 is deprecated; use https://etherscan.io/apidashboard).
 * Docs: https://docs.etherscan.io/v2-migration | Sepolia chainid: 11155111
 */

const SEPOLIA_CHAIN_ID = 11155111;
const ETHERSCAN_V2_API = 'https://api.etherscan.io/v2/api';

function getApiKey() {
  return process.env.ETHERSCAN_API_KEY || process.env.ETHERSCAN_SEPOLIA_API_KEY || '';
}

/**
 * Fetch ETH balance for an address on Sepolia.
 * @param {string} address - 0x... EVM address
 * @returns {Promise<number>} ETH balance
 */
export async function getSepoliaBalance(address) {
  if (!address || !String(address).startsWith('0x')) return 0;
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('[Etherscan Sepolia] ETHERSCAN_API_KEY is required (V1 deprecated). Get one at https://etherscan.io/apidashboard');
    return 0;
  }
  const params = new URLSearchParams({
    chainid: String(SEPOLIA_CHAIN_ID),
    module: 'account',
    action: 'balance',
    address: address,
    tag: 'latest',
    apikey: apiKey,
  });
  try {
    const res = await fetch(`${ETHERSCAN_V2_API}?${params.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (data.status !== '1' || data.message !== 'OK') return 0;
    const wei = BigInt(data.result ?? 0);
    return Number(wei) / 1e18;
  } catch (e) {
    console.error('[Etherscan Sepolia] getSepoliaBalance:', e?.message || e);
    return 0;
  }
}

/**
 * Fetch normal transaction list for an address on Sepolia. Returns shape compatible with app transaction list.
 * @param {string} address - 0x... EVM address
 * @param {number} [limit=50]
 * @returns {Promise<Array<{ id: string, type: string, amount: number, currency: string, created_at: string, direction: string, description: string }>>}
 */
export async function getSepoliaTransactions(address, limit = 50) {
  if (!address || !String(address).startsWith('0x')) return [];
  const apiKey = getApiKey();
  if (!apiKey) return [];
  const params = new URLSearchParams({
    chainid: String(SEPOLIA_CHAIN_ID),
    module: 'account',
    action: 'txlist',
    address: address,
    startblock: '0',
    endblock: '99999999',
    sort: 'desc',
    page: '1',
    offset: String(Math.min(limit, 100)),
    apikey: apiKey,
  });
  try {
    const res = await fetch(`${ETHERSCAN_V2_API}?${params.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (data.status !== '1' || !Array.isArray(data.result)) return [];
    const addr = address.toLowerCase();
    return data.result.map((tx) => {
      const valueWei = BigInt(tx.value ?? 0);
      const amount = Number(valueWei) / 1e18;
      const isIn = (tx.to || '').toLowerCase() === addr;
      return {
        id: `sepolia-${tx.hash}`,
        type: 'onchain',
        amount,
        currency: 'ETH',
        created_at: new Date(parseInt(tx.timeStamp, 10) * 1000).toISOString(),
        direction: isIn ? 'in' : 'out',
        description: isIn ? 'Receive (Sepolia)' : 'Send (Sepolia)',
        metadata: { hash: tx.hash, blockNumber: tx.blockNumber },
      };
    });
  } catch (e) {
    console.error('[Etherscan Sepolia] getSepoliaTransactions:', e?.message || e);
    return [];
  }
}
