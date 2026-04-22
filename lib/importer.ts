import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { prisma } from "./prisma";

export const TEMPLATE_COLUMNS = [
  "Project",
  "LotNumber",
  "Address",
  "Status",
  "AssignedRep",
  "Buyer1Name",
  "Buyer1Email",
  "Buyer1Phone",
  "Buyer2Name",
  "Buyer2Email",
  "Buyer2Phone",
  "Buyer3Name",
  "Buyer3Email",
  "Buyer3Phone",
] as const;

type Row = Partial<Record<(typeof TEMPLATE_COLUMNS)[number], string>>;

const ALLOWED_STATUS = new Set(["NEW", "CONTACTED", "SCHEDULED", "BOOKED", "OPTED_OUT"]);

function norm(v: string | undefined): string {
  return (v ?? "").toString().trim();
}

function hashRow(r: Row): string {
  const parts = TEMPLATE_COLUMNS.map((c) => norm(r[c]).toLowerCase());
  return createHash("sha1").update(parts.join("")).digest("hex");
}

export type ImportSummary = {
  added: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
};

export async function parseWorkbook(buffer: ArrayBuffer | Buffer): Promise<Row[]> {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: "" });
  return rows;
}

export async function importRows(rows: Row[], filename: string): Promise<ImportSummary> {
  const summary: ImportSummary = { added: 0, updated: 0, skipped: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const projectName = norm(r.Project);
    const lotNumber = norm(r.LotNumber);
    if (!projectName || !lotNumber) {
      summary.errors.push({ row: i + 2, reason: "Missing Project or LotNumber" });
      continue;
    }

    const statusRaw = norm(r.Status).toUpperCase();
    const status = ALLOWED_STATUS.has(statusRaw) ? statusRaw : "NEW";

    const project = await prisma.project.upsert({
      where: { name: projectName },
      update: {},
      create: { name: projectName },
    });

    let repId: string | null = null;
    const repName = norm(r.AssignedRep);
    if (repName) {
      const rep = await prisma.rep.findFirst({ where: { name: repName } });
      if (rep) repId = rep.id;
      else {
        const created = await prisma.rep.create({ data: { name: repName } });
        repId = created.id;
      }
    }

    const rowHash = hashRow(r);
    const existing = await prisma.lot.findUnique({
      where: { projectId_lotNumber: { projectId: project.id, lotNumber } },
    });

    const buyerData = [
      { role: "PRIMARY", name: norm(r.Buyer1Name), email: norm(r.Buyer1Email), phone: norm(r.Buyer1Phone) },
      { role: "CO_BUYER", name: norm(r.Buyer2Name), email: norm(r.Buyer2Email), phone: norm(r.Buyer2Phone) },
      { role: "THIRD", name: norm(r.Buyer3Name), email: norm(r.Buyer3Email), phone: norm(r.Buyer3Phone) },
    ].filter((b) => b.name);

    if (!existing) {
      await prisma.lot.create({
        data: {
          projectId: project.id,
          lotNumber,
          address: norm(r.Address) || null,
          status,
          assignedRepId: repId,
          rowHash,
          buyers: {
            create: buyerData.map((b) => ({
              role: b.role,
              name: b.name,
              email: b.email || null,
              phone: b.phone || null,
            })),
          },
        },
      });
      summary.added++;
      continue;
    }

    if (existing.rowHash === rowHash) {
      summary.skipped++;
      continue;
    }

    if (existing.status === "BOOKED") {
      summary.errors.push({ row: i + 2, reason: "Lot is BOOKED; skipped update" });
      summary.skipped++;
      continue;
    }

    await prisma.$transaction([
      prisma.lot.update({
        where: { id: existing.id },
        data: {
          address: norm(r.Address) || null,
          status: existing.status === "SCHEDULED" ? existing.status : status,
          assignedRepId: repId,
          rowHash,
        },
      }),
      prisma.buyer.deleteMany({ where: { lotId: existing.id } }),
      ...buyerData.map((b) =>
        prisma.buyer.create({
          data: {
            lotId: existing.id,
            role: b.role,
            name: b.name,
            email: b.email || null,
            phone: b.phone || null,
          },
        })
      ),
    ]);
    summary.updated++;
  }

  await prisma.importBatch.create({
    data: {
      filename,
      added: summary.added,
      updated: summary.updated,
      skipped: summary.skipped,
      errorsJson: summary.errors.length ? JSON.stringify(summary.errors) : null,
    },
  });

  return summary;
}
