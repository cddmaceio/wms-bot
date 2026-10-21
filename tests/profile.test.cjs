const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {setup}=require('./helpers.cjs');
const {profileInUse,recoverProfileMarkers,acquireProfileLease}=require('../bridge/profile.cjs');

function fixture(t){
  const {directory}=setup(t);
  const profile=path.join(directory,'whatsapp','session-wms-bot');
  const procRoot=path.join(directory,'proc');
  fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(procRoot);
  fs.mkdirSync(path.join(profile,'Default'));
  fs.writeFileSync(path.join(profile,'Default','Cookies'),'session-data-to-preserve');
  for(const marker of ['SingletonLock','SingletonSocket','SingletonCookie','DevToolsActivePort'])fs.writeFileSync(path.join(profile,marker),'old-container');
  function process(pid,args){const dir=path.join(procRoot,String(pid));fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'cmdline'),args.join('\0'));}
  return {directory,profile,procRoot,process};
}
test('Recupera somente marcadores obsoletos e preserva cookies e dados de pareamento',t=>{
  const f=fixture(t);f.process(402,['chromium','--user-data-dir=/tmp/wms-independent-profile']);
  const removed=recoverProfileMarkers(f.profile,{platform:'linux',procRoot:f.procRoot});
  assert.equal(removed.length,4);assert.equal(fs.readFileSync(path.join(f.profile,'Default','Cookies'),'utf8'),'session-data-to-preserve');
  assert.deepEqual(fs.readdirSync(f.profile),['Default']);
  assert.deepEqual(recoverProfileMarkers(f.profile,{platform:'linux',procRoot:f.procRoot}),[]);
});
test('Chromium ativo usando o perfil impede qualquer remoção de bloqueios',t=>{
  const f=fixture(t);f.process(402,['chromium','--user-data-dir='+f.profile]);
  assert(profileInUse(f.profile,f.procRoot));
  assert.throws(()=>recoverProfileMarkers(f.profile,{platform:'linux',procRoot:f.procRoot}),/em uso/);
  assert(fs.existsSync(path.join(f.profile,'SingletonLock')));
});
test('Reconhece argumento de perfil separado e não confunde processo sem perfil',t=>{
  const f=fixture(t);f.process(100,['node','service.js']);f.process(402,['chromium','--user-data-dir',f.profile]);
  assert(profileInUse(f.profile,f.procRoot));
});
test('Sem acesso à lista de processos a recuperação falha sem apagar marcadores',t=>{
  const f=fixture(t);
  assert.throws(()=>recoverProfileMarkers(f.profile,{platform:'linux',procRoot:path.join(f.directory,'unavailable')}));
  assert(fs.existsSync(path.join(f.profile,'SingletonLock')));
});
test('Marcadores inesperados ou plataforma sem inspeção não são removidos',t=>{
  const f=fixture(t);assert.throws(()=>recoverProfileMarkers(f.profile,{platform:'win32',procRoot:f.procRoot}),/conferência/);
  fs.unlinkSync(path.join(f.profile,'SingletonCookie'));fs.mkdirSync(path.join(f.profile,'SingletonCookie'));
  assert.throws(()=>recoverProfileMarkers(f.profile,{platform:'linux',procRoot:f.procRoot}),/inesperado/);
  assert(fs.existsSync(path.join(f.profile,'SingletonLock')));
});
test('Lease exclusiva bloqueia outra instância e é liberada no encerramento',async t=>{
  const {directory}=setup(t);
  const lease=await acquireProfileLease(directory,{retries:0});
  try{await assert.rejects(acquireProfileLease(directory,{retries:0}),/outra instância/);}finally{await lease.release();}
  const next=await acquireProfileLease(directory,{retries:0});await next.release();
  assert.throws(()=>next.recover(),/liberada/);
});
