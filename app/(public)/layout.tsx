/**
 * Signed-out chrome: none. No header, no nav — there is nowhere to navigate to
 * until there is a session, and an empty nav bar is furniture that advertises
 * what the visitor cannot have.
 *
 * Width is no longer constrained here; the phone canvas in the root layout does
 * that for every route.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col px-[var(--gutter)]">{children}</div>;
}
