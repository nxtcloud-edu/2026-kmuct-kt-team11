'use client';

import { useState, type FormEvent } from 'react';
import { Card, Button } from '@/components/surface';
import { Notice } from '@/components/states';

const MAX_BYTES = 25 * 1024 * 1024;

type Result = { transcript: string; language: string | null; ms: number; cost_usd: number };
type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; result: Result }
  | { kind: 'error'; message: string };

/**
 * A platform in front of the route (Vercel's ~4.5MB body limit, for one) can answer
 * with an HTML page instead of our JSON, so a failed `res.json()` is expected and
 * must still end in a sentence the user can act on.
 */
async function messageFor(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    /* not our JSON — fall through */
  }
  if (res.status === 413) return '파일이 너무 커요. 더 작은 파일로 올려 주세요.';
  return '전사에 실패했어요. 잠시 후 다시 시도해 주세요.';
}

export function Uploader() {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setState({ kind: 'error', message: '파일이 너무 커요. 25MB 이하로 올려 주세요.' });
      return;
    }

    setState({ kind: 'busy' });
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/transcribe', { method: 'POST', body: form });
      if (!res.ok) {
        setState({ kind: 'error', message: await messageFor(res) });
        return;
      }
      setState({ kind: 'done', result: (await res.json()) as Result });
    } catch {
      setState({ kind: 'error', message: '네트워크 연결을 확인해 주세요.' });
    }
  }

  const busy = state.kind === 'busy';

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label htmlFor="media-file" className="text-secondary" style={{ font: 'var(--type-meta)' }}>
          영상 또는 오디오 파일 (25MB 이하)
        </label>
        <input
          id="media-file"
          type="file"
          accept="video/*,audio/*"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setState({ kind: 'idle' });
          }}
          className="text-ink"
        />
        <Button type="submit" variant="primary" disabled={!file || busy}>
          {busy ? '전사 중…' : '전사하기'}
        </Button>
      </form>

      <div aria-live="polite">
        {state.kind === 'error' ? <Notice tone="danger" title="전사하지 못했어요" body={state.message} /> : null}

        {state.kind === 'done' ? (
          state.result.transcript.trim() === '' ? (
            <Notice
              title="말소리를 찾지 못했어요"
              body="음악만 있거나 소리가 없는 영상일 수 있어요. 화면에 적힌 글씨는 읽지 않아요."
            />
          ) : (
            <Card className="p-6">
              <p className="whitespace-pre-wrap" style={{ font: 'var(--type-body)' }}>
                {state.result.transcript}
              </p>
              <p className="mt-4 text-secondary" style={{ font: 'var(--type-caption)' }}>
                {(state.result.ms / 1000).toFixed(1)}초 · 약 ${state.result.cost_usd.toFixed(4)}
              </p>
            </Card>
          )
        ) : null}
      </div>
    </div>
  );
}
