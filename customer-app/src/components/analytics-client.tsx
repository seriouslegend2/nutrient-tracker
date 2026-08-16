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
  api, type GoalMetricProgress, type GoalProgressSummary, type GoalProgressSummaryItem, type HydrationReport,
  type MacroSeriesPoint, type Macros, type MealPatterns, type MicroRow,
  type Micros, type NutrientSeries, type Profile, type Trend,
} from '@/lib/api-client'
import {
  average, expectedBuckets, reportWindow, selectGoal, TREND_RANGES, type ReportGrouping,
  type TrendRange,
} from '@/lib/trends'

const AXIS = { stroke: 'var(--color-tx2)', fontSize: 12 }
const GRID = 'var(--color-line)'
const TOOLTIP = { background: 'var(--color-surface)', border: `1px solid ${GRID}`, borderRadius: 12 }

export function AnalyticsClient() {
  const [range, setRange] = useState<TrendRange>('4w')
  const report = useMemo(() => reportWindow(range), [range])
  const reportParams = { date_from: report.dateFrom, date_to: report.dateTo, group_by: report.grouping }

  const trend = useQuery({ queryKey: ['trend', reportParams], queryFn: () => api.trend(reportParams), staleTime: 0 })
  const macros = useQuery({ queryKey: ['macros', reportParams], queryFn: () => api.macros(reportParams), staleTime: 0 })
  const micros = useQuery({
    queryKey: ['micros', report.dateFrom, report.dateTo],
    queryFn: () => api.micros({ date_from: report.dateFrom, date_to: report.dateTo }), staleTime: 0,
  })
  const previousTrend = useQuery({
    queryKey: ['trend', 'previous', range, report.grouping, report.previousDateFrom, report.previousDateTo],
    queryFn: () => api.trend({ date_from: report.previousDateFrom, date_to: report.previousDateTo, group_by: report.grouping }), staleTime: 0,
  })
  const previousMacros = useQuery({
    queryKey: ['macros', 'previous', range, report.grouping, report.previousDateFrom, report.previousDateTo],
    queryFn: () => api.macros({ date_from: report.previousDateFrom, date_to: report.previousDateTo, group_by: report.grouping }), staleTime: 0,
  })
  const patterns = useQuery({
    queryKey: ['meal-patterns', report.dateFrom, report.dateTo],
    queryFn: () => api.mealPatterns({ date_from: report.dateFrom, date_to: report.dateTo }), staleTime: 0,
  })
  const nutrientSeries = useQuery({
    queryKey: ['nutrient-series', reportParams],
    queryFn: () => api.nutrientSeries({ ...reportParams, nutrient: ['fiber_g', 'sodium_mg'] }), staleTime: 0,
  })
  const hydration = useQuery({
    queryKey: ['hydration-report', reportParams],
    queryFn: () => api.hydrationReport(reportParams), staleTime: 0,
  })
  const goalSummary = useQuery({
    queryKey: ['goal-progress-summary', report.dateTo],
    queryFn: () => api.goalProgressSummary(report.dateTo), staleTime: 0,
  })
  const weights = useQuery({ queryKey: ['weights', 'trends'], queryFn: () => api.weightHistory({ page_size: 200 }), staleTime: 0 })
  const me = useQuery({ queryKey: ['me', 'trends'], queryFn: api.me, staleTime: 0 })

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
        {[['#energy', 'Energy'], ['#eating-pattern', 'Eating pattern'], ['#nutrients', 'Nutrients'], ['#body-water', 'Body & water'], ['#goals', 'Goals'], ['#data-quality', 'Data quality']].map(([href, label]) => <a key={href} href={href} className="action-button-secondary shrink-0">{label}</a>)}
      </nav>

      <EvidenceStrip trend={trend.data} grouping={report.grouping} dateFrom={report.dateFrom} dateTo={report.dateTo} loading={trend.isPending} />
      <OverviewStrip macros={macros.data} hydration={hydration.data} weights={weights.data?.items ?? []} profile={me.data?.profile} />

      <TrendSection id="energy" title="Energy intake" detail="Recorded calorie intake across the selected period.">
        <CaloriePanel query={trend} grouping={report.grouping} />
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
          <WaterPanel query={hydration} grouping={report.grouping} />
          <BodyMeasurementsPanel query={weights} dateFrom={report.dateFrom} />
        </div>
      </TrendSection>

      <TrendSection id="goals" title="Goal progression" detail="Select a goal to compare the path you planned with what has actually been recorded.">
        <GoalPanel summary={goalSummary} dateFrom={report.dateFrom} dateTo={report.dateTo} />
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
  const recorded = new Set(trend?.series.filter((point) => point.calories_kcal != null).map((point) => point.bucket) ?? [])
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

function OverviewStrip({ macros, hydration, weights, profile }: {
  macros?: Macros
  hydration?: HydrationReport
  weights: { measured_on: string; weight_kg: number; waist_cm?: number | null }[]
  profile?: Profile | null
}) {
  const perDay = (metric: 'calories_kcal' | 'protein_g' | 'carbs_g' | 'fat_g') => {
    const values = macros?.series.flatMap((point) => point[metric] == null ? [] : [Number(point[metric])]) ?? []
    const days = macros?.coverage_days[metric] ?? 0
    return days && values.length ? values.reduce((sum, value) => sum + value, 0) / days : null
  }
  const water = hydration?.logged_days
    ? hydration.series.reduce((sum, point) => sum + (point.volume_ml ?? 0), 0) / hydration.logged_days
    : null
  const body = [...weights].sort((a, b) => a.measured_on.localeCompare(b.measured_on))
  const latest = body.at(-1)
  const stats = [
    { label: 'Energy / recorded day', value: formatStat(perDay('calories_kcal'), 'kcal') },
    { label: 'Protein / recorded day', value: formatStat(perDay('protein_g'), 'g') },
    { label: 'Carbs / recorded day', value: formatStat(perDay('carbs_g'), 'g') },
    { label: 'Fat / recorded day', value: formatStat(perDay('fat_g'), 'g') },
    { label: 'Water / logged day', value: water == null ? '—' : `${(water / 1000).toFixed(1)} L` },
    { label: 'Latest weight', value: latest ? `${latest.weight_kg.toFixed(1)} kg` : '—' },
    { label: 'Latest waist', value: latest?.waist_cm == null ? '—' : `${latest.waist_cm.toFixed(1)} cm` },
    { label: 'Profile height', value: profile?.height_cm == null ? '—' : `${formatNumber(profile.height_cm)} cm` },
    { label: 'Current BMI', value: profile?.bmi == null ? '—' : formatNumber(profile.bmi) },
    { label: 'Estimated BMR', value: profile?.bmr_kcal == null ? '—' : `${Math.round(profile.bmr_kcal).toLocaleString()} kcal` },
    { label: 'Estimated daily expenditure', value: profile?.tdee_kcal == null ? '—' : `${Math.round(profile.tdee_kcal).toLocaleString()} kcal` },
  ]
  return (
    <section className="card mb-4 p-5 sm:p-6" aria-labelledby="overview-heading">
      <p className="eyebrow">Selected-period overview</p>
      <h2 id="overview-heading" className="display-title text-2xl">Your recorded stats</h2>
      <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {stats.map((stat) => <StatTile key={stat.label} value={stat.value} label={stat.label} />)}
      </div>
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

function CaloriePanel({ query, grouping }: {
  query: ReturnType<typeof useQuery<Trend>>; grouping: ReportGrouping
}) {
  const series = query.data?.series ?? []
  const recorded = series.flatMap((point) => point.calories_kcal == null ? [] : [point.calories_kcal])
  const coveredDays = series.reduce((sum, point) => sum + point.recorded_days, 0)
  const mean = coveredDays ? recorded.reduce((sum, value) => sum + value, 0) / coveredDays : null
  const chart = series.map((point) => ({
    ...point,
    displayed_calories: grouping === 'day' ? point.calories_kcal : point.daily_average_kcal,
  }))
  return (
    <ReportPanel title="Calorie intake" description={`Recorded calories by rolling ${grouping}; grouped periods use an average per covered day so incomplete logging is not treated as zero. The trailing 7-point average appears only when all seven periods have data.`} loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!recorded.length}>
      <MetricLine value={mean == null ? '—' : `${Math.round(mean).toLocaleString()} kcal`} label={`average across ${coveredDays} days with calorie data`} />
      <div role="img" aria-label={`Calorie intake chart across ${series.length} periods`}>
        <ResponsiveContainer width="100%" height={250}>
          <ComposedChart data={chart} margin={{ top: 12, right: 4, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" {...AXIS} tickFormatter={(value) => shortBucket(String(value), grouping)} minTickGap={24} />
            <YAxis {...AXIS} width={48} />
            <Tooltip contentStyle={TOOLTIP} labelFormatter={(value) => formatBucket(String(value), grouping)} formatter={(value, name) => [`${Math.round(Number(value)).toLocaleString()} kcal`, name === 'rolling_mean' ? 'Rolling daily average' : grouping === 'day' ? 'Recorded intake' : 'Average per covered day']} />
            <Bar dataKey="displayed_calories" fill="var(--color-accent)" radius={[5, 5, 0, 0]} maxBarSize={28} />
            <Line dataKey="rolling_mean" stroke="var(--color-tx)" strokeWidth={2.5} dot={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {query.data?.unaccounted_items ? <DataWarning>{query.data.unaccounted_items} food item{query.data.unaccounted_items > 1 ? 's were' : ' was'} excluded because nutrition is unknown.</DataWarning> : null}
      <ChartTable headers={['Period', 'Recorded total', 'Average / covered day', 'Rolling daily average', 'Coverage']} rows={series.map((point) => [formatPeriod(point), point.calories_kcal == null ? 'Missing' : `${Math.round(point.calories_kcal)} kcal`, point.daily_average_kcal == null ? 'Missing' : `${Math.round(point.daily_average_kcal)} kcal`, point.rolling_mean == null ? '—' : `${Math.round(point.rolling_mean)} kcal`, `${point.recorded_days}/${point.calendar_days} days (${point.coverage_status})`])} />
    </ReportPanel>
  )
}

function MacroPanel({ query, grouping }: { query: ReturnType<typeof useQuery<Macros>>; grouping: ReportGrouping }) {
  const [view, setView] = useState<'grams' | 'share'>('grams')
  const series = query.data?.series ?? []
  const chart = series.map((point) => ({
    bucket: point.bucket,
    protein: view === 'grams' ? point.mean_per_covered_day.protein_g : point.pct_of_energy.protein,
    carbs: view === 'grams' ? point.mean_per_covered_day.carbs_g : point.pct_of_energy.carbs,
    fat: view === 'grams' ? point.mean_per_covered_day.fat_g : point.pct_of_energy.fat,
  }))
  const shares = macroAverages(series)
  const gramsPerCoveredDay = (metric: 'protein_g' | 'carbs_g' | 'fat_g') => {
    const coveredDays = query.data?.coverage_days[metric] ?? 0
    const total = series.reduce((sum, point) => sum + (point[metric] ?? 0), 0)
    return coveredDays ? total / coveredDays : null
  }
  const grams = {
    protein: gramsPerCoveredDay('protein_g'),
    carbs: gramsPerCoveredDay('carbs_g'),
    fat: gramsPerCoveredDay('fat_g'),
  }
  return (
    <ReportPanel title="Macronutrient breakdown" description={`Protein, carbohydrate, and fat by rolling ${grouping}. Switch between average grams per covered day and percentage of recorded macro energy.`} loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!series.some((point) => point.protein_g != null || point.carbs_g != null || point.fat_g != null)}>
      <div className="mb-4 grid grid-cols-2 rounded-2xl border p-1" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface-soft)' }}>
        <button onClick={() => setView('grams')} aria-pressed={view === 'grams'} className="rounded-xl px-3 py-2 font-semibold" style={{ background: view === 'grams' ? 'var(--color-surface)' : 'transparent', color: view === 'grams' ? 'var(--color-accent-strong)' : 'var(--color-tx2)' }}>Grams</button>
        <button onClick={() => setView('share')} aria-pressed={view === 'share'} className="rounded-xl px-3 py-2 font-semibold" style={{ background: view === 'share' ? 'var(--color-surface)' : 'transparent', color: view === 'share' ? 'var(--color-accent-strong)' : 'var(--color-tx2)' }}>Energy share</button>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        {(['protein', 'carbs', 'fat'] as const).map((macro) => <div key={macro} className="rounded-2xl p-3" style={{ background: 'var(--color-surface-soft)' }}><p className="text-sm capitalize" style={{ color: `var(--color-${macro})` }}>{macro}</p><p className="mt-1 text-xl font-bold tabular-nums">{grams[macro] == null ? '—' : `${formatNumber(grams[macro]!)} g`}</p><p className="text-sm" style={{ color: 'var(--color-tx2)' }}>{shares[macro] == null ? 'Share unavailable' : `${Math.round(shares[macro]!)}% energy · ${formatRange(query.data?.amdr_reference[macro])}`}</p></div>)}
      </div>
      <MacroLegend />
      <div role="img" aria-label={`Macro energy share chart with ${series.length} recorded periods`}>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={chart} margin={{ top: 10, right: 5, left: -14, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" {...AXIS} tickFormatter={(value) => shortBucket(String(value), grouping)} minTickGap={24} />
            <YAxis {...AXIS} width={42} domain={view === 'share' ? [0, 100] : ['auto', 'auto']} tickFormatter={(value) => `${value}${view === 'share' ? '%' : 'g'}`} />
            <Tooltip contentStyle={TOOLTIP} formatter={(value, name) => [value == null ? 'Missing' : `${Number(value).toFixed(1)}${view === 'share' ? '%' : ' g'}`, String(name)]} labelFormatter={(value) => formatBucket(String(value), grouping)} />
            <Line dataKey="protein" stroke="var(--color-protein)" strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false} />
            <Line dataKey="carbs" stroke="var(--color-carbs)" strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false} />
            <Line dataKey="fat" stroke="var(--color-fat)" strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>{view === 'share' ? 'AMDR references are percentages of recorded macro energy.' : 'Values are averages per day containing that macro; missing days remain gaps.'}</p>
      {query.data?.unaccounted_items ? <DataWarning>{query.data.unaccounted_items} food item{query.data.unaccounted_items > 1 ? 's were' : ' was'} excluded because nutrition is unknown.</DataWarning> : null}
      <ChartTable headers={['Period', 'Protein', 'Carbs', 'Fat']} rows={chart.map((point, index) => [formatPeriod(series[index]), formatMacroValue(point.protein, view), formatMacroValue(point.carbs, view), formatMacroValue(point.fat, view)])} />
    </ReportPanel>
  )
}

function GoalPanel({ summary, dateFrom, dateTo }: {
  summary: ReturnType<typeof useQuery<GoalProgressSummary>>; dateFrom: string; dateTo: string
}) {
  const [selectedGoalId, setSelectedGoalId] = useState('')
  const [selectedMetric, setSelectedMetric] = useState('')
  const goals = summary.data?.goals ?? []
  const selected = selectGoal(goals, selectedGoalId)
  const options = goalChartOptions(selected)
  const option = options.find((item) => item.key === selectedMetric) ?? options[0]
  const chart = option?.calendar.filter((point) => point.date >= dateFrom && point.date <= dateTo).map((point) => ({
    ...point,
    planned: point.target,
    plannedLow: option.direction === 'around' ? point.target * 0.9 : null,
    plannedHigh: option.direction === 'around' ? point.target * 1.1 : null,
  })) ?? []
  return (
    <ReportPanel title="Goal vs actual" description="Choose any active goal. Each chart uses that goal's own dates, target, direction, and recorded source." loading={summary.isPending} error={summary.isError} onRetry={() => summary.refetch()} empty={!goals.length} emptyAction={<Link href="/goals/new" className="action-button">Add a goal</Link>}>
      {selected && <>
        <div className="flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="Active goals">
          {goals.map((goal) => <button key={goal.goal_id} type="button" role="tab" aria-selected={goal.goal_id === selected.goal_id} onClick={() => setSelectedGoalId(goal.goal_id)} className="shrink-0 rounded-full border px-4 py-2 text-sm font-bold" style={{ borderColor: goal.goal_id === selected.goal_id ? 'var(--color-accent-strong)' : 'var(--color-line)', background: goal.goal_id === selected.goal_id ? 'var(--color-accent-soft)' : 'var(--color-surface)', color: goal.goal_id === selected.goal_id ? 'var(--color-accent-strong)' : 'var(--color-tx2)' }}>{goal.label}</button>)}
        </div>
        <h3 className="mt-2 text-xl font-bold">{selected.label}</h3>
        {options.length > 1 && <div className="mt-3 flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label={`${selected.label} metrics`}>
          {options.map((item) => <button key={item.key} type="button" role="tab" aria-selected={item.key === option?.key} onClick={() => setSelectedMetric(item.key)} className="shrink-0 rounded-xl border px-3 py-2 text-sm font-semibold" style={{ borderColor: item.key === option?.key ? 'var(--color-accent-strong)' : 'var(--color-line)', background: item.key === option?.key ? 'var(--color-accent-soft)' : 'var(--color-surface)', color: item.key === option?.key ? 'var(--color-accent-strong)' : 'var(--color-tx2)' }}>{item.label}</button>)}
        </div>}
        <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
          <span className="rounded-full px-3 py-1" style={{ background: 'var(--color-surface-soft)' }}>{selected.cadence} cadence</span>
          <span className="rounded-full px-3 py-1" style={{ background: 'var(--color-surface-soft)' }}>{directionLabel(option?.direction ?? selected.today.direction)}</span>
          <span className="rounded-full px-3 py-1" style={{ background: 'var(--color-surface-soft)' }}>{selected.starts_on} to {selected.ends_on}</span>
        </div>
        <GoalPlanDetails goal={selected} />
        {chart.length > 0 ? <>
        <p className="mt-3 text-sm" style={{ color: 'var(--color-tx2)' }}>X-axis: date · Y-axis: {option?.label} ({option?.unit})</p>
        <div className="mt-1" role="img" aria-label={`${option?.label} actual compared with planned target`}>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={chart} margin={{ top: 10, right: 5, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
              <XAxis dataKey="date" {...AXIS} tickFormatter={(value) => shortBucket(String(value), 'day')} minTickGap={24} label={{ value: 'Date', position: 'insideBottomRight', offset: -2, fill: 'var(--color-tx2)' }} />
              <YAxis {...AXIS} width={52} label={{ value: option ? `${option.label} (${option.unit})` : '', angle: -90, position: 'insideLeft', fill: 'var(--color-tx2)', fontSize: 11 }} />
              <Tooltip contentStyle={TOOLTIP} formatter={(value, name) => [value == null ? 'Not recorded' : `${formatNumber(Number(value))} ${option?.unit}`, String(name)]} />
              <Line dataKey="actual" name="Actual" stroke="var(--color-accent)" strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false} />
              <Line dataKey="planned" name={option?.trajectory ? 'Planned trajectory' : 'Daily target'} stroke="var(--color-warn)" strokeDasharray="5 4" dot={false} connectNulls={false} />
              {option?.direction === 'around' && <Line dataKey="plannedLow" name="Lower target band" stroke="var(--color-warn)" strokeOpacity={0.45} strokeDasharray="2 5" dot={false} />}
              {option?.direction === 'around' && <Line dataKey="plannedHigh" name="Upper target band" stroke="var(--color-warn)" strokeOpacity={0.45} strokeDasharray="2 5" dot={false} />}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <ChartTable headers={['Date', 'Actual', option?.trajectory ? 'Planned trajectory' : 'Daily target', 'Status']} rows={chart.map((point) => [formatBucket(point.date, 'day'), point.actual == null ? 'Not recorded' : `${formatNumber(point.actual)} ${option?.unit}`, `${formatNumber(point.planned)} ${option?.unit}`, progressStatusLabel(point.status)])} />
        </> : <DataWarning>This goal does not overlap the selected report range.</DataWarning>}
        <div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}><p className="text-sm" style={{ color: 'var(--color-tx2)' }}>Period actual</p><p className="mt-1 text-xl font-bold tabular-nums">{option?.period.actual == null ? '—' : `${formatNumber(option.period.actual)} ${option.unit}`}</p></div><div className="rounded-2xl p-4" style={{ background: 'var(--color-surface-soft)' }}><p className="text-sm" style={{ color: 'var(--color-tx2)' }}>Target to date</p><p className="mt-1 text-xl font-bold tabular-nums">{option ? `${formatNumber(option.period.target_to_date)} ${option.unit}` : '—'}</p></div></div>
      </>}
    </ReportPanel>
  )
}

function GoalPlanDetails({ goal }: { goal: GoalProgressSummaryItem }) {
  const derivation = goal.derivation
  const rows: { label: string; value: string }[] = []
  const add = (label: string, key: string, unit = '') => {
    const value = derivation[key]
    if (typeof value === 'number' && Number.isFinite(value)) rows.push({ label, value: `${formatNumber(value)}${unit ? ` ${unit}` : ''}` })
    else if (typeof value === 'string' && value) rows.push({ label, value })
  }
  if (goal.kind === 'body_weight') {
    add('Starting weight', 'weight_kg', 'kg')
    add('Target weight', 'target_weight_kg', 'kg')
    add('Target BMI', 'target_bmi')
    add('Estimated BMR', 'bmr_kcal', 'kcal/day')
    add('Estimated TDEE', 'tdee_kcal', 'kcal/day')
    add('Requested rate', 'requested_rate_kg_per_week', 'kg/week')
    add('Maximum safe rate', 'max_safe_rate_kg_per_week', 'kg/week')
    add('Applied rate', 'applied_rate_kg_per_week', 'kg/week')
    add('Applied intake', 'applied_intake_kcal', 'kcal/day')
    add('Calorie floor', 'calorie_floor_kcal', 'kcal/day')
    add('Projected date', 'achievable_end_date')
  } else if (goal.kind === 'hydration') {
    add('Profile water reference', 'estimated_target_ml', 'ml/day')
    add('Applied water target', 'applied_target_ml', 'ml/day')
    add('Weight used', 'weight_kg', 'kg')
  } else if (goal.metric === 'protein_g') {
    add('Weight used', 'weight_kg', 'kg')
    add('Protein baseline', 'protein_floor_g', 'g/day')
    add('Requested protein', 'requested_protein_g', 'g/day')
    add('Applied protein', 'applied_protein_g', 'g/day')
  } else if (goal.metric === 'calories_kcal') {
    add('Requested calories', 'requested_intake_kcal', 'kcal/day')
    add('Applied calories', 'applied_intake_kcal', 'kcal/day')
    add('Calorie floor', 'calorie_floor_kcal', 'kcal/day')
  }
  if (!rows.length) return null
  return <details className="mt-3 rounded-2xl border p-3" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface-soft)' }}>
    <summary className="cursor-pointer font-bold">How this plan was calculated</summary>
    <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3">{rows.map((row) => <div key={row.label}><p className="text-xs" style={{ color: 'var(--color-tx2)' }}>{row.label}</p><p className="font-semibold tabular-nums">{row.value}</p></div>)}</div>
  </details>
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
  const series = query.data?.series.map((point) => ({ ...point, value: point.daily_averages[selected] ?? null, coverageDays: point.coverage_days[selected] ?? 0 })) ?? []
  const coveredDays = series.reduce((sum, point) => sum + point.coverageDays, 0)
  const mean = coveredDays ? series.reduce((sum, point) => sum + (point.value ?? 0) * point.coverageDays, 0) / coveredDays : null
  const reference = micros?.panel.find((row) => row.nutrient === selected)
  const coverage = patterns?.nutrient_coverage.find((row) => row.nutrient === selected)
  const ceiling = selected === 'sodium_mg'
  return (
    <ReportPanel title="Fiber and sodium" description="Focused trends for a minimum-reference nutrient and a reference-limit nutrient, with missing values kept separate from zero." loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!series.some((point) => point.value != null)}>
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
      <ChartTable headers={['Period', `${readableMetric(selected)} per covered day`, 'Days with values']} rows={series.map((point) => [formatPeriod(point), point.value == null ? 'Missing' : `${formatNumber(point.value)} ${metricUnit(selected)}`, `${point.coverageDays}/${point.calendar_days}`])} />
    </ReportPanel>
  )
}

function MicronutrientPanel({ query }: { query: ReturnType<typeof useQuery<Micros>> }) {
  const data = query.data
  const recorded = data?.panel.filter((row) => row.pct_of_rda != null) ?? []
  const missing = (data?.panel.length ?? 0) - recorded.length
  const scale = Math.max(150, ...recorded.map((row) => row.pct_of_rda ?? 0))
  return (
    <ReportPanel title="Vitamins and minerals" description={data ? `Average per day with a recorded value for each nutrient; ${data.logged_days} of ${data.days} calendar days had nutrition-bearing meals · ${data.basis}` : 'Recorded vitamins and minerals compared with reference values.'} loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!recorded.length} emptyText="No vitamin or mineral values were recorded in this period.">
      <p className="mb-3 font-bold">Review first</p>
      <div>{data?.watchlist.map((row) => <MicroReference key={row.nutrient} row={row} scale={scale} />)}</div>
      <DataWarning>Food logs cannot diagnose a deficiency. {missing} vitamin or mineral values were not recorded and are not shown as zero.</DataWarning>
      {data?.unaccounted_items ? <DataWarning>{data.unaccounted_items} food item{data.unaccounted_items > 1 ? 's were' : ' was'} excluded because nutrition is unknown.</DataWarning> : null}
      <details className="mt-4 border-t pt-2" style={{ borderColor: 'var(--color-line)' }}>
        <summary className="cursor-pointer py-3 font-bold" style={{ color: 'var(--color-accent-strong)' }}>View all {recorded.length} recorded vitamins and minerals</summary>
        <div className="mt-2">{recorded.map((row) => <MicroReference key={row.nutrient} row={row} scale={scale} />)}</div>
      </details>
    </ReportPanel>
  )
}

function WaterPanel({ query, grouping }: {
  query: ReturnType<typeof useQuery<HydrationReport>>; grouping: ReportGrouping
}) {
  const series = query.data?.series.map((point) => ({ ...point, value: grouping === 'day' ? point.volume_ml : point.daily_average_ml })) ?? []
  const totalLoggedDays = series.reduce((sum, point) => sum + point.logged_days, 0)
  const mean = totalLoggedDays ? series.reduce((sum, point) => sum + (point.volume_ml ?? 0), 0) / totalLoggedDays : null
  return (
    <ReportPanel title="Water recorded" description={`All water entries in the selected rolling range, grouped by ${grouping}; food moisture and other drinks are not included.`} loading={query.isPending} error={query.isError} onRetry={() => query.refetch()} empty={!series.some((point) => point.volume_ml != null)}>
      <MetricLine value={mean == null ? '—' : `${(mean / 1000).toFixed(1)} L`} label={`average per water-log day across ${query.data?.logged_days ?? 0} recorded days`} />
      <div role="img" aria-label={`Water recorded chart with ${series.length} periods`}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={series} margin={{ top: 10, right: 4, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" {...AXIS} tickFormatter={(value) => shortBucket(String(value), grouping)} minTickGap={24} />
            <YAxis {...AXIS} width={45} tickFormatter={(value) => `${Number(value) / 1000}L`} />
            <Tooltip contentStyle={TOOLTIP} formatter={(value) => [`${(Number(value) / 1000).toFixed(2)} L`, grouping === 'day' ? 'Recorded' : 'Average per logged day']} />
            <Bar dataKey="value" fill="var(--color-protein)" radius={[5, 5, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartTable headers={['Period', 'Total recorded', 'Average per logged day', 'Entries', 'Coverage']} rows={series.map((point) => [formatPeriod(point), point.volume_ml == null ? 'Missing' : `${(point.volume_ml / 1000).toFixed(2)} L`, point.daily_average_ml == null ? 'Missing' : `${(point.daily_average_ml / 1000).toFixed(2)} L`, String(point.log_count), `${point.logged_days}/${point.calendar_days} days`])} />
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
  if (row.pct_of_rda == null || row.actual_per_day == null) return null
  const ceiling = row.direction === 'at_most'
  const width = Math.min(100, (row.pct_of_rda / scale) * 100)
  const marker = (100 / scale) * 100
  return (
    <div className="mb-4">
      <div className="flex items-end justify-between gap-3"><div><p className="font-semibold capitalize">{readableMetric(row.nutrient)}</p><p className="text-sm tabular-nums" style={{ color: 'var(--color-tx2)' }}>{formatNumber(row.actual_per_day)} / {formatNumber(row.rda_per_day)} {metricUnit(row.nutrient)} per covered day · {row.coverage_days} days</p></div><span className="shrink-0 text-sm font-bold">{Math.round(row.pct_of_rda)}% {ceiling ? 'of limit' : 'of reference'}</span></div>
      <div className="relative mt-2 h-2 overflow-hidden rounded-full" style={{ background: 'var(--color-line)' }}><div className="h-full rounded-full" style={{ width: `${width}%`, background: row.on_track == null ? 'var(--color-tx2)' : row.on_track ? 'var(--color-accent)' : ceiling ? 'var(--color-danger)' : 'var(--color-warn)' }} /><span className="absolute inset-y-0 w-0.5" style={{ left: `${marker}%`, background: 'var(--color-tx)' }} /></div>
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
  const calorieValues = trend?.series.flatMap((point) => point.calories_kcal == null ? [] : [point.calories_kcal]) ?? []
  const previousCalories = previousTrend?.series.flatMap((point) => point.calories_kcal == null ? [] : [point.calories_kcal]) ?? []
  const currentCoveredDays = trend?.series.reduce((sum, point) => sum + point.recorded_days, 0) ?? 0
  const previousCoveredDays = previousTrend?.series.reduce((sum, point) => sum + point.recorded_days, 0) ?? 0
  const currentMean = currentCoveredDays ? calorieValues.reduce((sum, value) => sum + value, 0) / currentCoveredDays : null
  const previousMean = previousCoveredDays ? previousCalories.reduce((sum, value) => sum + value, 0) / previousCoveredDays : null
  if (calorieValues.length >= 3 && previousCalories.length >= 3 && currentMean != null && previousMean != null && previousMean > 0) {
    const change = (currentMean - previousMean) / previousMean * 100
    insights.push({ title: 'Recorded energy', detail: `Averaged ${Math.abs(Math.round(change))}% ${change >= 0 ? 'higher' : 'lower'} per covered day than the previous equal period (${currentCoveredDays} vs ${previousCoveredDays} covered days).` })
  } else if (calorieValues.length) insights.push({ title: 'Recorded energy', detail: `${currentCoveredDays} days have calorie data. Both equal periods need at least 3 recorded points for a comparison.` })

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
  const complete = series.filter((point) => point.protein_g != null && point.carbs_g != null && point.fat_g != null)
  const proteinEnergy = complete.reduce((sum, point) => sum + Number(point.protein_g) * 4, 0)
  const carbEnergy = complete.reduce((sum, point) => sum + Number(point.carbs_g) * 4, 0)
  const fatEnergy = complete.reduce((sum, point) => sum + Number(point.fat_g) * 9, 0)
  const total = proteinEnergy + carbEnergy + fatEnergy
  return {
    protein: total ? proteinEnergy / total * 100 : null,
    carbs: total ? carbEnergy / total * 100 : null,
    fat: total ? fatEnergy / total * 100 : null,
  }
}

function formatMacroValue(value: number | null, view: 'grams' | 'share') {
  return value == null ? 'Missing' : `${formatNumber(value)}${view === 'share' ? '%' : ' g'}`
}

function formatStat(value: number | null, unit: string) {
  return value == null ? '—' : `${Math.round(value).toLocaleString()} ${unit}`
}

function directionLabel(direction: string | null) {
  return direction === 'at_least' ? 'At least target' : direction === 'at_most' ? 'At most target' : direction === 'around' ? 'Around target' : 'Target direction unavailable'
}

function progressStatusLabel(status: string) {
  return ({ met: 'Met', below: 'Below', above: 'Above', no_data: 'Not recorded', in_progress: 'In progress', future: 'Future' } as Record<string, string>)[status] ?? status
}

type GoalChartOption = {
  key: string
  label: string
  unit: string
  direction: string | null
  trajectory: boolean
  calendar: GoalProgressSummaryItem['calendar']
  period: GoalProgressSummaryItem['period'] | GoalMetricProgress['period']
}

function goalChartOptions(goal?: GoalProgressSummaryItem): GoalChartOption[] {
  if (!goal) return []
  const metricOptions = goal.metrics.map((metric) => ({
    key: metric.metric,
    label: metric.label,
    unit: metric.unit,
    direction: metric.direction,
    trajectory: false,
    calendar: metric.calendar,
    period: metric.period,
  }))
  if (goal.kind !== 'body_weight') {
    return metricOptions.length ? metricOptions : [{
      key: goal.metric ?? goal.kind,
      label: goal.label,
      unit: goal.today.unit,
      direction: goal.today.direction,
      trajectory: false,
      calendar: goal.calendar,
      period: goal.period,
    }]
  }
  return [{
    key: 'weight_kg',
    label: 'Weight',
    unit: 'kg',
    direction: goal.today.direction,
    trajectory: true,
    calendar: goal.calendar,
    period: goal.period,
  }, ...metricOptions]
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

function formatBucket(value: string, _grouping: ReportGrouping) {
  const date = new Date(`${value}T12:00:00`)
  const formatted = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return formatted
}

function formatPeriod(point: { period_start: string; period_end: string }) {
  const start = formatBucket(point.period_start, 'day')
  return point.period_start === point.period_end ? start : `${start} to ${formatBucket(point.period_end, 'day')}`
}
