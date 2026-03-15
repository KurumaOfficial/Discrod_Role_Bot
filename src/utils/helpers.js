import crypto from 'node:crypto';

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function uniqueIds(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

export function normalizeRoleName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function createId(prefix = 'id') {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function displayUserTag(user) {
  if (!user) {
    return 'Unknown user';
  }

  if (user.discriminator && user.discriminator !== '0') {
    return `${user.username}#${user.discriminator}`;
  }

  return user.username;
}

export function displaySnapshotMember(member) {
  return member.displayName || member.globalName || member.nickname || member.username || member.userId;
}

export function compareRolesByPositionDesc(leftRole, rightRole) {
  return rightRole.position - leftRole.position || leftRole.name.localeCompare(rightRole.name, 'ru');
}

export function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

export function sanitizeReason(reason, fallback) {
  const cleanReason = String(reason ?? '').trim();
  return (cleanReason || fallback).slice(0, 512);
}
