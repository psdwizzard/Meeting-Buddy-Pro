const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function runDiarization({
  meetingId,
  audioPath,
  device = "cuda",
  pythonPath,
  options = {}
}) {
  return new Promise((resolve, reject) => {
    if (!audioPath || !fs.existsSync(audioPath)) {
      return reject(new Error(`Audio file not found for diarization: ${audioPath}`));
    }

    const scriptPath = path.join(
      __dirname,
      "..",
      "services",
      "diarization",
      "run.py"
    );
    const outputDir = path.join(__dirname, "..", "data", "outputs", meetingId);
    fs.mkdirSync(outputDir, { recursive: true });

    const args = [
      scriptPath,
      "--meeting",
      meetingId,
      "--out",
      outputDir,
      "--audio",
      audioPath
    ];

    if (device) {
      args.push("--device", device);
    }

    const envOptions = {
      whisperModel: process.env.DIARIZATION_WHISPER_MODEL,
      batchSize: process.env.DIARIZATION_BATCH_SIZE,
      language: process.env.DIARIZATION_LANGUAGE,
      disableStem: process.env.DIARIZATION_DISABLE_STEM === "1",
      suppressNumerals: process.env.DIARIZATION_SUPPRESS_NUMERALS === "1",
      logLevel: process.env.DIARIZATION_LOG_LEVEL,
      minSpeakers: process.env.DIARIZATION_MIN_SPEAKERS,
      maxSpeakers: process.env.DIARIZATION_MAX_SPEAKERS
    };

    const merged = { ...envOptions, ...options };

    if (merged.whisperModel) {
      args.push("--whisper-model", merged.whisperModel);
    }
    if (merged.batchSize && Number.isFinite(Number(merged.batchSize))) {
      args.push("--batch-size", String(merged.batchSize));
    }
    if (merged.language) {
      args.push("--language", merged.language);
    }
    if (merged.disableStem) {
      args.push("--no-stem");
    }
    if (merged.suppressNumerals) {
      args.push("--suppress-numerals");
    }
    if (merged.logLevel) {
      args.push("--log-level", merged.logLevel);
    }
    if (merged.minSpeakers && Number.isFinite(Number(merged.minSpeakers))) {
      args.push("--min-speakers", String(merged.minSpeakers));
    }
    if (merged.maxSpeakers && Number.isFinite(Number(merged.maxSpeakers))) {
      args.push("--max-speakers", String(merged.maxSpeakers));
    }

    const pythonExecutable = pythonPath ?? process.env.MBP_PYTHON ?? "python";

    const subprocess = spawn(pythonExecutable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        PYTHONPATH: [
          path.join(__dirname, "..", "services"),
          path.join(__dirname, "..", "whisper-diarization")
        ]
          .concat(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])
          .join(path.delimiter)
      }
    });

    let stdout = "";
    let stderr = "";

    subprocess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    subprocess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    subprocess.on("error", (error) => {
      reject(error);
    });

    subprocess.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`Diarization process exited with code ${code}.\n${stderr || stdout}`)
        );
      }
      resolve({ stdout, stderr, outputDir });
    });
  });
}

module.exports = {
  runDiarization
};
