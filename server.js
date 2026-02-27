const express = require('express');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3847);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.INTUIT_CLIENT_ID;
const CLIENT_SECRET = process.env.INTUIT_CLIENT_SECRET;
const REDIRECT_URI = process.env.INTUIT_REDIRECT_URI || `${APP_BASE_URL}/oauth/callback`;
const API_HOST = process.env.INTUIT_API_HOST || 'https://sandbox-quickbooks.api.intuit.com';
const SCOPES = (process.env.INTUIT_SCOPES || 'com.intuit.quickbooks.accounting').trim();

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = `${API_HOST}/v2/oauth2/tokens/revoke`;

let oauthState = null;
let tokenStore = null;

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

app.get('/connect', (req, res) => {
  if (!ensureConfig(res)) {
    return;
  }

  const state = crypto.randomBytes(16).toString('hex');
  oauthState = state;

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', SCOPES);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('state', state);

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

  if (!state || String(state) !== oauthState) {
    res.status(400).send('Invalid OAuth state.');
    return;
  }

  if (!code) {
    res.status(400).send('Missing OAuth code.');
    return;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: REDIRECT_URI
    });

    const tokenResponse = await fetch(TOKEN_URL, {
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

    oauthState = null;

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
    const revokeResponse = await fetch(REVOKE_URL, {
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
  console.log(`AI Bookkeeping approval app listening on ${APP_BASE_URL} (port ${PORT})`);
});
