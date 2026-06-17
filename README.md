# Inventory Nexus

Deployable Node.js + Express + SQLite inventory tracker with barcode scanning, owner PIN unlock, and Twilio SMS alerts.

## Quick Start

1. Copy `.env.example` to `.env`.
2. Edit `.env` and set strong passwords, a strong `JWT_SECRET`, and Twilio credentials.
3. Install dependencies:

```bash
npm install
```

4. Initialize SQLite:

```bash
npm run db:init
```

5. Start the app:

```bash
npm start
```

6. Open `http://localhost:3000`.

Default seed values from `.env.example` are:

- Owner username: `owner`
- Owner password: `OwnerPass!2026`
- Owner PIN: `493827`
- Worker username: `worker`
- Worker password: `WorkerPass!2026`

Change these before production.

## Docker

```bash
cp .env.example .env
# edit .env first
docker compose up --build
```

## Production Notes

- Use HTTPS in production. Browser camera access requires HTTPS outside localhost.
- Set `COOKIE_SECURE=true` when serving over HTTPS.
- Set `TWILIO_ENABLED=false` for local testing without SMS.
- Keep `.env` and SQLite files out of source control.
- Run `npm audit` before deployment.
