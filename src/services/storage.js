import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const dataDir = path.join(rootDir, 'data');
const snapshotsDir = path.join(dataDir, 'snapshots');
const reportsDir = path.join(dataDir, 'reports');
const statePath = path.join(dataDir, 'state.json');

function createDefaultState() {
  return {
    version: 1,
    selectedGuildId: '',
    selectedSnapshotId: '',
    mappingsBySnapshotId: {},
    lastReportId: '',
    updatedAt: new Date().toISOString()
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function ensureStorage() {
  await fs.mkdir(snapshotsDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });

  if (!await pathExists(statePath)) {
    await writeJson(statePath, createDefaultState());
  }
}

export async function readState() {
  await ensureStorage();

  const storedState = await readJson(statePath, createDefaultState());

  return {
    ...createDefaultState(),
    ...storedState,
    mappingsBySnapshotId: storedState?.mappingsBySnapshotId ?? {}
  };
}

export async function updateState(mutator) {
  const currentState = await readState();
  const draftState = structuredClone(currentState);
  const maybeNewState = await mutator(draftState);
  const nextState = maybeNewState ?? draftState;
  nextState.updatedAt = new Date().toISOString();
  await writeJson(statePath, nextState);
  return nextState;
}

function buildSnapshotSummary(snapshot) {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    importedAt: snapshot.importedAt ?? null,
    importedFrom: snapshot.importedFrom ?? null,
    guild: snapshot.guild,
    stats: snapshot.stats ?? {
      memberCount: snapshot.members?.length ?? 0,
      roleCount: snapshot.roles?.length ?? 0
    }
  };
}

function buildReportSummary(report) {
  return {
    id: report.id,
    createdAt: report.createdAt,
    status: report.status,
    guildId: report.guildId,
    snapshotId: report.snapshotId,
    stats: report.stats
  };
}

export async function saveSnapshot(snapshot) {
  await ensureStorage();
  const snapshotPath = path.join(snapshotsDir, `${snapshot.id}.json`);
  await writeJson(snapshotPath, snapshot);
  return snapshotPath;
}

export async function loadSnapshot(snapshotId) {
  if (!snapshotId) {
    return null;
  }

  const snapshotPath = path.join(snapshotsDir, `${snapshotId}.json`);
  return readJson(snapshotPath, null);
}

export async function listSnapshots() {
  await ensureStorage();

  const entries = await fs.readdir(snapshotsDir, { withFileTypes: true });
  const snapshots = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const snapshot = await readJson(path.join(snapshotsDir, entry.name), null);

    if (snapshot) {
      snapshots.push(buildSnapshotSummary(snapshot));
    }
  }

  return snapshots.sort((left, right) => {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

export async function saveReport(report) {
  await ensureStorage();
  const reportPath = path.join(reportsDir, `${report.id}.json`);
  await writeJson(reportPath, report);
  return reportPath;
}

export async function loadReport(reportId) {
  if (!reportId) {
    return null;
  }

  const reportPath = path.join(reportsDir, `${reportId}.json`);
  return readJson(reportPath, null);
}

export async function listReports() {
  await ensureStorage();

  const entries = await fs.readdir(reportsDir, { withFileTypes: true });
  const reports = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const report = await readJson(path.join(reportsDir, entry.name), null);

    if (report) {
      reports.push(buildReportSummary(report));
    }
  }

  return reports.sort((left, right) => {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

export function getSnapshotFilePath(snapshotId) {
  return path.join(snapshotsDir, `${snapshotId}.json`);
}

export function getReportFilePath(reportId) {
  return path.join(reportsDir, `${reportId}.json`);
}

export { buildSnapshotSummary, buildReportSummary, rootDir };
