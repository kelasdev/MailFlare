import type { TelegramCommand } from "../types";

interface TelegramMessagePayload {
  chat_id: string | number;
  text: string;
  parse_mode?: "Markdown";
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
    "stats",
    "inbox",
    "mail",
    "read",
    "unread",
    "star",
    "unstar",
    "archive",
    "delete",
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
