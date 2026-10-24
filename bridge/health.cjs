// Consulta apenas o contexto principal do cliente mantido pelo worker.
async function inspectSession(client, timeout = 1500) {
  let timer;
  try {
    if (!client?.pupPage || client.pupPage.isClosed())
      return { ready: false, reason: 'Página WhatsApp indisponível' };
    return await Promise.race([
      client.pupPage.evaluate(() => {
        const read = fn => { try { return fn() ?? null; } catch { return null; } };
        const socket = read(() => window.require('WAWebSocketModel').Socket);
        const chats = read(() => window.require('WAWebCollections').Chat);
        const injection = typeof window.WWebJS?.sendMessage === 'function';
        const compatible = injection && typeof window.WWebJS?.getMsgKeyId === 'function'
          && window.WWebJS.sendMessage.toString().includes('getMsgKeyId(newMsgKey)');
        const ready = navigator.onLine && !!socket && !!chats && compatible
          && socket.state === 'CONNECTED';
        return {
          ready,
          reason: ready ? null : !injection || !socket || !chats
            ? 'Página sem módulos WhatsApp; reconecte a sessão'
            : !compatible ? 'Compatibilidade WhatsApp indisponível'
            : 'Conexão WhatsApp indisponível: ' + (socket?.state || 'desconhecida'),
          version: read(() => window.Debug.VERSION),
          injection,
          modules: !!socket && !!chats,
          socketState: socket?.state ?? null,
          socketStream: socket?.stream ?? null,
          online: navigator.onLine,
        };
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Página WhatsApp sem resposta')), timeout);
      }),
    ]);
  } catch {
    return { ready: false, reason: 'Não foi possível verificar a página WhatsApp; reconecte a sessão' };
  } finally { clearTimeout(timer); }
}
module.exports = { inspectSession };
