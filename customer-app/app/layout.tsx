import type { Metadata, Viewport } from 'next'
import { Albert_Sans, Noto_Sans } from 'next/font/google'

import { Providers } from '@/components/providers'

import './globals.css'

const displayFont = Albert_Sans({ subsets: ['latin'], variable: '--font-display' })
const bodyFont = Noto_Sans({ subsets: ['latin'], variable: '--font-body' })

export const metadata: Metadata = {
  title: 'Nourish · Nutrient Tracker',
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
    <html lang="en" suppressHydrationWarning>
      <body className={`${displayFont.variable} ${bodyFont.variable}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
