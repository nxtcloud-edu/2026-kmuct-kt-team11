'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api/client';
import { Button } from '@/components/surface';

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await apiFetch('/auth/session', { method: 'DELETE' });
    } catch {
      // The cookie may already be gone or the session already revoked. Either
      // way the user asked to leave, so send them out rather than showing an
      // error they cannot act on.
    }
    // `refresh()` clears the cached RSC payload — without it the shell would
    // still be holding the signed-in render.
    router.replace('/sign-in');
    router.refresh();
  }

  // `quiet` — no fill. Signing out is reachable but is not the primary path
  // through this screen, and there is no accent colour in this system to
  // de-emphasise it with, so the fill is the whole hierarchy.
  return (
    <Button variant="quiet" className="w-full" onClick={signOut} disabled={busy}>
      {busy ? '로그아웃 중…' : '로그아웃'}
    </Button>
  );
}
