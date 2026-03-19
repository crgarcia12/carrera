---
title: VibeRacing Frontend-Backend Interaction Contract
version: 1.0
date_created: 2026-03-19
last_updated: 2026-03-19
owner: VibeRacing maintainers
tags:
  - architecture
  - protocol
  - frontend
  - backend
  - signalr
  - multiplayer
---

# Introduction

This specification defines the current browser-facing contract between the VibeRacing frontend and backend. Its purpose is to let a different team, or a Generative AI system, build a fully compatible frontend without needing to inspect the source code.

This document describes the implemented behavior in the repository It is intentionally precise about transport, message names, payloads, sequencing, and client obligations. It is intentionally flexible about visual style so independent frontends do not converge on a single look.

## 1. Purpose & Scope

This specification covers the runtime contract for a playable VibeRacing client.

- Intended audience:
  - frontend engineers
  - LLM-based code generation systems
  - QA engineers writing protocol and UI acceptance tests
- In scope:
  - HTTP endpoints
  - SignalR hub route, methods, events, and payload shapes
  - room and race lifecycle
  - client-side state responsibilities
  - browser-hosting constraints that affect connectivity
  - required UI information and user flows
- Out of scope:
  - backend implementation details not visible on the wire
  - pixel-perfect visual cloning of the existing frontend
  - deployment automation
  - future protocol enhancements not currently implemented

Assumptions:

- The backend is the authoritative source of race state.
- The frontend is a browser-based application unless stated otherwise.
- The goal is compatibility with the existing backend, not redesign of the protocol.

## 2. Definitions

| Term | Definition |
| --- | --- |
| API | Application Programming Interface. |
| CORS | Cross-Origin Resource Sharing. Browser security policy controlling cross-origin requests. |
| DNF | Did Not Finish. Used when a player appears in race results without a recorded finish time. |
| HUD | Heads-Up Display shown during the race. |
| LLM | Large Language Model. |
| Lobby | Pre-race room state where players join and mark themselves ready. |
| Opaque Identifier | A value the client must store and forward but must not interpret semantically. |
| Player ID | The backend-assigned identifier for a player. In the current implementation it is derived from the SignalR connection ID and must be treated as opaque. |
| Room Code | A six-character uppercase room identifier used to join or create a room. |
| SignalR | The real-time transport framework used by the backend for hub invocations and server events. |
| Snapshot | A `GameSnapshot` event containing the authoritative race state for all players. |
| Total Laps | The number of laps required to finish the race. In the current implementation the backend default is `3`, and that value is not sent to clients until `RaceFinished`. |
| Track Data | The full geometry package used by the frontend to render the track, checkpoints, and start positions. |
| `checkpointIndex` | The server's internal ordinal progress marker for the most recently cleared checkpoint in the sorted checkpoint sequence. This is not guaranteed to equal `track.checkpoints[].index`. |
| `nextCheckpointIndex` | The configured checkpoint identifier that should be matched against `track.checkpoints[].index` when highlighting the next checkpoint. |

## 3. Requirements, Constraints & Guidelines

- **REQ-001**: The frontend MUST communicate with the backend through SignalR on the `/racehub` route.
- **REQ-002**: All client-to-server JSON payloads MUST use camelCase property names.
- **REQ-003**: The frontend MUST implement the hub invocations `JoinLobby`, `ReadyUp`, and `SendInput` exactly as specified in this document.
- **REQ-004**: The frontend MUST treat `LobbyJoined`, `LobbyState`, `PlayerJoined`, `PlayerLeft`, `PlayerReady`, `RaceCountdown`, `RaceStarted`, `TrackLoaded`, `GameSnapshot`, `ScoreboardUpdate`, `RaceFinished`, and `ErrorMessage` as the complete set of server-driven UI events currently required for gameplay.
- **REQ-005**: The frontend MUST treat `GameSnapshot` as authoritative for player position, angle, speed, lap, checkpoint progress, finish state, and rank.
- **REQ-006**: The frontend MUST render the track from `TrackLoaded` data and MUST NOT depend on local copies of track JSON files.
- **REQ-007**: The frontend MUST highlight the next checkpoint by matching `player.nextCheckpointIndex` against `track.checkpoints[].index`.
- **REQ-008**: The frontend MUST display race results from `RaceFinished.results` and MUST render any `null` `totalTimeMs` value as DNF.
- **REQ-009**: The frontend MUST surface `ErrorMessage.message` to the user in a visible way.
- **REQ-010**: The frontend MUST distinguish the local player from other players in the race view and in standings/results.
- **REQ-011**: The frontend MUST stop race-only input transmission when the UI is not in the race state.
- **REQ-012**: The frontend MUST assume that `PlayerJoined` does not include `isReady`; new players should be treated as not ready until `PlayerReady` is received or `LobbyState` is refreshed.
- **REQ-013**: The frontend MUST preserve room code and player identity returned by the backend and MUST NOT synthesize its own replacements.

- **SEC-001**: The frontend MUST treat `playerId` as an opaque, untrusted session identifier and MUST NOT attach security or authorization meaning to it.
- **SEC-002**: The frontend MUST NOT assume any authentication context exists. The current protocol is anonymous.

- **CON-001**: The current backend exposes only two HTTP routes for browser clients: `GET /health` and SignalR `/racehub`.
- **CON-002**: The current backend does not expose CORS configuration. A browser frontend on a different origin cannot reliably connect directly unless a same-origin proxy is used or the backend is changed to allow that origin.
- **CON-003**: The current backend does not allow joining a room whose state is not `Lobby`. Mid-race joins are rejected through `ErrorMessage`.
- **CON-004**: The current backend stores room state in memory only. A backend restart destroys active rooms.
- **CON-005**: The current room defaults are `trackName = "dusty-fields"` and `totalLaps = 3`.
- **CON-006**: The current protocol does not expose `totalLaps` before `RaceFinished`. A compatible frontend may either assume the documented default of `3` or avoid showing a lap denominator before the race ends.
- **CON-007**: The current race ends for all players as soon as the first player finishes all required laps.
- **CON-008**: The current protocol does not include a replay, reset, or rematch method. Returning from the results screen to a lobby view is a client-local action only.
- **CON-009**: The current frontend enables SignalR automatic reconnect, but the protocol does not include application-level session resume. A transport reconnect does not automatically restore room membership or prior `playerId`.
- **CON-010**: `TrackLoaded` is sent when the client joins the room. The current backend does not rebroadcast track data on `RaceStarted`.

- **GUD-001**: A generated frontend SHOULD implement five user-visible states: landing, lobby, countdown, race, and results.
- **GUD-002**: A generated frontend SHOULD show, at minimum, room code, player list and ready states, countdown number, race scene, local lap/progress information, standings, and final results.
- **GUD-003**: Styling SHOULD preserve readability and information hierarchy, but colors, layout, typography, animation style, and rendering technique may differ from the existing frontend.
- **GUD-004**: A generated frontend SHOULD visually emphasize the local player, the next checkpoint, and the difference between finished players and DNF players.
- **GUD-005**: When hosted in the browser, a generated frontend SHOULD prefer a same-origin `/racehub` path plus a reverse proxy rather than hard-coding a cross-origin backend URL.

- **PAT-001**: The recommended frontend architecture is event-driven: incoming hub events update a single source of truth, and rendering consumes that state.
- **PAT-002**: The recommended race input pattern is to send the full four-flag input state repeatedly while racing instead of sending individual key transitions only.

## 4. Interfaces & Data Contracts

### 4.1 Transport Profile

| Item | Value |
| --- | --- |
| Primary real-time transport | ASP.NET Core SignalR hub |
| Hub route | `/racehub` |
| Health endpoint | `GET /health` |
| Wire payload format | JSON with camelCase property names |
| Browser default hub URL in current frontend | `${window.location.origin}/racehub` |
| Non-browser fallback hub URL in current frontend | `http://localhost:5000/racehub` |
| Current local-development browser pattern | Vite same-origin proxy from `/racehub` to `http://localhost:5000` |
| Current production browser pattern | Frontend reverse proxy from `/racehub` to the backend origin |
| Current live Azure backend origin | `https://viberacing-backend.redriver-e1f73e16.eastus.azurecontainerapps.io` |
| Current live Azure hub URL | `https://viberacing-backend.redriver-e1f73e16.eastus.azurecontainerapps.io/racehub` |
| Current live Azure health URL | `https://viberacing-backend.redriver-e1f73e16.eastus.azurecontainerapps.io/health` |

Implementation note for generated frontends:

- If the frontend is served from the same origin as the `/racehub` path, no backend CORS support is required.
- If the frontend is served from a different origin, browser connectivity requires either:
  - a reverse proxy exposing `/racehub` on the frontend origin, or
  - a backend variant that explicitly enables CORS for that origin.
- The live Azure backend URL above is an environment-specific deployment target. It is safe to use as a proxy target, for server-side clients, or for browser clients only if the backend is configured to allow that origin.

### 4.2 HTTP Endpoints

| Method | Path | Response | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | `{ "status": "ok" }` | Health check and deployment verification. |

### 4.3 Client -> Server Hub Invocations

#### `JoinLobby`

Invokes the backend method `JoinLobby`.

```json
{
  "roomCode": "ABC123",
  "displayName": "Alice"
}
```

Rules:

- `roomCode` may be an empty string. Empty means "create a new room".
- The backend uppercases and trims `roomCode`.
- If `roomCode` is empty, the backend generates a six-character room code from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.
- `displayName` may be empty. The backend then assigns `Racer` plus the first four characters of the connection-derived player ID.
- The backend trims `displayName` and truncates it to a maximum of 20 characters.
- If the room is not in `Lobby` state, the backend rejects the join by sending `ErrorMessage`.

#### `ReadyUp`

Invokes the backend method `ReadyUp`.

Payload: none.

Rules:

- Marks the current player as ready.
- Broadcasts `PlayerReady` to the room.
- If all current room members are ready, the backend begins the countdown and race start sequence.

#### `SendInput`

Sends the latest input state to the backend using the hub method `SendInput`.

```json
{
  "accelerate": true,
  "brake": false,
  "turnLeft": false,
  "turnRight": true
}
```

Rules:

- The four booleans represent the complete current control state.
- The current frontend sends this payload every 16 ms while racing.
- The backend does not send an acknowledgement for this message.
- The backend stores the latest input state and consumes it on the next simulation tick.

### 4.4 Server -> Client Events

| Event | Receiver | Payload shape | When it is sent | Client obligation |
| --- | --- | --- | --- | --- |
| `LobbyJoined` | Caller only | `{ roomCode, playerId, displayName }` | After successful `JoinLobby` | Persist room code and player ID. |
| `LobbyState` | Caller only | `{ roomCode, players: LobbyPlayer[] }` | After successful `JoinLobby` | Populate the lobby roster and switch to lobby UI. |
| `PlayerJoined` | Other players in the room | `{ playerId, displayName }` | When another player joins | Add a new lobby participant with default `isReady = false`. |
| `PlayerLeft` | Remaining players in the room | `{ playerId }` | On disconnect | Remove the player from lobby, standings, and rendered players. |
| `PlayerReady` | Entire room | `{ playerId }` | After `ReadyUp` | Mark that player as ready. |
| `RaceCountdown` | Entire room | `{ secondsRemaining }` | Countdown seconds `3`, `2`, `1` | Show countdown UI. |
| `RaceStarted` | Entire room | `{}` | Immediately after countdown | Enter race mode and start race-only input transmission. |
| `TrackLoaded` | Caller only | `TrackData` | After join | Cache track geometry for rendering. |
| `GameSnapshot` | Entire room | `GameSnapshot` | Every 3 ticks of the 60 Hz server loop (20 Hz) | Update authoritative race state. |
| `ScoreboardUpdate` | Entire room | `ScoreboardUpdate` | Every 60 ticks of the 60 Hz server loop (1 Hz) | Update fallback standings if snapshots are unavailable. |
| `RaceFinished` | Entire room | `RaceFinished` | As soon as any player finishes the final lap | Stop race input/render loop and show results. |
| `ErrorMessage` | Caller only | `{ message }` | On backend-reported error | Surface the message to the user. |

### 4.5 Shared Data Contracts

All property names below are wire-level camelCase names.

```ts
interface LobbyPlayer {
  playerId: string;
  displayName: string;
  isReady: boolean;
}

interface TileData {
  col: number;
  row: number;
  type: string;      // current values: "straight" | "curve"
  rotation: number;  // degrees
}

interface CheckpointData {
  index: number;         // configured checkpoint identifier
  x: number;
  y: number;
  width: number;
  height: number;
  isFinishLine: boolean;
}

interface StartPosition {
  slot: number;
  x: number;
  y: number;
  angle: number;
}

interface TrackData {
  name: string;
  cols: number;
  rows: number;
  tileSize: number;
  tiles: TileData[];
  checkpoints: CheckpointData[];
  startPositions: StartPosition[];
}

interface PlayerSnapshot {
  playerId: string;
  displayName: string;
  x: number;
  y: number;
  angle: number;
  speed: number;
  lap: number;
  checkpointIndex: number;      // internal ordinal progress marker
  bestLapMs: number | null;
  finished: boolean;
  rank: number;
  lapTimeMs: number;
  nextCheckpointIndex: number | null; // compare to checkpoint.index
}

interface GameSnapshot {
  tick: number;
  timestamp: number; // Unix epoch milliseconds
  players: PlayerSnapshot[];
}

interface ScoreboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  lap: number;
  bestLapMs: number | null;
  finished: boolean;
}

interface ScoreboardUpdate {
  rankings: ScoreboardEntry[];
}

interface RaceResult {
  rank: number;
  playerId: string;
  displayName: string;
  totalTimeMs: number | null;
  bestLapMs: number | null;
}

interface RaceFinished {
  trackName: string;
  totalLaps: number;
  message?: string;
  results: RaceResult[];
}
```

### 4.6 Canonical Interaction Sequence

#### Sequence A: Connect and Join/Create Room

1. The frontend connects to `/racehub`.
2. The user submits `displayName` and optional `roomCode`.
3. The frontend invokes `JoinLobby({ roomCode, displayName })`.
4. The backend replies to the caller with:
   - `LobbyJoined`
   - `LobbyState`
   - `TrackLoaded`
5. Other players in the same room receive `PlayerJoined`.

#### Sequence B: Ready and Start

1. Each player invokes `ReadyUp()`.
2. The backend broadcasts `PlayerReady` each time.
3. When all players are ready:
   - the room enters countdown state
   - the backend broadcasts `RaceCountdown` for `3`, then `2`, then `1`
   - the backend broadcasts `RaceStarted`
4. The frontend switches to race mode and begins sending `SendInput`.

#### Sequence C: Race Loop

1. The frontend continuously sends `SendInput` while racing.
2. The backend simulates the race at 60 Hz.
3. The backend broadcasts:
   - `GameSnapshot` at 20 Hz
   - `ScoreboardUpdate` at 1 Hz
4. The frontend renders cars, checkpoints, HUD information, and standings from backend state.

#### Sequence D: Finish and Results

1. As soon as the first player finishes lap 3, the backend ends the race for everyone.
2. The backend broadcasts `RaceFinished`.
3. The frontend stops race-only input, stops race rendering, and shows results.
4. The current frontend offers a "Back to Lobby" button, but this is local UI navigation only. The current backend protocol does not support replaying the same room.

### 4.7 Required UI Information

The frontend is free to choose its visual style, but it must preserve the following information model.

#### Landing State

- Display name input
- Optional room code input
- Join/create action

#### Lobby State

- Current room code
- Full player list
- Each player's ready status
- Local player's own ready control

#### Countdown State

- Visible countdown number

#### Race State

- Rendered track from `TrackLoaded`
- Rendered player positions from `GameSnapshot.players`
- Clear identification of the local player
- Current lap/progress information for the local player
- Current standings
- Highlight for the next checkpoint using `nextCheckpointIndex`

#### Results State

- Backend-supplied completion message
- Rank
- Display name
- Total time or DNF
- Best lap

## 5. Acceptance Criteria

- **AC-001**: Given a running backend, When a client requests `GET /health`, Then the backend shall return HTTP 200 with `{ "status": "ok" }`.
- **AC-002**: Given an empty room code, When the client invokes `JoinLobby`, Then the caller shall receive `LobbyJoined` with a generated six-character uppercase room code and an opaque `playerId`.
- **AC-003**: Given an existing room in lobby state, When a second client joins with that room code, Then the existing client shall receive `PlayerJoined` and the new client shall receive `LobbyState` and `TrackLoaded`.
- **AC-004**: Given a room that is not in lobby state, When a client invokes `JoinLobby`, Then the caller shall receive `ErrorMessage` and shall not join the room.
- **AC-005**: Given a room with multiple players, When one player invokes `ReadyUp`, Then the entire room shall receive `PlayerReady` and the race shall not start until all players are ready.
- **AC-006**: Given all players are ready, When the last required `ReadyUp` arrives, Then the room shall receive `RaceCountdown` values `3`, `2`, and `1`, followed by `RaceStarted`.
- **AC-007**: Given the race has started, When the frontend sends repeated `SendInput` payloads, Then subsequent `GameSnapshot` events shall reflect server-applied movement.
- **AC-008**: Given `TrackLoaded` and `GameSnapshot.players[].nextCheckpointIndex`, When the frontend renders checkpoint guidance, Then it shall highlight the checkpoint whose `checkpoint.index` equals `nextCheckpointIndex`.
- **AC-009**: Given a `GameSnapshot`, When the frontend updates race state, Then lap, rank, finish status, and car positions shall come from the backend snapshot rather than local prediction.
- **AC-010**: Given any player finishes lap 3 first, When the backend emits `RaceFinished`, Then all clients shall transition out of the race screen and show the results leaderboard.
- **AC-011**: Given a `RaceResult` with `totalTimeMs = null`, When the frontend renders results, Then that player shall be shown as DNF.
- **AC-012**: Given the current protocol, When a user clicks "Back to Lobby" after `RaceFinished`, Then the frontend may return to a local lobby view, but replay in the same room shall not be assumed possible.
- **AC-013**: Given a browser-hosted frontend on a different origin from the backend, When the frontend tries to call `/racehub` directly against the current backend, Then connectivity shall be assumed unsupported unless a same-origin proxy or explicit backend CORS support is added.

## 6. Test Automation Strategy

- **Test Levels**:
  - Contract unit tests for payload decoding and state reducers
  - Integration tests against a running backend
  - Browser end-to-end tests for join, ready, race, and results flows
- **Frameworks**:
  - Current backend repository: xUnit and FluentAssertions
  - Current frontend repository: TypeScript build validation via `npm run build`
  - Generated frontend: choose framework freely, but it MUST support WebSocket/SignalR contract validation
- **Test Data Management**:
  - Use the default `dusty-fields` room configuration
  - Use deterministic display names and room codes in automated tests
  - Use fixture payloads that include `null` `bestLapMs`, `null` `totalTimeMs`, and `nextCheckpointIndex = null`
- **CI/CD Integration**:
  - At minimum run `dotnet test backend\VibeRacing.Tests\VibeRacing.Tests.csproj`
  - At minimum run `npm run build` for any frontend implementation in this repository
  - For generated frontends, add a smoke test that joins a room, receives `TrackLoaded`, processes one `GameSnapshot`, and handles `RaceFinished`
- **Coverage Requirements**:
  - Every client -> server invocation SHALL be exercised by at least one automated test
  - Every server -> client event SHALL be decoded and rendered by at least one automated test
  - The finish flow and the join-rejection flow SHALL each have dedicated tests
- **Performance Testing**:
  - Validate that a generated frontend remains usable with at least 8 simultaneous players
  - Smoke-test protocol correctness at 15 players, even if the implementation chooses to simplify visuals

## 7. Rationale & Context

The backend is intentionally authoritative for race state so frontend implementations stay simple and consistent. The client is responsible for presentation, user input collection, and local screen transitions, but not for race rules.

The current protocol is small and event-driven. That is useful for LLM-driven implementation because:

- there are few hub method names
- all payloads are JSON objects
- the lifecycle is linear and stateful
- the same track data package can drive both rendering and checkpoint highlighting

The styling guidance is intentionally loose because the goal is compatibility, not cloning. A generated frontend may use Canvas, WebGL, SVG, DOM, or another rendering approach as long as it presents the required information and follows the server contract.

The current backend favors same-origin browser connectivity. That is why the repository uses a local Vite proxy in development and an Nginx reverse proxy in production. A generated frontend served from another origin must account for that deployment constraint explicitly.

## 8. Dependencies & External Integrations

### External Systems

- **EXT-001**: VibeRacing backend HTTP service - exposes `GET /health` and SignalR `/racehub`.

### Third-Party Services

- **SVC-001**: SignalR-compatible client runtime - required to invoke hub methods and receive server events over supported transports.

### Infrastructure Dependencies

- **INF-001**: Static frontend host - required to serve the generated frontend.
- **INF-002**: Same-origin reverse proxy or explicit backend CORS support - required for browser-based cross-origin deployments under the current backend behavior.

### Data Dependencies

- **DAT-001**: `TrackLoaded` event payload - the frontend depends on this event for track geometry, checkpoints, and start positions.
- **DAT-002**: `GameSnapshot` event payload - the frontend depends on this event for authoritative race state.

### Technology Platform Dependencies

- **PLT-001**: Browser or client runtime capable of maintaining a SignalR connection.
- **PLT-002**: Keyboard input handling for four control booleans (`accelerate`, `brake`, `turnLeft`, `turnRight`) or an equivalent input abstraction.
- **PLT-003**: A rendering layer capable of drawing multiple moving cars, static track geometry, and UI overlays.

### Compliance Dependencies

- **COM-001**: No specific regulatory requirement is encoded in the current gameplay protocol.

## 9. Examples & Edge Cases

```json
// Example 1: create a new room
{
  "invoke": "JoinLobby",
  "payload": {
    "roomCode": "",
    "displayName": "Alice"
  }
}
```

```json
// Example 2: caller receives lobby join confirmation
{
  "event": "LobbyJoined",
  "payload": {
    "roomCode": "AB7KQ2",
    "playerId": "D3m4AbCdEfGhIjKlMn",
    "displayName": "Alice"
  }
}
```

```json
// Example 3: TrackLoaded excerpt for the default track
{
  "name": "Dusty Fields",
  "cols": 10,
  "rows": 8,
  "tileSize": 96,
  "checkpoints": [
    { "index": 0, "x": 432, "y": 96,  "width": 32, "height": 96, "isFinishLine": true },
    { "index": 1, "x": 768, "y": 416, "width": 96, "height": 32, "isFinishLine": false },
    { "index": 2, "x": 512, "y": 576, "width": 32, "height": 96, "isFinishLine": false },
    { "index": 3, "x": 96,  "y": 320, "width": 96, "height": 32, "isFinishLine": false }
  ]
}
```

```json
// Example 4: GameSnapshot excerpt
{
  "tick": 120,
  "timestamp": 1742389800000,
  "players": [
    {
      "playerId": "p1",
      "displayName": "Alice",
      "x": 250.5,
      "y": 163.2,
      "angle": 0.14,
      "speed": 122.8,
      "lap": 1,
      "checkpointIndex": 0,
      "bestLapMs": null,
      "finished": false,
      "rank": 1,
      "lapTimeMs": 1820,
      "nextCheckpointIndex": 1
    }
  ]
}
```

```json
// Example 5: RaceFinished with one finisher and one DNF
{
  "trackName": "Dusty Fields",
  "totalLaps": 3,
  "message": "We are done! Alice finished lap 3 first.",
  "results": [
    {
      "rank": 1,
      "playerId": "p1",
      "displayName": "Alice",
      "totalTimeMs": 91000,
      "bestLapMs": 29500
    },
    {
      "rank": 2,
      "playerId": "p2",
      "displayName": "Bob",
      "totalTimeMs": null,
      "bestLapMs": 31000
    }
  ]
}
```

Edge cases:

- `PlayerJoined` currently omits `isReady`. Treat missing `isReady` as `false`.
- `bestLapMs` is `null` until the player completes at least one full lap.
- `nextCheckpointIndex` becomes `null` for finished players.
- `totalTimeMs` is `null` for players who appear in results without finishing before the race ended.
- `displayName` is trimmed and truncated to 20 characters by the backend.
- `roomCode` is uppercased by the backend.
- The current protocol does not broadcast `totalLaps` before `RaceFinished`.
- The current frontend's automatic reconnect does not imply replay or session restoration at the application level.

## 10. Validation Criteria

An implementation conforms to this specification only if all of the following are true:

1. It can connect to the backend over `/racehub` using SignalR.
2. It can create a room and join an existing lobby room using `JoinLobby`.
3. It can render a lobby from `LobbyState` and incremental lobby updates from `PlayerJoined`, `PlayerLeft`, and `PlayerReady`.
4. It can cache and render `TrackLoaded` without relying on local track files.
5. It can start and stop race-only input transmission based on `RaceStarted` and `RaceFinished`.
6. It uses `GameSnapshot` as the authoritative gameplay state source.
7. It highlights the next checkpoint using `nextCheckpointIndex` matched against `checkpoint.index`.
8. It can display standings and final results including DNF states.
9. It surfaces backend errors to the user.
10. It does not claim support for rematch/replay in the same room unless the backend protocol is extended.
11. It documents or implements a same-origin proxy strategy if the frontend is browser-hosted on a different origin than the backend.

## 11. ASK
Build a front end, as quickly as possible, that can play VibeRacing using only the information in this specification and the public backend. The frontend does not need to be visually polished, but it must be functionally compatible with the backend and meet all of the validation criteria above.
The backend lives in: https://viberacing-backend.redriver-e1f73e16.eastus.azurecontainerapps.io as described previously.
