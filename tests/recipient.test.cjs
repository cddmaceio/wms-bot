const {test}=require('node:test');
const assert=require('node:assert/strict');
const {resolveRecipient}=require('../bridge/recipient.cjs');

test('Vinculo LID de outro telefone nao e usado',async()=>{
  const client={getNumberId:async()=>({_serialized:'558299999999@c.us'}),
    getContactLidAndPhone:async()=>[{pn:'5582888888888@c.us',lid:'111@lid'}]};
  assert.equal((await resolveRecipient(client,'5582999999999@c.us')).state,'blocked');
});

test('Consulta travada termina antes de iniciar envio',async()=>{
  const client={getNumberId:()=>new Promise(()=>{})};
  const result=await resolveRecipient(client,'5582999999999@c.us',5);
  assert.equal(result.state,'not_sent');
  assert.match(result.note,/Tempo de resolução/);
});

test('Numero sem cadastro bloqueia sem consultar outro telefone',async()=>{
  const client={getNumberId:async()=>null,getContactLidAndPhone:()=>assert.fail('Nao consultar')};
  assert.equal((await resolveRecipient(client,'5582999999999@c.us')).state,'blocked');
});

test('Grupos preservam ID sem consultar telefone',async()=>{
  const result=await resolveRecipient({},'123456789012@g.us');
  assert.equal(result.chatId,'123456789012@g.us');
});
