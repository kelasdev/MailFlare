import {
  consumeAccessCode,
  createUser,
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
  logTelegramEvent,
  patchEmailStatus,
  saveStoredSettings
} from "./db";
import { verifyAccessJwt } from "./utils/access";
import { parseInboundEmail } from "./utils/email";
import {
  isAllowedTelegramUser,
  parseAllowedIds,
  parseTelegramCommand,
  sendTelegramMessage
} from "./utils/telegram";
import type { EmailStatusAction, Env, RuntimeSettings } from "./types";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

const ACCESS_SESSION_COOKIE_NAME = "mailflare_private_session";
const ACCESS_CODE_TTL_HOURS = 24;
const ACCESS_SESSION_TTL_SECONDS = 60 * 60 * 24;

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

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/api/telegram/webhook" ||
    pathname === "/auth/access-denied" ||
    pathname === "/auth/redeem"
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
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
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Inter, sans-serif;
        background: radial-gradient(circle at 20% 20%, #11294a 0%, #09172c 42%, #050d19 100%);
        color: #e8f1ff;
      }
      .card {
        width: min(92vw, 460px);
        border-radius: 16px;
        background: rgba(15, 32, 56, 0.86);
        border: 1px solid rgba(255, 255, 255, 0.12);
        padding: 28px 24px;
        box-shadow: 0 22px 60px rgba(0, 0, 0, 0.34);
      }
      .title {
        margin: 0 0 8px;
        font-size: 1.3rem;
        font-weight: 700;
      }
      .hint {
        margin: 0 0 18px;
        color: #b8cae8;
        font-size: 0.95rem;
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
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(3, 14, 28, 0.84);
        color: #f3f7ff;
        padding: 11px 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      button {
        margin-top: 14px;
        width: 100%;
        border: none;
        border-radius: 10px;
        background: linear-gradient(90deg, #ff8e3a, #ff6a2d);
        color: #131313;
        font-weight: 700;
        padding: 12px;
        cursor: pointer;
      }
      .foot {
        margin-top: 14px;
        font-size: 0.78rem;
        color: #9eb4da;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1 class="title">MailFlare Private Zone</h1>
      ${message}
      <form action="/auth/redeem" method="post">
        <label for="code">One-time Access Code</label>
        <input id="code" name="code" type="text" placeholder="MF-XXXX-XXXX-XXXX" required />
        <button type="submit">Unlock</button>
      </form>
      <p class="foot">Code hanya bisa dipakai 1x dan kadaluarsa 24 jam.</p>
    </main>
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

async function isSessionAuthorized(request: Request, env: Env): Promise<boolean> {
  const cookies = parseCookies(request);
  const token = cookies.get(ACCESS_SESSION_COOKIE_NAME);
  if (!token) return false;
  const tokenHash = await hashText(token);
  return isAccessSessionValid(env.mailflare_db, tokenHash);
}

async function isRequestAuthorized(request: Request, env: Env): Promise<boolean> {
  const url = new URL(request.url);
  const accessConfigured = Boolean(
    env.CF_ACCESS_TEAM_DOMAIN?.trim() && env.CF_ACCESS_AUD?.trim()
  );
  if (!accessConfigured && isLocalHost(url.hostname)) {
    return true;
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (token) {
    const result = await verifyAccessJwt(token, env);
    if (result.ok) return true;
  }

  return isSessionAuthorized(request, env);
}

async function handleAccessRedeem(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return htmlResponse(renderAccessDeniedPage(), 200);
  }

  const form = await request.formData().catch(() => null);
  const rawCode = String(form?.get("code") ?? "").trim().toUpperCase();
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
    const runtime: RuntimeSettings = {
      accessConfigured: Boolean(
        env.CF_ACCESS_TEAM_DOMAIN?.trim() && env.CF_ACCESS_AUD?.trim()
      ),
      telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN?.trim()),
      webhookSecretConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET?.trim()),
      telegramAllowedIdsCount: parseAllowedIds(env.TELEGRAM_ALLOWED_IDS).size,
      metrics,
      stored
    };
    return jsonResponse(runtime);
  }

  if (request.method === "PUT" && pathname === "/api/settings/profile") {
    const body = (await request.json().catch(() => null)) as
      | {
          defaultTelegramChatId?: string;
          webhookForwardEnabled?: boolean;
          webhookForwardUrl?: string;
        }
      | null;

    const defaultTelegramChatId = body?.defaultTelegramChatId?.trim() ?? "";
    const webhookForwardEnabled = Boolean(body?.webhookForwardEnabled);
    const webhookForwardUrl = body?.webhookForwardUrl?.trim() ?? "";

    if (webhookForwardUrl) {
      try {
        const parsed = new URL(webhookForwardUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return jsonResponse({ error: "Webhook URL must use http or https" }, 400);
        }
      } catch {
        return jsonResponse({ error: "Invalid webhook URL" }, 400);
      }
    }

    await saveStoredSettings(env.mailflare_db, {
      defaultTelegramChatId,
      webhookForwardEnabled,
      webhookForwardUrl
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
    const chatIdRaw =
      body?.chatId !== undefined && body?.chatId !== null
        ? String(body.chatId)
        : runtimeStored.defaultTelegramChatId;
    const chatId = chatIdRaw.trim();
    if (!chatId) return jsonResponse({ error: "chatId is required" }, 400);
    if (!env.TELEGRAM_BOT_TOKEN?.trim()) {
      return jsonResponse({ error: "TELEGRAM_BOT_TOKEN is not configured" }, 400);
    }

    const text = body?.message?.trim() || `MailFlare test ping (${new Date().toISOString()})`;
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, {
      chat_id: chatId,
      text
    });
    await logTelegramEvent(env.mailflare_db, {
      updateId: null,
      telegramUserId: String(chatId),
      command: "test",
      payloadJson: JSON.stringify({ chatId, message: text }),
      status: "ok"
    });
    await incrementMetric(env.mailflare_db, "telegram_test_sent");
    return jsonResponse({ ok: true });
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
      }
    | null;

  const text = update?.message?.text ?? "";
  const telegramUserId = update?.message?.from?.id;
  const chatId = update?.message?.chat?.id ?? telegramUserId;
  const parsed = parseTelegramCommand(text);
  const payloadJson = JSON.stringify(update ?? {});
  const webhookOrigin = new URL(request.url).origin;

  if (!telegramUserId || !chatId) {
    await logTelegramEvent(env.mailflare_db, {
      updateId: String(update?.update_id ?? ""),
      telegramUserId: null,
      command: parsed.command,
      payloadJson,
      status: "ignored"
    });
    return jsonResponse({ ok: true, ignored: true });
  }

  const allowed = parseAllowedIds(env.TELEGRAM_ALLOWED_IDS);
  if (!isAllowedTelegramUser(allowed, telegramUserId)) {
    await logTelegramEvent(env.mailflare_db, {
      updateId: String(update?.update_id ?? ""),
      telegramUserId: String(telegramUserId),
      command: parsed.command,
      payloadJson,
      status: "forbidden"
    });
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  const send = async (messageText: string): Promise<void> =>
    sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, {
      chat_id: chatId,
      text: messageText
    });

  try {
    if (parsed.command === "stats") {
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
      const rows =
        parsed.args[0] !== undefined
          ? await listInboxByUser(env.mailflare_db, parsed.args[0])
          : await listRecentEmails(env.mailflare_db);
      const lines = rows.slice(0, 10).map((item) => {
        const subject = item.subject?.trim() || "(No Subject)";
        return `- ${item.id}: ${subject}`;
      });
      await send(lines.length > 0 ? lines.join("\n") : "Inbox kosong.");
    } else if (parsed.command === "mail") {
      const emailId = parsed.args[0];
      if (!emailId) {
        await send("Usage: /mail <email_id>");
      } else {
        const email = await getEmailById(env.mailflare_db, emailId);
        if (!email) {
          await send("Email not found.");
        } else {
          await send(
            [
              `ID: ${email.id}`,
              `Subject: ${email.subject ?? "(No Subject)"}`,
              `From: ${email.sender}`,
              `To: ${email.recipient}`,
              `Snippet: ${email.snippet ?? "-"}`,
              `Read: ${email.isRead}`,
              `Starred: ${email.isStarred}`,
              `Archived: ${email.isArchived}`,
              `Deleted: ${email.deletedAt ?? "no"}`
            ].join("\n")
          );
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
      const emailId = parsed.args[0];
      if (!emailId) {
        await send(`Usage: /${parsed.command} <email_id>`);
      } else {
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
      await send(
        [
          "MailFlare Private Access Code",
          `Code: ${accessCode}`,
          "Valid: 24 hours",
          "One-time use: yes",
          `Open: ${webhookOrigin}/auth/access-denied`
        ].join("\n")
      );
    } else if (parsed.command === "reply") {
      await send("Command /reply disabled in v1.");
    } else {
      await send(
        [
          "Unknown command.",
          "Supported:",
          "/stats",
          "/inbox [user_id]",
          "/mail <email_id>",
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

    await logTelegramEvent(env.mailflare_db, {
      updateId: String(update?.update_id ?? ""),
      telegramUserId: String(telegramUserId),
      command: parsed.command,
      payloadJson,
      status: "ok"
    });
    await incrementMetric(env.mailflare_db, "telegram_webhook_ok");
    return jsonResponse({ ok: true });
  } catch (error) {
    await logTelegramEvent(env.mailflare_db, {
      updateId: String(update?.update_id ?? ""),
      telegramUserId: String(telegramUserId),
      command: parsed.command,
      payloadJson,
      status: "failed"
    });
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

    if (pathname === "/auth/access-denied") {
      return htmlResponse(renderAccessDeniedPage(), 200);
    }

    if (pathname === "/auth/redeem") {
      return handleAccessRedeem(request, env);
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

    const allowedIds = Array.from(parseAllowedIds(env.TELEGRAM_ALLOWED_IDS));
    const subject = parsed.subject?.trim() || "(No Subject)";
    const alertText = [
      "New inbound email",
      `To: ${parsed.recipient}`,
      `From: ${parsed.sender}`,
      `Subject: ${subject}`,
      `Email ID: ${parsed.id}`
    ].join("\n");

    await Promise.allSettled(
      allowedIds.map((chatId) =>
        sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, {
          chat_id: chatId,
          text: alertText
        })
      )
    );
  },

  async scheduled(controller, env, ctx): Promise<void> {
    await incrementMetric(env.mailflare_db, "scheduled_runs");
  }
} satisfies ExportedHandler<Env>;
