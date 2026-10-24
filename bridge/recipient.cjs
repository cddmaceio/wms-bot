const phoneId = /^\d{10,15}@c\.us$/;
const lidId = /^\d+@lid$/;
async function resolveRecipient(client, recipient, timeout = 12000) {
  if (recipient.endsWith('@g.us')) return { state: 'resolved', chatId: recipient };
  let timer;
  try {
    const work = (async () => {
      // A resposta do WhatsApp é a autoridade para normalizar o telefone.
      // Não adicionar/remover o nono dígito por tentativa.
      const registered = await client.getNumberId(recipient);
      if (!registered) return { state: 'blocked', note: 'Número não encontrado no WhatsApp' };
      const canonical = registered._serialized ?? registered.$1;
      if (lidId.test(canonical)) return { state: 'resolved', chatId: canonical };
      if (!phoneId.test(canonical)) throw new Error('Identificador canônico inválido');
      const contacts = await client.getContactLidAndPhone([canonical]);
      const contact = contacts.find(item => item.pn === canonical && lidId.test(item.lid));
      if (!contact) return { state: 'blocked', note: 'WhatsApp não retornou vínculo LID para o número canônico' };
      return { state: 'resolved', chatId: contact.lid };
    })();
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tempo de resolução do número canônico excedido')), timeout);
    })]);
  } catch (error) {
    const reason = String(error?.message || error)
      .replace(/\d{8,}/g, '[numero]').replace(/Bearer\s+\S+/gi, 'Bearer [segredo]').slice(0, 300);
    return { state: 'not_sent', note: 'Falha antes do envio ao resolver número canônico: ' + reason };
  } finally { clearTimeout(timer); }
}
module.exports = { resolveRecipient };
