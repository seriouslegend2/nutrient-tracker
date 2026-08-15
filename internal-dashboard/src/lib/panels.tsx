/**
 * The panel registry.
 *
 * KookarCore's house detail view is not tabs and not one aggregate endpoint -
 * it is a registry-driven workspace where each panel fetches its own data
 * lazily. Adding a section is ONE array entry, with no routing change.
 *
 * The lazy fetching is the load-bearing part: a user with 5,000 meals must not
 * produce a 5,000-row payload because an admin opened their profile.
 */

export type PanelId =
  | 'overview'
  | 'meals'
  | 'goals'
  | 'preferences'
  | 'messages'
  | 'agent-runs'

export type PanelDefinition = {
  id: PanelId
  label: string
  group: 'primary' | 'data' | 'operations'
  /** Backend panel path segment, or null for a locally-composed panel. */
  endpoint: string | null
}

export const PANELS: PanelDefinition[] = [
  { id: 'overview', label: 'Overview', group: 'primary', endpoint: null },
  { id: 'meals', label: 'Meal log', group: 'data', endpoint: 'meals' },
  { id: 'goals', label: 'Goals', group: 'data', endpoint: 'goals' },
  { id: 'preferences', label: 'Preferences', group: 'data', endpoint: 'preferences' },
  { id: 'messages', label: 'Conversation', group: 'operations', endpoint: 'messages' },
  {
    id: 'agent-runs',
    label: 'Agent runs',
    group: 'operations',
    endpoint: 'agent-runs',
  },
]

export const PANEL_BY_ID = Object.fromEntries(PANELS.map((p) => [p.id, p])) as Record<
  PanelId,
  PanelDefinition
>
