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
  sender: string;
  recipient: string;
  subject: string | null;
  snippet: string | null;
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

function asBool(value: number): boolean {
  return value === 1;
}

function mapEmail(row: EmailRow): EmailRecord {
  return {
    id: row.id,
    userId: row.user_id,
    sender: row.sender,
    recipient: row.recipient,
    subject: row.subject,
    snippet: row.snippet,
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

export async function insertInboundEmail(
  db: D1Database,
  payload: InboundEmail & { userId: string }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO emails (id, user_id, message_id, sender, recipient, subject, snippet, received_at, raw_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
      payload.rawSize
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
      FROM emails
      WHERE id = ?
      LIMIT 1`
    )
    .bind(emailId)
    .first<EmailRow>();

  return row ? mapEmail(row) : null;
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

export async function logTelegramEvent(
  db: D1Database,
  data: {
    updateId: string | null;
    telegramUserId: string | null;
    command: string | null;
    payloadJson: string;
    status: string;
  }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO telegram_events (id, update_id, telegram_user_id, command, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
    )
    .bind(
      crypto.randomUUID(),
      data.updateId,
      data.telegramUserId,
      data.command,
      data.payloadJson,
      data.status
    )
    .run();
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
      "SELECT key, value, updated_at FROM worker_settings WHERE key IN (?, ?, ?) ORDER BY updated_at DESC"
    )
    .bind(
      "default_telegram_chat_id",
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
    webhookForwardEnabled: (map.get("webhook_forward_enabled") ?? "0") === "1",
    webhookForwardUrl: map.get("webhook_forward_url") ?? "",
    updatedAt
  };
}

export async function saveStoredSettings(
  db: D1Database,
  input: {
    defaultTelegramChatId: string;
    webhookForwardEnabled: boolean;
    webhookForwardUrl: string;
  }
): Promise<void> {
  const entries: Array<{ key: string; value: string }> = [
    {
      key: "default_telegram_chat_id",
      value: input.defaultTelegramChatId.trim()
    },
    {
      key: "webhook_forward_enabled",
      value: input.webhookForwardEnabled ? "1" : "0"
    },
    {
      key: "webhook_forward_url",
      value: input.webhookForwardUrl.trim()
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
