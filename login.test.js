const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { firstVisible, loginOutcome } = require('./login');

function outcome({ password = false, hiddenPassword = false, alert = '', hiddenAlert = false,
  url = 'https://wms.example/separation-details', nav = true, realm = false } = {}) {
  const element = (text, visible = true) => ({ textContent: text, offsetWidth: visible ? 100 : 0,
    offsetHeight: 0, getClientRects: () => [] });
  const document = {
    body: { ...element(''), innerText: 'WMS' },
    querySelectorAll(selector) {
      if (selector.startsWith('[role="alert"]')) return alert ? [element(alert, !hiddenAlert)] : [];
      if (selector === 'input[type="password"]') return password || hiddenPassword ? [element('', password)] : [];
      if (selector.startsWith('button,')) return realm ? [element('Login with credentials')] : [];
      return nav ? [element('Menu')] : [];
    },
  };
  return vm.runInNewContext(`(${loginOutcome.toString()})()`, { document, location: { href: url } });
}

test('does not confirm login while the password form remains visible', () => {
  assert.equal(outcome({ password: true }), false);
});
test('reports a visible WMS error while on the login form', () => {
  const result = outcome({ password: true, alert: 'Credenciais inválidas' });
  assert.equal(result.status, 'error');
  assert.equal(result.message, 'Credenciais inválidas');
});
test('hidden errors and a hidden password do not block an authenticated shell', () => {
  assert.equal(outcome({ hiddenPassword: true, alert: 'Erro antigo', hiddenAlert: true }).status, 'success');
});
test('does not confirm login on realm, redirect or intermediate screens', () => {
  assert.equal(outcome({ realm: true }), false);
  assert.equal(outcome({ url: 'https://wms.example/multiple-realms' }), false);
  assert.equal(outcome({ nav: false }), false);
});
test('skips hidden and disabled matches to choose an actionable control', async () => {
  const candidates = [
    { isVisible: async () => false },
    { isVisible: async () => true, isEnabled: async () => false },
    { isVisible: async () => true, isEnabled: async () => true },
  ];
  const locator = { count: async () => candidates.length, nth: i => candidates[i] };
  assert.equal(await firstVisible([locator], { enabled: true }), candidates[2]);
});
