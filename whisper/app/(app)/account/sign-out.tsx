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

  return (
    <Button onClick={signOut} disabled={busy}>
      {busy ? '로그아웃 중…' : '로그아웃'}
    </Button>
  );
}
