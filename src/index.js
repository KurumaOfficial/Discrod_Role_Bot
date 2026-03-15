import process from 'node:process';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  DiscordAPIError,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';

import { buildCommandDefinitions } from './commands.js';
import { config, validateConfig } from './config.js';
import { JobStore } from './jobStore.js';
import { logger } from './logger.js';
import { PendingGrantStore } from './pendingGrantStore.js';
import {
  buildGrantPreview,
  formatRoleGrantError,
  startRoleGrantJob,
  validateRoleTarget,
} from './roleGrantService.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const jobStore = new JobStore();
const pendingGrantStore = new PendingGrantStore(config.pendingGrantTtlMs);
const JOB_PROGRESS_UPDATE_INTERVAL_MS = 2000;
const JOB_PROGRESS_WATCH_TIMEOUT_MS = 14 * 60 * 1000;
const PROGRESS_BAR_WIDTH = 16;

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '0s';
  }

  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }

  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(' ');
}

function buildProgressBar(processed, total) {
  const safeTotal = total > 0 ? total : 1;
  const ratio = Math.max(0, Math.min(processed / safeTotal, 1));
  const filled = Math.round(ratio * PROGRESS_BAR_WIDTH);
  const empty = PROGRESS_BAR_WIDTH - filled;

  return `[${'#'.repeat(filled)}${'-'.repeat(empty)}] ${Math.round(ratio * 100)}%`;
}

function getJobMetrics(job) {
  const finishedAtMs = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const elapsedMs = Math.max(finishedAtMs - Date.parse(job.startedAt), 0);
  const ratePerMinute =
    job.processed > 0 && elapsedMs > 0 ? ((job.processed / elapsedMs) * 60000).toFixed(2) : '0.00';
  const averageMs = job.processed > 0 ? elapsedMs / job.processed : job.delayMs;
  const remaining = Math.max(job.eligibleCount - job.processed, 0);
  const etaMs = job.status === 'running' ? remaining * averageMs : 0;

  return {
    elapsedMs,
    ratePerMinute,
    remaining,
    etaMs,
    progressBar: buildProgressBar(job.processed, job.eligibleCount),
  };
}

function buildJobStateLabel(job) {
  if (job.status === 'running') {
    return 'RUNNING';
  }

  if (job.status === 'completed') {
    return 'COMPLETED';
  }

  return 'FAILED';
}

function buildLiveGrantEmbed(job) {
  const metrics = getJobMetrics(job);
  const skippedBeforeStart = job.skippedBots + job.skippedExisting + job.skippedUnmanageable;
  const isRunning = job.status === 'running';
  const isCompleted = job.status === 'completed';
  const embed = new EmbedBuilder()
    .setColor(isRunning ? 0xf39c12 : isCompleted ? 0x2f7d32 : 0xc0392b)
    .setTitle(
      isRunning
        ? 'Kuruma Bulk Role Grant Started'
        : isCompleted
          ? 'Kuruma Bulk Role Grant Completed'
          : 'Kuruma Bulk Role Grant Failed',
    )
    .setDescription(
      isRunning
        ? 'Kuruma is updating this card while the queue runs.'
        : isCompleted
          ? 'The queue finished and this is the final result.'
          : 'The queue stopped before completion. Review the error details below.',
    )
    .addFields(
      { name: 'Status', value: buildJobStateLabel(job), inline: true },
      { name: 'Progress', value: `${job.processed}/${job.eligibleCount}`, inline: true },
      { name: 'Progress Bar', value: metrics.progressBar },
      { name: 'Role', value: `${job.roleName} (${job.roleId})` },
      { name: 'Granted', value: String(job.granted), inline: true },
      { name: 'Failed', value: String(job.failed), inline: true },
      { name: 'Skipped Before Start', value: String(skippedBeforeStart), inline: true },
      { name: 'Rate', value: `${metrics.ratePerMinute} members/min`, inline: true },
      { name: 'Elapsed', value: formatDuration(metrics.elapsedMs), inline: true },
      {
        name: isRunning ? 'ETA' : 'Delay',
        value: isRunning ? formatDuration(metrics.etaMs) : `${job.delayMs} ms`,
        inline: true,
      },
      { name: 'Job ID', value: job.id },
    )
    .setTimestamp();

  if (job.reportPath) {
    embed.addFields({ name: 'Report', value: job.reportPath });
  }

  if (job.fatalError) {
    embed.addFields({ name: 'Fatal Error', value: job.fatalError.slice(0, 1024) });
  }

  if (job.errors.length > 0) {
    const errorPreview = job.errors
      .slice(0, 3)
      .map((entry) => `${entry.memberId}: ${entry.error}`)
      .join('\n')
      .slice(0, 1024);

    embed.addFields({ name: 'Latest Errors', value: errorPreview });
  }

  return embed;
}

function buildPreviewEmbed({ guild, role, preview, includeBots, reason }) {
  return new EmbedBuilder()
    .setColor(0x2f7d32)
    .setTitle('Kuruma Bulk Role Grant Preview')
    .setDescription('Review the numbers below and confirm the bulk role grant.')
    .addFields(
      { name: 'Guild', value: `${guild.name} (${guild.id})` },
      { name: 'Role', value: `${role.name} (${role.id})` },
      { name: 'Will Grant', value: String(preview.eligibleCount), inline: true },
      { name: 'Skip Bots', value: String(preview.skippedBots), inline: true },
      { name: 'Skip Existing', value: String(preview.skippedExisting), inline: true },
      { name: 'Not Manageable', value: String(preview.skippedUnmanageable), inline: true },
      { name: 'Total Members Scanned', value: String(preview.totalMembers), inline: true },
      { name: 'Include Bots', value: includeBots ? 'Yes' : 'No', inline: true },
      { name: 'Reason', value: reason.slice(0, 1024) },
    )
    .setFooter({ text: 'Kuruma will process one safe queue at a time.' })
    .setTimestamp();
}

function buildStatusEmbed({ guild, activeJob, lastJob }) {
  const embed = new EmbedBuilder()
    .setColor(activeJob ? 0xf39c12 : 0x5865f2)
    .setTitle('Kuruma Role Grant Status')
    .setDescription(activeJob ? 'A bulk role grant is currently running.' : 'No active bulk role grant job.')
    .addFields(
      { name: 'Guild', value: `${guild.name} (${guild.id})` },
      { name: 'Delay', value: `${config.roleGrantDelayMs} ms`, inline: true },
      { name: 'Bot Filter', value: config.skipBotsByDefault ? 'Skip by default' : 'Include by default', inline: true },
    )
    .setTimestamp();

  if (activeJob) {
    const metrics = getJobMetrics(activeJob);

    embed.addFields(
      { name: 'Active Role', value: `${activeJob.roleName} (${activeJob.roleId})` },
      { name: 'Progress', value: `${activeJob.processed}/${activeJob.eligibleCount} processed`, inline: true },
      { name: 'Progress Bar', value: metrics.progressBar },
      { name: 'Granted', value: String(activeJob.granted), inline: true },
      { name: 'Failed', value: String(activeJob.failed), inline: true },
      {
        name: 'Skipped Before Start',
        value: `${activeJob.skippedBots + activeJob.skippedExisting + activeJob.skippedUnmanageable}`,
        inline: true,
      },
      { name: 'Rate', value: `${metrics.ratePerMinute} members/min`, inline: true },
      { name: 'Elapsed', value: formatDuration(metrics.elapsedMs), inline: true },
      { name: 'ETA', value: formatDuration(metrics.etaMs), inline: true },
    );

    if (activeJob.errors.length > 0) {
      const errorPreview = activeJob.errors
        .slice(0, 3)
        .map((entry) => `${entry.memberId}: ${entry.error}`)
        .join('\n')
        .slice(0, 1024);

      embed.addFields({ name: 'Latest Errors', value: errorPreview });
    }
  }

  if (lastJob) {
    embed.addFields(
      { name: 'Last Job', value: `${lastJob.status.toUpperCase()} for ${lastJob.roleName}` },
      {
        name: 'Last Result',
        value: `Granted ${lastJob.granted}, failed ${lastJob.failed}, skipped ${
          lastJob.skippedBots + lastJob.skippedExisting + lastJob.skippedUnmanageable
        }`,
      },
      {
        name: 'Last Report',
        value: lastJob.reportPath ? lastJob.reportPath : 'Report has not been written yet.',
      },
    );
  }

  return embed;
}

function buildPermissionError() {
  return 'You need the Manage Roles permission to use Kuruma bulk role commands.';
}

function isKnownInteractionResponseError(error) {
  return (
    error instanceof DiscordAPIError &&
    [10015, 10062, 40060, 50027].includes(error.code)
  );
}

async function sendInteractionError(interaction, content) {
  if (!interaction.isRepliable()) {
    return;
  }

  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({
        content,
        embeds: [],
        components: [],
      });
      return;
    }

    if (!interaction.replied) {
      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (isKnownInteractionResponseError(error)) {
      logger.warn('Kuruma could not deliver an interaction error message because the interaction was no longer valid.');
      return;
    }

    throw error;
  }
}

async function safeEditInteractionReply(interaction, payload) {
  try {
    await interaction.editReply(payload);
    return true;
  } catch (error) {
    if (isKnownInteractionResponseError(error)) {
      logger.warn('Kuruma stopped live progress updates because the interaction reply is no longer editable.');
      return false;
    }

    throw error;
  }
}

function getTrackedJob(jobId) {
  const activeJob = jobStore.getActiveJob();

  if (activeJob?.id === jobId) {
    return activeJob;
  }

  const lastJob = jobStore.getLastJob();

  if (lastJob?.id === jobId) {
    return lastJob;
  }

  return null;
}

async function watchJobProgressMessage(interaction, jobId) {
  const startedWatchingAt = Date.now();
  let lastSnapshotKey = '';
  let waitsForFinalReport = 0;

  while (Date.now() - startedWatchingAt < JOB_PROGRESS_WATCH_TIMEOUT_MS) {
    const trackedJob = getTrackedJob(jobId);

    if (!trackedJob) {
      return;
    }

    const waitingForReport =
      trackedJob.status !== 'running' && !trackedJob.reportPath && waitsForFinalReport < 3;
    const snapshotKey = [
      trackedJob.status,
      trackedJob.processed,
      trackedJob.granted,
      trackedJob.failed,
      trackedJob.errors.length,
      trackedJob.fatalError ?? '',
      trackedJob.reportPath ?? '',
    ].join(':');

    if (snapshotKey !== lastSnapshotKey) {
      const updated = await safeEditInteractionReply(interaction, {
        embeds: [buildLiveGrantEmbed(trackedJob)],
        components: [],
      });

      if (!updated) {
        return;
      }

      lastSnapshotKey = snapshotKey;
    }

    if (trackedJob.status !== 'running') {
      if (waitingForReport) {
        waitsForFinalReport += 1;
      } else {
        return;
      }
    }

    await sleep(JOB_PROGRESS_UPDATE_INTERVAL_MS);
  }
}

function ensureAllowedGuild(guildId) {
  return guildId === config.allowedGuildId;
}

async function registerCommandsForGuild(guild) {
  if (!ensureAllowedGuild(guild.id)) {
    return;
  }

  await guild.commands.set(buildCommandDefinitions());
  logger.info(`Registered Kuruma slash commands for guild ${guild.id}.`);
}

async function registerCommands() {
  const allowedGuild = await client.guilds.fetch(config.allowedGuildId).then((entry) => entry.fetch());
  await registerCommandsForGuild(allowedGuild);
}

async function handleStatus(interaction) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  if (!interaction.inGuild() || !ensureAllowedGuild(interaction.guildId)) {
    await interaction.editReply('Kuruma is locked to the guild configured in ALLOWED_GUILD_ID.');
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.editReply(buildPermissionError());
    return;
  }

  const activeJob = jobStore.getActiveJob();
  const lastJob = jobStore.getLastJob();

  await interaction.editReply({
    embeds: [buildStatusEmbed({ guild: interaction.guild, activeJob, lastJob })],
  });
}

async function handleGrantRole(interaction) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  if (!interaction.inGuild() || !ensureAllowedGuild(interaction.guildId)) {
    await interaction.editReply('Kuruma is locked to the guild configured in ALLOWED_GUILD_ID.');
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.editReply(buildPermissionError());
    return;
  }

  if (jobStore.hasActiveJob()) {
    await interaction.editReply('A Kuruma bulk role grant is already running. Use /status to track it.');
    return;
  }

  try {
    const selectedRole = interaction.options.getRole('role', true);
    const role =
      interaction.guild.roles.cache.get(selectedRole.id) ??
      (await interaction.guild.roles.fetch(selectedRole.id));
    const includeBots = interaction.options.getBoolean('include_bots') ?? !config.skipBotsByDefault;
    const reason = interaction.options.getString('reason')?.trim() || config.defaultGrantReason;

    if (!role) {
      await interaction.editReply({ content: 'Role not found in this guild.' });
      return;
    }

    const validationError = await validateRoleTarget(interaction.guild, role);

    if (validationError) {
      await interaction.editReply({ content: validationError });
      return;
    }

    const preview = await buildGrantPreview({
      guild: interaction.guild,
      role,
      includeBots,
    });
    const token = pendingGrantStore.create({
      guildId: interaction.guildId,
      roleId: role.id,
      includeBots,
      reason,
      requestedBy: interaction.user.id,
      preview: {
        totalMembers: preview.totalMembers,
        eligibleCount: preview.eligibleCount,
        skippedBots: preview.skippedBots,
        skippedExisting: preview.skippedExisting,
        skippedUnmanageable: preview.skippedUnmanageable,
      },
      memberIds: preview.memberIds,
    });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`grant-confirm:${token}`)
        .setLabel('Start Grant')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`grant-cancel:${token}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.editReply({
      embeds: [buildPreviewEmbed({ guild: interaction.guild, role, preview, includeBots, reason })],
      components: [row],
    });
  } catch (error) {
    logger.error('Failed to prepare Kuruma bulk role grant preview.', error);
    await interaction.editReply({ content: formatRoleGrantError(error) });
  }
}

async function handleGrantConfirm(interaction, token) {
  const entry = pendingGrantStore.get(token);

  if (!entry) {
    await interaction.reply({
      content: 'This Kuruma confirmation expired. Run /grantrole again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (entry.requestedBy !== interaction.user.id) {
    await interaction.reply({
      content: 'Only the admin who created this preview can confirm it.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  pendingGrantStore.consume(token);

  try {
    const { job, preview } = await startRoleGrantJob({
      client,
      guildId: entry.guildId,
      roleId: entry.roleId,
      requestedBy: entry.requestedBy,
      includeBots: entry.includeBots,
      reason: entry.reason,
      delayMs: config.roleGrantDelayMs,
      jobStore,
      reportDirectory: config.reportDirectory,
      preparedPreview: entry.preview,
      preparedMemberIds: entry.memberIds,
    });

    await interaction.editReply({
      embeds: [
        buildLiveGrantEmbed({
          ...job,
          eligibleCount: preview.eligibleCount,
        }),
      ],
      components: [],
    });

    void watchJobProgressMessage(interaction, job.id);
  } catch (error) {
    logger.error('Failed to start Kuruma bulk role grant.', error);
    await interaction.editReply({
      content: formatRoleGrantError(error),
      embeds: [],
      components: [],
    });
  }
}

async function handleGrantCancel(interaction, token) {
  const entry = pendingGrantStore.get(token);

  if (!entry) {
    await interaction.reply({
      content: 'This Kuruma confirmation already expired.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (entry.requestedBy !== interaction.user.id) {
    await interaction.reply({
      content: 'Only the admin who created this preview can cancel it.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  pendingGrantStore.remove(token);

  await interaction.update({
    content: 'Kuruma bulk role grant canceled before start.',
    embeds: [],
    components: [],
  });
}

client.once('clientReady', async () => {
  logger.info(`Logged in as ${client.user.tag}.`);

  try {
    await registerCommands();
  } catch (error) {
    logger.error('Failed to register Kuruma slash commands.', error);
  }
});

client.on('guildCreate', async (guild) => {
  try {
    await registerCommandsForGuild(guild);
  } catch (error) {
    logger.error(`Failed to register commands for new guild ${guild.id}.`, error);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'status') {
        await handleStatus(interaction);
        return;
      }

      if (interaction.commandName === 'grantrole') {
        await handleGrantRole(interaction);
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('grant-confirm:')) {
        const token = interaction.customId.split(':')[1];
        await handleGrantConfirm(interaction, token);
        return;
      }

      if (interaction.customId.startsWith('grant-cancel:')) {
        const token = interaction.customId.split(':')[1];
        await handleGrantCancel(interaction, token);
        return;
      }
    }
  } catch (error) {
    logger.error('Kuruma interaction handler failed.', error);
    await sendInteractionError(interaction, 'Kuruma hit an unexpected error. Check the bot console.');
  }
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection.', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception.', error);
});

async function bootstrap() {
  validateConfig();
  await client.login(config.botToken);
}

bootstrap().catch((error) => {
  logger.error('Kuruma bootstrap failed.', error);
  process.exit(1);
});
