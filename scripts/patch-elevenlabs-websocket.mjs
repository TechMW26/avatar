import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sdkFile = fileURLToPath(
  new URL(
    "../node_modules/@elevenlabs/client/dist/utils/WebSocketConnection.js",
    import.meta.url,
  ),
);

const unsafeImplementation = `    close() {
        this.pendingAudioEvents = [];
        this.socket.close(1000, "User ended conversation");
    }
    sendMessage(message) {
        this.socket.send(JSON.stringify(message));
    }`;

const guardedImplementation = `    close() {
        this.pendingAudioEvents = [];
        if (this.socket.readyState === 0 || this.socket.readyState === 1) {
            this.socket.close(1000, "User ended conversation");
        }
    }
    sendMessage(message) {
        if (this.socket.readyState !== 1) {
            return;
        }
        this.socket.send(JSON.stringify(message));
    }`;

const source = await readFile(sdkFile, "utf8");

if (!source.includes(guardedImplementation)) {
  if (!source.includes(unsafeImplementation)) {
    throw new Error(
      "Unsupported @elevenlabs/client WebSocketConnection layout; update the compatibility patch.",
    );
  }
  await writeFile(
    sdkFile,
    source.replace(unsafeImplementation, guardedImplementation),
    "utf8",
  );
}
