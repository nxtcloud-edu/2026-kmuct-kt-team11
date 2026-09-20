import type { Metadata } from 'next';
import { Content, PageHeader } from '@/components/surface';
import { Uploader } from './uploader';

export const metadata: Metadata = { title: '음성 전사' };

/**
 * Upload UI for `POST /api/transcribe`. It takes a file, never a URL: fetching an
 * Instagram URL needs yt-dlp, which is dev-only (H6) and lives in the
 * `npm run transcribe` CLI. Production ingest arrives as a DM attachment.
 */
export default function TranscribePage() {
  return (
    <Content>
      <PageHeader title="음성 전사" meta="영상이나 오디오 파일의 말소리를 텍스트로 바꿔요" />
      <Uploader />
    </Content>
  );
}
