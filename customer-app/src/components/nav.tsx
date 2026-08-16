'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/home', label: 'Today', icon: 'home' },
  { href: '/meals', label: 'Meals', icon: 'meals' },
  { href: '/agent', label: 'Log', icon: 'plus' },
  { href: '/analytics', label: 'Trends', icon: 'trends' },
  { href: '/about', label: 'You', icon: 'user' },
] as const

export function BottomNav() {
  const path = usePathname()

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t pb-[env(safe-area-inset-bottom)]" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface)' }} aria-label="Main navigation">
      <div
        className="mx-auto flex max-w-[720px] items-center justify-around px-1 py-1"
      >
        {TABS.map((tab) => {
          const active = path.startsWith(tab.href)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              aria-label={tab.label}
              className="relative flex min-h-16 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl text-[13px] font-semibold transition-colors"
              style={{ color: active ? 'var(--color-accent-strong)' : 'var(--color-tx2)' }}
            >
              <span
                className="grid h-7 w-10 place-items-center rounded-xl"
                style={active ? { background: 'var(--color-accent-soft)' } : undefined}
              >
                <NavIcon name={tab.icon} />
              </span>
              <span>{tab.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

function NavIcon({ name }: { name: typeof TABS[number]['icon'] }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      {name === 'home' && <><path {...common} d="m3.5 10.8 8.5-7 8.5 7" /><path {...common} d="M5.5 9.5v10h13v-10M9.5 19.5v-6h5v6" /></>}
      {name === 'meals' && <><path {...common} d="M5 4.5h14v15H5z" /><path {...common} d="M8 8h8M8 12h8M8 16h5" /></>}
      {name === 'plus' && <><path {...common} d="M12 6v12M6 12h12" /></>}
      {name === 'trends' && <><path {...common} d="M4 19V5M4 19h16" /><path {...common} d="m7 15 4-4 3 2 5-6" /></>}
      {name === 'user' && <><circle {...common} cx="12" cy="8" r="3.5" /><path {...common} d="M5.5 20c.8-4 3-6 6.5-6s5.7 2 6.5 6" /></>}
    </svg>
  )
}
