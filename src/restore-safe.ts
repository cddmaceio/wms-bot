import path from "node:path";
import lockfile from "proper-lockfile";
import { Store } from "./store";
import { SettingsService } from "./settings";
import { Vault } from "./security";
async function main() {
  const data = path.resolve(process.env.DATA_DIR || "./data");
  const release = await lockfile.lock(data, { stale: 60000, retries: 0 });
  try {
    const store = new Store(path.join(data, "wms.sqlite3"));
    try {
      if (!store.setting())
        throw new Error("Não há configuração salva para restaurar");
      const settings = new SettingsService(
        store,
        new Vault(process.env.SETTINGS_KEY || ""),
      );
      settings.update({
        scheduleEnabled: false,
        whatsappEnabled: false,
        sendEnabled: false,
      });
      console.log(
        "Agenda, WhatsApp e envios desativados. Confira pendências antes de reativar pelo painel.",
      );
    } finally {
      store.close();
    }
  } finally {
    await release();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
