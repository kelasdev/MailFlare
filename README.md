# MailFlare

MailFlare adalah PWA manajemen email berbasis **Cloudflare Worker + D1** dengan integrasi **Telegram Bot** untuk notifikasi dan kontrol cepat.

Project ini memakai arsitektur **single unified worker**:
- `fetch` untuk PWA assets + API
- `email` untuk inbound email (Cloudflare Email Routing)
- `scheduled` untuk metrik housekeeping

## Fitur Utama

### PWA (Single URL, state internal)
- Dashboard statistik email.
- User List (buat/hapus user inbox).
- Inbox per user (search, refresh, aksi cepat).
- Detail email (full body text / HTML render).
- Settings & runtime stats.
- State halaman disimpan di `localStorage` agar tetap lanjut setelah reload.

### Private Gateway
- Semua halaman utama/API dilindungi session private zone.
- Login pakai **one-time access code** dari Telegram command `/access`.
- Kode berlaku 24 jam, sekali pakai, lalu dibuat session cookie 24 jam.

### Telegram Bot
- Webhook dilindungi `TELEGRAM_WEBHOOK_SECRET`.
- Akses bot dibatasi `TELEGRAM_ALLOWED_IDS`.
- Mendukung command:
  - `/start`
  - `/stats`
  - `/adduser <username>`
  - `/listuser [asc|desc]` (alias kompatibilitas: `/listuse`)
  - `/inbox [username]`
  - `/apikey`
  - `/resend <email_id|short_id>`
  - `/access`
- Notifikasi inbound email mendukung inline action: read/unread, star/unstar, archive/delete, dan tombol preview HTML.

### API Key (v1)
- API key dibuat dari Telegram command `/apikey`.
- Key mentah ditampilkan **sekali** di Telegram.
- Yang disimpan di D1 hanya hash (`api_keys.key_hash`), bukan plaintext.
- Saat ini API key belum dipakai sebagai auth request API publik; disiapkan untuk integrasi aplikasi eksternal tahap berikutnya.

## Stack

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Email Routing (Email Worker)
- Svelte 5 + Vite (PWA shell)
- TypeScript + pnpm

## Struktur Singkat

- `worker/` -> runtime worker (`fetch/email/scheduled`)
- `frontend/` -> PWA Svelte
- `migrations/` -> skema D1
- `scripts/` -> util setup Telegram command

## Prasyarat

- Node.js 20+
- `pnpm`
- Akun Cloudflare (domain aktif)
- Telegram bot token dari BotFather

## Konfigurasi `wrangler.toml`

Contoh inti:

```toml
name = "mail-flare"
main = "worker/index.ts"
compatibility_date = "2026-04-02"

[assets]
directory = "./frontend/dist"
binding = "ASSETS"
run_worker_first = true

[[d1_databases]]
binding = "mailflare_db"
database_name = "mailflare-db"
database_id = "REPLACE_ME"
```

## Environment Variables & Secrets

Gunakan **Secrets** untuk nilai sensitif:

- `TELEGRAM_BOT_TOKEN` (secret)
- `TELEGRAM_WEBHOOK_SECRET` (secret)
- `TELEGRAM_ALLOWED_IDS` (secret direkomendasikan, format CSV: `123456,789012`)

Variable non-sensitif:

- `MAILFLARE_INBOUND_DOMAIN` (contoh: `mx.kelasdev.my.id`)
- `MAILFLARE_PUBLIC_BASE_URL` (opsional, untuk link preview Telegram bila origin harus dipaksa)

Contoh set secret:

```powershell
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET
'123456789,987654321' | pnpm wrangler secret put TELEGRAM_ALLOWED_IDS
```

## Setup Lokal Cepat

1. Install dependency:

```bash
pnpm install
```

2. Build frontend:

```bash
pnpm build
```

3. Jalankan worker lokal:

```bash
pnpm dev
```

4. (Opsional) Jalankan frontend Vite terpisah:

```bash
pnpm dev:frontend
```

Catatan: pada `localhost`, private gateway dibypass untuk memudahkan tuning UI.

## Setup D1

1. Buat DB:

```bash
pnpm wrangler d1 create mailflare-db
```

2. Update `database_id` di `wrangler.toml`.

3. Apply migration:

```bash
pnpm wrangler d1 migrations apply mailflare-db --local
pnpm wrangler d1 migrations apply mailflare-db --remote
```

## Deploy

```bash
pnpm deploy
```

## Setup Telegram Webhook

Set webhook ke worker:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<YOUR_DOMAIN>/api/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d "drop_pending_updates=true"
```

Sync daftar command bot (opsional tapi direkomendasikan):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\set-telegram-commands.ps1 -BotToken "<BOT_TOKEN>"
```

## Setup Email Routing (Catch-all ke Worker)

Arahkan catch-all ke worker `mail-flare`.

Perilaku MailFlare saat inbound:
- Jika recipient ada di tabel `users` -> email disimpan ke `emails`.
- Jika recipient tidak terdaftar -> email ditolak (`setReject`) dan tidak masuk database.

Artinya Anda cukup buat user di PWA/Telegram (`/adduser username`) lalu kirim email ke:
- `username@<MAILFLARE_INBOUND_DOMAIN>`

## API Endpoints

Endpoint berikut butuh session private gateway (kecuali disebut public):

- `GET /healthz`
- `GET /api/dashboard/stats`
- `GET /api/users`
- `POST /api/users`
- `DELETE /api/users/:userId`
- `GET /api/users/:userId/inbox`
- `GET /api/emails/recent`
- `GET /api/emails/:emailId`
- `PATCH /api/emails/:emailId/status`
- `GET /api/settings/runtime`
- `PUT /api/settings/profile`
- `POST /api/settings/telegram/test`
- `GET /api/settings/telegram/webhook-status`
- `POST /api/apikey/action` (auth via API key, output JSON)

Public endpoint:
- `POST /api/telegram/webhook` (tetap diverifikasi secret + allowed IDs)
- `GET /tg/preview` (signed URL, TTL terbatas)
- `GET /auth/access-denied`
- `POST /auth/redeem`
- `GET /auth/logout`
- `GET /auth/<MF-XXXX-XXXX-XXXX>` (quick redirect ke gateway)

## Alur Penggunaan

1. Admin chat bot Telegram -> `/access`.
2. Bot kirim one-time code.
3. Buka domain MailFlare -> masukkan code di halaman private zone.
4. Masuk PWA:
   - Buat user inbox.
   - Monitor inbox & detail email.
   - Atur Telegram forwarding di Settings.
5. Inbound email masuk -> tersimpan di D1 + notifikasi ke Telegram.

## Status API Key Saat Ini

`/apikey` cocok untuk bootstrap kredensial integrasi eksternal:
- dibuat via Telegram user yang diizinkan,
- disimpan aman (hash only),
- bisa dipakai ke endpoint command JSON: `POST /api/apikey/action`.

Jika Anda ingin, tahap berikutnya bisa tambah:
- middleware validasi API key untuk endpoint tertentu,
- list/revoke key,
- audit usage per key.

## Cara Pakai API Key (Command JSON)

1. Generate key dari Telegram:

```text
/apikey
```

2. Panggil endpoint command JSON dengan header `X-API-Key` (atau `Authorization: Bearer <key>`).
   Payload minimal:
   - `action`: nama command (`listuser`, `adduser`, `inbox`, dst)
   - `argv`: argumen string atau array string

Contoh `stats`:

```bash
curl -X POST "https://<YOUR_DOMAIN>/api/apikey/action" \
  -H "content-type: application/json" \
  -H "x-api-key: <YOUR_API_KEY>" \
  -d "{\"action\":\"stats\"}"
```

Contoh `listuser` sort descending, page 0:

```bash
curl -X POST "https://<YOUR_DOMAIN>/api/apikey/action" \
  -H "content-type: application/json" \
  -H "x-api-key: <YOUR_API_KEY>" \
  -d "{\"action\":\"listuser\",\"argv\":\"desc\",\"page\":0,\"pageSize\":5}"
```

Contoh `inbox` by username:

```bash
curl -X POST "https://<YOUR_DOMAIN>/api/apikey/action" \
  -H "content-type: application/json" \
  -H "x-api-key: <YOUR_API_KEY>" \
  -d "{\"action\":\"inbox\",\"argv\":\"alex\",\"maxItems\":10}"
```

Command yang didukung di endpoint JSON:
- `start`
- `stats`
- `adduser <username>`
- `listuser [asc|desc]`
- `inbox [username]`
- `resend <email_id|short_id>`
- `access`
- `apikey`
