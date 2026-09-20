import Link from 'next/link';
import { Content } from '@/components/surface';
import { Notice } from '@/components/states';

export default function NotFound() {
  return (
    <Content>
      <Notice
        title="페이지를 찾을 수 없어요"
        body="주소가 바뀌었거나 삭제된 페이지일 수 있어요."
        action={
          <Link href="/saved-places" className="text-sm underline underline-offset-4">
            저장한 곳으로 돌아가기
          </Link>
        }
      />
    </Content>
  );
}
