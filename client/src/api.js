async function request(method, url, body, opts = {}) {
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers,
    body: payload,
    ...opts,
  });
  const contentType = res.headers.get('content-type') || '';
  if (opts.raw) return res;
  if (!res.ok) {
    let msg = res.statusText;
    if (contentType.includes('application/json')) {
      try {
        const data = await res.json();
        msg = data.error || data.message || msg;
      } catch {}
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (contentType.includes('application/json')) return res.json();
  return res.text();
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
  upload: (url, formData) => request('POST', url, formData),
  raw: (url, opts) => request('GET', url, null, { ...opts, raw: true }),
};
