'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

import { BottomNav } from '@/components/nav'
import { api, type MicroRow } from '@/lib/api-client'

type Range = 'day' | 'week' | 'month'

const AXIS = { stroke: 'var(--color-tx2)', fontSize: 11 }
const GRID = 'var(--color-line)'

export function AnalyticsClient() {
  const [groupBy, setGroupBy] = useState<Range>('day')

  const { data: trend } = useQuery({
    queryKey: ['trend', groupBy], queryFn: () => api.trend({ group_by: groupBy }),
  })
  const { data: macros } = useQuery({
    queryKey: ['macros', groupBy], queryFn: () => api.macros({ group_by: groupBy }),
  })
  const { data: micros } = useQuery({ queryKey: ['micros'], queryFn: () => api.micros() })
  const { data: gva } = useQuery({ queryKey: ['gva'], queryFn: () => api.goalVsActual() })
  const { data: weights } = useQuery({ queryKey: ['weights'], queryFn: () => api.weightHistory() })

  return (
    <div className="app-shell px-4 pt-6">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Trends</h1>

      <div className="mb-5 flex gap-2">
        {(['day', 'week', 'month'] as const).map((r) => (
          <button
            key={r}
            onClick={() => setGroupBy(r)}
            className="rounded-lg px-3 py-1.5 text-sm capitalize"
            style={{
              background: groupBy === r ? 'var(--color-accent)' : 'var(--color-surface)',
              color: groupBy === r ? 'var(--color-bg)' : 'var(--color-tx)',
              border: '1px solid var(--color-line)',
            }}
          >
            {r}
          </button>
        ))}
      </div>

      <Panel title="Calorie intake" note={
        trend?.unaccounted_items
          ? `${trend.unaccounted_items} items excluded - nutrition unknown`
          : undefined
      }>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={trend?.series ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" {...AXIS} tickFormatter={(v) => String(v).slice(5)} />
            <YAxis {...AXIS} width={38} />
            <Tooltip contentStyle={{ background: 'var(--color-surface)', border: `1px solid ${GRID}` }} />
            <Area dataKey="calories_kcal" stroke="var(--color-accent)"
                  fill="var(--color-accent)" fillOpacity={0.15} />
            <Line dataKey="rolling_mean" stroke="var(--color-tx2)" dot={false} strokeDasharray="4 3" />
          </AreaChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Macros" note="Grams, and as a share of energy (AMDR: carbs 45-65%, fat 20-35%, protein 10-35%)">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={macros?.series ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" {...AXIS} tickFormatter={(v) => String(v).slice(5)} />
            <YAxis {...AXIS} width={38} />
            <Tooltip contentStyle={{ background: 'var(--color-surface)', border: `1px solid ${GRID}` }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="protein_g" stackId="m" fill="var(--color-protein)" name="protein" />
            <Bar dataKey="carbs_g" stackId="m" fill="var(--color-carbs)" name="carbs" />
            <Bar dataKey="fat_g" stackId="m" fill="var(--color-fat)" name="fat" />
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      {gva?.has_goal && (
        <Panel title="Goal vs actual" note={
          gva.clamp_fired ? 'Your target was adjusted for safety - see Home' : undefined
        }>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={(gva.series ?? []).map((d) => ({
              date: d.date,
              actual: (d.calories_kcal as { actual?: number } | undefined)?.actual ?? 0,
              target: (d.calories_kcal as { target?: number } | undefined)?.target ?? 0,
            }))}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="date" {...AXIS} tickFormatter={(v) => String(v).slice(5)} />
              <YAxis {...AXIS} width={38} />
              <Tooltip contentStyle={{ background: 'var(--color-surface)', border: `1px solid ${GRID}` }} />
              <Line dataKey="actual" stroke="var(--color-accent)" dot={false} name="actual" />
              <Line dataKey="target" stroke="var(--color-warn)" strokeDasharray="5 4"
                    dot={false} name="target" />
            </LineChart>
          </ResponsiveContainer>
        </Panel>
      )}

      {micros && (
        <Panel title="Micronutrients" note={`vs ${micros.basis}. Sodium is a ceiling, not a target.`}>
          <p className="mb-2 text-xs" style={{ color: 'var(--color-tx2)' }}>Needs attention</p>
          {micros.watchlist.map((row) => <MicroBar key={row.nutrient} row={row} />)}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs" style={{ color: 'var(--color-accent)' }}>
              All 18
            </summary>
            <div className="mt-2">
              {micros.panel.map((row) => <MicroBar key={row.nutrient} row={row} />)}
            </div>
          </details>
        </Panel>
      )}

      {weights && weights.items.length > 1 && (
        <Panel title="Weight" note="The projection flattens - BMR falls as weight falls.">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={[...weights.items].reverse()}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="measured_on" {...AXIS} tickFormatter={(v) => String(v).slice(5)} />
              <YAxis {...AXIS} width={38} domain={['dataMin - 2', 'dataMax + 2']} />
              <Tooltip contentStyle={{ background: 'var(--color-surface)', border: `1px solid ${GRID}` }} />
              <Line dataKey="weight_kg" stroke="var(--color-accent)" dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>
      )}

      <BottomNav />
    </div>
  )
}

function Panel({ title, note, children }: {
  title: string; note?: string; children: React.ReactNode
}) {
  return (
    <section className="card mb-4 p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {note && <p className="mb-2 mt-0.5 text-xs" style={{ color: 'var(--color-tx2)' }}>{note}</p>}
      <div className="mt-2 w-full overflow-x-auto">{children}</div>
    </section>
  )
}

function MicroBar({ row }: { row: MicroRow }) {
  const pct = Math.min(150, row.pct_of_rda)
  const isCeiling = row.direction === 'at_most'
  const colour = row.on_track
    ? 'var(--color-accent)'
    : isCeiling ? 'var(--color-danger)' : 'var(--color-warn)'
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs">
        <span>{row.nutrient.replace(/_(mg|ug|g|iu)$/, '').replace(/_/g, ' ')}</span>
        <span className="tabular-nums" style={{ color: 'var(--color-tx2)' }}>
          {Math.round(row.pct_of_rda)}%{isCeiling ? ' of limit' : ''}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--color-line)' }}>
        <div className="h-full rounded-full" style={{ width: `${(pct / 150) * 100}%`, background: colour }} />
      </div>
    </div>
  )
}
