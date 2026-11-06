'use strict';
/**
 * RideZy backend. No dependencies: only Node.js built-ins (Node 18+).
 *
 *   node server/server.js
 *
 * Serves the website and the API from one port (default 3000).
 * Data is stored in data/db.json (fine for development and small pilots;
 * move to PostgreSQL before real traffic).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

/* ---------------------------------------------------------------- config */
(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* .env is optional */ }
})();

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const RZP_ID = process.env.RAZORPAY_KEY_ID || '';
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const TWILIO = { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN, from: process.env.TWILIO_FROM };
const RADIUS_KM = Number(process.env.DISPATCH_RADIUS_KM) || 10;
const REQUIRE_APPROVAL = process.env.REQUIRE_DRIVER_APPROVAL === 'true';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const REQUEST_TIMEOUT_MS = 60000;
// Demo drivers: simulated drivers that appear near any pickup so a rider can always get a ride while testing.
// Real drivers (people signed in at /driver.html) always get a request first. Turn this off before a real launch.
const DEMO = process.env.DEMO_DRIVERS ? process.env.DEMO_DRIVERS === 'true' : !PROD;
const TIME_SCALE = Number(process.env.DEMO_TIME_SCALE) || 1;   // >1 makes demo drivers faster (used by tests)

/* ----------------------------------------------------------------- store */
const DB_FILE = path.join(ROOT, 'data', 'db.json');
let db = { users: {}, sessions: {}, rides: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { /* first run */ }
let saveTimer = null;
function saveNow() {
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const tmp = DB_FILE + '.tmp';
    const keep = { ...db, users: Object.fromEntries(Object.entries(db.users).filter(([, u]) => !u.bot)) };
    fs.writeFileSync(tmp, JSON.stringify(keep));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('Could not save data:', e.message); }
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 200); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveNow(); process.exit(0); });

for (const r of Object.values(db.rides)) {
  if (['searching', 'accepted', 'arrived', 'started'].includes(r.status) && (!r.driverId || !db.users[r.driverId])) r.status = 'cancelled';
}

const otps = new Map();       // phone -> { code, exp, tries, sentAt }
const online = new Map();     // driverId -> { lat, lng, ts }
const streams = new Map();    // userId -> Set(res)  (server-sent events)
const requestTimers = new Map();

/* --------------------------------------------------------------- helpers */
const uid = (p) => p + crypto.randomBytes(6).toString('hex');
const haversine = (a, b) => {
  const R = 6371, r = (x) => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const RATES = {
  bike: { base: 20, km: 7, min: 1 }, pool: { base: 25, km: 8, min: .8 }, auto: { base: 30, km: 12, min: 1.2 },
  mini: { base: 50, km: 14, min: 1.5 }, sedan: { base: 70, km: 18, min: 2 }, suv: { base: 100, km: 24, min: 2.5 },
  luxe: { base: 250, km: 60, min: 5 }
};
function estimate(type, km, min) {
  const r = RATES[type], h = new Date().getHours();
  const sg = (h >= 23 || h < 5) ? 1.25 : ((h >= 8 && h < 10) || (h >= 17 && h < 21)) ? 1.3 : 1;
  return ((r.base + r.km * km + r.min * min) * sg + 12) * 1.05;
}
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
function place(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = num(p.lat, -90, 90), lng = num(p.lng, -180, 180);
  if (lat === null || lng === null) return null;
  return { name: String(p.name || 'Pinned location').slice(0, 160), lat, lng };
}
const isPhone = (s) => /^[6-9]\d{9}$/.test(String(s || ''));
const ACTIVE = ['searching', 'accepted', 'arrived', 'started'];
const activeRideOf = (userId, role) => Object.values(db.rides).find((r) => (role === 'driver' ? r.driverId : r.riderId) === userId && ACTIVE.includes(r.status));

function driverPublic(u) {
  const o = online.get(u.id);
  return {
    name: u.name, rating: u.ratingCount ? (u.ratingSum / u.ratingCount).toFixed(1) : '4.8', trips: u.trips || 0,
    type: u.vehicle.type, model: u.vehicle.model, plate: u.vehicle.plate, phone: u.bot ? '' : u.phone, demo: !!u.bot,
    lat: o ? o.lat : null, lng: o ? o.lng : null
  };
}
function ridePublic(r, role) {
  const out = {
    id: r.id, status: r.status, type: r.type, pickup: r.pickup, drop: r.drop, stop: r.stop || null, km: r.km, min: r.min,
    fare: r.fare, payMethod: r.payMethod, payStatus: r.payStatus, note: r.note, riders: r.riders, createdAt: r.createdAt,
    rating: r.rating || null
  };
  const rider = db.users[r.riderId], driver = r.driverId && db.users[r.driverId];
  if (role === 'rider') {
    out.otp = r.otp;                                  // the rider reads the OTP to the driver
    if (driver) out.driver = driverPublic(driver);
  } else {
    out.rider = { name: rider ? rider.name : 'Rider', phone: ['accepted', 'arrived', 'started'].includes(r.status) && rider ? rider.phone : null };
  }
  return out;
}

/* ------------------------------------------------------------- real-time */
function emit(userId, event, data) {
  const set = streams.get(userId);
  if (!set) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}
function notifyRide(r) {
  emit(r.riderId, 'ride_update', ridePublic(r, 'rider'));
  if (r.driverId) emit(r.driverId, 'ride_update', ridePublic(r, 'driver'));
}
function candidatesFor(r) {
  return [...online.entries()]
    .filter(([id]) => db.users[id] && db.users[id].vehicle.type === r.type && !activeRideOf(id, 'driver'))
    .map(([id, o]) => ({ id, d: haversine(o, r.pickup) }))
    .filter((c) => c.d <= RADIUS_KM)
    .sort((a, b) => (db.users[a.id].bot ? 1 : 0) - (db.users[b.id].bot ? 1 : 0) || a.d - b.d)
    .slice(0, 6);
}
function requestPayload(r, d) {
  return { id: r.id, type: r.type, pickup: r.pickup, drop: r.drop, stop: r.stop || null, km: r.km, min: r.min, fare: r.fare, note: r.note, payMethod: r.payMethod, distanceToPickup: Number(d.toFixed(1)) };
}
function dispatch(r) {
  let c = candidatesFor(r);
  if (!c.length && DEMO) { for (let i = 0; i < 2; i++) spawnBot(r.type, r.pickup, 0.6, 2.5); c = candidatesFor(r); }
  if (!c.length) { r.status = 'no_drivers'; save(); notifyRide(r); return; }
  const real = c.filter((x) => !db.users[x.id].bot);
  for (const x of real) emit(x.id, 'ride_request', requestPayload(r, x.d));
  requestTimers.set(r.id, setTimeout(() => {
    requestTimers.delete(r.id);
    if (r.status === 'searching') { r.status = 'no_drivers'; save(); notifyRide(r); }
  }, REQUEST_TIMEOUT_MS));
  // demo drivers wait longer when a real driver is nearby, so the real driver gets the first chance
  if (DEMO && c.some((x) => db.users[x.id].bot)) setTimeout(() => botAccept(r), (real.length ? 9000 : 2200) / TIME_SCALE);
}
function assign(r, driver) {
  r.driverId = driver.id; r.status = 'accepted'; r.acceptedAt = Date.now();
  clearTimeout(requestTimers.get(r.id)); requestTimers.delete(r.id);
  save(); notifyRide(r);
  for (const [id] of online) if (id !== driver.id) emit(id, 'ride_taken', { id: r.id });
}

/* -------------------------------------------------------- demo drivers */
const MODELS = {
  bike: ['Honda Shine', 'TVS Apache', 'Bajaj Pulsar'], pool: ['Maruti Swift', 'Hyundai i10'], auto: ['Bajaj RE Auto', 'Piaggio Ape'],
  mini: ['Maruti Swift', 'Hyundai i10', 'Tata Tiago'], sedan: ['Honda City', 'Toyota Etios', 'Hyundai Verna'],
  suv: ['Toyota Innova', 'Maruti Ertiga'], luxe: ['Chevrolet Corvette Stingray']
};
const BOT_NAMES = ['Karthik', 'Murugan', 'Senthil', 'Ravi', 'Vignesh', 'Arjun', 'Suresh', 'Prakash', 'Dinesh', 'Manoj', 'Bala', 'Ganesh', 'Naveen', 'Ramesh', 'Kumar', 'Selvam'];
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
const rndr = (a, b) => a + Math.random() * (b - a);
function offsetPoint(p, km) {
  const a = rndr(0, Math.PI * 2);
  return { lat: p.lat + km * Math.cos(a) / 111, lng: p.lng + km * Math.sin(a) / (111 * Math.cos(p.lat * Math.PI / 180)) };
}
const botCount = () => Object.values(db.users).filter((u) => u.bot).length;
function spawnBot(type, around, minKm, maxKm) {
  const p = offsetPoint(around, rndr(minKm, maxKm)), id = uid('b_'), n = Math.floor(rndr(300, 5000));
  db.users[id] = {
    id, phone: '', name: pickOne(BOT_NAMES), role: 'driver', bot: true, approved: true, createdAt: Date.now(), trips: n,
    ratingSum: Number((rndr(4.5, 5) * n).toFixed(1)), ratingCount: n,
    vehicle: { type, model: pickOne(MODELS[type]), plate: `TN ${pickOne(['19', '22', '21', '11'])} ${String.fromCharCode(65 + crypto.randomInt(26))}${String.fromCharCode(65 + crypto.randomInt(26))} ${crypto.randomInt(1000, 10000)}` }
  };
  online.set(id, { lat: p.lat, lng: p.lng, ts: Date.now() });
  return db.users[id];
}
function botAccept(r) {
  if (r.status !== 'searching') return;
  const c = candidatesFor(r).find((x) => db.users[x.id].bot);
  if (!c) return;
  const bot = db.users[c.id];
  assign(r, bot);
  runBot(r, bot);
}
function runBot(r, bot) {
  const alive = () => db.rides[r.id] && db.rides[r.id].driverId === bot.id && !['cancelled', 'completed'].includes(r.status);
  function travel(points, ms, onDone) {
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
    const total = cum[cum.length - 1] || 0.001, t0 = Date.now(), dur = ms / TIME_SCALE;
    let idx = 0;
    const timer = setInterval(() => {
      if (!alive()) { clearInterval(timer); return; }
      const k = Math.min(1, (Date.now() - t0) / dur), d = total * k;
      while (idx < cum.length - 2 && cum[idx + 1] < d) idx++;
      const seg = (cum[idx + 1] - cum[idx]) || 0.0001, f = Math.min(1, Math.max(0, (d - cum[idx]) / seg));
      const a = points[idx], b = points[Math.min(idx + 1, points.length - 1)];
      const lat = a.lat + (b.lat - a.lat) * f, lng = a.lng + (b.lng - a.lng) * f;
      online.set(bot.id, { lat, lng, ts: Date.now() });
      emit(r.riderId, 'driver_location', { rideId: r.id, lat, lng });
      if (k >= 1) { clearInterval(timer); onDone(); }
    }, 500);
  }
  const here = online.get(bot.id), toPickup = haversine(here, r.pickup);
  travel([{ lat: here.lat, lng: here.lng }, r.pickup], Math.min(20000, Math.max(7000, toPickup * 2500)), () => {
    if (!alive()) return;
    r.status = 'arrived'; save(); notifyRide(r);
    setTimeout(() => {                                        // the demo driver "enters" the rider's OTP
      if (!alive() || r.status !== 'arrived') return;
      r.status = 'started'; r.startedAt = Date.now(); save(); notifyRide(r);
      const path = [r.pickup, ...(r.path || []).map((p) => ({ lat: p[0], lng: p[1] })), r.drop];
      travel(path, Math.min(40000, Math.max(15000, r.km * 900)), () => {
        if (!alive()) return;
        r.status = 'completed'; r.completedAt = Date.now();
        r.payStatus = r.payMethod === 'cash' ? 'paid' : 'due';
        bot.trips = (bot.trips || 0) + 1; save(); notifyRide(r);
      });
    }, 4000 / TIME_SCALE);
  });
}
// idle demo drivers drift a little so the map looks alive; old idle ones are removed
setInterval(() => {
  const bots = Object.values(db.users).filter((u) => u.bot);
  for (const u of bots) {
    const o = online.get(u.id);
    if (!o || activeRideOf(u.id, 'driver')) continue;
    const q = offsetPoint(o, rndr(0.01, 0.04));
    online.set(u.id, { lat: q.lat, lng: q.lng, ts: Date.now() });
  }
  const idle = bots.filter((u) => !activeRideOf(u.id, 'driver')).sort((a, b) => a.createdAt - b.createdAt);
  if (idle.length > 80) idle.slice(0, idle.length - 80).forEach((u) => { online.delete(u.id); delete db.users[u.id]; });
}, 2500);

const hits = new Map();
function limit(req, max) {
  const ip = req.socket.remoteAddress || 'x', now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.ts > 60000) h = { n: 0, ts: now };
  h.n++; hits.set(ip, h);
  if (h.n > max) throw fail(429, 'Too many requests. Please slow down.');
}

/* ------------------------------------------------------------------- SMS */
async function sendSms(phone, text) {
  if (TWILIO.sid && TWILIO.token && TWILIO.from) {
    const body = new URLSearchParams({ To: '+91' + phone, From: TWILIO.from, Body: text });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO.sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${TWILIO.sid}:${TWILIO.token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!r.ok) throw new Error('SMS provider error ' + r.status);
    return 'sms';
  }
  console.log(`[OTP] ${phone}: ${text}`);
  return 'console';
}

/* ---------------------------------------------------------------- routes */
const routes = [];
const R = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, auth: opts.auth !== false, role: opts.role });
const fail = (code, error) => { const e = new Error(error); e.status = code; return e; };

R('GET', '/api/health', async () => ({
  ok: true, payments: RZP_ID && RZP_SECRET ? 'razorpay' : 'demo', sms: TWILIO.sid ? 'sms' : 'console', requireApproval: REQUIRE_APPROVAL, demoDrivers: DEMO
}), { auth: false });

/* ---- auth ---- */
R('POST', '/api/auth/request-otp', async ({ req, body }) => {
  limit(req, 12);
  const phone = String(body.phone || '');
  if (!isPhone(phone)) throw fail(400, 'Enter a valid 10-digit mobile number.');
  const prev = otps.get(phone);
  if (prev && Date.now() - prev.sentAt < 30000) throw fail(429, 'Please wait 30 seconds before asking for another code.');
  const code = String(crypto.randomInt(100000, 1000000));
  otps.set(phone, { code, exp: Date.now() + 5 * 60000, tries: 0, sentAt: Date.now() });
  const via = await sendSms(phone, `Your RideZy code is ${code}. It expires in 5 minutes.`);
  const existing = Object.values(db.users).find((u) => u.phone === phone);
  return { ok: true, via, isNew: !existing, role: existing ? existing.role : null, devOtp: PROD ? undefined : code };
}, { auth: false });

R('POST', '/api/auth/verify', async ({ body }) => {
  const phone = String(body.phone || ''), code = String(body.code || '');
  const rec = otps.get(phone);
  if (!rec || rec.exp < Date.now()) throw fail(400, 'That code has expired. Ask for a new one.');
  if (++rec.tries > 5) { otps.delete(phone); throw fail(429, 'Too many attempts. Ask for a new code.'); }
  const a = Buffer.from(rec.code), b = Buffer.from(code.padEnd(rec.code.length).slice(0, rec.code.length));
  if (code.length !== rec.code.length || !crypto.timingSafeEqual(a, b)) throw fail(400, 'That code is not right.');
  otps.delete(phone);

  let user = Object.values(db.users).find((u) => u.phone === phone);
  const wantRole = body.role === 'driver' ? 'driver' : 'rider';
  if (user && user.role !== wantRole) throw fail(409, `This number is registered as a ${user.role}.`);
  if (!user) {
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) throw fail(400, 'Please enter your name to create your account.');
    user = { id: uid('u_'), phone, name, role: wantRole, createdAt: Date.now(), trips: 0, ratingSum: 0, ratingCount: 0 };
    if (wantRole === 'driver') {
      const v = body.vehicle || {};
      if (!RATES[v.type] || !String(v.model || '').trim() || !String(v.plate || '').trim()) throw fail(400, 'Add your vehicle type, model and number plate.');
      user.vehicle = { type: v.type, model: String(v.model).trim().slice(0, 40), plate: String(v.plate).trim().toUpperCase().slice(0, 16) };
      user.approved = !REQUIRE_APPROVAL;
    }
    db.users[user.id] = user;
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId: user.id, exp: Date.now() + 30 * 86400000 };
  save();
  return { token, user: userPublic(user) };
}, { auth: false });

const userPublic = (u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role, vehicle: u.vehicle || null, approved: u.approved !== false, trips: u.trips || 0 });

R('GET', '/api/me', async ({ user }) => ({ user: userPublic(user) }));
R('POST', '/api/auth/logout', async ({ token }) => { delete db.sessions[token]; save(); return { ok: true }; });

/* ---- rider: rides ---- */
R('POST', '/api/rides', async ({ user, body }) => {
  if (activeRideOf(user.id, 'rider')) throw fail(409, 'You already have a ride in progress.');
  const pickup = place(body.pickup), drop = place(body.drop), stop = body.stop ? place(body.stop) : null;
  const type = String(body.type || ''), km = num(body.km, 0.1, 500), min = num(body.min, 1, 600);
  if (!pickup || !drop || !RATES[type] || km === null || min === null) throw fail(400, 'Trip details are incomplete.');
  let path = [];
  if (Array.isArray(body.path)) {
    path = body.path.slice(0, 600).map((p) => (Array.isArray(p) && p.length === 2 ? [num(p[0], -90, 90), num(p[1], -180, 180)] : null)).filter((p) => p && p[0] !== null && p[1] !== null);
    const st = Math.ceil(path.length / 120) || 1; path = path.filter((_, i) => i % st === 0);
  }
  const payMethod = body.payMethod === 'cash' ? 'cash' : 'online';
  const est = estimate(type, km, min);
  let fare = Number(body.total);                     // promo, tip and rain are applied on the client; keep it within a sane range
  if (!Number.isFinite(fare) || fare < est * .55 || fare > est * 1.7) fare = est;
  const r = {
    id: uid('r_'), riderId: user.id, driverId: null, status: 'searching', type, pickup, drop, stop, km, min,
    fare: Math.round(fare), payMethod, payStatus: 'pending', note: String(body.note || '').slice(0, 200),
    path, riders: num(body.riders, 1, 6) || 1, otp: String(crypto.randomInt(1000, 10000)), createdAt: Date.now()
  };
  db.rides[r.id] = r; save();
  dispatch(r);
  return { ride: ridePublic(r, 'rider') };
}, { role: 'rider' });

R('GET', '/api/rides/active', async ({ user }) => {
  const r = activeRideOf(user.id, user.role);
  if (r) return { ride: ridePublic(r, user.role) };
  // a finished ride that still needs payment or a rating
  const last = Object.values(db.rides).filter((x) => x.riderId === user.id && x.status === 'completed' && (x.payStatus !== 'paid' || !x.rating))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return { ride: user.role === 'rider' && last ? ridePublic(last, 'rider') : null };
});

R('GET', '/api/rides/mine', async ({ user }) => ({
  rides: Object.values(db.rides).filter((r) => (user.role === 'driver' ? r.driverId : r.riderId) === user.id)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map((r) => ridePublic(r, user.role))
}));

R('POST', '/api/rides/:id/accept', async ({ user, params }) => {
  const r = db.rides[params.id];
  if (!r) throw fail(404, 'Ride not found.');
  if (!online.has(user.id)) throw fail(409, 'Go online first.');
  if (activeRideOf(user.id, 'driver')) throw fail(409, 'Finish your current ride first.');
  if (r.status !== 'searching') throw fail(409, 'This ride is no longer available.');
  if (user.vehicle.type !== r.type) throw fail(409, 'This ride needs a different vehicle type.');
  assign(r, user);
  return { ride: ridePublic(r, 'driver') };
}, { role: 'driver' });

R('POST', '/api/rides/:id/status', async ({ user, params, body }) => {
  const r = db.rides[params.id];
  if (!r) throw fail(404, 'Ride not found.');
  const next = String(body.status || '');
  if (user.role === 'rider') {
    if (r.riderId !== user.id) throw fail(403, 'Not your ride.');
    if (next !== 'cancelled' || !['searching', 'accepted', 'arrived'].includes(r.status)) throw fail(409, 'You cannot do that now.');
    r.status = 'cancelled';
  } else {
    if (r.driverId !== user.id) throw fail(403, 'Not your ride.');
    if (next === 'arrived' && r.status === 'accepted') r.status = 'arrived';
    else if (next === 'started' && r.status === 'arrived') {
      if (String(body.otp || '') !== r.otp) throw fail(400, 'That OTP is not right. Ask the rider for the 4-digit code.');
      r.status = 'started'; r.startedAt = Date.now();
    } else if (next === 'completed' && r.status === 'started') {
      r.status = 'completed'; r.completedAt = Date.now();
      r.payStatus = r.payMethod === 'cash' ? 'paid' : 'due';
      user.trips = (user.trips || 0) + 1;
    } else if (next === 'cancelled' && ['accepted', 'arrived'].includes(r.status)) r.status = 'cancelled';
    else throw fail(409, 'You cannot do that now.');
  }
  clearTimeout(requestTimers.get(r.id)); requestTimers.delete(r.id);
  save(); notifyRide(r);
  return { ride: ridePublic(r, user.role) };
});

R('POST', '/api/rides/:id/rate', async ({ user, params, body }) => {
  const r = db.rides[params.id];
  if (!r || r.riderId !== user.id || r.status !== 'completed') throw fail(404, 'Ride not found.');
  const stars = num(body.stars, 1, 5);
  if (stars === null) throw fail(400, 'Choose 1 to 5 stars.');
  if (r.rating) throw fail(409, 'You already rated this ride.');
  r.rating = Math.round(stars);
  const d = db.users[r.driverId];
  if (d) { d.ratingSum = (d.ratingSum || 0) + r.rating; d.ratingCount = (d.ratingCount || 0) + 1; }
  save();
  return { ok: true };
}, { role: 'rider' });

/* ---- nearby drivers (anonymous: only type and position) ---- */
const pubId = (id) => crypto.createHash('sha1').update(id).digest('hex').slice(0, 10);
R('GET', '/api/nearby', async ({ req, u }) => {
  limit(req, 90);
  const lat = num(u.searchParams.get('lat'), -90, 90), lng = num(u.searchParams.get('lng'), -180, 180);
  if (lat === null || lng === null) throw fail(400, 'lat and lng are required.');
  const c = { lat, lng };
  if (DEMO) {                                           // make sure a few demo drivers of every type are around
    let spawned = 0;
    for (const type of Object.keys(RATES)) {
      const have = [...online.entries()].filter(([id, o]) => db.users[id] && db.users[id].vehicle.type === type && haversine(o, c) <= 4).length;
      for (let i = have; i < 2 && spawned < 14 && botCount() < 90; i++) { spawnBot(type, c, 0.5, 3.2); spawned++; }
    }
  }
  const drivers = [...online.entries()]
    .filter(([id, o]) => db.users[id] && haversine(o, c) <= 6 && !activeRideOf(id, 'driver'))
    .map(([id, o]) => ({ id: pubId(id), type: db.users[id].vehicle.type, lat: o.lat, lng: o.lng, demo: !!db.users[id].bot }));
  return { demo: DEMO, drivers };
}, { auth: false });

/* ---- driver ---- */
R('POST', '/api/driver/online', async ({ user, body }) => {
  if (user.approved === false) throw fail(403, 'Your account is waiting for approval.');
  if (!body.online) { online.delete(user.id); return { online: false }; }
  const lat = num(body.lat, -90, 90), lng = num(body.lng, -180, 180);
  if (lat === null || lng === null) throw fail(400, 'We need your location to go online.');
  online.set(user.id, { lat, lng, ts: Date.now() });
  // send rides that are already waiting nearby
  for (const r of Object.values(db.rides)) {
    if (r.status === 'searching' && r.type === user.vehicle.type) {
      const d = haversine({ lat, lng }, r.pickup);
      if (d <= RADIUS_KM) emit(user.id, 'ride_request', requestPayload(r, d));
    }
  }
  return { online: true };
}, { role: 'driver' });

R('POST', '/api/driver/location', async ({ user, body }) => {
  const lat = num(body.lat, -90, 90), lng = num(body.lng, -180, 180);
  if (lat === null || lng === null) throw fail(400, 'Bad location.');
  if (online.has(user.id)) online.set(user.id, { lat, lng, ts: Date.now() });
  const r = activeRideOf(user.id, 'driver');
  if (r) emit(r.riderId, 'driver_location', { rideId: r.id, lat, lng });
  return { ok: true };
}, { role: 'driver' });

/* ---- payments (Razorpay; falls back to a demo mode without keys) ---- */
R('POST', '/api/payments/order', async ({ user, body }) => {
  const r = db.rides[body.rideId];
  if (!r || r.riderId !== user.id || r.status !== 'completed') throw fail(404, 'Ride not found.');
  if (r.payStatus === 'paid') throw fail(409, 'This ride is already paid.');
  if (!RZP_ID || !RZP_SECRET) return { demo: true, amount: r.fare * 100 };
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${RZP_ID}:${RZP_SECRET}`).toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: r.fare * 100, currency: 'INR', receipt: r.id, notes: { rideId: r.id } })
  });
  const j = await res.json();
  if (!res.ok) { console.error('Razorpay error:', j); throw fail(502, 'Payment provider error. Try again.'); }
  r.orderId = j.id; save();
  return { demo: false, orderId: j.id, amount: j.amount, keyId: RZP_ID };
}, { role: 'rider' });

R('POST', '/api/payments/verify', async ({ user, body }) => {
  const r = db.rides[body.rideId];
  if (!r || r.riderId !== user.id || r.status !== 'completed') throw fail(404, 'Ride not found.');
  if (r.payStatus === 'paid') return { ok: true };
  if (!RZP_ID || !RZP_SECRET) {
    if (!body.demo) throw fail(400, 'Payments are in demo mode.');
    r.payStatus = 'paid'; r.paidAt = Date.now(); save(); notifyRide(r); return { ok: true, demo: true };
  }
  const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = body;
  if (!oid || !pid || !sig || oid !== r.orderId) throw fail(400, 'Payment details are missing.');
  const expected = crypto.createHmac('sha256', RZP_SECRET).update(`${oid}|${pid}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(sig));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail(400, 'Payment could not be verified.');
  r.payStatus = 'paid'; r.paymentId = pid; r.paidAt = Date.now(); save(); notifyRide(r);
  return { ok: true };
}, { role: 'rider' });

/* ---- live stream ---- */
R('GET', '/api/events', async ({ req, res, user }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  if (!streams.has(user.id)) streams.set(user.id, new Set());
  streams.get(user.id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    const set = streams.get(user.id);
    if (set) { set.delete(res); if (!set.size) { streams.delete(user.id); online.delete(user.id); } }   // a driver with no open stream goes offline
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  return null;
});

/* ------------------------------------------------------------ http layer */
function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (local || (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
}
const send = (res, code, obj) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
  res.end(s);
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100000) { reject(fail(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(fail(400, 'Bad JSON.')); } });
    req.on('error', reject);
  });
}
function authenticate(req, u) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : u.searchParams.get('token');
  const s = token && db.sessions[token];
  if (!s || s.exp < Date.now()) return null;
  const user = db.users[s.userId];
  return user ? { user, token } : null;
}
async function api(req, res, u) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = u.pathname.match(r.re);
    if (!m) continue;
    let user = null, token = null;
    if (r.auth) {
      const a = authenticate(req, u);
      if (!a) return send(res, 401, { error: 'Please sign in.' });
      user = a.user; token = a.token;
      if (r.role && user.role !== r.role) return send(res, 403, { error: `This is only for ${r.role}s.` });
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    const out = await r.handler({ req, res, u, body, user, token, params: m.groups || {} });
    if (out !== null) send(res, 200, out);
    return;
  }
  send(res, 404, { error: 'Not found.' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const allowed = rel === '/index.html' || rel === '/driver.html' || rel.startsWith('/images/');
  const file = path.normalize(path.join(ROOT, rel));
  if (!allowed || !file.startsWith(ROOT + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': rel.startsWith('/images/') ? 'public, max-age=3600' : 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) await api(req, res, u);
    else serveStatic(req, res, u.pathname);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on our side.' });
    else res.end();
  }
});
server.listen(PORT, () => {
  console.log(`\n  RideZy is running:   http://localhost:${PORT}`);
  console.log(`  Driver app:          http://localhost:${PORT}/driver.html`);
  console.log(`  Payments:            ${RZP_ID && RZP_SECRET ? 'Razorpay' : 'demo mode (add Razorpay keys in .env)'}`);
  console.log(`  Demo drivers:        ${DEMO ? 'on (simulated drivers appear near any pickup)' : 'off'}`);
  console.log(`  OTP delivery:        ${TWILIO.sid ? 'SMS (Twilio)' : 'printed in this console (add Twilio keys in .env for real SMS)'}\n`);
});
