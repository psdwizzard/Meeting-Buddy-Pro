const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");

const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "meeting-buddy.db");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  audio_file_path TEXT
);

CREATE TABLE IF NOT EXISTS speakers (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  label TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  speaker_id TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  transcript TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  FOREIGN KEY (speaker_id) REFERENCES speakers(id) ON DELETE SET NULL
);
`);

const selectSpeakers = db.prepare(
  "SELECT id, meeting_id, label, display_name, created_at FROM speakers WHERE meeting_id = ? ORDER BY created_at ASC"
);
const deleteSpeakersStmt = db.prepare("DELETE FROM speakers WHERE meeting_id = ?");
const insertSpeakerStmt = db.prepare(
  "INSERT INTO speakers (id, meeting_id, label, display_name, created_at) VALUES (?, ?, ?, ?, ?)"
);

function mapMeetingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    audioFilePath: row.audio_file_path
  };
}

function attachSpeakers(meeting) {
  if (!meeting) return meeting;
  meeting.speakers = selectSpeakers.all(meeting.id).map((speaker) => ({
    id: speaker.id,
    meetingId: speaker.meeting_id,
    label: speaker.label,
    displayName: speaker.display_name,
    createdAt: speaker.created_at
  }));
  return meeting;
}

function getMeeting(meetingId) {
  const meetingRow = db
    .prepare("SELECT id, name, status, created_at, started_at, ended_at, audio_file_path FROM meetings WHERE id = ?")
    .get(meetingId);
  return attachSpeakers(mapMeetingRow(meetingRow));
}

function listMeetings() {
  const rows = db
    .prepare("SELECT id, name, status, created_at, started_at, ended_at, audio_file_path FROM meetings ORDER BY created_at DESC")
    .all();
  return rows.map((row) => attachSpeakers(mapMeetingRow(row)));
}

function resetSpeakersInternal(meetingId, speakersOrCount, now) {
  deleteSpeakersStmt.run(meetingId);
  if (Array.isArray(speakersOrCount)) {
    const items = speakersOrCount.length ? speakersOrCount : [{ label: "Speaker 1" }];
    items.forEach((speaker, index) => {
      const label = speaker.label ?? `Speaker ${index + 1}`;
      const displayName = speaker.displayName ?? label;
      insertSpeakerStmt.run(randomUUID(), meetingId, label, displayName, now);
    });
  } else {
    const count = Number.isFinite(Number(speakersOrCount)) ? Number(speakersOrCount) : 0;
    const safeCount = count > 0 ? count : 2;
    for (let index = 1; index <= safeCount; index += 1) {
      const label = `Speaker ${index}`;
      insertSpeakerStmt.run(randomUUID(), meetingId, label, label, now);
    }
  }
}

function resetSpeakers(meetingId, speakersOrCount) {
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    resetSpeakersInternal(meetingId, speakersOrCount, now);
  });
  transaction();
  return getMeeting(meetingId);
}

function createMeeting({ name, speakerCount = 2 }) {
  const now = new Date().toISOString();
  const meetingId = randomUUID();
  const insertMeeting = db.prepare(
    "INSERT INTO meetings (id, name, status, created_at) VALUES (?, ?, 'pending', ?)"
  );
  const transaction = db.transaction(() => {
    insertMeeting.run(meetingId, name, now);
    resetSpeakersInternal(meetingId, speakerCount, now);
  });
  transaction();
  return getMeeting(meetingId);
}

function updateMeeting(meetingId, updates) {
  const { name } = updates;
  if (name !== undefined) {
    db.prepare("UPDATE meetings SET name = ? WHERE id = ?").run(name, meetingId);
  }
  return getMeeting(meetingId);
}

function startMeeting(meetingId) {
  const now = new Date().toISOString();
  db.prepare("UPDATE meetings SET started_at = COALESCE(started_at, ?) WHERE id = ?").run(now, meetingId);
  return getMeeting(meetingId);
}

function endMeeting(meetingId, { audioFilePath } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE meetings SET ended_at = COALESCE(ended_at, ?), audio_file_path = COALESCE(?, audio_file_path), status = 'processing' WHERE id = ?"
  ).run(now, audioFilePath ?? null, meetingId);
  return getMeeting(meetingId);
}

function updateMeetingStatus(meetingId, status) {
  db.prepare("UPDATE meetings SET status = ? WHERE id = ?").run(status, meetingId);
  return getMeeting(meetingId);
}

function renameSpeaker(meetingId, speakerId, displayName) {
  db.prepare(
    "UPDATE speakers SET display_name = ? WHERE id = ? AND meeting_id = ?"
  ).run(displayName, speakerId, meetingId);
  return getMeeting(meetingId);
}

function addSpeaker(meetingId, displayName) {
  const meeting = getMeeting(meetingId);
  if (!meeting) {
    throw new Error("Meeting not found");
  }

  const speakerCount = meeting.speakers?.length || 0;
  const label = `Speaker ${speakerCount + 1}`;
  const now = new Date().toISOString();

  insertSpeakerStmt.run(randomUUID(), meetingId, label, displayName, now);
  return getMeeting(meetingId);
}

function storeSegments(meetingId, segments) {
  const insertSegment = db.prepare(
    "INSERT INTO segments (id, meeting_id, speaker_id, start_ms, end_ms, transcript, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const deleteSegments = db.prepare("DELETE FROM segments WHERE meeting_id = ?");
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    deleteSegments.run(meetingId);
    segments.forEach((segment) => {
      insertSegment.run(
        segment.id ?? randomUUID(),
        meetingId,
        segment.speakerId ?? null,
        segment.startMs,
        segment.endMs,
        segment.transcript,
        segment.createdAt ?? now
      );
    });
  });
  transaction();
  return getMeeting(meetingId);
}

module.exports = {
  createMeeting,
  updateMeeting,
  startMeeting,
  endMeeting,
  listMeetings,
  getMeeting,
  renameSpeaker,
  addSpeaker,
  resetSpeakers,
  storeSegments,
  updateMeetingStatus
};
