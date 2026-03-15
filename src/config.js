import path from 'node:path';
import process from 'node:process';

import 'dotenv/config';

function readInteger(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (Number.isNaN(parsedValue)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }

  return parsedValue;
}

function readBoolean(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  if (rawValue === 'true') {
    return true;
  }

  if (rawValue === 'false') {
    return false;
  }

  throw new Error(`Environment variable ${name} must be true or false.`);
}

export const config = {
  botToken: process.env.DISCORD_BOT_TOKEN?.trim() ?? '',
  allowedGuildId: process.env.ALLOWED_GUILD_ID?.trim() ?? '',
  roleGrantDelayMs: readInteger('ROLE_GRANT_DELAY_MS', 350),
  skipBotsByDefault: readBoolean('SKIP_BOTS_BY_DEFAULT', true),
  defaultGrantReason:
    process.env.DEFAULT_GRANT_REASON?.trim() ||
    'Kuruma bulk role grant after server migration',
  reportDirectory: path.resolve(process.cwd(), process.env.REPORTS_DIR?.trim() || 'data/reports'),
  pendingGrantTtlMs: 10 * 60 * 1000,
};

export function validateConfig() {
  const missing = [];

  if (!config.botToken || config.botToken.includes('PASTE_YOUR')) {
    missing.push('DISCORD_BOT_TOKEN');
  }

  if (!config.allowedGuildId || config.allowedGuildId.includes('PASTE_YOUR')) {
    missing.push('ALLOWED_GUILD_ID');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (config.roleGrantDelayMs < 0) {
    throw new Error('ROLE_GRANT_DELAY_MS must be >= 0.');
  }
}
