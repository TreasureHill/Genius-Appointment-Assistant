// Excel export of the Reviews tab: summary, per-rep table, the window's
// review log, and every review stored — one workbook.
const XLSX = require('xlsx');

function fmt(d, tz) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d));
  } catch {
    return new Date(d).toISOString();
  }
}

function reviewRows(list, repNames, tz) {
  const headers = ['Date (counts for)', 'Posted', 'Edited', 'Reviewer', 'Rating', 'Genius-related', 'Reps', 'Mapping', 'Matched on', 'Note', 'Review', 'Owner reply', 'Link'];
  const rows = [headers];
  for (const r of list) {
    const edited = r.editedAt && r.postedAt && new Date(r.editedAt) > new Date(r.postedAt);
    rows.push([
      fmt(r.effectiveAt, tz),
      fmt(r.postedAt, tz),
      edited ? fmt(r.editedAt, tz) : '',
      r.reviewer || '',
      Number(r.rating) || 0,
      r.genius ? 'yes' : 'no',
      (r.reps || []).map((id) => repNames.get(String(id && id._id ? id._id : id)) || '').filter(Boolean).join(', '),
      r.mappingSource === 'manual' ? 'manual' : 'auto',
      [...((r.auto && r.auto.aliases) || []), ...((r.auto && r.auto.terms) || [])].join(', '),
      (r.manual && r.manual.note) || '',
      r.text || '',
      (r.reply && r.reply.text) || '',
      r.link || '',
    ]);
  }
  return rows;
}

function sheet(wb, name, rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = (widths || rows[0].map(() => 18)).map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, name);
}

// stats: computeStats() output; allReviews: every stored review (lean);
// reps: [{ _id, name }]
function buildWorkbook({ stats, allReviews = [], reps = [], tz = 'UTC', listing = null, generatedAt = new Date() }) {
  const wb = XLSX.utils.book_new();
  const repNames = new Map(reps.map((r) => [String(r._id), r.name]));

  const w = stats.week;
  const a = stats.allTime;
  sheet(
    wb,
    'Summary',
    [
      ['Genius Google Reviews', stats.window.label],
      ['Window start', stats.window.start],
      ['Window end', stats.window.end],
      ['Timezone', tz],
      ['Generated', fmt(generatedAt, tz)],
      [],
      ['This window', ''],
      ['Reviews on the listing', w.total],
      ['Genius-related', w.genius],
      ['Not Genius-related', w.other],
      ['Genius 5-star', w.geniusFiveStar],
      ['Genius average rating', w.geniusAvgRating],
      ['Rated 3 stars or less', w.lowRated],
      ['Without an owner reply', w.unreplied],
      ['Genius but mapped to nobody', w.unmapped],
      [],
      ['All time (stored)', ''],
      ['Reviews stored', a.total],
      ['Genius-related', a.genius],
      ['Genius 5-star', a.geniusFiveStar],
      ['Genius average rating', a.geniusAvgRating],
      [],
      ['Listing (Google)', ''],
      ['Total reviews', listing && listing.total != null ? listing.total : ''],
      ['Average rating', listing && listing.rating != null ? listing.rating : ''],
    ],
    [34, 40]
  );

  sheet(
    wb,
    'Reps',
    [
      ['Rep', 'This window', '5-star this window', 'All time', '5-star all time', 'Average rating'],
      ...stats.reps.map((r) => [r.name, r.week, r.weekFiveStar, r.allTime, r.allTimeFiveStar, r.avgRating]),
    ],
    [22, 14, 18, 12, 16, 16]
  );

  const widths = [20, 20, 20, 24, 8, 14, 22, 10, 26, 30, 80, 50, 40];
  sheet(wb, 'Review log', reviewRows(stats.weekReviews || [], repNames, tz), widths);
  sheet(wb, 'All reviews', reviewRows(allReviews, repNames, tz), widths);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildWorkbook };
