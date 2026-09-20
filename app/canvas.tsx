/**
 * The phone canvas. 430px wide, centred on the grey backdrop, exactly as the
 * source system renders on desktop.
 *
 * Below 480px the frame is dropped entirely — no radius, no shadow, no
 * backdrop — and the app fills the viewport. A rounded card inside a phone is a
 * picture of an app; on a phone it should just be the app.
 */
export function Canvas({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh justify-center bg-backdrop max-[479px]:block max-[479px]:bg-canvas">
      <div
        className="relative flex min-h-dvh w-full max-w-[430px] flex-col bg-canvas
                   shadow-canvas min-[480px]:rounded-[var(--radius-canvas)]
                   max-[479px]:max-w-none max-[479px]:shadow-none"
      >
        {children}
      </div>
    </div>
  );
}
