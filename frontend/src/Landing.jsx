import React, { useEffect, useState } from 'react';

const statusNames = {
  normal: 'सामान्य', filling: 'भरिँदै', full: 'भरिएको',
  offline: 'सम्पर्क छैन', emptied: 'खाली गरिएको'
};
const FALLBACK = {
  municipality_name: 'व्यास नगरपालिका', department_name: 'नगर फोहोर व्यवस्थापन विभाग',
  municipality_location: 'दमौली, तनहुँ · गण्डकी प्रदेश, नेपाल', notice_title: 'महत्त्वपूर्ण सूचना',
  notice_body: 'कृपया फोहोर छुट्याएर तोकिएको स्थानमा राख्नुहोस्।', hero_kicker: 'स्वच्छ व्यास, स्वस्थ भविष्य',
  hero_title: 'हाम्रो नगर सफा राख्ने साझा प्रयास', hero_body: 'आफ्नो टोलको डस्टबिनको अवस्था जाँच्नुहोस्।',
  lookup_title: 'आफ्नो टोलको डस्टबिन अवस्था जाँच्नुहोस्', lookup_help: 'टोलको नाम लेखेर खोज्नुहोस्।',
  about_title: 'यस प्रणालीबारे', about_body: 'सेन्सरबाट आएको जानकारीले फोहोर संकलनको अवस्था देखाउँछ।',
  awareness_title: 'फोहोर व्यवस्थापन सचेतना', awareness_body: 'कुहिने र नकुहिने फोहोर छुट्याउनुहोस्।',
  footer_text: 'व्यास नगरपालिका · नगर फोहोर व्यवस्थापन विभाग'
};

function ResultCard({ bin }) {
  const updated = bin.last_update ? new Date(bin.last_update).toLocaleString() : 'अहिलेसम्म मापन आएको छैन';
  return <article className="public-result" key={bin.id}>
    <div className="public-result-top"><div><strong>{bin.name}</strong><p>{bin.tole || bin.location}</p></div><span className={`badge ${bin.status}`}>{statusNames[bin.status] || bin.status}</span></div>
    <div className="public-level"><span>{bin.fill_percent == null ? '—' : `${bin.fill_percent}%`}</span><small>पछिल्लो भरिएको स्तर</small></div>
    <div className={`meter ${bin.status}`}><span style={{ width: `${bin.fill_percent ?? 0}%` }} /></div>
    <small>अन्तिम अपडेट: {updated}</small>
    {bin.status === 'offline' && <p className="public-hint">यो पछिल्लो उपलब्ध मापन हो। सेन्सरबाट नयाँ जानकारी आएको छैन।</p>}
  </article>;
}

export default function Landing({ content: sourceContent, onSignIn }) {
  const content = sourceContent || FALLBACK;
  const [input, setInput] = useState('');
  const [searched, setSearched] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!searched) return;
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/public/bins?tole=${encodeURIComponent(searched)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || 'खोज उपलब्ध छैन।');
        if (active) { setResults(data.results); setError(''); }
      } catch (err) { if (active) setError(err.message); }
      finally { if (active) setLoading(false); }
    };
    load();
    const timer = setInterval(load, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [searched]);

  const search = event => {
    event.preventDefault();
    const value = input.trim();
    if (!value) { setError('कृपया टोलको नाम लेख्नुहोस्।'); return; }
    setResults([]); setError(''); setLoading(true); setSearched(value);
  };

  return <div className="public-home">
    <section className="municipal-heading" aria-label="Municipal heading">
      <div className="municipal-seal seal-left" role="img" aria-label="नेपालको प्रतीक" />
      <div className="municipal-title"><h1>{content.municipality_name}</h1><h2>{content.department_name}</h2><p>{content.municipality_location}</p></div>
      <div className="municipal-seal seal-right" role="img" aria-label="नगरपालिका प्रतीक" />
    </section>

    <section className="important-notice" aria-labelledby="notice-heading">
      <div className="notice-icon" aria-hidden="true">!</div>
      <div><h2 id="notice-heading">{content.notice_title}</h2><p>{content.notice_body}</p></div>
    </section>

    <section className="public-hero"><div><span className="hero-kicker">{content.hero_kicker}</span><h2>{content.hero_title}</h2><p>{content.hero_body}</p><a className="hero-link" href="#tole-lookup">टोलको अवस्था जाँच्नुहोस् <span aria-hidden="true">→</span></a></div><div className="hero-art" aria-hidden="true"><div className="hero-bin"><span /></div><div className="hero-pulse pulse-one" /><div className="hero-pulse pulse-two" /></div></section>

    <section id="tole-lookup" className="lookup-section"><div className="section-heading"><span className="section-kicker">सार्वजनिक जानकारी</span><h2>{content.lookup_title}</h2><p>{content.lookup_help}</p></div><form className="lookup-form" onSubmit={search}><label htmlFor="tole-name">टोलको नाम</label><div><input id="tole-name" value={input} onChange={event => setInput(event.target.value)} maxLength="80" placeholder="जस्तै: भानु टोल" autoComplete="off" /><button type="submit">खोज्नुहोस्</button></div></form>
      <div className="lookup-results" aria-live="polite">{loading && <p className="muted">अवस्था खोजिँदैछ…</p>}{error && <p className="error">{error}</p>}{!loading && searched && !error && <><p className="result-summary">“{searched}” का लागि {results.length} डस्टबिन भेटिए।</p><div className="public-result-grid">{results.map(bin => <ResultCard key={bin.id} bin={bin} />)}</div>{results.length === 0 && <p className="empty-results">यस नामको टोलमा दर्ता भएको डस्टबिन भेटिएन। टोलको अर्को नाम प्रयास गर्नुहोस् वा वडा कार्यालयलाई सम्पर्क गर्नुहोस्।</p>}</>}</div>
    </section>

    <div className="public-info-grid"><section className="info-panel"><span className="section-kicker">स्मार्ट सेवा</span><h2>{content.about_title}</h2><p>{content.about_body}</p></section><section className="info-panel awareness-panel"><span className="section-kicker">नागरिक सहभागिता</span><h2>{content.awareness_title}</h2><ul>{content.awareness_body.split('\n').filter(Boolean).map((line, index) => <li key={index}>{line}</li>)}</ul></section></div>
    <footer className="public-footer"><span>{content.footer_text}</span><button type="button" onClick={onSignIn}>व्यवस्थापक / कर्मचारी प्रवेश</button></footer>
  </div>;
}
