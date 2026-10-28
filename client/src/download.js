import { api } from './api';

// Fetch a file through the API (cookie auth) and trigger a browser download.
// Shared by the Reviews exports, contract documents (admin) and the portal's
// signed-agreement downloads. Throws an Error with the server's error code on
// failure so callers can show it.
export async function downloadFile(url, fallbackName) {
  const res = await api.raw(url);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      msg = data.error || data.message || msg;
    } catch {
      /* not json */
    }
    throw new Error(msg || 'Download failed');
  }
  const disposition = res.headers.get('content-disposition') || '';
  const m = /filename="?([^";]+)"?/i.exec(disposition);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = (m && m[1]) || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
