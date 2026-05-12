'use client';

import { Toaster } from '@/components/ui/toaster';
import { AppShell } from './components/layout/AppShell';
import { QueryProvider } from './providers/QueryProvider';
import { ThemeProvider } from './providers/ThemeProvider';

export default function App() {
  return (
    <QueryProvider>
      <ThemeProvider>
        <AppShell />
        <Toaster />
      </ThemeProvider>
    </QueryProvider>
  );
}
