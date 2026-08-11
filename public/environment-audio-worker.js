/* global Audio, importScripts */

let classifier = null;
let initializing = null;

async function initialize() {
  if (classifier) return classifier;
  if (initializing) return initializing;

  initializing = (async () => {
    importScripts("/mediapipe/audio_bundle.js");
    const fileset = await Audio.FilesetResolver.forAudioTasks(
      "/mediapipe/audio-wasm",
    );
    classifier = await Audio.AudioClassifier.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: "/mediapipe/models/yamnet.tflite",
        delegate: "CPU",
      },
      maxResults: 8,
      scoreThreshold: 0.08,
    });
    return classifier;
  })();

  try {
    return await initializing;
  } finally {
    initializing = null;
  }
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      await initialize();
      self.postMessage({ type: "ready" });
      return;
    }

    if (message.type !== "classify" || !message.samples) return;
    const activeClassifier = await initialize();
    const results = activeClassifier.classify(
      new Float32Array(message.samples),
      message.sampleRate,
    );
    const categories = results.flatMap((result) =>
      result.classifications.flatMap((classification) =>
        classification.categories.map((category) => ({
          name: category.categoryName,
          score: category.score,
        })),
      ),
    );
    self.postMessage({ type: "result", categories });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
