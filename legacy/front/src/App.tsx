'use client';

import { Toaster } from '@/components/ui/toaster';
import { AppShell } from './components/layout/AppShell';
import { DynamicWalletProvider } from './providers/DynamicWalletProvider';
import { QueryProvider } from './providers/QueryProvider';
import { ThemeProvider } from './providers/ThemeProvider';

export default function App() {
  return (
    <QueryProvider>
      <DynamicWalletProvider>
        <ThemeProvider>
          <AppShell />
          <Toaster />
        </ThemeProvider>
      </DynamicWalletProvider>
    </QueryProvider>
  );
}
