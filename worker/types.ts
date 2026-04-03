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
  MAILFLARE_INBOUND_DOMAIN?: string;
  MAILFLARE_PUBLIC_BASE_URL?: string;
}

export interface EmailRecord {
  id: string;
  userId: string;
  messageId?: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  snippet: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  rawMime?: string | null;
  headersJson?: string | null;
  rawSize?: number | null;
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
  privateGatewayEnabled: boolean;
  telegramConfigured: boolean;
  webhookSecretConfigured: boolean;
  inboundDomain: string;
  telegramAllowedIdsCount: number;
  telegramAllowedIds: string[];
  metrics: Record<string, number>;
  stored: StoredSettings;
}

export type TelegramForwardMode = "all_allowed" | "specific";

export interface StoredSettings {
  defaultTelegramChatId: string;
  telegramForwardEnabled: boolean;
  telegramForwardMode: TelegramForwardMode;
  telegramForwardChatId: string;
  updatedAt: string | null;
}

export interface EmailStatusPatch {
  action: EmailStatusAction;
  actor: string;
}

export interface TelegramCommand {
  command:
    | "start"
    | "stats"
    | "inbox"
    | "adduser"
    | "listuser"
    | "apikey"
    | "resend"
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
  bodyText: string | null;
  bodyHtml: string | null;
  rawMime: string | null;
  headersJson: string | null;
  rawSize: number | null;
  receivedAt: string;
}

export interface EmailState {
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  deletedAt: string | null;
}
