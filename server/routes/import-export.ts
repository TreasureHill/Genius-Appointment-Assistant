import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../auth";
import { importRows, parseWorkbook } from "../../lib/importer";
import { blankTemplateBuffer, exportCurrent } from "../../lib/exporter";

export const importExportRouter = Router();
importExportRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

importExportRouter.post("/import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  const rows = await parseWorkbook(req.file.buffer);
  const summary = await importRows(rows, req.file.originalname);
  res.json(summary);
});

importExportRouter.get("/import/template", (_req, res) => {
  const buf = blankTemplateBuffer();
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", 'attachment; filename="contacts-template.xlsx"');
  res.send(buf);
});

importExportRouter.get("/export", async (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const buf = await exportCurrent(projectId);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="contacts-${projectId ?? "all"}-${Date.now()}.xlsx"`
  );
  res.send(buf);
});
