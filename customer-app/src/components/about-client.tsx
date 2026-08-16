'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { BottomNav } from '@/components/nav'
import { api, type CategoryPortion, type Preference, type Profile } from '@/lib/api-client'

const CATEGORY_LABEL: Record<string, string> = {
  dal_gravy: 'Dal / gravy', dry_sabzi: 'Dry sabzi', rice_grain: 'Rice', flatbread: 'Roti / paratha',
  idli: 'Idli', dosa: 'Dosa', protein_main: 'Chicken / fish / mutton', paneer_tofu: 'Paneer / tofu',
  egg: 'Egg', curd_raita: 'Curd / raita', salad_raw: 'Salad', fruit: 'Fruit',
  beverage_milk: 'Milk / lassi', beverage_hot: 'Tea / coffee', snack_fried: 'Fried snack',
  sweet: 'Sweet', nuts_seeds: 'Nuts', fat_oil: 'Oil / ghee', unknown: 'Unknown item',
}

export function AboutClient() {
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const portions = useQuery({ queryKey: ['portions'], queryFn: api.portions })
  const preferences = useQuery({ queryKey: ['prefs'], queryFn: api.preferences })
  const goals = useQuery({ queryKey: ['goals'], queryFn: () => api.goals() })
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => { window.location.href = '/auth/login' },
  })
  const profile = me.data?.profile

  return <div className="app-shell px-4 pt-6 sm:px-6">
    <header className="mb-5"><p className="mb-1 text-base font-semibold" style={{ color: 'var(--color-accent-strong)' }}>Nourish</p><h1 className="display-title text-[38px] leading-none">You</h1></header>
    <section className="card mb-4 p-5">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl text-lg font-bold" style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent-strong)' }}>{me.data?.email?.slice(0, 1).toUpperCase() ?? '?'}</div>
      <p className="text-lg font-semibold">{me.data?.email ?? '—'}</p>
      <p className="text-xs" style={{ color: 'var(--color-tx2)' }}>{me.data?.roles?.join(', ')}</p>
      <button onClick={() => logout.mutate()} disabled={logout.isPending} className="action-button-danger mt-4">{logout.isPending ? 'Signing out…' : 'Sign out'}</button>
    </section>

    <section className="card mb-4 p-5">
      <h2 className="display-title mb-4 text-2xl">Body and preferences</h2>
      {profile && <ProfileEditor profile={profile} onSaved={() => {
        queryClient.invalidateQueries({ queryKey: ['me'] }); queryClient.invalidateQueries({ queryKey: ['goal'] }); queryClient.invalidateQueries({ queryKey: ['goals', 'summary'] })
      }} />}
      <dl className="mt-4 space-y-2 border-t pt-4 text-sm" style={{ borderColor: 'var(--color-line)' }}>
        <Row label="BMI" value={profile?.bmi ? String(profile.bmi) : '—'} />
        <Row label="BMR" value={profile?.bmr_kcal ? `${Math.round(profile.bmr_kcal)} kcal` : '—'} note="Mifflin-St Jeor" />
        <Row label="Daily burn" value={profile?.tdee_kcal ? `${Math.round(profile.tdee_kcal * 0.9)}–${Math.round(profile.tdee_kcal * 1.1)} kcal` : '—'} note="estimate, ±10%" />
      </dl>
      <WeightLogger onLogged={() => {
        queryClient.invalidateQueries({ queryKey: ['me'] }); queryClient.invalidateQueries({ queryKey: ['goal'] }); queryClient.invalidateQueries({ queryKey: ['goals', 'summary'] })
      }} />
    </section>

    <section className="card mb-4 p-5">
      <h2 className="display-title text-2xl">Your portions</h2>
      <p className="mb-3 mt-0.5 text-xs" style={{ color: 'var(--color-tx2)' }}>Each category has a fixed unit and grams. You can change only how many units make your usual serving. A specific meal can still use more or fewer servings.</p>
      {(portions.data?.items ?? []).map((portion) => <PortionEditor key={portion.category} portion={portion}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['portions'] })} />)}
    </section>

    <section className="card mb-4 p-5">
      <h2 className="display-title mb-3 text-2xl">Saved preferences</h2>
      {!preferences.data?.items.length && <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>No saved preferences yet.</p>}
      {(preferences.data?.items ?? []).map((preference) => <PreferenceEditor key={preference.pref_id}
        preference={preference} onSaved={() => queryClient.invalidateQueries({ queryKey: ['prefs'] })} />)}
    </section>

    <section id="goals" className="card mb-4 scroll-mt-4 p-5">
      <div className="flex items-center justify-between"><h2 className="display-title text-2xl">Goals</h2>
        <a href="/goals/new" className="action-button">+ Add a goal</a></div>
      <p className="mb-2 mt-1 text-xs" style={{ color: 'var(--color-tx2)' }}>You can keep several goals active together. Today shows each goal’s daily and full-period progress from your logged meals, water, or training check-ins.</p>
      {(goals.data?.items ?? []).map((goal) => <div key={`${goal.goal_id}-${goal.version}`} className="border-t py-4 text-sm" style={{ borderColor: 'var(--color-line)' }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <span><strong className="block">{managedGoalLabel(goal.kind, goal.spec)}</strong><span className="mt-1 block text-xs capitalize" style={{ color: 'var(--color-tx2)' }}>{goal.cadence} cadence | {goal.starts_on} to {goal.ends_on}</span></span>
          <span className="flex flex-wrap gap-2">
            <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: 'var(--color-surface-soft)', color: goal.is_active ? 'var(--color-accent-strong)' : 'var(--color-tx2)' }}>{goal.is_active ? 'Active' : 'Inactive'}</span>
            {goal.is_primary && <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent-strong)' }}>Primary</span>}
          </span>
        </div>
        <GoalControls id={goal.goal_id} active={goal.is_active} primary={goal.is_primary}
          canBePrimary={(goal.daily_targets.targets ?? []).some((target) => target.metric === 'calories_kcal')} onChanged={() => {
          queryClient.invalidateQueries({ queryKey: ['goals'] }); queryClient.invalidateQueries({ queryKey: ['goal'] }); queryClient.invalidateQueries({ queryKey: ['goals', 'summary'] })
        }} />
      </div>)}
    </section>

    <section className="card mb-4 p-5">
      <h2 className="display-title text-2xl">Account data</h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>
        Account export and account deletion are currently unavailable because the service does not expose those operations yet.
      </p>
    </section>
    <BottomNav />
  </div>
}

function ProfileEditor({ profile, onSaved }: { profile: Profile; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState({ sex: profile.sex ?? '', date_of_birth: profile.date_of_birth ?? '',
    height_cm: profile.height_cm ? String(profile.height_cm) : '', activity: profile.activity ?? 'moderate',
    diet: profile.diet ?? '', allergies: (profile.allergies ?? []).join(', '),
    breakfast_time: profile.breakfast_time ?? '08:00', lunch_time: profile.lunch_time ?? '13:00', dinner_time: profile.dinner_time ?? '20:00',
    is_pregnant_or_nursing: Boolean(profile.is_pregnant_or_nursing), has_medical_condition: Boolean(profile.has_medical_condition) })
  const save = useMutation({
    mutationFn: () => api.updateProfile({ ...values, height_cm: Number(values.height_cm),
      allergies: values.allergies.split(',').map((value) => value.trim()).filter(Boolean), diet: values.diet || null }),
    onSuccess: () => { setEditing(false); onSaved() },
  })
  if (!editing) return <div className="space-y-2 text-sm"><Row label="Sex" value={profile.sex ?? '—'} /><Row label="Date of birth" value={profile.date_of_birth ?? '—'} /><Row label="Height" value={profile.height_cm ? `${profile.height_cm} cm` : '—'} />
    <Row label="Activity" value={profile.activity?.replace('_', ' ') ?? '—'} /><Row label="Diet" value={profile.diet ?? '—'} /><Row label="Allergies" value={profile.allergies.length ? profile.allergies.join(', ') : 'None saved'} />
    <Row label="Meal schedule" value={[profile.breakfast_time, profile.lunch_time, profile.dinner_time].filter(Boolean).join(' · ') || 'Not set'} />
    <Row label="Goal safety" value={profile.is_pregnant_or_nursing || profile.has_medical_condition ? 'Review needed' : 'No flags saved'} />
    <button onClick={() => setEditing(true)} className="action-button mt-4">Edit profile</button></div>
  return <div className="space-y-3 text-sm">
    <label>Sex<select className="input mt-1" value={values.sex} onChange={(e) => setValues({ ...values, sex: e.target.value })}><option value="male">Male</option><option value="female">Female</option></select></label>
    <label>Date of birth<input type="date" className="input mt-1" value={values.date_of_birth} onChange={(e) => setValues({ ...values, date_of_birth: e.target.value })} /></label>
    <label>Height (cm)<input type="number" min="50" max="275" className="input mt-1" value={values.height_cm} onChange={(e) => setValues({ ...values, height_cm: e.target.value })} /></label>
    <label>Activity<select className="input mt-1" value={values.activity} onChange={(e) => setValues({ ...values, activity: e.target.value })}>{['sedentary', 'light', 'moderate', 'very_active', 'extra_active'].map((value) => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}</select></label>
    <label>Diet<input className="input mt-1" value={values.diet} onChange={(e) => setValues({ ...values, diet: e.target.value })} /></label>
    <label>Allergies, comma separated<input className="input mt-1" value={values.allergies} onChange={(e) => setValues({ ...values, allergies: e.target.value })} /></label>
    <fieldset><legend className="mb-2 font-semibold">Usual meal times</legend><div className="grid grid-cols-3 gap-2"><label>Breakfast<input type="time" className="input mt-1" value={values.breakfast_time} onChange={(e) => setValues({ ...values, breakfast_time: e.target.value })} /></label><label>Lunch<input type="time" className="input mt-1" value={values.lunch_time} onChange={(e) => setValues({ ...values, lunch_time: e.target.value })} /></label><label>Dinner<input type="time" className="input mt-1" value={values.dinner_time} onChange={(e) => setValues({ ...values, dinner_time: e.target.value })} /></label></div></fieldset>
    <label className="flex min-h-14 items-center gap-3 rounded-2xl border px-4" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface-soft)' }}><input className="h-5 w-5" type="checkbox" checked={values.is_pregnant_or_nursing} onChange={(e) => setValues({ ...values, is_pregnant_or_nursing: e.target.checked })} />Pregnant or nursing</label>
    <label className="flex min-h-14 items-center gap-3 rounded-2xl border px-4" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface-soft)' }}><input className="h-5 w-5" type="checkbox" checked={values.has_medical_condition} onChange={(e) => setValues({ ...values, has_medical_condition: e.target.checked })} />Medical condition affecting diet</label>
    {save.error && <p style={{ color: 'var(--color-danger)' }}>{save.error.message}</p>}
    <div className="flex gap-2"><button className="action-button" disabled={!values.sex || !values.date_of_birth || !values.height_cm || save.isPending} onClick={() => save.mutate()}>Save profile</button><button className="action-button-secondary" onClick={() => setEditing(false)}>Cancel</button></div>
  </div>
}

function PortionEditor({ portion, onSaved }: { portion: CategoryPortion; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [count, setCount] = useState(String(portion.portion_count))
  const save = useMutation({ mutationFn: () => api.setPortion(portion.category, Number(count)), onSuccess: () => { setEditing(false); onSaved() } })
  return <div className="border-t py-2 text-sm first:border-t-0" style={{ borderColor: 'var(--color-line)' }}>
    <button onClick={() => setEditing(!editing)} aria-expanded={editing} className="grid w-full grid-cols-[1fr_auto] items-center gap-3 text-left"><span><span className="block font-medium">{CATEGORY_LABEL[portion.category] ?? portion.category}</span><span className="mt-0.5 block tabular-nums" style={{ color: 'var(--color-tx2)' }}>Fixed category unit: 1 {portion.portion_unit} = {portion.portion_grams} g</span><span className="mt-0.5 block tabular-nums" style={{ color: 'var(--color-tx2)' }}>Your usual amount: {portion.portion_count} {portion.portion_unit} = {portion.effective_portion_grams} g{portion.is_custom && <span style={{ color: 'var(--color-accent-strong)' }}> · Your count</span>}</span></span><span className="edit-badge">Edit count</span></button>
    {editing && <div className="mt-2 grid gap-2"><p className="text-xs" style={{ color: 'var(--color-tx2)' }}>The grams for one {portion.portion_unit} are fixed. This changes only your usual count, not meals already logged.</p><label className="text-xs">Usual serving count ({portion.portion_unit})<input className="input mt-1" type="number" min="0.1" max="20" step="0.1" value={count} onChange={(e) => setCount(e.target.value)} /></label>
      <button className="action-button" disabled={!count || Number(count) <= 0 || Number(count) > 20 || save.isPending} onClick={() => save.mutate()}>Save</button>{save.error && <p style={{ color: 'var(--color-danger)' }}>{save.error.message}</p>}</div>}
  </div>
}

function PreferenceEditor({ preference, onSaved }: { preference: Preference; onSaved: () => void }) {
  const [content, setContent] = useState(preference.content)
  const [editing, setEditing] = useState(false)
  const save = useMutation({ mutationFn: () => api.setPreference(preference.topic_title, { content, type: preference.type }), onSuccess: () => { setEditing(false); onSaved() } })
  return <div className="mb-3 border-b pb-3 last:border-b-0" style={{ borderColor: 'var(--color-line)' }}><button onClick={() => setEditing(!editing)} aria-expanded={editing} className="flex w-full items-center justify-between gap-3 text-left text-sm font-medium"><span>{preference.topic_title}</span><span className="edit-badge">Edit</span></button>
    {editing ? <><textarea className="input mt-2 min-h-24" value={content} onChange={(e) => setContent(e.target.value)} /><button disabled={!content.trim() || save.isPending} onClick={() => save.mutate()} className="action-button mt-2">Save preference</button></> : <p className="whitespace-pre-wrap text-xs" style={{ color: 'var(--color-tx2)' }}>{preference.content}</p>}
    {save.error && <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{save.error.message}</p>}</div>
}

function GoalControls({ id, active, primary, canBePrimary, onChanged }: { id: string; active: boolean; primary: boolean; canBePrimary: boolean; onChanged: () => void }) {
  const toggle = useMutation({ mutationFn: () => active ? api.deactivateGoal(id) : api.activateGoal(id), onSuccess: onChanged })
  const makePrimary = useMutation({ mutationFn: () => api.makeGoalPrimary(id), onSuccess: onChanged })
  return <div className="mt-3 flex flex-wrap gap-2">
    <button className={active ? 'action-button-danger' : 'action-button'} disabled={toggle.isPending} onClick={() => toggle.mutate()}>{toggle.isPending ? 'Saving…' : active ? 'Deactivate' : 'Activate'}</button>
    {active && !primary && canBePrimary && <button className="action-button-secondary" disabled={makePrimary.isPending} onClick={() => makePrimary.mutate()}>{makePrimary.isPending ? 'Saving…' : 'Make primary'}</button>}
    {(toggle.error || makePrimary.error) && <p role="alert" className="w-full text-xs" style={{ color: 'var(--color-danger)' }}>{(toggle.error ?? makePrimary.error)?.message}</p>}
  </div>
}

function managedGoalLabel(kind: string, spec: Record<string, unknown>): string {
  if (typeof spec.label === 'string') return spec.label
  if (kind === 'body_weight') return `${spec.direction === 'gain' ? 'Gain' : 'Lose'} ${spec.amount_kg} kg`
  return kind.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="flex items-baseline justify-between"><dt style={{ color: 'var(--color-tx2)' }}>{label}</dt><dd className="tabular-nums text-right">{value}{note && <span className="ml-2 text-xs" style={{ color: 'var(--color-tx2)' }}>{note}</span>}</dd></div>
}

function WeightLogger({ onLogged }: { onLogged: () => void }) {
  const [weight, setWeight] = useState('')
  const log = useMutation({ mutationFn: () => api.logWeight(Number(weight)), onSuccess: () => { setWeight(''); onLogged() } })
  return <div className="mt-4"><div className="flex gap-2"><input type="number" min="20" max="400" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Log today's weight (kg)" className="input flex-1" /><button onClick={() => log.mutate()} disabled={!weight || log.isPending} className="btn-primary px-5">Save</button></div>{log.error && <p className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>{log.error.message}</p>}</div>
}
