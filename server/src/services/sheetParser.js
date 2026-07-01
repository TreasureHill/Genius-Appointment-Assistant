const XLSX = require('xlsx');
const Project = require('../models/Project');
const Lot = require('../models/Lot');
const ImportBatch = require('../models/ImportBatch');

const BUYER_ROLES = ['buyer', 'coBuyer', 'thirdBuyer'];

const HEADER_ALIASES = {
  project: ['project', 'project name', 'community'],
  lotNumber: ['lot #', 'lot number', 'lot', 'lot no'],
  address: ['address', 'street', 'lot address'],
  buyerName: ['buyer name', 'buyer'],
  buyerEmail: ['buyer email'],
  buyerPhone: ['buyer phone', 'buyer mobile'],
  coBuyerName: ['co-buyer name', 'cobuyer name', 'co buyer name'],
  coBuyerEmail: ['co-buyer email', 'cobuyer email', 'co buyer email'],
  coBuyerPhone: ['co-buyer phone', 'cobuyer phone', 'co buyer phone'],
  thirdBuyerName: ['third buyer name', 'third buyer'],
  thirdBuyerEmail: ['third buyer email'],
  thirdBuyerPhone: ['third buyer phone'],
  status: ['status'],
};

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildHeaderMap(headerRow) {
  const map = {};
  headerRow.forEach((h, idx) => {
    const norm = normalize(h);
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(norm)) {
        map[key] = idx;
        break;
      }
    }
  });
  return map;
}

function cell(row, idx) {
  if (idx == null) return '';
  const v = row[idx];
  if (v == null) return '';
  return String(v).trim();
}

function parseRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('No sheet found in workbook');
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  if (rows.length === 0) return { headerMap: {}, dataRows: [] };
  const headerMap = buildHeaderMap(rows[0]);
  const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c || '').trim()));
  return { headerMap, dataRows };
}

function buildBuyers(row, hm) {
  const list = [];
  const triplets = [
    { role: 'buyer', n: hm.buyerName, e: hm.buyerEmail, p: hm.buyerPhone },
    { role: 'coBuyer', n: hm.coBuyerName, e: hm.coBuyerEmail, p: hm.coBuyerPhone },
    { role: 'thirdBuyer', n: hm.thirdBuyerName, e: hm.thirdBuyerEmail, p: hm.thirdBuyerPhone },
  ];
  for (const t of triplets) {
    const name = cell(row, t.n);
    const email = cell(row, t.e).toLowerCase();
    const phone = cell(row, t.p);
    if (name || email || phone) {
      list.push({ role: t.role, name, email, phone, optedOut: false });
    }
  }
  return list;
}

// Preview what will happen without touching the database. Groups by project
// so the UI can show "5 new lots under existing Project A" vs "3 new lots
// creating new Project B".
async function preview(buffer) {
  const { headerMap, dataRows } = parseRows(buffer);
  const missing = ['project', 'lotNumber'].filter((k) => headerMap[k] == null);
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(', ')}`);

  const existingProjects = await Project.find({}).lean();
  const projectByName = new Map(existingProjects.map((p) => [p.name.toLowerCase(), p]));

  const existingLotKey = new Set();
  const allLots = await Lot.find({}, { project: 1, lotNumber: 1 }).lean();
  for (const l of allLots) existingLotKey.add(`${l.project}:${l.lotNumber}`);

  const byProject = new Map(); // normalized project name -> { name, isNew, toCreate:[], toSkip:[] }
  const warnings = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const projectName = cell(row, headerMap.project);
    const lotNumber = cell(row, headerMap.lotNumber);
    if (!projectName || !lotNumber) {
      warnings.push(`Row ${i + 2}: missing project or lot #, skipped`);
      continue;
    }
    const pkey = projectName.toLowerCase();
    const existing = projectByName.get(pkey);
    if (!byProject.has(pkey)) {
      byProject.set(pkey, {
        name: projectName,
        isNew: !existing,
        projectId: existing ? String(existing._id) : null,
        toCreate: [],
        toSkip: [],
      });
    }
    const bucket = byProject.get(pkey);
    const entry = {
      rowNumber: i + 2,
      lotNumber,
      address: cell(row, headerMap.address),
      buyers: buildBuyers(row, headerMap),
      status: cell(row, headerMap.status).toLowerCase() || 'pending',
    };
    const key = existing ? `${existing._id}:${lotNumber}` : `NEW:${projectName}:${lotNumber}`;
    if (existing && existingLotKey.has(key)) {
      bucket.toSkip.push(entry);
    } else {
      bucket.toCreate.push(entry);
    }
  }

  const projects = Array.from(byProject.values());
  return {
    projects,
    totalRows: dataRows.length,
    totalNew: projects.reduce((n, p) => n + p.toCreate.length, 0),
    totalSkip: projects.reduce((n, p) => n + p.toSkip.length, 0),
    newProjectCount: projects.filter((p) => p.isNew).length,
    warnings,
  };
}

// Actually write changes. Every insert/update is recorded on an ImportBatch
// row so the user can revert the whole upload.
async function commit(buffer, { updateExisting = false, filename = '', marketingNames = {} } = {}) {
  const { headerMap, dataRows } = parseRows(buffer);
  const missing = ['project', 'lotNumber'].filter((k) => headerMap[k] == null);
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(', ')}`);

  // Normalize the supplied marketing names to a lowercased lookup.
  const mktMap = new Map();
  for (const [k, v] of Object.entries(marketingNames || {})) {
    mktMap.set(String(k).trim().toLowerCase(), String(v || '').trim());
  }

  // Every project the sheet references that doesn't already exist is "new" and
  // must carry a marketing name. Validate up front so we never write a partial
  // import before failing.
  const sheetProjectNames = new Map(); // lowercased -> original
  for (const row of dataRows) {
    const name = cell(row, headerMap.project);
    if (name) sheetProjectNames.set(name.toLowerCase(), name);
  }
  const existing = await Project.find({}).select('name').lean();
  const existingLower = new Set(existing.map((p) => p.name.toLowerCase()));
  const missingMarketing = [];
  for (const [lower, original] of sheetProjectNames) {
    if (existingLower.has(lower)) continue; // existing project — not required
    if (!mktMap.get(lower)) missingMarketing.push(original);
  }
  if (missingMarketing.length) {
    const err = new Error(
      `Marketing name required for new project${missingMarketing.length === 1 ? '' : 's'}: ${missingMarketing.join(', ')}`
    );
    err.code = 'marketing_name_required';
    err.projects = missingMarketing;
    throw err;
  }

  const batch = await ImportBatch.create({
    filename,
    updateExisting: Boolean(updateExisting),
    totalRows: dataRows.length,
  });

  const result = {
    batchId: String(batch._id),
    createdProjects: 0,
    createdLots: 0,
    updatedLots: 0,
    skippedLots: 0,
    warnings: [],
  };

  const projectCache = new Map();

  async function getProject(name) {
    const key = name.toLowerCase();
    if (projectCache.has(key)) {
      return { project: projectCache.get(key), created: false };
    }
    let p = await Project.findOne({ name });
    let created = false;
    if (!p) {
      p = await Project.create({ name, marketingName: mktMap.get(key) || '' });
      created = true;
      result.createdProjects += 1;
      batch.createdProjects.push(p._id);
    }
    projectCache.set(key, p);
    return { project: p, created };
  }

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNum = i + 2;
    try {
      const projectName = cell(row, headerMap.project);
      const lotNumber = cell(row, headerMap.lotNumber);
      if (!projectName || !lotNumber) {
        result.warnings.push(`Row ${rowNum}: missing project or lot #, skipped`);
        continue;
      }
      const { project } = await getProject(projectName);
      const existing = await Lot.findOne({ project: project._id, lotNumber });
      const buyers = buildBuyers(row, headerMap);
      const statusCell = cell(row, headerMap.status).toLowerCase();
      const status = Lot.STATUSES.includes(statusCell) ? statusCell : undefined;

      if (existing) {
        if (updateExisting) {
          batch.updatedLotSnapshots.push({
            lotId: existing._id,
            prev: {
              address: existing.address,
              buyers: existing.buyers.map((b) => ({
                role: b.role,
                name: b.name,
                email: b.email,
                phone: b.phone,
                optedOut: b.optedOut,
              })),
              status: existing.status,
            },
          });
          existing.address = cell(row, headerMap.address) || existing.address;
          if (buyers.length) existing.buyers = buyers;
          if (status) existing.status = status;
          await existing.save();
          result.updatedLots += 1;
        } else {
          result.skippedLots += 1;
        }
      } else {
        const created = await Lot.create({
          project: project._id,
          lotNumber,
          address: cell(row, headerMap.address),
          buyers,
          status: status || 'pending',
          importBatch: batch._id,
        });
        result.createdLots += 1;
        batch.createdLots.push(created._id);
      }
    } catch (err) {
      result.warnings.push(`Row ${rowNum}: ${err.message}`);
    }
  }

  batch.warnings = result.warnings;
  await batch.save();
  return result;
}

// Undo a batch: delete the lots we created, restore snapshots for lots we
// updated, and delete any projects we created if they have no lots left.
async function revert(batchId) {
  const batch = await ImportBatch.findById(batchId);
  if (!batch) throw new Error('Import batch not found');
  if (batch.status === 'reverted') throw new Error('Already reverted');

  const Outbox = require('../models/Outbox');
  let deletedLots = 0;
  let restoredLots = 0;
  let deletedProjects = 0;

  // 1. Delete created lots + any pending outbox rows for them
  if (batch.createdLots.length) {
    await Outbox.deleteMany({ lot: { $in: batch.createdLots } });
    const del = await Lot.deleteMany({ _id: { $in: batch.createdLots } });
    deletedLots = del.deletedCount || 0;
  }

  // 2. Restore overwritten lots
  for (const snap of batch.updatedLotSnapshots || []) {
    const lot = await Lot.findById(snap.lotId);
    if (!lot) continue;
    const prev = snap.prev || {};
    if (prev.address != null) lot.address = prev.address;
    if (Array.isArray(prev.buyers)) lot.buyers = prev.buyers;
    if (prev.status) lot.status = prev.status;
    await lot.save();
    restoredLots += 1;
  }

  // 3. Delete any projects we created that now have zero lots
  if (batch.createdProjects.length) {
    for (const pid of batch.createdProjects) {
      const remaining = await Lot.countDocuments({ project: pid });
      if (remaining === 0) {
        await Project.deleteOne({ _id: pid });
        deletedProjects += 1;
      }
    }
  }

  batch.status = 'reverted';
  batch.revertedAt = new Date();
  await batch.save();

  return { deletedLots, restoredLots, deletedProjects };
}

module.exports = { preview, commit, revert, parseRows, BUYER_ROLES };
