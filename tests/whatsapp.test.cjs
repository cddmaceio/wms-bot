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
    assert.equal(id, "5582999999999@c.us");
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
test("Envio sem identificador permanece incerto e não repete", async () => {
  const client = new EventEmitter();
  let calls = 0;
  client.sendMessage = async () => { calls++; return null; };
  const result = await sendText(client, "5582999999999@c.us", "teste", 100);
  assert.equal(result.state, "uncertain");
  assert.equal(calls, 1);
  assert.equal(client.listenerCount("message_ack"), 0);
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


test('Consulta de numero travada nao impede o envio nativo ao ID cadastrado', async () => {
  const client = new EventEmitter();
  client.getNumberId = () => assert.fail('Nao deve consultar queryWidExists');
  client.getContactLidAndPhone = () => assert.fail('Nao deve repetir a consulta por PN/LID');
  let calls = 0;
  client.sendMessage = async (id, text, options) => {
    calls++;
    assert.equal(id, '5582999999999@c.us');
    assert.equal(text, 'teste');
    assert.equal(options.sendSeen, false);
    return { id: { _serialized: 'native' }, ack: 1 };
  };
  const result = await sendText(client, '5582999999999@c.us', 'teste', 100);
  assert.equal(result.state, 'confirmed');
  assert.equal(result.messageId, 'native');
  assert.equal(calls, 1);
});

test('Erro no envio nativo fica incerto com diagnostico e sem segundo envio', async () => {
  const client = new EventEmitter();
  let calls = 0;
  client.sendMessage = async () => { calls++; throw new Error('Falha interna 5582999999999'); };
  const result = await sendText(client, '5582999999999@c.us', 'teste', 100);
  assert.equal(result.state, 'uncertain');
  assert.match(result.note, /Falha interna/);
  assert(!result.note.includes('5582999999999'));
  assert.equal(calls, 1);
  assert.equal(client.listenerCount('message_ack'), 0);
});

test('ID invalido continua bloqueado antes de qualquer envio', async () => {
  const client = new EventEmitter();
  client.sendMessage = () => assert.fail('Nao deve enviar');
  await assert.rejects(sendText(client, 'outro-destino', 'teste', 100), /inválido/);
});
