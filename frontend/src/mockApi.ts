export interface DashboardStats {
  totalUsers: number;
  totalEmails: number;
  unreadEmails: number;
  starredEmails: number;
  archivedEmails: number;
  deletedEmails: number;
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string | null;
  unreadCount: number;
  totalCount: number;
  createdAt?: string | null;
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

interface HealthResponse {
  status: string;
  timestamp: string;
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

export interface StoredSettings {
  defaultTelegramChatId: string;
  telegramForwardEnabled: boolean;
  telegramForwardMode: "all_allowed" | "specific";
  telegramForwardChatId: string;
  updatedAt: string | null;
}

interface MockUserSeed {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

const usersSeed: MockUserSeed[] = [
  {
    id: "u-alex",
    email: "alex@company.com",
    displayName: "Alex",
    createdAt: "2026-03-28T11:00:00.000Z"
  },
  {
    id: "u-nadia",
    email: "nadia@company.com",
    displayName: "Nadia",
    createdAt: "2026-03-30T09:15:00.000Z"
  },
  {
    id: "u-rizky",
    email: "rizky@company.com",
    displayName: "Rizky",
    createdAt: "2026-04-01T08:40:00.000Z"
  }
];

const emailsStore: EmailRecord[] = [
  {
    id: "em-1001",
    userId: "u-alex",
    sender: "billing@stripe.com",
    recipient: "alex@company.com",
    subject: "Invoice April 2026 is ready",
    snippet: "Your monthly invoice is ready to view and download.",
    bodyText: "Your monthly invoice is ready to view and download.",
    isRead: false,
    isStarred: true,
    isArchived: false,
    deletedAt: null,
    receivedAt: "2026-04-02T07:10:00.000Z"
  },
  {
    id: "em-1002",
    userId: "u-alex",
    sender: "alerts@cloudflare.com",
    recipient: "alex@company.com",
    subject: "Worker error rate increased",
    snippet: "A spike in 5xx responses was detected on route /api/telegram/webhook.",
    bodyText: "A spike in 5xx responses was detected on route /api/telegram/webhook.",
    isRead: false,
    isStarred: false,
    isArchived: false,
    deletedAt: null,
    receivedAt: "2026-04-02T06:45:00.000Z"
  },
  {
    id: "em-1003",
    userId: "u-nadia",
    sender: "support@customer.io",
    recipient: "nadia@company.com",
    subject: "Re: Login issue after migration",
    snippet: "We still cannot sign in from the mobile app after your DNS change.",
    bodyText: "We still cannot sign in from the mobile app after your DNS change.",
    isRead: true,
    isStarred: false,
    isArchived: false,
    deletedAt: null,
    receivedAt: "2026-04-02T05:20:00.000Z"
  },
  {
    id: "em-1004",
    userId: "u-nadia",
    sender: "team@figma.com",
    recipient: "nadia@company.com",
    subject: "New comments on MailFlare dashboard",
    snippet: "3 comments were added to the Dashboard redesign file.",
    bodyText: "3 comments were added to the Dashboard redesign file.",
    isRead: false,
    isStarred: false,
    isArchived: false,
    deletedAt: null,
    receivedAt: "2026-04-01T22:18:00.000Z"
  },
  {
    id: "em-1005",
    userId: "u-rizky",
    sender: "security@github.com",
    recipient: "rizky@company.com",
    subject: "Dependabot alert resolved",
    snippet: "The vulnerable dependency has been patched in default branch.",
    bodyText: "The vulnerable dependency has been patched in default branch.",
    isRead: true,
    isStarred: false,
    isArchived: true,
    deletedAt: null,
    receivedAt: "2026-04-01T20:02:00.000Z"
  },
  {
    id: "em-1006",
    userId: "u-rizky",
    sender: "hello@vercel.com",
    recipient: "rizky@company.com",
    subject: "Build completed successfully",
    snippet: "Preview deployment is ready for branch feature/mail-worker.",
    bodyText: "Preview deployment is ready for branch feature/mail-worker.",
    isRead: false,
    isStarred: false,
    isArchived: false,
    deletedAt: null,
    receivedAt: "2026-04-01T18:40:00.000Z"
  },
  {
    id: "em-1007",
    userId: "u-rizky",
    sender: "newsletter@cloudflare.com",
    recipient: "rizky@company.com",
    subject: "Workers platform update",
    snippet: "New runtime features are now generally available.",
    bodyText: "New runtime features are now generally available.",
    isRead: true,
    isStarred: false,
    isArchived: false,
    deletedAt: "2026-04-01T12:00:00.000Z",
    receivedAt: "2026-03-31T10:00:00.000Z"
  }
];

const storedSettings: StoredSettings = {
  defaultTelegramChatId: "-100148293041",
  telegramForwardEnabled: true,
  telegramForwardMode: "all_allowed",
  telegramForwardChatId: "",
  updatedAt: new Date().toISOString()
};

function computeStats(): DashboardStats {
  return {
    totalUsers: usersSeed.length,
    totalEmails: emailsStore.length,
    unreadEmails: emailsStore.filter((email) => !email.isRead && !email.deletedAt).length,
    starredEmails: emailsStore.filter((email) => email.isStarred && !email.deletedAt).length,
    archivedEmails: emailsStore.filter((email) => email.isArchived && !email.deletedAt).length,
    deletedEmails: emailsStore.filter((email) => !!email.deletedAt).length
  };
}

function listUsers(): UserRecord[] {
  return usersSeed.map((user) => {
    const active = emailsStore.filter((email) => email.userId === user.id && !email.deletedAt);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      unreadCount: active.filter((email) => !email.isRead).length,
      totalCount: active.length,
      createdAt: user.createdAt
    };
  });
}

function sortByNewest(a: EmailRecord, b: EmailRecord): number {
  return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
}

function listRecent(): EmailRecord[] {
  return emailsStore.filter((email) => !email.deletedAt).sort(sortByNewest);
}

function listInboxByUser(userId: string): EmailRecord[] {
  return emailsStore
    .filter((email) => email.userId === userId && !email.deletedAt)
    .sort(sortByNewest);
}

function getEmail(emailId: string): EmailRecord | undefined {
  return emailsStore.find((email) => email.id === emailId);
}

function patchEmail(emailId: string, action: string): EmailRecord | undefined {
  const email = getEmail(emailId);
  if (!email) return undefined;

  if (action === "read") email.isRead = true;
  if (action === "unread") email.isRead = false;
  if (action === "star") email.isStarred = true;
  if (action === "unstar") email.isStarred = false;
  if (action === "archive") email.isArchived = true;
  if (action === "delete") email.deletedAt = new Date().toISOString();

  return email;
}

function deleteUser(userId: string): { ok: boolean; email?: string; deletedEmails: number } {
  const index = usersSeed.findIndex((user) => user.id === userId);
  if (index < 0) {
    return { ok: false, deletedEmails: 0 };
  }

  const email = usersSeed[index].email;
  usersSeed.splice(index, 1);

  let deletedEmails = 0;
  for (let i = emailsStore.length - 1; i >= 0; i -= 1) {
    if (emailsStore[i].userId === userId) {
      emailsStore.splice(i, 1);
      deletedEmails += 1;
    }
  }

  return { ok: true, email, deletedEmails };
}

function json<T>(body: T): T {
  return body;
}

export function isMockModePreferredByDefault(): boolean {
  return import.meta.env.VITE_MAILFLARE_MOCK_DEFAULT === "1";
}

export async function mockApi<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "GET" && path === "/healthz") {
    const health: HealthResponse = {
      status: "mock-ok",
      timestamp: new Date().toISOString()
    };
    return json(health) as T;
  }

  if (method === "GET" && path === "/api/dashboard/stats") {
    return json(computeStats()) as T;
  }

  if (method === "GET" && path === "/api/users") {
    return json(listUsers()) as T;
  }

  if (method === "POST" && path === "/api/users") {
    const payload = (init?.body ? JSON.parse(String(init.body)) : {}) as {
      email?: string;
      displayName?: string;
    };
    const email = payload.email?.trim().toLowerCase() ?? "";
    if (!email || !email.includes("@")) {
      throw new Error("Invalid email");
    }
    if (usersSeed.some((row) => row.email.toLowerCase() === email)) {
      throw new Error("User already exists");
    }

    const user: MockUserSeed = {
      id: `u-${crypto.randomUUID().slice(0, 8)}`,
      email,
      displayName: payload.displayName?.trim() || email,
      createdAt: new Date().toISOString()
    };
    usersSeed.push(user);
    return json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        unreadCount: 0,
        totalCount: 0,
        createdAt: user.createdAt
      }
    }) as T;
  }

  const userDeleteMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (method === "DELETE" && userDeleteMatch) {
    const userId = decodeURIComponent(userDeleteMatch[1]);
    const deleted = deleteUser(userId);
    if (!deleted.ok) {
      throw new Error("User not found");
    }
    return json({
      ok: true,
      userId,
      email: deleted.email,
      deletedEmails: deleted.deletedEmails
    }) as T;
  }

  if (method === "GET" && path === "/api/emails/recent") {
    return json(listRecent()) as T;
  }

  if (method === "GET" && path === "/api/settings/runtime") {
    const runtime: RuntimeSettings = {
      privateGatewayEnabled: true,
      telegramConfigured: true,
      webhookSecretConfigured: true,
      inboundDomain: (import.meta.env.VITE_MAILFLARE_INBOUND_DOMAIN ?? "mx.kelasdev.my.id")
        .trim()
        .toLowerCase()
        .replace(/^@+/, ""),
      telegramAllowedIdsCount: 1,
      telegramAllowedIds: ["123456789"],
      metrics: {
        inbound_email_count: emailsStore.length,
        telegram_webhook_ok: 12,
        users_created: usersSeed.length
      },
      stored: { ...storedSettings }
    };
    return json(runtime) as T;
  }

  if (method === "PUT" && path === "/api/settings/profile") {
    const payload = (init?.body ? JSON.parse(String(init.body)) : {}) as {
      defaultTelegramChatId?: string;
      telegramForwardEnabled?: boolean;
      telegramForwardMode?: "all_allowed" | "specific";
      telegramForwardChatId?: string;
    };

    storedSettings.defaultTelegramChatId = payload.defaultTelegramChatId?.trim() ?? "";
    storedSettings.telegramForwardEnabled = Boolean(payload.telegramForwardEnabled);
    storedSettings.telegramForwardMode =
      payload.telegramForwardMode === "specific" ? "specific" : "all_allowed";
    storedSettings.telegramForwardChatId = payload.telegramForwardChatId?.trim() ?? "";
    storedSettings.updatedAt = new Date().toISOString();

    return json({
      ok: true,
      stored: { ...storedSettings }
    }) as T;
  }

  if (method === "POST" && path === "/api/settings/telegram/test") {
    return json({ ok: true }) as T;
  }

  if (method === "GET" && path === "/api/settings/telegram/webhook-status") {
    return json({
      ok: true,
      status: {
        url: "https://mail-flare.example.workers.dev/api/telegram/webhook",
        has_custom_certificate: false,
        pending_update_count: 0,
        max_connections: 40
      }
    }) as T;
  }

  const userInboxMatch = path.match(/^\/api\/users\/([^/]+)\/inbox$/);
  if (method === "GET" && userInboxMatch) {
    return json(listInboxByUser(decodeURIComponent(userInboxMatch[1]))) as T;
  }

  const emailDetailMatch = path.match(/^\/api\/emails\/([^/]+)$/);
  if (method === "GET" && emailDetailMatch) {
    const email = getEmail(decodeURIComponent(emailDetailMatch[1]));
    if (!email) throw new Error("Email not found");
    return json(email) as T;
  }

  const emailPatchMatch = path.match(/^\/api\/emails\/([^/]+)\/status$/);
  if (method === "PATCH" && emailPatchMatch) {
    const payload = (init?.body ? JSON.parse(String(init.body)) : {}) as { action?: string };
    const email = patchEmail(decodeURIComponent(emailPatchMatch[1]), payload.action ?? "");
    if (!email) throw new Error("Email not found");
    return json({ ok: true, email }) as T;
  }

  throw new Error(`Mock API route not implemented: ${method} ${path}`);
}
