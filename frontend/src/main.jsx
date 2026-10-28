import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './Landing.jsx';
import LandingEditor from './LandingEditor.jsx';
import './style.css';

const fmt = value => value ? new Date(value).toLocaleString() : 'Never';
const priorityNames = { 1: 'Low', 2: 'Normal', 3: 'High' };
const API = async (path, token, options = {}) => {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `HTTP ${response.status}`);
  return data;
};

function Badge({ status }) { return <span className={`badge ${status}`}>{status.replace('_', ' ')}</span>; }
function Meter({ fill, status }) { return <div className={`meter ${status}`}><span style={{ width: `${fill ?? 0}%` }} /></div>; }

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('wasteToken'));
  const [user, setUser] = useState(null);
  const [showPublic, setShowPublic] = useState(true);
  const [publicContent, setPublicContent] = useState(null);
  const [loginError, setLoginError] = useState('');
  const [page, setPage] = useState('overview');
  const [bins, setBins] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [recent, setRecent] = useState([]);
  const [report, setReport] = useState(null);
  const [chartBin, setChartBin] = useState('');
  const [chartRows, setChartRows] = useState([]);
  const [connection, setConnection] = useState('Connecting…');
  const [notice, setNotice] = useState('');
  const [editBin, setEditBin] = useState(null);
  const [newKey, setNewKey] = useState('');
  const [taskBin, setTaskBin] = useState('');
  const manager = user?.role === 'manager';
  const tell = message => { setNotice(message); setTimeout(() => setNotice(current => current === message ? '' : current), 7000); };
  const logout = useCallback(() => { sessionStorage.removeItem('wasteToken'); setToken(null); setUser(null); setShowPublic(true); }, []);

  const refresh = useCallback(async (role = user?.role) => {
    if (!token || !role) return;
    try {
      if (role === 'manager') {
        const [nextBins, nextTasks, nextUsers, nextRecent, nextReport] = await Promise.all([
          API('/api/bins', token), API('/api/tasks', token), API('/api/users', token),
          API('/api/readings/recent', token), API('/api/reports/summary', token)
        ]);
        setBins(nextBins); setTasks(nextTasks); setUsers(nextUsers); setRecent(nextRecent); setReport(nextReport);
        setChartBin(current => nextBins.some(b => b.id === current) ? current : nextBins[0]?.id || '');
      } else setTasks(await API('/api/tasks', token));
    } catch (error) { if (error.message === 'Authentication required') logout(); else tell(error.message); }
  }, [token, user?.role, logout]);

  useEffect(() => { API('/api/public/content', null).then(setPublicContent).catch(error => tell(error.message)); }, []);
  useEffect(() => { if (!token) return; API('/api/me', token).then(account => { setUser(account); setShowPublic(false); setPage(account.role === 'manager' ? 'overview' : 'myTasks'); refresh(account.role); }).catch(logout); }, [token]);
  useEffect(() => { if (!manager || !chartBin || !token) return; API(`/api/bins/${encodeURIComponent(chartBin)}/readings?limit=100`, token).then(rows => setChartRows(rows.reverse())).catch(error => tell(error.message)); }, [chartBin, token, manager, recent]);
  useEffect(() => {
    if (!user || !token) return;
    let socket, retry, closed = false;
    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${scheme}//${location.host}/ws`, ['waste-v1', token]);
      socket.onopen = () => setConnection('Live connection active');
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'task' && user.role === 'staff' && message.data.staff_id === user.id && message.data.status === 'pending') tell(`New task: ${message.data.bin_name}`);
        if (['reading', 'bins', 'alerts', 'task', 'tasks'].includes(message.type)) refresh(user.role);
      };
      socket.onclose = () => { setConnection('Reconnecting…'); if (!closed) retry = setTimeout(connect, 3000); };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); socket?.close(); };
  }, [user?.id, token, refresh]);

  async function login(event) {
    event.preventDefault(); setLoginError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { const result = await API('/api/login', null, { method: 'POST', body: JSON.stringify(values) });
      sessionStorage.setItem('wasteToken', result.token); setToken(result.token);
    } catch (error) { setLoginError(error.message); }
  }
  async function saveBin(event) {
    event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form));
    const body = { id: values.id, name: values.name.trim(), location: values.location.trim(), tole: values.tole.trim(), height_cm: Number(values.height_cm), threshold: Number(values.threshold) };
    try { const result = await API(editBin ? `/api/bins/${encodeURIComponent(editBin.id)}` : '/api/bins', token,
      { method: editBin ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setNewKey(result.sensor_key ? `Sensor key for ${body.id}: ${result.sensor_key} — copy it now.` : '');
      setEditBin(null); form.reset(); tell(editBin ? 'Bin updated' : 'Bin added'); await refresh();
    } catch (error) { tell(error.message); }
  }
  async function removeBin(bin) {
    if (!confirm(`Remove ${bin.name}, its readings and tasks?`)) return;
    try { await API(`/api/bins/${encodeURIComponent(bin.id)}`, token, { method: 'DELETE' }); tell('Bin removed'); await refresh(); } catch (error) { tell(error.message); }
  }
  async function saveTask(event) {
    event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form));
    try { await API('/api/tasks', token, { method: 'POST', body: JSON.stringify({ bin_id: values.bin_id, staff_id: Number(values.staff_id), priority: Number(values.priority), note: values.note }) });
      form.reset(); setTaskBin(''); tell('Task assigned'); await refresh(); } catch (error) { tell(error.message); }
  }
  async function changeTask(task, status) {
    if (status === 'completed' && !confirm('Have you physically emptied this bin?')) return;
    try { await API(`/api/tasks/${task.id}`, token, { method: 'PATCH', body: JSON.stringify({ status }) }); tell('Task updated'); await refresh(); } catch (error) { tell(error.message); }
  }
  async function saveStaff(event) {
    event.preventDefault(); const form = event.currentTarget;
    try { await API('/api/users', token, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); tell('Staff account created'); await refresh(); } catch (error) { tell(error.message); }
  }
  async function removeStaff(person) {
    if (!confirm(`Remove ${person.username} and their tasks?`)) return;
    try { await API(`/api/users/${person.id}`, token, { method: 'DELETE' }); tell('Staff removed'); await refresh(); } catch (error) { tell(error.message); }
  }

  async function saveLanding(draft) {
    try {
      const updated = await API('/api/site-content', token, { method: 'PUT', body: JSON.stringify(draft) });
      setPublicContent(updated); tell('Public landing page saved');
    } catch (error) { tell(error.message); throw error; }
  }

  const pages = manager ? [['overview', 'Overview'], ['manage', 'Manage bins'], ['tasks', 'Tasks'], ['staff', 'Staff'], ['reports', 'Reports'], ['landing', 'Landing content']] : [['myTasks', 'My tasks']];
  const alerts = bins.filter(bin => bin.status === 'full' || bin.status === 'offline');
  const staff = users.filter(person => person.role === 'staff');
  const points = chartRows.map((row, index) => `${35 + index * 650 / Math.max(chartRows.length - 1, 1)},${180 - row.fill_percent * 1.6}`).join(' ');

  return <><header className={showPublic ? 'public-topbar' : ''}><div><strong>{showPublic ? (publicContent?.municipality_name || 'व्यास नगरपालिका') : 'Smart Waste'}</strong><small>{showPublic ? (publicContent?.department_name || 'नगर फोहोर व्यवस्थापन विभाग') : 'Collection control'}</small></div><div className="identity">{showPublic ? <button className="plain" onClick={() => setShowPublic(false)}>{user ? 'Dashboard' : 'Sign in'}</button> : user ? <><span>{user.username} · {user.role}</span><button className="plain" onClick={() => setShowPublic(true)}>Public home</button><button className="plain" onClick={logout}>Log out</button></> : <button className="plain" onClick={() => setShowPublic(true)}>Public home</button>}</div></header>
    <main className={showPublic ? 'public-main' : ''}>{showPublic ? <Landing content={publicContent} onSignIn={() => setShowPublic(false)} /> : !user ? <section className="login card"><h1>Sign in</h1><p>Use your manager or staff account.</p><form onSubmit={login}><label>Username<input name="username" required autoComplete="username" /></label><label>Password<input name="password" type="password" required autoComplete="current-password" /></label><button>Sign in</button></form><p className="error" role="alert">{loginError}</p></section> : <>
      <div className="headline"><div><h1>{pages.find(item => item[0] === page)?.[1]}</h1><p>{connection}</p></div><nav>{pages.map(([id, label]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>{label}</button>)}</nav></div>
      <div className="notice" role="status">{notice}</div>
      {manager && page === 'overview' && <section><div className="section-title"><h2>Bins</h2><span>{bins.length} bins · {bins.filter(b => b.status === 'full').length} full · {bins.filter(b => b.status === 'offline').length} offline</span></div><div className="grid">{bins.map(bin => <article className="card" key={bin.id}><div className="bin-top"><h3>{bin.name}</h3><Badge status={bin.status} /></div><p className="meta">{bin.id} · {bin.tole ? `${bin.tole} · ` : ''}{bin.location}</p><div className="level">{bin.fill_percent == null ? 'No reading' : `${bin.fill_percent}%`}</div><Meter fill={bin.fill_percent} status={bin.status} /><small>Last update: {fmt(bin.last_update)}</small>{bin.awaiting_reading && <p className="muted">Emptying reported; waiting for the next reading.</p>}</article>)}</div>
        <h2>Alert cart</h2><div className="stack">{alerts.length ? alerts.map(bin => <article className="card" key={bin.id}><div className="row-top"><strong>{bin.name}</strong><Badge status={bin.status} /></div><p className="meta">{bin.location} · {bin.fill_percent ?? '—'}% · Last seen {fmt(bin.last_update)}</p><button onClick={() => { setTaskBin(bin.id); setPage('tasks'); }}>Assign task</button></article>) : <p className="muted">No full or offline bins right now.</p>}</div>
        <h2>Fill history</h2><div className="card"><label>Bin<select value={chartBin} onChange={event => setChartBin(event.target.value)}>{bins.map(bin => <option key={bin.id} value={bin.id}>{bin.name} ({bin.id})</option>)}</select></label><svg viewBox="0 0 700 210" role="img" aria-label="Fill history chart"><line x1="35" y1="180" x2="685" y2="180" stroke="#b9cbd1" /><text x="0" y="24">100%</text><text x="0" y="104">50%</text><text x="0" y="184">0%</text><polyline points={points} fill="none" stroke="#087b81" strokeWidth="3" /></svg><p className="muted">{chartRows.length ? `${chartRows.length} readings · ${fmt(chartRows[0].recorded_at)} to ${fmt(chartRows.at(-1).recorded_at)}` : 'No readings yet.'}</p></div>
        <h2>Recent readings</h2><div className="table-wrap"><table><thead><tr><th>Bin</th><th>Level</th><th>Time</th></tr></thead><tbody>{recent.map(row => <tr key={row.id}><td>{row.bin_name}</td><td>{row.fill_percent}%</td><td>{fmt(row.recorded_at)}</td></tr>)}</tbody></table></div>
      </section>}
      {manager && page === 'manage' && <section><h2>Manage bins</h2><div className="two-col"><form key={editBin?.id || 'new'} className="card" onSubmit={saveBin}><h3>{editBin ? `Edit ${editBin.id}` : 'Add bin'}</h3><label>Bin ID<input name="id" defaultValue={editBin?.id || ''} readOnly={!!editBin} required pattern="[A-Za-z0-9_-]+" maxLength="32" /></label><label>Name<input name="name" defaultValue={editBin?.name || ''} required maxLength="80" /></label><label>Location<input name="location" defaultValue={editBin?.location || ''} required maxLength="160" /></label><label>Tole name (public lookup)<input name="tole" defaultValue={editBin?.tole || ''} maxLength="80" placeholder="e.g. भानु टोल" required /></label><label>Height (cm)<input name="height_cm" type="number" defaultValue={editBin?.height_cm || 40} min="1" max="1000" step="0.1" required /></label><label>Full threshold (%)<input name="threshold" type="number" defaultValue={editBin?.threshold || 80} min="1" max="100" required /></label><div className="actions"><button>Save bin</button>{editBin && <button type="button" className="secondary" onClick={() => setEditBin(null)}>Cancel edit</button>}</div>{newKey && <p className="key">{newKey}</p>}</form><div className="stack">{bins.map(bin => <article className="card" key={bin.id}><div className="row-top"><strong>{bin.name} ({bin.id})</strong><Badge status={bin.status} /></div><p className="meta">{bin.tole ? `${bin.tole} · ` : ''}{bin.location} · {bin.height_cm} cm · full above {bin.threshold}% · latest {bin.fill_percent ?? '—'}% · {fmt(bin.last_update)}</p><div className="actions"><button className="secondary" onClick={() => { setEditBin(bin); setNewKey(''); }}>Edit</button><button className="secondary" onClick={() => { setChartBin(bin.id); setPage('overview'); }}>View history</button><button className="danger" onClick={() => removeBin(bin)}>Remove</button></div></article>)}</div></div></section>}
      {manager && page === 'tasks' && <section><h2>Collection tasks</h2><div className="two-col"><form className="card" onSubmit={saveTask}><h3>Assign task</h3><label>Bin<select name="bin_id" value={taskBin} onChange={event => setTaskBin(event.target.value)} required><option value="">Choose a bin</option>{bins.map(bin => <option key={bin.id} value={bin.id}>{bin.name} ({bin.id})</option>)}</select></label><label>Staff<select name="staff_id" required><option value="">Choose staff</option>{staff.map(person => <option key={person.id} value={person.id}>{person.username}</option>)}</select></label><label>Priority<select name="priority" defaultValue="2"><option value="1">Low</option><option value="2">Normal</option><option value="3">High</option></select></label><label>Note<textarea name="note" maxLength="500" /></label><button>Assign task</button></form><TaskList tasks={tasks} manager onChange={changeTask} /></div></section>}
      {manager && page === 'staff' && <section><h2>Staff accounts</h2><div className="two-col"><form className="card" onSubmit={saveStaff}><h3>Create staff account</h3><label>Username<input name="username" required minLength="3" maxLength="40" /></label><label>Temporary password<input name="password" type="password" required minLength="12" /></label><button>Create account</button></form><div className="stack">{staff.length ? staff.map(person => <article className="card row-top" key={person.id}><strong>{person.username}</strong><button className="danger" onClick={() => removeStaff(person)}>Remove</button></article>) : <p className="muted">Create a staff account to assign tasks.</p>}</div></div></section>}
      {manager && page === 'reports' && <section><h2>Report summary</h2><div className="grid">{report && [['Bins', report.bins], ['Full', report.full], ['Offline', report.offline], ['Readings in 24 hours', report.readings24h], ...report.tasks.map(item => [`Tasks ${item.status.replace('_', ' ')}`, item.count])].map(([label, value]) => <article className="card" key={label}><div className="level">{value}</div><small>{label}</small></article>)}</div><p className="muted">Readings are kept at full resolution for 24 hours, then hourly until day 30.</p></section>}
      {manager && page === 'landing' && <LandingEditor content={publicContent} onSave={saveLanding} onPreview={() => setShowPublic(true)} />}
      {!manager && page === 'myTasks' && <section><h2>My collection tasks</h2><p className="muted">Highest priority first. Confirm the physical bin is emptied before completing a task.</p><TaskList tasks={tasks} onChange={changeTask} /></section>}
    </>}</main></>;
}

function TaskList({ tasks, manager, onChange }) {
  return <div className="stack">{tasks.length ? tasks.map(task => <article className={`card task-card ${task.priority === 3 ? 'high' : task.priority === 2 ? 'normal' : ''}`} key={task.id}><div className="row-top"><strong>{task.bin_name} · {task.tole ? `${task.tole} · ` : ''}{task.location}</strong><Badge status={task.status} /></div><p>Fill: {task.fill_percent ?? '—'}% · Priority: {priorityNames[task.priority]}{manager ? ` · Assigned to ${task.staff_name}` : ''}</p>{task.note && <p className="muted">{task.note}</p>}<small>Created {fmt(task.created_at)}{task.started_at && ` · Started ${fmt(task.started_at)}`}{task.completed_at && ` · Completed ${fmt(task.completed_at)}`}</small><div className="actions">{task.status === 'pending' && <button onClick={() => onChange(task, 'in_progress')}>Start</button>}{task.status === 'in_progress' && <button onClick={() => onChange(task, 'completed')}>Mark completed</button>}</div></article>) : <p className="muted">No tasks yet.</p>}</div>;
}

createRoot(document.getElementById('root')).render(<App />);
