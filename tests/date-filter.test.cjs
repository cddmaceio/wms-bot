const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { applyDateFilter, isSeparationQuery, waitForQuery } = require('../automation/date-filter.cjs');

function request(path='/api/outbound-reports/api/PalletItem/get-all', initial='2026-10-20', final=initial) {
  return {
    method: () => 'GET', resourceType: () => 'xhr',
    url: () => `https://wms.test${path}?initialDate=${encodeURIComponent(initial)}&finalDate=${encodeURIComponent(final)}`,
    failure: () => ({errorText:'net::ERR_FAILED'}),
  };
}
function response(req, status=200, finished=async()=>null) {
  return { request:()=>req, ok:()=>status>=200&&status<300, status:()=>status, finished };
}
function fixture(count=2, mismatch=false) {
  const page = new EventEmitter();
  const fields = Array.from({length:count},()=>({
    value:'',isVisible:async()=>true,scrollIntoViewIfNeeded:async()=>{},click:async()=>{},
    fill:async function(value){this.value=value;},press:async()=>{},
    inputValue:async function(){return mismatch?'01/01/2000':this.value;},
  }));
  let queried=0;
  const button={isVisible:async()=>true,isEnabled:async()=>true,click:async()=>{
    queried++;const req=request();page.emit('request',req);page.emit('response',response(req));
  }};
  Object.assign(page,{
    locator:()=>({count:async()=>fields.length,nth:i=>fields[i]}),
    getByRole:()=>({count:async()=>1,nth:()=>button}),waitForFunction:async()=>{},
  });
  return {page,queries:()=>queried};
}
function assertClean(page){for(const event of ['request','response','requestfailed','close'])assert.equal(page.listenerCount(event),0,`Listener residual: ${event}`);}

test('Filtro exige dois campos e não consulta se a data não foi confirmada', async()=>{
  for(const f of [fixture(1),fixture(2,true)]){await assert.rejects(applyDateFilter(f.page,'20/10/2026'),/FILTER_/);assert.equal(f.queries(),0);}
});
test('Filtro aguarda o endpoint real PalletItem/get-all com as duas datas solicitadas',async()=>{
  const f=fixture();assert.equal(await applyDateFilter(f.page,'20/10/2026'),true);assert.equal(f.queries(),1);assertClean(f.page);
});
test('Matcher rejeita telemetria, configurações e período divergente',()=>{
  assert(isSeparationQuery(request(),'20/10/2026'));
  assert(isSeparationQuery(request(undefined,'2026-10-20T00:00:00','2026-10-20T23:59:59'),'20/10/2026'));
  assert(isSeparationQuery(request(undefined,'2026-10-20 00:00:00','2026-10-20 23:59:59'),'20/10/2026'));
  for(const req of [request('/api/v2/rum'),request('/wms/new/gestao/processos/configuracoes'),request('/api/separation-details'),request(undefined,'2026-10-19'),request(undefined,'2026-10-20','2026-10-19')])assert(!isSeparationQuery(req,'20/10/2026'));
});
test('Respostas iniciadas antes do clique e requisições alheias não liberam exportação',async()=>{
  const page=new EventEmitter();let finished=false;
  const stale=request(),unrelated=request('/api/v2/rum'),correct=request();
  await waitForQuery(page,()=>{
    page.emit('response',response(stale));
    page.emit('request',unrelated);page.emit('response',response(unrelated));
    page.emit('request',correct);page.emit('response',response(correct,200,async()=>{await new Promise(resolve=>setTimeout(resolve,10));finished=true;}));
  },'20/10/2026',100);
  assert(finished);assertClean(page);
});
test('Falta de resposta correta gera diagnóstico e remove listeners',async()=>{
  const page=new EventEmitter();
  await assert.rejects(waitForQuery(page,()=>{const req=request('/api/v2/rum');page.emit('request',req);page.emit('response',response(req));},'20/10/2026',10),/FILTER_QUERY_TIMEOUT.*correspondentes: 0/);
  assertClean(page);
});
test('Erro no clique ou HTTP da consulta interrompe imediatamente sem listener residual',async()=>{
  const page=new EventEmitter();
  await assert.rejects(waitForQuery(page,()=>{throw new Error('clique bloqueado');},'20/10/2026',100),/clique bloqueado/);assertClean(page);
  await assert.rejects(waitForQuery(page,()=>{const req=request();page.emit('request',req);page.emit('response',response(req,500));},'20/10/2026',100),/HTTP 500/);assertClean(page);
});
test('Erro durante transferência ou falha de rede não libera download',async()=>{
  const page=new EventEmitter();
  await assert.rejects(waitForQuery(page,()=>{const req=request();page.emit('request',req);page.emit('response',response(req,200,async()=>new Error('interrompido')));},'20/10/2026',100),/Transferência.*interrompida/);assertClean(page);
  await assert.rejects(waitForQuery(page,()=>{const req=request();page.emit('request',req);page.emit('requestfailed',req);},'20/10/2026',100),/FILTER_QUERY_FAILED/);assertClean(page);
});
