import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { AppError, Delivery, Job, JobState } from "./types";

const stamp = () => new Date().toISOString();
export class Store {
  readonly db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, requestKey TEXT UNIQUE NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
        state TEXT NOT NULL, config TEXT NOT NULL, file TEXT, screenshot TEXT, summary TEXT NOT NULL DEFAULT '{}',
        error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, finished TEXT);
      CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, jobId TEXT NOT NULL REFERENCES jobs(id),
        stage TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY, jobId TEXT NOT NULL REFERENCES jobs(id),
        event TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        messageId TEXT, note TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL,
        UNIQUE(jobId,event,recipient));
      CREATE TABLE IF NOT EXISTS schedule_slots (slot TEXT PRIMARY KEY, state TEXT NOT NULL, jobId TEXT, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_plans (jobId TEXT PRIMARY KEY REFERENCES jobs(id), created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audits (id INTEGER PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,created);
      CREATE INDEX IF NOT EXISTS deliveries_state ON deliveries(state,id);
      PRAGMA user_version=1;
    `);
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }
  audit(action: string, detail: unknown) {
    this.db
      .prepare("INSERT INTO audits(action,detail,created) VALUES(?,?,?)")
      .run(action, JSON.stringify(detail), stamp());
  }
  audits() {
    return this.db
      .prepare("SELECT * FROM audits ORDER BY id DESC LIMIT 100")
      .all();
  }
  setting(): string | undefined {
    return (
      this.db.prepare("SELECT value FROM settings WHERE id=1").get() as
        | { value: string }
        | undefined
    )?.value;
  }
  saveSetting(value: string) {
    this.db
      .prepare(
        "INSERT INTO settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(value);
  }
  meta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  setMeta(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  create(date: string, key: string, source: string, config: string) {
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT id,date,source FROM jobs WHERE requestKey=?")
        .get(key) as { id: string; date: string; source: string } | undefined;
      if (old) {
        if (old.date !== date || old.source !== source)
          throw new AppError(
            "Chave já utilizada com parâmetros diferentes",
            409,
          );
        return { job: this.get(old.id)!, created: false };
      }
      const id = randomUUID();
      const now = stamp();
      this.db
        .prepare(
          "INSERT INTO jobs(id,requestKey,date,source,state,config,created,updated) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(id, key, date, source, "queued", config, now, now);
      this.audit("job_created", { id, date, source });
      return { job: this.get(id)!, created: true };
    });
  }
  get(id: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as
      | (Omit<Job, "summary"> & { summary: string })
      | undefined;
    return row ? { ...row, summary: JSON.parse(row.summary) } : undefined;
  }
  list(limit = 100): Job[] {
    return (
      this.db
        .prepare("SELECT id FROM jobs ORDER BY created DESC LIMIT ?")
        .all(limit) as { id: string }[]
    ).map((row) => this.get(row.id)!);
  }
  byState(state: JobState) {
    return (
      this.db
        .prepare("SELECT id FROM jobs WHERE state=? ORDER BY created,id")
        .all(state) as { id: string }[]
    ).map((row) => this.get(row.id)!);
  }
  update(
    id: string,
    values: Partial<
      Pick<
        Job,
        "state" | "file" | "screenshot" | "summary" | "error" | "finished"
      >
    >,
  ) {
    const entries = Object.entries({ ...values, updated: stamp() });
    this.db
      .prepare(
        `UPDATE jobs SET ${entries.map(([k]) => `${k}=?`).join(",")} WHERE id=?`,
      )
      .run(
        ...entries.map(([k, v]) => (k === "summary" ? JSON.stringify(v) : v)),
        id,
      );
  }
  attempt(jobId: string, stage: string, state: string, detail: unknown = null) {
    this.db
      .prepare(
        "INSERT INTO attempts(jobId,stage,state,detail,created) VALUES(?,?,?,?,?)",
      )
      .run(jobId, stage, state, JSON.stringify(detail), stamp());
  }
  attempts(id: string) {
    return this.db
      .prepare("SELECT * FROM attempts WHERE jobId=? ORDER BY id")
      .all(id);
  }
  recover() {
    this.transaction(() => {
      for (const state of [
        "downloading",
        "validating",
        "uploading",
      ] as JobState[])
        for (const job of this.byState(state)) {
          const next = state === "uploading" ? "uncertain" : "failed";
          this.update(job.id, {
            state: next,
            error:
              state === "uploading"
                ? "Processo interrompido durante upload; conferir destino antes de repetir"
                : "Processo interrompido; iniciar nova consulta manual",
            finished: stamp(),
          });
          this.attempt(job.id, state, next, "Recuperação após reinício");
        }
      this.db
        .prepare(
          "UPDATE deliveries SET state='uncertain',note='Interrompido durante tentativa; conferir mensagem',updated=? WHERE state='sending'",
        )
        .run(stamp());
    });
  }
  planDelivery(jobId: string, event: string, recipient: string, text: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO deliveries(jobId,event,recipient,text,updated) VALUES(?,?,?,?,?)",
      )
      .run(jobId, event, recipient, text, stamp());
  }
  unplannedNotifications(): Job[] {
    return (
      this.db
        .prepare(
          "SELECT j.id FROM jobs j WHERE j.state IN ('completed','partial','failed','uncertain','no_data','downloaded') AND j.source<>'notification-test' AND NOT EXISTS (SELECT 1 FROM notification_plans p WHERE p.jobId=j.id)",
        )
        .all() as { id: string }[]
    ).map((row) => this.get(row.id)!);
  }
  notificationPlanned(id: string) {
    return !!this.db
      .prepare("SELECT 1 FROM notification_plans WHERE jobId=?")
      .get(id);
  }
  markNotificationPlanned(id: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO notification_plans VALUES(?,?)")
      .run(id, stamp());
  }
  delivery(id: number) {
    return this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id) as
      | Delivery
      | undefined;
  }
  deliveries(jobId?: string): Delivery[] {
    return (
      jobId
        ? this.db
            .prepare("SELECT * FROM deliveries WHERE jobId=? ORDER BY id")
            .all(jobId)
        : this.db
            .prepare("SELECT * FROM deliveries ORDER BY id DESC LIMIT 200")
            .all()
    ) as Delivery[];
  }
  pending(): Delivery[] {
    return this.db
      .prepare(
        "SELECT * FROM deliveries WHERE state='pending' ORDER BY id LIMIT 100",
      )
      .all() as Delivery[];
  }
  updateDelivery(
    id: number,
    state: string,
    messageId: string | null = null,
    note: string | null = null,
  ) {
    this.db
      .prepare(
        "UPDATE deliveries SET state=?, messageId=COALESCE(?,messageId),note=?,updated=? WHERE id=?",
      )
      .run(state, messageId, note, stamp(), id);
  }
  claimDelivery(id: number) {
    return (
      this.db
        .prepare(
          "UPDATE deliveries SET state='sending',attempts=attempts+1,updated=? WHERE id=? AND state='pending'",
        )
        .run(stamp(), id).changes === 1
    );
  }
  slot(slot: string, state: string, jobId: string | null = null) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO schedule_slots VALUES(?,?,?,?)")
        .run(slot, state, jobId, stamp()).changes === 1
    );
  }
  slots() {
    return this.db
      .prepare("SELECT * FROM schedule_slots ORDER BY created DESC LIMIT 100")
      .all();
  }
  close() {
    this.db.close();
  }
}
