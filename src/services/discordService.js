import { Client, GatewayIntentBits, PermissionsBitField } from 'discord.js';

import { config, validateConfig } from '../config.js';
import { compareRolesByPositionDesc, createId, displayUserTag } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

let startupPromise = null;

async function getBotMember(guild) {
  return guild.members.me ?? guild.members.fetch(client.user.id);
}

function serializeRole(guild, role) {
  return {
    id: role.id,
    name: role.name,
    position: role.position,
    managed: role.managed,
    mentionable: role.mentionable,
    hoist: role.hoist,
    color: role.hexColor,
    permissions: role.permissions.toArray(),
    editable: role.id !== guild.id && !role.managed && role.editable
  };
}

function serializeGuildListItem(guild) {
  return {
    id: guild.id,
    name: guild.name,
    memberCount: guild.memberCount ?? 0
  };
}

export async function startDiscordClient() {
  if (startupPromise) {
    return startupPromise;
  }

  validateConfig();

  startupPromise = new Promise((resolve, reject) => {
    client.once('ready', () => {
      logger.info(`Discord client logged in as ${displayUserTag(client.user)}`);
      resolve(client);
    });

    client.once('error', reject);
  });

  client.on('warn', (warning) => logger.warn(warning));
  client.on('error', (error) => logger.error('Discord client error', error));

  await client.login(config.botToken);
  return startupPromise;
}

export async function waitForDiscord() {
  return startDiscordClient();
}

export async function listGuilds() {
  await waitForDiscord();

  return [...client.guilds.cache.values()]
    .map(serializeGuildListItem)
    .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
}

export async function resolveGuildId(candidateGuildId) {
  await waitForDiscord();

  if (config.targetGuildId) {
    return config.targetGuildId;
  }

  if (candidateGuildId) {
    return candidateGuildId;
  }

  const firstGuild = client.guilds.cache.first();

  if (!firstGuild) {
    throw new Error('Bot is not connected to any Discord server.');
  }

  return firstGuild.id;
}

export async function fetchGuildContext(candidateGuildId, { withMembers = false } = {}) {
  const guildId = await resolveGuildId(candidateGuildId);
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);

  await guild.roles.fetch();

  const botMember = await getBotMember(guild);
  const members = withMembers ? await guild.members.fetch() : null;

  return {
    guild,
    botMember,
    members
  };
}

export async function getGuildDashboard(candidateGuildId) {
  const { guild, botMember } = await fetchGuildContext(candidateGuildId);
  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .sort(compareRolesByPositionDesc)
    .map((role) => serializeRole(guild, role));

  const warnings = [];

  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    warnings.push('У бота нет права Manage Roles на сервере.');
  }

  if (!botMember.permissions.has(PermissionsBitField.Flags.ViewChannel)) {
    warnings.push('У бота нет права View Channels. Это не ломает restore, но показывает плохую конфигурацию.');
  }

  const lockedRoles = roles.filter((role) => !role.editable && !role.managed).length;

  if (lockedRoles > 0) {
    warnings.push(`Есть ${lockedRoles} ролей выше роли бота. Их нельзя восстановить, пока ты не поднимешь роль бота выше.`);
  }

  return {
    guild: {
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount ?? 0
    },
    bot: {
      id: client.user.id,
      username: client.user.username,
      highestRoleName: botMember.roles.highest?.name ?? 'Unknown',
      highestRolePosition: botMember.roles.highest?.position ?? 0
    },
    warnings,
    roles
  };
}

export async function captureGuildSnapshot(candidateGuildId) {
  const { guild, members } = await fetchGuildContext(candidateGuildId, { withMembers: true });
  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .sort(compareRolesByPositionDesc)
    .map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      managed: role.managed,
      mentionable: role.mentionable,
      hoist: role.hoist,
      color: role.hexColor,
      permissions: role.permissions.toArray()
    }));

  const serializedMembers = [...members.values()]
    .map((member) => ({
      userId: member.id,
      username: member.user.username,
      tag: displayUserTag(member.user),
      globalName: member.user.globalName ?? '',
      nickname: member.nickname ?? '',
      displayName: member.displayName,
      isBot: member.user.bot,
      roleIds: member.roles.cache
        .filter((role) => role.id !== guild.id)
        .sort(compareRolesByPositionDesc)
        .map((role) => role.id)
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'ru'));

  return {
    id: createId('snapshot'),
    version: 1,
    source: 'Kuruma Role Restorer',
    createdAt: new Date().toISOString(),
    guild: {
      id: guild.id,
      name: guild.name
    },
    stats: {
      memberCount: serializedMembers.length,
      roleCount: roles.length
    },
    roles,
    members: serializedMembers
  };
}
