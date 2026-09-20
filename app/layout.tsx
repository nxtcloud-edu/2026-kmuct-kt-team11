import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Canvas } from './canvas';

export const metadata: Metadata = {
  // Template so every child route reads "저장한 곳 · Gaja" without repeating it.
  title: { default: 'Gaja', template: '%s · Gaja' },
  description: '인스타그램에서 저장한 장소로 하루를 짭니다.',
};

export const viewport: Viewport = {
  // Matches --backdrop so the iOS status bar does not band against the page.
  themeColor: '#E9E9EB',
  width: 'device-width',
  initialScale: 1,
};

/**
 * `lang="ko"` because `users.locale` defaults to ko and every string in slice 1
 * is Korean. It is also what makes the system stack resolve Apple SD Gothic Neo
 * rather than falling back to a Latin face with substituted Hangul.
 *
 * Fonts are declared in globals.css rather than via next/font: the source
 * system names its families after the React Native tokens ('Inter-Medium',
 * 'Poppins-Bold'), and next/font would rename them, breaking every `font:`
 * shorthand that refers to them by name.
 */
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="ko">
      <body>
        <Canvas>{children}</Canvas>
      </body>
    </html>
  );
}
