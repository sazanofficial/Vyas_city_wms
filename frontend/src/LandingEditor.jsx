import React, { useEffect, useState } from 'react';

const fields = [
  ['municipality_name', 'Municipality name'],
  ['department_name', 'Department name'],
  ['municipality_location', 'Municipality location'],
  ['notice_title', 'Important notice heading'],
  ['notice_body', 'Important notice text'],
  ['hero_kicker', 'Hero short line'],
  ['hero_title', 'Hero heading'],
  ['hero_body', 'Hero description'],
  ['lookup_title', 'Tole lookup heading'],
  ['lookup_help', 'Tole lookup instructions'],
  ['about_title', 'About heading'],
  ['about_body', 'About text'],
  ['awareness_title', 'Awareness heading'],
  ['awareness_body', 'Awareness points (one per line)'],
  ['footer_text', 'Footer text'],
];

export default function LandingEditor({ content, onSave, onPreview }) {
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(content), [content]);
  if (!draft) return <p>Loading landing content…</p>;

  const submit = async event => {
    event.preventDefault(); setSaving(true);
    try { await onSave(draft); } catch { /* Parent shows the server error. */ } finally { setSaving(false); }
  };

  return <section className="landing-editor"><div className="section-title"><div><h2>Landing page content</h2><p className="muted">These changes appear on the public home page after saving. Text is displayed as plain text.</p></div><button className="secondary" onClick={onPreview}>Preview public page</button></div><form className="card editor-form" onSubmit={submit}>{fields.map(([key, label]) => <label key={key}>{label}{key.endsWith('_body') ? <textarea name={key} rows={key === 'awareness_body' ? 5 : 3} value={draft[key] ?? ''} maxLength="2000" required onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /> : <input name={key} value={draft[key] ?? ''} maxLength="160" required onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} />}</label>)}<div className="editor-actions"><button disabled={saving}>{saving ? 'Saving…' : 'Save landing page'}</button></div></form></section>;
}
