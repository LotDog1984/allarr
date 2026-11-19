import * as store from './state.js';
import { byId, baseUrl } from './modules.js';

export class ApiError extends Error {
  constructor(status, body, url) {
    super(`${status} from ${url}${body ? `: ${String(body).slice(0, 160)}` : ''}`);
    this.status = status;
  }
}

export const keyOf = (id) => store.get().modules[id]?.apiKey;

/** Low-level call to an app's own HTTP API, over localhost, with its API key. */
export async function call(id, method, path, { body, form, headers, timeout = 20_000, text = false } = {}) {
  const url = `${baseUrl(byId[id])}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      // Only when we have a key: some apps treat an empty X-Api-Key as a failed API-key login and ignore Bearer tokens.
      ...(keyOf(id) ? { 'X-Api-Key': keyOf(id) } : {}),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const raw = await res.text();
  if (!res.ok) throw new ApiError(res.status, raw, url);
  if (text) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Servarr v1/v3 API shortcut: arr('sonarr','GET','/rootfolder') */
export const arr = (id, method, path, opts) => call(id, method, `/api/${byId[id].api}${path}`, opts);

/** Fill a Servarr "schema" object (download client / application) with our values. */
export function fillSchema(schema, values) {
  const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ...schema,
    fields: schema.fields.map((f) => {
      const v = lower[f.name.toLowerCase()];
      return v === undefined ? f : { ...f, value: v };
    }),
  };
}

/** Create-or-update (matched by name) an entry of a Servarr collection that has /schema. */
export async function upsertWithSchema(id, collection, implementation, name, values, extra = {}) {
  const [existing, schemas] = await Promise.all([
    arr(id, 'GET', `/${collection}`),
    arr(id, 'GET', `/${collection}/schema`),
  ]);
  const schema = schemas.find((s) => s.implementation === implementation);
  if (!schema) throw new Error(`${byId[id].name} doesn't offer "${implementation}"`);
  const found = existing.find((e) => e.implementation === implementation && e.name === name);
  const body = { ...fillSchema(schema, values), ...extra, name };
  if (found) {
    await arr(id, 'PUT', `/${collection}/${found.id}?forceSave=true`, { body: { ...body, id: found.id } });
    return 'updated';
  }
  await arr(id, 'POST', `/${collection}?forceSave=true`, { body });
  return 'created';
}
