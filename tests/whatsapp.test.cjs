const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { sendText } = require("../bridge/text.cjs");
const { patchSource } = require("../bridge/patch-wwebjs.cjs");
test("WhatsApp captura ACK antes do retorno da mensagem e limpa listener", async () => {
  const client = new EventEmitter();
  client.getNumberId = async () => ({ _serialized: "123@lid" });
  client.sendMessage = async (id) => {
    assert.equal(id, "123@lid");
    client.emit("message_ack", { id: { _serialized: "m1" } }, 1);
    return { id: { _serialized: "m1" }, ack: 0 };
  };
  const result = await sendText(client, "5582999999999@c.us", "teste", 100);
  assert.equal(result.state, "confirmed");
  assert.equal(client.listenerCount("message_ack"), 0);
});
test("WhatsApp não repete automaticamente envio sem confirmação", async () => {
  const client = new EventEmitter();
  let calls = 0;
  client.sendMessage = async () => {
    calls++;
    return { id: { _serialized: "m2" }, ack: 0 };
  };
  const result = await sendText(client, "123456789012@g.us", "teste", 10);
  assert.equal(result.state, "uncertain");
  assert.equal(calls, 1);
  assert.equal(client.listenerCount("message_ack"), 0);
});
test("Destinatário sem cadastro não inicia sendMessage", async () => {
  const client = new EventEmitter();
  client.getNumberId = async () => null;
  client.sendMessage = () => assert.fail("Não deveria enviar");
  assert.equal(
    (await sendText(client, "5582999999999@c.us", "teste")).state,
    "blocked",
  );
});
test("Patch de chaves suporta $1, preserva _serialized e exige versão conhecida", () => {
  const file = path.join(
    path.dirname(require.resolve("whatsapp-web.js/package.json")),
    "src/util/Injected/Utils.js",
  );
  const patched = patchSource(fs.readFileSync(file, "utf8"), "1.34.7");
  assert.equal(patchSource(patched, "1.34.7"), patched);
  assert(patched.includes("getMsgKeyId(newMsgKey)"));
  assert(patched.includes("getMsgKeyId(msg.id)"));
  const assignment = patched.match(/window.WWebJS.getMsgKeyId = [^;]+;/)[0];
  const sandbox = { window: { WWebJS: {} } };
  vm.runInNewContext(assignment, sandbox);
  assert.equal(
    sandbox.window.WWebJS.getMsgKeyId({ $1: "fallback" }),
    "fallback",
  );
  assert.equal(
    sandbox.window.WWebJS.getMsgKeyId({
      _serialized: "original",
      $1: "fallback",
    }),
    "original",
  );
  assert.throws(() => patchSource(patched, "1.35.0"), /Revisar/);
});


test('Resolucao alternativa valida PN/LID antes de enviar', async () => {
  const client = new EventEmitter();
  client.getNumberId = async () => { throw new Error('queryWidExists indisponivel'); };
  client.getContactLidAndPhone = async ids => {
    assert.deepEqual(ids, ['5582999999999@c.us']);
    return [{ pn: ids[0], lid: '123456789@lid' }];
  };
  client.sendMessage = async id => {
    assert.equal(id, '123456789@lid');
    return { id: { _serialized: 'fallback' }, ack: 1 };
  };
  assert.equal((await sendText(client, '5582999999999@c.us', 'teste', 100)).state, 'confirmed');
});

test('Resolucao alternativa rejeita outro telefone e preserva erro original', async () => {
  const client = new EventEmitter();
  client.getNumberId = async () => { throw new Error('queryWidExists indisponivel'); };
  client.getContactLidAndPhone = async () => [{ pn: '5582888888888@c.us', lid: '123456789@lid' }];
  client.sendMessage = () => assert.fail('Nao deve enviar');
  const result = await sendText(client, '5582999999999@c.us', 'teste', 100);
  assert.equal(result.state, 'not_sent');
  assert.match(result.note, /queryWidExists indisponivel/);
});
