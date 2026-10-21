const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { parseCsv } = require("../dist/csv");
const { Vault, authorized } = require("../dist/security");
const { SettingsService } = require("../dist/settings");
const { validateDate, localTime } = require("../dist/time");
const { setup, csv } = require("./helpers.cjs");

test("CSV suporta BOM, aspas, separador dentro do campo, multilinha e última duplicata", () => {
  const result = parseCsv(
    '\uFEFFCódigo do Armazém;Mapas;Palete;Código do Item;Item\r\nBRA8;123;P1;001;"Produto; com\nlinha"\r\nBRA8;123;P1;001;"Último ""valor"""\r\n',
  );
  assert.equal(result.duplicates, 1);
  assert.equal(result.rawCount, 2);
  assert.equal(result.records[0].item, 'Último "valor"');
  assert.equal(parseCsv(csv.replaceAll(";", ",")).records.length, 1);
});
test("CSV rejeita chave incompleta, cabeçalhos duplicados e aspas inválidas", () => {
  assert.throws(
    () => parseCsv(csv.replace("BRA8;123;P1;001", "BRA8;;P1;001")),
    /chave incompleta/,
  );
  assert.throws(() => parseCsv(csv.replace(";Item", ";Mapas")), /duplicados/);
  assert.throws(() => parseCsv(csv + '"linha quebrada'), /CSV inválido/);
  assert.throws(() => parseCsv("foo;bar\nx;y"), /obrigatórias/);
});
test("CSV com cabeçalho válido e nenhuma linha é ausência de dados", () => {
  assert.equal(parseCsv(csv.split("\n")[0]).records.length, 0);
});
test("Datas são validadas pelo calendário e fuso, independentemente do host", () => {
  const now = new Date("2026-03-01T01:00:00Z");
  assert.equal(localTime(now, "America/Maceio").date, "2026-02-28");
  assert.throws(
    () => validateDate("2026-02-30", "America/Maceio", now),
    /inválida/,
  );
  assert.throws(
    () => validateDate("2026-03-01", "America/Maceio", now),
    /futura/,
  );
  assert.equal(validateDate("2024-02-29", "America/Maceio", now), "2024-02-29");
});
test("Configurações e snapshot são criptografados e sobrevivem a recriação do serviço", (t) => {
  const { store, settings, vault, service } = setup(t, {
    wmsPass: "senha-secreta-original",
    apiToken: "api-secreta",
  });
  const job = service.create({ date: "2026-01-01", requestKey: "request" }).job;
  settings.update({ wmsPass: "nova-senha" });
  assert.equal(vault.open(job.config).wmsPass, "senha-secreta-original");
  assert.equal(new SettingsService(store, vault).get().wmsPass, "nova-senha");
  assert.equal(settings.public().wmsPass, undefined);
  assert.equal(settings.public().apiToken, undefined);
  assert(!store.setting().includes("nova-senha"));
  assert(!job.config.includes("api-secreta"));
  assert.throws(() => new Vault("b".repeat(64)).open(job.config));
  assert.throws(() => settings.update({ sendEnabled: "false" }), /booleano/);
  assert.throws(
    () => settings.update({ apiUrl: "https://user:pass@example.com" }),
    /credenciais/,
  );
  assert.throws(() => settings.update({ arbitrary: true }), /desconhecida/);
});
test("Bearer exige comparação completa, inclusive tamanho", () => {
  assert(authorized("Bearer abc", "abc"));
  assert(!authorized("Bearer ab", "abc"));
  assert(!authorized(undefined, "abc"));
});
