const fs = require('node:fs');
const path = require('node:path');
const lockfile = require('proper-lockfile');

const markers = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'];

// O perfil LocalAuth permanece intacto. Somente arquivos transitórios do Chromium
// são elegíveis, após adquirir uma lease exclusiva e verificar os processos Linux.
function profileInUse(profile, procRoot = '/proc') {
  const expected = path.resolve(profile);
  for (const pid of fs.readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    let args;
    try { args = fs.readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8').split('\0'); }
    catch (error) {
      if (['ENOENT','ENOTDIR','ESRCH'].includes(error.code)) continue;
      throw new Error('Não foi possível verificar os processos do perfil WhatsApp');
    }
    for (let i = 0; i < args.length; i++) {
      const directory = args[i].startsWith('--user-data-dir=') ? args[i].slice('--user-data-dir='.length) : args[i] === '--user-data-dir' ? args[i+1] : null;
      if (directory && path.resolve(directory) === expected) return true;
    }
  }
  return false;
}

function recoverProfileMarkers(profile, {platform = process.platform, procRoot = '/proc'} = {}) {
  if (!fs.existsSync(profile)) return [];
  if (fs.lstatSync(profile).isSymbolicLink()) throw new Error('Perfil WhatsApp não pode ser um link simbólico');
  const found = markers.filter(name => {
    try { fs.lstatSync(path.join(profile, name)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  if (platform !== 'linux') {
    if (found.length) throw new Error('Bloqueio do perfil requer conferência dos processos neste sistema');
    return [];
  }
  if (profileInUse(profile, procRoot)) throw new Error('Perfil WhatsApp está em uso por um Chromium ativo; aguarde o encerramento');
  // Verifica todos os alvos antes de remover o primeiro; unlink não segue symlinks.
  for (const name of found) if (fs.lstatSync(path.join(profile,name)).isDirectory()) throw new Error('Marcador Chromium inesperado; recuperação interrompida');
  for (const name of found) fs.unlinkSync(path.join(profile, name));
  return found;
}

async function acquireProfileLease(data, {onCompromised = () => process.exit(1), retries = 35} = {}) {
  const auth = path.resolve(data, 'whatsapp');
  fs.mkdirSync(auth, {recursive:true});
  let release;
  try {
    release = await lockfile.lock(auth, {stale:30000, update:10000, retries:retries ? {retries,minTimeout:1000,maxTimeout:1000,factor:1} : 0, onCompromised});
  } catch (error) {
    if (error.code === 'ELOCKED') throw new Error('Perfil WhatsApp reservado por outra instância; aguarde seu encerramento antes de conectar');
    throw error;
  }
  let released = false;
  return {
    profile: path.join(auth, 'session-wms-bot'),
    recover() {
      if (released) throw new Error('Lease do perfil já foi liberada');
      return recoverProfileMarkers(path.join(auth, 'session-wms-bot'));
    },
    async release() { if (!released) { released=true; await release(); } },
  };
}
module.exports = {profileInUse, recoverProfileMarkers, acquireProfileLease};
