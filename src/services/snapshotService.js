import { captureGuildSnapshot } from './discordService.js';
import { loadSnapshot, saveSnapshot, updateState } from './storage.js';

import { compareRolesByPositionDesc, createId } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

function normalizeRole(rawRole) {
  if (!rawRole?.id || !rawRole?.name) {
    throw new Error('Snapshot role is missing id or name.');
  }

  return {
    id: String(rawRole.id),
    name: String(rawRole.name),
    position: Number(rawRole.position ?? 0),
    managed: Boolean(rawRole.managed),
    mentionable: Boolean(rawRole.mentionable),
    hoist: Boolean(rawRole.hoist),
    color: String(rawRole.color ?? '#000000'),
    permissions: Array.isArray(rawRole.permissions) ? rawRole.permissions.map(String) : []
  };
}

function normalizeMember(rawMember, index) {
  const userId = rawMember?.userId ?? rawMember?.id;

  if (!userId) {
    throw new Error(`Snapshot member #${index + 1} is missing userId.`);
  }

  const roleIds = rawMember.roleIds ?? rawMember.roles?.map((role) => role.id ?? role) ?? [];

  return {
    userId: String(userId),
    username: String(rawMember.username ?? rawMember.tag ?? `member-${index + 1}`),
    tag: String(rawMember.tag ?? rawMember.username ?? `member-${index + 1}`),
    globalName: String(rawMember.globalName ?? ''),
    nickname: String(rawMember.nickname ?? ''),
    displayName: String(rawMember.displayName ?? rawMember.globalName ?? rawMember.nickname ?? rawMember.username ?? userId),
    isBot: Boolean(rawMember.isBot ?? rawMember.bot),
    roleIds: [...new Set(roleIds.map((roleId) => String(roleId)).filter(Boolean))]
  };
}

function normalizeImportedSnapshot(rawSnapshot, originalName) {
  if (!rawSnapshot || typeof rawSnapshot !== 'object') {
    throw new Error('Uploaded snapshot is not a valid JSON object.');
  }

  if (!Array.isArray(rawSnapshot.roles) || !Array.isArray(rawSnapshot.members)) {
    throw new Error('Snapshot must contain roles[] and members[].');
  }

  const normalizedRoles = rawSnapshot.roles
    .map(normalizeRole)
    .sort(compareRolesByPositionDesc);

  const normalizedMembers = rawSnapshot.members
    .map(normalizeMember)
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'ru'));

  return {
    id: createId('imported-snapshot'),
    version: 1,
    source: 'Kuruma Role Restorer',
    createdAt: String(rawSnapshot.createdAt ?? new Date().toISOString()),
    importedAt: new Date().toISOString(),
    importedFrom: originalName ?? 'manual-upload.json',
    guild: {
      id: String(rawSnapshot.guild?.id ?? rawSnapshot.guildId ?? 'unknown-guild'),
      name: String(rawSnapshot.guild?.name ?? rawSnapshot.guildName ?? 'Imported guild')
    },
    stats: {
      memberCount: normalizedMembers.length,
      roleCount: normalizedRoles.length
    },
    roles: normalizedRoles,
    members: normalizedMembers
  };
}

function countRoleUsage(snapshot) {
  const usageMap = new Map();

  for (const member of snapshot.members) {
    for (const roleId of member.roleIds) {
      usageMap.set(roleId, (usageMap.get(roleId) ?? 0) + 1);
    }
  }

  return usageMap;
}

export function getRestorableSnapshotRoles(snapshot) {
  return (snapshot?.roles ?? [])
    .filter((role) => !role.managed && role.name !== '@everyone')
    .sort(compareRolesByPositionDesc);
}

export function buildSnapshotView(snapshot, mappings = {}) {
  const roleUsage = countRoleUsage(snapshot);
  const restorableRoles = getRestorableSnapshotRoles(snapshot);
  const ignoredManagedRoles = (snapshot.roles ?? [])
    .filter((role) => role.managed)
    .sort(compareRolesByPositionDesc);

  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    importedAt: snapshot.importedAt ?? null,
    importedFrom: snapshot.importedFrom ?? null,
    guild: snapshot.guild,
    stats: snapshot.stats ?? {
      memberCount: snapshot.members?.length ?? 0,
      roleCount: snapshot.roles?.length ?? 0
    },
    mappingStats: {
      mappedRoles: restorableRoles.filter((role) => Boolean(mappings[role.id])).length,
      totalRestorableRoles: restorableRoles.length
    },
    restorableRoles: restorableRoles.map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      mappedRoleId: mappings[role.id] ?? '',
      memberCount: roleUsage.get(role.id) ?? 0
    })),
    ignoredManagedRoles: ignoredManagedRoles.map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      memberCount: roleUsage.get(role.id) ?? 0
    }))
  };
}

export async function captureAndStoreSnapshot(guildId) {
  const snapshot = await captureGuildSnapshot(guildId);
  await saveSnapshot(snapshot);

  await updateState((state) => {
    state.selectedGuildId = snapshot.guild.id;
    state.selectedSnapshotId = snapshot.id;
    state.mappingsBySnapshotId[snapshot.id] ??= {};
    return state;
  });

  logger.info(`Captured snapshot ${snapshot.id} for guild ${snapshot.guild.name}`);
  return snapshot;
}

export async function importSnapshotBuffer(buffer, originalName) {
  const rawSnapshot = JSON.parse(buffer.toString('utf8'));
  const snapshot = normalizeImportedSnapshot(rawSnapshot, originalName);
  await saveSnapshot(snapshot);

  await updateState((state) => {
    state.selectedSnapshotId = snapshot.id;
    state.mappingsBySnapshotId[snapshot.id] ??= {};
    return state;
  });

  logger.info(`Imported snapshot ${snapshot.id} from ${snapshot.importedFrom}`);
  return snapshot;
}

export async function selectSnapshot(snapshotId) {
  const snapshot = await loadSnapshot(snapshotId);

  if (!snapshot) {
    throw new Error('Snapshot not found.');
  }

  await updateState((state) => {
    state.selectedSnapshotId = snapshot.id;
    state.mappingsBySnapshotId[snapshot.id] ??= {};
    return state;
  });

  return snapshot;
}
