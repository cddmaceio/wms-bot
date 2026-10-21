// Executado dentro da imagem, com --network none e volume exclusivo de homologação.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const Database = require("better-sqlite3");
async function main() {
  const headers = {
    Authorization: "Bearer " + process.env.ADMIN_TOKEN,
    "Content-Type": "application/json",
  };
  const base = "http://127.0.0.1:3001";
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    if (attempt === 39) throw new Error("Aplicação não ficou saudável");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal((await fetch(base + "/api/settings")).status, 401);
  const initial = await (
    await fetch(base + "/api/settings", { headers })
  ).json();
  assert.equal(initial.sendEnabled, false);
  assert.equal(initial.scheduleEnabled, false);
  assert.equal(initial.whatsappEnabled, false);
  if (process.argv.includes("--after-restart")) {
    assert.equal(initial.wmsUser, "validation-user");
    assert.deepEqual(initial.times, ["06:00", "12:00"]);
  } else {
    const response = await fetch(base + "/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        wmsUser: "validation-user",
        times: ["06:00", "12:00"],
      }),
    });
    assert(response.ok);
  }
  const status = await (await fetch(base + "/api/status", { headers })).json();
  assert.equal(status.workerHealthy, true);
  assert.equal(status.whatsapp.state, "disabled");
  const db = new Database("/data/wms.sqlite3", { readonly: true });
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  db.close();
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent("<h1>WMS container validation</h1>");
    assert.equal(await page.textContent("h1"), "WMS container validation");
  } finally {
    await browser.close();
  }
  console.log(
    "Contêiner validado: saúde, autenticação, SQLite WAL, persistência, IPC desativado e Chromium sem rede externa.",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
