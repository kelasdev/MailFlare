import {
  findUserIdByLookup,
  consumeAccessCode,
  createUser,
  deleteUserById,
  findEmailIdsByPrefix,
  findUserIdByEmail,
  getStoredSettings,
  getDashboardStats,
  getEmailById,
  incrementMetric,
  insertAccessCode,
  insertAccessSession,
  insertInboundEmail,
  isAccessSessionValid,
  listWorkerMetrics,
  listInboxByUser,
  listRecentEmails,
  listUsers,
  patchEmailStatus,
  saveStoredSettings
} from "./db";
import { parseInboundEmail } from "./utils/email";
import {
  answerTelegramCallbackQuery,
  editTelegramMessageReplyMarkup,
  getTelegramWebhookInfo,
  isAllowedTelegramUser,
  parseAllowedIds,
  parseTelegramCommand,
  sendTelegramMessage
} from "./utils/telegram";
import type { EmailRecord, EmailStatusAction, Env, InboundEmail, RuntimeSettings } from "./types";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

const ACCESS_SESSION_COOKIE_NAME = "mailflare_private_session";
const ACCESS_CODE_TTL_HOURS = 24;
const ACCESS_SESSION_TTL_SECONDS = 60 * 60 * 24;
const TELEGRAM_PREVIEW_TTL_SECONDS = 60 * 30;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  const contentType = headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    headers.set("cache-control", "no-store, no-cache, must-revalidate");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
  return withSecurityHeaders(response);
}

function htmlResponse(html: string, status = 200): Response {
  return withSecurityHeaders(
    new Response(html, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8"
      }
    })
  );
}

function getPathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function accessCodeFromPath(pathname: string): string | null {
  const segments = getPathSegments(pathname);
  if (segments.length !== 2) return null;
  if (segments[0] !== "auth") return null;
  const candidate = decodeURIComponent(segments[1] ?? "").trim().toUpperCase();
  if (!/^MF-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(candidate)) {
    return null;
  }
  return candidate;
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/api/telegram/webhook" ||
    pathname === "/tg/preview" ||
    pathname === "/auth/access-denied" ||
    pathname === "/auth/redeem" ||
    pathname === "/auth/logout" ||
    accessCodeFromPath(pathname) !== null
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeInboundDomain(value: string | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";
  return raw.replace(/^@+/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function statusActionFromInput(value: unknown): EmailStatusAction | null {
  if (
    value === "read" ||
    value === "unread" ||
    value === "star" ||
    value === "unstar" ||
    value === "archive" ||
    value === "delete"
  ) {
    return value;
  }
  return null;
}

function markdownV2CodeBlock(text: string, label: string): string {
  const sanitized = text.replace(/\\/g, "\\\\").replace(/`/g, "'").replace(/```/g, "'''");
  return `\`\`\`${label}\n${sanitized}\n\`\`\``;
}

interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

function buildEmailActionKeyboard(
  email: Pick<EmailRecord, "id" | "isRead" | "isStarred" | "isArchived" | "deletedAt">
): TelegramInlineKeyboard {
  const readAction = email.isRead ? "unread" : "read";
  const readLabel = email.isRead ? "✅ Read" : "📩 Unread";
  const starAction = email.isStarred ? "unstar" : "star";
  const starLabel = email.isStarred ? "⭐ Starred" : "☆ Star";
  const archiveLabel = email.isArchived ? "📦 Archived" : "🗄️ Archive";
  const deleteLabel = email.deletedAt ? "🗑️ Deleted" : "🗑️ Delete";
  return {
    inline_keyboard: [
      [
        { text: readLabel, callback_data: `mf:act:${readAction}:${email.id}` },
        { text: starLabel, callback_data: `mf:act:${starAction}:${email.id}` }
      ],
      [
        { text: archiveLabel, callback_data: `mf:act:archive:${email.id}` },
        { text: deleteLabel, callback_data: `mf:act:delete:${email.id}` }
      ],
      [{ text: "🌐 Preview HTML", callback_data: `mf:html:${email.id}` }]
    ]
  };
}

function parseTelegramCallbackData(
  data: string
): { kind: "action"; action: EmailStatusAction; emailId: string } | { kind: "html"; emailId: string } | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith("mf:")) return null;
  const parts = trimmed.split(":");
  if (parts[1] === "act" && parts.length >= 4) {
    const action = statusActionFromInput(parts[2]);
    const emailId = parts.slice(3).join(":").trim();
    if (!action || !emailId) return null;
    return { kind: "action", action, emailId };
  }
  if (parts[1] === "html" && parts.length >= 3) {
    const emailId = parts.slice(2).join(":").trim();
    if (!emailId) return null;
    return { kind: "html", emailId };
  }
  return null;
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return url.origin;
  } catch {
    return null;
  }
}

function shortEmailId(emailId: string): string {
  const compact = emailId.trim();
  if (!compact) return "unknown";
  if (compact.length <= 8) return compact;
  return compact.slice(0, 8);
}

function codeBlockLabelFromEmailId(emailId: string): string {
  return shortEmailId(emailId).replace(/[^a-zA-Z0-9_+-]/g, "");
}

function previewText(
  sourceEmail: Pick<InboundEmail, "bodyText" | "snippet">,
  limit = 280
): string {
  const source = (sourceEmail.bodyText ?? sourceEmail.snippet ?? "").replace(/\s+/g, " ").trim();
  if (!source) return "(No preview)";
  if (source.length <= limit) return source;
  return `${source.slice(0, limit - 3).trimEnd()}...`;
}

function buildInboundAlertMarkdown(
  email: Pick<InboundEmail, "id" | "recipient" | "sender" | "subject" | "bodyText" | "snippet">
): string {
  const subject = email.subject?.trim() || "(No Subject)";
  const body = previewText(email, 600);
  const notes = [
    `From    : ${email.sender}`,
    `To      : ${email.recipient}`,
    `Subject : ${subject}`,
    "",
    "Body",
    "----",
    body
  ].join("\n");

  return [
    "*📨 MailFlare Inbound Alert*",
    "",
    markdownV2CodeBlock(notes, codeBlockLabelFromEmailId(email.id))
  ]
    .filter(Boolean)
    .join("\n");
}

function inboundAlertMarkdown(email: InboundEmail): string {
  return buildInboundAlertMarkdown(email);
}

function inboundAlertMarkdownFromRecord(email: EmailRecord): string {
  return buildInboundAlertMarkdown(email);
}

function normalizeEmailLookupArg(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^#+/, "");
}

async function resolveEmailByArg(
  db: D1Database,
  rawArg: string | undefined
): Promise<{ email: EmailRecord | null; error: string | null }> {
  const arg = normalizeEmailLookupArg(rawArg);
  if (!arg) {
    return { email: null, error: "Usage: provide an email ID." };
  }

  const exact = await getEmailById(db, arg);
  if (exact) {
    return { email: exact, error: null };
  }

  if (arg.length < 6) {
    return { email: null, error: "ID too short. Use at least 6 characters." };
  }

  const matches = await findEmailIdsByPrefix(db, arg, 2);
  if (matches.length === 0) {
    return { email: null, error: "Email not found." };
  }

  if (matches.length > 1) {
    return { email: null, error: "ID prefix ambiguous. Use a longer ID." };
  }

  const resolved = await getEmailById(db, matches[0]);
  if (!resolved) {
    return { email: null, error: "Email not found." };
  }
  return { email: resolved, error: null };
}

function parseCookies(request: Request): Map<string, string> {
  const raw = request.headers.get("cookie");
  const map = new Map<string, string>();
  if (!raw) return map;
  const parts = raw.split(";");
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    map.set(key, value);
  }
  return map;
}

function randomString(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function generateAccessCode(): string {
  return `MF-${randomString(4)}-${randomString(4)}-${randomString(4)}`;
}

async function hashText(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(digest));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expiresAtIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function clientIpFromRequest(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "";
  return "";
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function previewSigningSecret(env: Env): string | null {
  const candidate = env.TELEGRAM_WEBHOOK_SECRET?.trim() || env.TELEGRAM_BOT_TOKEN?.trim() || "";
  return candidate || null;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function resolvePreviewBaseUrl(env: Env, fallbackOrigin?: string): string | null {
  return normalizeBaseUrl(env.MAILFLARE_PUBLIC_BASE_URL) ?? normalizeBaseUrl(fallbackOrigin);
}

async function buildTelegramPreviewUrl(
  env: Env,
  baseUrl: string,
  telegramUserId: string,
  emailId: string
): Promise<string | null> {
  const secret = previewSigningSecret(env);
  if (!secret) return null;

  const expiresAt = Math.floor(Date.now() / 1000) + TELEGRAM_PREVIEW_TTL_SECONDS;
  const payload = `${telegramUserId}|${emailId}|${expiresAt}`;
  const signature = await hmacSha256Hex(secret, payload);
  const url = new URL("/tg/preview", baseUrl);
  url.searchParams.set("uid", telegramUserId);
  url.searchParams.set("eid", emailId);
  url.searchParams.set("exp", String(expiresAt));
  url.searchParams.set("sig", signature);
  return url.toString();
}

async function verifyTelegramPreviewRequest(
  request: Request,
  env: Env
): Promise<{ uid: string; emailId: string } | null> {
  const secret = previewSigningSecret(env);
  if (!secret) return null;

  const url = new URL(request.url);
  const uid = url.searchParams.get("uid")?.trim() ?? "";
  const emailId = url.searchParams.get("eid")?.trim() ?? "";
  const expRaw = url.searchParams.get("exp")?.trim() ?? "";
  const signature = url.searchParams.get("sig")?.trim() ?? "";
  if (!uid || !emailId || !expRaw || !signature) return null;

  const exp = Number.parseInt(expRaw, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(exp) || exp <= now) return null;

  const allowed = parseAllowedIds(env.TELEGRAM_ALLOWED_IDS);
  if (!isAllowedTelegramUser(allowed, uid)) return null;

  const payload = `${uid}|${emailId}|${exp}`;
  const expected = await hmacSha256Hex(secret, payload);
  if (expected !== signature) return null;

  return { uid, emailId };
}

function renderTelegramPreviewPage(email: EmailRecord): string {
  const subject = escapeHtml(email.subject?.trim() || "(No Subject)");
  const from = escapeHtml(email.sender);
  const to = escapeHtml(email.recipient);
  const htmlBody = email.bodyHtml?.trim() ?? "";
  const textBody = escapeHtml(email.bodyText?.trim() || email.snippet?.trim() || "(No body)");

  const renderedBody = htmlBody
    ? `<iframe class="mail-frame" sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeHtml(htmlBody)}"></iframe>`
    : `<pre class="mail-text">${textBody}</pre>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MailFlare HTML Preview</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        font-family: Inter, sans-serif;
        background: #060c17;
        color: #e8edf7;
      }
      .wrap {
        max-width: 1100px;
        margin: 0 auto;
        padding: 20px;
      }
      .meta {
        background: #101a2a;
        border: 1px solid #22324a;
        border-radius: 12px;
        padding: 14px 16px;
        margin-bottom: 14px;
      }
      .meta-row {
        margin: 0 0 8px;
        font-size: 14px;
        line-height: 1.4;
      }
      .meta-row:last-child { margin-bottom: 0; }
      .mail-frame {
        width: 100%;
        min-height: calc(100vh - 190px);
        border: 1px solid #22324a;
        border-radius: 12px;
        background: #fff;
      }
      .mail-text {
        margin: 0;
        background: #0d1624;
        border: 1px solid #22324a;
        border-radius: 12px;
        padding: 16px;
        white-space: pre-wrap;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="meta">
        <p class="meta-row"><strong>Subject:</strong> ${subject}</p>
        <p class="meta-row"><strong>From:</strong> ${from}</p>
        <p class="meta-row"><strong>To:</strong> ${to}</p>
      </section>
      ${renderedBody}
    </main>
  </body>
</html>`;
}

async function handleTelegramPreviewRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const verified = await verifyTelegramPreviewRequest(request, env);
  if (!verified) {
    return htmlResponse(renderAccessDeniedPage("Preview link invalid or expired."), 401);
  }

  const email = await getEmailById(env.mailflare_db, verified.emailId);
  if (!email) {
    return htmlResponse(renderAccessDeniedPage("Email not found."), 404);
  }

  return htmlResponse(renderTelegramPreviewPage(email), 200);
}

function renderAccessDeniedPage(errorText?: string): string {
  const message = errorText
    ? `<p class="hint error">${escapeHtml(errorText)}</p>`
    : `<p class="hint">Area privat. Minta one-time access code lewat Telegram bot lalu masukkan di bawah.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MailFlare Private Zone</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        min-height: 100svh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: clamp(16px, 3vw, 32px);
        padding-top: max(clamp(16px, 3vw, 32px), env(safe-area-inset-top));
        padding-bottom: max(clamp(16px, 3vw, 32px), env(safe-area-inset-bottom));
        box-sizing: border-box;
        font-family: Inter, sans-serif;
        background: radial-gradient(circle at 20% 20%, #11294a 0%, #09172c 42%, #050d19 100%);
        color: #e8f1ff;
        overflow-x: hidden;
        overflow-y: auto;
      }
      .card {
        width: min(100%, 500px);
        border-radius: 18px;
        background: rgba(15, 32, 56, 0.86);
        border: 1px solid rgba(255, 255, 255, 0.14);
        padding: clamp(20px, 3vw, 30px);
        box-shadow: 0 22px 60px rgba(0, 0, 0, 0.34);
      }
      .brand {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 8px;
        margin-bottom: 16px;
      }
      .brand-mark {
        width: clamp(64px, 16vw, 86px);
        height: auto;
        filter: drop-shadow(0 10px 24px rgba(246, 130, 31, 0.34));
      }
      .brand-name {
        margin: 0;
        font-size: clamp(1.15rem, 1.7vw, 1.35rem);
        line-height: 1.2;
        letter-spacing: 0.01em;
        color: #ffb46b;
        font-weight: 800;
      }
      .brand-sub {
        margin: 0;
        font-size: 0.86rem;
        color: #a9bfe3;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .title {
        margin: 0 0 8px;
        font-size: clamp(1.08rem, 1.6vw, 1.25rem);
        font-weight: 700;
        text-align: center;
      }
      .hint {
        margin: 0 0 18px;
        color: #b8cae8;
        font-size: clamp(0.9rem, 1.2vw, 0.95rem);
        line-height: 1.45;
        text-align: center;
      }
      .error {
        color: #ffb4a0;
      }
      label {
        display: block;
        margin-bottom: 8px;
        font-size: 0.86rem;
        color: #b3c6e8;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(3, 14, 28, 0.84);
        color: #f3f7ff;
        padding: 12px 13px;
        letter-spacing: 0.045em;
        text-transform: uppercase;
      }
      input:focus {
        outline: 2px solid rgba(255, 161, 85, 0.55);
        outline-offset: 1px;
      }
      button {
        margin-top: 14px;
        width: 100%;
        border: none;
        border-radius: 10px;
        background: linear-gradient(90deg, #ff8e3a, #ff6a2d);
        color: #141414;
        font-weight: 700;
        padding: 12px 14px;
        cursor: pointer;
      }
      button:hover {
        filter: brightness(1.06);
      }
      .foot {
        margin-top: 14px;
        font-size: 0.8rem;
        color: #9eb4da;
        text-align: center;
      }
      @media (max-width: 420px) {
        body {
          align-items: flex-start;
        }
        .card {
          border-radius: 14px;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
        }
        .brand {
          margin-bottom: 14px;
        }
        .foot {
          font-size: 0.76rem;
        }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="brand">
        <svg class="brand-mark" viewBox="0 0 220 120" role="img" aria-label="Cloud icon">
          <defs>
            <linearGradient id="cfg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#ffb44a" />
              <stop offset="100%" stop-color="#f6821f" />
            </linearGradient>
          </defs>
          <ellipse cx="110" cy="78" rx="88" ry="28" fill="url(#cfg)" />
          <circle cx="72" cy="66" r="27" fill="#ffb44a" />
          <circle cx="108" cy="54" r="34" fill="#ff9d35" />
          <circle cx="148" cy="66" r="24" fill="#f6821f" />
        </svg>
        <p class="brand-name">MailFlare</p>
        <p class="brand-sub">Private Gateway</p>
      </div>
      <h1 class="title">MailFlare Private Zone</h1>
      ${message}
      <form action="/auth/redeem" method="post">
        <label for="code">One-time Access Code</label>
        <input id="code" name="code" type="text" placeholder="MF-XXXX-XXXX-XXXX" required />
        <button type="submit">Unlock</button>
      </form>
      <p class="foot">Code hanya bisa dipakai 1x dan kadaluarsa 24 jam.</p>
    </main>
    <script>
      (() => {
        const input = document.getElementById("code");
        const form = input?.form;
        if (!input || !form) return;
        const raw = decodeURIComponent((location.hash || "").replace(/^#/, "")).trim().toUpperCase();
        const ok = /^MF-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(raw);
        if (!ok) return;
        input.value = raw;
        history.replaceState(null, "", "/auth/access-denied");
        form.submit();
      })();
    </script>
  </body>
</html>`;
}

function buildSessionCookie(token: string, request: Request): string {
  const url = new URL(request.url);
  const attributes = [
    `${ACCESS_SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${ACCESS_SESSION_TTL_SECONDS}`
  ];
  if (url.protocol === "https:") {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

function clearSessionCookie(request: Request): string {
  const url = new URL(request.url);
  const attributes = [
    `${ACCESS_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ];
  if (url.protocol === "https:") {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

async function isSessionAuthorized(request: Request, env: Env): Promise<boolean> {
  const cookies = parseCookies(request);
  const token = cookies.get(ACCESS_SESSION_COOKIE_NAME);
  if (!token) return false;
  const tokenHash = await hashText(token);
  return isAccessSessionValid(env.mailflare_db, tokenHash);
}

async function isRequestAuthorized(request: Request, env: Env): Promise<boolean> {
  const url = new URL(request.url);
  if (isLocalHost(url.hostname)) {
    return true;
  }

  return isSessionAuthorized(request, env);
}

function resolveTelegramForwardTargets(
  allowedIds: Set<string>,
  stored: RuntimeSettings["stored"]
): string[] {
  if (!stored.telegramForwardEnabled) {
    return [];
  }
  if (stored.telegramForwardMode === "specific") {
    const target = stored.telegramForwardChatId.trim() || stored.defaultTelegramChatId.trim();
    if (!target) return [];
    if (!allowedIds.has(target)) {
      return [];
    }
    return [target];
  }
  return Array.from(allowedIds);
}

async function handleAccessRedeem(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return htmlResponse(renderAccessDeniedPage(), 200);
  }

  const form = await request.formData().catch(() => null);
  const rawCode = String(form?.get("code") ?? "").trim().toUpperCase();
  return redeemAccessCode(rawCode, request, env);
}

async function redeemAccessCode(rawCode: string, request: Request, env: Env): Promise<Response> {
  if (!rawCode) {
    return htmlResponse(renderAccessDeniedPage("Kode akses wajib diisi."), 400);
  }

  const codeHash = await hashText(rawCode);
  const codeId = await consumeAccessCode(env.mailflare_db, codeHash);
  if (!codeId) {
    await incrementMetric(env.mailflare_db, "private_access_code_invalid");
    return htmlResponse(
      renderAccessDeniedPage("Kode tidak valid / sudah dipakai / sudah kadaluarsa."),
      401
    );
  }

  const sessionToken = randomString(48);
  const sessionHash = await hashText(sessionToken);
  await insertAccessSession(env.mailflare_db, {
    id: crypto.randomUUID(),
    tokenHash: sessionHash,
    codeId,
    expiresAt: expiresAtIso(ACCESS_CODE_TTL_HOURS),
    userAgent: request.headers.get("user-agent") ?? "",
    clientIp: clientIpFromRequest(request)
  });
  await incrementMetric(env.mailflare_db, "private_access_granted");

  const response = withSecurityHeaders(
    new Response(null, {
      status: 302,
      headers: {
        location: "/",
        "set-cookie": buildSessionCookie(sessionToken, request)
      }
    })
  );
  return response;
}

async function handleApiRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const segments = getPathSegments(pathname);

  if (request.method === "GET" && pathname === "/api/dashboard/stats") {
    const stats = await getDashboardStats(env.mailflare_db);
    return jsonResponse(stats);
  }

  if (request.method === "GET" && pathname === "/api/users") {
    const users = await listUsers(env.mailflare_db);
    return jsonResponse(users);
  }

  if (request.method === "POST" && pathname === "/api/users") {
    const body = (await request.json().catch(() => null)) as
      | { email?: string; displayName?: string }
      | null;
    const email = body?.email?.trim().toLowerCase() ?? "";
    if (!email || !email.includes("@")) {
      return jsonResponse({ error: "Invalid email" }, 400);
    }

    try {
      const created = await createUser(env.mailflare_db, {
        email,
        displayName: body?.displayName
      });
      await incrementMetric(env.mailflare_db, "users_created");
      return jsonResponse({ ok: true, user: created }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.toLowerCase().includes("unique")) {
        return jsonResponse({ error: "User already exists" }, 409);
      }
      return jsonResponse({ error: "Failed to create user" }, 500);
    }
  }

  if (
    request.method === "DELETE" &&
    segments.length === 3 &&
    segments[0] === "api" &&
    segments[1] === "users"
  ) {
    const userId = decodeURIComponent(segments[2]);
    const deleted = await deleteUserById(env.mailflare_db, userId);
    if (!deleted.ok) {
      return jsonResponse({ error: "User not found" }, 404);
    }
    await incrementMetric(env.mailflare_db, "users_deleted");
    return jsonResponse({
      ok: true,
      userId,
      email: deleted.email,
      deletedEmails: deleted.deletedEmails
    });
  }

  if (
    request.method === "GET" &&
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "users" &&
    segments[3] === "inbox"
  ) {
    const userId = decodeURIComponent(segments[2]);
    const inbox = await listInboxByUser(env.mailflare_db, userId);
    return jsonResponse(inbox);
  }

  if (request.method === "GET" && pathname === "/api/emails/recent") {
    const emails = await listRecentEmails(env.mailflare_db);
    return jsonResponse(emails);
  }

  if (
    request.method === "GET" &&
    segments.length === 3 &&
    segments[0] === "api" &&
    segments[1] === "emails"
  ) {
    const emailId = decodeURIComponent(segments[2]);
    const email = await getEmailById(env.mailflare_db, emailId);
    if (!email) return jsonResponse({ error: "Email not found" }, 404);
    return jsonResponse(email);
  }

  if (
    request.method === "PATCH" &&
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "emails" &&
    segments[3] === "status"
  ) {
    const emailId = decodeURIComponent(segments[2]);
    const body = (await request.json().catch(() => null)) as
      | { action?: string; actor?: string }
      | null;
    const action = statusActionFromInput(body?.action);
    if (!action) return jsonResponse({ error: "Invalid action" }, 400);
    const actor = (body?.actor ?? "api") as string;
    const updated = await patchEmailStatus(env.mailflare_db, emailId, action, actor);
    if (!updated) return jsonResponse({ error: "Email not found" }, 404);
    await incrementMetric(env.mailflare_db, `email_action_${action}`);
    return jsonResponse({ ok: true, email: updated });
  }

  if (request.method === "GET" && pathname === "/api/settings/runtime") {
    const metrics = await listWorkerMetrics(env.mailflare_db);
    const stored = await getStoredSettings(env.mailflare_db);
    const allowedIds = parseAllowedIds(env.TELEGRAM_ALLOWED_IDS);
    const runtime: RuntimeSettings = {
      privateGatewayEnabled: true,
      telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN?.trim()),
      webhookSecretConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET?.trim()),
      inboundDomain: normalizeInboundDomain(env.MAILFLARE_INBOUND_DOMAIN),
      telegramAllowedIdsCount: allowedIds.size,
      telegramAllowedIds: Array.from(allowedIds),
      metrics,
      stored
    };
    return jsonResponse(runtime);
  }

  if (request.method === "PUT" && pathname === "/api/settings/profile") {
    const body = (await request.json().catch(() => null)) as
      | {
          defaultTelegramChatId?: string;
          telegramForwardEnabled?: boolean;
          telegramForwardMode?: "all_allowed" | "specific";
          telegramForwardChatId?: string;
        }
      | null;

    const defaultTelegramChatId = body?.defaultTelegramChatId?.trim() ?? "";
    const telegramForwardEnabled = Boolean(body?.telegramForwardEnabled);
    const telegramForwardMode =
      body?.telegramForwardMode === "specific" ? "specific" : "all_allowed";
    const telegramForwardChatId = body?.telegramForwardChatId?.trim() ?? "";
    const allowedIds = parseAllowedIds(env.TELEGRAM_ALLOWED_IDS);

    if (telegramForwardMode === "specific") {
      const target = telegramForwardChatId || defaultTelegramChatId;
      if (!target) {
        return jsonResponse(
          { error: "Specific mode requires telegramForwardChatId or defaultTelegramChatId" },
          400
        );
      }
      if (allowedIds.size > 0 && !allowedIds.has(target)) {
        return jsonResponse(
          { error: "Specific forward chat id must be inside TELEGRAM_ALLOWED_IDS" },
          400
        );
      }
    }

    await saveStoredSettings(env.mailflare_db, {
      defaultTelegramChatId,
      telegramForwardEnabled,
      telegramForwardMode,
      telegramForwardChatId
    });
    await incrementMetric(env.mailflare_db, "settings_profile_saved");
    const stored = await getStoredSettings(env.mailflare_db);
    return jsonResponse({ ok: true, stored });
  }

  if (request.method === "POST" && pathname === "/api/settings/telegram/test") {
    const body = (await request.json().catch(() => null)) as
      | { chatId?: string | number; message?: string }
      | null;

    const runtimeStored = await getStoredSettings(env.mailflare_db);
    const allowedIds = parseAllowedIds(env.TELEGRAM_ALLOWED_IDS);
    const chatIdRaw =
      body?.chatId !== undefined && body?.chatId !== null
        ? String(body.chatId)
        : runtimeStored.telegramForwardMode === "specific"
          ? runtimeStored.telegramForwardChatId || runtimeStored.defaultTelegramChatId
          : runtimeStored.defaultTelegramChatId;
    const chatId = chatIdRaw.trim();
    if (!chatId) return jsonResponse({ error: "chatId is required" }, 400);
    if (!env.TELEGRAM_BOT_TOKEN?.trim()) {
      return jsonResponse({ error: "TELEGRAM_BOT_TOKEN is not configured" }, 400);
    }
    if (allowedIds.size > 0 && !allowedIds.has(chatId)) {
      return jsonResponse({ error: "chatId must be inside TELEGRAM_ALLOWED_IDS" }, 400);
    }

    const text = body?.message?.trim() || `MailFlare test ping (${new Date().toISOString()})`;
    try {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, {
        chat_id: chatId,
        text
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Telegram test failed";
      if (message.includes("401")) {
        return jsonResponse(
          {
            error: "Telegram unauthorized. Cek TELEGRAM_BOT_TOKEN (kemungkinan invalid).",
            detail: message
          },
          502
        );
      }
      return jsonResponse({ error: "Telegram test failed", detail: message }, 502);
    }
    await incrementMetric(env.mailflare_db, "telegram_test_sent");
    return jsonResponse({ ok: true });
  }

  if (request.method === "GET" && pathname === "/api/settings/telegram/webhook-status") {
    if (!env.TELEGRAM_BOT_TOKEN?.trim()) {
      return jsonResponse({ error: "TELEGRAM_BOT_TOKEN is not configured" }, 400);
    }
    const status = await getTelegramWebhookInfo(env.TELEGRAM_BOT_TOKEN);
    return jsonResponse({ ok: true, status });
  }

  return jsonResponse({ error: "Not found" }, 404);
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (secret) {
    const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
    const querySecret = new URL(request.url).searchParams.get("secret");
    if (headerSecret !== secret && querySecret !== secret) {
      return jsonResponse({ error: "Invalid webhook secret" }, 401);
    }
  }

  const update = (await request.json().catch(() => null)) as
    | {
        update_id?: number;
        message?: {
          text?: string;
          from?: { id?: number };
          chat?: { id?: number | string };
        };
        callback_query?: {
          id?: string;
          data?: string;
          from?: { id?: number };
          message?: {
            message_id?: number;
            chat?: { id?: number | string };
          };
        };
      }
    | null;

  const callbackQuery = update?.callback_query;
  const callbackData = callbackQuery?.data ?? "";
  const text = update?.message?.text ?? "";
  const telegramUserId = update?.message?.from?.id ?? callbackQuery?.from?.id;
  const chatId = update?.message?.chat?.id ?? callbackQuery?.message?.chat?.id ?? telegramUserId;
  const callbackQueryId = callbackQuery?.id;
  const callbackMessageId = callbackQuery?.message?.message_id;
  const parsed = parseTelegramCommand(text);
  const webhookOrigin = new URL(request.url).origin;

  if (!telegramUserId || !chatId) {
    return jsonResponse({ ok: true, ignored: true });
  }

  const allowed = parseAllowedIds(env.TELEGRAM_ALLOWED_IDS);
  if (!isAllowedTelegramUser(allowed, telegramUserId)) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  const send = async (messageText: string): Promise<void> =>
    sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, {
      chat_id: chatId,
      text: messageText
    });

  try {
    if (callbackData) {
      if (!callbackQueryId) {
        return jsonResponse({ ok: true, ignored: true });
      }
      const parsedCallback = parseTelegramCallbackData(callbackData);
      if (!parsedCallback) {
        await answerTelegramCallbackQuery(env.TELEGRAM_BOT_TOKEN, {
          callback_query_id: callbackQueryId,
          text: "Unsupported action"
        });
        return jsonResponse({ ok: true });
      }

      if (parsedCallback.kind === "action") {
        const resolved = await resolveEmailByArg(env.mailflare_db, parsedCallback.emailId);
        if (!resolved.email) {
          await answerTelegramCallbackQuery(env.TELEGRAM_BOT_TOKEN, {
            callback_query_id: callbackQueryId,
            text: resolved.error ?? "Email not found"
          });
          return jsonResponse({ ok: true });
        }

        const updated = await patchEmailStatus(
          env.mailflare_db,
          resolved.email.id,
          parsedCallback.action,
          "telegram-inline"
        );
        if (!updated) {
          await answerTelegramCallbackQuery(env.TELEGRAM_BOT_TOKEN, {
            callback_query_id: callbackQueryId,
            text: "Email not found"
          });
          return jsonResponse({ ok: true });
        }

        await incrementMetric(env.mailflare_db, `telegram_action_${parsedCallback.action}`);
        if (callbackMessageId !== undefined) {
          try {
            await editTelegramMessageReplyMarkup(env.TELEGRAM_BOT_TOKEN, {
              chat_id: chatId,
              message_id: callbackMessageId,
              reply_markup: buildEmailActionKeyboard(updated)
            });
          } catch {
            // Ignore markup edit failure (old message/deleted message/etc).
          }
        }
        await answerTelegramCallbackQuery(env.TELEGRAM_BOT_TOKEN, {
          callback_query_id: callbackQueryId,
          text: `Action ${parsedCallback.action} applied`
        });
        await incrementMetric(env.mailflare_db, "telegram_webhook_ok");
        return jsonResponse({ ok: true });
      }

      const resolved = await resolveEmailByArg(env.mailflare_db, parsedCallback.emailId);
      if (!resolved.email) {
        await answerTelegramCallbackQuery(env.TELEGRAM_BOT_TOKEN, {
          callback_query_id: callbackQueryId,
          text: resolved.error ?? "Email not found"
        });
        return jsonResponse({ ok: true });
      }

      const previewBaseUrl = resolvePreviewBaseUrl(env, webhookOrigin);
      if (!previewBaseUrl) {
        await answerTelegramCallbackQuery(env.TELEGRAM_BOT_TOKEN, {
          callback_query_id: callbackQueryId,
          text: "Preview URL is not configured"
        });
        return jsonResponse({ ok: true });
      }

      const previewUrl = await buildTelegramPreviewUrl(
        env,
        previewBaseUrl,
        String(telegramUserId),
        resolved.email.id
      );
      if (!previewUrl) {
        await answerTelegramCallbackQuery(env.TELEGRAM_BOT_TOKEN, {
          callback_query_id: callbackQueryId,
          text: "Preview token is not available"
        });
        return jsonResponse({ ok: true });
      }

      await answerTelegramCallbackQuery(env.TELEGRAM_BOT_TOKEN, {
        callback_query_id: callbackQueryId,
        url: previewUrl
      });
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, {
        chat_id: chatId,
        disable_web_page_preview: true,
        text: "Open HTML preview from this button:",
        reply_markup: {
          inline_keyboard: [[{ text: "🌐 Open Preview", url: previewUrl }]]
        }
      });
      await incrementMetric(env.mailflare_db, "telegram_html_preview_link_sent");
      await incrementMetric(env.mailflare_db, "telegram_webhook_ok");
      return jsonResponse({ ok: true });
    }

    if (parsed.command === "start") {
      await send(
        [
          "Welcome to MailFlare Bot.",
          "Use /access to get one-time gateway code (24h, one-use).",
          "",
          "Supported:",
          "/start",
          "/stats",
          "/inbox [username]",
          "/resend <email_id>",
          "/read <email_id>",
          "/unread <email_id>",
          "/star <email_id>",
          "/unstar <email_id>",
          "/archive <email_id>",
          "/delete <email_id>",
          "/access"
        ].join("\n")
      );
    } else if (parsed.command === "stats") {
      const stats = await getDashboardStats(env.mailflare_db);
      await send(
        [
          "MailFlare Stats",
          `Users: ${stats.totalUsers}`,
          `Emails: ${stats.totalEmails}`,
          `Unread: ${stats.unreadEmails}`,
          `Starred: ${stats.starredEmails}`,
          `Archived: ${stats.archivedEmails}`,
          `Deleted: ${stats.deletedEmails}`
        ].join("\n")
      );
    } else if (parsed.command === "inbox") {
      let rows: EmailRecord[] = [];
      if (parsed.args[0] !== undefined) {
        const userId = await findUserIdByLookup(env.mailflare_db, parsed.args[0]);
        if (!userId) {
          await send("User not found.");
          await incrementMetric(env.mailflare_db, "telegram_webhook_ok");
          return jsonResponse({ ok: true });
        }
        rows = await listInboxByUser(env.mailflare_db, userId);
      } else {
        rows = await listRecentEmails(env.mailflare_db);
      }
      const lines = rows.slice(0, 10).map((item) => {
        const subject = item.subject?.trim() || "(No Subject)";
        return `- ${item.id}: ${subject}`;
      });
      await send(lines.length > 0 ? lines.join("\n") : "Inbox kosong.");
    } else if (parsed.command === "resend") {
      if (!parsed.args[0]) {
        await send("Usage: /resend <email_id>");
      } else {
        const resolved = await resolveEmailByArg(env.mailflare_db, parsed.args[0]);
        if (!resolved.email) {
          await send(resolved.error ?? "Email not found.");
        } else {
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, {
            chat_id: chatId,
            parse_mode: "MarkdownV2",
            disable_web_page_preview: true,
            text: inboundAlertMarkdownFromRecord(resolved.email),
            reply_markup: buildEmailActionKeyboard(resolved.email)
          });
          await incrementMetric(env.mailflare_db, "telegram_resend_sent");
        }
      }
    } else if (
      parsed.command === "read" ||
      parsed.command === "unread" ||
      parsed.command === "star" ||
      parsed.command === "unstar" ||
      parsed.command === "archive" ||
      parsed.command === "delete"
    ) {
      if (!parsed.args[0]) {
        await send(`Usage: /${parsed.command} <email_id>`);
      } else {
        const resolved = await resolveEmailByArg(env.mailflare_db, parsed.args[0]);
        if (!resolved.email) {
          await send(resolved.error ?? "Email not found.");
          await incrementMetric(env.mailflare_db, "telegram_action_not_found");
          await incrementMetric(env.mailflare_db, "telegram_webhook_ok");
          return jsonResponse({ ok: true });
        }
        const emailId = resolved.email.id;
        const updated = await patchEmailStatus(
          env.mailflare_db,
          emailId,
          parsed.command,
          "telegram-bot"
        );
        if (!updated) {
          await send("Email not found.");
        } else {
          await incrementMetric(env.mailflare_db, `telegram_action_${parsed.command}`);
          await send(`Action ${parsed.command} applied to ${emailId}.`);
        }
      }
    } else if (parsed.command === "access") {
      const accessCode = generateAccessCode();
      await insertAccessCode(env.mailflare_db, {
        id: crypto.randomUUID(),
        codeHash: await hashText(accessCode),
        telegramUserId: String(telegramUserId),
        expiresAt: expiresAtIso(ACCESS_CODE_TTL_HOURS)
      });
      await incrementMetric(env.mailflare_db, "private_access_code_created");
      const quickOpenUrl = `${webhookOrigin}/auth/${accessCode}`;
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, {
        chat_id: chatId,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        text: [
          "*MailFlare Private Access Code*",
          "",
          "Copy code:",
          `\`${accessCode}\``,
          "",
          "Valid: 24 hours",
          "One-time use: yes",
          "",
          "Open manually (no preview):",
          `\`${quickOpenUrl}\``
        ].join("\n")
      });
    } else if (parsed.command === "reply") {
      await send("Command /reply disabled in v1.");
    } else {
      await send(
        [
          "Unknown command.",
          "Supported:",
          "/start",
          "/stats",
          "/inbox [username]",
          "/resend <email_id>",
          "/read <email_id>",
          "/unread <email_id>",
          "/star <email_id>",
          "/unstar <email_id>",
          "/archive <email_id>",
          "/delete <email_id>",
          "/access"
        ].join("\n")
      );
    }

    await incrementMetric(env.mailflare_db, "telegram_webhook_ok");
    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Webhook processing failed" },
      500
    );
  }
}

async function serveFrontendAsset(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const direct = await env.ASSETS.fetch(request);
  if (direct.status !== 404) {
    return withSecurityHeaders(direct);
  }

  const url = new URL(request.url);
  if (url.pathname.includes(".")) {
    return withSecurityHeaders(direct);
  }

  const fallbackUrl = new URL(request.url);
  fallbackUrl.pathname = "/index.html";
  const fallback = await env.ASSETS.fetch(new Request(fallbackUrl.toString(), request));
  return withSecurityHeaders(fallback);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/telegram/webhook") {
      return handleTelegramWebhook(request, env);
    }

    if (pathname === "/tg/preview") {
      return handleTelegramPreviewRoute(request, env);
    }

    if (pathname === "/auth/access-denied") {
      return htmlResponse(renderAccessDeniedPage(), 200);
    }

    if (pathname === "/auth/redeem") {
      return handleAccessRedeem(request, env);
    }

    const pathAccessCode = accessCodeFromPath(pathname);
    if (pathAccessCode) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      return withSecurityHeaders(
        new Response(null, {
          status: 302,
          headers: {
            location: `/auth/access-denied#${encodeURIComponent(pathAccessCode)}`
          }
        })
      );
    }

    if (pathname === "/auth/logout") {
      return withSecurityHeaders(
        new Response(null, {
          status: 302,
          headers: {
            location: "/auth/access-denied",
            "set-cookie": clearSessionCookie(request)
          }
        })
      );
    }

    if (!isPublicPath(pathname)) {
      const authorized = await isRequestAuthorized(request, env);
      if (!authorized) {
        const isApiCall = pathname.startsWith("/api/") || pathname === "/healthz";
        if (isApiCall || (request.method !== "GET" && request.method !== "HEAD")) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        return htmlResponse(renderAccessDeniedPage(), 401);
      }
    }

    if (pathname === "/healthz" && request.method === "GET") {
      return jsonResponse({
        status: "ok",
        timestamp: new Date().toISOString()
      });
    }

    if (pathname.startsWith("/api/")) {
      return handleApiRoutes(request, env);
    }

    return serveFrontendAsset(request, env);
  },

  async email(message, env, ctx): Promise<void> {
    const parsed = await parseInboundEmail(message);
    const recipient = parsed.recipient.toLowerCase();
    const userId = await findUserIdByEmail(env.mailflare_db, recipient);
    if (!userId) {
      await incrementMetric(env.mailflare_db, "inbound_email_rejected_unknown_user");
      const rejectable = message as { setReject?: (reason: string) => void };
      if (typeof rejectable.setReject === "function") {
        rejectable.setReject("Recipient is not registered in MailFlare");
      }
      return;
    }

    await insertInboundEmail(env.mailflare_db, {
      ...parsed,
      userId
    });
    await incrementMetric(env.mailflare_db, "inbound_email_count");
    const storedEmail = await getEmailById(env.mailflare_db, parsed.id);

    const allowedIds = parseAllowedIds(env.TELEGRAM_ALLOWED_IDS);
    const stored = await getStoredSettings(env.mailflare_db);
    const targetChatIds = resolveTelegramForwardTargets(allowedIds, stored);
    if (targetChatIds.length < 1) {
      await incrementMetric(env.mailflare_db, "telegram_forward_skipped_no_target");
      return;
    }
    const alertText = inboundAlertMarkdown(parsed);

    await Promise.allSettled(
      targetChatIds.map((chatId) =>
        sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, {
          chat_id: chatId,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
          text: alertText,
          reply_markup: storedEmail ? buildEmailActionKeyboard(storedEmail) : undefined
        })
      )
    );
  },

  async scheduled(controller, env, ctx): Promise<void> {
    await incrementMetric(env.mailflare_db, "scheduled_runs");
  }
} satisfies ExportedHandler<Env>;
