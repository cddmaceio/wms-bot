const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { inspectSession } = require('../bridge/health.cjs');

function clientFor(window) {
  return { pupPage: { isClosed: () => false, evaluate: async fn =>
    vm.runInNewContext('(' + fn.toString() + ')()', { window, navigator:{onLine:true} }) } };
}
function healthyWindow() {
  return {
    Debug:{VERSION:'test'},
    WWebJS:{getMsgKeyId:()=>{},sendMessage:function(){ return 'getMsgKeyId(newMsgKey)'; }},
    require: name => name === 'WAWebSocketModel'
      ? {Socket:{state:'CONNECTED',stream:'CONNECTED'}} : {Chat:{length:3}},
  };
}

test('Página sem injeção e módulos reproduz diagnóstico da produção e não fica pronta', async () => {
  const health = await inspectSession(clientFor({require:()=>undefined}));
  assert.equal(health.ready,false);
  assert.equal(health.injection,false);
  assert.equal(health.modules,false);
  assert.match(health.reason,/sem módulos/);
});

test('Página íntegra e conectada fica pronta; socket desconectado não', async () => {
  const window=healthyWindow();
  assert.equal((await inspectSession(clientFor(window))).ready,true);
  window.require=()=>({Socket:{state:'OPENING'},Chat:{}});
  const health=await inspectSession(clientFor(window));
  assert.equal(health.ready,false);
  assert.equal(health.socketState,'OPENING');
});

test('Verificação de página travada e página fechada termina sem envio', async () => {
  const health=await inspectSession({pupPage:{isClosed:()=>false,evaluate:()=>new Promise(()=>{})}},5);
  assert.equal(health.ready,false);
  assert.equal((await inspectSession({pupPage:{isClosed:()=>true}})).ready,false);
});

test('Worker invalida ready e não chama sendText se os módulos desaparecerem', async () => {
  let sends=0;
  const sandbox={module:{exports:{}},process:{env:{DATA_DIR:'/test'},on:()=>{},send:()=>{}},setTimeout,clearTimeout};
  sandbox.require=name=> {
    if(name==='./patch-wwebjs.cjs')return {applyPatch:()=>{}};
    if(name==='./health.cjs')return {inspectSession};
    if(name==='./text.cjs')return {sendText:()=>{sends++;}};
    return {};
  };
  const source=fs.readFileSync(require.resolve('../bridge/worker.cjs'),'utf8');
  vm.runInNewContext(source + '\nmodule.exports={handle, setClient(value){client=value;enabled=true;state="ready";}};',sandbox);
  const worker=sandbox.module.exports;
  worker.setClient(clientFor({require:()=>undefined}));
  const status=await worker.handle('status',{});
  assert.equal(status.ready,false);
  assert.equal(status.state,'session_unavailable');
  assert.equal((await worker.handle('send',{recipient:'5582999999999@c.us',text:'teste'})).state,'not_sent');
  assert.equal(sends,0);
});


test('Conectar reinicia cliente ready, preserva perfil e impede inicializações sobrepostas', async () => {
  let destroyed=0, created=0, leases=0;
  const {EventEmitter}=require('node:events');
  class FakeClient extends EventEmitter {
    constructor(){ super(); created++; }
    initialize(){ return Promise.resolve(); }
  }
  const sandbox={module:{exports:{}},process:{env:{DATA_DIR:'/test'},on:()=>{},send:()=>{}},setTimeout:()=>1,clearTimeout:()=>{}};
  sandbox.require=name=> {
    if(name==='./patch-wwebjs.cjs')return {applyPatch:()=>{}};
    if(name==='./health.cjs')return {inspectSession};
    if(name==='./text.cjs')return {sendText:()=>assert.fail('Nao enviar')};
    if(name==='node:path')return require('node:path');
    if(name==='playwright')return {chromium:{executablePath:()=>'/test/chromium'}};
    if(name==='whatsapp-web.js')return {Client:FakeClient,LocalAuth:class{}};
    if(name==='./profile.cjs')return {acquireProfileLease:async()=>{leases++;return {recover:()=>[]}}};
    return {};
  };
  const source=fs.readFileSync(require.resolve('../bridge/worker.cjs'),'utf8');
  vm.runInNewContext(source+'\nmodule.exports={handle,prepare(value){client=value;enabled=true;state="ready";}};',sandbox);
  const worker=sandbox.module.exports;
  worker.prepare({destroy:async()=>{destroyed++}});
  await worker.handle('connect',{});
  await worker.handle('connect',{});
  assert.equal(destroyed,1);
  assert.equal(created,1);
  assert.equal(leases,1);
});
