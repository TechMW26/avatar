"use client";
/* eslint-disable react-hooks/set-state-in-effect -- Polling synchronizes React with a remote control service. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CharacterSlug } from "../lib/characters";
import type {
  RemoteControlSource,
  RemoteControlState,
} from "../lib/remoteControlTypes";

const POLL_INTERVAL_MS = 750;

export async function updateRemoteCharacter(
  character: CharacterSlug | null,
  source: RemoteControlSource,
  key?: string,
): Promise<RemoteControlState> {
  const response = await fetch("/api/remote-control", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "x-remote-control-key": key } : {}),
    },
    cache: "no-store",
    body: JSON.stringify({ character, source }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = (
      payload
      && typeof payload === "object"
      && "error" in payload
      && typeof payload.error === "string"
    )
      ? payload.error
      : "Remote control update failed.";
    throw new Error(message);
  }
  return payload as RemoteControlState;
}

export function useRemoteControlState(enabled = true) {
  const [state, setState] = useState<RemoteControlState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/remote-control", {
        cache: "no-store",
        signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          payload
          && typeof payload === "object"
          && "error" in payload
          && typeof payload.error === "string"
            ? payload.error
            : "Remote control is unavailable.",
        );
      }
      const next = payload as RemoteControlState;
      if (next.revision !== revisionRef.current) {
        revisionRef.current = next.revision;
        setState(next);
      }
      setError(null);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Remote control is unavailable.",
      );
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => {
      void refresh(controller.signal);
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [enabled, refresh]);

  return { state, error, refresh };
}
