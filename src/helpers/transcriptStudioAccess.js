/** Build the transcript write handlers used directly by IPC registration. */
function createTranscriptStudioIpcHandlers(databaseManager, resolveCloudPermission) {
  const requireEdit = async (noteId) => {
    const authority = databaseManager.getTranscriptEditAuthority(noteId);
    if (authority.canEdit) return;
    if (!authority.cloudId || typeof resolveCloudPermission !== "function") {
      throw new Error("Transcript note is read-only");
    }
    let permission;
    try {
      permission = await resolveCloudPermission(authority.cloudId);
    } catch {
      throw new Error("Unable to verify transcript edit permission");
    }
    if (permission !== "owner" && permission !== "editor") {
      throw new Error("Transcript note is read-only");
    }
  };

  return {
    applyRevision: async (_event, input) => {
      await requireEdit(input?.noteId);
      return databaseManager.applyTranscriptRevision(input);
    },
    restoreVersion: async (_event, noteId, versionId, expectedVersion) => {
      await requireEdit(noteId);
      return databaseManager.restoreTranscriptVersion(noteId, versionId, expectedVersion);
    },
  };
}

function registerTranscriptStudioWriteIpcHandlers(
  ipcMain,
  databaseManager,
  resolveCloudPermission
) {
  const handlers = createTranscriptStudioIpcHandlers(databaseManager, resolveCloudPermission);
  ipcMain.handle("transcript-studio-apply-revision", handlers.applyRevision);
  ipcMain.handle("transcript-studio-restore-version", handlers.restoreVersion);
}

module.exports = { createTranscriptStudioIpcHandlers, registerTranscriptStudioWriteIpcHandlers };
