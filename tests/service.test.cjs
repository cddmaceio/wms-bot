const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { Store } = require("../dist/store");
const { setup, drain, csv } = require("./helpers.cjs");

test("Download, validação e upload geram histórico; repetir chave não cria nova consulta", async (t) => {
  const { service, store } = setup(
    t,
    { apiUrl: "https://destination.test" },
    {
      upload: async () => ({
        state: "completed",
        processed: 1,
        maps: 1,
        errors: [],
        message: "OK",
      }),
    },
  );
  const first = service.create({ date: "2026-01-01", requestKey: "same" });
  const second = service.create({ date: "2026-01-01", requestKey: "same" });
  assert.equal(first.job.id, second.job.id);
  assert.equal(second.created, false);
  assert.throws(
    () => service.create({ date: "2026-01-02", requestKey: "same" }),
    /parâmetros diferentes/,
  );
  await drain(service);
  const job = store.get(first.job.id);
  assert.equal(job.state, "completed");
  assert.equal(job.summary.records, 1);
  assert.equal(service.detail(job.id).config, undefined);
  assert.equal(service.detail(job.id).attempts.length, 5);
});
test("Cliques simultâneos enfileiram trabalhos mas não executam downloads concorrentes", async (t) => {
  let active = 0,
    max = 0;
  const { service, store } = setup(
    t,
    {},
    {
      downloader: async (_s, dir) => {
        active++;
        max = Math.max(active, max);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const file = path.join(dir, "x.csv");
        fs.writeFileSync(file, csv);
        active--;
        return { file };
      },
    },
  );
  service.create({ requestKey: "one" });
  service.create({ requestKey: "two" });
  await Promise.all([service.tick(), service.tick()]);
  await service.active;
  await drain(service);
  assert.equal(max, 1);
  assert.equal(store.byState("downloaded").length, 2);
});
test("Arquivo sem linhas não chama upload; filtro inválido interrompe fluxo", async (t) => {
  let uploads = 0;
  const { service, store } = setup(
    t,
    { apiUrl: "https://destination.test" },
    {
      downloader: async (_s, dir) => {
        const file = path.join(dir, "x.csv");
        fs.writeFileSync(file, csv.split("\n")[0]);
        return { file };
      },
      upload: async () => {
        uploads++;
        throw new Error();
      },
    },
  );
  const job = service.create({}).job;
  await drain(service);
  assert.equal(store.get(job.id).state, "no_data");
  assert.equal(uploads, 0);
  service.downloader = async () => {
    throw new Error("FILTER_VALUE | data divergente");
  };
  const invalid = service.create({}).job;
  await drain(service);
  assert.equal(store.get(invalid.id).state, "failed");
  assert.equal(uploads, 0);
});
test("Reinício preserva fila, marca upload incerto e não repete mensagens em andamento", (t) => {
  const { store, service, file } = setup(t);
  const uploading = service.create({ requestKey: "upload" }).job;
  store.update(uploading.id, { state: "uploading" });
  const downloading = service.create({ requestKey: "download" }).job;
  store.update(downloading.id, { state: "downloading" });
  const queued = service.create({ requestKey: "queue" }).job;
  store.planDelivery(
    uploading.id,
    "completed",
    "5582999999999@c.us",
    "mensagem",
  );
  const item = store.pending()[0];
  store.claimDelivery(item.id);
  store.close();
  const reopened = new Store(file);
  reopened.recover();
  assert.equal(reopened.get(uploading.id).state, "uncertain");
  assert.equal(reopened.get(downloading.id).state, "failed");
  assert.equal(reopened.get(queued.id).state, "queued");
  assert.equal(reopened.delivery(item.id).state, "uncertain");
  reopened.close();
});
test("Reenvio usa cópia do CSV, não baixa novamente e é idempotente por chave", async (t) => {
  let downloads = 0;
  const { service, store, settings } = setup(
    t,
    {},
    {
      downloader: async (_s, dir) => {
        downloads++;
        const file = path.join(dir, "x.csv");
        fs.writeFileSync(file, csv);
        return { file };
      },
      upload: async () => ({
        state: "completed",
        processed: 1,
        maps: 1,
        errors: [],
        message: "OK",
      }),
    },
  );
  const source = service.create({}).job;
  await drain(service);
  settings.update({ apiUrl: "https://destination.test" });
  assert.throws(
    () => service.retryUpload(source.id, false, "retry"),
    /confirme/i,
  );
  const retry = service.retryUpload(source.id, true, "retry");
  assert.equal(
    service.retryUpload(source.id, true, "retry").job.id,
    retry.job.id,
  );
  await drain(service);
  assert.equal(downloads, 1);
  assert.equal(store.get(retry.job.id).state, "completed");
  assert.notEqual(store.get(source.id).file, store.get(retry.job.id).file);
});
test("Mensagens aguardam conexão; resultado incerto bloqueia repetição e pode ser conferido", async (t) => {
  let connected = false,
    calls = 0;
  const { service, store, bridge } = setup(
    t,
    {
      whatsappEnabled: true,
      sendEnabled: true,
      recipients: ["5582999999999@c.us"],
    },
    {
      bridge: {
        status: async () => ({
          ready: connected,
          state: connected ? "ready" : "disconnected",
        }),
        send: async () => {
          calls++;
          return { state: "uncertain" };
        },
      },
    },
  );
  const job = service.create({}).job;
  await drain(service);
  assert.equal(store.pending().length, 1);
  assert.equal(calls, 0);
  connected = true;
  await drain(service);
  assert.equal(calls, 1);
  const delivery = store.deliveries(job.id)[0];
  assert.equal(delivery.state, "uncertain");
  await drain(service);
  assert.equal(calls, 1);
  assert.throws(
    () => service.reconcileDelivery(delivery.id, "retry", "Conferido", false),
    /confirme/i,
  );
  service.reconcileDelivery(
    delivery.id,
    "confirm",
    "Recebido no aparelho",
    true,
  );
  assert.equal(store.delivery(delivery.id).state, "confirmed");
  assert.throws(
    () => service.reconcileDelivery(delivery.id, "retry", "Conferido", true),
    /Somente/,
  );
});
test("Retenção remove somente artefatos concluídos sem pendências e preserva histórico", async (t) => {
  const { service, store } = setup(t, { retentionDays: 1 });
  const job = service.create({}).job;
  await drain(service);
  store.update(job.id, { finished: "2020-01-01T00:00:00.000Z" });
  const file = store.get(job.id).file;
  store.planDelivery(job.id, "downloaded", "5582999999999@c.us", "pending");
  service.cleanup();
  assert(fs.existsSync(file));
  store.updateDelivery(store.pending()[0].id, "confirmed");
  service.cleanup();
  assert(!fs.existsSync(file));
  assert(store.get(job.id));
  assert.equal(store.get(job.id).file, null);
});
test("Backup consistente pode ser restaurado com configurações e jobs", async (t) => {
  const { store, service, directory, vault } = setup(t);
  const job = service.create({}).job;
  await drain(service);
  const target = path.join(directory, "backup.sqlite3");
  await store.db.backup(target);
  const copy = new Store(target);
  assert.equal(copy.get(job.id).state, "downloaded");
  assert(vault.open(copy.setting()).timezone);
  copy.close();
});
