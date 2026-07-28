import { NextResponse } from "next/server";
import {
  isCharacterSlug,
  type CharacterSlug,
} from "../../lib/characters";
import {
  readRemoteControlState,
  writeRemoteControlState,
} from "../../lib/remoteControlStore";
import type { RemoteControlSource } from "../../lib/remoteControlTypes";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

function isAuthorized(request: Request): boolean {
  const requiredKey = process.env.REMOTE_CONTROL_KEY;
  if (!requiredKey) return true;
  return request.headers.get("x-remote-control-key") === requiredKey;
}

export async function GET() {
  try {
    const state = await readRemoteControlState();
    return NextResponse.json(state, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[remote-control] read failed:", error);
    return NextResponse.json(
      { error: "Remote control is temporarily unavailable." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Invalid remote-control key." },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Invalid request body." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const candidate = body as {
      character?: unknown;
      source?: unknown;
    };
    const character = candidate.character;
    if (character !== null && !isCharacterSlug(
      typeof character === "string" ? character : null,
    )) {
      return NextResponse.json(
        { error: "Unknown character." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const source: RemoteControlSource =
      candidate.source === "manual" || candidate.source === "display-refresh"
        ? candidate.source
        : "remote";
    const selectedCharacter = character as CharacterSlug | null;
    const state = await writeRemoteControlState(selectedCharacter, source);
    return NextResponse.json(state, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[remote-control] update failed:", error);
    return NextResponse.json(
      { error: "Remote control could not be updated." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
