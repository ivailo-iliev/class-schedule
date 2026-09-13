import { useEffect, useState } from 'react';

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANIFEST_ID = 'private-install-manifest';

export function manifestHref(profileId: string): string | null {
  if (!PROFILE_ID.test(profileId)) return null;
  return `/manifest.webmanifest?profile=${encodeURIComponent(profileId)}`;
}

export function ensurePrivateManifest(profileId: string): void {
  if (typeof document === 'undefined') return;
  const href = manifestHref(profileId);
  if (!href) return;

  let link = document.getElementById(MANIFEST_ID);
  if (!(link instanceof HTMLLinkElement)) {
    link = document.createElement('link');
    link.id = MANIFEST_ID;
    link.setAttribute('rel', 'manifest');
    document.head.appendChild(link);
  }
  link.setAttribute('href', href);
}

export function removePrivateManifest(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(MANIFEST_ID)?.remove();
}

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) return;
  void navigator.serviceWorker.register('/sw.js').catch(() => {
    // Offline support is an enhancement; the network-backed app remains usable.
  });
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}
