'use client';

import type { ReactNode } from 'react';
import { AddressType, PhantomProvider as SDKPhantomProvider } from '@phantom/react-sdk';

const appId = process.env.NEXT_PUBLIC_PHANTOM_APP_ID;

export function PhantomProvider({ children }: { children: ReactNode }) {
  return (
    <SDKPhantomProvider
      config={
        appId
          ? {
              providers: ['google'],
              addressTypes: [AddressType.solana],
              appId,
              embeddedWalletType: 'user-wallet',
            }
          : {
              providers: ['phantom'],
              addressTypes: [AddressType.solana],
            }
      }
      appName="Wallet Copilot"
      appIcon="/icon.png"
    >
      {children}
    </SDKPhantomProvider>
  );
}
