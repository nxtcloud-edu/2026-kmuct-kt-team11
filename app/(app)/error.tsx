'use client';

import { useEffect } from 'react';
import { Button, Content } from '@/components/surface';
import { ErrorState } from '@/components/states';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[boundary:app]', error);
  }, [error]);

  return (
    <Content>
      <ErrorState
        detail="화면을 불러오지 못했어요. 잠시 후 다시 시도해 주세요."
        requestId={error.digest ?? null}
        action={<Button onClick={reset}>다시 시도</Button>}
      />
    </Content>
  );
}
