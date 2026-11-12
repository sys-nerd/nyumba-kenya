// Nyumba Kenya server. No npm packages needed: Node 22.13+ only.
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch { console.error("Node.js 22.13 or newer is required. Your version is " + process.version + "."); process.exit(1); }
const PORT = process.env.PORT || 3000;
const SECURE = process.env.SECURE_COOKIES === "1";      // set to 1 when served over https
const ADMIN_PHONE = process.env.ADMIN_PHONE || "";      // this account can remove any listing
const COUNTIES = ["Baringo","Bomet","Bungoma","Busia","Elgeyo-Marakwet","Embu","Garissa","Homa Bay","Isiolo","Kajiado","Kakamega","Kericho","Kiambu","Kilifi","Kirinyaga","Kisii","Kisumu","Kitui","Kwale","Laikipia","Lamu","Machakos","Makueni","Mandera","Marsabit","Meru","Migori","Mombasa","Murang'a","Nairobi","Nakuru","Nandi","Narok","Nyamira","Nyandarua","Nyeri","Samburu","Siaya","Taita-Taveta","Tana River","Tharaka-Nithi","Trans-Nzoia","Turkana","Uasin Gishu","Vihiga","Wajir","West Pokot"];
const TYPES = ["Single room","Bedsitter","1 Bedroom","2 Bedroom","3 Bedroom","Apartment","Maisonette","Bungalow"];
const ROLES = ["hunter","caretaker","landlord","agent"];

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, "nyumba.db"));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT,phone TEXT UNIQUE,role TEXT,salt TEXT,hash TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER,expires INTEGER);
CREATE TABLE IF NOT EXISTS houses(id INTEGER PRIMARY KEY,user_id INTEGER,title TEXT,county TEXT,area TEXT,type TEXT,rent INTEGER,tags TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS wanted(id INTEGER PRIMARY KEY,user_id INTEGER,county TEXT,area TEXT,type TEXT,budget INTEGER,note TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS enquiries(id INTEGER PRIMARY KEY,house_id INTEGER,user_id INTEGER,when_text TEXT,message TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY,house_id INTEGER,data BLOB,created INTEGER);`);
const clean = () => db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
clean(); setInterval(clean, 36e5).unref();

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const txt = (v, min, max, msg) => { v = String(v ?? "").trim(); if (v.length < min || v.length > max) fail(400, msg); return v; };
const num = (v, min, max, msg) => { v = Math.round(Number(v)); if (!(v >= min && v <= max)) fail(400, msg); return v; };
const pick = (v, list, msg) => { if (!list.includes(v)) fail(400, msg); return v; };
const phoneOf = p => { p = String(p || "").replace(/[^0-9+]/g, "").replace(/^[+]?254/, "0"); return /^0[17][0-9]{8}$/.test(p) ? p : null; };
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");

function readBody(req) {
  return new Promise((ok, no) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 20000) { no(Object.assign(new Error("Request too large."), { status: 413 })); req.destroy(); } });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(Object.assign(new Error("Invalid request."), { status: 400 })); } });
  });
}
function readRaw(req, max) {
  return new Promise((ok, no) => {
    const parts = []; let n = 0;
    req.on("data", c => { n += c.length; if (n <= max) parts.push(c); });   // keep reading so we can answer properly
    req.on("end", () => n > max ? no(Object.assign(new Error("That photo is too large."), { status: 413 })) : ok(Buffer.concat(parts)));
  });
}
const cookies = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(a => a[0]).map(a => [a[0], a.slice(1).join("=")]));
const who = req => {
  const t = cookies(req).sid; if (!t) return null;
  return db.prepare("SELECT u.id,u.name,u.phone,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?").get(t, Date.now()) || null;
};
const hits = new Map();
function limit(req) {
  const ip = process.env.TRUST_PROXY === "1" ? ((req.headers["x-forwarded-for"] || "").split(",").pop().trim() || req.socket.remoteAddress) : req.socket.remoteAddress;
  const now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 9e5) { h.n = 0; h.t = now; }
  h.n++; hits.set(ip, h);
  if (h.n > 20) fail(429, "Too many attempts. Wait 15 minutes and try again.");
}
const secure = req => SECURE || req.headers["x-forwarded-proto"] === "https";   // https is detected automatically behind a proxy
function startSession(req, res, uid) {
  const t = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(t, uid, Date.now() + 30 * 864e5);
  res.setHeader("Set-Cookie", `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure(req) ? "; Secure" : ""}`);
}
function photosFor(ids) {
  const out = {}; if (!ids.length) return out;
  for (const p of db.prepare("SELECT id,house_id FROM photos WHERE house_id IN (" + ids.map(() => "?").join(",") + ") ORDER BY id").all(...ids)) (out[p.house_id] ||= []).push(p.id);
  return out;
}
const isAdmin = u => u && ADMIN_PHONE && u.phone === ADMIN_PHONE;
const needUser = u => u || fail(401, "Sign in first.");

async function route(req, res, url) {
  const m = req.method, p = url.pathname, u = who(req), q = url.searchParams;
  const f = { county: q.get("county") || "", type: q.get("type") || "", max: Number(q.get("max")) || 0, q: (q.get("q") || "").slice(0, 50) };
  let r;
  if (m === "GET" && p === "/api/meta") return json(res, 200, { counties: COUNTIES, types: TYPES, user: u });

  if (m === "POST" && p === "/api/signup") {
    limit(req); const b = await readBody(req);
    const name = txt(b.name, 2, 40, "Enter your name."), phone = phoneOf(b.phone) || fail(400, "Enter a valid Kenyan number, like 0712 345 678.");
    const role = pick(b.role, ROLES, "Choose who you are."), pw = String(b.password || "");
    if (pw.length < 6 || pw.length > 100) fail(400, "Use a password with at least 6 characters.");
    const salt = crypto.randomBytes(16).toString("hex");
    try { r = db.prepare("INSERT INTO users(name,phone,role,salt,hash,created) VALUES(?,?,?,?,?,?)").run(name, phone, role, salt, hashPw(pw, salt), Date.now()); }
    catch { fail(409, "This number already has an account. Sign in instead."); }
    startSession(req, res, Number(r.lastInsertRowid));
    return json(res, 200, { user: { id: Number(r.lastInsertRowid), name, phone, role } });
  }
  if (m === "POST" && p === "/api/login") {
    limit(req); const b = await readBody(req);
    const row = db.prepare("SELECT * FROM users WHERE phone=?").get(phoneOf(b.phone) || "");
    const bad = () => fail(401, "Wrong phone number or password.");
    if (!row) bad();
    const a = Buffer.from(hashPw(String(b.password || ""), row.salt), "hex"), c = Buffer.from(row.hash, "hex");
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) bad();
    startSession(req, res, row.id);
    return json(res, 200, { user: { id: row.id, name: row.name, phone: row.phone, role: row.role } });
  }
  if (m === "POST" && p === "/api/logout") {
    const t = cookies(req).sid; if (t) db.prepare("DELETE FROM sessions WHERE token=?").run(t);
    res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return json(res, 200, { ok: true });
  }

  if (m === "GET" && p === "/api/houses") {
    const rows = db.prepare(`SELECT h.id,h.title,h.county,h.area,h.type,h.rent,h.tags,h.user_id,u.name,u.phone,u.role FROM houses h JOIN users u ON u.id=h.user_id
      WHERE (?='' OR h.county=?) AND (?='' OR h.type=?) AND (?=0 OR h.rent<=?) AND (?='' OR h.area LIKE '%'||?||'%' OR h.title LIKE '%'||?||'%') ORDER BY h.rent LIMIT 300`)
      .all(f.county, f.county, f.type, f.type, f.max, f.max, f.q, f.q, f.q);
    const ph = photosFor(rows.map(h => h.id));
    return json(res, 200, { houses: rows.map(h => ({ photos: ph[h.id] || [], id: h.id, title: h.title, county: h.county, area: h.area, type: h.type, rent: h.rent, tags: JSON.parse(h.tags || "[]"), role: h.role,
      name: u ? h.name : null, phone: u ? h.phone : null, mine: !!u && (h.user_id === u.id || isAdmin(u)) })) });
  }
  if (m === "POST" && p === "/api/houses") {
    needUser(u); if (u.role === "hunter") fail(403, "Only caretakers, landlords and agents can post houses.");
    if (db.prepare("SELECT COUNT(*) c FROM houses WHERE user_id=?").get(u.id).c >= 50) fail(400, "You can post up to 50 houses.");
    const b = await readBody(req);
    const tags = String(b.tags || "").split(",").map(s => s.trim().slice(0, 30)).filter(Boolean).slice(0, 6);
    const ins = db.prepare("INSERT INTO houses(user_id,title,county,area,type,rent,tags,created) VALUES(?,?,?,?,?,?,?,?)").run(u.id,
      txt(b.title, 3, 60, "Enter a title for the house."), pick(b.county, COUNTIES, "Choose a county."), txt(b.area, 2, 50, "Enter the area or estate."),
      pick(b.type, TYPES, "Choose the house type."), num(b.rent, 500, 1000000, "Enter the monthly rent in KES."), JSON.stringify(tags), Date.now());
    return json(res, 200, { ok: true, id: Number(ins.lastInsertRowid) });
  }
  let mm;
  if (m === "DELETE" && (mm = p.match(/^\/api\/houses\/(\d+)$/))) {
    needUser(u); const h = db.prepare("SELECT user_id FROM houses WHERE id=?").get(+mm[1]);
    if (!h || (h.user_id !== u.id && !isAdmin(u))) fail(404, "House not found.");
    db.prepare("DELETE FROM photos WHERE house_id=?").run(+mm[1]); db.prepare("DELETE FROM enquiries WHERE house_id=?").run(+mm[1]); db.prepare("DELETE FROM houses WHERE id=?").run(+mm[1]);
    return json(res, 200, { ok: true });
  }
  if (m === "POST" && (mm = p.match(/^\/api\/houses\/(\d+)\/enquiries$/))) {
    needUser(u); const h = db.prepare("SELECT user_id FROM houses WHERE id=?").get(+mm[1]);
    if (!h) fail(404, "House not found."); if (h.user_id === u.id) fail(400, "This is your own house.");
    const b = await readBody(req);
    db.prepare("INSERT INTO enquiries(house_id,user_id,when_text,message,created) VALUES(?,?,?,?,?)").run(+mm[1], u.id, txt(b.when, 1, 30, "Choose when you can view."), String(b.message || "").trim().slice(0, 200), Date.now());
    return json(res, 200, { ok: true });
  }

  if (m === "POST" && (mm = p.match(/^\/api\/houses\/(\d+)\/photos$/))) {
    needUser(u); const h = db.prepare("SELECT user_id FROM houses WHERE id=?").get(+mm[1]);
    if (!h || h.user_id !== u.id) fail(404, "House not found.");
    if (db.prepare("SELECT COUNT(*) c FROM photos WHERE house_id=?").get(+mm[1]).c >= 4) fail(400, "A house can have up to 4 photos.");
    if (!(req.headers["content-type"] || "").startsWith("image/jpeg")) fail(400, "Photos must be JPEG images.");
    const buf = await readRaw(req, 400000);
    if (buf.length < 100 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) fail(400, "That file is not a valid photo.");
    const pr = db.prepare("INSERT INTO photos(house_id,data,created) VALUES(?,?,?)").run(+mm[1], buf, Date.now());
    return json(res, 200, { ok: true, id: Number(pr.lastInsertRowid) });
  }

  if (m === "GET" && p === "/api/wanted") {
    const rows = db.prepare(`SELECT w.id,w.county,w.area,w.type,w.budget,w.note,w.user_id,u.name,u.phone FROM wanted w JOIN users u ON u.id=w.user_id
      WHERE (?='' OR w.county=?) AND (?='' OR w.type=?) AND (?='' OR w.area LIKE '%'||?||'%') ORDER BY w.created DESC LIMIT 300`).all(f.county, f.county, f.type, f.type, f.q, f.q);
    return json(res, 200, { wanted: rows.map(w => ({ id: w.id, county: w.county, area: w.area, type: w.type, budget: w.budget, note: w.note, name: u ? w.name : null, phone: u ? w.phone : null, mine: !!u && (w.user_id === u.id || isAdmin(u)) })) });
  }
  if (m === "POST" && p === "/api/wanted") {
    needUser(u); const b = await readBody(req);
    db.prepare("INSERT INTO wanted(user_id,county,area,type,budget,note,created) VALUES(?,?,?,?,?,?,?)").run(u.id, pick(b.county, COUNTIES, "Choose a county."),
      txt(b.area, 2, 50, "Enter your preferred area or estate."), pick(b.type, TYPES, "Choose the house type."), num(b.budget, 500, 1000000, "Enter the most you can pay per month in KES."), String(b.note || "").trim().slice(0, 120), Date.now());
    return json(res, 200, { ok: true });
  }
  if (m === "DELETE" && (mm = p.match(/^\/api\/wanted\/(\d+)$/))) {
    needUser(u); const w = db.prepare("SELECT user_id FROM wanted WHERE id=?").get(+mm[1]);
    if (!w || (w.user_id !== u.id && !isAdmin(u))) fail(404, "Request not found.");
    db.prepare("DELETE FROM wanted WHERE id=?").run(+mm[1]); return json(res, 200, { ok: true });
  }
  if (m === "GET" && p === "/api/my") {
    needUser(u);
    const enquiries = db.prepare(`SELECT e.id,e.when_text AS "when",e.message,h.title,x.name,x.phone FROM enquiries e JOIN houses h ON h.id=e.house_id JOIN users x ON x.id=e.user_id WHERE h.user_id=? ORDER BY e.created DESC LIMIT 200`).all(u.id);
    const mine = db.prepare("SELECT id,title,county,area,type,rent,tags FROM houses WHERE user_id=? ORDER BY created DESC").all(u.id), ph = photosFor(mine.map(h => h.id));
    const houses = mine.map(h => ({ photos: ph[h.id] || [], ...h, tags: JSON.parse(h.tags || "[]"), role: u.role, name: u.name, phone: u.phone, mine: true }));
    const wanted = db.prepare("SELECT id,county,area,type,budget,note FROM wanted WHERE user_id=? ORDER BY created DESC").all(u.id).map(w => ({ ...w, name: u.name, phone: u.phone, mine: true }));
    return json(res, 200, { enquiries, houses, wanted });
  }
  fail(404, "Not found.");
}

const page = () => fs.readFileSync(path.join(__dirname, "public", "index.html"));
http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  const url = new URL(req.url, "http://x");
  try {
    const pm = req.method === "GET" && url.pathname.match(/^\/photo\/(\d+)$/);
    if (pm) {
      const row = db.prepare("SELECT data FROM photos WHERE id=?").get(+pm[1]);
      if (!row) fail(404, "Not found.");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
      return res.end(Buffer.from(row.data));
    }
    if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
    if (url.pathname.startsWith("/api/")) return await route(req, res, url);
    if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page()); }
    fail(404, "Not found.");
  } catch (e) {
    if (!e.status) console.error(e);
    if (res.headersSent) return res.end();
    json(res, e.status || 500, { error: e.status ? e.message : "Something went wrong. Try again." });
  }
}).listen(PORT, () => console.log("Nyumba Kenya running on http://localhost:" + PORT));
