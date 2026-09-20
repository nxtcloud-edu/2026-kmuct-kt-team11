'use client';

import { useEffect } from 'react';
import { Button, Content } from '@/components/surface';
import { ErrorState } from '@/components/states';

/**
 * Root error boundary. Catches anything thrown during render below `/`.
 * `digest` is the server-side correlation id Next generates for a production
 * error — it is the only handle support has, so it is shown, not swallowed.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[boundary:root]', error);
  }, [error]);

  return (
    <Content>
      <ErrorState
        detail="예상하지 못한 문제가 생겼어요. 잠시 후 다시 시도해 주세요."
        requestId={error.digest ?? null}
        action={<Button onClick={reset}>다시 시도</Button>}
      />
    </Content>
  );
}
