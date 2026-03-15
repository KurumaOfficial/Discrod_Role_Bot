import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = Object.freeze({
  brand: 'Kuruma Role Restorer',
  botToken: process.env.DISCORD_BOT_TOKEN?.trim() ?? '',
  dashboardHost: process.env.DASHBOARD_HOST?.trim() || '127.0.0.1',
  dashboardPort: toInteger(process.env.DASHBOARD_PORT, 3007),
  targetGuildId: process.env.TARGET_GUILD_ID?.trim() ?? '',
  defaultRestoreDelayMs: Math.max(100, toInteger(process.env.DEFAULT_RESTORE_DELAY_MS, 250)),
  defaultRestoreReason: (process.env.DEFAULT_RESTORE_REASON?.trim() || 'Kuruma role restore').slice(0, 512),
  skipBotAccounts: toBoolean(process.env.SKIP_BOT_ACCOUNTS, true)
});

export function validateConfig() {
  const missingVariables = [];

  if (!config.botToken) {
    missingVariables.push('DISCORD_BOT_TOKEN');
  }

  if (missingVariables.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVariables.join(', ')}`);
  }
}
