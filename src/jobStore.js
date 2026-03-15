import crypto from 'node:crypto';

function clone(value) {
  if (!value) {
    return null;
  }

  return JSON.parse(JSON.stringify(value));
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

export class JobStore {
  constructor() {
    this.activeJob = null;
    this.lastJob = null;
  }

  hasActiveJob() {
    return this.activeJob !== null;
  }

  startJob({ guild, role, requestedBy, includeBots, reason, delayMs, preview }) {
    if (this.activeJob) {
      throw new Error('A role grant job is already running.');
    }

    this.activeJob = {
      id: crypto.randomUUID(),
      status: 'running',
      guildId: guild.id,
      guildName: guild.name,
      roleId: role.id,
      roleName: role.name,
      requestedBy,
      includeBots,
      reason,
      delayMs,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      totalMembers: preview.totalMembers,
      eligibleCount: preview.eligibleCount,
      skippedBots: preview.skippedBots,
      skippedExisting: preview.skippedExisting,
      skippedUnmanageable: preview.skippedUnmanageable,
      processed: 0,
      granted: 0,
      failed: 0,
      errors: [],
      fatalError: null,
      reportPath: null,
    };

    return clone(this.activeJob);
  }

  recordSuccess() {
    if (!this.activeJob) {
      return;
    }

    this.activeJob.processed += 1;
    this.activeJob.granted += 1;
  }

  recordFailure(member, error) {
    if (!this.activeJob) {
      return;
    }

    this.activeJob.processed += 1;
    this.activeJob.failed += 1;

    if (this.activeJob.errors.length >= 20) {
      return;
    }

    this.activeJob.errors.push({
      memberId: member?.id ?? 'unknown',
      memberTag: member?.user?.tag ?? 'unknown',
      error: normalizeError(error),
    });
  }

  markFatal(error) {
    if (!this.activeJob) {
      return;
    }

    this.activeJob.fatalError = normalizeError(error);
  }

  finishActive(status) {
    if (!this.activeJob) {
      return null;
    }

    this.activeJob.status = status;
    this.activeJob.finishedAt = new Date().toISOString();
    this.lastJob = clone(this.activeJob);
    this.activeJob = null;

    return clone(this.lastJob);
  }

  setLastJobReportPath(reportPath) {
    if (!this.lastJob) {
      return;
    }

    this.lastJob.reportPath = reportPath;
  }

  getActiveJob() {
    return clone(this.activeJob);
  }

  getLastJob() {
    return clone(this.lastJob);
  }
}
