'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/** Bottom tab bar, five items, thumb zone. No hover-dependent interaction. */
const TABS = [
  { href: '/home', label: 'Home', icon: '◎' },
  { href: '/meals', label: 'Meals', icon: '▤' },
  { href: '/agent', label: 'Log', icon: '＋', primary: true },
  { href: '/analytics', label: 'Trends', icon: '▲' },
  { href: '/about', label: 'You', icon: '☺' },
]

export function BottomNav() {
  const path = usePathname()
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t backdrop-blur"
      style={{
        borderColor: 'var(--color-line)',
        background: 'color-mix(in oklch, var(--color-surface) 92%, transparent)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div className="mx-auto flex max-w-[640px] items-stretch justify-around">
        {TABS.map((tab) => {
          const active = path.startsWith(tab.href)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className="flex flex-1 flex-col items-center gap-1 py-3 text-[11px]"
              style={{ color: active ? 'var(--color-accent)' : 'var(--color-tx2)' }}
            >
              <span
                className={tab.primary ? 'grid h-9 w-9 place-items-center rounded-full' : ''}
                style={
                  tab.primary
                    ? { background: 'var(--color-accent)', color: 'var(--color-bg)', fontSize: 20 }
                    : { fontSize: 18 }
                }
              >
                {tab.icon}
              </span>
              {!tab.primary && tab.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
