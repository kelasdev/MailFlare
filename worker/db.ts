import { applyStatusAction, serializeState } from "./utils/status";
import type {
  DashboardStats,
  EmailRecord,
  EmailState,
  EmailStatusAction,
  InboundEmail,
  StoredSettings,
  UserRecord
} from "./types";

type NullableNumber = number | null;

interface EmailRow {
  id: string;
  user_id: string;
  message_id?: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  snippet: string | null;
  body_text?: string | null;
  body_html?: string | null;
  raw_mime?: string | null;
  headers_json?: string | null;
  raw_size?: NullableNumber;
  is_read: number;
  is_starred: number;
  is_archived: number;
  deleted_at: string | null;
  received_at: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  unread_count: NullableNumber;
  total_count: NullableNumber;
  created_at: string | null;
}

interface StatsRow {
  total_users: NullableNumber;
  total_emails: NullableNumber;
  unread_emails: NullableNumber;
  starred_emails: NullableNumber;
  archived_emails: NullableNumber;
  deleted_emails: NullableNumber;
}

interface WorkerSettingRow {
  key: string;
  value: string | null;
  updated_at: string | null;
}

interface AccessCodeRow {
  id: string;
}

interface CountRow {
  total: NullableNumber;
}

interface ApiKeyRow {
  id: string;
  name: string | null;
  created_by: string | null;
  created_at: string;
}

function asBool(value: number): boolean {
  return value === 1;
}

function mapEmail(row: EmailRow): EmailRecord {
  return {
    id: row.id,
    userId: row.user_id,
    messageId: row.message_id ?? null,
    sender: row.sender,
    recipient: row.recipient,
    subject: row.subject,
    snippet: row.snippet,
    bodyText: row.body_text ?? null,
    bodyHtml: row.body_html ?? null,
    rawMime: row.raw_mime ?? null,
    headersJson: row.headers_json ?? null,
    rawSize: row.raw_size ?? null,
    isRead: asBool(row.is_read),
    isStarred: asBool(row.is_starred),
    isArchived: asBool(row.is_archived),
    deletedAt: row.deleted_at,
    receivedAt: row.received_at
  };
}

function toCount(value: NullableNumber): number {
  return value ?? 0;
}

export async function ensureUserByEmail(db: D1Database, email: string): Promise<string> {
  const existing = await db
    .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
    .bind(email)
    .first<{ id: string }>();

  if (existing?.id) return existing.id;

  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
    )
    .bind(id, email, email)
    .run();
  return id;
}

export async function findUserIdByEmail(db: D1Database, email: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
    .bind(email)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function findUserIdByLookup(db: D1Database, lookup: string): Promise<string | null> {
  const value = lookup.trim().toLowerCase();
  if (!value) return null;

  const row = await db
    .prepare(
      `SELECT id
      FROM users
      WHERE lower(id) = ?
        OR lower(email) = ?
        OR lower(display_name) = ?
        OR (
          CASE
            WHEN instr(email, '@') > 0 THEN lower(substr(email, 1, instr(email, '@') - 1))
            ELSE lower(email)
          END
        ) = ?
      LIMIT 1`
    )
    .bind(value, value, value, value)
    .first<{ id: string }>();

  return row?.id ?? null;
}

export async function insertInboundEmail(
  db: D1Database,
  payload: InboundEmail & { userId: string }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO emails (id, user_id, message_id, sender, recipient, subject, snippet, received_at, raw_size, body_text, body_html, raw_mime, headers_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      payload.id,
      payload.userId,
      payload.messageId,
      payload.sender,
      payload.recipient,
      payload.subject,
      payload.snippet,
      payload.receivedAt,
      payload.rawSize,
      payload.bodyText,
      payload.bodyHtml,
      payload.rawMime,
      payload.headersJson
    )
    .run();
}

export async function getDashboardStats(db: D1Database): Promise<DashboardStats> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM emails) AS total_emails,
        (SELECT COUNT(*) FROM emails WHERE is_read = 0 AND deleted_at IS NULL) AS unread_emails,
        (SELECT COUNT(*) FROM emails WHERE is_starred = 1 AND deleted_at IS NULL) AS starred_emails,
        (SELECT COUNT(*) FROM emails WHERE is_archived = 1 AND deleted_at IS NULL) AS archived_emails,
        (SELECT COUNT(*) FROM emails WHERE deleted_at IS NOT NULL) AS deleted_emails`
    )
    .first<StatsRow>();

  return {
    totalUsers: toCount(row?.total_users ?? 0),
    totalEmails: toCount(row?.total_emails ?? 0),
    unreadEmails: toCount(row?.unread_emails ?? 0),
    starredEmails: toCount(row?.starred_emails ?? 0),
    archivedEmails: toCount(row?.archived_emails ?? 0),
    deletedEmails: toCount(row?.deleted_emails ?? 0)
  };
}

export async function listUsers(db: D1Database): Promise<UserRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        u.id,
        u.email,
        u.display_name,
        u.created_at,
        SUM(CASE WHEN e.deleted_at IS NULL AND e.is_read = 0 THEN 1 ELSE 0 END) AS unread_count,
        SUM(CASE WHEN e.deleted_at IS NULL THEN 1 ELSE 0 END) AS total_count
      FROM users u
      LEFT JOIN emails e ON e.user_id = u.id
      GROUP BY u.id
      ORDER BY total_count DESC, u.email ASC`
    )
    .all<UserRow>();

  const rows = result.results ?? [];
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    unreadCount: toCount(row.unread_count),
    totalCount: toCount(row.total_count),
    createdAt: row.created_at
  }));
}

export async function createUser(
  db: D1Database,
  input: { email: string; displayName?: string | null }
): Promise<UserRecord> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName?.trim() || null;
  const id = crypto.randomUUID();

  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
    )
    .bind(id, email, displayName ?? email)
    .run();

  return {
    id,
    email,
    displayName: displayName ?? email,
    unreadCount: 0,
    totalCount: 0,
    createdAt: new Date().toISOString()
  };
}

export async function deleteUserById(
  db: D1Database,
  userId: string
): Promise<{ ok: boolean; email?: string; deletedEmails: number }> {
  const existing = await db
    .prepare("SELECT id, email FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ id: string; email: string }>();

  if (!existing?.id) {
    return { ok: false, deletedEmails: 0 };
  }

  const emailCountRow = await db
    .prepare("SELECT COUNT(*) AS total FROM emails WHERE user_id = ?")
    .bind(userId)
    .first<CountRow>();
  const deletedEmails = toCount(emailCountRow?.total ?? 0);

  await db
    .prepare("DELETE FROM email_status_history WHERE email_id IN (SELECT id FROM emails WHERE user_id = ?)")
    .bind(userId)
    .run();

  await db.prepare("DELETE FROM emails WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();

  return {
    ok: true,
    email: existing.email,
    deletedEmails
  };
}

export async function listInboxByUser(db: D1Database, userId: string): Promise<EmailRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, sender, recipient, subject, snippet, is_read, is_starred, is_archived, deleted_at, received_at
      FROM emails
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY received_at DESC
      LIMIT 100`
    )
    .bind(userId)
    .all<EmailRow>();

  return (result.results ?? []).map(mapEmail);
}

export async function listRecentEmails(db: D1Database): Promise<EmailRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, sender, recipient, subject, snippet, is_read, is_starred, is_archived, deleted_at, received_at
      FROM emails
      WHERE deleted_at IS NULL
      ORDER BY received_at DESC
      LIMIT 50`
    )
    .all<EmailRow>();

  return (result.results ?? []).map(mapEmail);
}

export async function getEmailById(db: D1Database, emailId: string): Promise<EmailRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, user_id, sender, recipient, subject, snippet, is_read, is_starred, is_archived, deleted_at, received_at
      , message_id, raw_size, body_text, body_html, raw_mime, headers_json
      FROM emails
      WHERE id = ?
      LIMIT 1`
    )
    .bind(emailId)
    .first<EmailRow>();

  return row ? mapEmail(row) : null;
}

export async function findEmailIdsByPrefix(
  db: D1Database,
  idPrefix: string,
  limit = 2
): Promise<string[]> {
  const prefix = idPrefix.trim();
  if (!prefix) return [];

  const result = await db
    .prepare(
      `SELECT id
      FROM emails
      WHERE id LIKE ?
      ORDER BY received_at DESC
      LIMIT ?`
    )
    .bind(`${prefix}%`, Math.max(1, limit))
    .all<{ id: string }>();

  return (result.results ?? []).map((row) => row.id);
}

export async function patchEmailStatus(
  db: D1Database,
  emailId: string,
  action: EmailStatusAction,
  actor: string
): Promise<EmailRecord | null> {
  const row = await db
    .prepare(
      "SELECT is_read, is_starred, is_archived, deleted_at FROM emails WHERE id = ? LIMIT 1"
    )
    .bind(emailId)
    .first<{
      is_read: number;
      is_starred: number;
      is_archived: number;
      deleted_at: string | null;
    }>();

  if (!row) {
    return null;
  }

  const fromState: EmailState = {
    isRead: asBool(row.is_read),
    isStarred: asBool(row.is_starred),
    isArchived: asBool(row.is_archived),
    deletedAt: row.deleted_at
  };
  const toState = applyStatusAction(fromState, action);

  await db
    .prepare(
      "UPDATE emails SET is_read = ?, is_starred = ?, is_archived = ?, deleted_at = ? WHERE id = ?"
    )
    .bind(
      toState.isRead ? 1 : 0,
      toState.isStarred ? 1 : 0,
      toState.isArchived ? 1 : 0,
      toState.deletedAt,
      emailId
    )
    .run();

  await db
    .prepare(
      "INSERT INTO email_status_history (id, email_id, action, actor, from_state, to_state, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
    )
    .bind(
      crypto.randomUUID(),
      emailId,
      action,
      actor,
      serializeState(fromState),
      serializeState(toState)
    )
    .run();

  return getEmailById(db, emailId);
}

export async function incrementMetric(
  db: D1Database,
  key: string,
  amount = 1
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO worker_metrics (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value, updated_at = CURRENT_TIMESTAMP"
    )
    .bind(key, amount)
    .run();
}

export async function listWorkerMetrics(db: D1Database): Promise<Record<string, number>> {
  const result = await db
    .prepare("SELECT key, value FROM worker_metrics ORDER BY key ASC")
    .all<{ key: string; value: number }>();

  const output: Record<string, number> = {};
  for (const row of result.results ?? []) {
    output[row.key] = row.value ?? 0;
  }
  return output;
}

export async function getStoredSettings(db: D1Database): Promise<StoredSettings> {
  const result = await db
    .prepare(
      "SELECT key, value, updated_at FROM worker_settings WHERE key IN (?, ?, ?, ?, ?, ?) ORDER BY updated_at DESC"
    )
    .bind(
      "default_telegram_chat_id",
      "telegram_forward_enabled",
      "telegram_forward_mode",
      "telegram_forward_chat_id",
      "webhook_forward_enabled",
      "webhook_forward_url"
    )
    .all<WorkerSettingRow>();

  const map = new Map<string, string>();
  let updatedAt: string | null = null;
  for (const row of result.results ?? []) {
    if (row.value !== null) {
      map.set(row.key, row.value);
    }
    if (!updatedAt && row.updated_at) {
      updatedAt = row.updated_at;
    }
  }

  return {
    defaultTelegramChatId: map.get("default_telegram_chat_id") ?? "",
    telegramForwardEnabled:
      (map.get("telegram_forward_enabled") ?? map.get("webhook_forward_enabled") ?? "1") ===
      "1",
    telegramForwardMode:
      map.get("telegram_forward_mode") === "specific" ? "specific" : "all_allowed",
    telegramForwardChatId: map.get("telegram_forward_chat_id") ?? "",
    updatedAt
  };
}

export async function saveStoredSettings(
  db: D1Database,
  input: {
    defaultTelegramChatId: string;
    telegramForwardEnabled: boolean;
    telegramForwardMode: "all_allowed" | "specific";
    telegramForwardChatId: string;
  }
): Promise<void> {
  const entries: Array<{ key: string; value: string }> = [
    {
      key: "default_telegram_chat_id",
      value: input.defaultTelegramChatId.trim()
    },
    {
      key: "telegram_forward_enabled",
      value: input.telegramForwardEnabled ? "1" : "0"
    },
    {
      key: "telegram_forward_mode",
      value: input.telegramForwardMode
    },
    {
      key: "telegram_forward_chat_id",
      value: input.telegramForwardChatId.trim()
    }
  ];

  for (const item of entries) {
    await db
      .prepare(
        "INSERT INTO worker_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
      )
      .bind(item.key, item.value)
      .run();
  }
}

async function ensureApiKeysTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        name TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TEXT
      )`
    )
    .run();
}

export async function insertApiKey(
  db: D1Database,
  input: {
    id: string;
    keyHash: string;
    name?: string | null;
    createdBy?: string | null;
  }
): Promise<void> {
  await ensureApiKeysTable(db);
  await db
    .prepare(
      "INSERT INTO api_keys (id, key_hash, name, created_by, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)"
    )
    .bind(input.id, input.keyHash, input.name ?? null, input.createdBy ?? null)
    .run();
}

export async function findActiveApiKeyByHash(
  db: D1Database,
  keyHash: string
): Promise<{ id: string; name: string | null; createdBy: string | null; createdAt: string } | null> {
  await ensureApiKeysTable(db);
  const row = await db
    .prepare(
      "SELECT id, name, created_by, created_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1"
    )
    .bind(keyHash)
    .first<ApiKeyRow>();

  if (!row?.id) return null;
  return {
    id: row.id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

export async function insertAccessCode(
  db: D1Database,
  input: {
    id: string;
    codeHash: string;
    telegramUserId: string;
    expiresAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO access_codes (id, code_hash, telegram_user_id, created_at, expires_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)"
    )
    .bind(input.id, input.codeHash, input.telegramUserId, input.expiresAt)
    .run();
}

export async function consumeAccessCode(db: D1Database, codeHash: string): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT id FROM access_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP LIMIT 1"
    )
    .bind(codeHash)
    .first<AccessCodeRow>();
  if (!row?.id) return null;

  const updated = await db
    .prepare("UPDATE access_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL")
    .bind(row.id)
    .run();
  const changes = updated.meta.changes ?? 0;
  if (changes < 1) return null;

  return row.id;
}

export async function insertAccessSession(
  db: D1Database,
  input: {
    id: string;
    tokenHash: string;
    codeId: string;
    expiresAt: string;
    userAgent: string;
    clientIp: string;
  }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO access_sessions (id, token_hash, code_id, created_at, expires_at, user_agent, client_ip) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)"
    )
    .bind(
      input.id,
      input.tokenHash,
      input.codeId,
      input.expiresAt,
      input.userAgent,
      input.clientIp
    )
    .run();
}

export async function isAccessSessionValid(db: D1Database, tokenHash: string): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT id FROM access_sessions WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP LIMIT 1"
    )
    .bind(tokenHash)
    .first<{ id: string }>();
  return Boolean(row?.id);
}
