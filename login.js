async function firstVisible(locators, { enabled = false } = {}) {
  for (const locator of locators) {
    const count = await locator.count();
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      if (!(await candidate.isVisible())) continue;
      if (enabled && !(await candidate.isEnabled())) continue;
      return candidate;
    }
  }
  return null;
}

// Executed inside the browser. Hidden forms and hidden alerts do not describe
// the current authentication state.
function loginOutcome() {
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const errors = Array.from(document.querySelectorAll(
    '[role="alert"], .alert-danger, .error-message, .invalid-feedback, #input-error, .kc-feedback-text'
  )).filter(visible).map(el => el.textContent.trim()).filter(Boolean);
  const passwordVisible = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
  const loginUrl = /multiple-realms|\/login(?:[/?#]|$)/i.test(location.href);
  if (errors.length && (passwordVisible || loginUrl)) {
    return { status: 'error', message: errors.join(' | ').slice(0, 500) };
  }
  if (passwordVisible || loginUrl) return false;
  if (!visible(document.body) || !document.body.innerText.trim()) return false;
  const realm = Array.from(document.querySelectorAll('button, a, [role="button"]'))
    .some(el => visible(el) && /login\s+(with\s+)?credentials|login\s+com\s+credenciais/i.test(el.textContent));
  const appVisible = Array.from(document.querySelectorAll('nav, .sidebar, [class*="menu"], [class*="nav"]')).some(visible);
  return !realm && appVisible ? { status: 'success' } : false;
}

async function waitForLogin(page, timeout = 60000) {
  const handle = await page.waitForFunction(loginOutcome, null, { timeout });
  try {
    return await handle.jsonValue();
  } finally {
    await handle.dispose();
  }
}

module.exports = { firstVisible, loginOutcome, waitForLogin };
