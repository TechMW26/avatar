import "server-only";

import { head, put } from "@vercel/blob";
import {
  EMPTY_REMOTE_CONTROL_STATE,
  type RemoteControlSource,
  type RemoteControlState,
} from "./remoteControlTypes";
import { isCharacterSlug, type CharacterSlug } from "./characters";

const REMOTE_STATE_PATH = "remote-control/current-character.json";
const STATE_CONTENT_TYPE_PREFIX =
  "application/vnd.bharat-darshan.remote-state.";
let memoryState: RemoteControlState = EMPTY_REMOTE_CONTROL_STATE;

function hasBlobStore(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function isRemoteControlSource(value: string): value is RemoteControlSource {
  return (
    value === "remote"
    || value === "manual"
    || value === "display-refresh"
  );
}

function encodeStateContentType(
  character: CharacterSlug | null,
  source: RemoteControlSource,
): string {
  return `${STATE_CONTENT_TYPE_PREFIX}${character ?? "none"}.${source}+json`;
}

function decodeStateContentType(
  contentType: string,
): Pick<RemoteControlState, "character" | "source"> | null {
  if (
    !contentType.startsWith(STATE_CONTENT_TYPE_PREFIX)
    || !contentType.endsWith("+json")
  ) {
    return null;
  }
  const encoded = contentType.slice(
    STATE_CONTENT_TYPE_PREFIX.length,
    -"+json".length,
  );
  const separator = encoded.lastIndexOf(".");
  if (separator < 1) return null;
  const characterValue = encoded.slice(0, separator);
  const source = encoded.slice(separator + 1);
  const character = characterValue === "none" ? null : characterValue;
  if (
    (character !== null && !isCharacterSlug(character))
    || !isRemoteControlSource(source)
  ) {
    return null;
  }
  return { character, source };
}

export async function readRemoteControlState(): Promise<RemoteControlState> {
  if (!hasBlobStore()) return memoryState;

  try {
    // Blob file contents can be cached after an overwrite, while HEAD metadata
    // changes immediately. Encoding the tiny state in content-type gives every
    // display a current, low-cost read without downloading stale JSON.
    const metadata = await head(REMOTE_STATE_PATH);
    const decoded = decodeStateContentType(metadata.contentType);
    if (!decoded) return memoryState;
    memoryState = {
      ...decoded,
      revision: metadata.etag,
      updatedAt: metadata.uploadedAt.getTime(),
    };
    return memoryState;
  } catch {
    return memoryState;
  }
}

export async function writeRemoteControlState(
  character: CharacterSlug | null,
  source: RemoteControlSource,
): Promise<RemoteControlState> {
  const nextState: RemoteControlState = {
    character,
    revision: crypto.randomUUID(),
    updatedAt: Date.now(),
    source,
  };

  if (hasBlobStore()) {
    await put(REMOTE_STATE_PATH, JSON.stringify(nextState), {
      access: "public",
      allowOverwrite: true,
      contentType: encodeStateContentType(character, source),
    });
  }

  memoryState = nextState;
  return nextState;
}
