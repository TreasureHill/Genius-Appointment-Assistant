const XLSX = require('xlsx');

const HEADERS = [
  'Project',
  'Lot #',
  'Address',
  'Buyer Name',
  'Buyer Email',
  'Buyer Phone',
  'Co-Buyer Name',
  'Co-Buyer Email',
  'Co-Buyer Phone',
  'Third Buyer Name',
  'Third Buyer Email',
  'Third Buyer Phone',
  'Status',
];

function buildBlankTemplate() {
  const examples = [
    [
      'Riverside Phase 1',
      '101',
      '101 River Rd',
      'Jane Owner',
      'jane@example.com',
      '+15555550101',
      'John Owner',
      'john@example.com',
      '+15555550102',
      '',
      '',
      '',
      'pending',
    ],
    [
      'Riverside Phase 1',
      '102',
      '102 River Rd',
      'Jim Owner',
      'jim@example.com',
      '+15555550103',
      '',
      '',
      '',
      '',
      '',
      '',
      'pending',
    ],
    [
      'Hilltop Phase 2',
      '1',
      '1 Hilltop Ln',
      'Pat Owner',
      'pat@example.com',
      '+15555550104',
      '',
      '',
      '',
      '',
      '',
      '',
      'pending',
    ],
  ];
  const rows = [HEADERS, ...examples];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = HEADERS.map(() => ({ wch: 22 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildExport(lots) {
  const rows = [HEADERS];
  for (const lot of lots) {
    const project = lot.project?.name || '';
    const b = lot.buyers || [];
    const byRole = (role) => b.find((x) => x.role === role) || {};
    const buyer = byRole('buyer');
    const co = byRole('coBuyer');
    const third = byRole('thirdBuyer');
    rows.push([
      project,
      lot.lotNumber || '',
      lot.address || '',
      buyer.name || '',
      buyer.email || '',
      buyer.phone || '',
      co.name || '',
      co.email || '',
      co.phone || '',
      third.name || '',
      third.email || '',
      third.phone || '',
      lot.status || '',
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = HEADERS.map(() => ({ wch: 22 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildStatusReport(perProject, lotsByProject) {
  const wb = XLSX.utils.book_new();

  // Summary sheet — one row per project with totals by status
  const summaryHeaders = [
    'Project',
    'Total Lots',
    'Pending',
    'Contacted',
    'Scheduled',
    'Opted Out',
    '% Scheduled',
  ];
  const summaryRows = [summaryHeaders];
  let grand = { total: 0, pending: 0, contacted: 0, scheduled: 0, opted_out: 0 };
  for (const p of perProject) {
    const s = p.byStatus || {};
    const total = p.totalLots || 0;
    summaryRows.push([
      p.name,
      total,
      s.pending || 0,
      s.contacted || 0,
      s.scheduled || 0,
      s.opted_out || 0,
      total ? Math.round(((s.scheduled || 0) / total) * 100) + '%' : '0%',
    ]);
    grand.total += total;
    grand.pending += s.pending || 0;
    grand.contacted += s.contacted || 0;
    grand.scheduled += s.scheduled || 0;
    grand.opted_out += s.opted_out || 0;
  }
  summaryRows.push([
    'TOTAL',
    grand.total,
    grand.pending,
    grand.contacted,
    grand.scheduled,
    grand.opted_out,
    grand.total ? Math.round((grand.scheduled / grand.total) * 100) + '%' : '0%',
  ]);
  const sumWs = XLSX.utils.aoa_to_sheet(summaryRows);
  sumWs['!cols'] = summaryHeaders.map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, sumWs, 'Summary');

  // Detail sheet — every lot with its status, project, and primary contact
  const detailHeaders = [
    'Project',
    'Lot #',
    'Status',
    'Address',
    'Buyer',
    'Buyer Email',
    'Buyer Phone',
    'Co-Buyer',
    'Co-Buyer Email',
    'Co-Buyer Phone',
    'Reminders Sent',
    'Last Contacted',
    'Calendly Event',
    'Calendly Time',
  ];
  const detailRows = [detailHeaders];
  for (const lot of lotsByProject) {
    const projectName = lot.project?.name || '';
    const byRole = (role) => (lot.buyers || []).find((x) => x.role === role) || {};
    const buyer = byRole('buyer');
    const co = byRole('coBuyer');
    detailRows.push([
      projectName,
      lot.lotNumber || '',
      lot.status || '',
      lot.address || '',
      buyer.name || '',
      buyer.email || '',
      buyer.phone || '',
      co.name || '',
      co.email || '',
      co.phone || '',
      lot.reminderCount || 0,
      lot.lastContactedAt ? new Date(lot.lastContactedAt).toLocaleString() : '',
      lot.calendlyEvent?.name || '',
      lot.calendlyEvent?.startTime ? new Date(lot.calendlyEvent.startTime).toLocaleString() : '',
    ]);
  }
  const detailWs = XLSX.utils.aoa_to_sheet(detailRows);
  detailWs['!cols'] = detailHeaders.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, detailWs, 'All Lots');

  // One sheet per status for easy filtering by stakeholders
  for (const status of ['pending', 'contacted', 'scheduled', 'opted_out']) {
    const subset = lotsByProject.filter((l) => l.status === status);
    const rows = [detailHeaders];
    for (const lot of subset) {
      const projectName = lot.project?.name || '';
      const byRole = (role) => (lot.buyers || []).find((x) => x.role === role) || {};
      const buyer = byRole('buyer');
      const co = byRole('coBuyer');
      rows.push([
        projectName,
        lot.lotNumber || '',
        lot.status || '',
        lot.address || '',
        buyer.name || '',
        buyer.email || '',
        buyer.phone || '',
        co.name || '',
        co.email || '',
        co.phone || '',
        lot.reminderCount || 0,
        lot.lastContactedAt ? new Date(lot.lastContactedAt).toLocaleString() : '',
        lot.calendlyEvent?.name || '',
        lot.calendlyEvent?.startTime ? new Date(lot.calendlyEvent.startTime).toLocaleString() : '',
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = detailHeaders.map(() => ({ wch: 20 }));
    XLSX.utils.book_append_sheet(wb, ws, status.replace('_', ' '));
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { HEADERS, buildBlankTemplate, buildExport, buildStatusReport };
