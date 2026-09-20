import type { NextConfig } from 'next'

const config: NextConfig = {
  // H6 holds even though app/ now exists: nothing under app/ may import the
  // yt-dlp media source. The guard test in lib/extraction/media enforces it.
  serverExternalPackages: [],
}

export default config
