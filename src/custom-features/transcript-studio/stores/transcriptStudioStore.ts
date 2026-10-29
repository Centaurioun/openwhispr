import { createStore, type StoreApi } from "zustand/vanilla";
import {
  createEditCommand,
  invertEditCommand,
  type ApplyEditOptions,
  type EditOperation,
  type TranscriptEditCommand,
  type TranscriptEditWorkspace,
} from "../domain/editOperations";

export interface TranscriptStudioSessionState {
  workspace: TranscriptEditWorkspace;
  undoStack: TranscriptEditCommand[];
  redoStack: TranscriptEditCommand[];
  apply: (operations: EditOperation[], options?: ApplyEditOptions) => void;
  undo: () => void;
  redo: () => void;
  reset: (workspace: TranscriptEditWorkspace) => void;
}

/** Create one in-memory session store per open note; no global key listeners are installed. */
export function createTranscriptStudioStore(
  initialWorkspace: TranscriptEditWorkspace
): StoreApi<TranscriptStudioSessionState> {
  const initial = structuredClone(initialWorkspace);
  return createStore<TranscriptStudioSessionState>((set, get) => ({
    workspace: initial,
    undoStack: [],
    redoStack: [],
    apply: (operations, options) => {
      if (operations.length === 0) return;
      const command = createEditCommand(get().workspace, operations, options);
      set((state) => ({
        workspace: command.after,
        undoStack: [...state.undoStack, command],
        redoStack: [],
      }));
    },
    undo: () => {
      const state = get();
      const command = state.undoStack[state.undoStack.length - 1];
      if (!command) return;
      const inverse = invertEditCommand(command);
      set({
        workspace: inverse.after,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, command],
      });
    },
    redo: () => {
      const state = get();
      const command = state.redoStack[state.redoStack.length - 1];
      if (!command) return;
      set({
        workspace: command.after,
        undoStack: [...state.undoStack, command],
        redoStack: state.redoStack.slice(0, -1),
      });
    },
    reset: (workspace) =>
      set({ workspace: structuredClone(workspace), undoStack: [], redoStack: [] }),
  }));
}
