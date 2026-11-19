let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || 'Request failed');
    err.status = res.status;
    if (res.status === 401 && !path.startsWith('/login')) onUnauthorized();
    throw err;
  }
  return data;
}

/** Live status + wiring progress from the Hub (Server-Sent Events, auto-reconnects). */
export function connectEvents({ status, wiring, updates, update }) {
  const es = new EventSource('/api/events');
  es.addEventListener('status', (e) => status(JSON.parse(e.data)));
  es.addEventListener('wiring', (e) => wiring(JSON.parse(e.data)));
  es.addEventListener('updates', (e) => updates?.(JSON.parse(e.data)));
  es.addEventListener('update', (e) => update?.(JSON.parse(e.data)));
  return es;
}
