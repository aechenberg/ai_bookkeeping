const express = require('express');
const crypto = require('crypto');
const { execSync } = require('child_process');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3847);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.INTUIT_CLIENT_ID;
const CLIENT_SECRET = process.env.INTUIT_CLIENT_SECRET;
const REDIRECT_URI = process.env.INTUIT_REDIRECT_URI || `${APP_BASE_URL}/oauth/callback`;
const SCOPES = (process.env.INTUIT_SCOPES || 'com.intuit.quickbooks.accounting').trim();

function resolveVersion() {
  if (process.env.APP_VERSION) {
    return process.env.APP_VERSION;
  }
  if (process.env.GIT_COMMIT) {
    return process.env.GIT_COMMIT;
  }

  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch (_error) {
    return 'unknown';
  }
}

const APP_VERSION = resolveVersion();

const DISCOVERY_URL = 'https://developer.api.intuit.com/.well-known/openid_configuration';
const FALLBACK_ENDPOINTS = {
  authorization_endpoint: 'https://appcenter.intuit.com/connect/oauth2',
  token_endpoint: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revocation_endpoint: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'
};

const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

let oauthPending = null;
let tokenStore = null;
let discoveryCache = null;
let discoveryCacheAt = 0;

function ensureConfig(res) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    res.status(500).send('Missing INTUIT_CLIENT_ID or INTUIT_CLIENT_SECRET in environment.');
    return false;
  }
  return true;
}

function base64Credentials(clientId, clientSecret) {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createCodeVerifier() {
  return base64UrlEncode(crypto.randomBytes(64));
}

function createCodeChallenge(verifier) {
  const digest = crypto.createHash('sha256').update(verifier).digest();
  return base64UrlEncode(digest);
}

async function getIntuitEndpoints() {
  if (discoveryCache && Date.now() - discoveryCacheAt < 10 * 60 * 1000) {
    return discoveryCache;
  }

  try {
    const response = await fetch(DISCOVERY_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      return FALLBACK_ENDPOINTS;
    }

    const json = await response.json();
    const endpoints = {
      authorization_endpoint: json.authorization_endpoint || FALLBACK_ENDPOINTS.authorization_endpoint,
      token_endpoint: json.token_endpoint || FALLBACK_ENDPOINTS.token_endpoint,
      revocation_endpoint: json.revocation_endpoint || FALLBACK_ENDPOINTS.revocation_endpoint
    };

    discoveryCache = endpoints;
    discoveryCacheAt = Date.now();
    return endpoints;
  } catch (_error) {
    return FALLBACK_ENDPOINTS;
  }
}

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Bookkeeping AI</title></head>
  <body style="font-family: sans-serif; max-width: 720px; margin: 40px auto;">
    <h1>Bookkeeping AI — Company Internal Only</h1>
    <p>This endpoint is for authorized company staff only and is not intended for external/public use.</p>
    <ul>
      <li><a href="/connect">Connect to Intuit</a></li>
      <li><a href="/disconnect">Disconnect from Intuit</a></li>
    </ul>
  </body>
</html>`);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: APP_VERSION,
    service: 'ai-bookkeeping',
    internalOnly: true
  });
});

app.get('/connect', async (req, res) => {
  if (!ensureConfig(res)) {
    return;
  }

  const state = crypto.randomBytes(32).toString('hex');
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const endpoints = await getIntuitEndpoints();

  oauthPending = {
    state,
    codeVerifier,
    createdAt: Date.now()
  };

  const authorizeUrl = new URL(endpoints.authorization_endpoint);
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', SCOPES);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  if (req.query.realmId) {
    authorizeUrl.searchParams.set('realmId', String(req.query.realmId));
  }

  res.redirect(authorizeUrl.toString());
});

app.get('/oauth/callback', async (req, res) => {
  if (!ensureConfig(res)) {
    return;
  }

  const { state, code, realmId } = req.query;

  if (!oauthPending || !state || String(state) !== oauthPending.state) {
    res.status(400).send('Invalid OAuth state.');
    return;
  }

  if (Date.now() - oauthPending.createdAt > OAUTH_PENDING_TTL_MS) {
    oauthPending = null;
    res.status(400).send('OAuth state expired. Start again from /connect.');
    return;
  }

  if (!code) {
    res.status(400).send('Missing OAuth code.');
    return;
  }

  const { codeVerifier } = oauthPending;
  oauthPending = null;

  try {
    const endpoints = await getIntuitEndpoints();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier
    });

    const tokenResponse = await fetch(endpoints.token_endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${base64Credentials(CLIENT_ID, CLIENT_SECRET)}`
      },
      body
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      res.status(502).send(`Token exchange failed: ${errorBody}`);
      return;
    }

    const tokenJson = await tokenResponse.json();
    tokenStore = {
      realmId: realmId ? String(realmId) : undefined,
      ...tokenJson
    };

    res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Connected</title></head>
  <body style="font-family: sans-serif; max-width: 720px; margin: 40px auto;">
    <h1>Connected</h1>
    <p>OAuth connection completed successfully.</p>
    <p>Access restricted to authorized company employees only.</p>
    <p><a href="/">Back to launch page</a></p>
  </body>
</html>`);
  } catch (error) {
    res.status(500).send(`OAuth callback error: ${error.message}`);
  }
});

app.get('/disconnect', async (_req, res) => {
  if (!ensureConfig(res)) {
    return;
  }

  const token = tokenStore?.refresh_token || tokenStore?.access_token;

  if (!token) {
    res.status(400).send('No stored token to revoke. Connect first.');
    return;
  }

  try {
    const endpoints = await getIntuitEndpoints();
    const revokeResponse = await fetch(endpoints.revocation_endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${base64Credentials(CLIENT_ID, CLIENT_SECRET)}`
      },
      body: JSON.stringify({ token })
    });

    if (!revokeResponse.ok) {
      const errorBody = await revokeResponse.text();
      res.status(502).send(`Token revoke failed: ${errorBody}`);
      return;
    }

    tokenStore = null;

    res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Disconnected</title></head>
  <body style="font-family: sans-serif; max-width: 720px; margin: 40px auto;">
    <h1>Disconnected</h1>
    <p>Intuit token revoked successfully.</p>
    <p>Access restricted to authorized company employees only.</p>
    <p><a href="/">Back to launch page</a></p>
  </body>
</html>`);
  } catch (error) {
    res.status(500).send(`Disconnect error: ${error.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`AI Bookkeeping approval app listening on ${APP_BASE_URL} (port ${PORT}, version ${APP_VERSION})`);
});
