import type { Metadata, Viewport } from 'next'

import { Providers } from '@/components/providers'

import './globals.css'

export const metadata: Metadata = {
  title: 'Nutrient Tracker',
  description: 'Log meals, set goals, see where you actually are.',
  manifest: '/manifest.webmanifest',
}

// Mobile-first: no zoom lock, respects the notch.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
