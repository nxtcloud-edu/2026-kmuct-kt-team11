import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  // Template so every child route reads "저장한 곳 · Gaja" without repeating it.
  title: { default: 'Gaja', template: '%s · Gaja' },
  description: '인스타그램에서 저장한 장소로 하루를 짭니다.',
};

export const viewport: Viewport = {
  // Matches --canvas so the iOS status bar does not band against the page.
  themeColor: '#F7F8F9',
  width: 'device-width',
  initialScale: 1,
};

/**
 * `lang="ko"` because `users.locale` defaults to ko and every string in slice 1
 * is Korean. It is also what makes the system stack resolve Apple SD Gothic Neo
 * rather than falling back to a Latin face with substituted Hangul.
 *
 * No font is loaded. `.agents/visual-language.md` forbids a webfont, so the
 * create-next-app Geist imports were removed rather than restyled.
 */
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
