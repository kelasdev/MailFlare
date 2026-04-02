export type EmailStatusAction =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "delete";

export interface Env {
  mailflare_db: D1Database;
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_IDS?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

export interface EmailRecord {
  id: string;
  userId: string;
  sender: string;
  recipient: string;
  subject: string | null;
  snippet: string | null;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  deletedAt: string | null;
  receivedAt: string;
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string | null;
  unreadCount: number;
  totalCount: number;
  createdAt?: string | null;
}

export interface DashboardStats {
  totalUsers: number;
  totalEmails: number;
  unreadEmails: number;
  starredEmails: number;
  archivedEmails: number;
  deletedEmails: number;
}

export interface RuntimeSettings {
  accessConfigured: boolean;
  telegramConfigured: boolean;
  webhookSecretConfigured: boolean;
  telegramAllowedIdsCount: number;
  metrics: Record<string, number>;
  stored: StoredSettings;
}

export interface StoredSettings {
  defaultTelegramChatId: string;
  webhookForwardEnabled: boolean;
  webhookForwardUrl: string;
  updatedAt: string | null;
}

export interface EmailStatusPatch {
  action: EmailStatusAction;
  actor: string;
}

export interface TelegramCommand {
  command:
    | "stats"
    | "inbox"
    | "mail"
    | "read"
    | "unread"
    | "star"
    | "unstar"
    | "archive"
    | "delete"
    | "access"
    | "reply"
    | "unknown";
  args: string[];
  raw: string;
}

export interface InboundEmail {
  id: string;
  messageId: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  snippet: string | null;
  rawSize: number | null;
  receivedAt: string;
}

export interface EmailState {
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  deletedAt: string | null;
}
