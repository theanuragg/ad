
'use client'

import { useEffect, useState, useCallback } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import ConnectWalletButton from "./components/walletbutton";

type FeeMetrics = {
  poolAddress: PublicKey;
  partnerBaseFee: BN;
  partnerQuoteFee: BN;
  creatorBaseFee: BN;
  creatorQuoteFee: BN;
  totalTradingBaseFee: BN;
  totalTradingQuoteFee: BN;
};

const LAMPORTS_PER_SOL = 1_000_000_000;
const MIN_CLAIM_USD = 1; // Minimum $1 to claim
const SOL_PRICE_USD = 150; // Update with real-time price or fetch from an API

export default function Home() {
  const [fees, setFees] = useState<FeeMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const [claimingPool, setClaimingPool] = useState<string | null>(null);
  const [claimingAll, setClaimingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<DynamicBondingCurveClient | null>(null);
  const [toasts, setToasts] = useState<Array<{id: number, message: string, type: 'success' | 'error'}>>([]);
  
  const wallet = useWallet();
  const { connection } = useConnection();
  
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);
  
  // Calculate total partner fees in USD
  const calculatePartnerFeesUSD = (fee: FeeMetrics): number => {
    const totalPartnerFeeLamports = 
      fee.partnerBaseFee.toNumber() + fee.partnerQuoteFee.toNumber();
    const totalPartnerFeeSOL = totalPartnerFeeLamports / LAMPORTS_PER_SOL;
    return totalPartnerFeeSOL * SOL_PRICE_USD;
  };
  
  // Check if fees are above $1 threshold
  const canClaimFees = (fee: FeeMetrics): boolean => {
    const feesInUSD = calculatePartnerFeesUSD(fee);
    return feesInUSD >= MIN_CLAIM_USD;
  };

  useEffect(() => {
    async function fetchFees() {
      try {
        setLoading(true);
        setError(null);
        
        const rpcEndpoints = [
          "https://solana-mainnet.g.alchemy.com/v2/demo",
          "https://api.mainnet-beta.solana.com",
          "https://rpc.ankr.com/solana",
          "https://solana-api.projectserum.com"
        ];
        
        let lastError: Error | null = null;
        
        for (const endpoint of rpcEndpoints) {
          try {
            console.log(`Trying RPC endpoint: ${endpoint}`);
            const conn = new Connection(endpoint);
            const clientInstance = new DynamicBondingCurveClient(conn, "confirmed");
            const configAddress = new PublicKey("28eYKBRnoVjVCHaJUeLKYzZyBJR3c5TG1UMGQccpSZgE");
            
            const poolFees = await clientInstance.state.getPoolsFeesByConfig(configAddress);
            setFees(poolFees);
            setClient(clientInstance);
            console.log(`Successfully fetched ${poolFees.length} pool fees from ${endpoint}`);
            
            // Log fees per pool
            poolFees.forEach((fee, index) => {
              const partnerFeeSOL = (fee.partnerBaseFee.toNumber() + fee.partnerQuoteFee.toNumber()) / LAMPORTS_PER_SOL;
              const partnerFeeUSD = partnerFeeSOL * SOL_PRICE_USD;
              console.log(`Pool ${index + 1} (${fee.poolAddress.toString().slice(0, 8)}...):`, {
                partnerBaseFee: fee.partnerBaseFee.toNumber() / LAMPORTS_PER_SOL,
                partnerQuoteFee: fee.partnerQuoteFee.toNumber() / LAMPORTS_PER_SOL,
                totalPartnerFeeSOL: partnerFeeSOL,
                totalPartnerFeeUSD: partnerFeeUSD,
                canClaim: partnerFeeUSD >= MIN_CLAIM_USD
              });
            });
            
            return;
          } catch (endpointError) {
            console.warn(`Failed with endpoint ${endpoint}:`, endpointError);
            lastError = endpointError instanceof Error ? endpointError : new Error(String(endpointError));
            continue;
          }
        }
        
        throw lastError || new Error("All RPC endpoints failed");
        
      } catch (err) {
        console.error("Failed to fetch pool fees from all endpoints:", err);
        const errorMessage = err instanceof Error ? err.message : "Failed to fetch pool fees";
        
        if (errorMessage.includes("403") || errorMessage.includes("Access forbidden")) {
          setError("RPC access denied. Please try again later or use a different RPC endpoint.");
        } else if (errorMessage.includes("429") || errorMessage.includes("rate limit")) {
          setError("Rate limit exceeded. Please wait a moment and try again.");
        } else if (errorMessage.includes("network") || errorMessage.includes("timeout")) {
          setError("Network error. Please check your connection and try again.");
        } else {
          setError(`Error: ${errorMessage}`);
        }
      } finally {
        setLoading(false);
      }
    }
    
    fetchFees();
  }, []);
  
  const claimFeesForPool = useCallback(
    async (fee: FeeMetrics) => {
      if (!client || !wallet.publicKey || !wallet.signTransaction) {
        showToast("Please connect your wallet first", "error");
        return false;
      }

      // Check if fees are above $1 threshold
      if (!canClaimFees(fee)) {
        const feesInUSD = calculatePartnerFeesUSD(fee);
        showToast(
          `Cannot claim fees below $${MIN_CLAIM_USD}. Current fees: $${feesInUSD.toFixed(2)}`,
          "error"
        );
        return false;
      }

      try {
        setClaimingPool(fee.poolAddress.toString());

        const tx = await client.partner.claimPartnerTradingFee2({
          pool: fee.poolAddress,
          feeClaimer: wallet.publicKey,
          payer: wallet.publicKey,
          maxBaseAmount: new BN(1_000_000_000_000),
          maxQuoteAmount: new BN(1_000_000_000_000),
          receiver: wallet.publicKey,
        });

        // Get latest blockhash for better transaction handling
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        
        const txSig = await wallet.sendTransaction(tx, connection, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });

        console.log(`Transaction sent: ${txSig}`);

        // Wait for confirmation with timeout handling
        const confirmation = await Promise.race([
          connection.confirmTransaction({
            signature: txSig,
            blockhash,
            lastValidBlockHeight,
          }, 'confirmed'),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Confirmation timeout')), 60000)
          )
        ]);

        // Verify transaction actually succeeded
        const status = await connection.getSignatureStatus(txSig);
        if (status?.value?.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
        }

        showToast(
          `Fees claimed for pool ${fee.poolAddress.toString().slice(0, 8)}...! Tx: ${txSig.slice(0, 8)}...`,
          "success"
        );
        return true;
      } catch (err) {
        console.error("Claim fees error:", err);
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        
        // If it's a timeout, provide a more helpful message
        if (errorMsg.includes('timeout') || errorMsg.includes('30.00 seconds')) {
          showToast(
            `Transaction may still be processing. Check explorer: ${fee.poolAddress.toString().slice(0, 8)}...`,
            "error"
          );
        } else {
          showToast(
            `Failed to claim fees for pool ${fee.poolAddress.toString().slice(0, 8)}...: ${errorMsg}`,
            "error"
          );
        }
        return false;
      } finally {
        setClaimingPool(null);
      }
    },
    [client, wallet, connection, showToast]
  );  
  const claimFeesAllPools = useCallback(async () => {
    if (!client || !wallet.publicKey) {
      showToast("Please connect your wallet first", "error");
      return;
    }
    
    setClaimingAll(true);
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;
    
    for (const fee of fees) {
      // Only claim if fees are above $1 threshold
      if (canClaimFees(fee)) {
        const success = await claimFeesForPool(fee);
        if (success) {
          successCount++;
        } else {
          failCount++;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        skippedCount++;
        console.log(`Skipped pool ${fee.poolAddress.toString().slice(0, 8)}... - fees below $${MIN_CLAIM_USD}`);
      }
    }
    
    setClaimingAll(false);
    showToast(
      `Batch claim complete: ${successCount} successful, ${failCount} failed, ${skippedCount} skipped (below $${MIN_CLAIM_USD})`,
      successCount > 0 ? "success" : "error"
    );
  }, [fees, client, wallet, claimFeesForPool, showToast]);
  
  const formatLamports = (lamports: BN) => {
    return (lamports.toNumber() / LAMPORTS_PER_SOL).toFixed(9);
  };
  
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`px-4 py-3 rounded-lg shadow-lg max-w-md ${
              toast.type === 'success'
                ? 'bg-green-500 text-white'
                : 'bg-red-500 text-white'
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
      
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Partner Pool Fees Dashboard
          </h1>
          
          <div className="flex gap-3">
            <ConnectWalletButton />
            <button
              onClick={claimFeesAllPools}
              disabled={claimingAll || fees.length === 0 || !wallet.connected}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {claimingAll ? "Claiming All..." : "Claim All Fees"}
            </button>
          </div>
        </div>
        
        {/* Wallet Status Indicator */}
        {wallet.connected && wallet.publicKey && (
          <div className="mb-4 p-3 bg-green-100 dark:bg-green-900 rounded-lg">
            <p className="text-sm text-green-800 dark:text-green-200">
              Connected: {wallet.publicKey.toString().slice(0, 4)}...{wallet.publicKey.toString().slice(-4)}
            </p>
          </div>
        )}
        
        {loading ? (
          <div className="text-center py-12">
            <div className="text-gray-500 dark:text-gray-400 text-lg">
              Loading pool fees...
            </div>
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <div className="text-red-500 dark:text-red-400 text-lg mb-4">
              {error}
            </div>
            <div className="text-gray-600 dark:text-gray-400 text-sm mb-6 max-w-md mx-auto">
              If the error persists, the RPC endpoints may be experiencing issues.
              Try refreshing the page or check back later.
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Retry
            </button>
          </div>
        ) : fees.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-500 dark:text-gray-400 text-lg">
              No pool fees found
            </div>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {fees.map((fee) => {
              const isClaimingThis = claimingPool === fee.poolAddress.toString();
              const hasClaimableFees = canClaimFees(fee);
              const feesInUSD = calculatePartnerFeesUSD(fee);
              
              return (
                <div
                  key={fee.poolAddress.toString()}
                  className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 border border-gray-200 dark:border-gray-700"
                >
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                      Pool Address
                    </h3>
                    {wallet.connected && (
                      <button
                        onClick={() => claimFeesForPool(fee)}
                        disabled={isClaimingThis || claimingAll || !hasClaimableFees}
                        className={`px-3 py-1 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                          hasClaimableFees 
                            ? 'bg-green-600 hover:bg-green-700' 
                            : 'bg-gray-400'
                        }`}
                        title={!hasClaimableFees ? `Fees below $${MIN_CLAIM_USD} threshold` : ''}
                      >
                        {isClaimingThis ? "Claiming..." : hasClaimableFees ? "Claim" : "< $1"}
                      </button>
                    )}
                  </div>
                  
                  <p className="text-sm text-gray-600 dark:text-gray-300 font-mono break-all mb-4">
                    {fee.poolAddress.toString()}
                  </p>
                  
                  {/* Display total fees in USD */}
                  <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900 rounded-lg">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-semibold text-blue-800 dark:text-blue-200">
                        Total Partner Fees:
                      </span>
                      <span className={`text-sm font-bold ${
                        hasClaimableFees 
                          ? 'text-green-600 dark:text-green-400' 
                          : 'text-red-600 dark:text-red-400'
                      }`}>
                        ${feesInUSD.toFixed(2)} USD
                      </span>
                    </div>
                    {!hasClaimableFees && (
                      <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                        Below ${MIN_CLAIM_USD} minimum
                      </p>
                    )}
                  </div>
                  
                  <div className="space-y-3">
                    <div className="border-b border-gray-200 dark:border-gray-600 pb-3 mb-3">
                      <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">Base Fees</h4>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Partner:
                          </span>
                          <span className="text-sm font-mono text-gray-900 dark:text-white">
                            {formatLamports(fee.partnerBaseFee)} SOL
                          </span>
                        </div>
                        
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Creator:
                          </span>
                          <span className="text-sm font-mono text-gray-900 dark:text-white">
                            {formatLamports(fee.creatorBaseFee)} SOL
                          </span>
                        </div>
                        
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Total Trading:
                          </span>
                          <span className="text-sm font-mono font-semibold text-green-600 dark:text-green-400">
                            {formatLamports(fee.totalTradingBaseFee)} SOL
                          </span>
                        </div>
                      </div>
                    </div>
                    
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">Quote Fees</h4>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Partner:
                          </span>
                          <span className="text-sm font-mono text-gray-900 dark:text-white">
                            {formatLamports(fee.partnerQuoteFee)} SOL
                          </span>
                        </div>
                        
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Creator:
                          </span>
                          <span className="text-sm font-mono text-gray-900 dark:text-white">
                            {formatLamports(fee.creatorQuoteFee)} SOL
                          </span>
                        </div>
                        
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Total Trading:
                          </span>
                          <span className="text-sm font-mono font-semibold text-blue-600 dark:text-blue-400">
                            {formatLamports(fee.totalTradingQuoteFee)} SOL
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
                    }

