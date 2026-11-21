// Settings-page API (admins only). The browser edits the settings as written: ${SECRET} references stay
// references, secret values are write-only, and password hashes never leave the server.
import { getRawConfig, saveConfig, readSecrets, writeSecrets, secretStatus, SECRET_NAME } from './config.js';
import { hashPassword } from './auth.js';
import { WIDGET_TYPES } from './widgets.js';

function forBrowser(raw) {
  const cfg = structuredClone(raw);
  for (const u of Object.values(cfg.users || {})) {
    u.passwordSet = Boolean(u.password);
    delete u.password;
  }
  return cfg;
}

/** Puts back the password hashes the browser never saw, hashing any new passwords. */
function withPasswords(next, current, me) {
  const errors = [];
  for (const [id, u] of Object.entries(next.users || {})) {
    const { newPassword } = u;
    delete u.newPassword; delete u.passwordSet; delete u.password;
    if (newPassword) {
      if (String(newPassword).length < 8) errors.push(`User "${id}": the password needs at least 8 characters`);
      else u.password = hashPassword(String(newPassword));
    } else if (current.users?.[id]?.password) {
      u.password = current.users[id].password;
    } else {
      errors.push(`User "${id}" needs a password`);
    }
  }
  // Locking yourself out from here would need a file edit on the server to undo.
  if (!next.users?.[me]) errors.push('You cannot delete your own user while signed in as it');
  else if (next.users[me].admin !== true) errors.push('You cannot remove your own admin rights');
  return errors;
}

/** Returns [status, body] for /api/admin/* requests of an admin. */
export async function adminRequest(req, pathname, viewer, readJson) {
  if (pathname === '/api/admin/settings' && req.method === 'GET') {
    const raw = getRawConfig();
    return [200, { config: forBrowser(raw), types: WIDGET_TYPES, secrets: secretStatus(raw), me: viewer.id }];
  }
  if (pathname === '/api/admin/settings' && req.method === 'PUT') {
    const { config } = await readJson(req, 1_000_000);
    if (!config || typeof config !== 'object') return [400, { errors: ['No settings sent'] }];
    const errors = withPasswords(config, getRawConfig(), viewer.id);
    if (errors.length) return [400, { errors }];
    const invalid = saveConfig(config);
    if (invalid.length) return [400, { errors: invalid }];
    console.log(`[settings] saved by ${viewer.id}`);
    const raw = getRawConfig();
    return [200, { config: forBrowser(raw), secrets: secretStatus(raw) }];
  }
  const secret = pathname.match(/^\/api\/admin\/secrets\/([^/]+)$/);
  if (secret) {
    const name = decodeURIComponent(secret[1]);
    if (!SECRET_NAME.test(name)) return [400, { errors: ['Secret names use A-Z, 0-9 and _ and start with a letter'] }];
    const secrets = readSecrets();
    if (req.method === 'PUT') {
      const { value } = await readJson(req, 20_000);
      if (typeof value !== 'string' || !value) return [400, { errors: ['Enter a value'] }];
      secrets[name] = value;
    } else if (req.method === 'DELETE') {
      delete secrets[name];
    } else {
      return [405, { errors: ['method not allowed'] }];
    }
    writeSecrets(secrets);
    console.log(`[settings] secret ${name} ${req.method === 'PUT' ? 'set' : 'removed'} by ${viewer.id}`);
    return [200, { secrets: secretStatus(getRawConfig()) }];
  }
  return [404, { errors: ['not found'] }];
}
