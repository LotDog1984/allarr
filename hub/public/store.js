import { api } from './api.js';
import { h, icon, spinner } from './ui.js';

/** Everything the screens share. Kept tiny on purpose. */
export const S = {
  me: null, // { hasAdmin, authenticated, setupComplete, username, version }
  catalog: { groups: [], modules: [] },
  statuses: new Map(), // id -> { state, up, version, ... }
  wiring: null, // latest wiring snapshot
  answers: {},
  onWiring: null, // the visible progress view subscribes here
  updates: null, // { checkedAt, items:[{id,current,latest,available,inPlace,...}], count, applying }
  job: null, // the in-place update that is running / just ran
  onUpdate: null, // the visible update-progress view subscribes here
};

export const mod = (id) => S.catalog.modules.find((m) => m.id === id);
export const go = (hash) => { location.hash = hash; };

export async function refreshMe() {
  S.me = await api('/state');
  return S.me;
}

export async function loadCatalog() {
  [S.catalog, S.answers] = await Promise.all([api('/catalog'), api('/answers')]);
}

export const selectedApps = () => S.answers.apps ?? S.catalog.modules.filter((m) => m.defaultOn).map((m) => m.id);

export const STATE_TEXT = {
  running: 'Running', starting: 'Starting…', stopped: 'Stopped', crashed: 'Crashed — restarting', missing: 'Not installed',
};

// --- shared progress list (wizard "install" step and the settings "apply" dialog) ----------
const STEP_ICON = {
  pending: () => h('span', { class: 'ic' }),
  running: () => spinner(),
  ok: () => h('span', { class: 'ic ok' }, icon('check', 14)),
  warn: () => h('span', { class: 'ic warn' }, icon('alert', 14)),
  error: () => h('span', { class: 'ic err' }, icon('x', 14)),
  skipped: () => h('span', { class: 'ic' }, '–'),
};

function stepRow(s) {
  const showOpen = s.status === 'warn' || s.status === 'error';
  return h(
    'div',
    { class: `prog-step ${s.status}` },
    h('div', {}, (STEP_ICON[s.status] ?? STEP_ICON.pending)()),
    h(
      'div',
      {},
      h('div', { class: 'label' }, s.label),
      s.detail && s.status !== 'running'
        ? showOpen || s.status === 'skipped'
          ? h('div', { class: 'detail' }, s.detail)
          : h('details', {}, h('summary', {}, 'Details'), h('div', { class: 'detail' }, s.detail))
        : null,
    ),
  );
}

export const progressList = (w) =>
  h('div', { class: 'prog', 'aria-live': 'polite' }, (w?.steps ?? []).map(stepRow));

export function progressSummary(w, { onContinue, onRetry }) {
  if (!w || w.running) return null;
  const good = w.status === 'ok';
  return h(
    'div',
    { class: 'stack', style: { marginTop: '18px' } },
    good
      ? h('div', { class: 'hero-ok' }, h('div', { class: 'big' }, icon('check', 32)), h('h3', {}, 'All set!'),
          h('p', { class: 'muted' }, 'Your apps are running and already connected to each other.'))
      : h('div', { class: `notice ${w.status === 'error' ? 'notice-err' : 'notice-warn'}` }, icon('alert', 18),
          h('div', {}, h('b', {}, w.status === 'error' ? 'Some things need attention' : 'Almost there'),
            'Most of the setup worked, but a few items above need a look. You can retry now, or continue and fix them later from the dashboard.')),
    h('div', { class: 'flex wrap', style: { justifyContent: 'center' } },
      !good && onRetry ? h('button', { class: 'btn btn-secondary', onClick: onRetry }, icon('refresh', 16), 'Try again') : null,
      onContinue ? h('button', { class: 'btn btn-primary btn-lg', onClick: onContinue }, good ? 'Open dashboard' : 'Continue anyway', icon('right', 16)) : null,
    ),
  );
}
