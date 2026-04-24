const XLSX = require('xlsx');
const Project = require('../models/Project');
const Lot = require('../models/Lot');
const Rep = require('../models/Rep');

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
  assignedRep: ['assigned rep', 'rep', 'sales rep'],
  status: ['status'],
};

function normalize(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
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

async function preview(buffer) {
  const { headerMap, dataRows } = parseRows(buffer);
  const missing = ['project', 'lotNumber'].filter((k) => headerMap[k] == null);
  if (missing.length) {
    throw new Error(`Missing required columns: ${missing.join(', ')}`);
  }

  const projectsSeen = new Map(); // name -> {name, isNew}
  const toCreate = [];
  const toSkip = [];
  const warnings = [];

  const existingProjects = await Project.find({}).lean();
  const projectByName = new Map(existingProjects.map((p) => [p.name.toLowerCase(), p]));

  const existingLotsKey = new Set();
  const allLots = await Lot.find({}, { project: 1, lotNumber: 1 }).lean();
  for (const l of allLots) existingLotsKey.add(`${l.project}:${l.lotNumber}`);

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const projectName = cell(row, headerMap.project);
    const lotNumber = cell(row, headerMap.lotNumber);
    if (!projectName || !lotNumber) {
      warnings.push(`Row ${i + 2}: missing project or lot #, skipped`);
      continue;
    }
    const existing = projectByName.get(projectName.toLowerCase());
    if (!existing && !projectsSeen.has(projectName)) {
      projectsSeen.set(projectName, { name: projectName, isNew: true });
    } else if (existing && !projectsSeen.has(projectName)) {
      projectsSeen.set(projectName, { name: projectName, isNew: false, id: String(existing._id) });
    }

    const key = existing ? `${existing._id}:${lotNumber}` : `NEW:${projectName}:${lotNumber}`;
    const buyers = buildBuyers(row, headerMap);
    const entry = {
      rowNumber: i + 2,
      projectName,
      lotNumber,
      address: cell(row, headerMap.address),
      buyers,
      assignedRepName: cell(row, headerMap.assignedRep),
      status: cell(row, headerMap.status).toLowerCase() || 'pending',
    };
    if (existing && existingLotsKey.has(key)) {
      toSkip.push(entry);
    } else {
      toCreate.push(entry);
    }
  }

  return {
    projects: Array.from(projectsSeen.values()),
    toCreate,
    toSkip,
    warnings,
    totalRows: dataRows.length,
  };
}

async function commit(buffer, { updateExisting = false } = {}) {
  const { headerMap, dataRows } = parseRows(buffer);
  const missing = ['project', 'lotNumber'].filter((k) => headerMap[k] == null);
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(', ')}`);

  const result = {
    createdProjects: 0,
    createdLots: 0,
    updatedLots: 0,
    skippedLots: 0,
    warnings: [],
  };

  const projectCache = new Map();
  const repCache = new Map();

  async function getProject(name) {
    const key = name.toLowerCase();
    if (projectCache.has(key)) return projectCache.get(key);
    let p = await Project.findOne({ name });
    if (!p) {
      p = await Project.create({ name });
      result.createdProjects += 1;
    }
    projectCache.set(key, p);
    return p;
  }

  async function getRep(name) {
    if (!name) return null;
    const key = name.toLowerCase();
    if (repCache.has(key)) return repCache.get(key);
    const rep = await Rep.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
    repCache.set(key, rep || null);
    if (!rep) result.warnings.push(`Rep "${name}" not found — leaving lot unassigned`);
    return rep;
  }

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const projectName = cell(row, headerMap.project);
    const lotNumber = cell(row, headerMap.lotNumber);
    if (!projectName || !lotNumber) {
      result.warnings.push(`Row ${i + 2}: missing project or lot #, skipped`);
      continue;
    }
    const project = await getProject(projectName);
    const existing = await Lot.findOne({ project: project._id, lotNumber });
    const buyers = buildBuyers(row, headerMap);
    const rep = await getRep(cell(row, headerMap.assignedRep));
    const statusCell = cell(row, headerMap.status).toLowerCase();
    const status = Lot.STATUSES.includes(statusCell) ? statusCell : undefined;

    if (existing) {
      if (updateExisting) {
        existing.address = cell(row, headerMap.address) || existing.address;
        if (buyers.length) existing.buyers = buyers;
        if (rep) existing.assignedRep = rep._id;
        if (status) existing.status = status;
        await existing.save();
        result.updatedLots += 1;
      } else {
        result.skippedLots += 1;
      }
    } else {
      await Lot.create({
        project: project._id,
        lotNumber,
        address: cell(row, headerMap.address),
        buyers,
        assignedRep: rep ? rep._id : null,
        status: status || 'pending',
      });
      result.createdLots += 1;
    }
  }
  return result;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { preview, commit, parseRows, BUYER_ROLES };
