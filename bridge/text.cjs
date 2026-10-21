const recipientPattern = /^(?:\d{10,15}@c\.us|\d{10,25}(?:-\d+)?@g\.us)$/;
async function sendText(client, recipient, text, timeout = 45000) {
  if (
    !recipientPattern.test(recipient) ||
    typeof text !== "string" ||
    !text ||
    text.length > 4000
  )
    throw new Error("Mensagem ou destinatário inválido");
  let chatId = recipient;
  // Falha de resolução acontece antes de sendMessage: nenhum envio foi iniciado.
  try {
    if (recipient.endsWith("@c.us")) {
      let resolutionTimer;
      const registered = await Promise.race([
        client.getNumberId(recipient),
        new Promise((_, reject) => {
          resolutionTimer = setTimeout(
            () => reject(new Error("Resolução do destinatário expirou")),
            15000,
          );
        }),
      ]).finally(() => clearTimeout(resolutionTimer));
      if (!registered?._serialized)
        return { state: "blocked", note: "Número não encontrado no WhatsApp" };
      chatId = registered._serialized;
    }
  } catch {
    return {
      state: "not_sent",
      note: "Não foi possível resolver o destinatário antes do envio",
    };
  }
  // Escuta os ACKs antes de sendMessage, inclusive se chegarem antes do retorno.
  const acks = new Map();
  let currentId, finish;
  const listener = (message, ack) => {
    const id = message.id?._serialized;
    if (!id) return;
    acks.set(id, ack);
    if (id === currentId && finish && (ack >= 1 || ack === -1))
      finish(ack >= 1);
  };
  client.on("message_ack", listener);
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Sem confirmação de envio")),
        timeout,
      );
    });
    const work = (async () => {
      const message = await client.sendMessage(chatId, text, {
        sendSeen: false,
      });
      currentId = message?.id?._serialized;
      if (!currentId)
        return {
          state: "uncertain",
          note: "WhatsApp não retornou identificador",
        };
      const ack = acks.get(currentId) ?? message.ack;
      if (ack >= 1) return { state: "confirmed", messageId: currentId };
      if (ack === -1)
        return {
          state: "uncertain",
          messageId: currentId,
          note: "Servidor recusou a mensagem",
        };
      const confirmed = await new Promise((resolve) => {
        finish = resolve;
      });
      return {
        state: confirmed ? "confirmed" : "uncertain",
        messageId: currentId,
      };
    })();
    return await Promise.race([work, deadline]);
  } catch {
    return {
      state: "uncertain",
      messageId: currentId,
      note: "Envio iniciado sem confirmação; conferir no aparelho",
    };
  } finally {
    clearTimeout(timer);
    client.off("message_ack", listener);
  }
}
module.exports = { sendText };
