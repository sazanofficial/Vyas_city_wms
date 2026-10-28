const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const db = require('./db');

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32 || secret === 'replace-with-a-long-random-secret') {
  console.error('Set JWT_SECRET to a random string of at least 32 characters.');
  process.exit(1);
}
const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], connectSrc: ["'self'", 'ws:', 'wss:'], imgSrc: ["'self'", 'data:'], scriptSrc: ["'self'"], styleSrc: ["'self'"], objectSrc: ["'none'"] } } }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Map();
const now = () => new Date().toISOString();
const hashKey = value => crypto.createHash('sha256').update(value).digest('hex');
const bad = (res, code, error) => res.status(code).json({ error });
const int = value => Number.isInteger(Number(value)) ? Number(value) : NaN;
const clean = value => typeof value === 'string' ? value.trim() : '';

function tokenFrom(req) {
  const match = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
  return match?.[1];
}
function auth(req, res, next) {
  try {
    const payload = jwt.verify(tokenFrom(req), secret, { algorithms: ['HS256'] });
    const user = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(payload.sub);
    if (!user) return bad(res, 401, 'Invalid account');
    req.user = user;
    next();
  } catch { return bad(res, 401, 'Authentication required'); }
}
const manager = (req, res, next) => req.user.role === 'manager' ? next() : bad(res, 403, 'Manager access required');
const send = (type, data, audience = 'manager') => {
  const message = JSON.stringify({ type, data });
  for (const [ws, user] of wsClients) {
    if (ws.readyState === ws.OPEN && (user.role === 'manager' || audience === 'all' || user.id === audience)) ws.send(message);
  }
};
function binView(bin) {
  const reading = db.prepare('SELECT fill_percent,recorded_at FROM readings WHERE bin_id=? ORDER BY recorded_at DESC,id DESC LIMIT 1').get(bin.id);
  const last = reading?.recorded_at || null;
  const offline = !last || Date.now() - Date.parse(last) > 30000;
  const awaitingReading = !!(bin.emptied_at && last && Date.parse(bin.emptied_at) >= Date.parse(last));
  const fill = reading?.fill_percent ?? null;
  const status = offline ? 'offline' : awaitingReading ? 'emptied' : fill > bin.threshold ? 'full' : fill >= 50 ? 'filling' : 'normal';
  return { id: bin.id, name: bin.name, location: bin.location, height_cm: bin.height_cm, threshold: bin.threshold,
    fill_percent: fill, last_update: last, status, emptied_at: bin.emptied_at, awaiting_reading: awaitingReading };
}
function allBins() { return db.prepare('SELECT * FROM bins ORDER BY id').all().map(binView); }
function publishBins() {
  const bins = allBins();
  send('bins', bins);
  send('alerts', bins.filter(b => b.status === 'full' || b.status === 'offline'));
}

app.post('/api/login', (req, res) => {
  const username = clean(req.body?.username);
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || typeof req.body?.password !== 'string' || !bcrypt.compareSync(req.body.password, user.password_hash))
    return bad(res, 401, 'Invalid username or password');
  const token = jwt.sign({ sub: String(user.id) }, secret, { algorithm: 'HS256', expiresIn: '8h' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});
app.get('/api/me', auth, (req, res) => res.json(req.user));

// Devices authenticate with a per-bin key. Never trust the bin ID by itself.
app.post('/api/data', (req, res) => {
  const id = clean(req.body?.bin_id);
  const fill = int(req.body?.fill_percent);
  const key = req.headers['x-sensor-key'];
  const bin = db.prepare('SELECT * FROM bins WHERE id=?').get(id);
  if (!bin) return bad(res, 404, 'Unknown bin ID');
  if (typeof key !== 'string' || !/^[a-f0-9]{48}$/.test(key) ||
      !crypto.timingSafeEqual(Buffer.from(hashKey(key)), Buffer.from(bin.sensor_key_hash)))
    return bad(res, 401, 'Invalid sensor key');
  if (!Number.isInteger(fill) || fill < 0 || fill > 100) return bad(res, 400, 'fill_percent must be an integer from 0 to 100');
  const recorded_at = now();
  db.prepare('INSERT INTO readings (bin_id,fill_percent,recorded_at) VALUES (?,?,?)').run(id, fill, recorded_at);
  const view = binView(bin);
  send('reading', view);
  publishBins();
  res.status(201).json({ bin_id: id, fill_percent: fill, recorded_at, status: view.status });
});

app.get('/api/bins', auth, manager, (req, res) => res.json(allBins()));
app.get('/api/bins/:id', auth, manager, (req, res) => {
  const bin = db.prepare('SELECT * FROM bins WHERE id=?').get(req.params.id);
  return bin ? res.json(binView(bin)) : bad(res, 404, 'Bin not found');
});
app.get('/api/bins/:id/readings', auth, manager, (req, res) => {
  if (!db.prepare('SELECT id FROM bins WHERE id=?').get(req.params.id)) return bad(res, 404, 'Bin not found');
  const limit = Math.min(Math.max(int(req.query.limit) || 100, 1), 500);
  res.json(db.prepare('SELECT id,fill_percent,recorded_at FROM readings WHERE bin_id=? ORDER BY recorded_at DESC,id DESC LIMIT ?').all(req.params.id, limit));
});
app.post('/api/bins', auth, manager, (req, res) => {
  const id = clean(req.body?.id), name = clean(req.body?.name), location = clean(req.body?.location);
  const height = Number(req.body?.height_cm), threshold = int(req.body?.threshold ?? 80);
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !name || name.length > 80 || !location || location.length > 160 ||
      !Number.isFinite(height) || height <= 0 || height > 1000 || threshold < 1 || threshold > 100)
    return bad(res, 400, 'Invalid bin details');
  if (db.prepare('SELECT id FROM bins WHERE id=?').get(id)) return bad(res, 409, 'Bin ID already exists');
  const sensor_key = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO bins (id,name,location,height_cm,threshold,sensor_key_hash) VALUES (?,?,?,?,?,?)')
    .run(id, name, location, height, threshold, hashKey(sensor_key));
  publishBins();
  res.status(201).json({ ...binView(db.prepare('SELECT * FROM bins WHERE id=?').get(id)), sensor_key });
});
app.patch('/api/bins/:id', auth, manager, (req, res) => {
  const bin = db.prepare('SELECT * FROM bins WHERE id=?').get(req.params.id);
  if (!bin) return bad(res, 404, 'Bin not found');
  const name = req.body.name === undefined ? bin.name : clean(req.body.name);
  const location = req.body.location === undefined ? bin.location : clean(req.body.location);
  const height = req.body.height_cm === undefined ? bin.height_cm : Number(req.body.height_cm);
  const threshold = req.body.threshold === undefined ? bin.threshold : int(req.body.threshold);
  if (!name || name.length > 80 || !location || location.length > 160 || !Number.isFinite(height) || height <= 0 || height > 1000 || threshold < 1 || threshold > 100)
    return bad(res, 400, 'Invalid bin details');
  db.prepare('UPDATE bins SET name=?,location=?,height_cm=?,threshold=? WHERE id=?').run(name, location, height, threshold, bin.id);
  publishBins();
  res.json(binView(db.prepare('SELECT * FROM bins WHERE id=?').get(bin.id)));
});
app.delete('/api/bins/:id', auth, manager, (req, res) => {
  if (!db.prepare('SELECT id FROM bins WHERE id=?').get(req.params.id)) return bad(res, 404, 'Bin not found');
  db.prepare('DELETE FROM bins WHERE id=?').run(req.params.id);
  publishBins();
  res.status(204).end();
});

app.get('/api/users', auth, manager, (req, res) => res.json(db.prepare('SELECT id,username,role,created_at FROM users ORDER BY id').all()));
app.post('/api/users', auth, manager, (req, res) => {
  const username = clean(req.body?.username), password = req.body?.password;
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || typeof password !== 'string' || password.length < 12 || password.length > 128)
    return bad(res, 400, 'Username must be 3-40 characters and password 12-128 characters');
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) return bad(res, 409, 'Username already exists');
  const result = db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)').run(username, bcrypt.hashSync(password, 12), 'staff');
  res.status(201).json(db.prepare('SELECT id,username,role,created_at FROM users WHERE id=?').get(result.lastInsertRowid));
});
app.delete('/api/users/:id', auth, manager, (req, res) => {
  const user = db.prepare('SELECT id,role FROM users WHERE id=?').get(req.params.id);
  if (!user) return bad(res, 404, 'User not found');
  if (user.role !== 'staff') return bad(res, 400, 'Only staff accounts can be removed');
  db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  send('tasks', { removed_staff_id: user.id });
  res.status(204).end();
});

const taskSql = `SELECT t.*,b.name AS bin_name,b.location,b.threshold,u.username AS staff_name,
  (SELECT r.fill_percent FROM readings r WHERE r.bin_id=t.bin_id ORDER BY r.recorded_at DESC,r.id DESC LIMIT 1) AS fill_percent
  FROM collection_tasks t JOIN bins b ON b.id=t.bin_id JOIN users u ON u.id=t.staff_id`;
const taskById = id => db.prepare(`${taskSql} WHERE t.id=?`).get(id);
app.get('/api/tasks', auth, (req, res) => {
  const where = req.user.role === 'manager' ? '' : ' WHERE t.staff_id=?';
  const args = req.user.role === 'manager' ? [] : [req.user.id];
  res.json(db.prepare(`${taskSql}${where} ORDER BY CASE t.status WHEN 'completed' THEN 1 ELSE 0 END, t.priority DESC,t.created_at DESC`).all(...args));
});
app.post('/api/tasks', auth, manager, (req, res) => {
  const bin_id = clean(req.body?.bin_id), staff_id = int(req.body?.staff_id);
  const priority = int(req.body?.priority ?? 2), note = clean(req.body?.note);
  if (!db.prepare('SELECT id FROM bins WHERE id=?').get(bin_id) ||
      !db.prepare("SELECT id FROM users WHERE id=? AND role='staff'").get(staff_id) ||
      priority < 1 || priority > 3 || note.length > 500) return bad(res, 400, 'Invalid task details');
  const result = db.prepare('INSERT INTO collection_tasks (bin_id,staff_id,priority,note) VALUES (?,?,?,?)').run(bin_id, staff_id, priority, note);
  const task = taskById(result.lastInsertRowid);
  send('task', task, staff_id);
  res.status(201).json(task);
});
app.patch('/api/tasks/:id', auth, (req, res) => {
  const task = taskById(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (req.user.role === 'staff' && task.staff_id !== req.user.id) return bad(res, 403, 'Not your task');
  const status = req.body?.status;
  if (!['pending', 'in_progress', 'completed'].includes(status)) return bad(res, 400, 'Invalid status');
  if (req.user.role === 'staff' && !((task.status === 'pending' && status === 'in_progress') ||
      (task.status === 'in_progress' && status === 'completed'))) return bad(res, 400, 'Start a pending task, then complete it');
  if (task.status === 'completed' && req.user.role === 'staff') return bad(res, 400, 'Completed task is final');
  const timestamp = now();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE collection_tasks SET status=?,started_at=?,completed_at=? WHERE id=?').run(status,
      status === 'pending' ? null : (task.started_at || timestamp), status === 'completed' ? timestamp : null, task.id);
    if (status === 'completed') db.prepare('UPDATE bins SET emptied_at=? WHERE id=?').run(timestamp, task.bin_id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const updated = taskById(task.id);
  send('task', updated, task.staff_id);
  publishBins();
  res.json(updated);
});

app.get('/api/reports/summary', auth, manager, (req, res) => {
  const bins = allBins();
  const taskCounts = db.prepare('SELECT status,COUNT(*) AS count FROM collection_tasks GROUP BY status').all();
  const readings24h = db.prepare("SELECT COUNT(*) AS count FROM readings WHERE strftime('%s',recorded_at) >= strftime('%s','now','-1 day')").get().count;
  res.json({ bins: bins.length, full: bins.filter(b => b.status === 'full').length,
    offline: bins.filter(b => b.status === 'offline').length, readings24h, tasks: taskCounts });
});
app.get('/api/readings/recent', auth, manager, (req, res) => res.json(
  db.prepare('SELECT r.id,r.bin_id,b.name AS bin_name,r.fill_percent,r.recorded_at FROM readings r JOIN bins b ON b.id=r.bin_id ORDER BY r.recorded_at DESC,r.id DESC LIMIT 50').all()
));

// One aggregate per bin per hour after 24 hours; remove aggregates after 30 days.
function cleanup() {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS reading_rollup AS SELECT bin_id, strftime('%Y-%m-%dT%H:00:00Z',recorded_at) AS bucket,
      ROUND(AVG(fill_percent)) AS fill_percent FROM readings WHERE 0 GROUP BY bin_id,bucket`);
    db.exec('DELETE FROM reading_rollup');
    db.exec(`INSERT INTO reading_rollup SELECT bin_id,strftime('%Y-%m-%dT%H:00:00Z',recorded_at),ROUND(AVG(fill_percent))
      FROM readings WHERE strftime('%s',recorded_at) < strftime('%s','now','-1 day') AND strftime('%s',recorded_at) >= strftime('%s','now','-30 days')
      GROUP BY bin_id,strftime('%Y-%m-%dT%H:00:00Z',recorded_at)`);
    db.exec("DELETE FROM readings WHERE strftime('%s',recorded_at) < strftime('%s','now','-1 day')");
    db.exec('INSERT INTO readings (bin_id,fill_percent,recorded_at) SELECT bin_id,fill_percent,bucket FROM reading_rollup');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); console.error('Cleanup failed:', error); }
}
cleanup();
const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
cleanupTimer.unref();
const offlineTimer = setInterval(publishBins, 5000);
offlineTimer.unref();

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') return socket.destroy();
  // Browser sends a short-lived JWT using Sec-WebSocket-Protocol.
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(x => x.trim());
  if (protocols[0] !== 'waste-v1' || !protocols[1]) return socket.destroy();
  try {
    const payload = jwt.verify(protocols[1], secret, { algorithms: ['HS256'] });
    const user = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(payload.sub);
    if (!user) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      wsClients.set(ws, user);
      ws.on('close', () => wsClients.delete(ws));
      ws.send(JSON.stringify({ type: 'ready', data: { user: user.username } }));
    });
  } catch { socket.destroy(); }
});

app.use((error, req, res, next) => {
  if (error.status === 400 && error.type === 'entity.parse.failed') return bad(res, 400, 'Invalid JSON');
  console.error(error);
  return bad(res, 500, 'Server error');
});
if (require.main === module) server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () =>
  console.log(`Smart waste server listening on 0.0.0.0:${Number(process.env.PORT) || 3000}`));
module.exports = { app, server, cleanup, binView };
