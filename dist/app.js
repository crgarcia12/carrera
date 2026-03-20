import { RaceScene3D } from "./three-race-scene.js";

const DEFAULT_TOTAL_LAPS = 3;
const INPUT_INTERVAL_MS = 16;
const PHASES = ["landing", "lobby", "countdown", "race", "results"];
const KEY_BINDINGS = {
  ArrowUp: "accelerate",
  KeyW: "accelerate",
  ArrowDown: "brake",
  KeyS: "brake",
  ArrowLeft: "turnLeft",
  KeyA: "turnLeft",
  ArrowRight: "turnRight",
  KeyD: "turnRight"
};
const PLAYER_COLORS = ["#f97316", "#22c55e", "#38bdf8", "#f43f5e", "#eab308", "#a855f7", "#fb7185", "#14b8a6"];

const state = {
  phase: "landing",
  connection: null,
  connectionStarted: false,
  startingPromise: null,
  connectionLabel: "Disconnected",
  statusMessage: "Ready to connect.",
  errorMessage: "",
  roomCode: "",
  playerId: "",
  displayName: "",
  players: [],
  track: null,
  countdownSeconds: null,
  gameSnapshot: null,
  scoreboard: [],
  raceFinished: null,
  latestInput: emptyInput(),
  inputLoopId: null,
  lobbyNotice: ""
};

const dom = {
  joinForm: document.querySelector("#join-form"),
  joinButton: document.querySelector("#join-button"),
  displayName: document.querySelector("#display-name"),
  roomCode: document.querySelector("#room-code"),
  readyButton: document.querySelector("#ready-button"),
  startOverButton: document.querySelector("#start-over-button"),
  backToLobbyButton: document.querySelector("#back-to-lobby-button"),
  connectionBadge: document.querySelector("#connection-badge"),
  roomBadge: document.querySelector("#room-badge"),
  statusBar: document.querySelector("#status-bar"),
  errorBar: document.querySelector("#error-bar"),
  lobbySummary: document.querySelector("#lobby-summary"),
  lobbyNote: document.querySelector("#lobby-note"),
  playerList: document.querySelector("#player-list"),
  countdownNumber: document.querySelector("#countdown-number"),
  countdownDetail: document.querySelector("#countdown-detail"),
  raceSummary: document.querySelector("#race-summary"),
  raceCanvas: document.querySelector("#race-canvas"),
  hudDisplayName: document.querySelector("#hud-display-name"),
  hudLap: document.querySelector("#hud-lap"),
  hudRank: document.querySelector("#hud-rank"),
  hudSpeed: document.querySelector("#hud-speed"),
  hudCheckpoint: document.querySelector("#hud-checkpoint"),
  hudBestLap: document.querySelector("#hud-best-lap"),
  standingsList: document.querySelector("#standings-list"),
  resultsMessage: document.querySelector("#results-message"),
  resultsBody: document.querySelector("#results-body"),
  sections: Object.fromEntries(
    PHASES.map((phase) => [phase, document.querySelector(`#${phase}-view`)])
  )
};
const raceScene = createRaceScene();

initialize();

function initialize() {
  if (!window.signalR) {
    setError("The SignalR browser client did not load. Verify access to the configured CDN.");
  }

  dom.joinForm.addEventListener("submit", handleJoinSubmit);
  dom.readyButton.addEventListener("click", handleReadyUp);
  dom.startOverButton.addEventListener("click", handleStartOver);
  dom.backToLobbyButton.addEventListener("click", handleBackToLobby);
  window.addEventListener("keydown", handleKeyChange);
  window.addEventListener("keyup", handleKeyChange);
  render();
}

function createRaceScene() {
  try {
    return new RaceScene3D({
      canvas: dom.raceCanvas,
      getPlayerColor: colorForPlayer
    });
  } catch (error) {
    console.error(error);
    queueMicrotask(() => {
      setError(`Unable to initialize the 3D renderer: ${error.message}`);
    });
    return null;
  }
}

async function handleJoinSubmit(event) {
  event.preventDefault();
  clearError();

  const displayName = dom.displayName.value.trim();
  const roomCode = dom.roomCode.value.trim().toUpperCase();

  dom.joinButton.disabled = true;
  setStatus("Connecting to the race hub...");

  try {
    await ensureConnectionStarted();
    resetRaceState({ preserveDisplayName: true });
    state.displayName = displayName;
    state.lobbyNotice = "";
    await state.connection.invoke("JoinLobby", { roomCode, displayName });
    setStatus("Join request sent. Waiting for lobby state...");
  } catch (error) {
    setError(`Unable to join the lobby: ${error.message}`);
  } finally {
    dom.joinButton.disabled = false;
  }
}

async function handleReadyUp() {
  if (!state.connectionStarted || !state.connection) {
    return;
  }

  dom.readyButton.disabled = true;
  clearError();

  try {
    await state.connection.invoke("ReadyUp");
    setStatus("Ready state sent. Waiting for all racers...");
  } catch (error) {
    setError(`Unable to send ReadyUp: ${error.message}`);
  } finally {
    renderLobby();
  }
}

async function handleStartOver() {
  await restartConnection();
  setStatus("Reset complete. You can create or join a new lobby.");
}

function handleBackToLobby() {
  state.phase = "lobby";
  state.lobbyNotice = "This race is finished. Same-room replay is not available. Use Start over for a fresh connection.";
  render();
}

function handleKeyChange(event) {
  const binding = KEY_BINDINGS[event.code];
  if (!binding) {
    return;
  }

  if (state.phase !== "race") {
    return;
  }

  event.preventDefault();
  const value = event.type === "keydown";
  if (state.latestInput[binding] === value) {
    return;
  }

  state.latestInput[binding] = value;
}

function ensureConnection() {
  if (state.connection) {
    return state.connection;
  }

  if (!window.signalR) {
    throw new Error("SignalR client is unavailable.");
  }

  const connection = new window.signalR.HubConnectionBuilder()
    .withUrl("/racehub")
    .withAutomaticReconnect()
    .configureLogging(window.signalR.LogLevel.Warning)
    .build();

  connection.on("LobbyJoined", (payload) => {
    state.roomCode = payload.roomCode;
    state.playerId = payload.playerId;
    state.displayName = payload.displayName;
    dom.displayName.value = payload.displayName;
    dom.roomCode.value = payload.roomCode;
    setRoomBadge(payload.roomCode);
    setStatus(`Joined room ${payload.roomCode} as ${payload.displayName}.`);
    render();
  });

  connection.on("LobbyState", (payload) => {
    state.roomCode = payload.roomCode;
    state.players = (payload.players ?? []).map((player) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      isReady: Boolean(player.isReady)
    }));
    state.raceFinished = null;
    state.scoreboard = [];
    state.gameSnapshot = null;
    state.countdownSeconds = null;
    state.phase = "lobby";
    setStatus(`Lobby ready with ${state.players.length} player(s).`);
    render();
  });

  connection.on("PlayerJoined", (payload) => {
    upsertLobbyPlayer({
      playerId: payload.playerId,
      displayName: payload.displayName,
      isReady: false
    });
    setStatus(`${payload.displayName} joined the lobby.`);
    renderLobby();
  });

  connection.on("PlayerLeft", (payload) => {
    state.players = state.players.filter((player) => player.playerId !== payload.playerId);
    if (state.gameSnapshot) {
      state.gameSnapshot.players = state.gameSnapshot.players.filter((player) => player.playerId !== payload.playerId);
    }
    state.scoreboard = state.scoreboard.filter((entry) => entry.playerId !== payload.playerId);
    render();
  });

  connection.on("PlayerReady", (payload) => {
    upsertLobbyPlayer({ playerId: payload.playerId, isReady: true });
    renderLobby();
  });

  connection.on("RaceCountdown", (payload) => {
    state.countdownSeconds = payload.secondsRemaining;
    state.phase = "countdown";
    setStatus(`Race starts in ${payload.secondsRemaining}.`);
    render();
  });

  connection.on("RaceStarted", () => {
    state.phase = "race";
    state.countdownSeconds = null;
    state.raceFinished = null;
    startInputLoop();
    setStatus("Race started. Drive!");
    render();
  });

  connection.on("TrackLoaded", (payload) => {
    state.track = payload;
    renderRaceScene();
  });

  connection.on("GameSnapshot", (payload) => {
    state.gameSnapshot = payload;
    renderRace();
  });

  connection.on("ScoreboardUpdate", (payload) => {
    state.scoreboard = payload.rankings ?? [];
    renderStandings();
  });

  connection.on("RaceFinished", (payload) => {
    stopInputLoop();
    state.raceFinished = payload;
    state.phase = "results";
    state.lobbyNotice = "This room has finished. Use Start over if you want a fresh lobby.";
    setStatus("Race finished.");
    render();
  });

  connection.on("ErrorMessage", (payload) => {
    const message = payload?.message ?? "The backend reported an unspecified error.";
    setError(message);
  });

  connection.onreconnecting(() => {
    state.connectionLabel = "Reconnecting";
    stopInputLoop();
    setStatus("Connection lost. Attempting to reconnect...");
    renderChrome();
  });

  connection.onreconnected(() => {
    state.connectionLabel = "Connected";
    resetRaceState({ preserveDisplayName: true });
    state.phase = "landing";
    state.lobbyNotice = "";
    setRoomBadge("No room");
    setStatus("Transport reconnected, but room state was not resumed. Join a lobby again.");
    render();
  });

  connection.onclose(() => {
    state.connectionStarted = false;
    state.connectionLabel = "Disconnected";
    stopInputLoop();
    if (state.phase !== "landing") {
      state.phase = "landing";
      setStatus("Connection closed. Join a lobby to reconnect.");
    }
    render();
  });

  state.connection = connection;
  return connection;
}

async function ensureConnectionStarted() {
  if (state.connectionStarted) {
    return state.connection;
  }

  if (state.startingPromise) {
    return state.startingPromise;
  }

  const connection = ensureConnection();

  state.startingPromise = connection.start().then(() => {
    state.connectionStarted = true;
    state.connectionLabel = "Connected";
    renderChrome();
    return connection;
  }).finally(() => {
    state.startingPromise = null;
  });

  return state.startingPromise;
}

async function restartConnection() {
  stopInputLoop();
  resetRaceState({ preserveDisplayName: true });
  state.phase = "landing";
  state.players = [];
  state.roomCode = "";
  setRoomBadge("No room");

  if (state.connection) {
    try {
      await state.connection.stop();
    } catch (_error) {
      // Ignore stop failures and create a fresh connection on next join.
    }
  }

  state.connection = null;
  state.connectionStarted = false;
  state.startingPromise = null;
  state.connectionLabel = "Disconnected";
  render();
}

function resetRaceState(options = {}) {
  const preserveDisplayName = options.preserveDisplayName ?? false;

  state.roomCode = "";
  state.playerId = "";
  state.players = [];
  state.track = null;
  state.countdownSeconds = null;
  state.gameSnapshot = null;
  state.scoreboard = [];
  state.raceFinished = null;
  state.latestInput = emptyInput();
  state.lobbyNotice = "";

  if (!preserveDisplayName) {
    state.displayName = "";
    dom.displayName.value = "";
  }
}

function startInputLoop() {
  stopInputLoop();
  state.inputLoopId = window.setInterval(() => {
    if (!state.connectionStarted || !state.connection || state.phase !== "race") {
      return;
    }

    state.connection.send("SendInput", { ...state.latestInput }).catch(() => {
      setStatus("Input send failed. Waiting for the connection to recover...");
    });
  }, INPUT_INTERVAL_MS);
}

function stopInputLoop() {
  if (state.inputLoopId !== null) {
    window.clearInterval(state.inputLoopId);
    state.inputLoopId = null;
  }

  state.latestInput = emptyInput();
}

function upsertLobbyPlayer(nextPlayer) {
  const existing = state.players.find((player) => player.playerId === nextPlayer.playerId);
  if (existing) {
    if (nextPlayer.displayName) {
      existing.displayName = nextPlayer.displayName;
    }
    if (typeof nextPlayer.isReady === "boolean") {
      existing.isReady = nextPlayer.isReady;
    }
    return;
  }

  state.players.push({
    playerId: nextPlayer.playerId,
    displayName: nextPlayer.displayName ?? "Racer",
    isReady: Boolean(nextPlayer.isReady)
  });
}

function render() {
  renderChrome();
  for (const phase of PHASES) {
    dom.sections[phase].hidden = phase !== state.phase;
  }
  renderLanding();
  renderLobby();
  renderCountdown();
  renderRace();
  renderResults();
}

function renderChrome() {
  dom.connectionBadge.textContent = state.connectionLabel;
  dom.connectionBadge.className = `badge ${state.connectionLabel === "Connected" ? "badge-live" : "badge-idle"}`;
  dom.statusBar.textContent = state.statusMessage;
  if (state.errorMessage) {
    dom.errorBar.hidden = false;
    dom.errorBar.textContent = state.errorMessage;
  } else {
    dom.errorBar.hidden = true;
    dom.errorBar.textContent = "";
  }
}

function renderLanding() {
  dom.displayName.value = state.displayName;
  dom.roomCode.value = state.roomCode;
}

function renderLobby() {
  const localPlayer = state.players.find((player) => player.playerId === state.playerId);
  const playerCount = state.players.length;
  dom.lobbySummary.textContent = state.roomCode
    ? `Room ${state.roomCode} with ${playerCount} racer${playerCount === 1 ? "" : "s"}.`
    : "Waiting for room assignment.";

  if (state.lobbyNotice) {
    dom.lobbyNote.hidden = false;
    dom.lobbyNote.textContent = state.lobbyNotice;
  } else {
    dom.lobbyNote.hidden = true;
    dom.lobbyNote.textContent = "";
  }

  dom.playerList.replaceChildren();
  for (const player of state.players) {
    const item = document.createElement("li");
    item.className = `player-row${player.playerId === state.playerId ? " local" : ""}`;

    const name = document.createElement("span");
    name.textContent = `${player.displayName}${player.playerId === state.playerId ? " (you)" : ""}`;

    const ready = document.createElement("span");
    ready.className = `ready-pill ${player.isReady ? "ready" : "waiting"}`;
    ready.textContent = player.isReady ? "Ready" : "Waiting";

    const playerId = document.createElement("span");
    playerId.className = "muted";
    playerId.textContent = abbreviatePlayerId(player.playerId);

    item.append(name, ready, playerId);
    dom.playerList.append(item);
  }

  const shouldDisableReady = !state.connectionStarted || !state.roomCode || state.phase !== "lobby" || Boolean(state.raceFinished) || localPlayer?.isReady;
  dom.readyButton.disabled = shouldDisableReady;
  dom.readyButton.textContent = localPlayer?.isReady ? "Waiting for others..." : "Ready up";
}

function renderCountdown() {
  dom.countdownNumber.textContent = state.countdownSeconds ?? "-";
  dom.countdownDetail.textContent = state.roomCode
    ? `Room ${state.roomCode} is about to start.`
    : "Preparing race state.";
}

function renderRace() {
  const snapshotPlayers = state.gameSnapshot?.players ?? [];
  const localPlayer = snapshotPlayers.find((player) => player.playerId === state.playerId);

  dom.raceSummary.textContent = state.track
    ? `${state.track.name} - ${snapshotPlayers.length} active racer${snapshotPlayers.length === 1 ? "" : "s"}`
    : "Waiting for track data...";

  dom.hudDisplayName.textContent = localPlayer?.displayName ?? (state.displayName || "-");
  dom.hudLap.textContent = localPlayer ? `${localPlayer.lap}/${state.raceFinished?.totalLaps ?? DEFAULT_TOTAL_LAPS}` : "-";
  dom.hudRank.textContent = localPlayer ? String(localPlayer.rank) : "-";
  dom.hudSpeed.textContent = localPlayer ? `${Math.round(localPlayer.speed)} u/s` : "-";
  dom.hudCheckpoint.textContent = localPlayer?.nextCheckpointIndex ?? "-";
  dom.hudBestLap.textContent = formatMilliseconds(localPlayer?.bestLapMs, false);

  renderStandings();
  renderRaceScene();
}

function renderStandings() {
  dom.standingsList.replaceChildren();
  for (const entry of getStandings()) {
    const item = document.createElement("li");
    item.className = `standing-row${entry.playerId === state.playerId ? " local" : ""}`;

    const left = document.createElement("span");
    left.textContent = `${entry.rank}. ${entry.displayName}`;

    const center = document.createElement("span");
    center.textContent = `Lap ${entry.lap}`;

    const right = document.createElement("span");
    right.textContent = entry.finished ? "Finished" : formatMilliseconds(entry.bestLapMs, false);

    item.append(left, center, right);
    dom.standingsList.append(item);
  }
}

function renderResults() {
  dom.resultsBody.replaceChildren();

  if (!state.raceFinished) {
    dom.resultsMessage.textContent = "Waiting for race results...";
    return;
  }

  dom.resultsMessage.textContent = state.raceFinished.message ?? `${state.raceFinished.trackName} complete.`;

  for (const result of state.raceFinished.results ?? []) {
    const row = document.createElement("tr");
    if (result.playerId === state.playerId) {
      row.classList.add("local");
    }

    row.append(
      buildTableCell(String(result.rank)),
      buildTableCell(result.displayName),
      buildTableCell(result.totalTimeMs === null ? "DNF" : formatMilliseconds(result.totalTimeMs, true)),
      buildTableCell(formatMilliseconds(result.bestLapMs, false))
    );

    dom.resultsBody.append(row);
  }
}

function renderRaceScene() {
  if (!raceScene) {
    return;
  }

  const localPlayer = (state.gameSnapshot?.players ?? []).find((player) => player.playerId === state.playerId);
  raceScene.update({
    track: state.track,
    players: state.gameSnapshot?.players ?? [],
    localPlayerId: state.playerId,
    nextCheckpointIndex: localPlayer?.nextCheckpointIndex ?? null
  });
}

function getStandings() {
  if (state.scoreboard.length > 0) {
    return [...state.scoreboard];
  }

  if (!state.gameSnapshot?.players?.length) {
    return [];
  }

  return [...state.gameSnapshot.players]
    .sort((left, right) => left.rank - right.rank)
    .map((player) => ({
      rank: player.rank,
      playerId: player.playerId,
      displayName: player.displayName,
      lap: player.lap,
      bestLapMs: player.bestLapMs,
      finished: player.finished
    }));
}

function setRoomBadge(value) {
  dom.roomBadge.textContent = value;
}

function setStatus(message) {
  state.statusMessage = message;
  renderChrome();
}

function setError(message) {
  state.errorMessage = message;
  renderChrome();
}

function clearError() {
  state.errorMessage = "";
  renderChrome();
}

function emptyInput() {
  return {
    accelerate: false,
    brake: false,
    turnLeft: false,
    turnRight: false
  };
}

function abbreviatePlayerId(playerId) {
  if (!playerId) {
    return "";
  }

  return playerId.length <= 10 ? playerId : `${playerId.slice(0, 4)}...${playerId.slice(-4)}`;
}

function formatMilliseconds(value, includeMinutes) {
  if (value === null || value === undefined) {
    return includeMinutes ? "DNF" : "-";
  }

  const totalMilliseconds = Math.max(0, Number(value));
  const minutes = Math.floor(totalMilliseconds / 60000);
  const seconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = Math.floor(totalMilliseconds % 1000);

  if (!includeMinutes && minutes === 0) {
    return `${seconds}.${String(milliseconds).padStart(3, "0")}s`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function colorForPlayer(playerId) {
  let hash = 0;
  for (let index = 0; index < playerId.length; index += 1) {
    hash = (hash << 5) - hash + playerId.charCodeAt(index);
    hash |= 0;
  }

  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

function buildTableCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  return cell;
}
