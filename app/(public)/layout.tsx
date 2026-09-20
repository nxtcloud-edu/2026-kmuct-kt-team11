/**
 * Signed-out chrome: none. No header, no nav — there is nowhere to navigate to
 * until there is a session, and an empty nav bar is furniture that advertises
 * what the visitor cannot have.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-[380px]">{children}</div>
    </div>
  );
}
