const express = require("express");
const { Pool } = require("pg");
const webpush = require("web-push");

const PASS = process.env.FAMILY_PASSWORD || "";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
});
const app = express();
app.use(express.json());
app.use(express.static("public"));

const auth = (req, res, next) =>
  PASS && req.get("x-pass") !== PASS ? res.status(401).json({ error: "auth" }) : next();

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS items(
    id SERIAL PRIMARY KEY, text TEXT NOT NULL, by TEXT NOT NULL,
    urgent BOOLEAN DEFAULT FALSE, done BOOLEAN DEFAULT FALSE,
    done_by TEXT, created_at TIMESTAMPTZ DEFAULT now(), done_at TIMESTAMPTZ)`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS qty TEXT, ADD COLUMN IF NOT EXISTS cat TEXT, ADD COLUMN IF NOT EXISTS note TEXT, ADD COLUMN IF NOT EXISTS claimed_by TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS subs(
    endpoint TEXT PRIMARY KEY, data JSONB NOT NULL, name TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v JSONB NOT NULL)`);
  let r = await pool.query("SELECT v FROM settings WHERE k='vapid'");
  if (!r.rows.length) {
    const keys = webpush.generateVAPIDKeys();
    await pool.query("INSERT INTO settings VALUES('vapid',$1)", [keys]);
    r = { rows: [{ v: keys }] };
  }
  const v = r.rows[0].v;
  webpush.setVapidDetails("mailto:family@example.com", v.publicKey, v.privateKey);
  return v.publicKey;
}

async function pushTo(excludeName, payload) {
  const { rows } = await pool.query("SELECT endpoint,data FROM subs WHERE name<>$1", [excludeName]);
  await Promise.all(rows.map(async (s) => {
    try { await webpush.sendNotification(s.data, JSON.stringify(payload)); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410)
        await pool.query("DELETE FROM subs WHERE endpoint=$1", [s.endpoint]);
    }
  }));
}

app.post("/api/login", (req, res) =>
  !PASS || req.body.password === PASS ? res.json({ ok: true }) : res.status(401).json({ error: "bad" }));

let VAPID_PUBLIC = "";
app.get("/api/vapid", auth, (_, res) => res.json({ key: VAPID_PUBLIC }));

app.get("/api/items", auth, async (_, res) => {
  const { rows } = await pool.query(
    `SELECT id,text,by,urgent,done,done_by,created_at,qty,cat,note,claimed_by FROM items
     WHERE done=FALSE OR done_at > now() - interval '3 days'
     ORDER BY created_at DESC LIMIT 200`);
  res.json(rows);
});

app.post("/api/items", auth, async (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 200);
  const by = String(req.body.by || "").trim().slice(0, 40);
  const urgent = !!req.body.urgent;
  const qty = String(req.body.qty || "").trim().slice(0, 40);
  const cat = String(req.body.cat || "").trim().slice(0, 30);
  const note = String(req.body.note || "").trim().slice(0, 200);
  if (!text || !by) return res.status(400).json({ error: "bad" });
  await pool.query("INSERT INTO items(text,by,urgent,qty,cat,note) VALUES($1,$2,$3,$4,$5,$6)", [text, by, urgent, qty, cat, note]);
  res.json({ ok: true });
  pushTo(by, { title: urgent ? "⚡ مستعجل" : "🏠 أغراض البيت", body: `${by} بدها: ${text}${qty ? " (" + qty + ")" : ""}` });
});

app.post("/api/items/bulk", auth, async (req, res) => {
  const by = String(req.body.by || "").trim().slice(0, 40);
  const list = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 30)
    .map((i) => ({
      text: String(i.text || "").trim().slice(0, 200), qty: String(i.qty || "").trim().slice(0, 40),
      cat: String(i.cat || "").trim().slice(0, 30), note: String(i.note || "").trim().slice(0, 200), urgent: !!i.urgent,
    })).filter((i) => i.text);
  if (!by || !list.length) return res.status(400).json({ error: "bad" });
  for (const i of list)
    await pool.query("INSERT INTO items(text,by,urgent,qty,cat,note) VALUES($1,$2,$3,$4,$5,$6)",
      [i.text, by, i.urgent, i.qty, i.cat, i.note]);
  res.json({ ok: true });
  const names = list.map((i) => i.text + (i.qty ? " (" + i.qty + ")" : "")).join("، ");
  pushTo(by, { title: list.some((i) => i.urgent) ? "⚡ مستعجل" : "🏠 أغراض البيت",
    body: `${by} بدها ${list.length > 1 ? list.length + " أغراض" : ""}: ${names}`.slice(0, 180) });
});

app.post("/api/items/:id/done", auth, async (req, res) => {
  const by = String(req.body.by || "").slice(0, 40);
  const { rows } = await pool.query(
    "UPDATE items SET done=TRUE,done_by=$1,done_at=now() WHERE id=$2 AND done=FALSE RETURNING text",
    [by, req.params.id]);
  res.json({ ok: true });
  if (rows.length) pushTo(by, { title: "✅ انجابت", body: `${by} جاب: ${rows[0].text}` });
});

app.post("/api/items/:id/claim", auth, async (req, res) => {
  const by = String(req.body.by || "").slice(0, 40);
  const { rows } = await pool.query(
    "UPDATE items SET claimed_by = CASE WHEN claimed_by=$1 THEN NULL ELSE $1 END WHERE id=$2 AND done=FALSE RETURNING text,claimed_by",
    [by, req.params.id]);
  res.json({ ok: true });
  if (rows.length && rows[0].claimed_by)
    pushTo(by, { title: "🚶 رايح", body: `${by} رايح يجيب: ${rows[0].text}` });
});

app.post("/api/sos", auth, async (req, res) => {
  const by = String(req.body.by || "").slice(0, 40);
  res.json({ ok: true });
  pushTo(by, { title: "📞 اتصال", body: `${by} بدها حدا يتصل فيها` });
});

app.delete("/api/items/:id", auth, async (req, res) => {
  await pool.query("DELETE FROM items WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/subscribe", auth, async (req, res) => {
  const { sub, name } = req.body;
  if (!sub || !sub.endpoint || !name) return res.status(400).json({ error: "bad" });
  await pool.query(
    `INSERT INTO subs VALUES($1,$2,$3)
     ON CONFLICT (endpoint) DO UPDATE SET data=$2,name=$3`, [sub.endpoint, sub, name]);
  res.json({ ok: true });
});

init().then((k) => {
  VAPID_PUBLIC = k;
  app.listen(process.env.PORT || 3000, () => console.log("up"));
}).catch((e) => { console.error(e); process.exit(1); });
