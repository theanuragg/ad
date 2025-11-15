'use client';

import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export default function ConnectWalletButton({ className = '' }: { className?: string }) {
  return (
    <WalletMultiButton className={className} />
  );
}