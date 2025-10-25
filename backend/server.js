const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const express = require("express");
const path = require("path");
const { runDiarization } = require("./diarization");
const storage = require("./storage");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3410;


const uploadsRoot = path.join(__dirname, "..", "data", "audio");
const outputsRoot = path.join(process.cwd(), "data", "outputs");
fs.mkdirSync(uploadsRoot, { recursive: true });
fs.mkdirSync(outputsRoot, { recursive: true });

const maxUploadBytes = Number(process.env.MAX_AUDIO_UPLOAD_BYTES || 536870912);
const uploadStorage = multer.diskStorage({
  destination: (request, file, callback) => {
    const meetingDir = path.join(uploadsRoot, request.params.meetingId || "misc");
    fs.mkdirSync(meetingDir, { recursive: true });
    callback(null, meetingDir);
  },
  filename: (request, file, callback) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const extension = path.extname(file.originalname || "") || ".wav";
    callback(null, `${timestamp}${extension}`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: maxUploadBytes },
  fileFilter: (request, file, callback) => {
    if (file.mimetype && file.mimetype.startsWith("audio/")) {
      callback(null, true);
    } else {
      callback(new Error("Only audio files are allowed"));
    }
  }
});


function resolveMeetingFiles(meetingId) {
  const files = {};
  const fileMap = {
    csv: "segments.csv",
    srt: "segments.srt",
    txt: "transcript.txt",
    json: "diarization.json"
  };

  const meetingDir = path.join(outputsRoot, meetingId);
  for (const [key, fileName] of Object.entries(fileMap)) {
    const candidate = path.join(meetingDir, fileName);
    if (fs.existsSync(candidate)) {
      files[key] = `/api/meetings/${meetingId}/files/${key}`;
    }
  }
  return files;
}

function buildMeetingPayload(meeting) {
  if (!meeting) return null;
  return {
    ...meeting,
    files: resolveMeetingFiles(meeting.id)
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

function replaceSpeakerPrefixes(content, replacements) {
  let output = content;
  replacements.forEach((displayName, label) => {
    if (!displayName || displayName === label) {
      return;
    }
    const pattern = new RegExp('(^|\\r?\\n)' + escapeRegExp(label) + '(?=\\s*:)', 'g');
    output = output.replace(pattern, function (match, prefix) {
      return prefix + displayName;
    });
  });
  return output;
}

function applySpeakerNamesToTextFile(filePath, replacements) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const original = fs.readFileSync(filePath, "utf-8");
  const nextContent = replaceSpeakerPrefixes(original, replacements);
  if (nextContent === original) {
    return false;
  }
  fs.writeFileSync(filePath, nextContent, "utf-8");
  return true;
}

function applySpeakerNamesToCsv(filePath, replacements) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const original = fs.readFileSync(filePath, "utf-8");
  const rows = original.split(/\r?\n/);
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = original.endsWith("\r\n") || original.endsWith("\n");
  let changed = false;
  const updated = rows.map((row, index) => {
    if (index === 0 || !row.trim()) {
      return row;
    }
    const commaIndex = row.indexOf(",");
    if (commaIndex === -1) {
      return row;
    }
    const rawSpeaker = row.slice(0, commaIndex);
    const trimmedSpeaker = rawSpeaker.trim();
    const nextName = replacements.get(trimmedSpeaker);
    if (!nextName || nextName === trimmedSpeaker) {
      return row;
    }
    const leadingWhitespaceMatch = /^\s*/.exec(rawSpeaker);
    const trailingWhitespaceMatch = /\s*$/.exec(rawSpeaker);
    const leadingWhitespace = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : "";
    const trailingWhitespace = trailingWhitespaceMatch ? trailingWhitespaceMatch[0] : "";
    changed = true;
    return leadingWhitespace + nextName + trailingWhitespace + row.slice(commaIndex);
  });
  if (!changed) {
    return false;
  }
  let nextContent = updated.join(newline);
  if (hadTrailingNewline && !nextContent.endsWith(newline)) {
    nextContent += newline;
  }
  fs.writeFileSync(filePath, nextContent, "utf-8");
  return true;
}

function applySpeakerNamesToJson(filePath, replacements) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const original = fs.readFileSync(filePath, "utf-8");
  let payload;
  try {
    payload = JSON.parse(original);
  } catch (error) {
    console.error('[meeting-buddy] Failed to parse diarization JSON at ' + filePath, error);
    return false;
  }
  let changed = false;

  if (Array.isArray(payload.speakers)) {
    payload.speakers.forEach((speaker) => {
      if (!speaker || typeof speaker !== "object") {
        return;
      }
      const originalLabel = speaker.originalLabel || speaker.label;
      const nextName = originalLabel ? replacements.get(originalLabel) : null;
      if (originalLabel && !speaker.originalLabel) {
        speaker.originalLabel = originalLabel;
        changed = true;
      }
      if (nextName && speaker.displayName !== nextName) {
        speaker.displayName = nextName;
        changed = true;
      }
    });
  }

  if (Array.isArray(payload.segments)) {
    payload.segments.forEach((segment) => {
      if (!segment || typeof segment !== "object") {
        return;
      }
      const originalLabel = segment.originalSpeakerLabel || segment.speakerLabel;
      const nextName = originalLabel ? replacements.get(originalLabel) : null;
      if (originalLabel && !segment.originalSpeakerLabel) {
        segment.originalSpeakerLabel = originalLabel;
        changed = true;
      }
      if (nextName) {
        if (segment.speakerLabel !== nextName) {
          segment.speakerLabel = nextName;
          changed = true;
        }
        if (segment.speakerDisplayName !== nextName) {
          segment.speakerDisplayName = nextName;
          changed = true;
        }
      }
    });
  }

  if (payload.speakerStats && typeof payload.speakerStats === "object") {
    const updatedStats = {};
    let statsChanged = false;
    for (const [key, value] of Object.entries(payload.speakerStats)) {
      if (value && typeof value === "object" && !value.originalLabel) {
        value.originalLabel = key;
        changed = true;
      }
      const originalLabel = value && typeof value === "object" && value.originalLabel ? value.originalLabel : key;
      const nextName = originalLabel ? replacements.get(originalLabel) : null;
      const targetKey = nextName || key;
      if (targetKey !== key) {
        statsChanged = true;
      }
      updatedStats[targetKey] = value;
    }
    if (statsChanged) {
      payload.speakerStats = updatedStats;
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }
  payload.updatedSpeakerNamesAt = new Date().toISOString();
  const nextJson = JSON.stringify(payload, null, 2) + "\n";
  fs.writeFileSync(filePath, nextJson, "utf-8");
  return true;
}

function applySpeakerNamesToExports(meeting) {
  if (!meeting || !Array.isArray(meeting.speakers) || !meeting.speakers.length) {
    return { updated: false, files: [] };
  }

  const replacements = new Map();
  meeting.speakers.forEach((speaker) => {
    const label = speaker && speaker.label;
    const displayName = speaker && typeof speaker.displayName === "string" ? speaker.displayName.trim() : "";
    if (!label || !displayName || displayName === label) {
      return;
    }
    replacements.set(label, displayName);
  });

  if (!replacements.size) {
    return { updated: false, files: [] };
  }

  const updatedFiles = [];
  const baseDir = path.join(outputsRoot, meeting.id || "");
  const transcriptPath = path.join(baseDir, "transcript.txt");
  const srtPath = path.join(baseDir, "segments.srt");
  const csvPath = path.join(baseDir, "segments.csv");
  const jsonPath = path.join(baseDir, "diarization.json");

  if (applySpeakerNamesToTextFile(transcriptPath, replacements)) {
    updatedFiles.push("transcript.txt");
  }
  if (applySpeakerNamesToTextFile(srtPath, replacements)) {
    updatedFiles.push("segments.srt");
  }
  if (applySpeakerNamesToCsv(csvPath, replacements)) {
    updatedFiles.push("segments.csv");
  }
  if (applySpeakerNamesToJson(jsonPath, replacements)) {
    updatedFiles.push("diarization.json");
  }

  return { updated: updatedFiles.length > 0, files: updatedFiles };
}
app.use(cors({ origin: true, credentials: false }));
app.use((request, response, next) => {
  const origin = request.headers.origin || '*';
  response.header('Access-Control-Allow-Origin', origin);
  response.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  response.header('Access-Control-Allow-Headers', 'Content-Type,Accept');
  if (request.method === 'OPTIONS') {
    return response.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: "50mb" }));
app.use((request, response, next) => {
  console.log(`[meeting-buddy] ${request.method} ${request.url}`);
  next();
});

app.get("/api/health", (request, response) => {
  response.json({
    status: "ok",
    time: new Date().toISOString(),
    meetings: storage.listMeetings().length
  });
});

app.get("/api/meetings", (request, response) => {
  const meetings = storage.listMeetings().map(buildMeetingPayload);
  response.json({ meetings });
});

app.post("/api/meetings", (request, response) => {
  const { name, speakerCount } = request.body ?? {};
  if (!name || !name.trim()) {
    return response.status(400).json({ error: "Meeting name is required" });
  }
  const safeCount = speakerCount && Number.isFinite(Number(speakerCount)) ? Number(speakerCount) : 2;
  const meeting = storage.createMeeting({ name: name.trim(), speakerCount: safeCount });
  return response.status(201).json({ meeting: buildMeetingPayload(meeting) });
});

app.patch("/api/meetings/:meetingId", (request, response) => {
  const { meetingId } = request.params;
  const { name } = request.body ?? {};

  const meeting = storage.getMeeting(meetingId);
  if (!meeting) {
    return response.status(404).json({ error: "Meeting not found" });
  }

  if (!name || !name.trim()) {
    return response.status(400).json({ error: "Meeting name is required" });
  }

  const updated = storage.updateMeeting(meetingId, { name: name.trim() });
  response.json({ meeting: buildMeetingPayload(updated) });
});

app.post("/api/meetings/:meetingId/start", (request, response) => {
  const { meetingId } = request.params;
  const meeting = storage.getMeeting(meetingId);
  if (!meeting) {
    return response.status(404).json({ error: "Meeting not found" });
  }
  const updated = storage.startMeeting(meetingId);
  response.json({ meeting: buildMeetingPayload(updated) });
});

app.patch("/api/meetings/:meetingId/speakers/:speakerId", (request, response) => {
  const { meetingId, speakerId } = request.params;
  const { displayName } = request.body ?? {};

  const meeting = storage.getMeeting(meetingId);
  if (!meeting) {
    return response.status(404).json({ error: "Meeting not found" });
  }

  if (!displayName || !displayName.trim()) {
    return response.status(400).json({ error: "Speaker display name is required" });
  }

  const updated = storage.renameSpeaker(meetingId, speakerId, displayName.trim());
  response.json({ meeting: buildMeetingPayload(updated) });
});

app.post("/api/meetings/:meetingId/speakers", (request, response) => {
  const { meetingId } = request.params;
  const { displayName } = request.body ?? {};

  const meeting = storage.getMeeting(meetingId);
  if (!meeting) {
    return response.status(404).json({ error: "Meeting not found" });
  }

  if (!displayName || !displayName.trim()) {
    return response.status(400).json({ error: "Speaker display name is required" });
  }

  const updated = storage.addSpeaker(meetingId, displayName.trim());
  response.json({ meeting: buildMeetingPayload(updated) });
});


app.get("/api/meetings/:meetingId/files/:type", (request, response) => {
  const { meetingId, type } = request.params;
  const lookup = {
    csv: "segments.csv",
    srt: "segments.srt",
    txt: "transcript.txt",
    json: "diarization.json"
  };
  const fileName = lookup[type];
  if (!fileName) {
    return response.status(404).json({ error: "Unsupported file type" });
  }
  const filePath = path.join(outputsRoot, meetingId, fileName);
  if (!fs.existsSync(filePath)) {
    return response.status(404).json({ error: "File not found" });
  }
  response.sendFile(filePath);
});

app.post(
  "/api/meetings/:meetingId/audio",
  (request, response, next) => {
    upload.single("audio")(request, response, (error) => {
      if (error) {
        console.error(`[meeting-buddy] Audio upload failed`, error);
        const message = error.message || "Audio upload failed";
        return response.status(400).json({ error: message });
      }
      next();
    });
  },
  (request, response) => {
    const { meetingId } = request.params;
    const meeting = storage.getMeeting(meetingId);
    if (!meeting) {
      if (request.file) {
        try {
          fs.unlinkSync(request.file.path);
        } catch (unlinkError) {
          console.warn(`[meeting-buddy] Failed to clean uploaded file`, unlinkError);
        }
      }
      return response.status(404).json({ error: "Meeting not found" });
    }

    if (!request.file) {
      return response.status(400).json({ error: "Audio file is required" });
    }

    const audioPath = request.file.path;
    const updated = storage.endMeeting(meetingId, { audioFilePath: audioPath });
    response.json({ meeting: updated, audioPath });

    queueMicrotask(() => handleDiarization(meetingId, audioPath));
  }
);

app.post("/api/meetings/:meetingId/end", (request, response) => {
  const { meetingId } = request.params;
  const { audioFilePath } = request.body ?? {};
  const meeting = storage.getMeeting(meetingId);
  if (!meeting) {
    return response.status(404).json({ error: "Meeting not found" });
  }
  const updated = storage.endMeeting(meetingId, { audioFilePath });
  response.json({ meeting: buildMeetingPayload(updated) });

  if (audioFilePath) {
    queueMicrotask(() => handleDiarization(meetingId, audioFilePath));
  } else {
    console.warn(`[meeting-buddy] No audio provided for meeting ${meetingId}; diarization skipped.`);
    storage.updateMeetingStatus(meetingId, "failed");
  }
});

app.patch("/api/meetings/:meetingId/speakers/:speakerId", (request, response) => {
  const { meetingId, speakerId } = request.params;
  const { displayName } = request.body ?? {};
  if (!displayName || !displayName.trim()) {
    return response.status(400).json({ error: "displayName is required" });
  }
  const meeting = storage.getMeeting(meetingId);
  if (!meeting) {
    return response.status(404).json({ error: "Meeting not found" });
  }
  const speakerExists = meeting.speakers.some((speaker) => speaker.id === speakerId);
  if (!speakerExists) {
    return response.status(404).json({ error: "Speaker not found" });
  }
  const updated = storage.renameSpeaker(meetingId, speakerId, displayName.trim());
  response.json({ meeting: buildMeetingPayload(updated) });
});
app.post("/api/meetings/:meetingId/speakers/apply", (request, response) => {
  const { meetingId } = request.params;
  const meeting = storage.getMeeting(meetingId);
  if (!meeting) {
    return response.status(404).json({ error: "Meeting not found" });
  }
  const result = applySpeakerNamesToExports(meeting);
  const refreshed = storage.getMeeting(meetingId);
  response.json({
    meeting: buildMeetingPayload(refreshed),
    files: result.files,
    updated: result.updated
  });
});

app.post("/api/meetings/:meetingId/reprocess", (request, response) => {
  const { meetingId } = request.params;
  const { whisperModel } = request.body ?? {};

  const meeting = storage.getMeeting(meetingId);
  if (!meeting) {
    return response.status(404).json({ error: "Meeting not found" });
  }
  if (!meeting.audioFilePath) {
    return response.status(400).json({ error: "No audio available for this meeting" });
  }

  const resolvedAudioPath = path.resolve(meeting.audioFilePath);
  if (!fs.existsSync(resolvedAudioPath)) {
    return response.status(400).json({ error: "Meeting audio file is missing" });
  }

  const trimmedModel = typeof whisperModel === "string" ? whisperModel.trim() : "";
  const modelOverride = trimmedModel ? trimmedModel : undefined;

  const overrides = modelOverride ? { whisperModel: modelOverride } : {};
  const processingMeeting = storage.updateMeetingStatus(meetingId, "processing");

  queueMicrotask(() => {
    handleDiarization(meetingId, meeting.audioFilePath, overrides);
  });

  response.json({
    meeting: buildMeetingPayload(processingMeeting),
    whisperModel: modelOverride ?? process.env.DIARIZATION_WHISPER_MODEL ?? null,
    status: "processing"
  });
});

app.post("/api/meetings/:meetingId/speakers/sync-count", (request, response) => {
  const { meetingId } = request.params;
  const { count } = request.body ?? {};

  const meeting = storage.getMeeting(meetingId);
  if (!meeting) {
    return response.status(404).json({ error: "Meeting not found" });
  }

  const numericCount = Number(count);
  if (!Number.isFinite(numericCount) || numericCount < 1) {
    return response.status(400).json({ error: "count must be at least 1" });
  }

  const safeCount = Math.min(50, Math.floor(numericCount));
  const updated = storage.ensureSpeakerCount(meetingId, safeCount);
  response.json({ meeting: buildMeetingPayload(updated) });
});

app.post("/api/meetings/:meetingId/speakers/reset", (request, response) => {
  const { meetingId } = request.params;
  const { count, speakers } = request.body ?? {};
  const meeting = storage.getMeeting(meetingId);
  if (!meeting) {
    return response.status(404).json({ error: "Meeting not found" });
  }
  const updated = Array.isArray(speakers)
    ? storage.resetSpeakers(meetingId, speakers)
    : storage.resetSpeakers(meetingId, count);
  response.json({ meeting: buildMeetingPayload(updated) });
});

app.use((error, request, response, next) => {
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`[meeting-buddy] API listening on http://127.0.0.1:${PORT}`);
});

async function handleDiarization(meetingId, audioPath, options = {}) {
  const device = process.env.DIARIZATION_DEVICE ?? "cuda";
  const pythonPath = process.env.DIARIZATION_PYTHON;

  if (!audioPath) {
    console.error(`[meeting-buddy] Audio path missing for meeting ${meetingId}`);
    storage.updateMeetingStatus(meetingId, "failed");
    return;
  }

  const resolvedAudioPath = path.resolve(audioPath);
  if (!fs.existsSync(resolvedAudioPath)) {
    console.error(
      `[meeting-buddy] Audio file missing for meeting ${meetingId}: ${resolvedAudioPath}`
    );
    storage.updateMeetingStatus(meetingId, "failed");
    return;
  }

  try {
    const result = await runDiarization({
      meetingId,
      audioPath: resolvedAudioPath,
      device,
      pythonPath,
      options
    });

    const trimmed = result.stdout.trim();
    let payload;

    if (trimmed) {
      const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const candidate = lines[index].trim();
        try {
          payload = JSON.parse(candidate);
          break;
        } catch {
          // continue searching through stdout lines
        }
      }
    }

    if (!payload) {
      const jsonPath = path.join(result.outputDir, "diarization.json");
      if (fs.existsSync(jsonPath)) {
        const filePayload = fs.readFileSync(jsonPath, "utf-8");
        payload = JSON.parse(filePayload);
      }
    }

    if (!payload) {
      throw new Error("Diarization payload missing");
    }

    if (Array.isArray(payload.speakers) && payload.speakers.length) {
      const updatedMeeting = storage.resetSpeakers(meetingId, payload.speakers);
      const labelToSpeakerId = new Map(
        updatedMeeting.speakers.map((speaker) => [speaker.label, speaker.id])
      );
      if (Array.isArray(payload.segments) && payload.segments.length) {
        const normalizedSegments = payload.segments.map((segment) => ({
          id: segment.id,
          startMs: segment.startMs ?? Math.round((segment.start ?? 0) * 1000),
          endMs: segment.endMs ?? Math.round((segment.end ?? 0) * 1000),
          transcript: segment.transcript ?? segment.text ?? "",
          speakerId:
            segment.speakerId ??
            labelToSpeakerId.get(segment.speakerLabel ?? segment.speaker) ??
            null,
          createdAt: segment.createdAt
        }));
        storage.storeSegments(meetingId, normalizedSegments);
      }
    }

    const nextStatus = payload.status && typeof payload.status === "string" ? payload.status : "done";
    storage.updateMeetingStatus(meetingId, nextStatus);
  } catch (error) {
    console.error(`[meeting-buddy] Diarization failed for ${meetingId}`, error);
    storage.updateMeetingStatus(meetingId, "failed");
  }
}


