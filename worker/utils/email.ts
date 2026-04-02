import type { InboundEmail } from "../types";

interface InboundEmailLike {
  from: string;
  to: string;
  headers?: Headers;
  raw?: unknown;
  rawSize?: number;
}

function getHeaderValue(headers: Headers | undefined, key: string): string | null {
  if (!headers) return null;
  return headers.get(key);
}

async function readRawSnippet(raw: unknown): Promise<string | null> {
  if (!raw) return null;
  if (typeof raw === "string") return raw.slice(0, 300);

  try {
    if (raw instanceof ReadableStream) {
      const text = await new Response(raw).text();
      return text.slice(0, 300);
    }
    if (raw instanceof ArrayBuffer) {
      const text = new TextDecoder().decode(raw);
      return text.slice(0, 300);
    }
  } catch {
    return null;
  }

  return null;
}

export async function parseInboundEmail(message: InboundEmailLike): Promise<InboundEmail> {
  const subject = getHeaderValue(message.headers, "subject");
  const messageId = getHeaderValue(message.headers, "message-id");
  const snippet = await readRawSnippet(message.raw);

  return {
    id: crypto.randomUUID(),
    messageId,
    sender: message.from,
    recipient: message.to,
    subject,
    snippet,
    rawSize: message.rawSize ?? null,
    receivedAt: new Date().toISOString()
  };
}
