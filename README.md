# Imamu Helper - WhatsApp Group Request Auto-Approval Bot 🤖

A specialized WhatsApp Bot for **Imamu Helper** that automatically handles WhatsApp group join requests by verifying candidate numbers against the Imamu Helper user database.

---

## 🌟 Features

- **Automated Join Approval**: Listens for group join requests in WhatsApp groups and approves requests instantly if the phone number exists in the database.
- **Phone Number Normalization**: Automatically parses and matches Saudi (+966 / 05 / 5) and international phone number variations against database records.
- **Pending Review Mode**: Leaves unrecognized numbers pending for manual admin review (or optionally auto-rejects if `AUTO_REJECT_UNRECOGNIZED=true`).
- **Interactive Admin Commands**:
  - `!status` - Check bot status & database connectivity.
  - `!pending` - List all pending join requests across all admin groups.
  - `!approveall` - Run a scan across all groups and auto-approve all verified pending requesters.
  - `!check <phone>` - Manually search for a user by phone number in the database.
  - `!help` - Display available commands.
- **REST Health Check API**: HTTP server endpoint `/health` and `/api/approve-all` for monitoring and integration.
- **Automated CI/CD Workflow**: GitHub Actions workflow automatically builds and publishes production Docker images to GitHub Container Registry (`ghcr.io/az2oo1/imamu-helper-bot:latest`).
- **Image-based Docker Compose Setup**: Pure container-image deployment with persistent volume storage (`whatsapp_bot_auth`) for WhatsApp authentication state across container restarts.

---

## 🚀 Quickstart with Docker Compose

Start the bot container using the published `ghcr.io/az2oo1/imamu-helper-bot:latest` image:

```bash
docker compose up -d
```

To view the QR Code in container logs to authenticate WhatsApp:
```bash
docker compose logs -f
```

---

## ⚙️ GitHub Actions Workflow (CI/CD)

This repository includes an automated GitHub Actions workflow defined in [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml).

### Workflow Triggers:
- **Push to `main` / `master`**: Automatically builds and publishes `ghcr.io/az2oo1/imamu-helper-bot:latest`.
- **Release Tags (`v*.*.*`)**: Builds and tags release versions (e.g. `ghcr.io/az2oo1/imamu-helper-bot:v1.0.0`).
- **Pull Requests**: Builds the Docker image to verify compilation without pushing.
- **Manual Trigger (`workflow_dispatch`)**: Allows manual workflow runs from GitHub Actions UI.

---

## ⚙️ Environment Configuration (`.env`)

Copy `.env.example` to `.env` to customize default settings:

| Parameter | Default Value | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://root@100.70.48.23:26257/defaultdb?sslmode=disable` | PostgreSQL / CockroachDB connection string |
| `AUTO_REJECT_UNRECOGNIZED` | `false` | Set `true` to reject unregistered numbers automatically |
| `ADMIN_NUMBERS` | `""` | Comma-separated list of WhatsApp phone numbers allowed to send bot commands |
| `PORT` | `3001` | HTTP Healthcheck & REST API port |
| `USE_PAIRING_CODE` | `false` | Set `true` to use phone pairing code instead of scanning QR code |
| `PAIRING_PHONE_NUMBER` | `""` | Phone number for pairing code authentication |

---

## 🛠️ Local Development (Without Docker)

### 1. Installation
```bash
cd "Imamu-helper bot"
npm install
```

### 2. Development Mode
```bash
npm run dev
```

### 3. Test Database Connection
```bash
npm run test:db
```

### 4. Build Production Bundle
```bash
npm run build
npm start
```

---

## 📱 Pairing with WhatsApp

1. Start the bot (`docker compose up -d` or `npm run dev`).
2. Open WhatsApp on your phone (must use an account that is an **Admin** in your target groups).
3. Navigate to **Settings -> Linked Devices -> Link a Device**.
4. Scan the QR code rendered in stdout / docker logs (`docker compose logs -f`).
5. Once authenticated, credentials are stored in the volume `whatsapp_bot_auth`. The bot will auto-reconnect on restarts.

---

## 🔗 Health Check & REST API

- `GET http://localhost:3001/health`: Returns bot uptime, DB connection status, and connection state.
- `GET http://localhost:3001/api/check/:phone`: Query Imamu Helper database for a phone number.
- `POST http://localhost:3001/api/approve-all`: Triggers manual group scan & auto-approval of verified pending requesters.
