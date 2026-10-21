// Compatibilidade de chaves do WhatsApp Web na versão fixada 1.34.7.
// Baseado no tratamento validado no Farol GSDPQ e na issue upstream #201852.
const fs = require("node:fs");
const path = require("node:path");
const marker = "// WMS_MESSAGE_KEY_COMPATIBILITY";
function patchSource(source, version) {
  if (version !== "1.34.7")
    throw new Error(
      "Revisar compatibilidade antes de atualizar whatsapp-web.js",
    );
  let code = source.replace(/\r\n/g, "\n");
  if (code.includes(marker)) return code;
  function replace(before, after) {
    if (code.split(before).length !== 2)
      throw new Error("Estrutura WhatsApp mudou; revisar patch de chaves");
    code = code.replace(before, after);
  }
  replace(
    "    window.WWebJS = {};",
    `    window.WWebJS = {};\n    ${marker}\n    window.WWebJS.getMsgKeyId = key => key?._serialized ?? key?.$1;`,
  );
  replace(
    ".Msg.get(newMsgKey._serialized);",
    ".Msg.get(window.WWebJS.getMsgKeyId(newMsgKey));",
  );
  replace(
    "        delete msg.pendingAckUpdate;",
    `        if (msg.id && msg.id._serialized == null) {\n            const id = window.WWebJS.getMsgKeyId(msg.id);\n            if (id) msg.id = Object.assign({}, msg.id, { _serialized: id });\n        }\n        delete msg.pendingAckUpdate;`,
  );
  replace(
    "            const lastMessage = chat.lastReceivedKey\n",
    "            const lastReceivedKeyId = window.WWebJS.getMsgKeyId(chat.lastReceivedKey);\n            const lastMessage = lastReceivedKeyId\n",
  );
  return code.replaceAll(
    "chat.lastReceivedKey._serialized",
    "lastReceivedKeyId",
  );
}
function applyPatch() {
  const packageFile = require.resolve("whatsapp-web.js/package.json");
  const { version } = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const file = path.join(
    path.dirname(packageFile),
    "src/util/Injected/Utils.js",
  );
  const original = fs.readFileSync(file, "utf8");
  const patched = patchSource(original, version);
  if (original !== patched) fs.writeFileSync(file, patched);
}
if (require.main === module) applyPatch();
module.exports = { patchSource, applyPatch };
