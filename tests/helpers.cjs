const fs = require("node:fs");
const path = require("node:path");
const { Store } = require("../dist/store");
const { Vault } = require("../dist/security");
const { SettingsService, defaults } = require("../dist/settings");
const { Service } = require("../dist/service");
const root = path.resolve("test-results");
const csv =
  "Código do Armazém;Mapas;Palete;Código do Item;Item\nBRA8;123;P1;001;Produto\n";
function setup(t, patch = {}, dependencies = {}) {
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  const file = path.join(directory, "wms.sqlite3");
  const store = new Store(file);
  const vault = new Vault("a".repeat(64));
  const settings = new SettingsService(store, vault, {
    ...defaults({}),
    ...patch,
  });
  const bridge = {
    status: async () => ({ state: "disabled", ready: false }),
    send: async () => ({ state: "confirmed", messageId: "message-1" }),
    configure: async () => {},
    connect: async () => {},
    qr: async () => ({ state: "disabled" }),
    stop: async () => {},
    ...dependencies.bridge,
  };
  const downloader =
    dependencies.downloader ||
    async function (_config, dir) {
      const file = path.join(dir, "source.csv");
      fs.writeFileSync(file, csv);
      return { file };
    };
  const service = new Service(
    store,
    settings,
    directory,
    bridge,
    downloader,
    dependencies.upload,
  );
  t.after(() => {
    if (store.db.open) store.close();
    const real = fs.realpathSync(directory);
    if (!real.startsWith(fs.realpathSync(root) + path.sep))
      throw new Error("Diretório de teste inválido");
    fs.rmSync(directory, { recursive: true });
  });
  return { store, vault, settings, service, bridge, directory, file };
}
async function drain(service) {
  await service.tick();
  await service.active;
  await service.sending;
}
module.exports = { setup, drain, csv };
