import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Nutrient Tracker',
    short_name: 'Nutrients',
    description: 'Log meals, set goals, and track nutrition.',
    start_url: '/home',
    display: 'standalone',
    background_color: '#faf9f6',
    theme_color: '#37a86b',
  }
}
