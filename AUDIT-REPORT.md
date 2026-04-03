## Audit Report: MailFlare Worker
**Scope:** `worker/index.ts`, `worker/db.ts`, `worker/utils/email.ts`, `worker/utils/telegram.ts`, `worker/utils/status.ts`, `migrations/0001..0005.sql`  
**Advisors:** 6 models | **Candidates Found:** 17 | **Confirmed:** 9

## Fix Progress (Implemented)

- ✅ BUG-001: webhook sekarang wajib `TELEGRAM_WEBHOOK_SECRET` (fail jika tidak ada).
- ✅ BUG-002: query secret (`?secret=`) dihapus, hanya header Telegram resmi.
- ✅ BUG-003: expiry check diganti ke `unixepoch(...)` agar konsisten.
- ✅ BUG-004: decoding path memakai helper aman (tidak melempar 500 pada input rusak).
- ✅ BUG-007: `/apikey` dan `/access` dibatasi hanya di private chat.
- ✅ BUG-008: `actor` di PATCH status tidak lagi bisa dipalsukan dari payload client.
- ✅ BUG-010: parser MIME sudah recursive untuk nested multipart.
- ✅ BUG-012: idempotency Telegram `update_id` ditambahkan (`telegram_webhook_updates`).
- ✅ BUG-013: write multi-step di DB dipindah ke `db.batch` agar lebih atomic.
- ✅ (Investigasi BUG-009): query `listUsers` diperbaiki supaya user tanpa email tidak salah hitung.

### Migration Baru
- `migrations/0006_telegram_webhook_updates.sql`

### Verifikasi
- `pnpm test` ✅ (37/37 passed)

### Confirmed Bugs

#### BUG-001: Webhook auth can be bypassed when secret is unset [CRITICAL]
- **Location:** [worker/index.ts:1511](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/index.ts:1511)
- **Bug:** Secret validation is conditional; if `TELEGRAM_WEBHOOK_SECRET` is empty, webhook authenticity is not verified.
- **Evidence:** Handler only checks secret inside `if (secret)`, then trusts `from.id` from request JSON.
- **Impact:** Forged webhook requests can execute privileged bot commands.
- **Found by:** 2/6 hunters
- **Challenge result:** 5 confirmed, 1 disproved, 0 uncertain
- **Suggested fix direction:** Require secret validation unconditionally in production path.

#### BUG-003: Expiry checks compare incompatible datetime formats [HIGH]
- **Location:** [worker/index.ts:786](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/index.ts:786), [worker/db.ts:591](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/db.ts:591), [worker/db.ts:636](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/db.ts:636)
- **Bug:** Expiry is stored as ISO text (`toISOString`) and compared to `CURRENT_TIMESTAMP` text.
- **Evidence:** SQL uses `expires_at > CURRENT_TIMESTAMP` (text compare).
- **Impact:** Access code/session TTL can evaluate incorrectly.
- **Found by:** 3/6 hunters
- **Challenge result:** 4 confirmed, 1 disproved, 1 uncertain
- **Suggested fix direction:** Normalize both sides to same format or compare numeric epoch.

#### BUG-007: Sensitive bot outputs can leak in group chats [HIGH]
- **Location:** [worker/index.ts:1548](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/index.ts:1548), [worker/index.ts:1786](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/index.ts:1786), [worker/index.ts:1849](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/index.ts:1849)
- **Bug:** Authorization checks sender user ID, but `/apikey` and `/access` responses are sent to current `chatId`.
- **Evidence:** Secret-bearing responses are posted directly to chat context.
- **Impact:** API keys/access codes can be exposed to group members.
- **Found by:** 1/6 hunters
- **Challenge result:** 6 confirmed, 0 disproved, 0 uncertain
- **Suggested fix direction:** Restrict secret responses to private chat or enforce chat type policy.

#### BUG-004: Unhandled `decodeURIComponent` can throw on malformed path [MEDIUM]
- **Location:** [worker/index.ts:97](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/index.ts:97)
- **Bug:** Decoding route segment has no guard.
- **Evidence:** Malformed percent-encoding can raise `URIError`.
- **Impact:** Request can fail with 5xx on crafted path.
- **Found by:** 1/6 hunters
- **Challenge result:** 4 confirmed, 1 disproved, 1 uncertain
- **Suggested fix direction:** Wrap decode in safe parsing fallback.

#### BUG-008: Audit actor is client-forgeable in status patch API [MEDIUM]
- **Location:** [worker/index.ts:1387](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/index.ts:1387), [worker/db.ts:401](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/db.ts:401)
- **Bug:** `actor` is accepted from request body and persisted as history actor.
- **Evidence:** No server-side binding of actor identity.
- **Impact:** Audit trail integrity is unreliable.
- **Found by:** 2/6 hunters
- **Challenge result:** 4 confirmed, 2 disproved, 0 uncertain
- **Suggested fix direction:** Derive actor server-side from auth context.

#### BUG-010: MIME parser does not recurse nested multiparts [MEDIUM]
- **Location:** [worker/utils/email.ts:208](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/utils/email.ts:208)
- **Bug:** Only top-level multipart is parsed.
- **Evidence:** No recursive parse for nested `multipart/*`.
- **Impact:** Real emails may lose body text/HTML extraction.
- **Found by:** 3/6 hunters
- **Challenge result:** 5 confirmed, 0 disproved, 1 uncertain
- **Suggested fix direction:** Add recursive multipart traversal.

#### BUG-012: No webhook idempotency on Telegram `update_id` [MEDIUM]
- **Location:** [worker/index.ts:1527](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/index.ts:1527)
- **Bug:** `update_id` is parsed but never deduplicated.
- **Evidence:** No persistence/check before side effects.
- **Impact:** Retries can duplicate key/code generation and actions.
- **Found by:** 2/6 hunters
- **Challenge result:** 4 confirmed, 2 disproved, 0 uncertain
- **Suggested fix direction:** Store processed update IDs with TTL and reject repeats.

#### BUG-013: Multi-step DB mutations are non-transactional [MEDIUM]
- **Location:** [worker/db.ts:256](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/db.ts:256), [worker/db.ts:356](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/db.ts:356)
- **Bug:** Related writes happen across multiple statements without transaction.
- **Evidence:** Delete/status flows execute stepwise update/insert/delete operations.
- **Impact:** Partial state possible on intermediate failure.
- **Found by:** 1/6 hunters
- **Challenge result:** 5 confirmed, 1 disproved, 0 uncertain
- **Suggested fix direction:** Wrap related write sequences in transaction boundaries.

#### BUG-002: Webhook secret accepted in query string [LOW]
- **Location:** [worker/index.ts:1519](c:/Users/LENOVO/Desktop/KODINGAN/MailFlare/worker/index.ts:1519)
- **Bug:** `?secret=` is accepted as alternate auth input.
- **Evidence:** Query secret compared alongside header secret.
- **Impact:** Increased risk of secret leakage through URL logging/surfaces.
- **Found by:** 1/6 hunters
- **Challenge result:** 4 confirmed, 2 disproved, 0 uncertain
- **Suggested fix direction:** Accept secret only via Telegram header.

### Dismissed Findings

| ID | Claim | Reason Dismissed |
|---|---|---|
| BUG-005 | Quick-open `/auth/<code>` does not redeem | Access-denied page script auto-reads hash and submits redeem form. |
| BUG-011 | Escaping HTML in `srcdoc` prevents rendering | Skeptic majority found this can still render due attribute decoding; not a reliable bug claim. |
| BUG-015 | Empty `TELEGRAM_ALLOWED_IDS` is a bug | Treated as fail-closed security default, not functional defect by itself. |
| BUG-017 | Runtime `api_keys` table creation is broken | No concrete runtime breakage shown; judged as schema-governance concern, not immediate bug. |

### Needs Investigation

| ID | Claim | Why Uncertain |
|---|---|---|
| BUG-006 | `TELEGRAM_ALLOWED_IDS` semantics mismatch (user auth vs chat targets/preview uid) | Split verdicts; likely operational footgun but deployment intent may make it acceptable. |
| BUG-009 | `listUsers` zero-email users counted as 1 | Skeptics split evenly; requires quick runtime SQL verification in this environment. |
| BUG-014 | Archived emails still shown in inbox/recent | Could be intended “tag” behavior vs expected archive hide behavior. |
| BUG-016 | Telegram helper no-op with missing token masks success | Evidence of silent no-op exists; severity depends on intended fail-fast behavior. |

### Audit Summary
- **Confidence:** Medium-High (strong consensus on top security/data-integrity issues).
- **Coverage:** Core webhook auth, private access flow, DB mutation logic, MIME parsing, Telegram command paths.
- **Recommendation:** Prioritize BUG-001, BUG-003, BUG-007 first; then BUG-008/010/012/013.
