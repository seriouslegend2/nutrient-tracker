'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

import { BottomNav } from '@/components/nav'
import {
  api, type GoalVsActual, type MacroSeriesPoint, type Macros, type MicroRow,
  type Micros, type Trend,
} from '@/lib/api-client'
import {
  aggregateDatedValues, average, expectedBuckets, periodChange, reportWindow,
  TREND_RANGES, type ReportGrouping, type TrendRange,
} from '@/lib/trends'

const AXIS = { stroke: 'var(--color-tx2)', fontSize: 12 }
const GRID = 'var(--color-line)'
const TOOLTIP = { background: 'var(--color-surface)', border: `1px solid ${GRID}`, borderRadius: 12 }

export function AnalyticsClient() {
  const [range, setRange] = useState<TrendRange>('4w')
  const report = useMemo(() => reportWindow(range), [range])
  const reportParams = { date_from: report.dateFrom, date_to: report.dateTo, group_by: report.grouping }

  const trend = useQuery({ queryKey: ['trend', reportParams], queryFn: () => api.trend(reportParams) })
  const macros = useQuery({ queryKey: ['macros', reportParams], queryFn: () => api.macros(reportParams) })
  const micros = useQuery({
    queryKey: ['micros', report.dateFrom, report.dateTo],
    queryFn: () => api.micros({ date_from: report.dateFrom, date_to: report.dateTo }),
  })
  const goalComparison = useQuery({
    queryKey: ['goal-vs-actual', report.dateFrom, report.dateTo],
    queryFn: () => api.goalVsActual({ date_from: report.dateFrom, date_to: report.dateTo }),
  })
  const weights = useQuery({ queryKey: ['weights', 'trends'], queryFn: () => api.weightHistory({ page_size: 200 }) })
  const water = useQuery({ queryKey: ['water', 'trends'], queryFn: () => api.water({ page_size: 200 }) })

  return (
    <div className="app-shell trends-shell px-5 pt-6 sm:px-6">
      <header className="mb-5">
        <p className="mb-1 text-base font-semibold" style={{ color: 'var(--color-accent-strong)' }}>Nourish</p>
        <h1 className="display-title text-[38px] leading-none">Trends</h1>
        <p className="mt-2 max-w-xl text-sm" style={{ color: 'var(--color-tx2)' }}>
          Patterns from your recorded meals, goals, water, and body measurements.
        </p>
      </header>

      <div className="mb-4 grid grid-cols-4 rounded-2xl border p-1" style={{ background: 'var(--color-surface-soft)', borderColor: 'var(--color-line)' }} aria-label="Report range">
        {TREND_RANGES.map((item) => (
          <button key={item.value} aria-pressed={range === item.value} onClick={() => setRange(item.value)}
            className="rounded-xl px-1 py-2 text-sm font-semibold transition-colors"
            style={{ background: range === item.value ? 'var(--color-surface)' : 'transparent', color: range === item.value ? 'var(--color-accent-strong)' : 'var(--color-tx2)' }}>
            {item.label}
          </button>
        ))}
      </div>

      <EvidenceStrip trend={trend.data} grouping={report.grouping} dateFrom={report.dateFrom} dateTo={report.dateTo} loading={trend.isPending} />
      <InsightSummary trend={trend.data} macros={macros.data} weights={weights.data?.items ?? []} dateFrom={report.dateFrom} />

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div>
          <CaloriePanel query={trend} grouping={report.grouping} calorieTarget={findCalorieTarget(goalComparison.data)} />
          <MacroPanel query={macros} grouping={report.grouping} />
          <GoalPanel comparison={goalComparison} />
        </div>
        <div>
          <MicronutrientPanel query={micros} />
          <WaterPanel query={water} comparison={goalComparison.data} dateFrom={report.dateFrom} dateTo={report.dateTo} grouping={report.grouping} />
          <WeightPanel query={weights} dateFrom={report.dateFrom} />
        </div>
      </div>

      <BottomNav />
    </div>
  )
}

function EvidenceStrip({ trend, grouping, dateFrom, dateTo, loading }: {
  trend?: Trend; grouping: ReportGrouping; dateFrom: string; dateTo: string; loading: boolean
}) {
  const buckets = expectedBuckets(dateFrom, dateTo, grouping)
  const recorded = new Set(trend?.series.map((point) => point.bucket) ?? [])
  const noun = grouping === 'day' ? 'days' : grouping === 'week' ? 'weeks' : 'months'
  return (
    <section className="card mb-4 p-5" aria-labelledby="evidence-heading">
      <div className="flex items-start justify-between gap-4">
        <div><p className="eyebrow">Data coverage</p><h2 id="evidence-heading" className="display-title text-xl">{loading ? 'Loading…' : `${recorded.size} of ${buckets.length} ${noun} recorded`}</h2></div>
        {Boolean(trend?.unaccounted_items) && <span className="rounded-full px-3 py-1 text-sm font-semibold" style={{ background: 'var(--color-surface-soft)', color: 'var(--color-warn)' }}>{trend!.unaccounted_items} foods excluded</span>}
      </div>
      <div className="mt-4 flex gap-1" aria-label={`${recorded.size} of ${buckets.length} reporting periods contain recorded nutrition`}>
        {buckets.map((bucket) => <span key={bucket} title={`${formatBucket(bucket, grouping)}: ${recorded.has(bucket) ? 'recorded' : 'no recorded nutrition'}`} className="h-3 min-w-1 flex-1 rounded-full" style={{ background: recorded.has(bucket) ? 'var(--color-accent-strong)' : 'var(--color-line)' }} />)}
      </div>
      <p className="mt-3 text-sm" style={{ color: 'var(--color-tx2)' }}>Empty marks mean no nutrition-bearing meal was recorded. Missing food nutrition is never counted as zero.</p>
    </section>
  )
}

function InsightSummary({ trend, macros, weights, dateFrom }: {
  trend?: Trend; macros?: Macros; weights: { measured_on: string; weight_kg: number }[]; dateFrom: string
}) {
  const insights = buildInsights(trend, macros, weights.filter((item) => item.measured_on >= dateFrom))
  if (!insights.length) return (
    <section className="card mb-4 p-5"><p className="eyebrow">What changed</p><h2 className="display-title text-xl">Not enough recorded data yet</h2><p className="mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>Log meals on a few more days to see a reliable pattern.</p></section>
  )
  return (
    <section className="card mb-4 p-5" aria-labelledby="insights-heading">
      <p className="eyebrow">Period summary</p><h2 id="insights-heading" className="display-title text-xl">What changed</h2>
      <div className="mt-2 sm:grid sm:grid-cols-3 sm:gap-4">
        {insights.map((insight) => <div key={insight.title} className="border-t py-3" style={{ borderColor: 'var(--color-line)' }}><p className="font-bold">{insight.title}</p><p className="mt-0.5 text-sm" style={{ color: 'var(--color-tx2)' }}>{insight.detail}</p></div>)}
      </div>
    </section>
  )
}

function CaloriePanel({ query, grouping, calorieTarget }: {
  query: ReturnType<typeof useQuery<Trend>>; grouping: ReportGrouping; calorieTarget?: number
}) {
  const series = query.data?.series ?? []
  const mean = average(series.map((point) => point.calories_kcal))
  return (
    <ReportPanel title="Calorie intake" description={`Recorded intake by ${grouping}, with a trailing 7-period average.`} loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!series.length}>
      <MetricLine value={mean == null ? '—' : `${Math.round(mean).toLocaleString()} kcal`} label={`average across ${series.length} recorded ${grouping === 'day' ? 'days' : `${grouping}s`}`} />
      <div role="img" aria-label={`Calorie intake chart with ${series.length} recorded periods`}>
        <ResponsiveContainer width="100%" height={250}>
          <ComposedChart data={series} margin={{ top: 12, right: 4, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" {...AXIS} tickFormatter={(value) => shortBucket(String(value), grouping)} minTickGap={24} />
            <YAxis {...AXIS} width={48} />
            <Tooltip contentStyle={TOOLTIP} labelFormatter={(value) => formatBucket(String(value), grouping)} formatter={(value, name) => [`${Math.round(Number(value)).toLocaleString()} kcal`, name === 'rolling_mean' ? 'Rolling average' : 'Recorded intake']} />
            <Bar dataKey="calories_kcal" fill="var(--color-accent)" radius={[5, 5, 0, 0]} maxBarSize={28} />
            <Line dataKey="rolling_mean" stroke="var(--color-tx)" strokeWidth={2.5} dot={false} connectNulls={false} />
            {calorieTarget && <ReferenceLine y={calorieTarget} stroke="var(--color-warn)" strokeDasharray="5 4" label={{ value: 'target', fill: 'var(--color-tx2)', fontSize: 12 }} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {query.data?.unaccounted_items ? <DataWarning>{query.data.unaccounted_items} food item{query.data.unaccounted_items > 1 ? 's were' : ' was'} excluded because nutrition is unknown.</DataWarning> : null}
      <ChartTable headers={['Period', 'Calories', 'Rolling average']} rows={series.map((point) => [formatBucket(point.bucket, grouping), `${Math.round(point.calories_kcal)} kcal`, `${Math.round(point.rolling_mean)} kcal`])} />
    </ReportPanel>
  )
}

function MacroPanel({ query, grouping }: { query: ReturnType<typeof useQuery<Macros>>; grouping: ReportGrouping }) {
  const series = query.data?.series ?? []
  const chart = series.map((point) => ({ bucket: point.bucket, protein: point.pct_of_energy.protein, carbs: point.pct_of_energy.carbs, fat: point.pct_of_energy.fat }))
  const shares = macroAverages(series)
  return (
    <ReportPanel title="Macros" description={`Protein, carbohydrate, and fat as a share of recorded food energy by ${grouping}.`} loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!series.length}>
      <div className="mb-3 grid grid-cols-3 gap-2">
        {(['protein', 'carbs', 'fat'] as const).map((macro) => <div key={macro} className="rounded-2xl p-3" style={{ background: 'var(--color-surface-soft)' }}><p className="text-sm capitalize" style={{ color: `var(--color-${macro === 'carbs' ? 'carbs' : macro})` }}>{macro}</p><p className="mt-1 text-xl font-bold tabular-nums">{shares[macro] == null ? '—' : `${Math.round(shares[macro]!)}%`}</p><p className="text-sm" style={{ color: 'var(--color-tx2)' }}>{formatRange(query.data?.amdr_reference[macro])}</p></div>)}
      </div>
      <MacroLegend />
      <div role="img" aria-label={`Macro energy share chart with ${series.length} recorded periods`}>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={chart} margin={{ top: 10, right: 5, left: -14, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" {...AXIS} tickFormatter={(value) => shortBucket(String(value), grouping)} minTickGap={24} />
            <YAxis {...AXIS} width={42} domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
            <Tooltip contentStyle={TOOLTIP} formatter={(value, name) => [`${Number(value).toFixed(1)}%`, String(name)]} labelFormatter={(value) => formatBucket(String(value), grouping)} />
            <Line dataKey="protein" stroke="var(--color-protein)" strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false} />
            <Line dataKey="carbs" stroke="var(--color-carbs)" strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false} />
            <Line dataKey="fat" stroke="var(--color-fat)" strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>Reference ranges are AMDR percentages of energy, so grams are not stacked together.</p>
      {query.data?.unaccounted_items ? <DataWarning>{query.data.unaccounted_items} food item{query.data.unaccounted_items > 1 ? 's were' : ' was'} excluded because nutrition is unknown.</DataWarning> : null}
      <ChartTable headers={['Period', 'Protein', 'Carbs', 'Fat']} rows={chart.map((point) => [formatBucket(point.bucket, grouping), `${point.protein}%`, `${point.carbs}%`, `${point.fat}%`])} />
    </ReportPanel>
  )
}

function GoalPanel({ comparison }: {
  comparison: ReturnType<typeof useQuery<GoalVsActual>>
}) {
  const metric = findPlottableGoalMetric(comparison.data)
  const target = comparison.data?.targets.find((item) => item.metric === metric)
  const chart = metric ? (comparison.data?.series ?? []).flatMap((point) => {
    const value = point[metric] as { actual?: number; target?: number } | undefined
    return value && value.actual != null && value.target != null ? [{ date: String(point.date), actual: value.actual, target: value.target }] : []
  }) : []
  const summary = comparison.data?.summary
  return (
    <ReportPanel title="Goal vs actual" description="Recorded results compared with your active personal target." loading={comparison.isPending} error={comparison.isError} onRetry={() => comparison.refetch()} empty={!comparison.data?.has_goal} emptyAction={<Link href="/goals/new" className="action-button">Add a goal</Link>}>
      {target && chart.length > 0 && <>
        <p className="mb-2 font-bold">{target.label ?? readableMetric(target.metric)}</p>
        <div role="img" aria-label={`${target.label ?? readableMetric(target.metric)} actual compared with target`}>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={chart} margin={{ top: 10, right: 5, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
              <XAxis dataKey="date" {...AXIS} tickFormatter={(value) => shortBucket(String(value), 'day')} minTickGap={24} />
              <YAxis {...AXIS} width={45} />
              <Tooltip contentStyle={TOOLTIP} formatter={(value, name) => [`${Math.round(Number(value))} ${target.unit}`, String(name)]} />
              <Line dataKey="actual" name="Actual" stroke="var(--color-accent)" strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false} />
              <Line dataKey="target" name="Target" stroke="var(--color-warn)" strokeDasharray="5 4" dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <ChartTable headers={['Date', 'Actual', 'Target']} rows={chart.map((point) => [formatBucket(point.date, 'day'), `${formatNumber(point.actual)} ${target.unit}`, `${formatNumber(point.target)} ${target.unit}`])} />
      </>}
      {comparison.data?.has_goal && !chart.length && <DataWarning>This goal does not have a meal-based comparison chart for the selected period.</DataWarning>}
      {summary && <div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}><p className="text-sm" style={{ color: 'var(--color-tx2)' }}>Days with meals</p><p className="mt-1 text-xl font-bold tabular-nums">{summary.days_logged} / {summary.days_elapsed}</p></div><div className="rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}><p className="text-sm" style={{ color: 'var(--color-tx2)' }}>Logging coverage</p><p className="mt-1 text-xl font-bold tabular-nums">{Math.round(summary.adherence * 100)}%</p></div></div>}
    </ReportPanel>
  )
}

function MicronutrientPanel({ query }: { query: ReturnType<typeof useQuery<Micros>> }) {
  const data = query.data
  const scale = Math.max(150, ...(data?.panel.map((row) => row.pct_of_rda) ?? [150]))
  return (
    <ReportPanel title="Micronutrients" description={data ? `Average across ${data.days} calendar days; ${data.logged_days} had nutrition-bearing meals · ${data.basis}` : 'Recorded vitamins and minerals compared with reference values.'} loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!data?.panel.length}>
      <p className="mb-3 font-bold">Review first</p>
      <div>{data?.watchlist.map((row) => <MicroReference key={row.nutrient} row={row} scale={scale} />)}</div>
      <DataWarning>Food logs cannot diagnose a deficiency. Missing meal nutrient values can lower these recorded averages.</DataWarning>
      {data?.unaccounted_items ? <DataWarning>{data.unaccounted_items} food item{data.unaccounted_items > 1 ? 's were' : ' was'} excluded because nutrition is unknown.</DataWarning> : null}
      <details className="mt-4 border-t pt-2" style={{ borderColor: 'var(--color-line)' }}>
        <summary className="cursor-pointer py-3 font-bold" style={{ color: 'var(--color-accent-strong)' }}>View all 18 nutrients</summary>
        <div className="mt-2">{data?.panel.map((row) => <MicroReference key={row.nutrient} row={row} scale={scale} />)}</div>
      </details>
    </ReportPanel>
  )
}

function WaterPanel({ query, comparison, dateFrom, dateTo, grouping }: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.water>>>>
  comparison?: GoalVsActual; dateFrom: string; dateTo: string; grouping: ReportGrouping
}) {
  const logs = (query.data?.items ?? []).filter((item) => item.logged_on >= dateFrom && item.logged_on <= dateTo)
  const series = aggregateDatedValues(logs.map((item) => ({ date: item.logged_on, value: item.volume_ml })), grouping)
  const target = comparison?.targets.find((item) => item.metric === 'water_ml')?.value
  const mean = average(series.map((point) => point.value))
  return (
    <ReportPanel title="Water recorded" description={`Drinks entered in the app by ${grouping}; food moisture and unlogged drinks are not included.`} loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!series.length}>
      <MetricLine value={mean == null ? '—' : `${(mean / 1000).toFixed(1)} L`} label={`average across ${series.length} recorded ${grouping === 'day' ? 'days' : `${grouping}s`}`} />
      <div role="img" aria-label={`Water recorded chart with ${series.length} periods`}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={series} margin={{ top: 10, right: 4, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" {...AXIS} tickFormatter={(value) => shortBucket(String(value), grouping)} minTickGap={24} />
            <YAxis {...AXIS} width={45} tickFormatter={(value) => `${Number(value) / 1000}L`} />
            <Tooltip contentStyle={TOOLTIP} formatter={(value) => [`${(Number(value) / 1000).toFixed(2)} L`, 'Recorded']} />
            <Bar dataKey="value" fill="var(--color-protein)" radius={[5, 5, 0, 0]} maxBarSize={28} />
            {target && grouping === 'day' && <ReferenceLine y={target} stroke="var(--color-warn)" strokeDasharray="5 4" />}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartTable headers={['Period', 'Water recorded']} rows={series.map((point) => [formatBucket(point.bucket, grouping), `${(point.value / 1000).toFixed(2)} L`])} />
      {query.data?.has_more && <DataWarning>Only the latest 200 water entries are included in this view.</DataWarning>}
    </ReportPanel>
  )
}

function WeightPanel({ query, dateFrom }: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.weightHistory>>>>; dateFrom: string
}) {
  const series = [...(query.data?.items ?? [])].filter((item) => item.measured_on >= dateFrom).sort((a, b) => a.measured_on.localeCompare(b.measured_on))
  const change = series.length > 1 ? series.at(-1)!.weight_kg - series[0].weight_kg : null
  return (
    <ReportPanel title="Weight" description="Recorded measurements only; short-term movement can reflect fluid and normal day-to-day variation." loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!series.length} emptyText="Log at least one weight to start this trend.">
      <MetricLine value={series.length ? `${series.at(-1)!.weight_kg.toFixed(1)} kg` : '—'} label={change == null ? `${series.length} measurement` : `${change > 0 ? '+' : ''}${change.toFixed(1)} kg across ${series.length} measurements`} />
      {series.length > 1 && <div role="img" aria-label={`Weight history with ${series.length} measurements`}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={series} margin={{ top: 12, right: 6, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="measured_on" {...AXIS} tickFormatter={(value) => shortBucket(String(value), 'day')} minTickGap={24} />
            <YAxis {...AXIS} width={48} domain={['dataMin - 1', 'dataMax + 1']} />
            <Tooltip contentStyle={TOOLTIP} formatter={(value, name) => [`${Number(value).toFixed(1)} ${name === 'weight_kg' ? 'kg' : 'cm'}`, name === 'weight_kg' ? 'Weight' : 'Waist']} />
            <Line dataKey="weight_kg" stroke="var(--color-accent)" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} />
            {series.filter((item) => item.waist_cm != null).length > 1 && <Line dataKey="waist_cm" stroke="var(--color-carbs)" strokeWidth={2} dot={{ r: 2 }} connectNulls={false} />}
          </LineChart>
        </ResponsiveContainer>
      </div>}
      {series.length > 1 && <ChartTable headers={['Date', 'Weight', 'Waist']} rows={series.map((point) => [formatBucket(point.measured_on, 'day'), `${point.weight_kg.toFixed(1)} kg`, point.waist_cm == null ? '—' : `${point.waist_cm.toFixed(1)} cm`])} />}
      {query.data?.has_more && <DataWarning>Only the latest 200 measurements are included.</DataWarning>}
    </ReportPanel>
  )
}

function ReportPanel({ title, description, loading, error, onRetry, empty, emptyText = 'No recorded data in this period.', emptyAction, children }: {
  title: string; description: string; loading: boolean; error: boolean; onRetry: () => unknown
  empty: boolean; emptyText?: string; emptyAction?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section className="card mb-4 p-5 sm:p-6">
      <h2 className="display-title text-2xl">{title}</h2>
      <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--color-tx2)' }}>{description}</p>
      {loading ? <div className="mt-4 rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}>Loading report…</div>
        : error ? <div className="mt-4"><p role="alert">This report could not be loaded.</p><button className="action-button mt-3" onClick={onRetry}>Try again</button></div>
          : empty ? <div className="mt-4 rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}><p>{emptyText}</p>{emptyAction && <div className="mt-3">{emptyAction}</div>}</div>
            : <div className="mt-4">{children}</div>}
    </section>
  )
}

function MicroReference({ row, scale }: { row: MicroRow; scale: number }) {
  const ceiling = row.direction === 'at_most'
  const width = Math.min(100, (row.pct_of_rda / scale) * 100)
  const marker = (100 / scale) * 100
  return (
    <div className="mb-4">
      <div className="flex items-end justify-between gap-3"><div><p className="font-semibold capitalize">{readableMetric(row.nutrient)}</p><p className="text-sm tabular-nums" style={{ color: 'var(--color-tx2)' }}>{formatNumber(row.actual_per_day)} / {formatNumber(row.rda_per_day)} {metricUnit(row.nutrient)} per day</p></div><span className="shrink-0 text-sm font-bold">{Math.round(row.pct_of_rda)}% {ceiling ? 'of limit' : 'of reference'}</span></div>
      <div className="relative mt-2 h-2 overflow-hidden rounded-full" style={{ background: 'var(--color-line)' }}><div className="h-full rounded-full" style={{ width: `${width}%`, background: row.on_track ? 'var(--color-accent)' : ceiling ? 'var(--color-danger)' : 'var(--color-warn)' }} /><span className="absolute inset-y-0 w-0.5" style={{ left: `${marker}%`, background: 'var(--color-tx)' }} /></div>
    </div>
  )
}

function MetricLine({ value, label }: { value: string; label: string }) {
  return <div className="mb-3 flex items-end justify-between gap-4"><p className="display-title text-3xl tabular-nums">{value}</p><p className="max-w-48 text-right text-sm" style={{ color: 'var(--color-tx2)' }}>{label}</p></div>
}

function MacroLegend() {
  return <div className="mb-2 flex flex-wrap gap-4 text-sm">{[['Protein', 'protein'], ['Carbs', 'carbs'], ['Fat', 'fat']].map(([label, colour]) => <span key={label} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: `var(--color-${colour})` }} />{label}</span>)}</div>
}

function DataWarning({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 rounded-2xl p-3 text-sm leading-relaxed" style={{ background: 'var(--color-surface-soft)', color: 'var(--color-tx2)' }}>{children}</p>
}

function ChartTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return <details className="mt-3"><summary className="cursor-pointer py-2 font-semibold" style={{ color: 'var(--color-accent-strong)' }}>View values</summary><div className="mt-2 overflow-x-auto"><table className="w-full min-w-96 text-left text-sm"><thead><tr>{headers.map((header) => <th key={header} className="border-b px-2 py-2" style={{ borderColor: 'var(--color-line)' }}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border-b px-2 py-2 tabular-nums" style={{ borderColor: 'var(--color-line)' }}>{cell}</td>)}</tr>)}</tbody></table></div></details>
}

function buildInsights(trend?: Trend, macros?: Macros, weights: { measured_on: string; weight_kg: number }[] = []) {
  const insights: { title: string; detail: string }[] = []
  const calorieValues = trend?.series.map((point) => point.calories_kcal) ?? []
  const change = periodChange(calorieValues)
  if (change != null) insights.push({ title: 'Recorded energy', detail: `Recent recorded periods averaged ${Math.abs(Math.round(change))}% ${change >= 0 ? 'higher' : 'lower'} than the earlier half.` })
  else if (calorieValues.length) insights.push({ title: 'Recorded energy', detail: `${calorieValues.length} periods have calorie data. More points are needed to call a direction.` })

  const shares = macroAverages(macros?.series ?? [])
  const macro = (['protein', 'carbs', 'fat'] as const).find((key) => {
    const reference = macros?.amdr_reference[key]
    return shares[key] != null && reference && (shares[key]! < reference[0] || shares[key]! > reference[1])
  })
  if (macro) insights.push({ title: `${macro[0].toUpperCase()}${macro.slice(1)} share`, detail: `Averaged ${Math.round(shares[macro]!)}% of recorded food energy; the reference range shown is ${formatRange(macros?.amdr_reference[macro])}.` })
  else if (shares.protein != null) insights.push({ title: 'Macro balance', detail: 'Average recorded macro energy shares were within the displayed reference ranges.' })

  const sorted = [...weights].sort((a, b) => a.measured_on.localeCompare(b.measured_on))
  if (sorted.length > 1) {
    const delta = sorted.at(-1)!.weight_kg - sorted[0].weight_kg
    insights.push({ title: 'Recorded weight', detail: `${delta > 0 ? '+' : ''}${delta.toFixed(1)} kg between ${sorted.length} measurements. This does not identify the cause of short-term change.` })
  }
  return insights.slice(0, 3)
}

function macroAverages(series: MacroSeriesPoint[]) {
  return {
    protein: average(series.map((point) => point.pct_of_energy.protein)),
    carbs: average(series.map((point) => point.pct_of_energy.carbs)),
    fat: average(series.map((point) => point.pct_of_energy.fat)),
  }
}

function findCalorieTarget(data?: GoalVsActual) {
  return data?.targets.find((target) => target.metric === 'calories_kcal')?.value
}

function findPlottableGoalMetric(data?: GoalVsActual) {
  return data?.targets.find((target) => data.series.some((point) => {
    const value = point[target.metric]
    return typeof value === 'object' && value !== null && 'actual' in value
  }))?.metric
}

function formatRange(range?: number[]) { return range ? `${range[0]}–${range[1]}% reference` : 'No reference' }
function formatNumber(value: number) { return Number.isInteger(value) ? String(value) : value.toFixed(1) }
function metricUnit(metric: string) { return metric.match(/_(mg|ug|g|iu)$/)?.[1] ?? '' }
function readableMetric(metric: string) { return metric.replace(/_(mg|ug|g|iu|kcal|ml)$/, '').replaceAll('_', ' ') }

function shortBucket(value: string, grouping: ReportGrouping) {
  const date = new Date(`${value}T12:00:00`)
  return date.toLocaleDateString(undefined, grouping === 'month' ? { month: 'short' } : { day: 'numeric', month: 'short' })
}

function formatBucket(value: string, grouping: ReportGrouping) {
  const date = new Date(`${value}T12:00:00`)
  const formatted = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return grouping === 'week' ? `Week of ${formatted}` : grouping === 'month' ? date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : formatted
}
