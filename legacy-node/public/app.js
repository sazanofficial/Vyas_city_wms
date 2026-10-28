const $ = id => document.getElementById(id);
const state = { token: sessionStorage.getItem('wasteToken'), user: null, bins: [], tasks: [], users: [], socket: null, page: 'overview' };
const time = value => value ? new Date(value).toLocaleString() : 'Never';
const node = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = String(text); if (className) e.className = className; return e; };
const clear = element => element.replaceChildren();
const flash = message => { $('flash').textContent = message; setTimeout(() => { if ($('flash').textContent === message) $('flash').textContent = ''; }, 7000); };
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}`, ...(options.headers || {}) } });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw Error(result?.error || `HTTP ${response.status}`);
  return result;
}
function logout() {
  sessionStorage.removeItem('wasteToken'); state.token = null; state.user = null;
  state.socket?.close(); state.socket = null; $('identity').hidden = true; $('appPanel').hidden = true; $('loginPanel').hidden = false;
}
function showPage(page) {
  state.page = page;
  for (const e of document.querySelectorAll('.page')) e.hidden = e.id !== page;
  for (const e of $('nav').children) e.classList.toggle('active', e.dataset.page === page);
  const titles = { overview: 'Overview', manage: 'Manage bins', tasks: 'Collection tasks', staff: 'Staff', reports: 'Reports', myTasks: 'My tasks' };
  $('pageTitle').textContent = titles[page];
  if (page === 'overview') refreshOverview();
  if (page === 'reports') refreshReports();
}
function setupNav() {
  clear($('nav'));
  const pages = state.user.role === 'manager' ? [['overview','Overview'],['manage','Manage bins'],['tasks','Tasks'],['staff','Staff'],['reports','Reports']] : [['myTasks','My tasks']];
  for (const [id, label] of pages) {
    const b = node('button', label); b.dataset.page = id; b.onclick = () => showPage(id); $('nav').append(b);
  }
  document.querySelectorAll('.manager-page').forEach(e => { if (state.user.role !== 'manager') e.hidden = true; });
  showPage(pages[0][0]);
}
function badge(status) { return node('span', status.replace('_',' '), `badge ${status}`); }
function renderBins() {
  clear($('binCards')); clear($('alerts')); clear($('manageBins'));
  const full = state.bins.filter(b => b.status === 'full').length, offline = state.bins.filter(b => b.status === 'offline').length;
  $('overviewStats').textContent = `${state.bins.length} bins · ${full} full · ${offline} offline`;
  for (const b of state.bins) {
    const card = node('article', undefined, 'card'); const top = node('div', undefined, 'bin-top');
    const name = node('h3', b.name); top.append(name, badge(b.status)); card.append(top, node('p', `${b.id} · ${b.location}`, 'meta'));
    card.append(node('div', b.fill_percent == null ? 'No reading' : `${b.fill_percent}%`, 'level'));
    const meter = node('div', undefined, `meter ${b.status}`), bar = node('span');
    bar.style.width = `${b.fill_percent ?? 0}%`; meter.append(bar); card.append(meter);
    card.append(node('small', `Last update: ${time(b.last_update)}`));
    if (b.awaiting_reading) card.append(node('p', 'Emptying reported; waiting for next sensor reading.', 'muted'));
    $('binCards').append(card);
    const manage = node('article', undefined, 'card');
    const mtop = node('div', undefined, 'row-top'); mtop.append(node('strong', `${b.name} (${b.id})`), badge(b.status)); manage.append(mtop);
    manage.append(node('p', `${b.location} · ${b.height_cm} cm · full at ${b.threshold}% · latest ${b.fill_percent ?? '—'}% · ${time(b.last_update)}`, 'meta'));
    const actions = node('div', undefined, 'actions');
    const edit = node('button', 'Edit', 'secondary'); edit.onclick = () => editBin(b);
    const del = node('button', 'Remove', 'danger'); del.onclick = () => deleteBin(b);
    const detail = node('button', 'View history', 'secondary'); detail.onclick = () => { $('chartBin').value = b.id; showPage('overview'); renderChart(); };
    actions.append(edit, detail, del); manage.append(actions); $('manageBins').append(manage);
    if (b.status === 'full' || b.status === 'offline') {
      const alert = node('article', undefined, 'card'); const atop = node('div', undefined, 'row-top');
      atop.append(node('strong', b.name), badge(b.status)); alert.append(atop, node('p', `${b.location} · ${b.fill_percent ?? '—'}% · Last seen ${time(b.last_update)}`, 'meta'));
      const assign = node('button', 'Assign task'); assign.onclick = () => { showPage('tasks'); $('taskBin').value = b.id; $('taskStaff').focus(); };
      alert.append(assign); $('alerts').append(alert);
    }
  }
  if (!$('alerts').children.length) $('alerts').append(node('p', 'No full or offline bins right now.', 'muted'));
  fillSelect($('taskBin'), state.bins.map(b => [b.id, `${b.name} (${b.id})`]));
  fillSelect($('chartBin'), state.bins.map(b => [b.id, `${b.name} (${b.id})`]));
}
function fillSelect(select, choices) {
  const old = select.value; clear(select);
  for (const [value, label] of choices) { const option = node('option', label); option.value = value; select.append(option); }
  if (choices.some(([value]) => value === old)) select.value = old;
}
function editBin(b) {
  showPage('manage'); const f = $('binForm');
  for (const key of ['id','name','location','height_cm','threshold']) f.elements[key].value = b[key];
  f.elements.id.readOnly = true; $('binFormTitle').textContent = `Edit ${b.id}`; $('cancelBin').hidden = false; f.scrollIntoView({ behavior: 'smooth' });
}
function resetBinForm() { $('binForm').reset(); $('binForm').elements.id.readOnly = false; $('binFormTitle').textContent = 'Add bin'; $('cancelBin').hidden = true; }
async function deleteBin(b) {
  if (!confirm(`Remove ${b.name} and all its readings and tasks?`)) return;
  try { await api(`/api/bins/${encodeURIComponent(b.id)}`, { method:'DELETE' }); flash('Bin removed'); await refreshAll(); } catch(e) { flash(e.message); }
}
function renderTasks() {
  const target = state.user.role === 'manager' ? $('managerTasks') : $('myTasksList'); clear(target);
  for (const task of state.tasks) {
    const card = node('article', undefined, `card task-card ${task.priority === 3 ? 'high' : task.priority === 2 ? 'normal' : ''}`);
    const top = node('div', undefined, 'row-top'); top.append(node('strong', `${task.bin_name} · ${task.location}`), badge(task.status)); card.append(top);
    card.append(node('p', `Fill: ${task.fill_percent ?? '—'}% · Priority: ${['','Low','Normal','High'][task.priority]}${state.user.role === 'manager' ? ` · Assigned to ${task.staff_name}` : ''}`));
    if (task.note) card.append(node('p', task.note, 'muted'));
    card.append(node('small', `Created ${time(task.created_at)}${task.started_at ? ` · Started ${time(task.started_at)}` : ''}${task.completed_at ? ` · Completed ${time(task.completed_at)}` : ''}`));
    const actions = node('div', undefined, 'actions');
    if (task.status === 'pending') {
      const start = node('button', 'Start'); start.onclick = () => setTask(task.id, 'in_progress'); actions.append(start);
    }
    if (task.status === 'in_progress') {
      const done = node('button', 'Mark completed'); done.onclick = () => setTask(task.id, 'completed'); actions.append(done);
    }
    card.append(actions); target.append(card);
  }
  if (!state.tasks.length) target.append(node('p', 'No tasks yet.', 'muted'));
}
async function setTask(id,status) {
  if (status === 'completed' && !confirm('Have you physically emptied this bin?')) return;
  try { await api(`/api/tasks/${id}`, { method:'PATCH', body:JSON.stringify({status}) }); flash('Task updated'); await refreshAll(); } catch(e) { flash(e.message); }
}
function renderUsers() {
  clear($('staffList'));
  const staff = state.users.filter(u => u.role === 'staff');
  fillSelect($('taskStaff'), staff.map(u => [String(u.id), u.username]));
  for (const u of staff) {
    const card = node('article', undefined, 'card row-top'); card.append(node('strong', u.username));
    const del = node('button', 'Remove', 'danger'); del.onclick = async () => {
      if (!confirm(`Remove ${u.username} and their tasks?`)) return;
      try { await api(`/api/users/${u.id}`, {method:'DELETE'}); flash('Staff removed'); await refreshAll(); } catch(e) { flash(e.message); }
    }; card.append(del); $('staffList').append(card);
  }
  if (!staff.length) $('staffList').append(node('p', 'Create a staff account to assign tasks.', 'muted'));
}
async function renderChart() {
  const id = $('chartBin').value; if (!id) return;
  try {
    const rows = (await api(`/api/bins/${encodeURIComponent(id)}/readings?limit=100`)).reverse();
    const svg = $('chart'); clear(svg);
    const ns = 'http://www.w3.org/2000/svg';
    const line = document.createElementNS(ns,'line'); line.setAttribute('x1','35'); line.setAttribute('y1','180'); line.setAttribute('x2','685'); line.setAttribute('y2','180'); line.setAttribute('stroke','#b9cbd1'); svg.append(line);
    for (const [y,label] of [[20,'100%'],[100,'50%'],[180,'0%']]) { const t = document.createElementNS(ns,'text'); t.setAttribute('x','0'); t.setAttribute('y',String(y+4)); t.setAttribute('font-size','12'); t.textContent=label; svg.append(t); }
    if (rows.length) { const poly = document.createElementNS(ns,'polyline'); const points = rows.map((r,i) => `${35+(i*650/Math.max(rows.length-1,1))},${180-r.fill_percent*1.6}`).join(' '); poly.setAttribute('points',points); poly.setAttribute('fill','none'); poly.setAttribute('stroke','#087b81'); poly.setAttribute('stroke-width','3'); svg.append(poly); }
    $('chartCaption').textContent = rows.length ? `${rows.length} readings · ${time(rows[0].recorded_at)} to ${time(rows.at(-1).recorded_at)}` : 'No readings yet.';
  } catch(e) { flash(e.message); }
}
async function refreshOverview() {
  if (state.user?.role !== 'manager') return;
  try {
    const rows = await api('/api/readings/recent'); clear($('recentRows'));
    for (const r of rows) { const tr = node('tr'); for (const value of [r.bin_name,`${r.fill_percent}%`,time(r.recorded_at)]) tr.append(node('td',value)); $('recentRows').append(tr); }
    renderChart();
  } catch(e) { flash(e.message); }
}
async function refreshReports() {
  if (state.user?.role !== 'manager') return;
  try { const report = await api('/api/reports/summary'); clear($('reportCards'));
    for (const [label,value] of [['Bins',report.bins],['Full',report.full],['Offline',report.offline],['Readings in 24 hours',report.readings24h],...report.tasks.map(t => [`Tasks ${t.status.replace('_',' ')}`,t.count])]) {
      const card = node('article',undefined,'card'); card.append(node('div',value,'level'),node('small',label)); $('reportCards').append(card);
    }
  } catch(e) { flash(e.message); }
}
async function refreshAll() {
  if (!state.user) return;
  try {
    if (state.user.role === 'manager') {
      [state.bins,state.tasks,state.users] = await Promise.all([api('/api/bins'),api('/api/tasks'),api('/api/users')]);
      renderBins(); renderTasks(); renderUsers();
      if (state.page === 'overview') refreshOverview(); if (state.page === 'reports') refreshReports();
    } else { state.tasks = await api('/api/tasks'); renderTasks(); }
  } catch(e) { if (e.message === 'Authentication required') logout(); else flash(e.message); }
}
function connectSocket() {
  state.socket?.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws`, ['waste-v1',state.token]); state.socket = ws;
  ws.onopen = () => { $('connection').textContent = 'Live connection active'; };
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'task' && state.user.role === 'staff' && msg.data.staff_id === state.user.id && msg.data.status === 'pending') flash(`New task: ${msg.data.bin_name}`);
    if (['bins','reading','alerts','task','tasks'].includes(msg.type)) refreshAll();
  };
  ws.onclose = () => { $('connection').textContent = 'Reconnecting…'; if (state.token) setTimeout(connectSocket,3000); };
}
async function enter() {
  try { state.user = await api('/api/me'); $('who').textContent = `${state.user.username} · ${state.user.role}`;
    $('identity').hidden = false; $('appPanel').hidden = false; $('loginPanel').hidden = true;
    setupNav(); await refreshAll(); connectSocket();
  } catch { logout(); }
}
$('loginForm').onsubmit = async event => { event.preventDefault(); $('loginError').textContent = '';
  try { const data = await api('/api/login', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    state.token = data.token; sessionStorage.setItem('wasteToken',data.token); await enter();
  } catch(e) { $('loginError').textContent = e.message; }
};
$('logout').onclick = logout;
$('cancelBin').onclick = resetBinForm;
$('chartBin').onchange = renderChart;
$('binForm').onsubmit = async event => { event.preventDefault(); const f=event.target; const id=f.elements.id.value.trim();
  const editing=f.elements.id.readOnly; const body={id,name:f.elements.name.value.trim(),location:f.elements.location.value.trim(),height_cm:Number(f.elements.height_cm.value),threshold:Number(f.elements.threshold.value)};
  try { const result=await api(editing?`/api/bins/${encodeURIComponent(id)}`:'/api/bins',{method:editing?'PATCH':'POST',body:JSON.stringify(body)});
    $('newKey').textContent=result.sensor_key?`Sensor key for ${id}: ${result.sensor_key} — copy it now; it will not be shown again.`:'';
    resetBinForm(); flash(editing?'Bin updated':'Bin added'); await refreshAll();
  } catch(e) { flash(e.message); }
};
$('taskForm').onsubmit = async event => { event.preventDefault(); const f=event.target;
  try { await api('/api/tasks',{method:'POST',body:JSON.stringify({bin_id:f.elements.bin_id.value,staff_id:Number(f.elements.staff_id.value),priority:Number(f.elements.priority.value),note:f.elements.note.value})});
    f.reset(); flash('Task assigned'); await refreshAll();
  } catch(e) { flash(e.message); }
};
$('staffForm').onsubmit = async event => { event.preventDefault(); const f=event.target;
  try { await api('/api/users',{method:'POST',body:JSON.stringify({username:f.elements.username.value,password:f.elements.password.value})});
    f.reset(); flash('Staff account created'); await refreshAll();
  } catch(e) { flash(e.message); }
};
if (state.token) enter();
