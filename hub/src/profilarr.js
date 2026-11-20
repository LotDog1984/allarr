/**
 * Profilarr has no API for adding a Sonarr/Radarr connection (only its own UI forms), so the Hub writes the same
 * rows its "add instance" code writes. Profilarr's database layout is pinned to the version in the Dockerfile, and
 * the wiring step turns any failure here into a warning plus a checklist hint, so a schema change can't break setup.
 * `node:sqlite` is loaded lazily so the Hub still starts on a Node that lacks it.
 */
const open = async (file, options) => {
  const { DatabaseSync } = await import('node:sqlite');
  return options ? new DatabaseSync(file, options) : new DatabaseSync(file); // Node 22 rejects an explicit undefined
};

/** Has Profilarr finished its first start (database created and migrated)? */
export async function ready(file) {
  try {
    const db = await open(file, { readOnly: true });
    try {
      return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'arr_instances'").get();
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Create or refresh connections: [{ name, type, url, apiKey }]. Profilarr must be stopped. Returns what it did. */
export async function upsertInstances(file, entries) {
  const db = await open(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN');
    const done = [];
    for (const e of entries) {
      const row = db.prepare('SELECT id FROM arr_instances WHERE name = ? OR (type = ? AND url = ?)').get(e.name, e.type, e.url);
      if (row) {
        db.prepare('UPDATE arr_instances SET url = ?, api_key = ?, enabled = 1 WHERE id = ?').run(e.url, e.apiKey, row.id);
        done.push({ name: e.name, how: 'updated' });
        continue;
      }
      const { lastInsertRowid } = db
        .prepare('INSERT INTO arr_instances (name, type, url, api_key, enabled) VALUES (?, ?, ?, ?, 1)')
        .run(e.name, e.type, e.url, e.apiKey);
      const id = Number(lastInsertRowid);
      // What Profilarr itself does after adding one: rank the linked profile databases for the new instance.
      db.prepare(`INSERT INTO arr_sync_database_priority (instance_id, database_id, priority)
        SELECT ?, di.id, ROW_NUMBER() OVER (ORDER BY di.id) FROM database_instances di
        WHERE NOT EXISTS (SELECT 1 FROM arr_sync_database_priority WHERE instance_id = ? AND database_id = di.id)`).run(id, id);
      done.push({ name: e.name, how: 'added' });
    }
    db.exec('COMMIT');
    return done;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction open */ }
    throw err;
  } finally {
    db.close();
  }
}
