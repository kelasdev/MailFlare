import type { TelegramCommand } from "../types";

interface TelegramMessagePayload {
  chat_id: string | number;
  text: string;
  parse_mode?: "Markdown" | "MarkdownV2";
  disable_web_page_preview?: boolean;
}

export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}

export function parseAllowedIds(csvText: string | undefined): Set<string> {
  if (!csvText) return new Set<string>();
  return new Set(
    csvText
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
}

export function isAllowedTelegramUser(allowedIds: Set<string>, userId: string | number): boolean {
  return allowedIds.has(String(userId));
}

export function parseTelegramCommand(rawText: string | undefined): TelegramCommand {
  const text = (rawText ?? "").trim();
  if (!text.startsWith("/")) {
    return { command: "unknown", args: [], raw: text };
  }

  const parts = text.split(/\s+/);
  const commandToken = parts[0]?.toLowerCase().replace(/^\/+/, "") ?? "";
  const commandName = commandToken.split("@")[0] ?? commandToken;
  const args = parts.slice(1);

  const known = new Set([
    "start",
    "stats",
    "inbox",
    "mail",
    "read",
    "unread",
    "star",
    "unstar",
    "archive",
    "delete",
    "access",
    "reply"
  ]);

  if (!known.has(commandName)) {
    return { command: "unknown", args, raw: text };
  }

  return {
    command: commandName as TelegramCommand["command"],
    args,
    raw: text
  };
}

export async function sendTelegramMessage(
  botToken: string | undefined,
  payload: TelegramMessagePayload,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!botToken) return;
  const response = await fetchImpl(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }
}

export async function getTelegramWebhookInfo(
  botToken: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<TelegramWebhookInfo> {
  if (!botToken) {
    throw new Error("Telegram bot token is not configured");
  }
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
    method: "GET"
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram getWebhookInfo failed: ${response.status} ${body}`);
  }
  const parsed = (await response.json()) as {
    ok?: boolean;
    result?: TelegramWebhookInfo;
    description?: string;
  };
  if (!parsed.ok || !parsed.result) {
    throw new Error(`Telegram getWebhookInfo failed: ${parsed.description ?? "unknown error"}`);
  }
  return parsed.result;
}
