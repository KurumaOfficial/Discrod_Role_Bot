import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export function buildCommandDefinitions() {
  const defaultPermissions = PermissionFlagsBits.ManageRoles.toString();

  return [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show Kuruma bulk role grant status and metrics.')
      .setDefaultMemberPermissions(defaultPermissions),
    new SlashCommandBuilder()
      .setName('grantrole')
      .setDescription('Preview and start a safe bulk role grant for one or two roles.')
      .setDefaultMemberPermissions(defaultPermissions)
      .addRoleOption((option) =>
        option.setName('role').setDescription('Primary role to grant to members.').setRequired(true),
      )
      .addRoleOption((option) =>
        option
          .setName('second_role')
          .setDescription('Optional second role to grant in the same job.')
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('include_bots')
          .setDescription('Grant the role to bot accounts too. Default: false.'),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Optional audit log reason.')
          .setMaxLength(512),
      ),
  ].map((command) => command.toJSON());
}
