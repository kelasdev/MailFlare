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

interface HeaderBodySplit {
  headerText: string;
  bodyText: string;
}

interface MimePart {
  headers: Map<string, string>;
  body: string;
}

function normalizeEol(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitHeaderBody(rawText: string): HeaderBodySplit {
  const normalized = normalizeEol(rawText);
  const marker = normalized.indexOf("\n\n");
  if (marker < 0) {
    return { headerText: "", bodyText: normalized };
  }
  return {
    headerText: normalized.slice(0, marker),
    bodyText: normalized.slice(marker + 2)
  };
}

function parseHeaderMap(headerText: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = normalizeEol(headerText).split("\n");
  let currentKey = "";
  let currentValue = "";

  const flush = () => {
    if (!currentKey) return;
    map.set(currentKey.toLowerCase(), currentValue.trim());
    currentKey = "";
    currentValue = "";
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^[ \t]/.test(line) && currentKey) {
      currentValue += ` ${line.trim()}`;
      continue;
    }
    flush();
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    currentKey = line.slice(0, separator).trim();
    currentValue = line.slice(separator + 1).trim();
  }
  flush();
  return map;
}

function parseBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary\s*=\s*("?)([^";]+)\1/i);
  return match?.[2]?.trim() || null;
}

function parseMimeParts(bodyText: string, boundary: string): MimePart[] {
  const normalized = normalizeEol(bodyText);
  const boundaryToken = `--${boundary}`;
  const segments = normalized.split(boundaryToken);
  const parts: MimePart[] = [];

  for (const segment of segments) {
    const cleaned = segment.trim();
    if (!cleaned || cleaned === "--") continue;
    if (cleaned.startsWith("--")) continue;
    const { headerText, bodyText: partBody } = splitHeaderBody(cleaned);
    const headers = parseHeaderMap(headerText);
    parts.push({ headers, body: partBody.trim() });
  }

  return parts;
}

function decodeQuotedPrintable(input: string): string {
  const normalized = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "=" && i + 2 < normalized.length) {
      const hex = normalized.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(normalized.charCodeAt(i) & 0xff);
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeBase64(input: string): string {
  const compact = input.replace(/\s+/g, "");
  if (!compact) return "";
  try {
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return input;
  }
}

function decodeByTransferEncoding(body: string, encodingHeader: string | undefined): string {
  const encoding = (encodingHeader ?? "").trim().toLowerCase();
  if (encoding.includes("quoted-printable")) {
    return decodeQuotedPrintable(body);
  }
  if (encoding.includes("base64")) {
    return decodeBase64(body);
  }
  return body;
}

function htmlToText(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHeaderLikePrefix(input: string): string {
  const lines = normalizeEol(input).split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      break;
    }
    if (/^[A-Za-z0-9-]+:\s/.test(line) || /^[ \t]+/.test(line)) {
      index += 1;
      continue;
    }
    break;
  }

  if (index > 0 && index < lines.length) {
    return lines.slice(index).join("\n");
  }
  return input;
}

function compactSnippet(input: string): string {
  return normalizeEol(input).replace(/\s+/g, " ").trim();
}

function normalizeBodyForDisplay(input: string): string {
  const noHeaderPrefix = stripHeaderLikePrefix(input);
  return normalizeEol(noHeaderPrefix).replace(/\u0000/g, "").trim();
}

function headersToMap(headers: Headers | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!headers) return map;
  headers.forEach((value, key) => {
    map.set(key.toLowerCase(), value);
  });
  return map;
}

function mapToJson(map: Map<string, string>): string | null {
  if (map.size < 1) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of map.entries()) {
    out[key] = value;
  }
  return JSON.stringify(out);
}

interface ExtractedEmailPayload {
  headers: Map<string, string>;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string | null;
}

function extractEmailPayload(rawText: string): ExtractedEmailPayload {
  const { headerText, bodyText } = splitHeaderBody(rawText);
  const topHeaders = parseHeaderMap(headerText);
  const topContentType = topHeaders.get("content-type") ?? "";
  const topTransfer = topHeaders.get("content-transfer-encoding");

  let plainCandidate: string | null = null;
  let htmlCandidate: string | null = null;
  let fallbackCandidate = decodeByTransferEncoding(bodyText, topTransfer);

  if (topContentType.toLowerCase().includes("multipart/")) {
    const boundary = parseBoundary(topContentType);
    if (boundary) {
      const parts = parseMimeParts(bodyText, boundary);
      for (const part of parts) {
        const contentType = (part.headers.get("content-type") ?? "").toLowerCase();
        const disposition = (part.headers.get("content-disposition") ?? "").toLowerCase();
        if (disposition.includes("attachment")) continue;

        const decoded = decodeByTransferEncoding(
          part.body,
          part.headers.get("content-transfer-encoding")
        );

        if (!plainCandidate && contentType.includes("text/plain")) {
          plainCandidate = decoded;
          continue;
        }
        if (!htmlCandidate && contentType.includes("text/html")) {
          htmlCandidate = decoded;
          continue;
        }
        if (!plainCandidate && !htmlCandidate && decoded.trim()) {
          fallbackCandidate = decoded;
        }
      }
    }
  } else if (topContentType.toLowerCase().includes("text/html")) {
    htmlCandidate = fallbackCandidate;
  } else {
    plainCandidate = fallbackCandidate;
  }

  const bodyHtmlRaw = htmlCandidate?.trim() ? htmlCandidate : null;
  const bodyTextSource =
    plainCandidate?.trim() ||
    (bodyHtmlRaw ? htmlToText(bodyHtmlRaw) : "") ||
    fallbackCandidate ||
    "";

  const bodyTextNormalized = normalizeBodyForDisplay(bodyTextSource);
  const bodyTextOut = bodyTextNormalized ? bodyTextNormalized : null;
  const snippet = bodyTextOut ? compactSnippet(bodyTextOut).slice(0, 300) : null;

  return {
    headers: topHeaders,
    bodyText: bodyTextOut,
    bodyHtml: bodyHtmlRaw,
    snippet
  };
}

async function readRawText(raw: unknown): Promise<string | null> {
  if (!raw) return null;
  if (typeof raw === "string") return raw;

  try {
    if (raw instanceof ReadableStream) {
      return await new Response(raw).text();
    }
    if (raw instanceof ArrayBuffer) {
      return new TextDecoder().decode(raw);
    }
    if (raw instanceof Uint8Array) {
      return new TextDecoder().decode(raw);
    }
  } catch {
    return null;
  }

  return null;
}

export async function parseInboundEmail(message: InboundEmailLike): Promise<InboundEmail> {
  const rawMime = await readRawText(message.raw);
  const extracted = rawMime ? extractEmailPayload(rawMime) : null;
  const fallbackHeaders = headersToMap(message.headers);

  const subject =
    getHeaderValue(message.headers, "subject") ?? extracted?.headers.get("subject") ?? null;
  const messageId =
    getHeaderValue(message.headers, "message-id") ?? extracted?.headers.get("message-id") ?? null;

  return {
    id: crypto.randomUUID(),
    messageId,
    sender: message.from,
    recipient: message.to,
    subject,
    snippet: extracted?.snippet ?? null,
    bodyText: extracted?.bodyText ?? null,
    bodyHtml: extracted?.bodyHtml ?? null,
    rawMime,
    headersJson: mapToJson(extracted?.headers ?? fallbackHeaders),
    rawSize: message.rawSize ?? null,
    receivedAt: new Date().toISOString()
  };
}
