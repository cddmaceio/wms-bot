import { fork, ChildProcess } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface WhatsAppBridge {
  status(): Promise<Record<string, unknown>>;
  send(
    recipient: string,
    text: string,
  ): Promise<{ state: string; messageId?: string; note?: string }>;
  configure(enabled: boolean): Promise<void>;
  connect(): Promise<void>;
  qr(): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}
// IPC não publica porta e só aceita chamadas do processo pai.
export class Bridge implements WhatsAppBridge {
  private child?: ChildProcess;
  private stopping = false;
  private enabled = false;
  private timer?: NodeJS.Timeout;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    private data: string,
    private log: (event: string, detail?: unknown) => void,
  ) {}
  private spawn() {
    if (this.child || this.stopping) return;
    this.child = fork(path.resolve(__dirname, "../bridge/worker.cjs"), [], {
      // Não repassar credenciais WMS, API, token administrativo ou chave do SQLite.
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        DATA_DIR: this.data,
        WHATSAPP_ENABLED: String(this.enabled),
        PUPPETEER_SKIP_DOWNLOAD: "true",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child.on("message", (message: any) => {
      if (message.event) {
        this.log("whatsapp", { event: message.event });
        return;
      }
      const item = this.pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error));
      else item.resolve(message.value);
    });
    const exited = () => {
      this.child = undefined;
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Processo WhatsApp interrompido"));
      }
      this.pending.clear();
      if (!this.stopping) this.timer = setTimeout(() => this.spawn(), 10000);
    };
    this.child.once("exit", exited);
    this.child.on("error", (error) =>
      this.log("whatsapp_process_error", { name: error.name }),
    );
  }
  private call<T>(
    action: string,
    payload: unknown = {},
    timeout = 65000,
  ): Promise<T> {
    this.spawn();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Tempo de resposta do WhatsApp excedido"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.send({ id, action, payload }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  async configure(enabled: boolean) {
    this.enabled = enabled;
    await this.call("configure", { enabled });
  }
  async connect() {
    await this.call("connect");
  }
  async status() {
    try {
      return await this.call<Record<string, unknown>>("status", {}, 3000);
    } catch {
      return { state: "unavailable", ready: false };
    }
  }
  async qr() {
    return this.call<Record<string, unknown>>("qr", {}, 3000);
  }
  async send(recipient: string, text: string) {
    return this.call<{ state: string; messageId?: string; note?: string }>(
      "send",
      { recipient, text },
    );
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 10000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
