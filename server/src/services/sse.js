// Server-Sent Events over a POST response (the browser reads it with fetch).
// Returns { emit, signal, end }: `signal` aborts when the client disconnects
// (closed tab, pressed Stop), so upstream work like a Claude stream stops too.
function openSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx / Caddy: don't buffer the stream.
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  // Keep idle proxies from closing the connection while Claude thinks.
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15_000);
  const emit = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const end = () => {
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  };
  return { emit, end, signal: controller.signal };
}

// Run `fn({ emit, signal })` as an SSE response, turning thrown errors into an
// `error` event the client can show.
async function streamResponse(req, res, fn) {
  const { emit, end, signal } = openSse(req, res);
  try {
    await fn({ emit, signal });
  } catch (err) {
    if (!err?.aborted) emit({ type: 'error', message: err?.message || 'Something went wrong.' });
  } finally {
    end();
  }
}

module.exports = { openSse, streamResponse };
