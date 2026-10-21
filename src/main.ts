import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { Store } from "./store";
import { Vault } from "./security";
import { SettingsService } from "./settings";
import { Bridge } from "./bridge";
import { Service } from "./service";
import { createApp } from "./server";
import { createLogger } from "./logger";

async function main() {
  const data = path.resolve(process.env.DATA_DIR || "./data");
  const token = process.env.ADMIN_TOKEN || "";
  if (token.length < 32)
    throw new Error("ADMIN_TOKEN deve conter ao menos 32 caracteres");
  const vault = new Vault(process.env.SETTINGS_KEY || "");
  const port = Number(process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT inválida");
  fs.mkdirSync(data, { recursive: true });
  const release = await lockfile.lock(data, {
    stale: 60000,
    update: 10000,
    retries: 0,
    onCompromised: () => {
      process.stderr.write("Lock do volume perdido; encerrando\n");
      process.exit(1);
    },
  });
  const log = createLogger(data);
  const store = new Store(path.join(data, "wms.sqlite3"));
  const settings = new SettingsService(store, vault);
  const bridge = new Bridge(data, log);
  const service = new Service(
    store,
    settings,
    data,
    bridge,
    undefined,
    undefined,
    log,
  );
  await service.start();
  const server = createApp(service, token, log).listen(
    port,
    process.env.HOST || "0.0.0.0",
    () => log("started", { port }),
  );
  server.on("error", (error) => {
    log("server_error", { name: error.name });
    void stop();
  });
  let exiting = false;
  async function stop() {
    if (exiting) return;
    exiting = true;
    log("stopping");
    const force = setTimeout(() => process.exit(1), 35000);
    force.unref();
    server.close();
    await service.stop();
    store.close();
    await release();
    clearTimeout(force);
    process.exit(0);
  }
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  process.on("uncaughtException", (error) => {
    log("fatal_error", { name: error.name });
    process.exit(1);
  });
  process.on("unhandledRejection", () => {
    log("unhandled_rejection");
    process.exit(1);
  });
}
main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
