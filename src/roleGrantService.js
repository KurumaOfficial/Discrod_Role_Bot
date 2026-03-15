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

export async function validateRoleTarget(guild, role) {
  const me = guild.members.me ?? (await guild.members.fetchMe());

  if (!me) {
    return 'Bot member is not available in this guild yet. Try again in a few seconds.';
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'Bot is missing the Manage Roles permission.';
  }

  if (role.id === guild.id) {
    return 'The @everyone role cannot be granted manually.';
  }

  if (role.managed) {
    return 'Managed or integration roles cannot be granted manually.';
  }

  if (!role.editable) {
    return 'This role is above the bot role or otherwise not editable.';
  }

  return null;
}

export async function buildGrantPreview({ guild, role, includeBots }) {
  const me = guild.members.me ?? (await guild.members.fetchMe());

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('Bot is missing the Manage Roles permission.');
  }

  const members = await guild.members.fetch();
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

    if (member.roles.cache.has(role.id)) {
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
  roleId,
  requestedBy,
  includeBots,
  reason,
  delayMs,
  jobStore,
  reportDirectory,
}) {
  if (jobStore.hasActiveJob()) {
    throw new Error('A role grant job is already running.');
  }

  const guild = await client.guilds.fetch(guildId).then((entry) => entry.fetch());
  const role = await guild.roles.fetch(roleId);

  if (!role) {
    throw new Error('Role not found.');
  }

  const validationError = await validateRoleTarget(guild, role);

  if (validationError) {
    throw new Error(validationError);
  }

  const preview = await buildGrantPreview({ guild, role, includeBots });
  const job = jobStore.startJob({
    guild,
    role,
    requestedBy,
    includeBots,
    reason,
    delayMs,
    preview,
  });

  void runRoleGrantJob({
    guild,
    role,
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

async function runRoleGrantJob({ guild, role, memberIds, reason, delayMs, jobStore, reportDirectory }) {
  logger.info(`Starting Kuruma bulk role grant for ${memberIds.length} members in guild ${guild.id}.`);

  try {
    for (const memberId of memberIds) {
      const member =
        guild.members.cache.get(memberId) ?? (await guild.members.fetch(memberId).catch(() => null));

      if (!member) {
        jobStore.recordFailure({ id: memberId }, new Error('Member is no longer available in the guild.'));

        if (delayMs > 0) {
          await sleep(delayMs);
        }

        continue;
      }

      try {
        await member.roles.add(role, reason);
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
