import type { CharacterSlug } from "./characters";

export type RemoteControlSource = "remote" | "manual" | "display-refresh";

export interface RemoteControlState {
  character: CharacterSlug | null;
  revision: string;
  updatedAt: number;
  source: RemoteControlSource;
}

export const EMPTY_REMOTE_CONTROL_STATE: RemoteControlState = {
  character: null,
  revision: "initial",
  updatedAt: 0,
  source: "display-refresh",
};
