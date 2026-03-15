import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PermissionFlagsBits } from 'discord.js';

import { logger } from './logger.js';

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function sanitizeFileSegment(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'item';
}

function normalizeError(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function dedupeRoles(roles) {
  const seenIds = new Set();
  const uniqueRoles = [];

  for (const role of roles) {
    if (!role || seenIds.has(role.id)) {
      continue;
    }

    seenIds.add(role.id);
    uniqueRoles.push(role);
  }

  return uniqueRoles;
}

function getMissingRoleIds(member, roles) {
  return roles.filter((role) => !member.roles.cache.has(role.id)).map((role) => role.id);
}

function getRateLimitRetryDelayMs(error) {
  const retryAfterSeconds = Number(
    error?.data?.retry_after ??
      error?.rawError?.retry_after ??
      error?.retry_after,
  );

  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return 0;
  }

  return Math.ceil(retryAfterSeconds * 1000) + 1000;
}

async function runWithInfiniteRateLimitRetry({ operation, contextLabel, guildId, memberId = null }) {
  let attempt = 1;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      const retryDelayMs = getRateLimitRetryDelayMs(error);

      if (retryDelayMs <= 0) {
        throw error;
      }

      const scope = memberId ? `guild ${guildId}, member ${memberId}` : `guild ${guildId}`;

      logger.warn(
        `${contextLabel} hit a rate limit for ${scope}. Retrying in ${retryDelayMs} ms (attempt ${attempt}).`,
      );
      await sleep(retryDelayMs);
      attempt += 1;
    }
  }
}

async function fetchAllMembersWithRetry(guild) {
  return runWithInfiniteRateLimitRetry({
    guildId: guild.id,
    contextLabel: 'Member scan',
    operation: () => guild.members.fetch(),
  });
}

export async function validateRoleTargets(guild, roles) {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const uniqueRoles = dedupeRoles(roles);

  if (!me) {
    return 'Bot member is not available in this guild yet. Try again in a few seconds.';
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'Bot is missing the Manage Roles permission.';
  }

  for (const role of uniqueRoles) {
    if (role.id === guild.id) {
      return 'The @everyone role cannot be granted manually.';
    }

    if (role.managed) {
      return `Managed or integration roles cannot be granted manually: ${role.name}.`;
    }

    if (!role.editable) {
      return `This role is above the bot role or otherwise not editable: ${role.name}.`;
    }
  }

  return null;
}

export async function buildGrantPreview({ guild, roles, includeBots }) {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const uniqueRoles = dedupeRoles(roles);

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('Bot is missing the Manage Roles permission.');
  }

  const members = await fetchAllMembersWithRetry(guild);
  const memberIds = [];
  const preview = {
    totalMembers: members.size,
    eligibleCount: 0,
    skippedBots: 0,
    skippedExisting: 0,
    skippedUnmanageable: 0,
  };

  for (const member of members.values()) {
    if (member.user.bot && !includeBots) {
      preview.skippedBots += 1;
      continue;
    }

    if (getMissingRoleIds(member, uniqueRoles).length === 0) {
      preview.skippedExisting += 1;
      continue;
    }

    if (!member.manageable) {
      preview.skippedUnmanageable += 1;
      continue;
    }

    memberIds.push(member.id);
    preview.eligibleCount += 1;
  }

  return {
    ...preview,
    memberIds,
  };
}

export async function startRoleGrantJob({
  client,
  guildId,
  roleIds,
  requestedBy,
  includeBots,
  reason,
  delayMs,
  jobStore,
  reportDirectory,
  preparedPreview = null,
  preparedMemberIds = null,
}) {
  if (jobStore.hasActiveJob()) {
    throw new Error('A role grant job is already running.');
  }

  const guild = await client.guilds.fetch(guildId).then((entry) => entry.fetch());
  const roles = [];

  for (const roleId of roleIds) {
    const role = await guild.roles.fetch(roleId);

    if (!role) {
      throw new Error(`Role not found: ${roleId}`);
    }

    roles.push(role);
  }

  const uniqueRoles = dedupeRoles(roles);
  const validationError = await validateRoleTargets(guild, uniqueRoles);

  if (validationError) {
    throw new Error(validationError);
  }

  const preview =
    preparedPreview && Array.isArray(preparedMemberIds)
      ? {
          ...preparedPreview,
          memberIds: preparedMemberIds,
        }
      : await buildGrantPreview({ guild, roles: uniqueRoles, includeBots });
  const job = jobStore.startJob({
    guild,
    roles: uniqueRoles,
    requestedBy,
    includeBots,
    reason,
    delayMs,
    preview,
  });

  void runRoleGrantJob({
    guild,
    roles: uniqueRoles,
    memberIds: preview.memberIds,
    reason,
    delayMs,
    jobStore,
    reportDirectory,
  });

  return {
    job,
    preview,
  };
}

async function runRoleGrantJob({ guild, roles, memberIds, reason, delayMs, jobStore, reportDirectory }) {
  logger.info(
    `Starting Kuruma bulk role grant for ${memberIds.length} members and ${roles.length} roles in guild ${guild.id}.`,
  );

  try {
    for (const memberId of memberIds) {
      const member =
        guild.members.cache.get(memberId) ??
        (await runWithInfiniteRateLimitRetry({
          guildId: guild.id,
          memberId,
          contextLabel: 'Member fetch',
          operation: () => guild.members.fetch(memberId),
        }).catch(() => null));

      if (!member) {
        jobStore.recordFailure({ id: memberId }, new Error('Member is no longer available in the guild.'));

        if (delayMs > 0) {
          await sleep(delayMs);
        }

        continue;
      }

      try {
        const missingRoleIds = getMissingRoleIds(member, roles);

        if (missingRoleIds.length > 0) {
          await runWithInfiniteRateLimitRetry({
            guildId: guild.id,
            memberId: member.id,
            contextLabel: 'Role grant',
            operation: () =>
              member.roles.add(
                missingRoleIds.length === 1 ? missingRoleIds[0] : missingRoleIds,
                reason,
              ),
          });
        }

        jobStore.recordSuccess();
      } catch (error) {
        jobStore.recordFailure(member, error);
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }

    const finishedJob = jobStore.finishActive('completed');

    if (finishedJob) {
      const reportPath = await writeReport(finishedJob, reportDirectory);
      jobStore.setLastJobReportPath(reportPath);
      logger.info(`Kuruma bulk role grant completed. Report: ${reportPath}`);
    }
  } catch (error) {
    logger.error('Kuruma bulk role grant crashed.', error);
    jobStore.markFatal(error);
    const failedJob = jobStore.finishActive('failed');

    if (failedJob) {
      const reportPath = await writeReport(failedJob, reportDirectory);
      jobStore.setLastJobReportPath(reportPath);
      logger.error(`Kuruma failed job report written to ${reportPath}`);
    }
  }
}

async function writeReport(job, reportDirectory) {
  await mkdir(reportDirectory, { recursive: true });

  const timestamp = new Date(job.finishedAt ?? job.startedAt).toISOString().replace(/[:.]/g, '-');
  const fileName = [
    timestamp,
    sanitizeFileSegment(job.guildName),
    sanitizeFileSegment(job.roleName),
    job.id,
  ].join('__') + '.json';
  const absolutePath = path.join(reportDirectory, fileName);

  await writeFile(
    absolutePath,
    JSON.stringify(
      {
        ...job,
        summary: {
          processed: job.processed,
          granted: job.granted,
          failed: job.failed,
          skippedBeforeStart: job.skippedBots + job.skippedExisting + job.skippedUnmanageable,
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  return absolutePath;
}

export function formatRoleGrantError(error) {
  return normalizeError(error);
}
