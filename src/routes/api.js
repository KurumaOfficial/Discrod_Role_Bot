import { Router } from 'express';
import multer from 'multer';

import { config } from '../config.js';
import { getGuildDashboard, listGuilds } from '../services/discordService.js';
import { buildRestorePreview, autoMatchMappings, cancelCurrentJob, getCurrentJob, saveMappings, startRestoreJob } from '../services/restoreService.js';
import { buildSnapshotView, captureAndStoreSnapshot, importSnapshotBuffer, selectSnapshot } from '../services/snapshotService.js';
import { getReportFilePath, getSnapshotFilePath, listSnapshots, loadReport, loadSnapshot, readState, updateState } from '../services/storage.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

function asyncRoute(handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      response.status(400).json({
        error: error?.message ?? 'Unknown API error'
      });
    }
  };
}

async function buildDashboardPayload() {
  let state = await readState();
  const guilds = await listGuilds();

  let selectedGuildId = config.targetGuildId || state.selectedGuildId || guilds[0]?.id || '';

  if (selectedGuildId && !guilds.some((guild) => guild.id === selectedGuildId)) {
    selectedGuildId = guilds[0]?.id || '';
  }

  const snapshots = await listSnapshots();
  let selectedSnapshotId = state.selectedSnapshotId || snapshots[0]?.id || '';

  if (selectedSnapshotId && !snapshots.some((snapshot) => snapshot.id === selectedSnapshotId)) {
    selectedSnapshotId = snapshots[0]?.id || '';
  }

  if (selectedGuildId !== state.selectedGuildId || selectedSnapshotId !== state.selectedSnapshotId) {
    state = await updateState((draft) => {
      draft.selectedGuildId = selectedGuildId;
      draft.selectedSnapshotId = selectedSnapshotId;
      return draft;
    });
  }

  const live = selectedGuildId ? await getGuildDashboard(selectedGuildId) : null;
  const mappings = selectedSnapshotId ? (state.mappingsBySnapshotId[selectedSnapshotId] ?? {}) : {};
  const snapshot = selectedSnapshotId ? await loadSnapshot(selectedSnapshotId) : null;
  const latestReport = state.lastReportId ? await loadReport(state.lastReportId) : null;

  return {
    brand: config.brand,
    guilds,
    selectedGuildId,
    live,
    snapshots,
    selectedSnapshotId,
    snapshot: snapshot ? buildSnapshotView(snapshot, mappings) : null,
    mappings,
    defaults: {
      delayMs: config.defaultRestoreDelayMs,
      reason: config.defaultRestoreReason,
      skipBotAccounts: config.skipBotAccounts
    },
    job: getCurrentJob(),
    latestReport: latestReport ? {
      id: latestReport.id,
      createdAt: latestReport.createdAt,
      status: latestReport.status,
      stats: latestReport.stats
    } : null
  };
}

export function createApiRouter() {
  const router = Router();

  router.get('/dashboard', asyncRoute(async (_request, response) => {
    response.json(await buildDashboardPayload());
  }));

  router.post('/guild/select', asyncRoute(async (request, response) => {
    if (config.targetGuildId && request.body.guildId && request.body.guildId !== config.targetGuildId) {
      throw new Error('TARGET_GUILD_ID is locked in .env. Remove it if you want to switch servers in the dashboard.');
    }

    await updateState((state) => {
      state.selectedGuildId = request.body.guildId || config.targetGuildId || state.selectedGuildId;
      return state;
    });

    response.json(await buildDashboardPayload());
  }));

  router.post('/snapshot/capture', asyncRoute(async (request, response) => {
    const guildId = request.body.guildId || config.targetGuildId || null;
    const snapshot = await captureAndStoreSnapshot(guildId);
    response.json({
      message: `Snapshot ${snapshot.id} captured successfully.`,
      snapshot
    });
  }));

  router.post('/snapshot/select', asyncRoute(async (request, response) => {
    const snapshot = await selectSnapshot(request.body.snapshotId);
    response.json({
      message: `Snapshot ${snapshot.id} selected.`,
      snapshot
    });
  }));

  router.post('/snapshot/import', upload.single('snapshotFile'), asyncRoute(async (request, response) => {
    if (!request.file) {
      throw new Error('Choose a JSON snapshot file first.');
    }

    const snapshot = await importSnapshotBuffer(request.file.buffer, request.file.originalname);
    response.json({
      message: `Snapshot ${snapshot.id} imported successfully.`,
      snapshot
    });
  }));

  router.get('/snapshot/export/:snapshotId', asyncRoute(async (request, response) => {
    const snapshot = await loadSnapshot(request.params.snapshotId);

    if (!snapshot) {
      throw new Error('Snapshot not found.');
    }

    response.download(getSnapshotFilePath(snapshot.id), `kuruma-snapshot-${snapshot.id}.json`);
  }));

  router.post('/mapping/auto-match', asyncRoute(async (request, response) => {
    const mappings = await autoMatchMappings(request.body.guildId, request.body.snapshotId);
    response.json({
      message: 'Automatic role mapping completed.',
      mappings
    });
  }));

  router.post('/mapping/save', asyncRoute(async (request, response) => {
    const mappings = await saveMappings(request.body.snapshotId, request.body.mappings ?? {});
    response.json({
      message: 'Mappings saved.',
      mappings
    });
  }));

  router.post('/preview', asyncRoute(async (request, response) => {
    const preview = await buildRestorePreview(
      request.body.guildId,
      request.body.snapshotId,
      request.body.options ?? {}
    );

    response.json(preview);
  }));

  router.post('/restore/start', asyncRoute(async (request, response) => {
    const job = await startRestoreJob(
      request.body.guildId,
      request.body.snapshotId,
      request.body.options ?? {}
    );

    response.status(202).json({
      message: 'Restore job started.',
      job
    });
  }));

  router.post('/restore/cancel', asyncRoute(async (_request, response) => {
    const cancelled = cancelCurrentJob();
    response.json({
      cancelled
    });
  }));

  router.get('/report/export/:reportId', asyncRoute(async (request, response) => {
    const report = await loadReport(request.params.reportId);

    if (!report) {
      throw new Error('Report not found.');
    }

    response.download(getReportFilePath(report.id), `kuruma-restore-report-${report.id}.json`);
  }));

  return router;
}
