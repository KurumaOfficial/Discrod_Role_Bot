import { config } from '../config.js';
import { fetchGuildContext, getGuildDashboard } from './discordService.js';
import { loadSnapshot, readState, saveReport, updateState } from './storage.js';
import { getRestorableSnapshotRoles } from './snapshotService.js';

import {
  clampInteger,
  compareRolesByPositionDesc,
  createId,
  displaySnapshotMember,
  normalizeRoleName,
  sanitizeReason,
  sleep,
  uniqueIds
} from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

let currentJob = null;

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function resolveRestoreOptions(rawOptions = {}) {
  return {
    delayMs: clampInteger(rawOptions.delayMs, 100, 5000, config.defaultRestoreDelayMs),
    dryRun: toBoolean(rawOptions.dryRun, false),
    preserveExtraManageableRoles: toBoolean(rawOptions.preserveExtraManageableRoles, false),
    skipBotAccounts: toBoolean(rawOptions.skipBotAccounts, config.skipBotAccounts),
    reason: sanitizeReason(rawOptions.reason, config.defaultRestoreReason)
  };
}

function buildNameGroups(roles) {
  const groups = new Map();

  for (const role of roles) {
    const key = normalizeRoleName(role.name);
    groups.set(key, [...(groups.get(key) ?? []), role]);
  }

  return groups;
}

function buildRoleMaps(snapshot, guild) {
  return {
    snapshotRolesById: new Map((snapshot.roles ?? []).map((role) => [role.id, role])),
    liveRolesById: new Map([...guild.roles.cache.values()].map((role) => [role.id, role]))
  };
}

function appendJobLog(job, message) {
  job.logs.unshift(`[${new Date().toLocaleTimeString('ru-RU')}] ${message}`);
  job.logs = job.logs.slice(0, 40);
  job.updatedAt = new Date().toISOString();
}

function createSampleEntry(snapshotMember, details) {
  return {
    userId: snapshotMember.userId,
    member: displaySnapshotMember(snapshotMember),
    ...details
  };
}

function buildMemberPlan({
  guild,
  member,
  snapshotMember,
  snapshotRolesById,
  liveRolesById,
  mappings,
  options
}) {
  const currentRoles = [...member.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .sort(compareRolesByPositionDesc);

  const currentManageableRoles = currentRoles.filter((role) => !role.managed && role.editable);
  const currentProtectedRoles = currentRoles.filter((role) => role.managed || !role.editable);

  const unresolvedSnapshotRoles = [];
  const blockedTargetRoles = [];
  const desiredManageableRoles = [];

  for (const snapshotRoleId of snapshotMember.roleIds) {
    const snapshotRole = snapshotRolesById.get(snapshotRoleId);

    if (!snapshotRole || snapshotRole.managed || snapshotRole.name === '@everyone') {
      continue;
    }

    const mappedRoleId = mappings[snapshotRoleId];

    if (!mappedRoleId) {
      unresolvedSnapshotRoles.push(snapshotRole.name);
      continue;
    }

    const liveRole = liveRolesById.get(mappedRoleId);

    if (!liveRole) {
      blockedTargetRoles.push(`${snapshotRole.name} -> target role was not found`);
      continue;
    }

    if (liveRole.managed || liveRole.id === guild.id) {
      blockedTargetRoles.push(`${snapshotRole.name} -> target role is managed by Discord`);
      continue;
    }

    if (!liveRole.editable) {
      blockedTargetRoles.push(`${snapshotRole.name} -> target role is above the bot`);
      continue;
    }

    desiredManageableRoles.push(liveRole);
  }

  const desiredManageableRoleIds = uniqueIds(desiredManageableRoles.map((role) => role.id));
  const currentManageableRoleIds = currentManageableRoles.map((role) => role.id);
  const targetManageableRoleIds = options.preserveExtraManageableRoles
    ? uniqueIds([...currentManageableRoleIds, ...desiredManageableRoleIds])
    : desiredManageableRoleIds;

  const addRoles = targetManageableRoleIds
    .filter((roleId) => !currentManageableRoleIds.includes(roleId))
    .map((roleId) => liveRolesById.get(roleId))
    .filter(Boolean)
    .sort(compareRolesByPositionDesc)
    .reverse();

  const removeRoles = options.preserveExtraManageableRoles
    ? []
    : currentManageableRoles
      .filter((role) => !targetManageableRoleIds.includes(role.id))
      .sort(compareRolesByPositionDesc);

  const skipBecauseBot = options.skipBotAccounts && member.user.bot;
  const blockingReasons = [];

  if (skipBecauseBot) {
    blockingReasons.push('Bot accounts are skipped by configuration.');
  }

  if ((addRoles.length > 0 || removeRoles.length > 0) && !member.manageable) {
    blockingReasons.push('Member is above the bot role or is the server owner.');
  }

  if (unresolvedSnapshotRoles.length > 0) {
    blockingReasons.push('Not all snapshot roles are mapped.');
  }

  if (blockedTargetRoles.length > 0) {
    blockingReasons.push('One or more target roles cannot be assigned by the bot.');
  }

  return {
    memberId: member.id,
    memberLabel: displaySnapshotMember(snapshotMember),
    skipBecauseBot,
    hasChanges: addRoles.length > 0 || removeRoles.length > 0,
    canUseRoleSet: blockingReasons.length === 0 && currentProtectedRoles.length === 0,
    finalRoleIdsForSet: targetManageableRoleIds,
    addRoles,
    removeRoles,
    unresolvedSnapshotRoles,
    blockedTargetRoles,
    blockingReasons,
    protectedRoleNames: currentProtectedRoles.map((role) => role.name)
  };
}

async function withDiscordRetry(action, contextLabel) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const statusCode = Number(error?.status ?? error?.rawError?.status ?? 0);
      const retryable = statusCode >= 500 || ['ECONNRESET', 'ETIMEDOUT'].includes(error?.code);

      if (!retryable || attempt === 3) {
        break;
      }

      const delayMs = 800 * attempt;
      logger.warn(`Retrying ${contextLabel} in ${delayMs}ms`, error?.message ?? error);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function getSnapshotAndMappings(snapshotId) {
  const snapshot = await loadSnapshot(snapshotId);

  if (!snapshot) {
    throw new Error('Snapshot not found.');
  }

  const state = await readState();
  const mappings = state.mappingsBySnapshotId[snapshotId] ?? {};

  return { snapshot, mappings };
}

export async function getMappings(snapshotId) {
  const state = await readState();
  return state.mappingsBySnapshotId[snapshotId] ?? {};
}

export async function saveMappings(snapshotId, rawMappings) {
  const snapshot = await loadSnapshot(snapshotId);

  if (!snapshot) {
    throw new Error('Snapshot not found.');
  }

  const allowedRoleIds = new Set(getRestorableSnapshotRoles(snapshot).map((role) => role.id));
  const nextMappings = {};

  for (const [snapshotRoleId, liveRoleId] of Object.entries(rawMappings ?? {})) {
    if (!allowedRoleIds.has(snapshotRoleId)) {
      continue;
    }

    if (liveRoleId) {
      nextMappings[snapshotRoleId] = String(liveRoleId);
    }
  }

  await updateState((state) => {
    state.selectedSnapshotId = snapshotId;
    state.mappingsBySnapshotId[snapshotId] = nextMappings;
    return state;
  });

  return nextMappings;
}

export async function autoMatchMappings(guildId, snapshotId) {
  const snapshot = await loadSnapshot(snapshotId);

  if (!snapshot) {
    throw new Error('Snapshot not found.');
  }

  const liveDashboard = await getGuildDashboard(guildId);
  const state = await readState();
  const existingMappings = state.mappingsBySnapshotId[snapshotId] ?? {};
  const nextMappings = { ...existingMappings };

  const restorableSnapshotRoles = getRestorableSnapshotRoles(snapshot);
  const snapshotGroups = buildNameGroups(restorableSnapshotRoles);
  const liveGroups = buildNameGroups(liveDashboard.roles.filter((role) => !role.managed));

  for (const snapshotRole of restorableSnapshotRoles) {
    const snapshotGroup = snapshotGroups.get(normalizeRoleName(snapshotRole.name)) ?? [];
    const liveGroup = liveGroups.get(normalizeRoleName(snapshotRole.name)) ?? [];

    if (snapshotGroup.length === 1 && liveGroup.length === 1) {
      nextMappings[snapshotRole.id] = liveGroup[0].id;
    }
  }

  return saveMappings(snapshotId, nextMappings);
}

export async function buildRestorePreview(guildId, snapshotId, rawOptions = {}) {
  const options = resolveRestoreOptions(rawOptions);
  const { snapshot, mappings } = await getSnapshotAndMappings(snapshotId);
  const { guild, members } = await fetchGuildContext(guildId, { withMembers: true });
  const { snapshotRolesById, liveRolesById } = buildRoleMaps(snapshot, guild);
  const restorableRoles = getRestorableSnapshotRoles(snapshot);

  const preview = {
    generatedAt: new Date().toISOString(),
    guild: {
      id: guild.id,
      name: guild.name
    },
    snapshotId: snapshot.id,
    options,
    mappingStats: {
      mappedRoles: restorableRoles.filter((role) => Boolean(mappings[role.id])).length,
      totalRestorableRoles: restorableRoles.length,
      unmappedRoleNames: restorableRoles
        .filter((role) => !mappings[role.id])
        .map((role) => role.name)
    },
    stats: {
      totalSnapshotMembers: snapshot.members.length,
      missingMembers: 0,
      unchangedMembers: 0,
      blockedMembers: 0,
      changedMembers: 0,
      skippedBots: 0,
      totalAddOperations: 0,
      totalRemoveOperations: 0
    },
    samples: {
      missingMembers: [],
      blockedMembers: [],
      changedMembers: []
    }
  };

  for (const snapshotMember of snapshot.members) {
    const liveMember = members.get(snapshotMember.userId);

    if (!liveMember) {
      preview.stats.missingMembers += 1;

      if (preview.samples.missingMembers.length < 15) {
        preview.samples.missingMembers.push(createSampleEntry(snapshotMember, {
          reason: 'Member is not on the server anymore.'
        }));
      }

      continue;
    }

    const plan = buildMemberPlan({
      guild,
      member: liveMember,
      snapshotMember,
      snapshotRolesById,
      liveRolesById,
      mappings,
      options
    });

    if (plan.skipBecauseBot) {
      preview.stats.skippedBots += 1;
      continue;
    }

    if (plan.blockingReasons.length > 0) {
      preview.stats.blockedMembers += 1;

      if (preview.samples.blockedMembers.length < 20) {
        preview.samples.blockedMembers.push(createSampleEntry(snapshotMember, {
          reasons: plan.blockingReasons,
          unresolvedSnapshotRoles: plan.unresolvedSnapshotRoles,
          blockedTargetRoles: plan.blockedTargetRoles
        }));
      }

      continue;
    }

    if (plan.hasChanges) {
      preview.stats.changedMembers += 1;
      preview.stats.totalAddOperations += plan.addRoles.length;
      preview.stats.totalRemoveOperations += plan.removeRoles.length;

      if (preview.samples.changedMembers.length < 20) {
        preview.samples.changedMembers.push(createSampleEntry(snapshotMember, {
          addRoles: plan.addRoles.map((role) => role.name),
          removeRoles: plan.removeRoles.map((role) => role.name)
        }));
      }

      continue;
    }

    preview.stats.unchangedMembers += 1;
  }

  return preview;
}

export function getCurrentJob() {
  return currentJob;
}

export function cancelCurrentJob() {
  if (!currentJob || currentJob.status !== 'running') {
    return false;
  }

  currentJob.cancelRequested = true;
  appendJobLog(currentJob, 'Cancellation requested. Kuruma will stop after the current member.');
  return true;
}

export async function startRestoreJob(guildId, snapshotId, rawOptions = {}) {
  if (currentJob?.status === 'running') {
    throw new Error('Another restore job is already running.');
  }

  const options = resolveRestoreOptions(rawOptions);
  const { snapshot, mappings } = await getSnapshotAndMappings(snapshotId);
  const { guild, members } = await fetchGuildContext(guildId, { withMembers: true });
  const { snapshotRolesById, liveRolesById } = buildRoleMaps(snapshot, guild);

  const job = {
    id: createId('restore-job'),
    status: 'running',
    guildId: guild.id,
    guildName: guild.name,
    snapshotId: snapshot.id,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    updatedAt: new Date().toISOString(),
    cancelRequested: false,
    options,
    progress: {
      processedMembers: 0,
      totalMembers: snapshot.members.length,
      percent: 0
    },
    stats: {
      updatedMembers: 0,
      dryRunMembers: 0,
      noChangeMembers: 0,
      blockedMembers: 0,
      missingMembers: 0,
      failedMembers: 0,
      skippedBots: 0,
      apiWrites: 0
    },
    lastError: null,
    logs: []
  };

  currentJob = job;
  appendJobLog(job, `Restore job started for ${snapshot.members.length} snapshot members.`);

  (async () => {
    const reportEntries = [];

    try {
      for (const snapshotMember of snapshot.members) {
        if (job.cancelRequested) {
          job.status = 'cancelled';
          appendJobLog(job, 'Job cancelled by operator.');
          break;
        }

        const liveMember = members.get(snapshotMember.userId);

        if (!liveMember) {
          job.stats.missingMembers += 1;
          reportEntries.push(createSampleEntry(snapshotMember, {
            status: 'missing',
            reason: 'Member is no longer present on the server.'
          }));
          appendJobLog(job, `Missing member: ${displaySnapshotMember(snapshotMember)}`);
          job.progress.processedMembers += 1;
          job.progress.percent = Math.round((job.progress.processedMembers / job.progress.totalMembers) * 1000) / 10;
          continue;
        }

        const plan = buildMemberPlan({
          guild,
          member: liveMember,
          snapshotMember,
          snapshotRolesById,
          liveRolesById,
          mappings,
          options
        });

        if (plan.skipBecauseBot) {
          job.stats.skippedBots += 1;
          reportEntries.push(createSampleEntry(snapshotMember, {
            status: 'skipped-bot',
            reason: 'Skipped because bot accounts are excluded.'
          }));
          job.progress.processedMembers += 1;
          job.progress.percent = Math.round((job.progress.processedMembers / job.progress.totalMembers) * 1000) / 10;
          continue;
        }

        if (plan.blockingReasons.length > 0) {
          job.stats.blockedMembers += 1;
          reportEntries.push(createSampleEntry(snapshotMember, {
            status: 'blocked',
            reasons: plan.blockingReasons,
            unresolvedSnapshotRoles: plan.unresolvedSnapshotRoles,
            blockedTargetRoles: plan.blockedTargetRoles
          }));
          appendJobLog(job, `Blocked member: ${plan.memberLabel}`);
          job.progress.processedMembers += 1;
          job.progress.percent = Math.round((job.progress.processedMembers / job.progress.totalMembers) * 1000) / 10;
          continue;
        }

        if (!plan.hasChanges) {
          job.stats.noChangeMembers += 1;
          reportEntries.push(createSampleEntry(snapshotMember, {
            status: 'no-change'
          }));
          job.progress.processedMembers += 1;
          job.progress.percent = Math.round((job.progress.processedMembers / job.progress.totalMembers) * 1000) / 10;
          continue;
        }

        if (options.dryRun) {
          job.stats.dryRunMembers += 1;
          reportEntries.push(createSampleEntry(snapshotMember, {
            status: 'dry-run',
            addRoles: plan.addRoles.map((role) => role.name),
            removeRoles: plan.removeRoles.map((role) => role.name)
          }));
          appendJobLog(job, `Dry-run member: ${plan.memberLabel}`);
          job.progress.processedMembers += 1;
          job.progress.percent = Math.round((job.progress.processedMembers / job.progress.totalMembers) * 1000) / 10;
          continue;
        }

        try {
          if (plan.canUseRoleSet) {
            await withDiscordRetry(
              () => liveMember.roles.set(plan.finalRoleIdsForSet, options.reason),
              `roles.set for ${plan.memberLabel}`
            );
            job.stats.apiWrites += 1;
            await sleep(options.delayMs);
          } else {
            for (const role of plan.addRoles) {
              await withDiscordRetry(
                () => liveMember.roles.add(role.id, options.reason),
                `roles.add(${role.name}) for ${plan.memberLabel}`
              );
              job.stats.apiWrites += 1;
              await sleep(options.delayMs);
            }

            for (const role of plan.removeRoles) {
              await withDiscordRetry(
                () => liveMember.roles.remove(role.id, options.reason),
                `roles.remove(${role.name}) for ${plan.memberLabel}`
              );
              job.stats.apiWrites += 1;
              await sleep(options.delayMs);
            }
          }

          job.stats.updatedMembers += 1;
          reportEntries.push(createSampleEntry(snapshotMember, {
            status: 'updated',
            addRoles: plan.addRoles.map((role) => role.name),
            removeRoles: plan.removeRoles.map((role) => role.name)
          }));
          appendJobLog(job, `Updated member: ${plan.memberLabel}`);
        } catch (error) {
          job.stats.failedMembers += 1;
          job.lastError = error?.message ?? String(error);
          reportEntries.push(createSampleEntry(snapshotMember, {
            status: 'failed',
            error: job.lastError,
            addRoles: plan.addRoles.map((role) => role.name),
            removeRoles: plan.removeRoles.map((role) => role.name)
          }));
          appendJobLog(job, `Failed member: ${plan.memberLabel}`);
          logger.error(`Restore failed for ${plan.memberLabel}`, error);
        }

        job.progress.processedMembers += 1;
        job.progress.percent = Math.round((job.progress.processedMembers / job.progress.totalMembers) * 1000) / 10;
      }

      if (job.status === 'running') {
        job.status = options.dryRun ? 'dry-run-complete' : 'completed';
      }
    } catch (error) {
      job.status = 'failed';
      job.lastError = error?.message ?? String(error);
      appendJobLog(job, `Job crashed: ${job.lastError}`);
      logger.error('Restore job crashed', error);
    } finally {
      job.finishedAt = new Date().toISOString();
      job.updatedAt = new Date().toISOString();

      const report = {
        id: createId('restore-report'),
        createdAt: new Date().toISOString(),
        finishedAt: job.finishedAt,
        status: job.status,
        guildId: guild.id,
        guildName: guild.name,
        snapshotId: snapshot.id,
        options,
        stats: job.stats,
        entries: reportEntries
      };

      try {
        await saveReport(report);
        await updateState((state) => {
          state.selectedGuildId = guild.id;
          state.selectedSnapshotId = snapshot.id;
          state.lastReportId = report.id;
          return state;
        });

        job.reportId = report.id;
        appendJobLog(job, `Report saved: ${report.id}`);
      } catch (error) {
        job.lastError = error?.message ?? String(error);
        appendJobLog(job, `Failed to save report: ${job.lastError}`);
        logger.error('Failed to save restore report', error);
      }
    }
  })().catch((error) => {
    job.status = 'failed';
    job.lastError = error?.message ?? String(error);
    appendJobLog(job, `Unhandled restore failure: ${job.lastError}`);
    logger.error('Unhandled restore failure', error);
  });

  return job;
}
