/**
 * Send native ETH from platform wallet to user and fee address.
 * Used when MoonPay sends to platform wallet: we split 92% to user, 8% to fee address on-chain.
 */

import { ethers } from 'ethers';

function getProvider() {
  const useBaseSepolia = process.env.ONLY_BASE_SEPOLIA === 'true' || process.env.ONLY_BASE_SEPOLIA === '1';
  if (useBaseSepolia) {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
    return new ethers.JsonRpcProvider(rpcUrl);
  }
  const isSandbox = process.env.MOONPAY_SANDBOX === 'true' || process.env.MOONPAY_SANDBOX === '1';
  const rpcUrl = isSandbox
    ? (process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org')
    : (process.env.BASE_RPC_URL || process.env.ETHEREUM_RPC_URL || 'https://mainnet.base.org');
  return new ethers.JsonRpcProvider(rpcUrl);
}

/**
 * Send ETH from platform wallet to a single address.
 * @param {string} toAddress - 0x... recipient
 * @param {string|number} amountEth - amount in ETH (e.g. 0.1 or '0.1')
 * @returns {Promise<{ hash: string, success: boolean }>}
 */
export async function sendEth(toAddress, amountEth) {
  const privateKey = process.env.PLATFORM_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    console.warn('[send-eth] PLATFORM_WALLET_PRIVATE_KEY not set; cannot send on-chain. Add it to .env and fund the wallet on Base Sepolia for instant-test.');
    return { hash: null, success: false };
  }
  if (!toAddress || !String(toAddress).startsWith('0x')) {
    return { hash: null, success: false };
  }
  const amountWei = ethers.parseEther(String(amountEth));
  if (amountWei === 0n) return { hash: null, success: true };

  const provider = getProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  try {
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: amountWei,
      gasLimit: 21000n,
    });
    const receipt = await tx.wait();
    return { hash: receipt?.hash, success: !!receipt };
  } catch (e) {
    console.error('[send-eth]', e?.message || e);
    return { hash: null, success: false };
  }
}

/**
 * Split received amount: send 92% to user, 8% to fee address. Returns true if both sent (or fee is 0).
 * @param {string} userAddress - 0x... user wallet
 * @param {string} feeAddress - 0x... system fee wallet
 * @param {number} totalAmountEth - total ETH received (e.g. from MoonPay)
 * @returns {Promise<{ userTxHash?: string, feeTxHash?: string, ok: boolean }>}
 */
export async function splitAndSendEth(userAddress, feeAddress, totalAmountEth) {
  const rate = Number(process.env.SYSTEM_FEE_PERCENT) || 8;
  const feePercent = rate > 1 ? rate / 100 : rate;
  const netPercent = 1 - feePercent;
  const netAmount = totalAmountEth * netPercent;
  const feeAmount = totalAmountEth * feePercent;

  const results = { ok: false };
  if (netAmount > 0 && userAddress) {
    const userResult = await sendEth(userAddress, netAmount);
    results.userTxHash = userResult.hash || undefined;
    if (!userResult.success) {
      console.error('[send-eth] Failed to send user share to', userAddress);
      return results;
    }
  }
  if (feeAmount > 0 && feeAddress) {
    const feeResult = await sendEth(feeAddress, feeAmount);
    results.feeTxHash = feeResult.hash || undefined;
    if (!feeResult.success) {
      console.error('[send-eth] Failed to send fee to', feeAddress);
      return results;
    }
  }
  results.ok = true;
  return results;
}
