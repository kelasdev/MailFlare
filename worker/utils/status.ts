import type { EmailState, EmailStatusAction } from "../types";

export function serializeState(state: EmailState): string {
  return JSON.stringify(state);
}

export function applyStatusAction(state: EmailState, action: EmailStatusAction): EmailState {
  if (action === "read") {
    return { ...state, isRead: true };
  }
  if (action === "unread") {
    return { ...state, isRead: false };
  }
  if (action === "star") {
    return { ...state, isStarred: true };
  }
  if (action === "unstar") {
    return { ...state, isStarred: false };
  }
  if (action === "archive") {
    return { ...state, isArchived: true };
  }
  if (action === "delete") {
    return { ...state, deletedAt: new Date().toISOString() };
  }
  return state;
}
