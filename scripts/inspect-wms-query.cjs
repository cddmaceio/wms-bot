// Diagnóstico somente da consulta WMS. Não exporta CSV, não chama destino/WhatsApp.
const path = require("node:path");
const { chromium } = require("playwright");
const Database = require("better-sqlite3");
const { Vault } = require(path.join(process.cwd(), "dist/security.js"));

async function main() {
  const data = process.env.DATA_DIR || "/data";
  const db = new Database(path.join(data, "wms.sqlite3"), { readonly: true });
  const saved = db.prepare("SELECT value FROM settings WHERE id=1").get();
  const latest = db.prepare("SELECT date FROM jobs ORDER BY created DESC LIMIT 1").get();
  db.close();
  const config = new Vault(process.env.SETTINGS_KEY || "").open(saved.value);
  const date = latest.date.split("-").reverse().join("/");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ storageState: path.join(data, "wms-profile/storageState.json") });
    const page = await context.newPage();
    await page.goto(config.wmsUrl.replace(/\/$/, "") + "/separation-details", { waitUntil: "domcontentloaded", timeout: 60000 });
    const fields = page.locator("input.datepicker-tracking");
    await fields.first().waitFor({ state: "visible", timeout: 30000 });
    for (let i = 0; i < await fields.count(); i++) {
      if (!await fields.nth(i).isVisible()) continue;
      await fields.nth(i).fill(date); await fields.nth(i).press("Tab");
    }
    const requests = new Set();
    let lastActivity = Date.now();
    function safe(request) {
      const u = new URL(request.url());
      const payload = u.search + (request.postData() || "");
      return { method: request.method(), path: u.pathname.replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, '[id]'), type: request.resourceType(), parameterNames: [...u.searchParams.keys()], hasDate: payload.includes(date) || payload.includes(latest.date), initialMatches: u.searchParams.get('initialDate')?.startsWith(latest.date), finalMatches: u.searchParams.get('finalDate')?.startsWith(latest.date), dateSeparators: ['initialDate','finalDate'].map(key=>u.searchParams.get(key)?.slice(10,11)), dateLengths: ['initialDate','finalDate'].map(key=>u.searchParams.get(key)?.length) };
    }
    const eligible = request => ["xhr", "fetch"].includes(request.resourceType()) && /\/PalletItem\/get-all(?:\?|$)/i.test(request.url());
    page.on("request", request => { if (eligible(request)) { requests.add(request); lastActivity = Date.now(); console.log("QUERY_REQUEST", JSON.stringify(safe(request))); } });
    page.on("response", response => { if (requests.has(response.request())) { lastActivity = Date.now(); console.log("QUERY_RESPONSE", JSON.stringify({ ...safe(response.request()), status: response.status() })); } });
    page.on("requestfinished", request => { if (requests.delete(request)) lastActivity = Date.now(); });
    page.on("requestfailed", request => { if (requests.delete(request)) { lastActivity = Date.now(); console.log("QUERY_FAILED", JSON.stringify(safe(request))); } });
    const button = page.getByRole("button", { name: /^Consultar$/i });
    await button.click();
    const start = Date.now();
    while (Date.now() - start < 15000 && (Date.now() - lastActivity < 2000 || requests.size)) await new Promise(resolve => setTimeout(resolve, 100));
    console.log("QUERY_UI", JSON.stringify({ dateFields: await Promise.all(Array.from({length: await fields.count()}, (_,i) => fields.nth(i).inputValue())), tables: await page.locator("table").count(), rows: await page.locator("tbody tr").count(), pending: requests.size }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.name, "Diagnóstico não concluído:", error.message.split(/\n/)[0]); process.exitCode = 1; });
