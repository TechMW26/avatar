"use client";

function camLog(...args: unknown[]) {
  console.log("[camera]", ...args);
}

/** Heuristic to detect built-in / integrated cameras (Mac FaceTime, laptop
 *  built-ins, etc.) so we can prefer external USB webcams when no explicit
 *  camera selector is configured. */
function isBuiltinCamera(label: string): boolean {
  const lower = label.toLocaleLowerCase();
  // Empty label could be an external camera that hasn't had its label
  // revealed yet — treat as NOT built-in so we prefer it over a known
  // FaceTime camera.
  if (lower.length === 0) return false;
  return (
    lower.includes("facetime") ||
    lower.includes("built-in") ||
    lower.includes("built in") ||
    lower.includes("integrated")
  );
}

/** Enumerate videoinput devices, warming permissions if ANY label is still
 *  hidden (not just when all are hidden). */
async function enumerateCameras(): Promise<MediaDeviceInfo[]> {
  let devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "videoinput",
  );

  camLog(`raw devices: ${devices.length}`, devices.map((d) => ({ id: d.deviceId.slice(0, 8), label: d.label || "(empty)" })));

  // Browsers hide camera labels until media permission has been granted.
  // Previously we only warmed when EVERY label was empty, but on macOS a
  // cached FaceTime label would short-circuit this and leave external USB
  // camera labels unresolved.  Now warm whenever ANY label is missing.
  if (devices.length > 0 && devices.some((device) => !device.label)) {
    camLog("warming camera permission (some labels missing)");
    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: true,
      });
      permissionStream.getTracks().forEach((track) => track.stop());
      devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "videoinput",
      );
      camLog(`after warm: ${devices.length} devices`, devices.map((d) => ({ id: d.deviceId.slice(0, 8), label: d.label || "(empty)" })));
    } catch (err) {
      camLog("permission warm failed:", err);
    }
  }

  // Stable sort: external cameras first so index:0 / index:1 always
  // map to USB webcams regardless of the OS enumeration order.
  devices = [...devices].sort((a, b) => {
    const aBuiltin = isBuiltinCamera(a.label) ? 1 : 0;
    const bBuiltin = isBuiltinCamera(b.label) ? 1 : 0;
    return aBuiltin - bBuiltin;
  });
  camLog(`sorted (external first):`, devices.map((d) => ({ label: d.label || "(empty)", builtin: isBuiltinCamera(d.label) })));

  return devices;
}

/** Resolve a camera by exact device id or a case-insensitive label fragment.
 *  When no selector is given, prefer external USB cameras over built-in
 *  ones (e.g. Mac FaceTime camera). */
export async function resolveCameraDeviceId(
  selector?: string | null,
): Promise<string | null> {
  if (!navigator.mediaDevices?.enumerateDevices) return null;

  const devices = await enumerateCameras();
  const requested = selector?.trim();

  camLog(`selector: "${requested || "(none)"}"`);

  // No explicit selector → prefer the first external camera.
  if (!requested) {
    if (devices.length === 0) {
      camLog("no cameras found at all");
      return null;
    }
    // Sort: external cameras first, built-in last, then pick the first.
    const sorted = [...devices].sort((a, b) => {
      const aBuiltin = isBuiltinCamera(a.label) ? 1 : 0;
      const bBuiltin = isBuiltinCamera(b.label) ? 1 : 0;
      return aBuiltin - bBuiltin;
    });
    const picked = sorted[0];
    camLog(`auto-picked: "${picked.label || "(no label)"}" (builtin=${isBuiltinCamera(picked.label)}, id=${picked.deviceId.slice(0, 8)}…)`);
    return picked.deviceId;
  }

  const indexMatch = requested.match(/^index:(\d+)$/i);
  if (indexMatch) {
    const idx = Number(indexMatch[1]);
    const dev = devices[idx];
    camLog(`index:${idx} → "${dev?.label || "(no label)"}"`);
    return dev?.deviceId ?? null;
  }

  const normalized = requested.toLocaleLowerCase();
  const match = devices.find((device) => device.deviceId === requested)
    ?? devices.find((device) => device.label.toLocaleLowerCase() === normalized)
    ?? devices.find((device) => device.label.toLocaleLowerCase().includes(normalized));
  camLog(`label match "${requested}" → "${match?.label || "NOT FOUND"}"`);
  return match?.deviceId ?? null;
}

export function getCameraSelectorFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("camera");
}

export type DisplayCameraRole = "front" | "rear";

/**
 * Camera ownership is fixed by display role. Legacy index selectors are
 * deliberately ignored so bookmarked URLs cannot swap the presentation and
 * CV feeds. A device id or label remains available as an explicit override
 * for installations whose OS enumerates cameras differently.
 */
export function getDisplayCameraSelector(role: DisplayCameraRole): string {
  const requested = getCameraSelectorFromUrl()?.trim();
  if (requested && !/^index:\d+$/i.test(requested)) return requested;
  return role === "front" ? "index:0" : "index:1";
}
