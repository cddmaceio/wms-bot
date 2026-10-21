const { test } = require("node:test");
const assert = require("node:assert/strict");
const { uploadRecords } = require("../dist/upload");
const { defaults } = require("../dist/settings");
const settings = {
  ...defaults({}),
  apiUrl: "https://destination.test",
  apiToken: "secret",
};
test("Upload preserva contrato, autenticação e interpreta contadores confirmados", async () => {
  const result = await uploadRecords(
    settings,
    [{ mapas: "123" }],
    "file.csv",
    async (url, options) => {
      assert.equal(url, "https://destination.test/api/conference/upload");
      assert.equal(options.headers.Authorization, "Bearer secret");
      assert.deepEqual(JSON.parse(options.body), {
        records: [{ mapas: "123" }],
        file_name: "file.csv",
      });
      assert.equal(options.redirect, "error");
      assert(options.signal);
      return new Response(
        JSON.stringify({
          success: true,
          data: { processedCount: 1, conferenceMapsUpserted: 2 },
        }),
      );
    },
  );
  assert.equal(result.state, "completed");
  assert.equal(result.maps, 2);
  assert.equal(result.processed, 1);
});
test("HTTP 207 e errors nunca são apresentados como sucesso integral", async () => {
  for (const status of [200, 207]) {
    const result = await uploadRecords(
      settings,
      [],
      "x.csv",
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { processedCount: 5 },
            errors: ["lote falhou"],
          }),
          { status },
        ),
    );
    assert.equal(result.state, "partial");
    assert.deepEqual(result.errors, ["lote falhou"]);
  }
});
test("Timeout, resposta inválida e HTTP 500 exigem conferência; não há repetição automática", async () => {
  let calls = 0;
  const result = await uploadRecords(settings, [], "x.csv", async () => {
    calls++;
    throw new Error("timeout secret");
  });
  assert.equal(calls, 1);
  assert.equal(result.state, "uncertain");
  assert(!JSON.stringify(result).includes("timeout secret"));
  const invalid = await uploadRecords(
    settings,
    [],
    "x.csv",
    async () => new Response("not json"),
  );
  assert.equal(invalid.state, "uncertain");
  const unknown = await uploadRecords(settings, [], "x.csv", async () => new Response("{}"));
  assert.equal(unknown.state, "uncertain");
  const failure = await uploadRecords(
    settings,
    [],
    "x.csv",
    async () => new Response('{"success":false}', { status: 500 }),
  );
  assert.equal(failure.state, "uncertain");
  const rejected = await uploadRecords(
    settings,
    [],
    "x.csv",
    async () => new Response('{"success":false}', { status: 401 }),
  );
  assert.equal(rejected.state, "failed");
});
