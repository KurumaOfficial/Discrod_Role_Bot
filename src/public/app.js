const state = {
  dashboard: null,
  preview: null,
  pollTimer: null
};

const elements = {
  guildForm: document.getElementById('guild-form'),
  guildSelect: document.getElementById('guild-select'),
  serverSummary: document.getElementById('server-summary'),
  serverWarnings: document.getElementById('server-warnings'),
  captureSnapshot: document.getElementById('capture-snapshot'),
  exportSnapshot: document.getElementById('export-snapshot'),
  snapshotSelectForm: document.getElementById('snapshot-select-form'),
  snapshotSelect: document.getElementById('snapshot-select'),
  importSnapshotForm: document.getElementById('import-snapshot-form'),
  snapshotFile: document.getElementById('snapshot-file'),
  snapshotSummary: document.getElementById('snapshot-summary'),
  autoMatch: document.getElementById('auto-match'),
  saveMappings: document.getElementById('save-mappings'),
  mappingSummary: document.getElementById('mapping-summary'),
  mappingTableBody: document.getElementById('mapping-table-body'),
  ignoredRoles: document.getElementById('ignored-roles'),
  delayMs: document.getElementById('delay-ms'),
  restoreReason: document.getElementById('restore-reason'),
  dryRun: document.getElementById('dry-run'),
  preserveExtra: document.getElementById('preserve-extra'),
  skipBots: document.getElementById('skip-bots'),
  runPreview: document.getElementById('run-preview'),
  startRestore: document.getElementById('start-restore'),
  previewSummary: document.getElementById('preview-summary'),
  previewSamples: document.getElementById('preview-samples'),
  jobSummary: document.getElementById('job-summary'),
  jobLogs: document.getElementById('job-logs'),
  cancelJob: document.getElementById('cancel-job'),
  toast: document.getElementById('toast'),
  reportLink: document.getElementById('report-link')
};

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden', 'toast-error');

  if (isError) {
    elements.toast.classList.add('toast-error');
  }

  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 3200);
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'API request failed.');
  }

  return data;
}

function collectMappings() {
  const mappingInputs = document.querySelectorAll('[data-snapshot-role-id]');
  const mappings = {};

  for (const input of mappingInputs) {
    if (input.value) {
      mappings[input.dataset.snapshotRoleId] = input.value;
    }
  }

  return mappings;
}

function collectRestoreOptions() {
  return {
    delayMs: Number.parseInt(elements.delayMs.value, 10),
    reason: elements.restoreReason.value,
    dryRun: elements.dryRun.checked,
    preserveExtraManageableRoles: elements.preserveExtra.checked,
    skipBotAccounts: elements.skipBots.checked
  };
}

function renderInfoGrid(target, entries) {
  target.innerHTML = '';

  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'info-card';
    item.innerHTML = `<span>${entry.label}</span><strong>${entry.value}</strong>`;
    target.appendChild(item);
  }
}

function renderGuildSection() {
  const dashboard = state.dashboard;
  elements.guildSelect.innerHTML = dashboard.guilds
    .map((guild) => `<option value="${guild.id}" ${guild.id === dashboard.selectedGuildId ? 'selected' : ''}>${guild.name} (${guild.memberCount})</option>`)
    .join('');

  if (!dashboard.live) {
    renderInfoGrid(elements.serverSummary, []);
    elements.serverWarnings.innerHTML = '';
    return;
  }

  renderInfoGrid(elements.serverSummary, [
    { label: 'Server', value: dashboard.live.guild.name },
    { label: 'Members', value: dashboard.live.guild.memberCount },
    { label: 'Roles', value: dashboard.live.roles.length },
    { label: 'Bot top role', value: dashboard.live.bot.highestRoleName }
  ]);

  elements.serverWarnings.innerHTML = dashboard.live.warnings.length > 0
    ? dashboard.live.warnings.map((warning) => `<span class="chip chip-warning">${warning}</span>`).join('')
    : '<span class="chip chip-ok">Конфигурация выглядит рабочей.</span>';
}

function renderSnapshotSection() {
  const dashboard = state.dashboard;
  elements.snapshotSelect.innerHTML = dashboard.snapshots
    .map((snapshot) => `<option value="${snapshot.id}" ${snapshot.id === dashboard.selectedSnapshotId ? 'selected' : ''}>${new Date(snapshot.createdAt).toLocaleString('ru-RU')} / ${snapshot.guild.name}</option>`)
    .join('');

  if (!dashboard.snapshot) {
    renderInfoGrid(elements.snapshotSummary, []);
    elements.mappingSummary.innerHTML = '<p class="muted">Сначала сними или импортируй snapshot.</p>';
    elements.mappingTableBody.innerHTML = '';
    elements.ignoredRoles.innerHTML = '';
    return;
  }

  renderInfoGrid(elements.snapshotSummary, [
    { label: 'Snapshot ID', value: dashboard.snapshot.id },
    { label: 'Source server', value: dashboard.snapshot.guild.name },
    { label: 'Captured', value: new Date(dashboard.snapshot.createdAt).toLocaleString('ru-RU') },
    { label: 'Members', value: dashboard.snapshot.stats.memberCount }
  ]);

  elements.mappingSummary.innerHTML = `
    <div class="info-card accent">
      <span>Mapped roles</span>
      <strong>${dashboard.snapshot.mappingStats.mappedRoles} / ${dashboard.snapshot.mappingStats.totalRestorableRoles}</strong>
    </div>
    <p class="muted">Управляемые Discord роли вроде booster и bot-managed ролей игнорируются автоматически.</p>
  `;

  const liveRoleOptions = dashboard.live?.roles ?? [];

  elements.mappingTableBody.innerHTML = dashboard.snapshot.restorableRoles.length > 0
    ? dashboard.snapshot.restorableRoles.map((role) => {
      const optionsHtml = [
        '<option value="">Not mapped</option>',
        ...liveRoleOptions.map((liveRole) => {
          const suffix = liveRole.managed ? ' [managed]' : liveRole.editable ? '' : ' [locked]';
          const selected = role.mappedRoleId === liveRole.id ? 'selected' : '';
          return `<option value="${liveRole.id}" ${selected}>${liveRole.name}${suffix}</option>`;
        })
      ].join('');

      return `
        <tr>
          <td>
            <strong>${role.name}</strong>
            <div class="muted">Snapshot role ID: ${role.id}</div>
          </td>
          <td>${role.memberCount}</td>
          <td>
            <select data-snapshot-role-id="${role.id}">
              ${optionsHtml}
            </select>
          </td>
        </tr>
      `;
    }).join('')
    : '<tr><td colspan="3">No restorable roles were found in this snapshot.</td></tr>';

  elements.ignoredRoles.innerHTML = dashboard.snapshot.ignoredManagedRoles.length > 0
    ? `Ignored managed roles: ${dashboard.snapshot.ignoredManagedRoles.map((role) => role.name).join(', ')}`
    : 'Ignored managed roles: none';
}

function renderPreview() {
  const preview = state.preview;

  if (!preview) {
    elements.previewSummary.innerHTML = '<p class="muted">Нажми Build preview, чтобы увидеть объём работы до записи в Discord.</p>';
    elements.previewSamples.innerHTML = '';
    return;
  }

  elements.previewSummary.innerHTML = `
    <div class="info-card"><span>Changed members</span><strong>${preview.stats.changedMembers}</strong></div>
    <div class="info-card"><span>Blocked members</span><strong>${preview.stats.blockedMembers}</strong></div>
    <div class="info-card"><span>Missing members</span><strong>${preview.stats.missingMembers}</strong></div>
    <div class="info-card"><span>Add operations</span><strong>${preview.stats.totalAddOperations}</strong></div>
    <div class="info-card"><span>Remove operations</span><strong>${preview.stats.totalRemoveOperations}</strong></div>
    <div class="info-card"><span>Unmapped roles</span><strong>${preview.mappingStats.unmappedRoleNames.length}</strong></div>
  `;

  const changedHtml = preview.samples.changedMembers
    .map((member) => `<li><strong>${member.member}</strong> | + ${member.addRoles.join(', ') || 'nothing'} | - ${member.removeRoles.join(', ') || 'nothing'}</li>`)
    .join('');

  const blockedHtml = preview.samples.blockedMembers
    .map((member) => `<li><strong>${member.member}</strong> | ${member.reasons.join(' / ')}</li>`)
    .join('');

  const missingHtml = preview.samples.missingMembers
    .map((member) => `<li><strong>${member.member}</strong> | ${member.reason}</li>`)
    .join('');

  elements.previewSamples.innerHTML = `
    <div class="sample-card">
      <h3>Changed sample</h3>
      <ul>${changedHtml || '<li>No pending role changes.</li>'}</ul>
    </div>
    <div class="sample-card">
      <h3>Blocked sample</h3>
      <ul>${blockedHtml || '<li>No blocking cases detected.</li>'}</ul>
    </div>
    <div class="sample-card">
      <h3>Missing sample</h3>
      <ul>${missingHtml || '<li>All snapshot members are present.</li>'}</ul>
    </div>
  `;
}

function renderJob() {
  const job = state.dashboard?.job;

  if (!job) {
    renderInfoGrid(elements.jobSummary, []);
    elements.jobLogs.innerHTML = '<p class="muted">Restore job is idle.</p>';
  } else {
    renderInfoGrid(elements.jobSummary, [
      { label: 'Status', value: job.status },
      { label: 'Processed', value: `${job.progress.processedMembers} / ${job.progress.totalMembers}` },
      { label: 'Updated', value: job.stats.updatedMembers },
      { label: 'Failed', value: job.stats.failedMembers },
      { label: 'Writes', value: job.stats.apiWrites },
      { label: 'Progress', value: `${job.progress.percent}%` }
    ]);

    elements.jobLogs.innerHTML = job.logs?.length
      ? job.logs.map((line) => `<div class="log-line">${line}</div>`).join('')
      : '<p class="muted">No job logs yet.</p>';
  }

  const reportId = state.dashboard?.latestReport?.id || job?.reportId;

  if (reportId) {
    elements.reportLink.href = `/api/report/export/${reportId}`;
    elements.reportLink.classList.remove('hidden');
  } else {
    elements.reportLink.classList.add('hidden');
  }

  window.clearInterval(state.pollTimer);

  if (job?.status === 'running') {
    state.pollTimer = window.setInterval(refreshDashboard, 3000);
  }
}

function renderDefaults() {
  const defaults = state.dashboard.defaults;
  elements.delayMs.value = defaults.delayMs;
  elements.restoreReason.value = defaults.reason;
  elements.skipBots.checked = defaults.skipBotAccounts;
}

function renderAll() {
  renderGuildSection();
  renderSnapshotSection();
  renderPreview();
  renderJob();

  if (!elements.delayMs.value) {
    renderDefaults();
  }
}

async function refreshDashboard() {
  state.dashboard = await apiFetch('/api/dashboard');
  renderAll();
}

async function saveMappingsBeforeAction() {
  if (!state.dashboard?.snapshot) {
    throw new Error('Snapshot is not selected.');
  }

  const mappings = collectMappings();

  await apiFetch('/api/mapping/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      snapshotId: state.dashboard.selectedSnapshotId,
      mappings
    })
  });
}

elements.guildForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    await apiFetch('/api/guild/select', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        guildId: elements.guildSelect.value
      })
    });

    state.preview = null;
    await refreshDashboard();
    showToast('Server switched.');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.captureSnapshot.addEventListener('click', async () => {
  try {
    await apiFetch('/api/snapshot/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        guildId: elements.guildSelect.value
      })
    });

    state.preview = null;
    await refreshDashboard();
    showToast('Snapshot captured.');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.exportSnapshot.addEventListener('click', () => {
  if (!state.dashboard?.selectedSnapshotId) {
    showToast('No snapshot selected.', true);
    return;
  }

  window.open(`/api/snapshot/export/${state.dashboard.selectedSnapshotId}`, '_blank', 'noopener,noreferrer');
});

elements.snapshotSelectForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    await apiFetch('/api/snapshot/select', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        snapshotId: elements.snapshotSelect.value
      })
    });

    state.preview = null;
    await refreshDashboard();
    showToast('Snapshot selected.');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.importSnapshotForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!elements.snapshotFile.files?.length) {
    showToast('Choose a JSON file first.', true);
    return;
  }

  const formData = new FormData();
  formData.append('snapshotFile', elements.snapshotFile.files[0]);

  try {
    await apiFetch('/api/snapshot/import', {
      method: 'POST',
      body: formData
    });

    elements.snapshotFile.value = '';
    state.preview = null;
    await refreshDashboard();
    showToast('Snapshot imported.');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.autoMatch.addEventListener('click', async () => {
  try {
    await apiFetch('/api/mapping/auto-match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        guildId: state.dashboard.selectedGuildId,
        snapshotId: state.dashboard.selectedSnapshotId
      })
    });

    state.preview = null;
    await refreshDashboard();
    showToast('Auto-match completed.');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.saveMappings.addEventListener('click', async () => {
  try {
    await saveMappingsBeforeAction();
    await refreshDashboard();
    showToast('Mappings saved.');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.runPreview.addEventListener('click', async () => {
  try {
    await saveMappingsBeforeAction();

    state.preview = await apiFetch('/api/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        guildId: state.dashboard.selectedGuildId,
        snapshotId: state.dashboard.selectedSnapshotId,
        options: collectRestoreOptions()
      })
    });

    renderPreview();
    showToast('Preview updated.');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.startRestore.addEventListener('click', async () => {
  try {
    await saveMappingsBeforeAction();

    await apiFetch('/api/restore/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        guildId: state.dashboard.selectedGuildId,
        snapshotId: state.dashboard.selectedSnapshotId,
        options: collectRestoreOptions()
      })
    });

    await refreshDashboard();
    showToast('Restore job started.');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.cancelJob.addEventListener('click', async () => {
  try {
    await apiFetch('/api/restore/cancel', {
      method: 'POST'
    });

    await refreshDashboard();
    showToast('Cancel signal sent.');
  } catch (error) {
    showToast(error.message, true);
  }
});

refreshDashboard().catch((error) => {
  showToast(error.message, true);
});
