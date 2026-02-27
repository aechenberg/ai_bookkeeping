# AI Bookkeeping – Company-Internal Intuit Approval Surface

This repo includes a minimal Node/Express app to satisfy Intuit production approval URL requirements for a company-internal app. It is not intended for external/public users.

## What it provides

- `/` → Launch page (plain internal-use landing page)
- `/connect` → Starts Intuit OAuth flow
- `/oauth/callback` → Handles OAuth redirect and token exchange
- `/disconnect` → Revokes token using Intuit revocation endpoint
- `/health` → Returns running version/build info to verify deployment state

## 1) Configure environment

Copy `.env.example` to `.env` and set real values:

```bash
cp .env.example .env
```

Required values:

- `INTUIT_CLIENT_ID`
- `INTUIT_CLIENT_SECRET`
- `APP_BASE_URL` (e.g. `https://bookkeeping.yourdomain.com`)
- `INTUIT_REDIRECT_URI` (e.g. `https://bookkeeping.yourdomain.com/oauth/callback`)

Optional:

- `APP_VERSION` (set to commit SHA or release tag for easy runtime verification)

## 2) Run locally

```bash
npm install
npm start
```

Default server port: `3847`

## 3) Intuit app settings (Production)

Use these in Intuit's form:

- Host domain: `bookkeeping.yourdomain.com`
- Launch URL: `https://bookkeeping.yourdomain.com/`
- Disconnect URL: `https://bookkeeping.yourdomain.com/disconnect`
- Connect/Reconnect URL: `https://bookkeeping.yourdomain.com/connect`
- Redirect URI: `https://bookkeeping.yourdomain.com/oauth/callback`

## 4) HTTPS on Ubuntu with Caddy (recommended)

Install Caddy:

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Example `/etc/caddy/Caddyfile`:

```caddy
bookkeeping.yourdomain.com {
	reverse_proxy 127.0.0.1:3847
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy
```

Point DNS `A` record for `bookkeeping.yourdomain.com` to your server IP, then Caddy will auto-manage Let's Encrypt certificates.

## 5) Run app as a service (optional)

Example systemd unit: `/etc/systemd/system/ai-bookkeeping.service`

```ini
[Unit]
Description=AI Bookkeeping Intuit Approval App
After=network.target

[Service]
Type=simple
WorkingDirectory=/workspaces/ai_bookkeeping
Environment=NODE_ENV=production
EnvironmentFile=/workspaces/ai_bookkeeping/.env
ExecStart=/usr/bin/node /workspaces/ai_bookkeeping/server.js
Restart=always
User=user

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-bookkeeping
sudo systemctl status ai-bookkeeping
```
