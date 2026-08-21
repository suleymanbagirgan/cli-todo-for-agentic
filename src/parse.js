function parseDate(s) {
  const t = s.toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  if (t === 'bugün' || t === 'bugun' || t === 'today') return iso(today);
  if (t === 'yarın' || t === 'yarin' || t === 'tomorrow') {
    const d = new Date(today); d.setDate(d.getDate() + 1); return iso(d);
  }
  if (t === 'dün' || t === 'dun' || t === 'yesterday') {
    const d = new Date(today); d.setDate(d.getDate() - 1); return iso(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

export function parseInput(raw) {
  const tokens = String(raw).trim().split(/\s+/).filter(Boolean);
  let project = null;
  let priority = 0;
  let due = null;
  const textParts = [];

  for (const tok of tokens) {
    if (!project && /^\+[\wçğıöşüÇĞİÖŞÜ-]+$/.test(tok)) {
      project = tok.slice(1).toLowerCase();
    } else if (!priority && /^!{1,3}$/.test(tok)) {
      priority = tok.length;
    } else if (!due && tok.startsWith('@') && tok.length > 1) {
      const d = parseDate(tok.slice(1));
      if (d) due = d; else textParts.push(tok);
    } else {
      textParts.push(tok);
    }
  }

  return { text: textParts.join(' '), project, priority, due };
}

export function formatDue(due) {
  if (!due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due + 'T00:00:00');
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'bugün';
  if (diff === 1) return 'yarın';
  if (diff === -1) return 'dün';
  if (diff > 1 && diff <= 7) return `${diff}g`;
  if (diff < -1) return `${-diff}g geç`;
  return due;
}

export function isOverdue(due) {
  if (!due) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(due + 'T00:00:00') < today;
}
