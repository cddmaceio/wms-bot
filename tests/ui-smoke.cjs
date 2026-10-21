const { chromium } = require("playwright");
const { createApp } = require("../dist/server");
const { setup, drain } = require("./helpers.cjs");
const assert = require("node:assert/strict");
const path = require("node:path");
const callbacks = [];
async function main() {
  const { service, settings } = setup({ after: (fn) => callbacks.push(fn) });
  const token = "ui-test-token-".repeat(4);
  const server = createApp(service, token).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator("#token").fill(token);
    await page.getByRole("button", { name: "Entrar na central" }).click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "03 Configurações" }).click();
    await page.locator('[data-setting="wmsUser"]').fill("operador-teste");
    await page.getByRole("button", { name: "Salvar configurações" }).click();
    await page.getByText("Configurações salvas.", { exact: true }).waitFor();
    assert.equal(settings.get().wmsUser, "operador-teste");
    await page.getByRole("button", { name: "04 Agenda" }).click();
    await page.locator("#schedule-times").fill("06:00, 12:00");
    await page.getByRole("button", { name: "Salvar agenda" }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("#notice").textContent ===
        "Configurações salvas.",
    );
    await page.getByRole("button", { name: "02 Execuções" }).click();
    await page.getByRole("button", { name: "Iniciar consulta" }).click();
    await page
      .getByText("Consulta adicionada à fila.", { exact: true })
      .waitFor();
    await drain(service);
    await page.getByRole("button", { name: "Atualizar", exact: true }).click();
    await page
      .locator("#jobs-table")
      .getByText("Baixado sem API", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Ver detalhes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Baixar CSV", exact: true })
      .waitFor();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Baixar CSV", exact: true }).click();
    assert((await download).suggestedFilename().endsWith(".csv"));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.resolve("test-results/painel-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.resolve("test-results/painel-mobile.png"),
      fullPage: true,
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "A página não deve ter rolagem horizontal",
    );
    await page.getByRole("button", { name: "05 WhatsApp" }).click();
    await page.locator("#whatsapp-form").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await page.locator("#login").waitFor({ state: "visible" });
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(
      "Painel validado: autenticação, configurações, agenda, consulta, download, WhatsApp, logout e responsividade.",
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
    for (const callback of callbacks.reverse()) await callback();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
