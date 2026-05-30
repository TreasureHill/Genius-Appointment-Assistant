const DEFAULT_PAGE_SIZES = [25, 50, 100, 200];

// Reusable pagination footer. Works for both server-paged lists (History,
// Calendly) and client-paged lists (Board). Pass total/page/pages plus the
// onPage / onPageSize callbacks; everything else is presentational.
export default function Pagination({
  page,
  pages,
  total,
  pageSize,
  onPage,
  onPageSize,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  loading = false,
  noun = 'rows',
}) {
  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(total, page * pageSize);

  function goto(p) {
    if (loading) return;
    const next = Math.min(Math.max(1, p), pages);
    if (next !== page) onPage(next);
  }

  return (
    <div className="pagination">
      <div className="muted" style={{ fontSize: 12 }}>
        {total === 0
          ? `No ${noun}`
          : `Showing ${startRow.toLocaleString()}–${endRow.toLocaleString()} of ${total.toLocaleString()} ${noun}`}
      </div>
      <div style={{ flex: 1 }} />
      {onPageSize && (
        <>
          <label className="muted" style={{ fontSize: 12, margin: 0 }}>
            Per page&nbsp;
          </label>
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            style={{ width: 'auto' }}
            disabled={loading}
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </>
      )}
      <button className="secondary" disabled={page <= 1 || loading} onClick={() => goto(1)}>
        « First
      </button>
      <button className="secondary" disabled={page <= 1 || loading} onClick={() => goto(page - 1)}>
        ‹ Prev
      </button>
      <span className="muted" style={{ fontSize: 12, padding: '0 6px' }}>
        Page {page} of {pages}
      </span>
      <button className="secondary" disabled={page >= pages || loading} onClick={() => goto(page + 1)}>
        Next ›
      </button>
      <button className="secondary" disabled={page >= pages || loading} onClick={() => goto(pages)}>
        Last »
      </button>
    </div>
  );
}
