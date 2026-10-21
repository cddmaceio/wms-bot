import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "./store";
import { SettingsService } from "./settings";
import { AppError, Job, Settings } from "./types";
import { localTime, validateDate } from "./time";
import { redact, requireConfirmation } from "./security";
import { readCsv } from "./csv";
import { uploadRecords } from "./upload";
import { WhatsAppBridge } from "./bridge";
import { Scheduler, nextSlots } from "./scheduler";

type Downloader = (
  settings: Settings,
  directory: string,
  session: string,
  date: string,
  signal?: AbortSignal,
) => Promise<{ file: string; screenshot?: string }>;
const stamp = () => new Date().toISOString();
const terminal = [
  "completed",
  "partial",
  "failed",
  "uncertain",
  "no_data",
  "downloaded",
];
export class Service {
  private active?: Promise<void>;
  private sending?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private abort = new AbortController();
  private lastCleanup = 0;
  readonly scheduler: Scheduler;
  lastTick = Date.now();
  workerError: string | null = null;
  constructor(
    readonly store: Store,
    readonly settings: SettingsService,
    readonly data: string,
    readonly bridge: WhatsAppBridge,
    private downloader: Downloader = require("../automation/wms.cjs"),
    private upload = uploadRecords,
    private log: (event: string, detail?: unknown) => void = () => {},
  ) {
    fs.mkdirSync(path.join(data, "jobs"), { recursive: true });
    this.store.recover();
    // Recupera a criação da notificação se o processo terminou entre o resultado e o planejamento.
    for (const job of store.unplannedNotifications()) this.notify(job);
    this.scheduler = new Scheduler(
      store,
      () => settings.get(),
      (date, key) => this.create({ date, requestKey: key }, "schedule").job.id,
    );
  }
  private config(job: Job): Settings {
    return this.settings.vault.open<Settings>(job.config);
  }
  private secrets(s: Settings) {
    return [s.wmsPass, s.apiToken];
  }
  create(input: Record<string, unknown>, source = "manual") {
    const s = this.settings.get();
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !["date", "requestKey"].includes(k))
    )
      throw new AppError("Informe somente date e requestKey");
    const date =
      input.date === undefined
        ? localTime(new Date(), s.timezone).date
        : validateDate(input.date, s.timezone);
    const key =
      input.requestKey === undefined ? randomUUID() : input.requestKey;
    if (typeof key !== "string" || key.length < 1 || key.length > 200)
      throw new AppError("requestKey deve ter entre 1 e 200 caracteres");
    if (source === "manual" && /^(schedule:|test:)/.test(key))
      throw new AppError("Prefixo de requestKey reservado");
    return this.store.create(date, key, source, this.settings.vault.seal(s));
  }
  detail(id: string) {
    const job = this.store.get(id);
    if (!job) throw new AppError("Execução não encontrada", 404);
    return {
      ...this.publicJob(job),
      attempts: this.store.attempts(id),
      deliveries: this.store.deliveries(id),
    };
  }
  publicJob(job: Job) {
    const { config, ...publicJob } = job;
    return publicJob;
  }
  list() {
    return this.store.list().map((job) => this.publicJob(job));
  }
  artifact(id: string, kind: string) {
    const job = this.store.get(id);
    if (!job) throw new AppError("Execução não encontrada", 404);
    const file =
      kind === "csv" ? job.file : kind === "screenshot" ? job.screenshot : null;
    if (!file || !fs.existsSync(file))
      throw new AppError("Arquivo indisponível ou removido por retenção", 404);
    const root = fs.realpathSync(path.join(this.data, "jobs")) + path.sep;
    const real = fs.realpathSync(file);
    if (!real.startsWith(root))
      throw new AppError("Arquivo fora do volume de execuções", 403);
    return real;
  }
  retryUpload(id: string, confirmed: unknown, requestKey: unknown) {
    requireConfirmation(
      confirmed,
      "Confira o destino e confirme o reenvio do arquivo",
    );
    const origin = this.store.get(id);
    if (!origin) throw new AppError("Execução não encontrada", 404);
    if (!terminal.includes(origin.state))
      throw new AppError("Aguarde a execução terminar", 409);
    const file = this.artifact(id, "csv");
    if (
      typeof requestKey !== "string" ||
      !requestKey ||
      requestKey.length > 200
    )
      throw new AppError("requestKey obrigatória");
    if (!this.settings.get().apiUrl)
      throw new AppError("Configure a API de destino");
    return this.store.transaction(() => {
      const old = this.store.db
        .prepare("SELECT id FROM jobs WHERE requestKey=?")
        .get(requestKey) as { id: string } | undefined;
      if (old) {
        const job = this.store.get(old.id)!;
        if (job.source !== `upload:${id}`)
          throw new AppError("Chave já utilizada", 409);
        return { job, created: false };
      }
      if (
        this.store.db
          .prepare(
            "SELECT id FROM jobs WHERE state IN ('queued','downloading','validating','uploading') LIMIT 1",
          )
          .get()
      )
        throw new AppError(
          "Há execução em andamento; aguarde para reenviar",
          409,
        );
      const result = this.store.create(
        origin.date,
        requestKey,
        `upload:${id}`,
        this.settings.vault.seal(this.settings.get()),
      );
      const directory = path.join(this.data, "jobs", result.job.id);
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, path.basename(file));
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      this.store.update(result.job.id, { file: target });
      this.store.audit("upload_retry", { source: id, job: result.job.id });
      return { job: this.store.get(result.job.id)!, created: true };
    });
  }
  configure(patch: Record<string, unknown>) {
    const before = this.settings.get();
    const result = this.settings.update(patch);
    if (
      ["scheduleEnabled", "times", "weekdays", "timezone"].some(
        (k) => k in patch,
      )
    )
      this.store.setMeta(
        "scheduler_checkpoint",
        String(Math.floor(Date.now() / 60000) * 60000),
      );
    if (before.whatsappEnabled !== this.settings.get().whatsappEnabled)
      void this.bridge
        .configure(this.settings.get().whatsappEnabled)
        .catch(() => this.log("whatsapp_configure_pending"));
    return result;
  }
  async connectWhatsApp() {
    if (!this.settings.get().whatsappEnabled)
      throw new AppError("Habilite o WhatsApp nas configurações");
    await this.bridge.connect();
  }
  testMessage(recipient: unknown, confirmed: unknown, requestKey: unknown) {
    requireConfirmation(confirmed, "Confirme o envio de teste");
    const s = this.settings.get();
    if (!s.whatsappEnabled || !s.sendEnabled)
      throw new AppError("Habilite WhatsApp e envio nas configurações");
    if (typeof recipient !== "string" || !s.recipients.includes(recipient))
      throw new AppError("Escolha um destinatário cadastrado");
    if (
      typeof requestKey !== "string" ||
      !requestKey ||
      requestKey.length > 150
    )
      throw new AppError("requestKey obrigatória");
    return this.store.transaction(() => {
      const result = this.store.create(
        localTime(new Date(), s.timezone).date,
        `test:${requestKey}`,
        `notification-test`,
        this.settings.vault.seal(s),
      );
      if (!result.created) {
        const deliveries = this.store.deliveries(result.job.id);
        if (deliveries[0]?.recipient !== recipient)
          throw new AppError(
            "Chave de teste já usada para outro destinatário",
            409,
          );
        return result.job.id;
      }
      this.store.update(result.job.id, {
        state: "completed",
        finished: stamp(),
        summary: { message: "Teste WhatsApp" },
      });
      this.store.planDelivery(
        result.job.id,
        "test",
        recipient,
        `WMS Bot — TESTE DE NOTIFICAÇÃO\nExecução: ${result.job.id}`,
      );
      this.store.audit("whatsapp_test", { job: result.job.id, recipient });
      return result.job.id;
    });
  }
  reconcileDelivery(
    id: number,
    action: unknown,
    note: unknown,
    confirmed: unknown,
  ) {
    requireConfirmation(confirmed, "Confira a mensagem no aparelho e confirme");
    if (typeof note !== "string" || note.trim().length < 3 || note.length > 500)
      throw new AppError("Informe uma justificativa de 3 a 500 caracteres");
    return this.store.transaction(() => {
      const item = this.store.delivery(id);
      if (!item) throw new AppError("Mensagem não encontrada", 404);
      if (action === "skip" && item.state === "pending") {
        /* Cancelamento explícito de pendente. */
      } else if (!["uncertain", "blocked"].includes(item.state))
        throw new AppError(
          "Somente mensagens incertas ou bloqueadas podem ser conferidas",
          409,
        );
      if (!["confirm", "retry", "skip"].includes(String(action)))
        throw new AppError("Ação inválida");
      const state =
        action === "confirm"
          ? "confirmed"
          : action === "retry"
            ? "pending"
            : "skipped";
      this.store.updateDelivery(id, state, null, note.trim());
      this.store.audit("delivery_review", {
        id,
        previous: item.state,
        state,
        note: note.trim(),
      });
      return this.store.delivery(id);
    });
  }
  private notify(job: Job) {
    if (this.store.notificationPlanned(job.id)) return;
    const config = this.config(job);
    if (!config.events.includes(job.state)) {
      this.store.markNotificationPlanned(job.id);
      return;
    }
    const summary = job.summary;
    const elapsed = job.finished
      ? Math.max(
          0,
          Math.round(
            (Date.parse(job.finished) - Date.parse(job.created)) / 1000,
          ),
        )
      : 0;
    const label: Record<string, string> = {
      completed: "Importação concluída",
      partial: "Importação com pendências",
      failed: "Falha",
      uncertain: "Resultado incerto: conferir destino",
      no_data: "Sem dados",
      downloaded: "CSV baixado; API não configurada",
    };
    const text =
      `WMS Bot — ${label[job.state] || job.state}\nData: ${job.date}\nMapas: ${summary.maps ?? "—"} | Registros: ${summary.processed ?? summary.records ?? "—"}\nDuração: ${elapsed}s\n${job.error ? job.error + "\n" : ""}Execução: ${job.id}`.slice(
        0,
        3500,
      );
    this.store.transaction(() => {
      for (const recipient of config.recipients)
        this.store.planDelivery(job.id, job.state, recipient, text);
      this.store.markNotificationPlanned(job.id);
    });
  }
  private async process(job: Job) {
    const s = this.config(job);
    const directory = path.join(this.data, "jobs", job.id);
    fs.mkdirSync(directory, { recursive: true });
    try {
      if (!job.source.startsWith("upload:")) {
        this.store.update(job.id, { state: "downloading" });
        this.store.attempt(job.id, "download", "started");
        const result = await this.downloader(
          s,
          directory,
          path.join(this.data, "wms-profile", "storageState.json"),
          job.date,
          this.abort.signal,
        );
        this.store.update(job.id, {
          file: result.file,
          screenshot: result.screenshot || null,
        });
        this.store.attempt(job.id, "download", "completed");
      }
      this.store.update(job.id, { state: "validating" });
      const file = this.store.get(job.id)!.file;
      if (!file) throw new Error("CSV não disponível");
      const parsed = readCsv(this.artifact(job.id, "csv"));
      const summary: Record<string, unknown> = {
        records: parsed.records.length,
        rawCount: parsed.rawCount,
        duplicates: parsed.duplicates,
      };
      this.store.update(job.id, { summary });
      this.store.attempt(job.id, "validation", "completed", summary);
      if (!parsed.records.length)
        this.store.update(job.id, { state: "no_data", finished: stamp() });
      else if (!s.apiUrl)
        this.store.update(job.id, { state: "downloaded", finished: stamp() });
      else {
        this.store.update(job.id, { state: "uploading" });
        this.store.attempt(job.id, "upload", "started");
        const result = await this.upload(
          s,
          parsed.records,
          path.basename(file),
        );
        const clean = JSON.parse(
          JSON.stringify(result, (_key, value) =>
            typeof value === "string" ? redact(value, this.secrets(s)) : value,
          ),
        );
        this.store.update(job.id, {
          state: result.state,
          summary: { ...summary, ...clean },
          error: result.state === "completed" ? null : clean.message,
          finished: stamp(),
        });
        this.store.attempt(job.id, "upload", result.state, clean);
      }
    } catch (error) {
      const current = this.store.get(job.id)!;
      const state = current.state === "uploading" ? "uncertain" : "failed";
      const message = redact(error, this.secrets(s));
      const shot = fs
        .readdirSync(directory)
        .filter((f) => f.endsWith(".png"))
        .sort()
        .at(-1);
      this.store.update(job.id, {
        state,
        error: message,
        finished: stamp(),
        ...(shot ? { screenshot: path.join(directory, shot) } : {}),
      });
      this.store.attempt(job.id, current.state, state, message);
    }
    const result = this.store.get(job.id)!;
    this.notify(result);
    this.log("job_finished", { id: job.id, state: result.state });
  }
  private async deliver() {
    const s = this.settings.get();
    if (!s.whatsappEnabled || !s.sendEnabled) return;
    if (!(await this.bridge.status()).ready) return;
    for (const item of this.store.pending()) {
      if (this.stopping) return;
      const current = this.settings.get();
      if (!current.sendEnabled || !current.whatsappEnabled) return;
      if (!current.recipients.includes(item.recipient)) {
        this.store.updateDelivery(
          item.id,
          "skipped",
          null,
          "Destinatário removido",
        );
        continue;
      }
      // Não avançar mensagens posteriores de um destinatário com resultado incerto.
      const blocked = this.store.db
        .prepare(
          "SELECT id FROM deliveries WHERE recipient=? AND state IN ('uncertain','sending','blocked') AND id<>? LIMIT 1",
        )
        .get(item.recipient, item.id);
      if (blocked || !this.store.claimDelivery(item.id)) continue;
      try {
        const response = await this.bridge.send(item.recipient, item.text);
        const state =
          response.state === "not_sent"
            ? "pending"
            : ["confirmed", "uncertain", "blocked"].includes(response.state)
              ? response.state
              : "uncertain";
        this.store.updateDelivery(
          item.id,
          state,
          response.messageId || null,
          response.note || null,
        );
        if (state === "pending") break;
      } catch {
        this.store.updateDelivery(
          item.id,
          "uncertain",
          null,
          "Processo WhatsApp sem resposta; conferir no aparelho",
        );
      }
    }
  }
  cleanup(now = Date.now()) {
    const cutoff = new Date(
      now - this.settings.get().retentionDays * 86400000,
    ).toISOString();
    const candidates = this.store.db
      .prepare(
        "SELECT id FROM jobs WHERE finished<? AND state IN ('completed','no_data','downloaded','failed') AND (file IS NOT NULL OR screenshot IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.jobId=jobs.id AND d.state NOT IN ('confirmed','skipped'))",
      )
      .all(cutoff) as { id: string }[];
    for (const { id } of candidates) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const directory = path.join(this.data, "jobs", id);
      const root = fs.realpathSync(path.join(this.data, "jobs")) + path.sep;
      if (fs.existsSync(directory)) {
        const stat = fs.lstatSync(directory);
        if (
          stat.isSymbolicLink() ||
          !fs.realpathSync(directory).startsWith(root)
        )
          continue;
        fs.rmSync(directory, { recursive: true });
      }
      this.store.update(id, { file: null, screenshot: null });
      this.store.audit("artifacts_expired", { id });
    }
  }
  async status() {
    return {
      workerHealthy: !this.workerError,
      lastTick: new Date(this.lastTick).toISOString(),
      workerError: this.workerError,
      whatsapp: await this.bridge.status(),
      nextRuns: nextSlots(this.settings.get()),
      slots: this.store.slots(),
      disk: fs.statfsSync(this.data),
      settings: this.settings.public(),
    };
  }
  healthy() {
    return (
      !this.stopping && !this.workerError && Date.now() - this.lastTick < 30000
    );
  }
  async tick() {
    if (this.stopping) return;
    this.lastTick = Date.now();
    try {
      this.scheduler.tick();
      if (!this.active) {
        const job = this.store.byState("queued")[0];
        if (job)
          this.active = this.process(job)
            .catch((error) => {
              this.workerError = redact(error);
              this.log("worker_error", { error: this.workerError });
            })
            .finally(() => {
              this.active = undefined;
            });
      }
      if (!this.sending)
        this.sending = this.deliver()
          .catch((error) =>
            this.log("delivery_worker_error", { error: redact(error) }),
          )
          .finally(() => {
            this.sending = undefined;
          });
      if (Date.now() - this.lastCleanup > 3600000 && !this.active) {
        this.cleanup();
        this.lastCleanup = Date.now();
      }
    } catch (error) {
      this.workerError = redact(error);
      this.log("scheduler_error", { error: this.workerError });
    }
  }
  async start() {
    try {
      await this.bridge.configure(this.settings.get().whatsappEnabled);
    } catch {
      this.log("whatsapp_unavailable_on_start");
    }
    this.timer = setInterval(() => void this.tick(), 1000);
    await this.tick();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.bridge.stop();
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([this.active, this.sending]),
      new Promise((resolve) => {
          timeout = setTimeout(resolve, 20000);
      }),
    ]);
    clearTimeout(timeout);
    this.abort.abort();
    if (this.active) {
      await Promise.race([
        this.active,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, 3000);
        }),
      ]);
      clearTimeout(timeout);
    }
  }
}
