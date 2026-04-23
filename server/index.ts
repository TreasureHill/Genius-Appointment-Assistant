import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { ZodError } from "zod";

import { authRouter } from "./routes/auth";
import { projectsRouter } from "./routes/projects";
import { lotsRouter } from "./routes/lots";
import { repsRouter } from "./routes/reps";
import { templatesRouter } from "./routes/templates";
import { importExportRouter } from "./routes/import-export";
import { sendRouter } from "./routes/send";
import { settingsRouter } from "./routes/settings";
import { historyRouter } from "./routes/history";
import { webhooksRouter } from "./routes/webhooks";

import { startWorkers } from "../workers";

const app = express();

app.use(cookieParser());

app.use("/api/webhooks", express.urlencoded({ extended: true }));
app.use("/api/webhooks", express.json());
app.use("/api/webhooks", webhooksRouter);

app.use(express.json({ limit: "10mb" }));

app.use("/api/auth", authRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/lots", lotsRouter);
app.use("/api/reps", repsRouter);
app.use("/api/templates", templatesRouter);
app.use("/api", importExportRouter);
app.use("/api/send", sendRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/history", historyRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid request", details: err.flatten() });
    return;
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Server error" });
};
app.use(errorHandler);

const clientDist = path.resolve(process.cwd(), "dist/client");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.type("text/plain").send(
      "Client not built. Run `npm run build` (or `npm run dev` for hot reload)."
    );
  });
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

app.listen(port, host, () => {
  console.log(`[server] listening on http://${host}:${port}`);
  startWorkers();
});
