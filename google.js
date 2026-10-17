// Google account link (OAuth 2.0 for installed apps) + Gmail sending.
//
// Flow: loopback redirect with PKCE. We open the consent page in the user's
// default browser, Google redirects to a one-shot http server on
// 127.0.0.1:<random port>, we trade the code for tokens and close the server.
// Scopes are the narrowest that do the job:
//   gmail.send            send mail only — can't read the mailbox
//   calendar.app.created  only calendars this app creates (not the user's others)
//   drive.metadata.readonly  file names/links for the Drive picker — can't read contents
//   openid email          which account is linked (shown in settings)
// Tokens are encrypted with Electron safeStorage (Windows DPAPI: only this
// Windows user can decrypt) before touching disk.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const CRED_PATH = path.join(DATA_DIR, 'google-credentials.json');
const TOKEN_PATH = path.join(DATA_DIR, 'google-token.bin');
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

let safeStorage = null; // injected by electron-main (main process only)
let openExternal = null;

function configure(opts) {
  safeStorage = opts.safeStorage;
  openExternal = opts.openExternal;
}

function loadClient() {
  if (!fs.existsSync(CRED_PATH)) return null;
  const j = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  const c = j.installed || j.web;
  return c && c.client_id && c.client_secret ? c : null;
}

// ---------- token storage ----------

function readToken() {
  if (!fs.existsSync(TOKEN_PATH) || !safeStorage) return null;
  try {
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(TOKEN_PATH)));
  } catch (e) {
    console.error('google: cannot read token', e.message);
    return null;
  }
}

function writeToken(tok) {
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('系統加密功能無法使用，無法安全保存授權');
  fs.writeFileSync(TOKEN_PATH, safeStorage.encryptString(JSON.stringify(tok)));
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function emailFromIdToken(idToken) {
  try { return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8')).email || null; } catch { return null; }
}

// ---------- connect ----------

let pending = null; // one sign-in at a time

function connect() {
  const client = loadClient();
  if (!client) return Promise.reject(new Error('找不到 data\\google-credentials.json'));
  if (pending) return pending;

  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  pending = new Promise((resolve, reject) => {
    const server = http.createServer();
    let timer = null;
    const done = (err, val) => {
      clearTimeout(timer);
      server.close();
      pending = null;
      err ? reject(err) : resolve(val);
    };
    const page = (res, ok, msg) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Plannize</title>
        <body style="font-family:system-ui,'Microsoft JhengHei';display:grid;place-items:center;height:100vh;margin:0;background:#15172a;color:#eef0ff">
        <div style="text-align:center"><div style="font-size:48px">${ok ? '✅' : '⚠️'}</div><h2>${msg}</h2><p style="opacity:.7">可以關閉這個分頁，回到 App。</p></div>`);
    };

    server.on('request', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
      if (url.searchParams.get('state') !== state) { page(res, false, '授權失敗：驗證碼不符'); return; }
      const error = url.searchParams.get('error');
      if (error) { page(res, false, '已取消授權'); done(new Error(error === 'access_denied' ? '你取消了授權' : error)); return; }
      const code = url.searchParams.get('code');
      try {
        const tok = await tokenRequest({
          client_id: client.client_id,
          client_secret: client.client_secret,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        });
        if (!tok.refresh_token) throw new Error('Google 沒有回傳長期授權，請到 Google 帳戶移除此 App 的存取權後再試一次');
        const granted = (tok.scope || '').split(' ');
        const saved = {
          refresh_token: tok.refresh_token,
          access_token: tok.access_token,
          expires_at: Date.now() + (tok.expires_in - 60) * 1000,
          scope: tok.scope,
          email: emailFromIdToken(tok.id_token),
        };
        writeToken(saved);
        page(res, true, '已連結 Google 帳號');
        done(null, { email: saved.email, missing: SCOPES.filter((s) => s.startsWith('https') && !granted.includes(s)) });
      } catch (e) {
        page(res, false, '授權失敗');
        done(e);
      }
    });

    let redirectUri = null;
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString();
      openExternal(auth.toString());
      timer = setTimeout(() => done(new Error('等待授權逾時（5 分鐘），請再試一次')), AUTH_TIMEOUT_MS);
    });
    server.on('error', (e) => done(e));
  });
  return pending;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description || j.error || `token request failed (${res.status})`);
  return j;
}

// A valid access token, refreshed when needed.
async function accessToken() {
  const tok = readToken();
  if (!tok) throw new Error('尚未連結 Google 帳號');
  if (tok.access_token && Date.now() < tok.expires_at) return tok.access_token;
  const client = loadClient();
  if (!client) throw new Error('找不到 data\\google-credentials.json');
  let r;
  try {
    r = await tokenRequest({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: tok.refresh_token, grant_type: 'refresh_token' });
  } catch (e) {
    if (/invalid_grant|expired|revoked/i.test(e.message)) throw new Error('Google 授權已失效，請到設定重新連結帳號');
    throw e;
  }
  tok.access_token = r.access_token;
  tok.expires_at = Date.now() + (r.expires_in - 60) * 1000;
  writeToken(tok);
  return tok.access_token;
}

async function disconnect() {
  const tok = readToken();
  if (tok && tok.refresh_token) {
    // revoke on Google's side too, so the app disappears from the account's access list
    try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(tok.refresh_token), { method: 'POST' }); } catch {}
  }
  fs.rmSync(TOKEN_PATH, { force: true });
}

function status() {
  const tok = readToken();
  return {
    hasCredentials: !!loadClient(),
    connected: !!tok,
    email: tok ? tok.email : null,
    canMail: !!tok && (tok.scope || '').includes('gmail.send'),
    canCalendar: !!tok && (tok.scope || '').includes('calendar.app.created'),
    canDrive: !!tok && (tok.scope || '').includes('drive.metadata.readonly'),
  };
}

// ---------- Gmail ----------

const encWord = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

async function sendMail({ to, subject, html }) {
  const token = await accessToken();
  const recipient = to || readToken().email;
  const mime = [
    `To: ${recipient}`,
    `Subject: ${encWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
  ].join('\r\n');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(Buffer.from(mime, 'utf8')) }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error((j.error && j.error.message) || `Gmail 寄信失敗（${res.status}）`);
  }
  return recipient;
}

// ---------- Drive (metadata only: names, types, links) ----------

const DRIVE_FIELDS = 'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime,iconLink)';
// quote a value for a Drive query string: backslash and single quote are escaped
const qEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const FOLDER = 'application/vnd.google-apps.folder';

// mode: 'recent' | 'folder' (folderId, default root) | 'shared' | 'search' (query)
async function driveList({ mode = 'recent', folderId = 'root', query = '', pageToken = null } = {}) {
  const token = await accessToken();
  const p = new URLSearchParams({ fields: DRIVE_FIELDS, pageSize: '50', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
  if (mode === 'folder') { p.set('q', `'${qEsc(folderId)}' in parents and trashed = false`); p.set('orderBy', 'folder,name_natural'); }
  else if (mode === 'shared') { p.set('q', 'sharedWithMe = true and trashed = false'); p.set('orderBy', 'recency desc'); }
  else if (mode === 'search') { p.set('q', `name contains '${qEsc(query)}' and trashed = false`); p.set('orderBy', 'recency desc'); }
  else { p.set('q', `trashed = false and mimeType != '${FOLDER}'`); p.set('orderBy', 'recency desc'); }
  if (pageToken) p.set('pageToken', pageToken);
  const res = await fetch('https://www.googleapis.com/drive/v3/files?' + p, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || `Google 雲端硬碟讀取失敗（${res.status}）`);
  return { files: j.files || [], nextPageToken: j.nextPageToken || null };
}

module.exports = { configure, connect, disconnect, status, accessToken, sendMail, driveList };
