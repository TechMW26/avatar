"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import {
  CHARACTERS,
  getCharacter,
  type CharacterSlug,
} from "../lib/characters";
import {
  updateRemoteCharacter,
  useRemoteControlState,
} from "../hooks/useRemoteControl";
import styles from "./remote.module.css";

function getRemoteKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("key") || undefined;
}

export default function RemoteControlPage() {
  const { state, error, refresh } = useRemoteControlState(true);
  const [pending, setPending] = useState<CharacterSlug | "reset" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Remote Control · Bharat Darshan AI";
  }, []);

  const select = async (character: CharacterSlug | null) => {
    setPending(character ?? "reset");
    setActionError(null);
    try {
      await updateRemoteCharacter(character, "remote", getRemoteKey());
      await refresh();
    } catch (selectionError) {
      setActionError(
        selectionError instanceof Error
          ? selectionError.message
          : "Could not update the display.",
      );
    } finally {
      setPending(null);
    }
  };

  const activeCharacter = state?.character
    ? getCharacter(state.character)
    : null;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Bharat Darshan · Display Control</p>
          <h1>Remote character control</h1>
          <p className={styles.subtitle}>
            Select a guide to switch the installation immediately.
          </p>
        </div>
        <div
          className={`${styles.connection} ${error ? styles.connectionError : ""}`}
          role="status"
        >
          <span />
          {error ? "Connection issue" : "Live"}
        </div>
      </header>

      <section className={styles.statusCard} aria-live="polite">
        <div className={styles.statusIcon}>
          {activeCharacter ? activeCharacter.hindiName.slice(0, 1) : "—"}
        </div>
        <div className={styles.statusCopy}>
          <span>Current display state</span>
          <strong>
            {activeCharacter
              ? activeCharacter.name
              : state
                ? "Waiting on selection screen"
                : "Connecting to display…"}
          </strong>
          {state?.updatedAt ? (
            <small>
              Updated {new Date(state.updatedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </small>
          ) : null}
        </div>
        <button
          type="button"
          className={styles.resetButton}
          disabled={pending !== null || state?.character === null}
          onClick={() => void select(null)}
        >
          {pending === "reset" ? "Resetting…" : "Return to selection"}
        </button>
      </section>

      <section className={styles.characterGrid} aria-label="Remote character choices">
        {CHARACTERS.map((character) => {
          const isActive = state?.character === character.slug;
          const isPending = pending === character.slug;
          return (
            <button
              key={character.slug}
              type="button"
              className={`${styles.characterCard} ${isActive ? styles.activeCard : ""}`}
              style={{
                "--remote-accent": character.accent,
              } as React.CSSProperties}
              disabled={pending !== null}
              onClick={() => void select(character.slug)}
              aria-pressed={isActive}
            >
              <div className={styles.portrait}>
                <Image
                  src="/og-image.png"
                  alt=""
                  fill
                  sizes="(max-width: 680px) 32vw, 220px"
                />
              </div>
              <div className={styles.characterCopy}>
                <span>{character.hindiName}</span>
                <strong>{character.name}</strong>
                <small>{character.role}</small>
              </div>
              <div className={styles.actionIcon} aria-hidden="true">
                {isPending ? "…" : isActive ? "✓" : "→"}
              </div>
            </button>
          );
        })}
      </section>

      {(actionError || error) && (
        <p className={styles.error} role="alert">
          {actionError || error}
        </p>
      )}

      <p className={styles.note}>
        Refreshing either installation display clears the active guide and
        updates this remote automatically.
      </p>
    </main>
  );
}
