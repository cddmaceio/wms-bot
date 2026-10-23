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
