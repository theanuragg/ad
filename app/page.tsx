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

const USDC_DECIMALS = 1_000_000; // USDC has 6 decimals

export default function Home() {
  const [fees, setFees] = useState<FeeMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const [claimingPool, setClaimingPool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<DynamicBondingCurveClient | null>(null);
  const [toasts, setToasts] = useState<Array<{id: number, message: string, type: 'success' | 'error'}>>([]);
  
  const wallet = useWallet();
  const { connection } = useConnection();

   const endpoint = "https://mainnet.helius-rpc.com/?api-key=a9af5820-b142-4aaa-9296-ba25637a13f0"
  const conn = new Connection(endpoint, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000,
});
  const clientInstance = new DynamicBondingCurveClient(conn, "confirmed");

  
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);
  
  // Calculate total partner fees in USDC
  const calculatePartnerFeesUSDC = (fee: FeeMetrics): number => {
    const totalPartnerFee = 
      fee.partnerBaseFee.toNumber() + fee.partnerQuoteFee.toNumber();
    return totalPartnerFee / USDC_DECIMALS;
  };

  useEffect(() => {
    async function fetchFees() {
      try {
        setLoading(true);
        setError(null);
        
       const rpcEndpoints = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-api.projectserum.com",
];        
        let lastError: Error | null = null;
        
        for (const endpoint of rpcEndpoints) {
          try {
            console.log(`Trying RPC endpoint: ${endpoint}`);
            const conn = new Connection(endpoint, {
              commitment: "confirmed",
              confirmTransactionInitialTimeout: 60000,
            });
            
               const configAddress = new PublicKey("28eYKBRnoVjVCHaJUeLKYzZyBJR3c5TG1UMGQccpSZgE");
            
            const poolFees = await clientInstance.state.getPoolsFeesByConfig(configAddress);
            setFees(poolFees);
            setClient(clientInstance);
            console.log(`Successfully fetched ${poolFees.length} pool fees from ${endpoint}`);
            
            // Log fees per pool
            poolFees.forEach((fee, index) => {
              const partnerFeeUSDC = calculatePartnerFeesUSDC(fee);
              console.log(`Pool ${index + 1} (${fee.poolAddress.toString().slice(0, 8)}...):`, {
                partnerBaseFee: fee.partnerBaseFee.toNumber() / USDC_DECIMALS,
                partnerQuoteFee: fee.partnerQuoteFee.toNumber() / USDC_DECIMALS,
                totalPartnerFeeUSDC: partnerFeeUSDC
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
  
  // Helper function to retry with exponential backoff
  const retryWithBackoff = async <T,>(
    fn: () => Promise<T>,
    maxRetries = 3,
    baseDelay = 2000
  ): Promise<T> => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err: any) {
        const is403 = err?.message?.includes('403') || err?.message?.includes('forbidden');
        const isRateLimit = err?.message?.includes('429') || err?.message?.includes('rate');
        
        if ((is403 || isRateLimit) && i < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, i);
          console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Max retries exceeded');
  };

  const claimFeesForPool = useCallback(
    async (fee: FeeMetrics) => {
      if (!client || !wallet.publicKey || !wallet.signTransaction) {
        showToast("Please connect your wallet first", "error");
        return false;
      }

      setClaimingPool(fee.poolAddress.toString());

      try {
        // Use retry logic for the claim operation
        await retryWithBackoff(async () => {
          const tx = await client.partner.claimPartnerTradingFee2({
            pool: fee.poolAddress,
            feeClaimer: wallet.publicKey!,
            payer: wallet.publicKey!,
            maxBaseAmount: new BN(1_000_000_000_000),
            maxQuoteAmount: new BN(1_000_000_000_000),
            receiver: wallet.publicKey!,
          });

          // Get latest blockhash for better transaction handling
          const { blockhash } = await connection.getLatestBlockhash('finalized');
          tx.recentBlockhash = blockhash;
          tx.feePayer = wallet.publicKey!;
          
          const txSig = await wallet.sendTransaction(tx, connection);
          await connection.confirmTransaction(txSig, "confirmed");

          console.log(`Transaction sent: ${txSig}`);
        }, 3, 2000);
        
        showToast(
          `Successfully claimed fees for pool ${fee.poolAddress.toString().slice(0, 8)}...`,
          "success"
        );
        
        return true;
      } catch (err: any) {
        console.error("Claim fees error:", err);
        
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        
        // Better error messages
        if (errorMsg.includes('403') || errorMsg.includes('forbidden')) {
          showToast(
            `RPC access denied. Please check your RPC endpoint or try again later.`,
            "error"
          );
        } else if (errorMsg.includes('timeout') || errorMsg.includes('30.00 seconds')) {
          showToast(
            `Transaction timeout. Check explorer: ${fee.poolAddress.toString().slice(0, 8)}...`,
            "error"
          );
        } else if (errorMsg.includes('User rejected')) {
          showToast(
            `Transaction cancelled by user`,
            "error"
          );
        } else {
          showToast(
            `Failed to claim fees: ${errorMsg}`,
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
  
  const formatUSDC = (amount: BN) => {
    return (amount.toNumber() / USDC_DECIMALS).toFixed(6);
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
          
          <ConnectWalletButton />
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
              const feesInUSDC = calculatePartnerFeesUSDC(fee);
              
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
                        disabled={isClaimingThis}
                        className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isClaimingThis ? "Claiming..." : "Claim"}
                      </button>
                    )}
                  </div>
                  
                  <p className="text-sm text-gray-600 dark:text-gray-300 font-mono break-all mb-4">
                    {fee.poolAddress.toString()}
                  </p>
                  
                  {/* Display total fees in USDC */}
                  <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900 rounded-lg">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-semibold text-blue-800 dark:text-blue-200">
                        Total Partner Fees:
                      </span>
                      <span className="text-sm font-bold text-green-600 dark:text-green-400">
                        ${feesInUSDC.toFixed(2)} USDC
                      </span>
                    </div>
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
                            {formatUSDC(fee.partnerBaseFee)} USDC
                          </span>
                        </div>
                        
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Creator:
                          </span>
                          <span className="text-sm font-mono text-gray-900 dark:text-white">
                            {formatUSDC(fee.creatorBaseFee)} USDC
                          </span>
                        </div>
                        
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Total Trading:
                          </span>
                          <span className="text-sm font-mono font-semibold text-green-600 dark:text-green-400">
                            {formatUSDC(fee.totalTradingBaseFee)} USDC
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
                            {formatUSDC(fee.partnerQuoteFee)} USDC
                          </span>
                        </div>
                        
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Creator:
                          </span>
                          <span className="text-sm font-mono text-gray-900 dark:text-white">
                            {formatUSDC(fee.creatorQuoteFee)} USDC
                          </span>
                        </div>
                        
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Total Trading:
                          </span>
                          <span className="text-sm font-mono font-semibold text-blue-600 dark:text-blue-400">
                            {formatUSDC(fee.totalTradingQuoteFee)} USDC
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
