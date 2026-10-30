/** Build the transcript write handlers used directly by IPC registration. */
function createTranscriptStudioIpcHandlers(databaseManager, resolveCloudPermission) {
  const assertAccount = (expectedAccountId) => {
    if (
      (expectedAccountId !== null && typeof expectedAccountId !== "string") ||
      expectedAccountId !== databaseManager.activeAccountId
    )
      throw new Error("Transcript account scope changed; reload before editing");
  };
  const requireEdit = async (noteId, expectedAccountId) => {
    assertAccount(expectedAccountId);
    const authority = databaseManager.getTranscriptEditAuthority(noteId);
    if (!authority.canEdit) {
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
    }
    assertAccount(expectedAccountId);
  };

  return {
    applyRevision: async (_event, input) => {
      if (!input || !Object.hasOwn(input, "expectedAccountId"))
        throw new Error("Transcript account assertion is required");
      const expectedAccountId = input.expectedAccountId;
      await requireEdit(input.noteId, expectedAccountId);
      return databaseManager.applyTranscriptRevision({ ...input, expectedAccountId });
    },
    restoreVersion: async (_event, noteId, versionId, expectedVersion, expectedAccountId) => {
      await requireEdit(noteId, expectedAccountId);
      return databaseManager.restoreTranscriptVersion(
        noteId,
        versionId,
        expectedVersion,
        expectedAccountId
      );
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
