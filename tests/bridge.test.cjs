const { test } = require("node:test");
const assert = require("node:assert/strict");
const lockfile = require("proper-lockfile");
const { Bridge } = require("../dist/bridge");
const { setup } = require("./helpers.cjs");
test("Processo WhatsApp real inicia desativado, responde por IPC e encerra sem navegador", async (t) => {
  const { directory } = setup(t);
  const bridge = new Bridge(directory, () => {});
  try {
    await bridge.configure(false);
    const state = await bridge.status();
    assert.equal(state.state, "disabled");
    assert.equal(state.ready, false);
    assert.equal((await bridge.qr()).image, null);
    assert.equal(
      (await bridge.send("5582999999999@c.us", "Não enviar")).state,
      "not_sent",
    );
  } finally {
    await bridge.stop();
  }
});
test("Lock impede segunda instância usando o mesmo volume", async (t) => {
  const { directory } = setup(t);
  const release = await lockfile.lock(directory, { retries: 0 });
  try {
    await assert.rejects(
      lockfile.lock(directory, { retries: 0 }),
      /already being held/,
    );
  } finally {
    await release();
  }
});
