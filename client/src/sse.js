// POST a JSON body and read a Server-Sent Events response (the server's AI
// drafting streams). `onEvent` gets each parsed `data:` object. Returns a
// promise that resolves when the stream ends; `signal` aborts it.
export async function streamPost(url, body, { onEvent, signal } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body || {}),
    signal,
  });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('text/event-stream')) {
    let msg = res.statusText || 'Request failed';
    try {
      const data = await res.json();
      msg = data.error || data.message || msg;
    } catch {
      /* not json */
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          onEvent?.(JSON.parse(line.slice(6)));
        } catch {
          /* ignore malformed */
        }
      }
    }
  }
}
