"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  updateRemoteCharacter,
  useRemoteControlState,
} from "./hooks/useRemoteControl";
import {
  CHARACTERS,
  CHARACTER_STORAGE_KEY,
  type CharacterProfile,
} from "./lib/characters";
import styles from "./selection.module.css";

function navigateToCharacter(character: CharacterProfile) {
  window.localStorage.setItem(CHARACTER_STORAGE_KEY, character.slug);

  const current = new URL(window.location.href);
  const talkUrl = new URL("/talk", window.location.origin);
  talkUrl.searchParams.set("character", character.slug);

  const dual = current.searchParams.get("dual");
  const camera = current.searchParams.get("camera");
  if (dual) talkUrl.searchParams.set("dual", dual);
  if (camera) talkUrl.searchParams.set("camera", camera);

  window.location.assign(talkUrl);
}

export default function Home() {
  const [isResetting, setIsResetting] = useState(true);
  const [pendingCharacter, setPendingCharacter] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const remoteControl = useRemoteControlState(!isResetting);

  useEffect(() => {
    document.title = "Choose Your Guide · Bharat Darshan AI";
    window.localStorage.removeItem(CHARACTER_STORAGE_KEY);
    void updateRemoteCharacter(null, "display-refresh")
      .catch((error) => {
        setSelectionError(
          error instanceof Error ? error.message : "Remote control is unavailable.",
        );
      })
      .finally(() => setIsResetting(false));
  }, []);

  useEffect(() => {
    if (!isResetting && remoteControl.state?.character) {
      const selected = CHARACTERS.find(
        (character) => character.slug === remoteControl.state?.character,
      );
      if (selected) navigateToCharacter(selected);
    }
  }, [isResetting, remoteControl.state]);

  const selectCharacter = useCallback(async (character: CharacterProfile) => {
    setPendingCharacter(character.slug);
    setSelectionError(null);
    try {
      await updateRemoteCharacter(character.slug, "manual");
      navigateToCharacter(character);
    } catch (error) {
      setSelectionError(
        error instanceof Error ? error.message : "Character selection failed.",
      );
      setPendingCharacter(null);
    }
  }, []);

  return (
    <main className={styles.page}>
      <div className={styles.ambient} aria-hidden="true">
        <span className={styles.orbOne} />
        <span className={styles.orbTwo} />
        <span className={styles.grid} />
      </div>

      <header className={styles.header}>
        <div className={styles.eyebrow}>
          <span />
          भारत दर्शन · Living History
          <span />
        </div>
        <h1>Choose your guide</h1>
        <p>
          इतिहास के तीन महान व्यक्तित्वों में से अपना संवाद साथी चुनें
        </p>
      </header>

      <section className={styles.cards} aria-label="Available historical guides">
        {CHARACTERS.map((character, index) => (
          <button
            key={character.slug}
            type="button"
            className={styles.card}
            style={{
              "--character-accent": character.accent,
              "--character-accent-dark": character.accentDark,
            } as React.CSSProperties}
            onClick={() => selectCharacter(character)}
            disabled={isResetting || pendingCharacter !== null}
            aria-label={`Choose ${character.name}`}
          >
            <div className={styles.cardVisual}>
              <Image
                src="/og-image.png"
                alt=""
                fill
                priority={index === 0}
                sizes="(max-width: 760px) 86vw, 30vw"
                className={styles.portrait}
              />
              <div className={styles.visualShade} />
              <span className={styles.number}>0{index + 1}</span>
              <span className={styles.era}>{character.era}</span>
            </div>

            <div className={styles.cardBody}>
              <div>
                <p className={styles.hindiName}>{character.hindiName}</p>
                <h2>{character.name}</h2>
              </div>
              <p className={styles.role}>{character.role}</p>
              <p className={styles.description}>{character.description}</p>
              <span className={styles.chooseAction}>
                Begin conversation
                <span aria-hidden="true">→</span>
              </span>
            </div>
          </button>
        ))}
      </section>

      <p className={styles.footnote}>
        {selectionError || remoteControl.error
          ? selectionError || remoteControl.error
          : "Each guide has an independent voice, historical perspective, and knowledge base."}
      </p>
    </main>
  );
}
