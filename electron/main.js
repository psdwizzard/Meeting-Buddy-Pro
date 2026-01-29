const { app, BrowserWindow, nativeTheme, ipcMain, Menu } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const isDev = process.env.NODE_ENV === "development";
const recordingsRoot = path.join(process.cwd(), "data", "audio");
fs.mkdirSync(recordingsRoot, { recursive: true });
const QUICK_RECORD_ENV = "MEETING_BUDDY_QUICK_RECORD";

const DEFAULT_WHISPER_MODEL = process.env.DIARIZATION_WHISPER_MODEL || "medium.en";
const DIARIZATION_MODELS = [
  { label: "Tiny", value: "tiny" },
  { label: "Base", value: "base" },
  { label: "Small", value: "small" },
  { label: "Small (English)", value: "small.en" },
  { label: "Medium", value: "medium" },
  { label: "Medium (English)", value: "medium.en" },
  { label: "Large v2", value: "large-v2" },
  { label: "Large v3", value: "large-v3" },
  { label: "Large v3 Turbo", value: "large-v3-turbo" },
  { label: "Distil Large v2", value: "distil-large-v2" }
];

let activeWhisperModel = DEFAULT_WHISPER_MODEL;
let preferencesPath = null;

function sanitizeSegment(value) {
  return (value ?? "meeting")
    .toString()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
}

function mimeTypeToExtension(mimeType) {
  if (!mimeType) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}

function getPreferencesPath() {
  if (!preferencesPath) {
    try {
      preferencesPath = path.join(app.getPath("userData"), "meeting-buddy-preferences.json");
    } catch (error) {
      console.error("[meeting-buddy] Unable to resolve preferences path", error);
      preferencesPath = null;
    }
  }
  return preferencesPath;
}

function loadSavedModelPreference() {
  const prefs = getPreferencesPath();
  if (!prefs) {
    return null;
  }
  try {
    if (!fs.existsSync(prefs)) {
      return null;
    }
    const raw = fs.readFileSync(prefs, "utf-8");
    const data = JSON.parse(raw);
    return typeof data.whisperModel === "string" ? data.whisperModel : null;
  } catch (error) {
    console.warn("[meeting-buddy] Failed to read saved model preference", error);
    return null;
  }
}

function persistModelPreference(model) {
  const prefs = getPreferencesPath();
  if (!prefs) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(prefs), { recursive: true });
    const payload = { whisperModel: model };
    fs.writeFileSync(prefs, JSON.stringify(payload, null, 2), "utf-8");
  } catch (error) {
    console.warn("[meeting-buddy] Failed to persist model preference", error);
  }
}

function updateActiveModel(model, { persist = true } = {}) {
  if (!model || typeof model !== "string") {
    return false;
  }
  if (model === activeWhisperModel) {
    return false;
  }
  activeWhisperModel = model;
  process.env.DIARIZATION_WHISPER_MODEL = model;
  if (persist) {
    persistModelPreference(model);
  }
  return true;
}

function broadcast(channel, payload) {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  });
}

function broadcastModelChange() {
  broadcast("meetingBuddy:model-changed", {
    model: activeWhisperModel,
    available: DIARIZATION_MODELS
  });
}

function broadcastReprocessRequest() {
  broadcast("meetingBuddy:reprocess-active", {
    model: activeWhisperModel
  });
}

function wantsQuickRecord() {
  if (process.argv.includes("--quick-record")) {
    return true;
  }
  const envValue = process.env[QUICK_RECORD_ENV];
  if (!envValue) {
    return false;
  }
  return envValue === "1" || envValue.toLowerCase() === "true";
}

function buildModelMenu() {
  return {
    label: "Model",
    submenu: [
      ...DIARIZATION_MODELS.map((modelOption) => ({
        label: modelOption.label,
        type: "radio",
        checked: activeWhisperModel === modelOption.value,
        click: () => {
          const changed = updateActiveModel(modelOption.value);
          if (changed) {
            broadcastModelChange();
          }
          applyApplicationMenu();
        }
      })),
      { type: "separator" },
      {
        label: "Reprocess Active Meeting",
        accelerator: "CmdOrCtrl+Shift+R",
        click: () => {
          broadcastReprocessRequest();
        }
      }
    ]
  };
}

function buildMenuTemplate() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" }
            ]
          }
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
              { type: "separator" },
              { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] }
            ]
          : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }])
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    buildModelMenu(),
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(isMac ? [{ role: "zoom" }, { type: "separator" }, { role: "front" }] : [{ role: "close" }])
      ]
    },
    {
      role: "help",
      submenu: []
    }
  ];

  return template;
}

function applyApplicationMenu() {
  if (!app.isReady()) {
    return;
  }
  const menu = Menu.buildFromTemplate(buildMenuTemplate());
  Menu.setApplicationMenu(menu);
}

ipcMain.handle("meetingBuddy:save-audio", async (_event, payload = {}) => {
  const { meetingId, base64Data, extension, mimeType } = payload;
  if (!meetingId || !base64Data) {
    throw new Error("Invalid audio payload");
  }

  const meetingSegment = sanitizeSegment(meetingId);
  const meetingDir = path.join(recordingsRoot, meetingSegment);
  await fsp.mkdir(meetingDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeExtension = sanitizeSegment(extension || mimeTypeToExtension(mimeType) || "webm");
  const fileName = `recording-${timestamp}.${safeExtension}`;
  const filePath = path.join(meetingDir, fileName);

  const buffer = Buffer.from(base64Data, "base64");
  await fsp.writeFile(filePath, buffer);

  return { filePath };
});

ipcMain.handle("meetingBuddy:get-model", async () => ({
  model: activeWhisperModel,
  available: DIARIZATION_MODELS
}));

function createMainWindow() {
  nativeTheme.themeSource = "dark";

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0f172a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow.isDestroyed()) {
      broadcastModelChange();
    }
  });

  const shouldQuickRecord = wantsQuickRecord();
  if (isDev) {
    const url = new URL("http://127.0.0.1:5173");
    if (shouldQuickRecord) {
      url.searchParams.set("quickRecord", "1");
    }
    mainWindow.loadURL(url.toString());
  } else {
    const indexPath = path.join(__dirname, "..", "dist", "index.html");
    if (shouldQuickRecord) {
      mainWindow.loadFile(indexPath, { query: { quickRecord: "1" } });
    } else {
      mainWindow.loadFile(indexPath);
    }
  }

  return mainWindow;
}

app.whenReady().then(() => {
  const savedModel = loadSavedModelPreference();
  if (savedModel) {
    updateActiveModel(savedModel, { persist: false });
  } else {
    process.env.DIARIZATION_WHISPER_MODEL = activeWhisperModel;
  }

  applyApplicationMenu();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

module.exports = {
  DIARIZATION_MODELS
};

