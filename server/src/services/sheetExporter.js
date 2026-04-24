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

module.exports = { HEADERS, buildBlankTemplate, buildExport };
