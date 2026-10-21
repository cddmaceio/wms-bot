const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../dist/server");
const { setup, drain } = require("./helpers.cjs");
const token = "test-admin-token-".repeat(3);
test("API protege dados, QR, configurações e arquivos; jobs retornam 202 e são consultáveis", async (t) => {
  const { service } = setup(t, {
    wmsPass: "private-password",
    apiToken: "private-api-token",
  });
  const server = createApp(service, token).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, options = {}) =>
    fetch(base + route, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
  assert.equal((await fetch(base + "/health")).status, 200);
  for (const route of [
    "/api/jobs",
    "/api/settings",
    "/api/whatsapp/qr",
    "/api/deliveries",
  ])
    assert.equal((await fetch(base + route)).status, 401);
  const page = await fetch(base + "/");
  assert(page.headers.get("content-security-policy"));
  assert.equal(page.status, 200);
  const config = await (await call("/api/settings")).json();
  assert.equal(config.wmsPass, undefined);
  assert.equal(config.apiToken, undefined);
  const created = await call("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"date":"2026-01-01","requestKey":"http-test"}',
  });
  assert.equal(created.status, 202);
  const job = await created.json();
  assert.equal(job.config, undefined);
  await drain(service);
  const detail = await (await call("/api/jobs/" + job.id)).json();
  assert.equal(detail.state, "downloaded");
  assert(!JSON.stringify(detail).includes("private-password"));
  assert.equal(
    (await fetch(base + `/api/jobs/${job.id}/artifacts/csv`)).status,
    401,
  );
  assert.equal((await call(`/api/jobs/${job.id}/artifacts/csv`)).status, 200);
  assert.equal(
    (
      await call("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{invalid",
      })
    ).status,
    400,
  );
  assert.equal((await call("/run", { method: "POST" })).status, 410);
});
