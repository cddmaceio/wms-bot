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
  const bounded = async (work, milliseconds) => {
    let timer;
    try {
      return await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Tempo de resolução excedido')), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  };
  // Falha de resolução acontece antes de sendMessage: nenhum envio foi iniciado.
  try {
    if (recipient.endsWith("@c.us")) {
      let registered;
      try {
        registered = await bounded(() => client.getNumberId(recipient), 10000);
      } catch (primaryError) {
        // O vínculo PN/LID só é aceito quando o telefone retornado é o solicitado.
        try {
          const contacts = await bounded(() => client.getContactLidAndPhone([recipient]), 5000);
          const contact = contacts.find(item => item.pn === recipient && /^\d+@lid$/.test(item.lid));
          if (!contact) throw primaryError;
          registered = { _serialized: contact.lid };
        } catch { throw primaryError; }
      }
      if (!registered?._serialized)
        return { state: "blocked", note: "Número não encontrado no WhatsApp" };
      chatId = registered._serialized;
    }
  } catch (error) {
    const reason = String(error?.message || error).replace(/\d{8,}/g, '[numero]').replace(/Bearer\s+\S+/gi, 'Bearer [segredo]').slice(0, 300);
    return {
      state: "not_sent",
      note: "Não foi possível resolver o destinatário antes do envio: " + reason,
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
