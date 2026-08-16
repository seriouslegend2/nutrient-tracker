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
  api, type GoalProgressSummary, type GoalVsActual, type HydrationReport,
  type MacroSeriesPoint, type Macros, type MealPatterns, type MicroRow,
  type Micros, type NutrientSeries, type Trend,
} from '@/lib/api-client'
import {
  average, expectedBuckets, reportWindow, TREND_RANGES, type ReportGrouping,
  type TrendRange,
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
  const previousTrend = useQuery({
    queryKey: ['trend', 'previous', range, report.previousDateFrom, report.previousDateTo],
    queryFn: () => api.trend({ date_from: report.previousDateFrom, date_to: report.previousDateTo, group_by: report.grouping }),
  })
  const previousMacros = useQuery({
    queryKey: ['macros', 'previous', range, report.previousDateFrom, report.previousDateTo],
    queryFn: () => api.macros({ date_from: report.previousDateFrom, date_to: report.previousDateTo, group_by: report.grouping }),
  })
  const patterns = useQuery({
    queryKey: ['meal-patterns', report.dateFrom, report.dateTo],
    queryFn: () => api.mealPatterns({ date_from: report.dateFrom, date_to: report.dateTo }),
  })
  const nutrientSeries = useQuery({
    queryKey: ['nutrient-series', reportParams],
    queryFn: () => api.nutrientSeries({ ...reportParams, nutrient: ['fiber_g', 'sodium_mg'] }),
  })
  const hydration = useQuery({
    queryKey: ['hydration-report', reportParams],
    queryFn: () => api.hydrationReport(reportParams),
  })
  const goalSummary = useQuery({
    queryKey: ['goal-progress-summary', report.dateTo],
    queryFn: () => api.goalProgressSummary(report.dateTo),
  })
  const weights = useQuery({ queryKey: ['weights', 'trends'], queryFn: () => api.weightHistory({ page_size: 200 }) })

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

      <nav aria-label="Trends sections" className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {[['#energy', 'Energy'], ['#eating-pattern', 'Eating pattern'], ['#nutrients', 'Nutrients'], ['#body-water', 'Body & water'], ['#data-quality', 'Data quality']].map(([href, label]) => <a key={href} href={href} className="action-button-secondary shrink-0">{label}</a>)}
      </nav>

      <EvidenceStrip trend={trend.data} grouping={report.grouping} dateFrom={report.dateFrom} dateTo={report.dateTo} loading={trend.isPending} />

      <TrendSection id="energy" title="Energy and goals" detail="Calorie direction and personal target progress.">
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <CaloriePanel query={trend} grouping={report.grouping} calorieTarget={findCalorieTarget(goalComparison.data)} />
          <GoalPanel comparison={goalComparison} />
        </div>
      </TrendSection>

      <InsightSummary trend={trend.data} previousTrend={previousTrend.data} macros={macros.data} previousMacros={previousMacros.data} weights={weights.data?.items ?? []} dateFrom={report.dateFrom} />

      <TrendSection id="eating-pattern" title="Eating pattern" detail="Where recorded food energy appears across meal slots and times.">
        <MealPatternPanel query={patterns} />
      </TrendSection>

      <TrendSection id="nutrients" title="Nutrients" detail="Macro balance, focused fiber and sodium trends, and the full micronutrient reference panel.">
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <MacroPanel query={macros} grouping={report.grouping} />
          <NutrientFocusPanel query={nutrientSeries} micros={micros.data} patterns={patterns.data} grouping={report.grouping} />
        </div>
          <MicronutrientPanel query={micros} />
      </TrendSection>

      <TrendSection id="body-water" title="Body and water" detail="Recorded water, weight, and waist measurements without diagnostic interpretation.">
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <WaterPanel query={hydration} goals={goalSummary.data} grouping={report.grouping} />
          <BodyMeasurementsPanel query={weights} dateFrom={report.dateFrom} />
        </div>
      </TrendSection>

      <TrendSection id="data-quality" title="How this was calculated" detail="Coverage and source information behind the displayed estimates.">
        <DataQualityPanel query={patterns} />
      </TrendSection>

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

function InsightSummary({ trend, previousTrend, macros, previousMacros, weights, dateFrom }: {
  trend?: Trend; previousTrend?: Trend; macros?: Macros; previousMacros?: Macros
  weights: { measured_on: string; weight_kg: number }[]; dateFrom: string
}) {
  const insights = buildInsights(trend, previousTrend, macros, previousMacros, weights.filter((item) => item.measured_on >= dateFrom))
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

function MealPatternPanel({ query }: { query: ReturnType<typeof useQuery<MealPatterns>> }) {
  const data = query.data
  const slots = data?.slots.filter((slot) => slot.item_count > 0) ?? []
  const occurrences = slots.reduce((sum, slot) => sum + slot.days_present, 0)
  const perLoggedDay = data?.logged_days ? occurrences / data.logged_days : null
  const peak = data?.hourly.reduce((best, point) => point.occurrences > best.occurrences ? point : best, { hour: 0, occurrences: 0 })
  const slotColours = ['var(--color-protein)', 'var(--color-carbs)', 'var(--color-fat)', 'var(--color-accent)', 'var(--color-warn)', 'var(--color-tx2)']
  return (
    <ReportPanel title="Meal slots and timing" description="Recorded meal-slot use and explicit eating times; missing entries do not prove that a meal was skipped." loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!data?.item_count}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatTile value={perLoggedDay == null ? '—' : perLoggedDay.toFixed(1)} label="meal slots used per logged day" />
        <StatTile value={String(data?.timed_occurrences ?? 0)} label={`timed slots of ${occurrences} recorded`} />
        <StatTile value={peak?.occurrences ? `${String(peak.hour).padStart(2, '0')}:00–${String((peak.hour + 1) % 24).padStart(2, '0')}:00` : '—'} label="most common recorded hour" />
      </div>

      <h3 className="mt-5 font-bold">Recorded energy by meal slot</h3>
      <div className="mt-3 flex h-6 overflow-hidden rounded-full" aria-label="Recorded calorie share by meal slot">
        {slots.filter((slot) => slot.energy_share_pct > 0).map((slot, index) => <span key={slot.meal_type} title={`${slotLabel(slot.meal_type)}: ${slot.energy_share_pct}%`} style={{ width: `${slot.energy_share_pct}%`, background: slotColours[index % slotColours.length] }} />)}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {slots.map((slot, index) => <div key={slot.meal_type} className="flex items-start justify-between gap-3 border-t py-2 text-sm" style={{ borderColor: 'var(--color-line)' }}><span className="flex items-center gap-2"><span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: slotColours[index % slotColours.length] }} /><span><strong>{slotLabel(slot.meal_type)}</strong><span className="block" style={{ color: 'var(--color-tx2)' }}>{slot.days_present} days{slot.median_slot_time ? ` · median ${slot.median_slot_time}` : ' · no recorded time'}</span></span></span><span className="font-bold tabular-nums">{slot.energy_share_pct}%</span></div>)}
      </div>

      <h3 className="mt-5 font-bold">24-hour recorded-day ribbon</h3>
      <div className="mt-3 flex h-20 items-end gap-1" role="img" aria-label={`Eating-time histogram based on ${data?.timed_occurrences ?? 0} timed meal slots`}>
        {data?.hourly.map((point) => {
          const max = Math.max(1, ...data.hourly.map((item) => item.occurrences))
          return <span key={point.hour} title={`${String(point.hour).padStart(2, '0')}:00: ${point.occurrences} recorded slots`} className="min-h-1 flex-1 rounded-t" style={{ height: `${Math.max(5, point.occurrences / max * 100)}%`, background: point.occurrences ? 'var(--color-accent)' : 'var(--color-line)' }} />
        })}
      </div>
      <div className="mt-1 flex justify-between text-sm" style={{ color: 'var(--color-tx2)' }}><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
      <DataWarning>Timing uses only meal slots with an explicit consumption time. It does not classify any hour as good or bad.</DataWarning>
      <ChartTable headers={['Meal slot', 'Days present', 'Items', 'Median time', 'Recorded energy']} rows={slots.map((slot) => [slotLabel(slot.meal_type), String(slot.days_present), String(slot.item_count), slot.median_slot_time ?? 'Not recorded', `${slot.energy_share_pct}%`])} />
    </ReportPanel>
  )
}

function NutrientFocusPanel({ query, micros, patterns, grouping }: {
  query: ReturnType<typeof useQuery<NutrientSeries>>; micros?: Micros; patterns?: MealPatterns; grouping: ReportGrouping
}) {
  const [selected, setSelected] = useState<'fiber_g' | 'sodium_mg'>('fiber_g')
  const series = query.data?.series.map((point) => ({ bucket: point.bucket, value: point.daily_averages[selected] ?? null, coverageDays: point.coverage_days[selected] ?? 0 })) ?? []
  const coveredDays = series.reduce((sum, point) => sum + point.coverageDays, 0)
  const mean = coveredDays ? series.reduce((sum, point) => sum + (point.value ?? 0) * point.coverageDays, 0) / coveredDays : null
  const reference = micros?.panel.find((row) => row.nutrient === selected)
  const coverage = patterns?.nutrient_coverage.find((row) => row.nutrient === selected)
  const ceiling = selected === 'sodium_mg'
  return (
    <ReportPanel title="Fiber and sodium" description="Focused trends for a minimum-reference nutrient and a reference-limit nutrient, with missing values kept separate from zero." loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!query.data?.series.length}>
      <div className="mb-4 grid grid-cols-2 rounded-2xl border p-1" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface-soft)' }}>
        <button onClick={() => setSelected('fiber_g')} aria-pressed={selected === 'fiber_g'} className="rounded-xl px-3 py-2 font-semibold" style={{ background: selected === 'fiber_g' ? 'var(--color-surface)' : 'transparent', color: selected === 'fiber_g' ? 'var(--color-accent-strong)' : 'var(--color-tx2)' }}>Fiber</button>
        <button onClick={() => setSelected('sodium_mg')} aria-pressed={selected === 'sodium_mg'} className="rounded-xl px-3 py-2 font-semibold" style={{ background: selected === 'sodium_mg' ? 'var(--color-surface)' : 'transparent', color: selected === 'sodium_mg' ? 'var(--color-accent-strong)' : 'var(--color-tx2)' }}>Sodium</button>
      </div>
      <MetricLine value={mean == null ? '—' : `${formatNumber(mean)} ${metricUnit(selected)}/day`} label={`average across ${coveredDays} days with ${selected === 'fiber_g' ? 'fiber' : 'sodium'} values`} />
      <div role="img" aria-label={`${readableMetric(selected)} daily average by ${grouping}`}>
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={series} margin={{ top: 10, right: 5, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" {...AXIS} tickFormatter={(value) => shortBucket(String(value), grouping)} minTickGap={24} />
            <YAxis {...AXIS} width={50} />
            <Tooltip contentStyle={TOOLTIP} formatter={(value) => value == null ? ['Missing', readableMetric(selected)] : [`${formatNumber(Number(value))} ${metricUnit(selected)}/day`, readableMetric(selected)]} />
            <Bar dataKey="value" fill={ceiling ? 'var(--color-warn)' : 'var(--color-accent)'} radius={[5, 5, 0, 0]} maxBarSize={28} />
            {reference && <ReferenceLine y={reference.rda_per_day} stroke="var(--color-tx)" strokeDasharray="5 4" label={{ value: ceiling ? 'limit' : 'reference', fill: 'var(--color-tx2)', fontSize: 12 }} />}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>{coverage ? `${coverage.items_with_value} of ${coverage.total_items} food items (${Math.round(coverage.coverage_pct)}%) included a ${selected === 'fiber_g' ? 'fiber' : 'sodium'} value.` : 'Item-level coverage is unavailable.'}</p>
      <DataWarning>{ceiling ? 'Recorded sodium may not include salt added during cooking or at the table. Values above the line are above the displayed reference, not a diagnosis.' : 'A value below the line describes this food log only and does not diagnose a deficiency.'}</DataWarning>
      <ChartTable headers={['Period', `${readableMetric(selected)} per covered day`, 'Days with values']} rows={series.map((point) => [formatBucket(point.bucket, grouping), point.value == null ? 'Missing' : `${formatNumber(point.value)} ${metricUnit(selected)}`, String(point.coverageDays)])} />
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

function WaterPanel({ query, goals, grouping }: {
  query: ReturnType<typeof useQuery<HydrationReport>>
  goals?: GoalProgressSummary; grouping: ReportGrouping
}) {
  const series = query.data?.series.map((point) => ({ ...point, value: grouping === 'day' ? point.volume_ml : point.daily_average_ml })) ?? []
  const target = goals?.goals.find((goal) => goal.kind === 'hydration')?.today.target
  const totalLoggedDays = series.reduce((sum, point) => sum + point.logged_days, 0)
  const mean = totalLoggedDays ? series.reduce((sum, point) => sum + point.volume_ml, 0) / totalLoggedDays : null
  return (
    <ReportPanel title="Water recorded" description={`All water entries in the selected range, grouped by ${grouping}; food moisture and other drinks are not included.`} loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!series.length}>
      <MetricLine value={mean == null ? '—' : `${(mean / 1000).toFixed(1)} L`} label={`average per water-log day across ${query.data?.logged_days ?? 0} recorded days`} />
      <div role="img" aria-label={`Water recorded chart with ${series.length} periods`}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={series} margin={{ top: 10, right: 4, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" {...AXIS} tickFormatter={(value) => shortBucket(String(value), grouping)} minTickGap={24} />
            <YAxis {...AXIS} width={45} tickFormatter={(value) => `${Number(value) / 1000}L`} />
            <Tooltip contentStyle={TOOLTIP} formatter={(value) => [`${(Number(value) / 1000).toFixed(2)} L`, grouping === 'day' ? 'Recorded' : 'Average per logged day']} />
            <Bar dataKey="value" fill="var(--color-protein)" radius={[5, 5, 0, 0]} maxBarSize={28} />
            {target && grouping === 'day' && <ReferenceLine y={target} stroke="var(--color-warn)" strokeDasharray="5 4" />}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartTable headers={['Period', 'Total recorded', 'Average per logged day', 'Entries']} rows={series.map((point) => [formatBucket(point.bucket, grouping), `${(point.volume_ml / 1000).toFixed(2)} L`, `${(point.daily_average_ml / 1000).toFixed(2)} L`, String(point.log_count)])} />
      <DataWarning>These values describe water entered in the app, not hydration status or total water intake.</DataWarning>
    </ReportPanel>
  )
}

function BodyMeasurementsPanel({ query, dateFrom }: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.weightHistory>>>>; dateFrom: string
}) {
  const series = [...(query.data?.items ?? [])].filter((item) => item.measured_on >= dateFrom).sort((a, b) => a.measured_on.localeCompare(b.measured_on))
  const waist = series.filter((item) => item.waist_cm != null)
  const change = series.length > 1 ? series.at(-1)!.weight_kg - series[0].weight_kg : null
  return (
    <ReportPanel title="Weight and waist" description="Recorded measurements only; short-term movement can reflect fluid, measurement technique, and ordinary day-to-day variation." loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!series.length} emptyText="Log at least one weight to start this trend.">
      <MetricLine value={series.length ? `${series.at(-1)!.weight_kg.toFixed(1)} kg` : '—'} label={change == null ? `${series.length} measurement` : `${change > 0 ? '+' : ''}${change.toFixed(1)} kg across ${series.length} measurements`} />
      {series.length > 1 && <><h3 className="font-bold">Weight</h3><div role="img" aria-label={`Weight history with ${series.length} measurements`}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={series} margin={{ top: 12, right: 6, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="measured_on" {...AXIS} tickFormatter={(value) => shortBucket(String(value), 'day')} minTickGap={24} />
            <YAxis {...AXIS} width={48} domain={['dataMin - 1', 'dataMax + 1']} />
            <Tooltip contentStyle={TOOLTIP} formatter={(value) => [`${Number(value).toFixed(1)} kg`, 'Weight']} />
            <Line dataKey="weight_kg" stroke="var(--color-accent)" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div></>}
      {waist.length > 1 && <><h3 className="mt-5 font-bold">Waist</h3><div role="img" aria-label={`Waist history with ${waist.length} measurements`}>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={waist} margin={{ top: 12, right: 6, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="measured_on" {...AXIS} tickFormatter={(value) => shortBucket(String(value), 'day')} minTickGap={24} />
            <YAxis {...AXIS} width={48} domain={['dataMin - 1', 'dataMax + 1']} />
            <Tooltip contentStyle={TOOLTIP} formatter={(value) => [`${Number(value).toFixed(1)} cm`, 'Waist']} />
            <Line dataKey="waist_cm" stroke="var(--color-carbs)" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div></>}
      {series.length > 1 && <ChartTable headers={['Date', 'Weight', 'Waist']} rows={series.map((point) => [formatBucket(point.measured_on, 'day'), `${point.weight_kg.toFixed(1)} kg`, point.waist_cm == null ? '—' : `${point.waist_cm.toFixed(1)} cm`])} />}
      {query.data?.has_more && <DataWarning>Only the latest 200 measurements are included.</DataWarning>}
    </ReportPanel>
  )
}

function DataQualityPanel({ query }: { query: ReturnType<typeof useQuery<MealPatterns>> }) {
  const data = query.data
  return (
    <ReportPanel title="Data quality and sources" description="How food entries were captured, how portions were resolved, and which nutrient values were present." loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!data?.item_count}>
      <div className="grid gap-5 sm:grid-cols-2">
        <SourceList title="Capture channel" rows={data?.capture_sources ?? []} label={captureSourceLabel} />
        <SourceList title="Portion basis" rows={data?.portion_sources ?? []} label={portionSourceLabel} />
      </div>
      <h3 className="mt-5 font-bold">Nutrient value coverage</h3>
      <div className="mt-3 grid gap-x-5 sm:grid-cols-2">{data?.nutrient_coverage.map((row) => <div key={row.nutrient} className="mb-3"><div className="flex justify-between gap-3 text-sm"><span className="capitalize">{readableMetric(row.nutrient)}</span><span className="font-bold tabular-nums">{Math.round(row.coverage_pct)}%</span></div><div className="progress-track mt-1"><div className="progress-fill" style={{ width: `${row.coverage_pct}%`, background: 'var(--color-accent)' }} /></div><p className="mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>{row.items_with_value} of {row.total_items} food items</p></div>)}</div>
      <DataWarning>These summaries describe entries recorded in the app. Food logs can contain missing foods, uncertain portions, and incomplete nutrient data.</DataWarning>
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

function TrendSection({ id, title, detail, children }: { id: string; title: string; detail: string; children: React.ReactNode }) {
  return <section id={id} className="scroll-mt-4"><div className="mb-3 mt-8"><h2 className="display-title text-3xl">{title}</h2><p className="mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>{detail}</p></div>{children}</section>
}

function StatTile({ value, label }: { value: string; label: string }) {
  return <div className="rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}><p className="text-xl font-bold tabular-nums">{value}</p><p className="mt-1 text-sm" style={{ color: 'var(--color-tx2)' }}>{label}</p></div>
}

function SourceList({ title, rows, label }: {
  title: string
  rows: { source: string; item_count: number; share_pct: number }[]
  label: (source: string) => string
}) {
  return <div><h3 className="font-bold">{title}</h3><div className="mt-2">{rows.map((row) => <div key={row.source} className="flex items-center justify-between gap-3 border-t py-2 text-sm" style={{ borderColor: 'var(--color-line)' }}><span>{label(row.source)}</span><span className="font-bold tabular-nums">{row.item_count} · {Math.round(row.share_pct)}%</span></div>)}</div></div>
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

function buildInsights(
  trend?: Trend,
  previousTrend?: Trend,
  macros?: Macros,
  previousMacros?: Macros,
  weights: { measured_on: string; weight_kg: number }[] = []
) {
  const insights: { title: string; detail: string }[] = []
  const calorieValues = trend?.series.map((point) => point.calories_kcal) ?? []
  const previousCalories = previousTrend?.series.map((point) => point.calories_kcal) ?? []
  const currentMean = average(calorieValues)
  const previousMean = average(previousCalories)
  if (calorieValues.length >= 3 && previousCalories.length >= 3 && currentMean != null && previousMean != null && previousMean > 0) {
    const change = (currentMean - previousMean) / previousMean * 100
    insights.push({ title: 'Recorded energy', detail: `Averaged ${Math.abs(Math.round(change))}% ${change >= 0 ? 'higher' : 'lower'} than the previous equal period (${calorieValues.length} vs ${previousCalories.length} recorded points).` })
  } else if (calorieValues.length) insights.push({ title: 'Recorded energy', detail: `${calorieValues.length} periods have calorie data. Both equal periods need at least 3 points for a comparison.` })

  const shares = macroAverages(macros?.series ?? [])
  const previousShares = macroAverages(previousMacros?.series ?? [])
  const comparableMacros = (['protein', 'carbs', 'fat'] as const).filter((key) => shares[key] != null && previousShares[key] != null)
  const changedMacro = comparableMacros.sort((a, b) => Math.abs(shares[b]! - previousShares[b]!) - Math.abs(shares[a]! - previousShares[a]!))[0]
  if (changedMacro && (macros?.series.length ?? 0) >= 3 && (previousMacros?.series.length ?? 0) >= 3) {
    const points = shares[changedMacro]! - previousShares[changedMacro]!
    insights.push({ title: `${changedMacro[0].toUpperCase()}${changedMacro.slice(1)} share`, detail: `${Math.abs(points).toFixed(1)} percentage points ${points >= 0 ? 'higher' : 'lower'} than the previous equal period.` })
  } else {
  const macro = (['protein', 'carbs', 'fat'] as const).find((key) => {
    const reference = macros?.amdr_reference[key]
    return shares[key] != null && reference && (shares[key]! < reference[0] || shares[key]! > reference[1])
  })
  if (macro) insights.push({ title: `${macro[0].toUpperCase()}${macro.slice(1)} share`, detail: `Averaged ${Math.round(shares[macro]!)}% of recorded food energy; the reference range shown is ${formatRange(macros?.amdr_reference[macro])}.` })
  else if (shares.protein != null) insights.push({ title: 'Macro balance', detail: 'Average recorded macro energy shares were within the displayed reference ranges.' })
  }

  const sorted = [...weights].sort((a, b) => a.measured_on.localeCompare(b.measured_on))
  if (sorted.length > 1) {
    const delta = sorted.at(-1)!.weight_kg - sorted[0].weight_kg
    insights.push({ title: 'Recorded weight', detail: `${delta > 0 ? '+' : ''}${delta.toFixed(1)} kg between ${sorted.length} measurements. This does not identify the cause of short-term change.` })
  }
  return insights.slice(0, 3)
}

function macroAverages(series: MacroSeriesPoint[]) {
  const proteinEnergy = series.reduce((sum, point) => sum + point.protein_g * 4, 0)
  const carbEnergy = series.reduce((sum, point) => sum + point.carbs_g * 4, 0)
  const fatEnergy = series.reduce((sum, point) => sum + point.fat_g * 9, 0)
  const total = proteinEnergy + carbEnergy + fatEnergy
  return {
    protein: total ? proteinEnergy / total * 100 : null,
    carbs: total ? carbEnergy / total * 100 : null,
    fat: total ? fatEnergy / total * 100 : null,
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

function slotLabel(value: string) {
  return ({ breakfast: 'Breakfast', brunch: 'Brunch', lunch: 'Lunch', snacks: 'Snacks', dinner: 'Dinner', misc: 'Other' } as Record<string, string>)[value] ?? value
}

function captureSourceLabel(value: string) {
  return ({ manual: 'Manual entry', agent: 'Conversation', media: 'Photo or voice upload', pdf: 'PDF import', unknown: 'Unknown channel' } as Record<string, string>)[value] ?? value.replaceAll('_', ' ')
}

function portionSourceLabel(value: string) {
  return ({ meals: 'User-stated portion', dish_household: 'Saved dish portion', category_household: 'Saved category portion', dish_global: 'Food-specific standard', category_global: 'Category estimate', unknown: 'Nutrition unresolved' } as Record<string, string>)[value] ?? value.replaceAll('_', ' ')
}

function shortBucket(value: string, grouping: ReportGrouping) {
  const date = new Date(`${value}T12:00:00`)
  return date.toLocaleDateString(undefined, grouping === 'month' ? { month: 'short' } : { day: 'numeric', month: 'short' })
}

function formatBucket(value: string, grouping: ReportGrouping) {
  const date = new Date(`${value}T12:00:00`)
  const formatted = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return grouping === 'week' ? `Week of ${formatted}` : grouping === 'month' ? date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : formatted
}
