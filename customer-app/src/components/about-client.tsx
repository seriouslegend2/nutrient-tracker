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
  sweet: 'Sweet', nuts_seeds: 'Nuts', fat_oil: 'Oil / ghee',
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

  return <div className="app-shell px-4 pt-6">
    <h1 className="mb-4 text-2xl font-semibold tracking-tight">You</h1>
    <section className="card mb-4 p-5">
      <p className="text-lg">{me.data?.email ?? '—'}</p>
      <p className="text-xs" style={{ color: 'var(--color-tx2)' }}>{me.data?.roles?.join(', ')}</p>
      <button onClick={() => logout.mutate()} disabled={logout.isPending} className="mt-4 text-sm"
              style={{ color: 'var(--color-danger)' }}>{logout.isPending ? 'Signing out…' : 'Sign out'}</button>
    </section>

    <section className="card mb-4 p-5">
      <h2 className="mb-3 text-sm font-medium" style={{ color: 'var(--color-tx2)' }}>Body and preferences</h2>
      {profile && <ProfileEditor profile={profile} onSaved={() => queryClient.invalidateQueries({ queryKey: ['me'] })} />}
      <dl className="mt-4 space-y-2 border-t pt-4 text-sm" style={{ borderColor: 'var(--color-line)' }}>
        <Row label="BMI" value={profile?.bmi ? String(profile.bmi) : '—'} />
        <Row label="BMR" value={profile?.bmr_kcal ? `${Math.round(profile.bmr_kcal)} kcal` : '—'} note="Mifflin-St Jeor" />
        <Row label="Daily burn" value={profile?.tdee_kcal ? `${Math.round(profile.tdee_kcal * 0.9)}–${Math.round(profile.tdee_kcal * 1.1)} kcal` : '—'} note="estimate, ±10%" />
      </dl>
      <WeightLogger onLogged={() => queryClient.invalidateQueries({ queryKey: ['me'] })} />
    </section>

    <section className="card mb-4 p-5">
      <h2 className="text-sm font-medium" style={{ color: 'var(--color-tx2)' }}>Your portions</h2>
      <p className="mb-3 mt-0.5 text-xs" style={{ color: 'var(--color-tx2)' }}>Edit the size of one portion for each category.</p>
      {(portions.data?.items ?? []).map((portion) => <PortionEditor key={portion.category} portion={portion}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['portions'] })} />)}
    </section>

    <section className="card mb-4 p-5">
      <h2 className="mb-3 text-sm font-medium" style={{ color: 'var(--color-tx2)' }}>Saved preferences</h2>
      {!preferences.data?.items.length && <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>No saved preferences yet.</p>}
      {(preferences.data?.items ?? []).map((preference) => <PreferenceEditor key={preference.pref_id}
        preference={preference} onSaved={() => queryClient.invalidateQueries({ queryKey: ['prefs'] })} />)}
    </section>

    <section className="card mb-4 p-5">
      <div className="flex items-center justify-between"><h2 className="text-sm font-medium" style={{ color: 'var(--color-tx2)' }}>Goals</h2>
        <a href="/goals/new" className="text-sm" style={{ color: 'var(--color-accent)' }}>New goal</a></div>
      {(goals.data?.items ?? []).map((goal) => <div key={goal.goal_id} className="flex items-center justify-between border-t py-3 text-sm" style={{ borderColor: 'var(--color-line)' }}>
        <span className="capitalize">{goal.kind.replace('_', ' ')} · {goal.starts_on} to {goal.ends_on}</span>
        <GoalToggle id={goal.goal_id} active={goal.is_active} onChanged={() => {
          queryClient.invalidateQueries({ queryKey: ['goals'] }); queryClient.invalidateQueries({ queryKey: ['goal'] })
        }} />
      </div>)}
    </section>

    <section className="card mb-4 p-5">
      <h2 className="text-sm font-medium">Account data</h2>
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
    is_pregnant_or_nursing: Boolean(profile.is_pregnant_or_nursing), has_medical_condition: Boolean(profile.has_medical_condition) })
  const save = useMutation({
    mutationFn: () => api.updateProfile({ ...values, height_cm: Number(values.height_cm),
      allergies: values.allergies.split(',').map((value) => value.trim()).filter(Boolean), diet: values.diet || null }),
    onSuccess: () => { setEditing(false); onSaved() },
  })
  if (!editing) return <div className="text-sm"><Row label="Height" value={profile.height_cm ? `${profile.height_cm} cm` : '—'} />
    <Row label="Activity" value={profile.activity ?? '—'} /><Row label="Diet" value={profile.diet ?? '—'} />
    <button onClick={() => setEditing(true)} className="mt-3" style={{ color: 'var(--color-accent)' }}>Edit profile</button></div>
  return <div className="space-y-3 text-sm">
    <label>Sex<select className="input mt-1" value={values.sex} onChange={(e) => setValues({ ...values, sex: e.target.value })}><option value="male">Male</option><option value="female">Female</option></select></label>
    <label>Date of birth<input type="date" className="input mt-1" value={values.date_of_birth} onChange={(e) => setValues({ ...values, date_of_birth: e.target.value })} /></label>
    <label>Height (cm)<input type="number" min="50" max="275" className="input mt-1" value={values.height_cm} onChange={(e) => setValues({ ...values, height_cm: e.target.value })} /></label>
    <label>Activity<select className="input mt-1" value={values.activity} onChange={(e) => setValues({ ...values, activity: e.target.value })}>{['sedentary', 'light', 'moderate', 'very_active', 'extra_active'].map((value) => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}</select></label>
    <label>Diet<input className="input mt-1" value={values.diet} onChange={(e) => setValues({ ...values, diet: e.target.value })} /></label>
    <label>Allergies, comma separated<input className="input mt-1" value={values.allergies} onChange={(e) => setValues({ ...values, allergies: e.target.value })} /></label>
    <label className="flex gap-2"><input type="checkbox" checked={values.is_pregnant_or_nursing} onChange={(e) => setValues({ ...values, is_pregnant_or_nursing: e.target.checked })} />Pregnant or nursing</label>
    <label className="flex gap-2"><input type="checkbox" checked={values.has_medical_condition} onChange={(e) => setValues({ ...values, has_medical_condition: e.target.checked })} />Medical condition affecting diet</label>
    {save.error && <p style={{ color: 'var(--color-danger)' }}>{save.error.message}</p>}
    <div className="flex gap-4"><button disabled={!values.sex || !values.date_of_birth || !values.height_cm || save.isPending} onClick={() => save.mutate()} style={{ color: 'var(--color-accent)' }}>Save profile</button><button onClick={() => setEditing(false)}>Cancel</button></div>
  </div>
}

function PortionEditor({ portion, onSaved }: { portion: CategoryPortion; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [grams, setGrams] = useState(String(portion.portion_grams))
  const [count, setCount] = useState(String(portion.portion_count))
  const save = useMutation({ mutationFn: () => api.setPortion(portion.category, { portion_unit: portion.portion_unit, portion_grams: Number(grams), portion_count: Number(count) }), onSuccess: () => { setEditing(false); onSaved() } })
  return <div className="border-t py-2 text-sm first:border-t-0" style={{ borderColor: 'var(--color-line)' }}>
    <button onClick={() => setEditing(!editing)} className="flex w-full items-baseline justify-between text-left"><span>{CATEGORY_LABEL[portion.category] ?? portion.category}</span><span className="tabular-nums" style={{ color: 'var(--color-tx2)' }}>{portion.portion_count} {portion.portion_unit} · {portion.portion_grams} g{portion.is_custom && <span style={{ color: 'var(--color-accent)' }}> · yours</span>}</span></button>
    {editing && <div className="mt-2 grid grid-cols-2 gap-2"><label className="text-xs">Count<input className="input mt-1" type="number" min="0.1" step="0.1" value={count} onChange={(e) => setCount(e.target.value)} /></label><label className="text-xs">Grams<input className="input mt-1" type="number" min="1" value={grams} onChange={(e) => setGrams(e.target.value)} /></label>
      <button disabled={!count || !grams || save.isPending} onClick={() => save.mutate()} style={{ color: 'var(--color-accent)' }}>Save</button>{save.error && <p style={{ color: 'var(--color-danger)' }}>{save.error.message}</p>}</div>}
  </div>
}

function PreferenceEditor({ preference, onSaved }: { preference: Preference; onSaved: () => void }) {
  const [content, setContent] = useState(preference.content)
  const [editing, setEditing] = useState(false)
  const save = useMutation({ mutationFn: () => api.setPreference(preference.topic_title, { content, type: preference.type }), onSuccess: () => { setEditing(false); onSaved() } })
  return <div className="mb-3 border-b pb-3 last:border-b-0" style={{ borderColor: 'var(--color-line)' }}><button onClick={() => setEditing(!editing)} className="w-full text-left text-sm font-medium">{preference.topic_title}</button>
    {editing ? <><textarea className="input mt-2 min-h-24" value={content} onChange={(e) => setContent(e.target.value)} /><button disabled={!content.trim() || save.isPending} onClick={() => save.mutate()} className="mt-2 text-sm" style={{ color: 'var(--color-accent)' }}>Save preference</button></> : <p className="whitespace-pre-wrap text-xs" style={{ color: 'var(--color-tx2)' }}>{preference.content}</p>}
    {save.error && <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{save.error.message}</p>}</div>
}

function GoalToggle({ id, active, onChanged }: { id: string; active: boolean; onChanged: () => void }) {
  const toggle = useMutation({ mutationFn: () => active ? api.deactivateGoal(id) : api.activateGoal(id), onSuccess: onChanged })
  return <button disabled={toggle.isPending} onClick={() => toggle.mutate()} style={{ color: active ? 'var(--color-danger)' : 'var(--color-accent)' }}>{toggle.isPending ? 'Saving…' : active ? 'Deactivate' : 'Activate'}</button>
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="flex items-baseline justify-between"><dt style={{ color: 'var(--color-tx2)' }}>{label}</dt><dd className="tabular-nums text-right">{value}{note && <span className="ml-2 text-xs" style={{ color: 'var(--color-tx2)' }}>{note}</span>}</dd></div>
}

function WeightLogger({ onLogged }: { onLogged: () => void }) {
  const [weight, setWeight] = useState('')
  const log = useMutation({ mutationFn: () => api.logWeight(Number(weight)), onSuccess: () => { setWeight(''); onLogged() } })
  return <div className="mt-4"><div className="flex gap-2"><input type="number" min="20" max="400" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Log today's weight (kg)" className="input flex-1" /><button onClick={() => log.mutate()} disabled={!weight || log.isPending} className="rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-40" style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}>Save</button></div>{log.error && <p className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>{log.error.message}</p>}</div>
}
