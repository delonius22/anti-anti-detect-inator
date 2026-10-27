// Visit store on Node's built-in SQLite (Node 22.13+). One row per link, one per visit.
// JSON columns keep the schema stable while the test plan's fields evolve.

import { DatabaseSync } from "node:sqlite";

export function openStore(path = process.env.DB_PATH || "visits.db") {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, cohort TEXT, tool TEXT, note TEXT,
      one_time INTEGER DEFAULT 0, used INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY, link_id TEXT NOT NULL,
      t0 INTEGER, t1 INTEGER, t3 INTEGER, t5 INTEGER,
      ip TEXT, server TEXT, client TEXT, rtt TEXT, verdict TEXT);
    CREATE INDEX IF NOT EXISTS visits_link ON visits(link_id);
  `);
  const q = {
    addLink: db.prepare("INSERT INTO links (id,url,cohort,tool,note,one_time,created_at) VALUES (?,?,?,?,?,?,?)"),
    getLink: db.prepare("SELECT * FROM links WHERE id = ?"),
    useLink: db.prepare("UPDATE links SET used = used + 1 WHERE id = ?"),
    addVisit: db.prepare("INSERT INTO visits (id,link_id,t0,ip,server) VALUES (?,?,?,?,?)"),
    getVisit: db.prepare("SELECT * FROM visits WHERE id = ?"),
    setT1: db.prepare("UPDATE visits SET t1 = ? WHERE id = ?"),
    setClient: db.prepare("UPDATE visits SET client = ?, t3 = COALESCE(t3, ?) WHERE id = ?"),
    setRtt: db.prepare("UPDATE visits SET rtt = ? WHERE id = ?"),
    setVerdict: db.prepare("UPDATE visits SET verdict = ? WHERE id = ?"),
    setT5: db.prepare("UPDATE visits SET t5 = COALESCE(t5, ?) WHERE id = ?"),
    list: db.prepare(`SELECT v.*, l.url, l.cohort, l.tool FROM visits v JOIN links l ON l.id = v.link_id
                      ORDER BY v.t0 DESC LIMIT ?`),
  };
  const parse = (row) => row && ({ ...row,
    server: row.server && JSON.parse(row.server), client: row.client && JSON.parse(row.client),
    rtt: row.rtt && JSON.parse(row.rtt), verdict: row.verdict && JSON.parse(row.verdict) });

  return {
    db,
    addLink: (l) => q.addLink.run(l.id, l.url, l.cohort ?? null, l.tool ?? null, l.note ?? null, l.oneTime ? 1 : 0, Date.now()),
    getLink: (id) => q.getLink.get(id),
    useLink: (id) => q.useLink.run(id),
    addVisit: (v) => q.addVisit.run(v.id, v.linkId, v.t0, v.ip, JSON.stringify(v.server)),
    getVisit: (id) => parse(q.getVisit.get(id)),
    setT1: (id, t) => q.setT1.run(t, id),
    mergeClient: (id, patch, t3) => {
      const cur = q.getVisit.get(id);
      if (!cur) return false;
      const merged = { ...(cur.client ? JSON.parse(cur.client) : {}), ...patch };
      q.setClient.run(JSON.stringify(merged), t3, id);
      return true;
    },
    setRtt: (id, rtt) => q.setRtt.run(JSON.stringify(rtt), id),
    setVerdict: (id, v) => q.setVerdict.run(JSON.stringify(v), id),
    setT5: (id, t) => q.setT5.run(t, id),
    list: (limit = 100) => q.list.all(limit).map(parse),
  };
}
