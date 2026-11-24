export function normalizeServiceUrl(value) {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Use a web address starting with http or https.');
  }
  return parsed.origin;
}

export function buildJoinUrl(serviceUrl, code) {
  if (!/^\d{6}$/.test(code)) throw new Error('A six-digit pairing code is required.');
  const destination = new URL('/', normalizeServiceUrl(serviceUrl));
  destination.hash = `join=${code}`;
  return destination.toString();
}

export function getServiceEndpoints(serviceUrl) {
  const base = new URL(normalizeServiceUrl(serviceUrl));
  const socketProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    health: new URL('/api/health', base).toString(),
    activity: new URL('/api/activity', base).toString(),
    relay: `${socketProtocol}//${base.host}/relay`,
  };
}
