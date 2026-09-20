import type { Metadata } from 'next';
import Link from 'next/link';
import { Content, PageHeader } from '@/components/surface';
import { requireSession } from '@/lib/require-session';
import { CreateGroupForm } from './create-group-form';

export const metadata: Metadata = { title: '새 그룹' };

export default async function NewGroupPage() {
  await requireSession();
  return (
    <Content>
      <Link href="/groups" className="mb-4 inline-block text-secondary">
        그룹으로 돌아가기
      </Link>
      <PageHeader title="새 그룹" meta="함께 코스를 만들 사람들을 초대할 공간이에요." />
      <CreateGroupForm />
    </Content>
  );
}
