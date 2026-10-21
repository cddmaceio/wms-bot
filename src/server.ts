import express, { Request, Response, NextFunction } from "express";
import path from "node:path";
import { Service } from "./service";
import { AppError } from "./types";
import { authorized } from "./security";

function object(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
    throw new AppError("Corpo JSON obrigatório");
  return req.body;
}
class Controller {
  constructor(private service: Service) {}
  settings = (_req: Request, res: Response) =>
    res.json(this.service.settings.public());
  configure = (req: Request, res: Response) =>
    res.json(this.service.configure(object(req)));
  status = async (_req: Request, res: Response) =>
    res.json(await this.service.status());
  list = (_req: Request, res: Response) => res.json(this.service.list());
  create = (req: Request, res: Response) => {
    const result = this.service.create(object(req));
    res
      .status(result.created ? 202 : 200)
      .json(this.service.publicJob(result.job));
  };
  detail = (req: Request, res: Response) =>
    res.json(this.service.detail(String(req.params.id)));
  artifact = (req: Request, res: Response) => {
    const file = this.service.artifact(
      String(req.params.id),
      String(req.params.kind),
    );
    res.download(file, path.basename(file));
  };
  retry = (req: Request, res: Response) => {
    const input = object(req);
    const result = this.service.retryUpload(
      String(req.params.id),
      input.confirmed,
      input.requestKey,
    );
    res
      .status(result.created ? 202 : 200)
      .json(this.service.publicJob(result.job));
  };
  qr = async (_req: Request, res: Response) =>
    res.json(await this.service.bridge.qr());
  connect = async (_req: Request, res: Response) => {
    await this.service.connectWhatsApp();
    res.json({ ok: true });
  };
  test = (req: Request, res: Response) => {
    const input = object(req);
    res
      .status(202)
      .json({
        id: this.service.testMessage(
          input.recipient,
          input.confirmed,
          input.requestKey,
        ),
      });
  };
  deliveries = (_req: Request, res: Response) =>
    res.json(this.service.store.deliveries());
  reconcile = (req: Request, res: Response) => {
    const input = object(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1)
      throw new AppError("Identificador inválido");
    res.json(
      this.service.reconcileDelivery(
        id,
        input.action,
        input.note,
        input.confirmed,
      ),
    );
  };
  audits = (_req: Request, res: Response) =>
    res.json(this.service.store.audits());
}
export function createApp(
  service: Service,
  token: string,
  log: (event: string, detail?: unknown) => void = () => {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.get("/health", (_req, res) =>
    res
      .status(service.healthy() ? 200 : 503)
      .json({ service: "wms-bot", healthy: service.healthy() }),
  );
  app.get(["/", "/admin"], (_req, res) =>
    res.sendFile(path.resolve(__dirname, "../public/index.html")),
  );
  app.use(
    "/assets",
    express.static(path.resolve(__dirname, "../public"), { index: false }),
  );
  app.use((req, res, next) => {
    if (!authorized(req.headers.authorization, token)) {
      res.status(401).json({ error: "Autenticação Bearer obrigatória" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  const c = new Controller(service);
  const api = express.Router();
  api.get("/settings", c.settings);
  api.put("/settings", c.configure);
  api.get("/status", c.status);
  api.get("/jobs", c.list);
  api.post("/jobs", c.create);
  api.get("/jobs/:id", c.detail);
  api.get("/jobs/:id/artifacts/:kind", c.artifact);
  api.post("/jobs/:id/retry-upload", c.retry);
  api.get("/whatsapp/qr", c.qr);
  api.post("/whatsapp/connect", c.connect);
  api.post("/whatsapp/test", c.test);
  api.get("/deliveries", c.deliveries);
  api.post("/deliveries/:id/reconcile", c.reconcile);
  api.get("/audits", c.audits);
  app.use("/api", api);
  app.all(
    [
      "/run",
      "/upload-last",
      "/delete-files",
      "/files",
      "/session-status",
      "/download-last",
      "/view-last-csv",
      "/view-debug-last",
      "/download-debug-last",
    ],
    (_req, res) =>
      res
        .status(410)
        .json({
          error: "Rota substituída pela API /api/jobs; consulte README.md",
        }),
  );
  app.use((_req, res) =>
    res.status(404).json({ error: "Rota não encontrada" }),
  );
  app.use(
    (
      error: Error & { status?: number; type?: string },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      const status =
        error instanceof AppError
          ? error.status
          : error.type === "entity.parse.failed"
            ? 400
            : error.type === "entity.too.large"
              ? 413
              : 500;
      if (status === 500) log("http_error", { name: error.name });
      res
        .status(status)
        .json({
          error:
            status === 500
              ? "Falha interna; consulte o diagnóstico"
              : status === 413
                ? "Corpo excede 64 KB"
                : status === 400 && !(error instanceof AppError)
                  ? "JSON inválido"
                  : error.message,
        });
    },
  );
  return app;
}
