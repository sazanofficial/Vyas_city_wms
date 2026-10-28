const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const username = process.env.MANAGER_USER || 'manager';
const password = process.env.MANAGER_PASSWORD;
if (!password || password.length < 12) {
  console.error('Set MANAGER_PASSWORD to at least 12 characters before seeding.');
  process.exit(1);
}
if (!db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
  db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
    .run(username, bcrypt.hashSync(password, 12), 'manager');
  console.log(`Created manager account: ${username}`);
} else console.log(`Manager ${username} already exists; password unchanged.`);

for (let i = 1; i <= 4; i++) {
  const id = `bin${i}`;
  if (db.prepare('SELECT id FROM bins WHERE id = ?').get(id)) continue;
  const key = crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  db.prepare('INSERT INTO bins (id,name,location,height_cm,threshold,sensor_key_hash) VALUES (?,?,?,?,?,?)')
    .run(id, `Bin ${i}`, `Location ${i}`, 40, 80, hash);
  console.log(`${id} sensor key: ${key}  (copy now into that board's SENSOR_KEY)`);
}
console.log('Seed complete. Existing bins and sensor keys were preserved.');
