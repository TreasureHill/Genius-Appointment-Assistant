import * as XLSX from "xlsx";
import { prisma } from "./prisma";
import { TEMPLATE_COLUMNS } from "./importer";

export function blankTemplateBuffer(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_COLUMNS as unknown as string[]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Contacts");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buf;
}

export async function exportCurrent(projectId?: string): Promise<Buffer> {
  const lots = await prisma.lot.findMany({
    where: projectId ? { projectId } : undefined,
    include: { project: true, buyers: true, assignedRep: true },
    orderBy: [{ project: { name: "asc" } }, { lotNumber: "asc" }],
  });

  const rows = lots.map((lot) => {
    const byRole = Object.fromEntries(lot.buyers.map((b) => [b.role, b]));
    const primary = byRole["PRIMARY"];
    const co = byRole["CO_BUYER"];
    const third = byRole["THIRD"];
    return {
      Project: lot.project.name,
      LotNumber: lot.lotNumber,
      Address: lot.address ?? "",
      Status: lot.status,
      AssignedRep: lot.assignedRep?.name ?? "",
      Buyer1Name: primary?.name ?? "",
      Buyer1Email: primary?.email ?? "",
      Buyer1Phone: primary?.phone ?? "",
      Buyer2Name: co?.name ?? "",
      Buyer2Email: co?.email ?? "",
      Buyer2Phone: co?.phone ?? "",
      Buyer3Name: third?.name ?? "",
      Buyer3Email: third?.email ?? "",
      Buyer3Phone: third?.phone ?? "",
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows, { header: TEMPLATE_COLUMNS as unknown as string[] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Contacts");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
