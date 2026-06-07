'use client';

import { useEffect, useState } from 'react';

function clearStorage(storage: Storage) {
  const keysToRemove: string[] = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;

    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes('dynamic') || normalizedKey.startsWith('dyn_')) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach((key) => storage.removeItem(key));
}

function clearAccessibleCookies() {
  document.cookie.split(';').forEach((cookie) => {
    const [rawName] = cookie.trim().split('=');
    if (!rawName) return;

    const normalizedName = rawName.toLowerCase();
    if (!normalizedName.includes('dynamic') && !normalizedName.includes('dyn') && normalizedName !== 'compass_app_session') {
      return;
    }

    document.cookie = `${rawName}=; Max-Age=0; Path=/; SameSite=Lax`;
  });
}

export default function DynamicResetPage() {
  const [message, setMessage] = useState('Limpiando sesión local de Dynamic...');

  useEffect(() => {
    async function resetDynamicSession() {
      try {
        await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
        clearStorage(window.localStorage);
        clearStorage(window.sessionStorage);
        clearAccessibleCookies();
        setMessage('Sesión local de Dynamic limpiada. Redirigiendo...');
      } finally {
        window.setTimeout(() => {
          window.location.replace('/home');
        }, 500);
      }
    }

    void resetDynamicSession();
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-6 text-center text-on-surface">
      <div className="max-w-md rounded-3xl border border-outline bg-surface-container p-8 shadow-xl">
        <h1 className="text-xl font-semibold">Reset Dynamic</h1>
        <p className="mt-3 text-sm text-on-surface-variant">{message}</p>
      </div>
    </main>
  );
}
