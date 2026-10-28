const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'waste-test-'));
process.env.DB_PATH = path.join(temp, 'test.sqlite');
process.env.JWT_SECRET = 'test-secret-not-for-production-1234567890';
const db = require('../src/db');
const { server, cleanup } = require('../src/server');
const key = 'a'.repeat(48);
const hash = crypto.createHash('sha256').update(key).digest('hex');
db.prepare('INSERT INTO bins (id,name,location,height_cm,threshold,sensor_key_hash) VALUES (?,?,?,?,?,?)')
  .run('bin1','Test bin','North gate',40,80,hash);
db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
  .run('manager',bcrypt.hashSync('manager-password-123',8),'manager');
db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
  .run('collector',bcrypt.hashSync('staff-password-123',8),'staff');

test('device ingestion, thresholds, live updates, roles, tasks and retention', async t => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(temp,{recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, method='GET', body, token, sensorKey) {
    const response = await fetch(base+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{ }),...(sensorKey?{'X-Sensor-Key':sensorKey}:{})},body:body?JSON.stringify(body):undefined});
    return { status:response.status, data:response.status===204?null:await response.json() };
  }
  const managerLogin = await request('/api/login','POST',{username:'manager',password:'manager-password-123'});
  const staffLogin = await request('/api/login','POST',{username:'collector',password:'staff-password-123'});
  assert.equal(managerLogin.status,200); assert.equal(staffLogin.status,200);
  const mt = managerLogin.data.token, st = staffLogin.data.token;
  assert.equal((await fetch(base)).status,200);
  assert.equal((await fetch(base+'/app.js')).status,200);
  assert.equal((await request('/api/bins')).status,401);
  assert.equal((await request('/api/bins','GET',null,st)).status,403);
  assert.equal((await request('/api/bins/bin1/readings','GET',null,st)).status,403);
  assert.equal((await request('/api/users','GET',null,st)).status,403);
  assert.equal((await request('/api/data','POST',{bin_id:'unknown',fill_percent:82},null,key)).status,404);
  assert.equal((await request('/api/data','POST',{bin_id:'bin1',fill_percent:82},null,'b'.repeat(48))).status,401);
  assert.equal((await request('/api/data','POST',{bin_id:'bin1',fill_percent:101},null,key)).status,400);
  assert.equal((await request('/api/data','POST',{bin_id:'bin1',fill_percent:50},null,key)).data.status,'filling');
  assert.equal((await request('/api/data','POST',{bin_id:'bin1',fill_percent:80},null,key)).data.status,'filling');

  const ws = new WebSocket(base.replace('http','ws')+'/ws',['waste-v1',mt]);
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
  const message = new Promise(resolve => ws.on('message',data => {const m=JSON.parse(data);if(m.type==='reading')resolve(m)}));
  const ingest = await request('/api/data','POST',{bin_id:'bin1',fill_percent:82},null,key);
  assert.equal(ingest.status,201); assert.equal(ingest.data.status,'full');
  assert.equal((await message).data.fill_percent,82);
  assert.equal((await request('/api/bins','GET',null,mt)).data[0].status,'full');
  assert.equal((await request('/api/tasks','POST',{bin_id:'bin1',staff_id:2,priority:3},st)).status,403);
  const created = await request('/api/tasks','POST',{bin_id:'bin1',staff_id:2,priority:3,note:'Collect today'},mt);
  assert.equal(created.status,201);
  assert.equal((await request('/api/tasks','GET',null,st)).data.length,1);
  const id = created.data.id;
  assert.equal((await request(`/api/tasks/${id}`,'PATCH',{status:'completed'},st)).status,400);
  assert.equal((await request(`/api/tasks/${id}`,'PATCH',{status:'in_progress'},st)).status,200);
  assert.equal((await request(`/api/tasks/${id}`,'PATCH',{status:'completed'},st)).status,200);
  assert.equal((await request('/api/bins','GET',null,mt)).data[0].status,'emptied');
  assert.equal((await request('/api/data','POST',{bin_id:'bin1',fill_percent:12},null,key)).data.status,'normal');
  const old = new Date(Date.now()-2*86400000).toISOString();
  db.prepare('INSERT INTO readings (bin_id,fill_percent,recorded_at) VALUES (?,?,?)').run('bin1',10,old);
  db.prepare('INSERT INTO readings (bin_id,fill_percent,recorded_at) VALUES (?,?,?)').run('bin1',20,old);
  cleanup();
  const rolled = db.prepare('SELECT fill_percent FROM readings WHERE bin_id=? AND recorded_at LIKE ?').get('bin1',old.slice(0,13)+'%');
  assert.equal(rolled.fill_percent,15);
  ws.close();
});
