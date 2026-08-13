function isSensitiveKey(key) {
  const words = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase().split('_').filter(Boolean);
  const joined = words.join('');
  const lastWord = words[words.length - 1] || '';
  if (['password', 'passwd', 'pwd', 'pass', 'secret', 'token', 'authorization', 'credential', 'credentials'].includes(joined)) return true;
  if (['password', 'passwd', 'pwd', 'pass', 'secret', 'token', 'authorization', 'credential', 'credentials'].includes(lastWord)) return true;
  return ['apikey', 'apisecretkey', 'accesstoken', 'refreshtoken', 'clientsecret', 'smtppass', 'smtppassword',
    'dbpass', 'dbpassword', 'databaseurl', 'connectionstring', 'privatekey', 'passwordhash', 'tokenhash'].some(value => joined.endsWith(value));
}

function sanitizeJobError(value, maxLength = 2000) {
  let text = String(value == null ? '' : value);
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [已脱敏]');
  text = text.replace(
    /((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s/@:]*:)[^@\s/]+@/gi,
    '$1[已脱敏]@'
  );
  text = text.replace(/([?&])([^=&\s]+)=([^&\s]+)/g, (match, prefix, key) =>
    isSensitiveKey(key) ? `${prefix}${key}=[已脱敏]` : match);
  text = text.replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
    (match, openQuote, key, separator) => isSensitiveKey(key)
      ? `${openQuote}${key}${separator}[已脱敏]`
      : match
  );
  text = text.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[JWT已脱敏]');
  return text.slice(0, Math.max(Number(maxLength) || 2000, 1));
}

function sanitizeJobResult(value, depth = 0) {
  if (depth > 8) return '[内容层级过深]';
  if (typeof value === 'string') return sanitizeJobError(value, 4000);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeJobResult(item, depth + 1));
  if (typeof value !== 'object') return sanitizeJobError(value, 4000);
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    result[key] = isSensitiveKey(key)
      ? '[已脱敏]'
      : sanitizeJobResult(item, depth + 1);
  }
  return result;
}

module.exports = { sanitizeJobError, sanitizeJobResult, isSensitiveKey };
