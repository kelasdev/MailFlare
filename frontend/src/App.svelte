<script lang="ts">
  import { onMount } from "svelte";
  import {
    isMockModePreferredByDefault,
    mockApi,
    type DashboardStats,
    type EmailRecord,
    type RuntimeSettings,
    type UserRecord
  } from "./mockApi";

  type NavPath = "/" | "/users" | "/inbox" | "/email-detail" | "/settings";

  interface HealthResponse {
    status: string;
    timestamp: string;
  }

  interface TelegramWebhookStatus {
    url: string;
    has_custom_certificate: boolean;
    pending_update_count: number;
    ip_address?: string;
    last_error_date?: number;
    last_error_message?: string;
    max_connections?: number;
  }

  const MOCK_MODE_STORAGE_KEY = "mailflare:mock-mode";
  const INTERNAL_PATH_STORAGE_KEY = "mailflare:internal-path";
  const SELECTED_USER_STORAGE_KEY = "mailflare:selected-user";
  const SELECTED_EMAIL_STORAGE_KEY = "mailflare:selected-email";
  const DEFAULT_INBOUND_DOMAIN = "mx.kelasdev.my.id";

  const navItems: Array<{
    path: "/" | "/users" | "/settings";
    label: string;
    mobileLabel: string;
    icon: string;
  }> = [
    { path: "/", label: "MailFlare Dashboard", mobileLabel: "Dashboard", icon: "dashboard" },
    { path: "/users", label: "User List View", mobileLabel: "Users", icon: "group" },
    { path: "/settings", label: "Worker Settings & Stats", mobileLabel: "Settings", icon: "settings" }
  ];

  let currentPath: NavPath = "/";
  let loading = false;
  let errorText = "";
  let feedbackText = "";
  let mockMode = false;
  let allowMockMode = false;

  let stats: DashboardStats | null = null;
  let users: UserRecord[] = [];
  let inbox: EmailRecord[] = [];
  let detailEmail: EmailRecord | null = null;
  let health: HealthResponse | null = null;
  let runtimeSettings: RuntimeSettings | null = null;

  let selectedUserId = "";
  let detailEmailId = "";
  let inboundDomain = DEFAULT_INBOUND_DOMAIN;
  let addUserDomain = DEFAULT_INBOUND_DOMAIN;
  let inboxSearchQuery = "";
  let userSearchQuery = "";
  let userSortMode: "az" | "created" = "az";
  let refreshingInbox = false;
  let showAddUserModal = false;
  let newUserEmail = "";
  let newUserDisplayName = "";
  let creatingUser = false;
  let telegramChatId = "";
  let testingTelegramConnection = false;
  let settingsDefaultTelegramChatId = "";
  let settingsTelegramForwardState: "enabled" | "disabled" = "enabled";
  let settingsTelegramForwardMode: "all_allowed" | "specific" = "all_allowed";
  let settingsTelegramForwardChatId = "";
  let telegramWebhookStatus: TelegramWebhookStatus | null = null;
  let loadingWebhookStatus = false;
  let settingsUpdatedAt: string | null = null;
  let savingSettingsProfile = false;

  function asNavPath(pathname: string | null | undefined): NavPath {
    if (pathname === "/users") return "/users";
    if (pathname === "/inbox") return "/inbox";
    if (pathname === "/email-detail") return "/email-detail";
    if (pathname === "/settings") return "/settings";
    return "/";
  }

  function isNavActive(path: "/" | "/users" | "/settings"): boolean {
    if (path === "/users") {
      return currentPath === "/users" || currentPath === "/inbox" || currentPath === "/email-detail";
    }
    return currentPath === path;
  }

  function selectedUserLabel(): string {
    const user = users.find((row) => row.id === selectedUserId);
    if (!user) return "-";
    return user.displayName ?? user.email;
  }

  function userDisplayLabel(user: UserRecord): string {
    return user.displayName ?? user.email;
  }

  function userMatchesQuery(user: UserRecord, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [userDisplayLabel(user), user.email, user.id].join(" ").toLowerCase().includes(needle);
  }

  function userCreatedAt(user: UserRecord): string | null {
    return user.createdAt ?? null;
  }

  function userCreatedSortValue(user: UserRecord): number {
    const createdAt = userCreatedAt(user);
    if (!createdAt) return 0;
    const value = new Date(createdAt).getTime();
    return Number.isFinite(value) ? value : 0;
  }

  function sortUsers(list: UserRecord[]): UserRecord[] {
    const next = [...list];
    if (userSortMode === "created") {
      next.sort((a, b) => {
        const time = userCreatedSortValue(b) - userCreatedSortValue(a);
        if (time !== 0) return time;
        return userDisplayLabel(a).localeCompare(userDisplayLabel(b));
      });
      return next;
    }
    next.sort((a, b) => userDisplayLabel(a).localeCompare(userDisplayLabel(b)));
    return next;
  }

  function openAddUserModal(): void {
    showAddUserModal = true;
    newUserEmail = "";
    newUserDisplayName = "";
    errorText = "";
    feedbackText = "";
    void ensureInboundDomainFromRuntime();
  }

  function closeAddUserModal(): void {
    if (creatingUser) return;
    showAddUserModal = false;
  }

  function handleAddUserBackdropClick(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    closeAddUserModal();
  }

  async function submitAddUser(): Promise<void> {
    const emailInput = newUserEmail.trim().toLowerCase();
    if (!emailInput) {
      errorText = "Email wajib diisi.";
      return;
    }
    const email = normalizeUserEmail(emailInput);
    if (!email.includes("@")) {
      errorText = "Email belum valid. Masukkan email lengkap atau set inbound domain.";
      return;
    }
    const displayName = newUserDisplayName.trim() || undefined;

    feedbackText = "";
    errorText = "";
    creatingUser = true;
    try {
      const created = await api<{ ok: boolean; user: UserRecord }>("/api/users", {
        method: "POST",
        body: JSON.stringify({ email, displayName })
      });
      await loadUsers();
      selectedUserId = created.user.id;
      localStorage.setItem(SELECTED_USER_STORAGE_KEY, selectedUserId);
      feedbackText = `User ${created.user.displayName ?? created.user.email} berhasil ditambahkan.`;
      showAddUserModal = false;
    } catch (error) {
      errorText = error instanceof Error ? error.message : "Failed to add user";
    } finally {
      creatingUser = false;
    }
  }

  function navigate(path: NavPath): void {
    if (path !== currentPath) {
      currentPath = path;
      localStorage.setItem(INTERNAL_PATH_STORAGE_KEY, path);
      void loadCurrentView();
    }
  }

  function toLocalTime(isoText: string): string {
    try {
      return new Date(isoText).toLocaleString();
    } catch {
      return isoText;
    }
  }

  function normalizeUserEmail(input: string): string {
    const value = input.trim().toLowerCase();
    if (!value) return "";
    if (value.includes("@")) return value;
    const domain = resolveInboundDomain();
    if (domain) return `${value}@${domain}`;
    return value;
  }

  function normalizeDomain(rawDomain: string | null | undefined): string {
    const normalized = (rawDomain ?? "").trim().toLowerCase();
    if (!normalized) return "";
    return normalized.replace(/^@+/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }

  function resolveInboundDomain(): string {
    const runtimeDomain = normalizeDomain(runtimeSettings?.inboundDomain);
    if (runtimeDomain) return runtimeDomain;
    return normalizeDomain(inboundDomain);
  }

  async function ensureInboundDomainFromRuntime(): Promise<void> {
    if (normalizeDomain(runtimeSettings?.inboundDomain)) return;
    try {
      const runtime = await api<RuntimeSettings>("/api/settings/runtime");
      runtimeSettings = runtime;
      const domain = normalizeDomain(runtime.inboundDomain);
      if (domain) inboundDomain = domain;
    } catch {
      // Keep using local fallback domain when runtime endpoint is unavailable.
    }
  }

  function isLocalHost(hostname: string): boolean {
    const host = hostname.trim().toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  }

  function unixSecondsToLocal(seconds?: number): string {
    if (!seconds) return "-";
    try {
      return new Date(seconds * 1000).toLocaleString();
    } catch {
      return String(seconds);
    }
  }

  function senderEmail(sender: string): string {
    const angle = sender.match(/<([^>]+)>/);
    if (angle?.[1]) return angle[1].trim();
    return sender.includes("@") ? sender.trim() : "";
  }

  function titleize(text: string): string {
    return text
      .split(/[\s._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  function senderDisplayName(sender: string): string {
    const angleName = sender.match(/^"?([^"<]+)"?\s*<[^>]+>$/);
    if (angleName?.[1]) {
      return angleName[1].trim();
    }
    const email = senderEmail(sender);
    if (email) {
      const local = email.split("@")[0] ?? "";
      return titleize(local) || email;
    }
    return sender;
  }

  function senderInitial(sender: string): string {
    const name = senderDisplayName(sender).trim();
    if (!name) return "?";
    return name.charAt(0).toUpperCase();
  }

  function toShortDate(isoText: string): string {
    try {
      return new Date(isoText).toLocaleDateString(undefined, {
        month: "short",
        day: "2-digit"
      });
    } catch {
      return isoText;
    }
  }

  function formatCompact(value: number): string {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1
    }).format(value);
  }

  function emailMatchesQuery(email: EmailRecord, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;

    const haystack = [
      senderDisplayName(email.sender),
      senderEmail(email.sender),
      email.subject ?? "",
      email.snippet ?? ""
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(needle);
  }

  function initializeMockMode(): void {
    if (!allowMockMode) {
      mockMode = false;
      localStorage.setItem(MOCK_MODE_STORAGE_KEY, "0");
      return;
    }

    const queryMode = new URLSearchParams(window.location.search).get("mock");
    if (queryMode === "1") {
      mockMode = true;
      localStorage.setItem(MOCK_MODE_STORAGE_KEY, "1");
      return;
    }
    if (queryMode === "0") {
      mockMode = false;
      localStorage.setItem(MOCK_MODE_STORAGE_KEY, "0");
      return;
    }

    const stored = localStorage.getItem(MOCK_MODE_STORAGE_KEY);
    if (stored === "1") {
      mockMode = true;
    } else if (stored === "0") {
      mockMode = false;
    }
  }

  function detectAllowMockMode(): boolean {
    return import.meta.env.DEV || isLocalHost(window.location.hostname);
  }

  function initializeInternalPath(): void {
    const storedPath = localStorage.getItem(INTERNAL_PATH_STORAGE_KEY);
    currentPath = asNavPath(storedPath);
    selectedUserId = localStorage.getItem(SELECTED_USER_STORAGE_KEY) ?? "";
    detailEmailId = localStorage.getItem(SELECTED_EMAIL_STORAGE_KEY) ?? "";

    if (window.location.pathname !== "/") {
      history.replaceState({}, "", "/");
    }
  }

  function setMockMode(value: boolean): void {
    if (!allowMockMode) return;
    mockMode = value;
    localStorage.setItem(MOCK_MODE_STORAGE_KEY, value ? "1" : "0");
    feedbackText = value
      ? "Mock mode aktif: UI memakai data lokal."
      : "Live mode aktif: UI memakai API backend.";
    void loadCurrentView();
  }

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    if (mockMode) {
      return mockApi<T>(path, init);
    }

    const response = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {})
      }
    });
    if (response.status === 401) {
      window.location.href = "/auth/access-denied";
      throw new Error("Session expired. Silakan login ulang via access code Telegram.");
    }
    if (!response.ok) {
      const body = await response.text();
      if (body) {
        try {
          const parsed = JSON.parse(body) as { error?: string; message?: string };
          throw new Error(parsed.error || parsed.message || body);
        } catch {
          throw new Error(body);
        }
      }
      throw new Error(`Request failed with ${response.status}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async function loadDashboard(): Promise<void> {
    stats = await api<DashboardStats>("/api/dashboard/stats");
  }

  async function loadUsers(): Promise<void> {
    users = await api<UserRecord[]>("/api/users");
  }

  async function loadEmailDetail(): Promise<void> {
    detailEmail = null;
    if (!detailEmailId) return;
    detailEmail = await api<EmailRecord>(`/api/emails/${detailEmailId}`);
  }

  async function loadInboxForSelectedUser(): Promise<void> {
    if (!selectedUserId) {
      inbox = [];
      detailEmailId = "";
      detailEmail = null;
      localStorage.removeItem(SELECTED_USER_STORAGE_KEY);
      localStorage.removeItem(SELECTED_EMAIL_STORAGE_KEY);
      return;
    }

    inbox = await api<EmailRecord[]>(`/api/users/${selectedUserId}/inbox`);
    if (inbox.length === 0) {
      detailEmailId = "";
      detailEmail = null;
      localStorage.setItem(SELECTED_USER_STORAGE_KEY, selectedUserId);
      localStorage.removeItem(SELECTED_EMAIL_STORAGE_KEY);
      return;
    }

    const hasSelectedEmail = inbox.some((email) => email.id === detailEmailId);
    if (!hasSelectedEmail) {
      detailEmailId = inbox[0].id;
      localStorage.setItem(SELECTED_EMAIL_STORAGE_KEY, detailEmailId);
    }
    await loadEmailDetail();
  }

  async function selectUser(userId: string, navigateToInbox = false): Promise<void> {
    selectedUserId = userId;
    detailEmailId = "";
    detailEmail = null;
    localStorage.setItem(SELECTED_USER_STORAGE_KEY, selectedUserId);
    localStorage.removeItem(SELECTED_EMAIL_STORAGE_KEY);
    inboxSearchQuery = "";
    await loadInboxForSelectedUser();
    if (navigateToInbox) {
      navigate("/inbox");
    }
  }

  async function selectEmail(emailId: string, navigateToDetail = false): Promise<void> {
    detailEmailId = emailId;
    localStorage.setItem(SELECTED_EMAIL_STORAGE_KEY, detailEmailId);
    await loadEmailDetail();
    if (navigateToDetail) {
      navigate("/email-detail");
    }
  }

  async function loadSettings(): Promise<void> {
    health = await api<HealthResponse>("/healthz");
    runtimeSettings = await api<RuntimeSettings>("/api/settings/runtime");
    const domain = normalizeDomain(runtimeSettings.inboundDomain);
    if (domain) inboundDomain = domain;
    settingsDefaultTelegramChatId = runtimeSettings.stored.defaultTelegramChatId;
    settingsTelegramForwardState = runtimeSettings.stored.telegramForwardEnabled
      ? "enabled"
      : "disabled";
    settingsTelegramForwardMode = runtimeSettings.stored.telegramForwardMode;
    settingsTelegramForwardChatId = runtimeSettings.stored.telegramForwardChatId;
    settingsUpdatedAt = runtimeSettings.stored.updatedAt;
    if (!telegramChatId.trim()) {
      telegramChatId =
        runtimeSettings.stored.telegramForwardMode === "specific"
          ? runtimeSettings.stored.telegramForwardChatId ||
            runtimeSettings.stored.defaultTelegramChatId
          : runtimeSettings.stored.defaultTelegramChatId;
    }
    if (!stats) {
      stats = await api<DashboardStats>("/api/dashboard/stats");
    }
    await refreshTelegramWebhookStatus();
  }

  async function saveSettingsProfile(): Promise<void> {
    savingSettingsProfile = true;
    feedbackText = "";
    errorText = "";
    try {
      const response = await api<{
        ok: boolean;
        stored: {
          defaultTelegramChatId: string;
          telegramForwardEnabled: boolean;
          telegramForwardMode: "all_allowed" | "specific";
          telegramForwardChatId: string;
          updatedAt: string | null;
        };
      }>("/api/settings/profile", {
        method: "PUT",
        body: JSON.stringify({
          defaultTelegramChatId: settingsDefaultTelegramChatId,
          telegramForwardEnabled: settingsTelegramForwardState === "enabled",
          telegramForwardMode: settingsTelegramForwardMode,
          telegramForwardChatId: settingsTelegramForwardChatId
        })
      });
      settingsDefaultTelegramChatId = response.stored.defaultTelegramChatId;
      settingsTelegramForwardState = response.stored.telegramForwardEnabled
        ? "enabled"
        : "disabled";
      settingsTelegramForwardMode = response.stored.telegramForwardMode;
      settingsTelegramForwardChatId = response.stored.telegramForwardChatId;
      settingsUpdatedAt = response.stored.updatedAt;
      if (!telegramChatId.trim()) {
        telegramChatId =
          response.stored.telegramForwardMode === "specific"
            ? response.stored.telegramForwardChatId || response.stored.defaultTelegramChatId
            : response.stored.defaultTelegramChatId;
      }
      feedbackText = "Settings profile berhasil disimpan.";
      await loadSettings();
    } catch (error) {
      errorText = error instanceof Error ? error.message : "Failed to save settings profile";
    } finally {
      savingSettingsProfile = false;
    }
  }

  async function testTelegramConnection(): Promise<void> {
    const chatId =
      telegramChatId.trim() ||
      (settingsTelegramForwardMode === "specific"
        ? settingsTelegramForwardChatId.trim() || settingsDefaultTelegramChatId.trim()
        : settingsDefaultTelegramChatId.trim());
    if (!chatId) {
      errorText = "Chat ID wajib diisi untuk test Telegram.";
      return;
    }
    testingTelegramConnection = true;
    feedbackText = "";
    errorText = "";
    try {
      await api<{ ok: boolean }>("/api/settings/telegram/test", {
        method: "POST",
        body: JSON.stringify({
          chatId,
          message: `MailFlare test message (${new Date().toLocaleString()})`
        })
      });
      feedbackText = "Test message Telegram berhasil dikirim.";
      await loadSettings();
    } catch (error) {
      errorText = error instanceof Error ? error.message : "Failed to send Telegram test";
    } finally {
      testingTelegramConnection = false;
    }
  }

  async function refreshTelegramWebhookStatus(): Promise<void> {
    loadingWebhookStatus = true;
    try {
      const response = await api<{ ok: boolean; status: TelegramWebhookStatus }>(
        "/api/settings/telegram/webhook-status"
      );
      telegramWebhookStatus = response.status;
    } catch {
      telegramWebhookStatus = null;
    } finally {
      loadingWebhookStatus = false;
    }
  }

  async function loadCurrentView(): Promise<void> {
    loading = true;
    errorText = "";
    feedbackText = "";
    try {
      if (currentPath === "/") {
        await loadDashboard();
      } else if (currentPath === "/users") {
        await loadUsers();
        if (users.length > 0) {
          const selectedStillExists = users.some((user) => user.id === selectedUserId);
          if (!selectedStillExists) {
            selectedUserId = users[0].id;
            localStorage.setItem(SELECTED_USER_STORAGE_KEY, selectedUserId);
            localStorage.removeItem(SELECTED_EMAIL_STORAGE_KEY);
          }
        } else {
          selectedUserId = "";
          detailEmailId = "";
          localStorage.removeItem(SELECTED_USER_STORAGE_KEY);
          localStorage.removeItem(SELECTED_EMAIL_STORAGE_KEY);
        }
        detailEmailId = "";
        detailEmail = null;
      } else if (currentPath === "/inbox") {
        if (!selectedUserId) {
          currentPath = "/users";
          localStorage.setItem(INTERNAL_PATH_STORAGE_KEY, currentPath);
          localStorage.removeItem(SELECTED_USER_STORAGE_KEY);
          localStorage.removeItem(SELECTED_EMAIL_STORAGE_KEY);
          await loadUsers();
          return;
        }
        await loadUsers();
        await loadInboxForSelectedUser();
      } else if (currentPath === "/email-detail") {
        if (!selectedUserId) {
          currentPath = "/users";
          localStorage.setItem(INTERNAL_PATH_STORAGE_KEY, currentPath);
          localStorage.removeItem(SELECTED_USER_STORAGE_KEY);
          localStorage.removeItem(SELECTED_EMAIL_STORAGE_KEY);
          await loadUsers();
          return;
        }
        await loadUsers();
        await loadInboxForSelectedUser();
        if (!detailEmailId) {
          currentPath = "/inbox";
          localStorage.setItem(INTERNAL_PATH_STORAGE_KEY, currentPath);
          localStorage.removeItem(SELECTED_EMAIL_STORAGE_KEY);
          return;
        }
        await loadEmailDetail();
      } else if (currentPath === "/settings") {
        await loadSettings();
      }
    } catch (error) {
      errorText = error instanceof Error ? error.message : "Unexpected error";
    } finally {
      loading = false;
    }
  }

  async function patchStatus(emailId: string, action: string): Promise<void> {
    feedbackText = "";
    errorText = "";
    try {
      await api<{ ok: boolean }>(`/api/emails/${emailId}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          action,
          actor: "pwa-admin"
        })
      });
      if (currentPath === "/users" || currentPath === "/inbox" || currentPath === "/email-detail") {
        await loadInboxForSelectedUser();
        if (currentPath === "/email-detail") {
          await loadEmailDetail();
        }
      } else if (currentPath === "/") {
        await loadDashboard();
      } else if (currentPath === "/settings") {
        await loadSettings();
      }
      feedbackText = `Action "${action}" berhasil untuk ${emailId}.`;
    } catch (error) {
      errorText = error instanceof Error ? error.message : "Failed to update status";
    }
  }

  async function refreshInboxList(): Promise<void> {
    if (!selectedUserId || refreshingInbox) return;
    refreshingInbox = true;
    errorText = "";
    feedbackText = "";
    try {
      await Promise.race([
        (async () => {
          await loadUsers();
          await loadInboxForSelectedUser();
        })(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Refresh timeout. Coba lagi.")), 12000);
        })
      ]);
      feedbackText = "Inbox berhasil di-refresh.";
      setTimeout(() => {
        if (feedbackText === "Inbox berhasil di-refresh.") {
          feedbackText = "";
        }
      }, 1400);
    } catch (error) {
      errorText = error instanceof Error ? error.message : "Failed to refresh inbox";
    } finally {
      refreshingInbox = false;
    }
  }

  onMount(() => {
    allowMockMode = detectAllowMockMode();
    if (allowMockMode) {
      mockMode = isMockModePreferredByDefault();
    }
    initializeInternalPath();
    initializeMockMode();
    void loadCurrentView();
  });

  $: filteredInbox = inbox.filter((email) => emailMatchesQuery(email, inboxSearchQuery));
  $: filteredUsers = sortUsers(users.filter((user) => userMatchesQuery(user, userSearchQuery)));
  $: addUserDomain = resolveInboundDomain();
</script>

<main class="shell">
  <section class="topbar" class:usersTopbar={currentPath === "/users"}>
    {#if currentPath === "/inbox"}
      <div class="brand brand-block mail-header">
        <div class="mail-header-row">
          <span class="material-symbols-outlined brand-cloud-icon" aria-hidden="true">cloud</span>
          <strong>MailFlare Mails User : {selectedUserLabel()}</strong>
          <span class="mail-header-separator" aria-hidden="true">|</span>
          <button class="topbar-inline-back" on:click={() => navigate("/users")}>Back to User List</button>
        </div>
      </div>
    {:else if currentPath === "/email-detail"}
      <div class="brand brand-block readmail-header">
        <div class="readmail-header-row">
          <span class="material-symbols-outlined brand-cloud-icon" aria-hidden="true">cloud</span>
          <span class="readmail-brand">MailFlare</span>
          <span class="userlist-separator" aria-hidden="true">|</span>
          <strong class="readmail-user">Read Mail User: {selectedUserLabel()}</strong>
        </div>
      </div>
    {:else if currentPath === "/users"}
      <div class="brand brand-block userlist-header">
        <div class="userlist-title-row">
          <span class="material-symbols-outlined brand-cloud-icon" aria-hidden="true">cloud</span>
          <strong>MailFlare User List</strong>
          <span class="userlist-separator" aria-hidden="true">|</span>
          <button
            class="user-add-btn"
            type="button"
            on:click={openAddUserModal}
            title="Add User"
          >
            <span>Add user</span>
            <span aria-hidden="true">+</span>
          </button>
        </div>
      </div>
    {:else if currentPath === "/"}
      <div class="brand brand-block dashboard-header">
        <div class="dashboard-title-row">
          <span class="material-symbols-outlined brand-cloud-icon" aria-hidden="true">cloud</span>
          <strong>MailFlare Dashboard</strong>
          <span class="userlist-separator" aria-hidden="true">|</span>
        </div>
      </div>
    {:else if currentPath === "/settings"}
      <div class="brand brand-block dashboard-header">
        <div class="dashboard-title-row">
          <span class="material-symbols-outlined brand-cloud-icon" aria-hidden="true">cloud</span>
          <strong>MailFlare Settings</strong>
          <span class="userlist-separator" aria-hidden="true">|</span>
        </div>
      </div>
    {:else}
      <div class="brand brand-block brand-default">
        <span class="material-symbols-outlined brand-cloud-icon brand-cloud-icon-lg" aria-hidden="true">cloud</span>
        <div>
          <strong>MailFlare Worker Console</strong>
          <p class="muted topbar-caption">Single-URL PWA flow</p>
        </div>
      </div>
    {/if}
    <nav class="nav nav-desktop" aria-label="Views">
      {#each navItems as item}
        <button
          class:active={isNavActive(item.path)}
          on:click={() => navigate(item.path)}
        >
          {item.label}
        </button>
      {/each}
    </nav>
    {#if allowMockMode}
      <div class="mock-control">
        <span class="muted">Data: {mockMode ? "Mock" : "Live"}</span>
        <button on:click={() => setMockMode(!mockMode)}>
          Switch to {mockMode ? "Live" : "Mock"}
        </button>
      </div>
    {/if}
  </section>

  {#if loading}
    <p class="muted">Loading...</p>
  {/if}
  {#if errorText}
    <p class="muted">{errorText}</p>
  {/if}
  {#if feedbackText}
    <p class="muted">{feedbackText}</p>
  {/if}

  {#if currentPath === "/"}
    <section class="grid dashboard-grid section-shell">
      <article class="card dashboard-card dashboard-card-users">
        <div class="dashboard-card-head">
          <p class="label">Total Users</p>
          <span class="material-symbols-outlined dashboard-icon">group</span>
        </div>
        <p class="value">{stats?.totalUsers ?? 0}</p>
      </article>
      <article class="card dashboard-card dashboard-card-total">
        <div class="dashboard-card-head">
          <p class="label">Total Emails</p>
          <span class="material-symbols-outlined dashboard-icon">mail</span>
        </div>
        <p class="value">{stats?.totalEmails ?? 0}</p>
      </article>
      <article class="card dashboard-card dashboard-card-unread">
        <div class="dashboard-card-head">
          <p class="label">Unread Emails</p>
          <span class="material-symbols-outlined dashboard-icon">mark_email_unread</span>
        </div>
        <p class="value">{stats?.unreadEmails ?? 0}</p>
      </article>
      <article class="card dashboard-card dashboard-card-starred">
        <div class="dashboard-card-head">
          <p class="label">Starred Emails</p>
          <span class="material-symbols-outlined dashboard-icon dashboard-icon-fill">star</span>
        </div>
        <p class="value">{stats?.starredEmails ?? 0}</p>
      </article>
      <article class="card dashboard-card dashboard-card-archived">
        <div class="dashboard-card-head">
          <p class="label">Archived Emails</p>
          <span class="material-symbols-outlined dashboard-icon">archive</span>
        </div>
        <p class="value">{stats?.archivedEmails ?? 0}</p>
      </article>
      <article class="card dashboard-card dashboard-card-deleted">
        <div class="dashboard-card-head">
          <p class="label">Deleted Emails</p>
          <span class="material-symbols-outlined dashboard-icon">delete</span>
        </div>
        <p class="value">{stats?.deletedEmails ?? 0}</p>
      </article>
    </section>
  {/if}

  {#if currentPath === "/users"}
    <section class="userlist-controls section-shell">
      <form class="userlist-toolbar" on:submit|preventDefault>
        <input
          class="userlist-search-input"
          type="search"
          placeholder="Search user"
          bind:value={userSearchQuery}
        />
        <label class="userlist-filter">
          <span>Filter</span>
          <select bind:value={userSortMode}>
            <option value="az">A-Z</option>
            <option value="created">Date created</option>
          </select>
        </label>
      </form>
    </section>
    <section class="list section-shell">
      {#if users.length === 0}
        <article class="empty">Belum ada user.</article>
      {:else if filteredUsers.length === 0}
        <article class="empty">Tidak ada user yang cocok dengan pencarian.</article>
      {:else}
        {#each filteredUsers as user}
          <button class="row row-button user-row" on:click={() => selectUser(user.id, true)}>
            <div class="user-main">
              <strong>{user.displayName ?? user.email}</strong>
              <p class="muted">{user.email}</p>
            </div>
            <div class="user-meta">
              <span class="pill">{user.unreadCount} unread</span>
              <span class="muted">{user.totalCount} total</span>
            </div>
          </button>
        {/each}
      {/if}
    </section>
  {/if}

  {#if currentPath === "/inbox"}
    <section class="inbox-search-wrap section-shell">
      <form class="inbox-search-form" on:submit|preventDefault>
        <input
          class="inbox-search-input"
          type="search"
          placeholder="Telusuri dalam email"
          bind:value={inboxSearchQuery}
        />
        <button
          class="inbox-refresh-btn"
          type="button"
          disabled={refreshingInbox || !selectedUserId}
          on:click={refreshInboxList}
        >
          {refreshingInbox ? "Refreshing..." : "Refresh"}
        </button>
      </form>
    </section>
    <section class="list section-shell">
      {#if inbox.length === 0}
        <article class="empty">Inbox user kosong.</article>
      {:else if filteredInbox.length === 0}
        <article class="empty">Tidak ada email yang cocok dengan pencarian.</article>
      {:else}
        {#each filteredInbox as email}
          <article
            class="row inbox-mail-row"
            class:unread={!email.isRead}
            class:selected={email.id === detailEmailId}
          >
            <button class="inbox-open" on:click={() => selectEmail(email.id, true)}>
              <span class="inbox-avatar">{senderInitial(email.sender)}</span>
              <div class="inbox-content">
                <div class="inbox-meta-row">
                  <span class="inbox-from" title={email.sender}>{senderDisplayName(email.sender)}</span>
                  <span class="inbox-date">{toShortDate(email.receivedAt)}</span>
                  <span class="inbox-subject-text">{email.subject ?? "(No Subject)"}</span>
                </div>
                <p class="muted inbox-preview">{email.snippet ?? "-"}</p>
              </div>
            </button>
            <div class="inbox-actions">
              <button
                class="inbox-icon-btn inbox-icon-star"
                class:active={email.isStarred}
                title={email.isStarred ? "Unstar" : "Star"}
                on:click={() => patchStatus(email.id, email.isStarred ? "unstar" : "star")}
              >
                {email.isStarred ? "★" : "☆"}
              </button>
              <button
                class="inbox-icon-btn inbox-icon-archive"
                class:active={email.isArchived}
                title="Archive"
                on:click={() => patchStatus(email.id, "archive")}
              >
                {email.isArchived ? "🗂" : "🗄"}
              </button>
            </div>
          </article>
        {/each}
      {/if}
    </section>
  {/if}

  {#if currentPath === "/email-detail"}
    <section class="gmail-read section-shell">
      <header class="gmail-read-head">
        <button class="page-head-back" on:click={() => navigate("/inbox")}>Back to Inbox</button>
        {#if detailEmail}
          <div class="gmail-head-actions">
            <button class="gmail-head-icon" title="Mark as Read" on:click={() => patchStatus(detailEmail.id, "read")}>✓</button>
            <button class="gmail-head-icon" title="Mark as Unread" on:click={() => patchStatus(detailEmail.id, "unread")}>✉</button>
            <button class="gmail-head-icon" title={detailEmail.isStarred ? "Unstar" : "Star"} on:click={() => patchStatus(detailEmail.id, detailEmail.isStarred ? "unstar" : "star")}>
              {detailEmail.isStarred ? "★" : "☆"}
            </button>
            <button class="gmail-head-icon" title="Archive" on:click={() => patchStatus(detailEmail.id, "archive")}>🗂</button>
            <button class="gmail-head-icon danger" title="Soft Delete" on:click={() => patchStatus(detailEmail.id, "delete")}>🗑</button>
          </div>
        {/if}
      </header>

      {#if detailEmail}
        <article class="gmail-read-card">
          <div class="gmail-subject-row">
            <h2 class="gmail-subject">{detailEmail.subject ?? "(No Subject)"}</h2>
            <span class="gmail-id-chip" title={detailEmail.id}>#{detailEmail.id.slice(0, 8)}</span>
          </div>

          <div class="gmail-meta-row">
            <span class="gmail-avatar">{senderInitial(detailEmail.sender)}</span>
            <div class="gmail-meta-main">
              <p class="gmail-from-line">
                <strong>{senderDisplayName(detailEmail.sender)}</strong>
                {#if senderEmail(detailEmail.sender)}
                  <span class="muted">&lt;{senderEmail(detailEmail.sender)}&gt;</span>
                {/if}
              </p>
              <p class="gmail-to-line">to {detailEmail.recipient}</p>
            </div>
            <time class="gmail-time">{toLocalTime(detailEmail.receivedAt)}</time>
          </div>

          <div class="gmail-body">
            <p>{detailEmail.snippet ?? "-"}</p>
            <p class="muted">
              Full MIME body renderer belum diaktifkan di v1, jadi tampilan saat ini memakai snippet email untuk preview konten.
            </p>
          </div>

          <div class="gmail-reply-row">
            <button class="gmail-reply-btn" disabled title="Reply disabled in v1">Reply (v1 off)</button>
            <button class="gmail-reply-btn" disabled title="Reply All disabled in v1">Reply All (v1 off)</button>
            <button class="gmail-reply-btn" disabled title="Forward disabled in v1">Forward (v1 off)</button>
          </div>
        </article>
      {:else}
        <article class="empty">Pilih email dari inbox dulu.</article>
      {/if}
    </section>
  {/if}

  {#if currentPath === "/settings"}
    <section class="settings-view section-shell">
      <div class="settings-headline-row">
        <div>
          <h2 class="settings-title">System Performance</h2>
          <p class="settings-subtitle">Real-time ledger of your MailFlare infrastructure.</p>
        </div>
        <span class="settings-chip" class:mock={mockMode}>
          {mockMode
            ? "Mock Status"
            : runtimeSettings?.privateGatewayEnabled
              ? "Private Gateway Enabled"
              : "Private Gateway Disabled"}
        </span>
      </div>

      <div class="settings-ledger-grid">
        <article class="settings-ledger-card accent-primary">
          <span class="settings-ledger-icon">TR</span>
          <div>
            <p class="settings-ledger-value">{formatCompact(stats?.totalEmails ?? 0)}</p>
            <p class="settings-ledger-label">Total Emails Processed</p>
          </div>
        </article>
        <article class="settings-ledger-card accent-ok">
          <span class="settings-ledger-icon">TG</span>
          <div>
            <p class="settings-ledger-value">
              {runtimeSettings?.telegramAllowedIdsCount ?? 0}
            </p>
            <p class="settings-ledger-label">Telegram Allowed IDs</p>
          </div>
        </article>
        <article class="settings-ledger-card accent-warm">
          <span class="settings-ledger-icon">IN</span>
          <div>
            <p class="settings-ledger-value">
              {formatCompact(runtimeSettings?.metrics?.inbound_email_count ?? 0)}
            </p>
            <p class="settings-ledger-label">Inbound Emails</p>
          </div>
        </article>
      </div>

      <div class="settings-config-grid">
        <article class="settings-panel">
          <div class="settings-panel-head">
            <div class="settings-panel-icon">TG</div>
            <div>
              <h3>Telegram Bot Config</h3>
              <p>Forward inbound email + test delivery target.</p>
            </div>
          </div>
          <div class="settings-field-stack">
            <label class="settings-field">
              <span>Bot Status</span>
              <input
                type="text"
                value={runtimeSettings?.telegramConfigured ? "Configured" : "Not configured"}
                readonly
              />
            </label>
            <label class="settings-field">
              <span>Allowed IDs (ENV)</span>
              <input
                type="text"
                value={runtimeSettings?.telegramAllowedIds?.join(", ") || "-"}
                readonly
              />
            </label>
            <label class="settings-field">
              <span>Forward Inbound Email</span>
              <select bind:value={settingsTelegramForwardState}>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <label class="settings-field">
              <span>Forward Target Mode</span>
              <select bind:value={settingsTelegramForwardMode}>
                <option value="all_allowed">All Allowed IDs</option>
                <option value="specific">Specific Chat ID</option>
              </select>
            </label>
            {#if settingsTelegramForwardMode === "specific"}
              <label class="settings-field">
                <span>Forward Chat ID (Specific)</span>
                <input
                  type="text"
                  bind:value={settingsTelegramForwardChatId}
                  placeholder="Contoh: 123456789"
                />
              </label>
            {/if}
            <label class="settings-field">
              <span>Default Chat ID (Fallback)</span>
              <input
                type="text"
                bind:value={settingsDefaultTelegramChatId}
                placeholder="Dipakai saat specific mode tanpa override"
              />
            </label>
            <label class="settings-field">
              <span>Test Chat ID (Override sekali kirim)</span>
              <input
                type="text"
                bind:value={telegramChatId}
                placeholder="Kosongkan untuk pakai target tersimpan"
              />
            </label>
            <div class="settings-row-actions">
              <button
                class="settings-button muted"
                type="button"
                disabled={savingSettingsProfile}
                on:click={() => void saveSettingsProfile()}
              >
                {savingSettingsProfile ? "Saving..." : "Save Telegram Config"}
              </button>
              <button
                class="settings-button primary"
                type="button"
                disabled={testingTelegramConnection}
                on:click={() => void testTelegramConnection()}
              >
                {testingTelegramConnection ? "Testing..." : "Test Connection"}
              </button>
            </div>
          </div>
        </article>

        <article class="settings-panel">
          <div class="settings-panel-head">
            <div class="settings-panel-icon">CF</div>
            <div>
              <h3>Telegram Webhook Status</h3>
              <p>Lihat status webhook langsung dari Telegram API.</p>
            </div>
          </div>
          <div class="settings-field-stack">
            <label class="settings-field">
              <span>Webhook Secret</span>
              <input
                type="text"
                value={runtimeSettings?.webhookSecretConfigured ? "Configured" : "Not configured"}
                readonly
              />
            </label>
            <label class="settings-field">
              <span>Webhook URL</span>
              <input type="text" value={telegramWebhookStatus?.url ?? "-"} readonly />
            </label>
            <label class="settings-field">
              <span>Pending Updates</span>
              <input type="text" value={String(telegramWebhookStatus?.pending_update_count ?? "-")} readonly />
            </label>
            <label class="settings-field">
              <span>Last Error</span>
              <input
                type="text"
                value={telegramWebhookStatus?.last_error_message ?? "-"}
                readonly
              />
            </label>
            <label class="settings-field">
              <span>Last Error Date</span>
              <input type="text" value={unixSecondsToLocal(telegramWebhookStatus?.last_error_date)} readonly />
            </label>
            <label class="settings-field">
              <span>Private Gateway</span>
              <input
                type="text"
                value={runtimeSettings?.privateGatewayEnabled ? "Enabled" : "Disabled"}
                readonly
              />
            </label>
            <div class="settings-row-actions">
              <button
                class="settings-button muted"
                type="button"
                disabled={loadingWebhookStatus}
                on:click={() => void refreshTelegramWebhookStatus()}
              >
                {loadingWebhookStatus ? "Checking..." : "Check Webhook Status"}
              </button>
              <button class="settings-button muted" type="button" on:click={() => void loadSettings()}>
                Refresh Runtime
              </button>
            </div>
          </div>
        </article>
      </div>

      <aside class="settings-note">
        <strong>Worker Health:</strong> {health?.status ?? "unknown"} - {health ? toLocalTime(health.timestamp) : "-"}
        <br />
        Changes are applied instantly across workers. Use specific mode to target one chat ID, or all-allowed mode for broadcast alerts.
        <br />
        <strong>Profile Updated:</strong> {settingsUpdatedAt ? toLocalTime(settingsUpdatedAt) : "-"}
      </aside>
      <aside class="settings-note subtle">
        Telegram reply is intentionally disabled in v1 and delete mode remains soft-delete for audit/recovery.
      </aside>
    </section>
  {/if}
</main>

{#if showAddUserModal}
  <div class="modal-backdrop" role="presentation" on:click={handleAddUserBackdropClick}>
    <div
      class="modal-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-user-title"
    >
      <header class="modal-head">
        <h3 id="add-user-title">Add User</h3>
        <button class="modal-close" type="button" on:click={closeAddUserModal} aria-label="Close">✕</button>
      </header>
      <form class="modal-form" on:submit|preventDefault={() => void submitAddUser()}>
        <label class="settings-field">
          <span>Username atau Email</span>
          <input
            type="text"
            bind:value={newUserEmail}
            placeholder={`contoh: alex${addUserDomain ? ` (otomatis jadi alex@${addUserDomain})` : " atau email lengkap"}`}
            required
            autocomplete="off"
          />
          {#if newUserEmail.trim()}
            <small class="muted">Akan disimpan sebagai: {normalizeUserEmail(newUserEmail)}</small>
          {/if}
        </label>
        <label class="settings-field">
          <span>Display Name (Opsional)</span>
          <input
            type="text"
            bind:value={newUserDisplayName}
            placeholder="contoh: Alex"
            autocomplete="off"
          />
        </label>
        <div class="modal-actions">
          <button class="settings-button muted" type="button" on:click={closeAddUserModal} disabled={creatingUser}>
            Cancel
          </button>
          <button class="settings-button primary" type="submit" disabled={creatingUser}>
            {creatingUser ? "Adding..." : "Add User"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<nav class="bottom-nav" aria-label="Primary">
  {#each navItems as item}
    <button
      class="bottom-nav-item"
      class:active={isNavActive(item.path)}
      on:click={() => navigate(item.path)}
    >
      <span class="material-symbols-outlined bottom-nav-icon" aria-hidden="true">{item.icon}</span>
      <span class="bottom-nav-label">{item.mobileLabel}</span>
    </button>
  {/each}
</nav>


