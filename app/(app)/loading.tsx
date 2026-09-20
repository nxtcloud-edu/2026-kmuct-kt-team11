import { Content } from '@/components/surface';
import { ListSkeleton } from '@/components/states';

/**
 * Shown while a signed-in route's server render is in flight. The header is
 * already painted by the layout, so this only stands in for the content column.
 */
export default function AppLoading() {
  return (
    <Content>
      <div className="mb-6 h-8 w-40 rounded bg-fill" />
      <ListSkeleton />
    </Content>
  );
}
