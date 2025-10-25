import { useEffect, useMemo, useRef, useState } from "react";
import "./index.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3410";

const statusLabels = {
  pending: "Pending",
  processing: "Processing",
  done: "Done",
  failed: "Failed"
};

function formatDate(value) {
  if (!value) return "--";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "--";
  return dt.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60)
    .toString()
    .padStart(2, "0");
  const remainingSeconds = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function mimeTypeToExtension(mimeType) {
  if (!mimeType) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return window.btoa(binary);
}

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/wav"
  ];
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function detectSpeakerCountFromTranscript(content) {
  if (!content) {
    return 0;
  }
  const regex = /Speaker\s+(\d+)\s*:/gi;
  let max = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      max = Math.max(max, value);
    }
  }
  return max;
}

function pickFirstAudioFile(fileList = []) {
  const candidates = Array.from(fileList);
  if (!candidates.length) {
    return null;
  }
  return candidates.find((file) => {
    if (!file) return false;
    if (file.type && file.type.startsWith('audio/')) {
      return true;
    }
    return /\.(wav|mp3|m4a|aac|ogg|webm)$/i.test(file.name || '');
  }) ?? null;
}

export default function App() {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newMeetingName, setNewMeetingName] = useState("");
  const [error, setError] = useState("");
  const [actionMeetingId, setActionMeetingId] = useState(null);
  const [uploadingMeetingId, setUploadingMeetingId] = useState(null);
  const [recordingMeetingId, setRecordingMeetingId] = useState(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [selectedMeetingId, setSelectedMeetingId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingMeetingName, setEditingMeetingName] = useState(false);
  const [transcriptContent, setTranscriptContent] = useState("");
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [editingSpeakerId, setEditingSpeakerId] = useState(null);
  const [applyingSpeakerNamesMeetingId, setApplyingSpeakerNamesMeetingId] = useState(null);
  const [diarizationModel, setDiarizationModel] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [reprocessingMeetingId, setReprocessingMeetingId] = useState(null);
  const [syncingSpeakerCountMeetingId, setSyncingSpeakerCountMeetingId] = useState(null);
  const [draggingUploadMeetingId, setDraggingUploadMeetingId] = useState(null);

  const fileInputsRef = useRef({});
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);

  const sortedMeetings = useMemo(() => {
    return [...meetings].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [meetings]);

  const selectedMeeting = useMemo(() => {
    return meetings.find(m => m.id === selectedMeetingId);
  }, [meetings, selectedMeetingId]);

  const filteredMeetings = useMemo(() => {
    if (!searchQuery.trim()) return sortedMeetings;
    const query = searchQuery.toLowerCase();
    return sortedMeetings.filter(m =>
      m.name?.toLowerCase().includes(query) ||
      m.speakers?.some(s => s.displayName?.toLowerCase().includes(query))
    );
  }, [sortedMeetings, searchQuery]);

  const isApplyingSpeakerNames = applyingSpeakerNamesMeetingId === selectedMeeting?.id;
  const canApplySpeakerNames = Boolean(
    selectedMeeting?.files?.txt ||
    selectedMeeting?.files?.srt ||
    selectedMeeting?.files?.csv
  );
  const isSyncingSpeakers = syncingSpeakerCountMeetingId === selectedMeeting?.id;
  const isReprocessing = reprocessingMeetingId === selectedMeeting?.id;
  const isUploadDragTarget = draggingUploadMeetingId === selectedMeeting?.id;
  const activeModelLabel = useMemo(() => {
    if (!diarizationModel) {
      return "Default";
    }
    const match = availableModels.find((option) => option?.value === diarizationModel);
    return match?.label ?? diarizationModel;
  }, [diarizationModel, availableModels]);
  const canReprocessMeeting = Boolean(selectedMeeting?.audioFilePath && selectedMeeting?.endedAt);

  useEffect(() => {
    fetchMeetings();
    return () => {
      cleanupRecording();
    };
  }, []);

  // Auto-select first meeting when meetings load
  useEffect(() => {
    if (!selectedMeetingId && sortedMeetings.length > 0) {
      setSelectedMeetingId(sortedMeetings[0].id);
    }
  }, [sortedMeetings, selectedMeetingId]);

  // Auto-refresh when there are processing meetings
  useEffect(() => {
    const hasProcessingMeetings = meetings.some(m => m.status === "processing");

    if (!hasProcessingMeetings) {
      return;
    }

    // Poll every 10 seconds when there are meetings being processed
    const pollInterval = setInterval(() => {
      fetchMeetings();
    }, 10000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [meetings]);

  useEffect(() => {
    const api = window.meetingBuddy;
    if (!api) {
      return undefined;
    }

    const disposeHandlers = [];

    const applyModelPayload = (payload = {}) => {
      setDiarizationModel(payload?.model ?? null);
      if (Array.isArray(payload?.available)) {
        setAvailableModels(payload.available);
      }
    };

    if (typeof api.requestModel === "function") {
      api
        .requestModel()
        .then((payload) => {
          if (payload) {
            applyModelPayload(payload);
          }
        })
        .catch((error) => {
          console.error('[meeting-buddy] Failed to load model preference', error);
        });
    }

    if (typeof api.onModelChanged === "function") {
      disposeHandlers.push(api.onModelChanged(applyModelPayload));
    }

    if (typeof api.onReprocessRequested === "function") {
      disposeHandlers.push(
        api.onReprocessRequested(({ model }) => {
          const targetModel = model ?? diarizationModel ?? null;
          if (!selectedMeetingId || !canReprocessMeeting) {
            setError('Select a completed meeting with audio before reprocessing');
            return;
          }
          if (reprocessingMeetingId) {
            return;
          }
          reprocessMeeting(selectedMeetingId, targetModel);
        })
      );
    }

    return () => {
      disposeHandlers.forEach((dispose) => {
        try {
          dispose?.();
        } catch (error) {
          console.error('[meeting-buddy] Failed to dispose IPC listener', error);
        }
      });
    };
  }, [selectedMeetingId, diarizationModel, canReprocessMeeting, reprocessingMeetingId]);

  async function fetchMeetings() {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/api/meetings`);
      if (!response.ok) {
        throw new Error(`Failed to load meetings (${response.status})`);
      }
      const data = await response.json();
      setMeetings(data.meetings ?? []);
      setError("");
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to load meetings");
    } finally {
      setLoading(false);
    }
  }

  function cleanupRecording() {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
    recordingChunksRef.current = [];
    setRecordingMeetingId(null);
    setRecordingDuration(0);
  }

  async function ensureMeetingStarted(meetingId) {
    const meeting = meetings.find((item) => item.id === meetingId);
    if (meeting?.startedAt) {
      return;
    }
    setActionMeetingId(meetingId);
    try {
      const response = await fetch(`${API_BASE}/api/meetings/${meetingId}/start`, {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Unable to start meeting (${response.status})`);
      }
      await fetchMeetings();
    } finally {
      setActionMeetingId(null);
    }
  }

  async function beginRecording(meetingId) {
    try {
      setError("");
      if (recordingMeetingId && recordingMeetingId !== meetingId) {
        await stopRecording(recordingMeetingId);
      }

      await ensureMeetingStarted(meetingId);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recordingChunksRef.current = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      });
      recorder.addEventListener("error", (event) => {
        console.error("Recorder error", event.error);
        setError(event.error?.message ?? "Recorder error");
      });
      recorder.addEventListener("stop", () => {
        const chunksCopy = recordingChunksRef.current.slice();
        recordingChunksRef.current = [];
        handleRecordingComplete(meetingId, recorder.mimeType, chunksCopy);
      });

      mediaRecorderRef.current = recorder;
      mediaStreamRef.current = stream;
      setRecordingMeetingId(meetingId);
      setRecordingDuration(0);

      recorder.start(1000);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingDuration((previous) => previous + 1);
      }, 1000);
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to start recording");
      cleanupRecording();
    }
  }

  async function stopRecording(meetingId) {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    const recorder = mediaRecorderRef.current;
    if (!recorder || recordingMeetingId !== meetingId) {
      cleanupRecording();
      return;
    }

    if (recorder.state !== "inactive") {
      recorder.stop();
    } else {
      cleanupRecording();
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }

  async function handleRecordingComplete(meetingId, mimeType, chunks) {
    try {
      if (!chunks.length) {
        throw new Error("Recording did not capture any audio");
      }
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      const arrayBuffer = await blob.arrayBuffer();
      const base64Data = arrayBufferToBase64(arrayBuffer);
      const extension = mimeTypeToExtension(mimeType || blob.type);

      if (!window.meetingBuddy?.saveAudio) {
        throw new Error("Audio bridge is unavailable");
      }

      const saveResult = await window.meetingBuddy.saveAudio({
        meetingId,
        base64Data,
        extension,
        mimeType: mimeType || blob.type || "audio/webm"
      });

      if (!saveResult?.filePath) {
        throw new Error("Failed to persist recording to disk");
      }

      const response = await fetch(`${API_BASE}/api/meetings/${meetingId}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioFilePath: saveResult.filePath })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = payload.error || `Unable to end meeting (${response.status})`;
        throw new Error(message);
      }

      await fetchMeetings();
      setError("");
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to save recording");
    } finally {
      cleanupRecording();
    }
  }

  async function uploadAudio(meetingId, file) {
    if (!file) {
      return;
    }
    setUploadingMeetingId(meetingId);
    try {
      const formData = new FormData();
      formData.append("audio", file);
      const response = await fetch(`${API_BASE}/api/meetings/${meetingId}/audio`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = payload.error || `Unable to upload audio (${response.status})`;
        throw new Error(message);
      }
      await fetchMeetings();
      setError("");
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to upload audio");
    } finally {
      setUploadingMeetingId(null);
    }
  }

  function handleUploadDragOver(event, meetingId) {
    if (!meetingId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (uploadingMeetingId === meetingId) {
      return;
    }
    if (draggingUploadMeetingId !== meetingId) {
      setDraggingUploadMeetingId(meetingId);
    }
  }

  function handleUploadDragLeave(event, meetingId) {
    if (!meetingId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const related = event.relatedTarget;
    if (related && event.currentTarget?.contains?.(related)) {
      return;
    }
    if (draggingUploadMeetingId === meetingId) {
      setDraggingUploadMeetingId(null);
    }
  }

  function handleUploadDrop(event, meetingId) {
    if (!meetingId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDraggingUploadMeetingId((current) => (current === meetingId ? null : current));

    if (uploadingMeetingId === meetingId) {
      return;
    }

    const droppedFile = pickFirstAudioFile(event.dataTransfer?.files || []);
    if (!droppedFile) {
      setError("Please drop an audio file");
      return;
    }
    uploadAudio(meetingId, droppedFile);
  }

  function triggerAudioSelect(meetingId) {
    const input = fileInputsRef.current[meetingId];
    if (input) {
      input.click();
    }
  }

  function registerFileInput(meetingId, node) {
    if (node) {
      fileInputsRef.current[meetingId] = node;
    } else {
      delete fileInputsRef.current[meetingId];
    }
  }

  async function createMeeting(event) {
    event?.preventDefault();
    const trimmed = newMeetingName.trim();
    if (!trimmed) {
      setError("Meeting name is required");
      return;
    }
    try {
      setError("");
      const response = await fetch(`${API_BASE}/api/meetings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed })
      });
      if (!response.ok) {
        throw new Error(`Failed to create meeting (${response.status})`);
      }
      const data = await response.json();
      setNewMeetingName("");
      await fetchMeetings();
      // Auto-select the newly created meeting
      if (data.meeting?.id) {
        setSelectedMeetingId(data.meeting.id);
      }
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to create meeting");
    }
  }

  async function createNewMeeting() {
    try {
      setError("");
      const response = await fetch(`${API_BASE}/api/meetings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Untitled Meeting" })
      });
      if (!response.ok) {
        throw new Error(`Failed to create meeting (${response.status})`);
      }
      const data = await response.json();
      await fetchMeetings();
      // Auto-select the newly created meeting and enable editing
      if (data.meeting?.id) {
        setSelectedMeetingId(data.meeting.id);
        // Use setTimeout to ensure the meeting is selected and rendered before enabling edit mode
        setTimeout(() => setEditingMeetingName(true), 0);
      }
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to create meeting");
    }
  }

  async function updateMeetingName(meetingId, newName) {
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("Meeting name cannot be empty");
      return;
    }
    try {
      setError("");
      const response = await fetch(`${API_BASE}/api/meetings/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed })
      });
      if (!response.ok) {
        throw new Error(`Failed to update meeting name (${response.status})`);
      }
      await fetchMeetings();
      setEditingMeetingName(false);
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to update meeting name");
    }
  }

  async function fetchTranscript(meetingId) {
    const meeting = meetings.find(m => m.id === meetingId);
    if (!meeting?.files?.txt) {
      setTranscriptContent("");
      return;
    }

    try {
      setLoadingTranscript(true);
      const response = await fetch(`${API_BASE}${meeting.files.txt}`);
      if (!response.ok) {
        throw new Error(`Failed to load transcript (${response.status})`);
      }
      const text = await response.text();
      setTranscriptContent(text);
      maybeSyncSpeakersFromTranscript(meetingId, text);
    } catch (err) {
      console.error(err);
      setTranscriptContent("Failed to load transcript.");
    } finally {
      setLoadingTranscript(false);
    }
  }

  async function updateSpeakerName(meetingId, speakerId, newName) {
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("Speaker name cannot be empty");
      return;
    }
    try {
      setError("");
      const response = await fetch(`${API_BASE}/api/meetings/${meetingId}/speakers/${speakerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: trimmed })
      });
      if (!response.ok) {
        throw new Error(`Failed to update speaker name (${response.status})`);
      }
      await fetchMeetings();
      setEditingSpeakerId(null);
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to update speaker name");
    }
  }

  async function addSpeaker(meetingId) {
    const meeting = meetings.find(m => m.id === meetingId);
    if (!meeting) return;

    const speakerCount = meeting.speakers?.length || 0;
    const newSpeakerLabel = `Speaker ${speakerCount + 1}`;

    try {
      setError("");
      const response = await fetch(`${API_BASE}/api/meetings/${meetingId}/speakers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: newSpeakerLabel })
      });
      if (!response.ok) {
        throw new Error(`Failed to add speaker (${response.status})`);
      }
      await fetchMeetings();
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to add speaker");
    }
  }

  async function syncSpeakerSlots(meetingId, targetCount) {
    if (!meetingId || !targetCount || targetCount < 1) {
      return;
    }
    if (syncingSpeakerCountMeetingId === meetingId) {
      return;
    }

    try {
      setError("");
      setSyncingSpeakerCountMeetingId(meetingId);
      const response = await fetch(`${API_BASE}/api/meetings/${meetingId}/speakers/sync-count`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: targetCount })
      });
      if (!response.ok) {
        throw new Error(`Failed to sync speaker count (${response.status})`);
      }
      await fetchMeetings();
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to sync speakers with transcript");
    } finally {
      setSyncingSpeakerCountMeetingId((current) => (current === meetingId ? null : current));
    }
  }

  function maybeSyncSpeakersFromTranscript(meetingId, transcriptText) {
    if (!meetingId || !transcriptText?.trim()) {
      return;
    }
    if (syncingSpeakerCountMeetingId && syncingSpeakerCountMeetingId !== meetingId) {
      return;
    }

    const detected = detectSpeakerCountFromTranscript(transcriptText);
    if (!detected) {
      return;
    }

    const meeting = meetings.find((item) => item.id === meetingId);
    if (!meeting) {
      return;
    }

    const existing = meeting.speakers?.length ?? 0;
    if (detected <= existing) {
      return;
    }

    syncSpeakerSlots(meetingId, detected);
  }

  async function reprocessMeeting(meetingId, modelOverride) {
    if (!meetingId) {
      return;
    }
    if (reprocessingMeetingId) {
      return;
    }

    const meeting = meetings.find(item => item.id === meetingId);
    if (!meeting) {
      setError("Meeting not found");
      return;
    }
    if (!meeting.audioFilePath) {
      setError("No audio available for this meeting");
      return;
    }

    try {
      setError("");
      setReprocessingMeetingId(meetingId);
      const payload = {};
      if (typeof modelOverride === "string" && modelOverride.trim()) {
        payload.whisperModel = modelOverride.trim();
      }

      const response = await fetch(`${API_BASE}/api/meetings/${meetingId}/reprocess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const result = await response
        .json()
        .catch(() => ({}));

      if (!response.ok) {
        const message = typeof result?.error === "string" ? result.error : `Failed to reprocess meeting (${response.status})`;
        throw new Error(message);
      }

      await fetchMeetings();
      if (selectedMeetingId === meetingId) {
        await fetchTranscript(meetingId);
      }

      return result;
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to reprocess meeting");
      return null;
    } finally {
      setReprocessingMeetingId(current => (current === meetingId ? null : current));
    }
  }

  async function applySpeakerNames(meetingId) {
    if (!meetingId) {
      return;
    }
    try {
      setError("");
      setApplyingSpeakerNamesMeetingId(meetingId);
      const response = await fetch(`${API_BASE}/api/meetings/${meetingId}/speakers/apply`, {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Failed to apply speaker names (${response.status})`);
      }
      await response.json();
      await fetchMeetings();
      if (selectedMeetingId === meetingId) {
        await fetchTranscript(meetingId);
      }
    } catch (err) {
      console.error(err);
      setError(err.message ?? "Unable to apply speaker names");
    } finally {
      setApplyingSpeakerNamesMeetingId(null);
    }
  }

  // Load transcript when selected meeting changes or when the meeting's files change
  useEffect(() => {
    if (selectedMeetingId) {
      fetchTranscript(selectedMeetingId);
    } else {
      setTranscriptContent("");
    }
  }, [selectedMeetingId, selectedMeeting?.files?.txt]);

  useEffect(() => {
    setDraggingUploadMeetingId(null);
  }, [selectedMeetingId]);

  return (
    <div className="flex h-screen">
      {/* Left Column - Meeting List (25%) */}
      <div className="w-1/4 bg-[#121212] p-4 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Previous Meetings</h2>
          <button
            onClick={createNewMeeting}
            className="text-primary hover:text-primary/80 transition-colors"
            title="Create new meeting"
          >
            <span className="material-symbols-outlined">add</span>
          </button>
        </div>
        <div className="flex-grow overflow-y-auto space-y-2">
          {loading ? (
            <p className="text-gray-400 text-sm">Loading...</p>
          ) : filteredMeetings.length === 0 ? (
            <p className="text-gray-400 text-sm">No meetings found</p>
          ) : (
            filteredMeetings.map((meeting) => (
              <button
                key={meeting.id}
                onClick={() => setSelectedMeetingId(meeting.id)}
                className={`w-full flex items-center gap-4 rounded-lg px-4 h-12 text-left transition-colors ${
                  selectedMeetingId === meeting.id
                    ? "bg-primary/20"
                    : "hover:bg-primary/10"
                }`}
              >
                <span className="material-symbols-outlined text-white">description</span>
                <p className="text-white text-base font-bold leading-tight truncate flex-1">
                  {meeting.name}
                </p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right Column - Meeting Details (75%) */}
      <div className="w-3/4 flex flex-col bg-background-dark">
        {selectedMeeting ? (
          <>
            {/* Top Bar */}
            <div className="flex items-center p-4 pb-2 justify-between border-b border-gray-700">
              <div className="flex-1">
                {editingMeetingName ? (
                  <input
                    type="text"
                    defaultValue={selectedMeeting.name}
                    autoFocus
                    onBlur={(e) => updateMeetingName(selectedMeeting.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        updateMeetingName(selectedMeeting.id, e.target.value);
                      } else if (e.key === "Escape") {
                        setEditingMeetingName(false);
                      }
                    }}
                    className="text-white text-lg font-bold leading-tight tracking-[-0.015em] bg-[#121212] border border-primary rounded px-2 py-1 outline-none w-full"
                  />
                ) : (
                  <div
                    className="text-white text-lg font-bold leading-tight tracking-[-0.015em] cursor-text hover:bg-[#121212] rounded px-2 py-1 -mx-2 -my-1"
                    onClick={() => setEditingMeetingName(true)}
                  >
                    {selectedMeeting.name}
                  </div>
                )}
                <p className="text-gray-400 text-sm mt-1">
                  Created {formatDate(selectedMeeting.createdAt)} | {statusLabels[selectedMeeting.status]} | Model {activeModelLabel}
                </p>
              </div>
              <div className="flex gap-2">
                {recordingMeetingId === selectedMeeting.id ? (
                  <button
                    onClick={() => stopRecording(selectedMeeting.id)}
                    className="bg-red-500/20 border border-red-500/40 text-red-200 text-base font-bold leading-normal tracking-[0.015em] px-4 py-2 rounded-lg hover:bg-red-500/30"
                  >
                    Stop ({formatDuration(recordingDuration)})
                  </button>
                ) : (
                  <button
                    onClick={() => beginRecording(selectedMeeting.id)}
                    disabled={uploadingMeetingId === selectedMeeting.id}
                    className="bg-primary text-white text-base font-bold leading-normal tracking-[0.015em] px-4 py-2 rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Start Meeting
                  </button>
                )}
              </div>
            </div>

            {/* Main Content */}
            <div className="flex-grow p-6 overflow-y-auto">
              {error && (
                <div className="mb-4 p-4 bg-red-500/20 border border-red-500/40 rounded-lg text-red-200">
                  {error}
                </div>
              )}

              {isSyncingSpeakers && (
                <div className="mb-4 p-4 bg-primary/20 border border-primary/40 rounded-lg text-white/80">
                  Syncing speakers with transcript...
                </div>
              )}

              {isReprocessing && (
                <div className="mb-4 p-4 bg-primary/20 border border-primary/40 rounded-lg text-white/80">
                  Reprocessing transcript with {activeModelLabel}.
                </div>
              )}

              {/* Speaker Renaming Section */}
              {selectedMeeting.endedAt && (
                <div className="mb-8">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-[22px] font-bold leading-tight tracking-[-0.015em]">Speakers</h3>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => addSpeaker(selectedMeeting.id)}
                        disabled={isSyncingSpeakers}
                        className="flex items-center gap-2 text-primary hover:text-primary/80 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="material-symbols-outlined text-base">add</span>
                        Add Speaker
                      </button>
                      <button
                        onClick={() => applySpeakerNames(selectedMeeting.id)}
                        disabled={!canApplySpeakerNames || isApplyingSpeakerNames || isReprocessing || isSyncingSpeakers}
                        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                          isApplyingSpeakerNames || isReprocessing || isSyncingSpeakers
                            ? "bg-primary text-white"
                            : "bg-primary/20 text-white hover:bg-primary/30"
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                      >
                        {isApplyingSpeakerNames || isReprocessing || isSyncingSpeakers ? (
                          <>
                            <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
                            {isReprocessing ? "Reprocessing..." : "Processing..."}
                          </>
                        ) : (
                          <>
                            <span className="material-symbols-outlined text-base">sync</span>
                            Process Names
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                  {selectedMeeting.speakers?.length > 0 ? (
                    <div className="space-y-4">
                      {selectedMeeting.speakers.map((speaker) => (
                        <div
                          key={speaker.id}
                          className="flex items-center gap-4 bg-[#121212] px-4 min-h-14 justify-between rounded-lg"
                        >
                          <div className="flex items-center gap-4 flex-1">
                            <div className="text-white flex items-center justify-center rounded-lg bg-primary/30 shrink-0 size-10">
                              <span className="material-symbols-outlined">mic</span>
                            </div>
                            {editingSpeakerId === speaker.id ? (
                              <input
                                type="text"
                                defaultValue={speaker.displayName}
                                autoFocus
                                onBlur={(e) => updateSpeakerName(selectedMeeting.id, speaker.id, e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    updateSpeakerName(selectedMeeting.id, speaker.id, e.target.value);
                                  } else if (e.key === "Escape") {
                                    setEditingSpeakerId(null);
                                  }
                                }}
                                className="text-white text-base font-normal leading-normal flex-1 bg-[#0a0a0a] border border-primary rounded px-2 py-1 outline-none"
                              />
                            ) : (
                              <p className="text-white text-base font-normal leading-normal flex-1 truncate">
                                {speaker.displayName}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => setEditingSpeakerId(editingSpeakerId === speaker.id ? null : speaker.id)}
                            className="text-primary text-base font-medium leading-normal hover:text-primary/80"
                          >
                            {editingSpeakerId === speaker.id ? "Cancel" : "Edit"}
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="bg-[#121212] p-6 rounded-lg text-center">
                      <p className="text-gray-400 mb-4">No speakers added yet. Click "Add Speaker" to add speakers to this meeting.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Transcript Download/View Section */}
              {selectedMeeting.files && Object.keys(selectedMeeting.files).length > 0 && (
                <div>
                  <h3 className="text-[22px] font-bold leading-tight tracking-[-0.015em] mb-4">Transcript</h3>

                  {/* Download Buttons */}
                  <div className="bg-[#121212] p-6 rounded-lg mb-4">
                    <div className="flex items-center justify-between flex-wrap gap-4">
                      <p className="text-gray-400">Download formats</p>
                      <div className="flex space-x-4">
                        {selectedMeeting.files.csv && (
                          <a
                            href={`${API_BASE}${selectedMeeting.files.csv}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 bg-primary/20 text-white px-4 py-2 rounded-lg hover:bg-primary/30"
                          >
                            <span className="material-symbols-outlined">table_chart</span>
                            Download CSV
                          </a>
                        )}
                        {selectedMeeting.files.txt && (
                          <a
                            href={`${API_BASE}${selectedMeeting.files.txt}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 bg-primary/20 text-white px-4 py-2 rounded-lg hover:bg-primary/30"
                          >
                            <span className="material-symbols-outlined">description</span>
                            Download TXT
                          </a>
                        )}
                        {selectedMeeting.files.srt && (
                          <a
                            href={`${API_BASE}${selectedMeeting.files.srt}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 bg-primary/20 text-white px-4 py-2 rounded-lg hover:bg-primary/30"
                          >
                            <span className="material-symbols-outlined">subtitles</span>
                            Download SRT
                          </a>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Transcript Viewer */}
                  {selectedMeeting.files.txt && (
                    <div className="bg-[#121212] p-6 rounded-lg max-h-96 overflow-y-auto">
                      {loadingTranscript ? (
                        <p className="text-gray-400">Loading transcript...</p>
                      ) : transcriptContent ? (
                        <div className="text-white whitespace-pre-wrap font-mono text-sm leading-relaxed">
                          {transcriptContent}
                        </div>
                      ) : (
                        <p className="text-gray-400">No transcript content available</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Upload Section */}
              {!selectedMeeting.endedAt && (
                <div className="mt-8">
                  <h3 className="text-[22px] font-bold leading-tight tracking-[-0.015em] mb-4">Upload Audio</h3>
                  <div
                    className={`bg-[#121212] p-6 rounded-lg border transition-colors ${
                      isUploadDragTarget ? "border-primary/60 bg-primary/10" : "border-transparent"
                    }`}
                    onDragOver={(event) => handleUploadDragOver(event, selectedMeeting.id)}
                    onDragEnter={(event) => handleUploadDragOver(event, selectedMeeting.id)}
                    onDragLeave={(event) => handleUploadDragLeave(event, selectedMeeting.id)}
                    onDrop={(event) => handleUploadDrop(event, selectedMeeting.id)}
                  >
                    <button
                      onClick={() => triggerAudioSelect(selectedMeeting.id)}
                      disabled={uploadingMeetingId === selectedMeeting.id}
                      className="flex items-center gap-2 bg-primary/20 text-white px-4 py-2 rounded-lg hover:bg-primary/30 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="material-symbols-outlined">upload_file</span>
                      {uploadingMeetingId === selectedMeeting.id ? "Uploading..." : "Upload Audio & End"}
                    </button>
                    <input
                      type="file"
                      accept="audio/*"
                      ref={(node) => registerFileInput(selectedMeeting.id, node)}
                      className="hidden"
                      onChange={(event) => {
                        const [file] = event.target.files || [];
                        uploadAudio(selectedMeeting.id, file);
                        event.target.value = "";
                      }}
                    />
                    <p className="text-gray-400 text-sm mt-4">
                      Drag & drop audio files here or click the button above. Supports WAV, MP3, M4A, OGG, and WEBM.
                    </p>
                  </div>
                </div>
              )}

              {/* Empty State */}
              {!selectedMeeting.speakers?.length && !selectedMeeting.files && selectedMeeting.status === "pending" && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <span className="material-symbols-outlined text-6xl text-gray-600 mb-4">mic</span>
                    <h3 className="text-xl font-bold mb-2">No Recording Yet</h3>
                    <p className="text-gray-400">Click "Start Meeting" to begin recording</p>
                  </div>
                </div>
              )}
            </div>

            {/* Bottom Search Bar */}
            <div className="p-4 border-t border-gray-700">
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                  search
                </span>
                <input
                  className="w-full bg-[#121212] text-white border-none rounded-lg pl-10 pr-4 py-3 focus:ring-2 focus:ring-primary outline-none"
                  placeholder="Search past transcripts..."
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <span className="material-symbols-outlined text-6xl text-gray-600 mb-4">event_note</span>
              <h3 className="text-xl font-bold mb-2">No Meeting Selected</h3>
              <p className="text-gray-400 mb-4">Select a meeting from the list or create a new one</p>
              <form onSubmit={createMeeting} className="max-w-md mx-auto">
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Enter meeting name..."
                    value={newMeetingName}
                    onChange={(e) => setNewMeetingName(e.target.value)}
                    className="flex-1 bg-[#121212] text-white border border-gray-700 rounded-lg px-4 py-2 focus:ring-2 focus:ring-primary outline-none"
                  />
                  <button
                    type="submit"
                    className="bg-primary text-white px-6 py-2 rounded-lg font-semibold hover:bg-primary/90"
                  >
                    Create
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}





