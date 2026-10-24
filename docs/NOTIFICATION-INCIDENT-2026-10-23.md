# Fila WhatsApp pendente em 23/10/2026

## Evidência da instância

Consulta autenticada de leitura em produção: envio e WhatsApp habilitados; conexão ready; mensagem #4, referente a 22/10, com 9.232 tentativas e nota de falha na resolução do destinatário antes do envio. As mensagens #5 e #6 estavam pendentes, com zero tentativas. Mensagens anteriores tinham ACK confirmado.

## Causa observada

A resolução do destinatário falha antes de sendMessage. O erro original era ocultado por uma nota genérica. O retorno not_sent devolvia a mensagem para pending sem intervalo nem limite; o break encerrava o lote e os itens seguintes não avançavam. O heartbeat do worker e o estado ready não representam sucesso de envio.

O motivo interno da falha de resolução ainda precisa ser confirmado na instância com o erro detalhado da versão corrigida. Não há evidência de falta de disco.

## Correção local

- Resolução alternativa pela API getContactLidAndPhone apenas quando getNumberId lança erro; exige correspondência exata do telefone e LID válido. Não altera números nem tenta outro destinatário.
- Intervalo mínimo de 30 segundos, até três tentativas automáticas; falhas persistentes passam a blocked para revisão.
- Uma falha não encerra o processamento dos outros destinatários; a ordem do destinatário com falha é preservada durante a espera.
- Auditoria de início/resultado; detalhe do erro de resolução; motivo de espera e identificação da mensagem bloqueadora no painel.
- Diagnóstico inclui contagens da fila e erro do worker de notificações. Resultados incertos continuam sem repetição automática.

## Implantação e recuperação

Publicar a alteração e fazer redeploy de uma única instância na Coolify, preservando o volume existente. Uma mensagem que estiver sending durante o reinício será recuperada como uncertain. Conferir o aparelho e revisar a mensagem #4 no painel antes de liberar a fila. Não marcar como recebida sem confirmação. Não apagar banco nem sessão para liberar a fila.

A correção foi preparada localmente; não foi realizado deploy nem envio manual durante o diagnóstico. A alternativa de resolução precisa ser homologada na sessão real após implantação.

## Diagnóstico após o primeiro deploy

Às 23:42:18 UTC, a mensagem #4 ficou blocked com erro de timeout na resolução. A alternativa PN/LID não resolveu: quando não há vínculo em cache, a implementação da biblioteca também chama queryWidExists.

A correção seguinte remove as duas consultas prévias. O envio usa sendMessage com o ID exato cadastrado, deixando a resolução da conversa com o fluxo nativo da biblioteca. Há uma única chamada de envio, acompanhada por ACK. Falha ou timeout depois de iniciar essa chamada continua uncertain, sem retry automático. O erro original de envio passa a constar na nota, com números longos e Bearer removidos.

Após este segundo deploy, a mensagem #4 já bloqueada precisa ser revisada no painel: após conferir que não chegou, usar **Não recebi: tentar** e justificar. O deploy não altera sozinho a decisão de revisão de uma mensagem bloqueada. A homologação real permanece necessária.

## Contexto do navegador sem módulos

O diagnóstico executado no Chromium da instância retornou WWebJS.sendMessage ausente, sem WAWebSocketModel.Socket nem WAWebCollections.Chat, apesar do estado ready no worker. A reconexão autorizada desativou e reativou somente o WhatsApp, preservando perfil e pareamento. A mensagem #4 permaneceu incerta; nenhuma reconciliação nem envio manual foi executado.

O worker passa a verificar o contexto principal ativo, módulos, compatibilidade e Socket.state antes de declarar ready e antes de enviar. A verificação tem limite de 1,5 segundo. Perda dos módulos resulta em session_unavailable, visível no painel. O botão de conectar passa a recriar uma sessão ready preservando o perfil, sem sobrepor inicializações ou interromper uma tentativa de envio em curso. Uma reconexão não repete mensagens incertas.

## Causa da rota No LID for user

Após recuperar a sessão, o diagnóstico de cache mostrou que o destinatário cadastrado não tem LID nem conversa no formato com nono dígito. A conversa já confirmada existe, e seu vínculo reverso aponta para o telefone canônico sem esse dígito. O envio direto ao cadastro original provoca No LID for user.

A resolução agora consulta getNumberId para obter o número canônico registrado e, depois, getContactLidAndPhone para esse número canônico. Somente um vínculo com PN exatamente igual ao canônico é aceito. O envio é feito uma única vez ao LID retornado. Nenhum dígito é adicionado/removido por heurística, e o destinatário cadastrado e seu histórico são preservados. A resolução inteira tem limite de 12 segundos e ocorre antes de iniciar sendMessage. A sessão é verificada antes desse fluxo.
