import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.183.2/build/three.module.js";
import { getTileSurfaceRotationDegrees } from "./tile-surface-rotation.js";

const TRACK_BASE_HEIGHT = 12;
const TRACK_SURFACE_OFFSET = TRACK_BASE_HEIGHT / 2 + 0.18;
const CHECKPOINT_HEIGHT = 8;
const FINISH_LINE_HEIGHT = 10;
const PLAYER_LERP_FACTOR = 8;
const ROAD_TEXTURE_SIZE = 512;
const PATTERN_TEXTURE_SIZE = 160;
const SKY_TEXTURE_WIDTH = 1024;
const SKY_TEXTURE_HEIGHT = 512;
const TERRAIN_BASE_Y = -TRACK_BASE_HEIGHT + 2;
const TRACK_BANK_DEPTH = 72;
const TRACK_BANK_BOTTOM_Y = TERRAIN_BASE_Y - 4;

let textureAnisotropy = 8;

const geometryCache = {
  tileBase: new THREE.BoxGeometry(1, TRACK_BASE_HEIGHT, 1),
  roadSurface: new THREE.PlaneGeometry(1, 1),
  checkpoint: new THREE.BoxGeometry(1, CHECKPOINT_HEIGHT, 1),
  finishCheckpoint: new THREE.BoxGeometry(1, FINISH_LINE_HEIGHT, 1),
  startSlot: new THREE.CylinderGeometry(0.5, 0.5, 1, 18),
  halo: new THREE.TorusGeometry(16, 1.6, 12, 48),
  arrow: new THREE.ConeGeometry(5, 14, 14),
  body: new THREE.BoxGeometry(30, 10, 18),
  cabin: new THREE.BoxGeometry(12, 7, 10),
  windowBand: new THREE.BoxGeometry(10, 4, 9),
  wheel: new THREE.BoxGeometry(4, 4, 3),
  spoiler: new THREE.BoxGeometry(4, 3, 18),
  bumper: new THREE.BoxGeometry(3, 3, 18),
  headlight: new THREE.BoxGeometry(2.2, 1.8, 3.8),
  taillight: new THREE.BoxGeometry(2.2, 1.8, 3.8),
  carShadow: new THREE.PlaneGeometry(1, 1),
  treeTrunk: new THREE.CylinderGeometry(3.2, 4.6, 24, 10),
  treeFoliage: new THREE.ConeGeometry(18, 34, 12),
  treeCanopy: new THREE.SphereGeometry(14, 16, 12),
  rock: new THREE.DodecahedronGeometry(10, 0),
  trackBank: createTrackBankGeometry(),
  skyDome: new THREE.SphereGeometry(1, 48, 24)
};

const materialCache = new Map();
const textureCache = new Map();
const patternCanvasCache = new Map();

export class RaceScene3D {
  constructor({ canvas, getPlayerColor }) {
    this.canvas = canvas;
    this.getPlayerColor = getPlayerColor;
    this.currentTrackKey = "";
    this.track = null;
    this.trackWidth = 0;
    this.trackDepth = 0;
    this.nextCheckpointIndex = null;
    this.localPlayerId = "";
    this.tileLookup = new Set();
    this.playerMeshes = new Map();
    this.checkpointMeshes = new Map();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    textureAnisotropy = Math.max(
      textureAnisotropy,
      this.renderer.capabilities.getMaxAnisotropy?.() ?? textureAnisotropy
    );

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xa9c8de);
    this.scene.fog = new THREE.Fog(0xc9d7e1, 1200, 4200);

    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 6000);
    this.camera.position.set(-180, 900, 640);

    this.timer = new THREE.Timer();
    this.timer.connect(document);

    this.world = new THREE.Group();
    this.backdropGroup = new THREE.Group();
    this.trackGroup = new THREE.Group();
    this.checkpointGroup = new THREE.Group();
    this.playerGroup = new THREE.Group();
    this.startGroup = new THREE.Group();
    this.sceneryGroup = new THREE.Group();
    this.world.add(
      this.backdropGroup,
      this.trackGroup,
      this.checkpointGroup,
      this.playerGroup,
      this.startGroup,
      this.sceneryGroup
    );
    this.scene.add(this.world);
    this.skyDome = new THREE.Mesh(geometryCache.skyDome, getSkyDomeMaterial());
    this.scene.add(this.skyDome);

    this.lightTarget = new THREE.Object3D();
    this.scene.add(this.lightTarget);

    this.ambientLight = new THREE.HemisphereLight(0xf6fbff, 0x4f6c4c, 1.18);
    this.directionalLight = new THREE.DirectionalLight(0xffefcf, 1.62);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.set(2048, 2048);
    this.directionalLight.shadow.bias = -0.00018;
    this.directionalLight.shadow.normalBias = 0.08;
    this.directionalLight.target = this.lightTarget;

    this.fillLight = new THREE.DirectionalLight(0xc0dcff, 0.28);
    this.fillLight.target = this.lightTarget;

    this.scene.add(this.ambientLight, this.directionalLight, this.fillLight);

    this.animationFrameId = 0;
    this.renderFrame = this.renderFrame.bind(this);
    this.animationFrameId = window.requestAnimationFrame(this.renderFrame);
  }

  update({ track, players, localPlayerId, nextCheckpointIndex }) {
    this.localPlayerId = localPlayerId ?? "";
    this.nextCheckpointIndex = nextCheckpointIndex ?? null;

    const trackKey = track ? JSON.stringify(track) : "";
    if (trackKey !== this.currentTrackKey) {
      this.currentTrackKey = trackKey;
      this.track = track ?? null;
      this.rebuildTrack();
    }

    this.syncPlayers(players ?? []);
    this.updateCheckpointHighlight();
  }

  rebuildTrack() {
    disposeChildren(this.backdropGroup);
    disposeChildren(this.trackGroup);
    disposeChildren(this.checkpointGroup);
    disposeChildren(this.startGroup);
    disposeChildren(this.sceneryGroup);
    this.checkpointMeshes.clear();

    if (!this.track) {
      this.trackWidth = 0;
      this.trackDepth = 0;
      return;
    }

    this.trackWidth = this.track.cols * this.track.tileSize;
    this.trackDepth = this.track.rows * this.track.tileSize;
    const terrainPadding = Math.max(this.track.tileSize * 8, 960);
    const terrainWidth = this.trackWidth + terrainPadding;
    const terrainDepth = this.trackDepth + terrainPadding;

    const terrain = new THREE.Mesh(
      createTerrainGeometry(terrainWidth, terrainDepth),
      createTerrainMaterial(terrainWidth, terrainDepth)
    );
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = TERRAIN_BASE_Y;
    terrain.receiveShadow = true;
    this.backdropGroup.add(terrain);
    this.trackGroup.add(this.createTrackFoundation(this.track.tileSize));

    for (const tile of this.track.tiles ?? []) {
      this.trackGroup.add(this.createTileMesh(tile, this.track.tileSize));
    }

    for (const checkpoint of this.track.checkpoints ?? []) {
      const checkpointMesh = this.createCheckpointMesh(checkpoint);
      this.checkpointMeshes.set(checkpoint.index, checkpointMesh);
      this.checkpointGroup.add(checkpointMesh);
    }

    for (const start of this.track.startPositions ?? []) {
      this.startGroup.add(this.createStartMarker(start));
    }

    this.populateScenery();
    this.positionCamera();
  }

  createTileMesh(tile, tileSize) {
    const tileGroup = new THREE.Group();
    const center = this.toWorldPosition(
      tile.col * tileSize + tileSize / 2,
      tile.row * tileSize + tileSize / 2,
      0
    );

    const surface = new THREE.Mesh(
      geometryCache.roadSurface,
      getRoadMaterial(tile.type, tile.col ?? 0, tile.row ?? 0)
    );
    surface.scale.set(tileSize, tileSize, 1);
    surface.rotation.x = -Math.PI / 2;
    surface.rotation.z = degToRad(
      getTileSurfaceRotationDegrees(tile.type, tile.rotation ?? 0)
    );
    surface.position.copy(center);
    surface.position.y = TRACK_SURFACE_OFFSET + 0.12;
    surface.receiveShadow = true;
    tileGroup.add(surface);

    return tileGroup;
  }

  createTrackFoundation(tileSize) {
    const group = new THREE.Group();
    const sideMaterial = getTileSideMaterial();
    const bottomMaterial = getTileBottomMaterial();
    const margin = tileSize * 0.35;
    const foundationWidth = this.trackWidth + margin;
    const foundationDepth = this.trackDepth + margin;
    const topMaterial = createFoundationTopMaterial(foundationWidth, foundationDepth);

    const foundation = new THREE.Mesh(geometryCache.tileBase, [
      sideMaterial,
      sideMaterial,
      topMaterial,
      bottomMaterial,
      sideMaterial,
      sideMaterial
    ]);
    foundation.scale.set(foundationWidth, 1, foundationDepth);
    foundation.castShadow = true;
    foundation.receiveShadow = true;
    group.add(foundation);

    for (const edge of ["north", "east", "south", "west"]) {
      group.add(this.createFoundationBank(edge, foundationWidth, foundationDepth));
    }

    return group;
  }

  createFoundationBank(edge, foundationWidth, foundationDepth) {
    const bank = new THREE.Mesh(geometryCache.trackBank, getTrackBankMaterial());
    const topY = TRACK_BASE_HEIGHT / 2 - 0.24;
    const height = topY - TRACK_BANK_BOTTOM_Y;
    const span = edge === "north" || edge === "south" ? foundationWidth : foundationDepth;

    bank.scale.set(span, height, TRACK_BANK_DEPTH * 1.45);
    bank.position.set(0, (topY + TRACK_BANK_BOTTOM_Y) / 2, 0);
    bank.castShadow = true;
    bank.receiveShadow = true;

    switch (edge) {
      case "north":
        bank.rotation.y = Math.PI;
        bank.position.z -= foundationDepth / 2;
        break;
      case "east":
        bank.rotation.y = -Math.PI / 2;
        bank.position.x += foundationWidth / 2;
        break;
      case "south":
        bank.position.z += foundationDepth / 2;
        break;
      case "west":
        bank.rotation.y = Math.PI / 2;
        bank.position.x -= foundationWidth / 2;
        break;
      default:
        break;
    }

    return bank;
  }

  createCheckpointMesh(checkpoint) {
    const geometry = checkpoint.isFinishLine ? geometryCache.finishCheckpoint : geometryCache.checkpoint;
    const material = new THREE.MeshStandardMaterial({
      color: checkpoint.isFinishLine ? 0xf8fafc : 0x38bdf8,
      emissive: checkpoint.isFinishLine ? 0x334155 : 0x0ea5e9,
      emissiveIntensity: 0.18,
      transparent: true,
      opacity: checkpoint.isFinishLine ? 0.3 : 0.18,
      roughness: 0.28,
      metalness: 0.05
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(checkpoint.width, 1, checkpoint.height);
    mesh.position.copy(
      this.toWorldPosition(
        checkpoint.x + checkpoint.width / 2,
        checkpoint.y + checkpoint.height / 2,
        TRACK_SURFACE_OFFSET + geometry.parameters.height / 2
      )
    );
    mesh.castShadow = true;
    mesh.userData.isFinishLine = checkpoint.isFinishLine;
    mesh.userData.index = checkpoint.index;
    return mesh;
  }

  createStartMarker(start) {
    const marker = new THREE.Mesh(
      geometryCache.startSlot,
      new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.14,
        transparent: true,
        opacity: 0.4,
        roughness: 0.3,
        metalness: 0.1
      })
    );

    marker.scale.set(16, 4, 16);
    marker.position.copy(this.toWorldPosition(start.x, start.y, TRACK_SURFACE_OFFSET + 3));
    marker.castShadow = true;
    return marker;
  }

  populateScenery() {
    const clearanceX = this.trackWidth / 2 + 170;
    const clearanceZ = this.trackDepth / 2 + 170;
    const outerX = this.trackWidth / 2 + 620;
    const outerZ = this.trackDepth / 2 + 620;
    const groundY = TERRAIN_BASE_Y - 4;
    const treeCount = 28;
    const rockCount = 15;

    for (let index = 0; index < treeCount; index += 1) {
      const angle = (index / treeCount) * Math.PI * 2 + hash2D(index, 7, 461) * 0.42;
      const radiusX = lerp(clearanceX, outerX, hash2D(index, 11, 487));
      const radiusZ = lerp(clearanceZ, outerZ, hash2D(index, 17, 503));
      const scale = lerp(0.72, 1.28, hash2D(index, 19, 521));
      const tree = this.createTree(scale, hash2D(index, 23, 547));
      tree.position.set(Math.cos(angle) * radiusX, groundY, Math.sin(angle) * radiusZ);
      tree.rotation.y = hash2D(index, 29, 571) * Math.PI * 2;
      this.sceneryGroup.add(tree);
    }

    for (let index = 0; index < rockCount; index += 1) {
      const angle = (index / rockCount) * Math.PI * 2 + hash2D(index, 31, 593) * 0.48;
      const radiusX = lerp(clearanceX + 40, outerX - 40, hash2D(index, 37, 607));
      const radiusZ = lerp(clearanceZ + 40, outerZ - 40, hash2D(index, 41, 631));
      const cluster = new THREE.Group();
      const clusterScale = lerp(0.72, 1.12, hash2D(index, 43, 653));

      for (let piece = 0; piece < 3; piece += 1) {
        const rock = this.createRock(clusterScale * lerp(0.56, 0.92, hash2D(piece, index, 677)));
        rock.position.set(
          (hash2D(piece, index, 701) - 0.5) * 18,
          piece * 1.4,
          (hash2D(index, piece, 719) - 0.5) * 16
        );
        rock.rotation.set(
          0.08 + hash2D(piece, index, 733) * 0.16,
          hash2D(index, piece, 751) * Math.PI * 2,
          -0.12 + hash2D(piece, index, 769) * 0.18
        );
        cluster.add(rock);
      }

      cluster.position.set(Math.cos(angle) * radiusX, groundY - 5, Math.sin(angle) * radiusZ);
      cluster.rotation.y = hash2D(index, 47, 787) * Math.PI * 2;
      this.sceneryGroup.add(cluster);
    }
  }

  createTree(scale, variant = 0) {
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(geometryCache.treeTrunk, getTreeTrunkMaterial());
    trunk.position.y = 12 * scale;
    trunk.scale.setScalar(scale);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    group.add(trunk);

    if (variant < 0.45) {
      for (const [height, widthScale] of [
        [32, 1.08],
        [48, 0.9],
        [60, 0.7]
      ]) {
        const foliage = new THREE.Mesh(geometryCache.treeFoliage, getFoliageMaterial());
        foliage.position.y = height * scale;
        foliage.scale.set(widthScale * scale, scale, widthScale * scale);
        foliage.castShadow = true;
        foliage.receiveShadow = true;
        group.add(foliage);
      }
    } else {
      for (const [x, y, z, radius] of [
        [-5, 30, -3, 0.88],
        [7, 35, 4, 1.02],
        [0, 42, 0, 1.16]
      ]) {
        const canopy = new THREE.Mesh(geometryCache.treeCanopy, getFoliageMaterial());
        canopy.position.set(x * scale, y * scale, z * scale);
        canopy.scale.setScalar(radius * scale);
        canopy.castShadow = true;
        canopy.receiveShadow = true;
        group.add(canopy);
      }
    }

    return group;
  }

  createRock(scale) {
    const rock = new THREE.Mesh(geometryCache.rock, getRockMaterial());
    rock.scale.set(scale, scale * 0.72, scale * 0.9);
    rock.castShadow = true;
    rock.receiveShadow = true;
    return rock;
  }

  syncPlayers(players) {
    const seenPlayers = new Set();

    for (const player of players) {
      seenPlayers.add(player.playerId);
      let mesh = this.playerMeshes.get(player.playerId);
      if (!mesh) {
        mesh = this.createPlayerMesh(player);
        this.playerMeshes.set(player.playerId, mesh);
        this.playerGroup.add(mesh);
      }

      mesh.userData.player = player;
      mesh.userData.targetPosition.copy(this.toWorldPosition(player.x, player.y, TRACK_SURFACE_OFFSET + 9));
      mesh.userData.targetRotation = -player.angle;
      mesh.userData.halo.visible = player.playerId === this.localPlayerId;
      mesh.userData.arrow.visible = player.playerId === this.localPlayerId;
      mesh.userData.finished.visible = Boolean(player.finished);
    }

    for (const [playerId, mesh] of this.playerMeshes) {
      if (seenPlayers.has(playerId)) {
        continue;
      }

      this.playerGroup.remove(mesh);
      this.playerMeshes.delete(playerId);
    }
  }

  createPlayerMesh(player) {
    const group = new THREE.Group();
    group.position.copy(this.toWorldPosition(player.x, player.y, TRACK_SURFACE_OFFSET + 9));

    const bodyMaterial = new THREE.MeshPhysicalMaterial({
      color: this.getPlayerColor(player.playerId),
      roughness: 0.36,
      metalness: 0.16,
      clearcoat: 0.65,
      clearcoatRoughness: 0.26,
      emissive: player.playerId === this.localPlayerId ? 0xffffff : 0x000000,
      emissiveIntensity: player.playerId === this.localPlayerId ? 0.04 : 0
    });
    const trimMaterial = new THREE.MeshStandardMaterial({
      color: 0x1f2937,
      roughness: 0.45,
      metalness: 0.22
    });
    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xc8e7ff,
      roughness: 0.12,
      metalness: 0,
      transmission: 0.45,
      transparent: true,
      opacity: 0.75
    });
    const wheelMaterial = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.84,
      metalness: 0.05
    });
    const chromeMaterial = new THREE.MeshStandardMaterial({
      color: 0xe5e7eb,
      roughness: 0.28,
      metalness: 0.42
    });

    const shadow = new THREE.Mesh(geometryCache.carShadow, getCarShadowMaterial());
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -8.3;
    shadow.scale.set(38, 24, 1);
    group.add(shadow);

    const body = new THREE.Mesh(geometryCache.body, bodyMaterial);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const bumperFront = new THREE.Mesh(geometryCache.bumper, chromeMaterial);
    bumperFront.position.set(16, -1.4, 0);
    bumperFront.castShadow = true;
    group.add(bumperFront);

    const bumperRear = bumperFront.clone();
    bumperRear.position.x = -16;
    group.add(bumperRear);

    const cabin = new THREE.Mesh(geometryCache.cabin, bodyMaterial.clone());
    cabin.scale.set(0.9, 0.95, 0.82);
    cabin.position.set(-1.5, 7.2, 0);
    cabin.castShadow = true;
    group.add(cabin);

    const windowBand = new THREE.Mesh(geometryCache.windowBand, glassMaterial);
    windowBand.position.set(-1.5, 8.1, 0);
    group.add(windowBand);

    const spoiler = new THREE.Mesh(geometryCache.spoiler, trimMaterial);
    spoiler.position.set(-14, 7.2, 0);
    spoiler.castShadow = true;
    group.add(spoiler);

    for (const wheelPosition of [
      [10, -4.2, 10],
      [10, -4.2, -10],
      [-10, -4.2, 10],
      [-10, -4.2, -10]
    ]) {
      const wheel = new THREE.Mesh(geometryCache.wheel, wheelMaterial);
      wheel.position.set(...wheelPosition);
      wheel.castShadow = true;
      group.add(wheel);
    }

    for (const lightZ of [-5.5, 5.5]) {
      const headlight = new THREE.Mesh(
        geometryCache.headlight,
        new THREE.MeshStandardMaterial({
          color: 0xfef3c7,
          emissive: 0xfde68a,
          emissiveIntensity: 0.28,
          roughness: 0.2,
          metalness: 0.08
        })
      );
      headlight.position.set(15.2, 1.2, lightZ);
      group.add(headlight);

      const taillight = new THREE.Mesh(
        geometryCache.taillight,
        new THREE.MeshStandardMaterial({
          color: 0xfca5a5,
          emissive: 0xdc2626,
          emissiveIntensity: 0.26,
          roughness: 0.22,
          metalness: 0.08
        })
      );
      taillight.position.set(-15.2, 1.2, lightZ);
      group.add(taillight);
    }

    const halo = new THREE.Mesh(
      geometryCache.halo,
      new THREE.MeshBasicMaterial({
        color: 0xf8fafc,
        transparent: true,
        opacity: 0.78
      })
    );
    halo.rotation.x = Math.PI / 2;
    halo.position.y = -7;
    halo.visible = false;
    group.add(halo);

    const arrow = new THREE.Mesh(
      geometryCache.arrow,
      new THREE.MeshStandardMaterial({
        color: 0xfacc15,
        emissive: 0xf59e0b,
        emissiveIntensity: 0.42,
        roughness: 0.38,
        metalness: 0.08
      })
    );
    arrow.position.set(0, 28, 0);
    arrow.visible = false;
    group.add(arrow);

    const finished = new THREE.Mesh(
      new THREE.SphereGeometry(4, 12, 12),
      new THREE.MeshStandardMaterial({
        color: 0x22c55e,
        emissive: 0x15803d,
        emissiveIntensity: 0.3,
        roughness: 0.32,
        metalness: 0.05
      })
    );
    finished.position.set(0, 18, 0);
    finished.visible = false;
    group.add(finished);

    group.userData = {
      targetPosition: group.position.clone(),
      targetRotation: 0,
      halo,
      arrow,
      finished
    };

    return group;
  }

  updateCheckpointHighlight() {
    const pulse = (Math.sin(performance.now() * 0.006) + 1) / 2;

    for (const [index, mesh] of this.checkpointMeshes) {
      const isNext = index === this.nextCheckpointIndex;
      const material = mesh.material;
      material.opacity = isNext ? 0.72 : mesh.userData.isFinishLine ? 0.3 : 0.16;
      material.emissiveIntensity = isNext ? 0.78 : mesh.userData.isFinishLine ? 0.2 : 0.12;
      mesh.scale.y = isNext ? 1 + pulse * 0.4 : 1;
    }
  }

  positionCamera() {
    const maxDimension = Math.max(this.trackWidth, this.trackDepth, 720);
    this.camera.position.set(-maxDimension * 0.28, maxDimension * 0.58, maxDimension * 0.94);
    this.camera.lookAt(0, 16, maxDimension * 0.02);
    this.camera.near = 1;
    this.camera.far = maxDimension * 7;
    this.camera.updateProjectionMatrix();

    this.scene.fog.near = maxDimension * 1.1;
    this.scene.fog.far = maxDimension * 3.8;
    this.directionalLight.position.set(maxDimension * 0.52, maxDimension * 1.08, maxDimension * 0.26);
    this.fillLight.position.set(-maxDimension * 0.48, maxDimension * 0.34, -maxDimension * 0.56);
    this.lightTarget.position.set(0, 0, 0);
    this.skyDome.scale.setScalar(maxDimension * 5.6);

    const shadowSpan = maxDimension * 0.78;
    this.directionalLight.shadow.camera.left = -shadowSpan;
    this.directionalLight.shadow.camera.right = shadowSpan;
    this.directionalLight.shadow.camera.top = shadowSpan;
    this.directionalLight.shadow.camera.bottom = -shadowSpan;
    this.directionalLight.shadow.camera.near = 10;
    this.directionalLight.shadow.camera.far = maxDimension * 3.6;
    this.directionalLight.shadow.camera.updateProjectionMatrix();
  }

  renderFrame(timestamp) {
    this.animationFrameId = window.requestAnimationFrame(this.renderFrame);

    if (resizeRendererToDisplaySize(this.renderer)) {
      const renderCanvas = this.renderer.domElement;
      this.camera.aspect = renderCanvas.clientWidth / renderCanvas.clientHeight;
      this.camera.updateProjectionMatrix();
    }

    this.timer.update(timestamp);
    const delta = Math.min(this.timer.getDelta(), 0.05);
    const movementAlpha = Math.min(1, delta * PLAYER_LERP_FACTOR);
    this.skyDome.position.copy(this.camera.position);

    for (const mesh of this.playerMeshes.values()) {
      mesh.position.lerp(mesh.userData.targetPosition, movementAlpha);
      mesh.rotation.y = lerpAngle(mesh.rotation.y, mesh.userData.targetRotation, movementAlpha);
      mesh.userData.arrow.position.y = 28 + Math.sin(performance.now() * 0.01) * 2.5;
    }

    this.updateCheckpointHighlight();
    this.renderer.render(this.scene, this.camera);
  }

  toWorldPosition(x, y, height) {
    return new THREE.Vector3(
      x - this.trackWidth / 2,
      height,
      y - this.trackDepth / 2
    );
  }
}

function getRoadMaterial(tileType, col = 0, row = 0) {
  const variant = positiveModulo(col * 17 + row * 29, 4);
  const key = `road:${tileType}:${variant}`;
  if (materialCache.has(key)) {
    return materialCache.get(key);
  }

  const textures = getRoadTextureSet(tileType, variant);
  const material = new THREE.MeshStandardMaterial({
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: tileType === "curve" ? 1.35 : 1.15,
    transparent: true,
    alphaTest: 0.14,
    roughness: 0.86,
    metalness: 0.03
  });

  materialCache.set(key, material);
  return material;
}

function getTileTopMaterial() {
  const key = "tile-top";
  if (materialCache.has(key)) {
    return materialCache.get(key);
  }

  const textures = createRepeatingTextureSet("grass", 3.2, 3.2, true);
  const material = new THREE.MeshStandardMaterial({
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: 2.1,
    roughness: 0.97,
    metalness: 0.01
  });

  materialCache.set(key, material);
  return material;
}

function getTileSideMaterial() {
  const key = "tile-side";
  if (materialCache.has(key)) {
    return materialCache.get(key);
  }

  const textures = createRepeatingTextureSet("dirt", 1.2, 0.42, true);
  const material = new THREE.MeshStandardMaterial({
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: 1.7,
    roughness: 0.93,
    metalness: 0.02
  });

  materialCache.set(key, material);
  return material;
}

function getTrackBankMaterial() {
  const key = "track-bank";
  if (materialCache.has(key)) {
    return materialCache.get(key);
  }

  const textures = createRepeatingTextureSet("dirt", 1.3, 0.92, true);
  const material = new THREE.MeshStandardMaterial({
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: 2,
    roughness: 0.96,
    metalness: 0
  });

  materialCache.set(key, material);
  return material;
}

function getTileBottomMaterial() {
  const key = "tile-bottom";
  if (materialCache.has(key)) {
    return materialCache.get(key);
  }

  const material = new THREE.MeshStandardMaterial({
    color: 0x4b3726,
    roughness: 0.98,
    metalness: 0.01
  });

  materialCache.set(key, material);
  return material;
}

function createTerrainMaterial(width, depth) {
  const textures = createLargeTerrainTextureSet(width, depth);
  return new THREE.MeshStandardMaterial({
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: 2.8,
    roughness: 0.98,
    metalness: 0
  });
}

function createFoundationTopMaterial(width, depth) {
  const textures = createFoundationTextureSet(width, depth);
  return new THREE.MeshStandardMaterial({
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: 1.8,
    roughness: 0.96,
    metalness: 0
  });
}

function getSkyDomeMaterial() {
  const key = "sky-dome";
  if (materialCache.has(key)) {
    return materialCache.get(key);
  }

  const texture = getTextureSet("sky-dome-texture", createSkyTexture);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });

  materialCache.set(key, material);
  return material;
}

function getCarShadowMaterial() {
  const key = "car-shadow";
  if (materialCache.has(key)) {
    return materialCache.get(key);
  }

  const texture = getTextureSet("shadow-soft", createSoftShadowTexture);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity: 0.38
  });

  materialCache.set(key, material);
  return material;
}

function getTreeTrunkMaterial() {
  const key = "tree-trunk";
  if (materialCache.has(key)) {
    return materialCache.get(key);
  }

  const textures = createRepeatingTextureSet("bark", 1.1, 2.6, true);
  const material = new THREE.MeshStandardMaterial({
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: 1.2,
    roughness: 0.95,
    metalness: 0.01
  });

  materialCache.set(key, material);
  return material;
}

function getFoliageMaterial() {
  const key = "foliage";
  if (materialCache.has(key)) {
    return materialCache.get(key);
  }

  const textures = createRepeatingTextureSet("foliage", 2.2, 2.2, true);
  const material = new THREE.MeshStandardMaterial({
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: 1.35,
    roughness: 0.92,
    metalness: 0
  });

  materialCache.set(key, material);
  return material;
}

function getRockMaterial() {
  const key = "rock";
  if (materialCache.has(key)) {
    return materialCache.get(key);
  }

  const textures = createRepeatingTextureSet("rock", 1.4, 1.4, true);
  const material = new THREE.MeshStandardMaterial({
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: 1.25,
    roughness: 0.9,
    metalness: 0.02
  });

  materialCache.set(key, material);
  return material;
}

function createRepeatingTextureSet(kind, repeatX, repeatY, colorTexture = false) {
  const patternSet = getPatternCanvasSet(kind);
  return {
    color: createCanvasTexture(patternSet.color, {
      colorSpace: colorTexture ? THREE.SRGBColorSpace : null,
      repeatX,
      repeatY
    }),
    bump: createCanvasTexture(patternSet.bump, { repeatX, repeatY })
  };
}

function getRoadTextureSet(tileType, variant) {
  return getTextureSet(`road-textures:${tileType}:${variant}`, () => createRoadTextureSet(tileType, variant));
}

function createRoadTextureSet(tileType, variant) {
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = ROAD_TEXTURE_SIZE;
  colorCanvas.height = ROAD_TEXTURE_SIZE;

  const bumpCanvas = document.createElement("canvas");
  bumpCanvas.width = ROAD_TEXTURE_SIZE;
  bumpCanvas.height = ROAD_TEXTURE_SIZE;

  const contexts = {
    color: colorCanvas.getContext("2d"),
    bump: bumpCanvas.getContext("2d")
  };

  if (tileType === "curve") {
    drawCurveRoadTexture(contexts, ROAD_TEXTURE_SIZE, variant);
  } else {
    drawStraightRoadTexture(contexts, ROAD_TEXTURE_SIZE, variant);
  }

  return {
    color: createCanvasTexture(colorCanvas, { colorSpace: THREE.SRGBColorSpace }),
    bump: createCanvasTexture(bumpCanvas)
  };
}

function drawStraightRoadTexture(contexts, size, variant) {
  const roadWidth = size * 0.54;
  const roadX = (size - roadWidth) / 2;
  const curbWidth = size * 0.052;
  const shoulderWidth = size * 0.085;

  const shoulderPath = new Path2D();
  shoulderPath.rect(
    roadX - shoulderWidth - curbWidth,
    0,
    roadWidth + (shoulderWidth + curbWidth) * 2,
    size
  );

  const roadPath = new Path2D();
  roadPath.rect(roadX, 0, roadWidth, size);

  fillPathWithPattern(contexts.color, shoulderPath, getPatternCanvasSet("gravel").color);
  fillPathWithPattern(contexts.bump, shoulderPath, getPatternCanvasSet("gravel").bump);
  fillPathWithPattern(contexts.color, roadPath, getPatternCanvasSet("asphalt").color);
  fillPathWithPattern(contexts.bump, roadPath, getPatternCanvasSet("asphalt").bump);

  addStraightRoadShading(contexts.color, roadPath, roadX, roadWidth, size);
  drawStraightCurbBand(contexts.color, roadX - curbWidth, curbWidth, size, ["#f8fafc", "#dc2626"]);
  drawStraightCurbBand(contexts.color, roadX + roadWidth, curbWidth, size, ["#dc2626", "#f8fafc"]);
  drawStraightCurbBand(contexts.bump, roadX - curbWidth, curbWidth, size, ["#cfcfcf", "#4b4b4b"]);
  drawStraightCurbBand(contexts.bump, roadX + roadWidth, curbWidth, size, ["#4b4b4b", "#cfcfcf"]);
  drawStraightLaneMarkings(contexts.color, roadX, roadWidth, size, { dashOffset: variant * size * 0.03 });
  drawStraightLaneMarkings(contexts.bump, roadX, roadWidth, size, {
    color: "rgba(84,84,84,0.95)",
    dashOffset: variant * size * 0.03
  });
  drawStraightTireMarks(contexts.color, roadPath, roadX, roadWidth, size, 0.16, variant);
  drawStraightTireMarks(contexts.bump, roadPath, roadX, roadWidth, size, 0.28, variant);
  drawStraightWear(contexts.color, roadPath, roadX, roadWidth, size, variant);
  drawStraightWear(contexts.bump, roadPath, roadX, roadWidth, size, variant, { color: "rgba(76,76,76,0.42)" });
}

function drawCurveRoadTexture(contexts, size, variant) {
  const outerRadius = size * 0.78;
  const innerRadius = size * 0.3;
  const curbWidth = size * 0.05;
  const shoulderWidth = size * 0.08;

  const shoulderPath = createRingSectorPath(
    0,
    size,
    innerRadius - shoulderWidth - curbWidth,
    outerRadius + shoulderWidth + curbWidth,
    -Math.PI / 2,
    0
  );
  const roadPath = createRingSectorPath(0, size, innerRadius, outerRadius, -Math.PI / 2, 0);

  fillPathWithPattern(contexts.color, shoulderPath, getPatternCanvasSet("gravel").color);
  fillPathWithPattern(contexts.bump, shoulderPath, getPatternCanvasSet("gravel").bump);
  fillPathWithPattern(contexts.color, roadPath, getPatternCanvasSet("asphalt").color);
  fillPathWithPattern(contexts.bump, roadPath, getPatternCanvasSet("asphalt").bump);

  addCurveRoadShading(contexts.color, roadPath, size, innerRadius, outerRadius);
  drawArcCurbBand(
    contexts.color,
    0,
    size,
    outerRadius,
    outerRadius + curbWidth,
    -Math.PI / 2,
    0,
    ["#f8fafc", "#dc2626"]
  );
  drawArcCurbBand(
    contexts.color,
    0,
    size,
    innerRadius - curbWidth,
    innerRadius,
    -Math.PI / 2,
    0,
    ["#dc2626", "#f8fafc"]
  );
  drawArcCurbBand(
    contexts.bump,
    0,
    size,
    outerRadius,
    outerRadius + curbWidth,
    -Math.PI / 2,
    0,
    ["#cfcfcf", "#4b4b4b"]
  );
  drawArcCurbBand(
    contexts.bump,
    0,
    size,
    innerRadius - curbWidth,
    innerRadius,
    -Math.PI / 2,
    0,
    ["#4b4b4b", "#cfcfcf"]
  );
  drawCurveLaneMarkings(contexts.color, size, innerRadius, outerRadius, { dashOffset: variant * size * 0.028 });
  drawCurveLaneMarkings(contexts.bump, size, innerRadius, outerRadius, {
    color: "rgba(86,86,86,0.95)",
    dashOffset: variant * size * 0.028
  });
  drawCurveTireMarks(contexts.color, roadPath, size, innerRadius, outerRadius, 0.16, variant);
  drawCurveTireMarks(contexts.bump, roadPath, size, innerRadius, outerRadius, 0.28, variant);
  drawCurveWear(contexts.color, roadPath, size, innerRadius, outerRadius, variant);
  drawCurveWear(contexts.bump, roadPath, size, innerRadius, outerRadius, variant, { color: "rgba(74,74,74,0.4)" });
}

function addStraightRoadShading(context, roadPath, roadX, roadWidth, size) {
  context.save();
  context.clip(roadPath);
  const gradient = context.createLinearGradient(roadX, 0, roadX + roadWidth, 0);
  gradient.addColorStop(0, "rgba(0,0,0,0.32)");
  gradient.addColorStop(0.16, "rgba(255,255,255,0.08)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.03)");
  gradient.addColorStop(0.84, "rgba(255,255,255,0.08)");
  gradient.addColorStop(1, "rgba(0,0,0,0.32)");
  context.fillStyle = gradient;
  context.fillRect(roadX, 0, roadWidth, size);
  context.restore();
}

function addCurveRoadShading(context, roadPath, size, innerRadius, outerRadius) {
  context.save();
  context.clip(roadPath);
  const gradient = context.createRadialGradient(0, size, innerRadius, 0, size, outerRadius);
  gradient.addColorStop(0, "rgba(0,0,0,0.28)");
  gradient.addColorStop(0.32, "rgba(255,255,255,0.07)");
  gradient.addColorStop(0.72, "rgba(255,255,255,0.02)");
  gradient.addColorStop(1, "rgba(0,0,0,0.3)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  context.restore();
}

function drawStraightCurbBand(context, startX, width, height, colors) {
  const stripeHeight = 18;
  for (let offset = 0; offset < height; offset += stripeHeight) {
    context.fillStyle = colors[Math.floor(offset / stripeHeight) % colors.length];
    context.fillRect(startX, offset, width, Math.min(stripeHeight, height - offset));
  }
}

function drawArcCurbBand(context, cx, cy, innerRadius, outerRadius, startAngle, endAngle, colors) {
  const stripeCount = 10;
  const stripeSize = (endAngle - startAngle) / stripeCount;
  for (let index = 0; index < stripeCount; index += 1) {
    const path = createRingSectorPath(
      cx,
      cy,
      innerRadius,
      outerRadius,
      startAngle + stripeSize * index,
      Math.min(endAngle, startAngle + stripeSize * (index + 1))
    );
    context.fillStyle = colors[index % colors.length];
    context.fill(path);
  }
}

function drawStraightLaneMarkings(context, roadX, roadWidth, size, options = {}) {
  const color = options.color ?? "rgba(248,250,252,0.92)";

  context.save();
  context.lineCap = "round";
  context.strokeStyle = color;

  context.lineWidth = size * 0.01;
  context.beginPath();
  context.moveTo(roadX + roadWidth * 0.13, size * 0.06);
  context.lineTo(roadX + roadWidth * 0.13, size * 0.94);
  context.moveTo(roadX + roadWidth * 0.87, size * 0.06);
  context.lineTo(roadX + roadWidth * 0.87, size * 0.94);
  context.stroke();

  context.setLineDash([size * 0.09, size * 0.08]);
  context.lineDashOffset = -(options.dashOffset ?? 0);
  context.lineWidth = size * 0.014;
  context.beginPath();
  context.moveTo(roadX + roadWidth * 0.5, size * 0.08);
  context.lineTo(roadX + roadWidth * 0.5, size * 0.92);
  context.stroke();
  context.restore();
}

function drawCurveLaneMarkings(context, size, innerRadius, outerRadius, options = {}) {
  const color = options.color ?? "rgba(248,250,252,0.92)";
  const centerRadius = (innerRadius + outerRadius) / 2;

  context.save();
  context.lineCap = "round";
  context.strokeStyle = color;

  context.lineWidth = size * 0.01;
  context.beginPath();
  context.arc(0, size, innerRadius + (outerRadius - innerRadius) * 0.12, -Math.PI / 2, 0);
  context.stroke();

  context.beginPath();
  context.arc(0, size, outerRadius - (outerRadius - innerRadius) * 0.12, -Math.PI / 2, 0);
  context.stroke();

  context.setLineDash([size * 0.08, size * 0.075]);
  context.lineDashOffset = -(options.dashOffset ?? 0);
  context.lineWidth = size * 0.014;
  context.beginPath();
  context.arc(0, size, centerRadius, -Math.PI / 2, 0);
  context.stroke();
  context.restore();
}

function drawStraightTireMarks(context, roadPath, roadX, roadWidth, size, opacity = 0.18, variant = 0) {
  context.save();
  context.clip(roadPath);
  context.strokeStyle = `rgba(0,0,0,${opacity})`;
  context.lineWidth = size * 0.012;

  for (const [index, offset] of [0.31, 0.39, 0.61, 0.69].entries()) {
    const wobble = (hash2D(index, variant, 211) - 0.5) * 0.035;
    context.beginPath();
    context.moveTo(roadX + roadWidth * (offset + wobble), size * 0.08);
    context.bezierCurveTo(
      roadX + roadWidth * (offset + 0.02 + wobble),
      size * (0.26 + hash2D(index + 2, variant, 227) * 0.1),
      roadX + roadWidth * (offset - 0.02 + wobble),
      size * (0.62 + hash2D(index + 5, variant, 239) * 0.1),
      roadX + roadWidth * (offset + wobble),
      size * 0.92
    );
    context.stroke();
  }

  context.restore();
}

function drawCurveTireMarks(context, roadPath, size, innerRadius, outerRadius, opacity = 0.18, variant = 0) {
  const firstTrack = innerRadius + (outerRadius - innerRadius) * (0.3 + hash2D(1, variant, 149) * 0.06);
  const secondTrack = innerRadius + (outerRadius - innerRadius) * (0.64 + hash2D(2, variant, 173) * 0.06);

  context.save();
  context.clip(roadPath);
  context.strokeStyle = `rgba(0,0,0,${opacity})`;
  context.lineWidth = size * 0.012;
  context.beginPath();
  context.arc(0, size, firstTrack, -Math.PI / 2 + 0.03 + variant * 0.005, -0.05);
  context.stroke();

  context.beginPath();
  context.arc(0, size, secondTrack, -Math.PI / 2 + 0.035 + variant * 0.005, -0.045);
  context.stroke();
  context.restore();
}

function drawStraightWear(context, roadPath, roadX, roadWidth, size, variant, options = {}) {
  const color = options.color ?? "rgba(255,255,255,0.05)";
  context.save();
  context.clip(roadPath);
  context.fillStyle = color;
  context.strokeStyle = options.strokeColor ?? "rgba(0,0,0,0.18)";

  for (let index = 0; index < 3; index += 1) {
    const patchX = roadX + roadWidth * (0.18 + index * 0.24 + hash2D(index, variant, 313) * 0.08);
    const patchY = size * (0.12 + hash2D(index + 3, variant, 331) * 0.62);
    const patchWidth = roadWidth * (0.08 + hash2D(index + 7, variant, 347) * 0.06);
    const patchHeight = size * (0.06 + hash2D(index + 11, variant, 359) * 0.08);
    context.globalAlpha = 0.16;
    context.fillRect(patchX, patchY, patchWidth, patchHeight);
  }

  context.globalAlpha = 1;
  context.lineWidth = size * 0.006;
  context.beginPath();
  context.moveTo(roadX + roadWidth * (0.22 + variant * 0.03), size * 0.2);
  context.lineTo(roadX + roadWidth * (0.26 + variant * 0.03), size * 0.82);
  context.moveTo(roadX + roadWidth * (0.72 - variant * 0.025), size * 0.18);
  context.lineTo(roadX + roadWidth * (0.68 - variant * 0.025), size * 0.76);
  context.stroke();
  context.restore();
}

function drawCurveWear(context, roadPath, size, innerRadius, outerRadius, variant, options = {}) {
  const color = options.color ?? "rgba(255,255,255,0.05)";
  const wearRadius = innerRadius + (outerRadius - innerRadius) * (0.52 + hash2D(5, variant, 383) * 0.12);
  context.save();
  context.clip(roadPath);
  context.strokeStyle = options.strokeColor ?? "rgba(0,0,0,0.16)";
  context.lineWidth = size * 0.006;
  context.beginPath();
  context.arc(0, size, wearRadius, -Math.PI / 2 + 0.08, -0.08);
  context.stroke();

  context.fillStyle = color;
  context.globalAlpha = 0.16;
  context.beginPath();
  context.arc(
    size * 0.16,
    size * 0.88,
    size * (0.03 + hash2D(7, variant, 401) * 0.02),
    0,
    Math.PI * 2
  );
  context.fill();
  context.restore();
}

function createTerrainGeometry(width, depth) {
  const segmentsX = Math.max(24, Math.round(width / 90));
  const segmentsY = Math.max(24, Math.round(depth / 90));
  const geometry = new THREE.PlaneGeometry(width, depth, segmentsX, segmentsY);
  const positions = geometry.attributes.position;

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const distance = Math.max(Math.abs(x) / (width * 0.5), Math.abs(y) / (depth * 0.5));
    const edgeWeight = smoothstep(0.22, 0.96, distance);
    const ridgeWeight = smoothstep(0.56, 0.98, distance);
    const rolling = (fractalNoise(x * 0.012, y * 0.012, 19, 4) - 0.5) * 24;
    const smallDetail = (fractalNoise(x * 0.04, y * 0.04, 44, 2) - 0.5) * 6;
    const ridge = ridgeWeight * (10 + fractalNoise(x * 0.0055, y * 0.0055, 91, 3) * 34);
    const basin = (1 - smoothstep(0.12, 0.38, distance)) * 4.5;
    positions.setZ(index, rolling * edgeWeight + smallDetail * (0.22 + edgeWeight) + ridge - basin - 8);
  }

  geometry.computeVertexNormals();
  return geometry;
}

function createLargeTerrainTextureSet(width, depth) {
  const textureSize = 1024;
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = textureSize;
  colorCanvas.height = textureSize;

  const bumpCanvas = document.createElement("canvas");
  bumpCanvas.width = textureSize;
  bumpCanvas.height = textureSize;

  const colorContext = colorCanvas.getContext("2d");
  const colorImage = colorContext.createImageData(textureSize, textureSize);

  const bumpContext = bumpCanvas.getContext("2d");
  const bumpImage = bumpContext.createImageData(textureSize, textureSize);

  for (let y = 0; y < textureSize; y += 1) {
    for (let x = 0; x < textureSize; x += 1) {
      const sample = sampleLargeTerrain((x / textureSize) * width, (y / textureSize) * depth);
      const offset = (y * textureSize + x) * 4;
      colorImage.data[offset] = sample.color[0];
      colorImage.data[offset + 1] = sample.color[1];
      colorImage.data[offset + 2] = sample.color[2];
      colorImage.data[offset + 3] = 255;
      bumpImage.data[offset] = sample.bump;
      bumpImage.data[offset + 1] = sample.bump;
      bumpImage.data[offset + 2] = sample.bump;
      bumpImage.data[offset + 3] = 255;
    }
  }

  colorContext.putImageData(colorImage, 0, 0);
  bumpContext.putImageData(bumpImage, 0, 0);

  return {
    color: createCanvasTexture(colorCanvas, { colorSpace: THREE.SRGBColorSpace }),
    bump: createCanvasTexture(bumpCanvas)
  };
}

function createFoundationTextureSet(width, depth) {
  const textureSize = 1024;
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = textureSize;
  colorCanvas.height = textureSize;

  const bumpCanvas = document.createElement("canvas");
  bumpCanvas.width = textureSize;
  bumpCanvas.height = textureSize;

  const colorContext = colorCanvas.getContext("2d");
  const colorImage = colorContext.createImageData(textureSize, textureSize);

  const bumpContext = bumpCanvas.getContext("2d");
  const bumpImage = bumpContext.createImageData(textureSize, textureSize);

  for (let y = 0; y < textureSize; y += 1) {
    for (let x = 0; x < textureSize; x += 1) {
      const sample = sampleFoundationGrass((x / textureSize) * width, (y / textureSize) * depth);
      const offset = (y * textureSize + x) * 4;
      colorImage.data[offset] = sample.color[0];
      colorImage.data[offset + 1] = sample.color[1];
      colorImage.data[offset + 2] = sample.color[2];
      colorImage.data[offset + 3] = 255;
      bumpImage.data[offset] = sample.bump;
      bumpImage.data[offset + 1] = sample.bump;
      bumpImage.data[offset + 2] = sample.bump;
      bumpImage.data[offset + 3] = 255;
    }
  }

  colorContext.putImageData(colorImage, 0, 0);
  bumpContext.putImageData(bumpImage, 0, 0);

  return {
    color: createCanvasTexture(colorCanvas, { colorSpace: THREE.SRGBColorSpace }),
    bump: createCanvasTexture(bumpCanvas)
  };
}

function getPatternCanvasSet(kind) {
  if (patternCanvasCache.has(kind)) {
    return patternCanvasCache.get(kind);
  }

  const canvases = createPatternCanvasSet(kind);
  patternCanvasCache.set(kind, canvases);
  return canvases;
}

function createPatternCanvasSet(kind) {
  const color = document.createElement("canvas");
  color.width = PATTERN_TEXTURE_SIZE;
  color.height = PATTERN_TEXTURE_SIZE;

  const bump = document.createElement("canvas");
  bump.width = PATTERN_TEXTURE_SIZE;
  bump.height = PATTERN_TEXTURE_SIZE;

  const colorContext = color.getContext("2d");
  const colorImage = colorContext.createImageData(PATTERN_TEXTURE_SIZE, PATTERN_TEXTURE_SIZE);

  const bumpContext = bump.getContext("2d");
  const bumpImage = bumpContext.createImageData(PATTERN_TEXTURE_SIZE, PATTERN_TEXTURE_SIZE);

  for (let y = 0; y < PATTERN_TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < PATTERN_TEXTURE_SIZE; x += 1) {
      const sample = sampleSurface(kind, x, y);
      const offset = (y * PATTERN_TEXTURE_SIZE + x) * 4;
      colorImage.data[offset] = sample.color[0];
      colorImage.data[offset + 1] = sample.color[1];
      colorImage.data[offset + 2] = sample.color[2];
      colorImage.data[offset + 3] = 255;
      bumpImage.data[offset] = sample.bump;
      bumpImage.data[offset + 1] = sample.bump;
      bumpImage.data[offset + 2] = sample.bump;
      bumpImage.data[offset + 3] = 255;
    }
  }

  colorContext.putImageData(colorImage, 0, 0);
  bumpContext.putImageData(bumpImage, 0, 0);

  return { color, bump };
}

function sampleSurface(kind, x, y) {
  switch (kind) {
    case "grass":
      return sampleGrass(x, y);
    case "foliage":
      return sampleFoliage(x, y);
    case "terrain":
      return sampleTerrain(x, y);
    case "dirt":
      return sampleDirt(x, y);
    case "bark":
      return sampleBark(x, y);
    case "gravel":
      return sampleGravel(x, y);
    case "rock":
      return sampleRock(x, y);
    case "asphalt":
    default:
      return sampleAsphalt(x, y);
  }
}

function sampleGrass(x, y) {
  const broad = fractalNoise(x * 0.035, y * 0.035, 11, 4);
  const blades = fractalNoise(x * 0.16, y * 0.16, 27, 3);
  const dry = smoothstep(0.6, 0.88, fractalNoise(x * 0.02, y * 0.02, 43, 3));
  const pebble = fractalNoise(x * 0.42, y * 0.42, 71, 2);

  const r = 28 + broad * 18 + dry * 22 + (pebble > 0.9 ? 10 : 0);
  const g = 74 + broad * 58 - dry * 9 + blades * 12;
  const b = 18 + broad * 10 - dry * 5;
  const bump = 110 + broad * 42 + blades * 58;

  return {
    color: [clampByte(r), clampByte(g), clampByte(b)],
    bump: clampByte(bump)
  };
}

function sampleTerrain(x, y) {
  const grass = sampleGrass(x, y);
  const dirt = sampleDirt(x, y);
  const patch = smoothstep(0.64, 0.9, fractalNoise(x * 0.018, y * 0.018, 87, 4));
  const mixAmount = patch * 0.75;
  const color = mixColors(grass.color, dirt.color, mixAmount);
  const bump = lerp(grass.bump, dirt.bump, mixAmount * 0.7);
  return { color, bump: clampByte(bump) };
}

function sampleLargeTerrain(x, y) {
  const broadGrass = fractalNoise(x * 0.01, y * 0.01, 117, 5);
  const blades = fractalNoise(x * 0.045, y * 0.045, 139, 3);
  const dryField = smoothstep(0.52, 0.84, fractalNoise(x * 0.0045, y * 0.0045, 151, 4));
  const dirtPatches = smoothstep(0.68, 0.9, fractalNoise(x * 0.007, y * 0.007, 167, 4));
  const rut = smoothstep(0.78, 0.92, fractalNoise(x * 0.03, y * 0.006, 181, 3));

  const lush = 1 - dryField * 0.45;
  const r = 34 + broadGrass * 18 + dirtPatches * 34 + rut * 6;
  const g = 72 + broadGrass * 44 * lush - dirtPatches * 8 + blades * 8;
  const b = 20 + broadGrass * 12 - dirtPatches * 4;
  const bump = 102 + broadGrass * 34 + blades * 42 + dirtPatches * 28;

  return {
    color: [clampByte(r), clampByte(g), clampByte(b)],
    bump: clampByte(bump)
  };
}

function sampleFoundationGrass(x, y) {
  const broad = fractalNoise(x * 0.006, y * 0.006, 881, 5);
  const variation = fractalNoise(x * 0.03, y * 0.03, 907, 3);
  const worn = smoothstep(0.72, 0.92, fractalNoise(x * 0.012, y * 0.012, 929, 4));
  const mow = (Math.sin((x + y * 0.35) * 0.032) + 1) * 0.5;

  const r = 38 + broad * 16 + variation * 8 + mow * 6;
  const g = 88 + broad * 34 + variation * 18 - worn * 10;
  const b = 28 + broad * 12 + mow * 4;
  const bump = 96 + broad * 28 + variation * 24 + mow * 12;

  return {
    color: [clampByte(r), clampByte(g), clampByte(b)],
    bump: clampByte(bump)
  };
}

function sampleFoliage(x, y) {
  const broad = fractalNoise(x * 0.05, y * 0.05, 191, 4);
  const leaves = fractalNoise(x * 0.2, y * 0.2, 211, 3);
  const sunHit = smoothstep(0.66, 0.9, fractalNoise(x * 0.03, y * 0.03, 223, 3));

  const r = 26 + broad * 22 + sunHit * 18;
  const g = 70 + broad * 58 + leaves * 16;
  const b = 18 + broad * 14;
  const bump = 112 + broad * 38 + leaves * 54;

  return {
    color: [clampByte(r), clampByte(g), clampByte(b)],
    bump: clampByte(bump)
  };
}

function sampleDirt(x, y) {
  const broad = fractalNoise(x * 0.04, y * 0.04, 7, 4);
  const stones = fractalNoise(x * 0.24, y * 0.24, 29, 2);
  const striation = (Math.sin(y * 0.22 + broad * 5.5) + 1) * 0.5;

  const r = 92 + broad * 30 + striation * 18 + stones * 10;
  const g = 62 + broad * 20 + striation * 8;
  const b = 38 + broad * 10;
  const bump = 96 + broad * 56 + stones * 74 + striation * 20;

  return {
    color: [clampByte(r), clampByte(g), clampByte(b)],
    bump: clampByte(bump)
  };
}

function sampleBark(x, y) {
  const grain = fractalNoise(x * 0.05, y * 0.16, 233, 4);
  const ridges = smoothstep(0.58, 0.94, Math.abs(Math.sin(x * 0.2 + grain * 5.2)));
  const moss = smoothstep(0.78, 0.92, fractalNoise(x * 0.025, y * 0.025, 251, 3));

  const r = 82 + grain * 26 - ridges * 18 - moss * 10;
  const g = 56 + grain * 18 - ridges * 12 + moss * 10;
  const b = 34 + grain * 8 - ridges * 8;
  const bump = 120 + grain * 28 + ridges * 78;

  return {
    color: [clampByte(r), clampByte(g), clampByte(b)],
    bump: clampByte(bump)
  };
}

function sampleGravel(x, y) {
  const broad = fractalNoise(x * 0.09, y * 0.09, 13, 4);
  const pebbles = fractalNoise(x * 0.32, y * 0.32, 55, 2);
  const dust = smoothstep(0.54, 0.88, fractalNoise(x * 0.03, y * 0.03, 93, 3));

  const r = 118 + broad * 34 + pebbles * 22 + dust * 16;
  const g = 108 + broad * 28 + dust * 8;
  const b = 94 + broad * 22 - dust * 2;
  const bump = 104 + broad * 58 + pebbles * 92;

  return {
    color: [clampByte(r), clampByte(g), clampByte(b)],
    bump: clampByte(bump)
  };
}

function sampleAsphalt(x, y) {
  const broad = fractalNoise(x * 0.085, y * 0.085, 5, 4);
  const aggregate = fractalNoise(x * 0.32, y * 0.32, 17, 2);
  const oil = smoothstep(0.72, 0.92, fractalNoise(x * 0.018, y * 0.018, 61, 3));
  const seam = Math.abs(Math.sin((x + y) * 0.085 + broad * 7)) > 0.985 ? 18 : 0;

  const base = 52 + broad * 24 + aggregate * 10 - oil * 20 - seam;
  const bump = 86 + broad * 40 + aggregate * 80 - oil * 12;

  return {
    color: [clampByte(base), clampByte(base + 1), clampByte(base + 3)],
    bump: clampByte(bump)
  };
}

function sampleRock(x, y) {
  const broad = fractalNoise(x * 0.06, y * 0.06, 263, 4);
  const speckle = fractalNoise(x * 0.22, y * 0.22, 281, 2);
  const vein = smoothstep(0.74, 0.94, fractalNoise(x * 0.03, y * 0.12, 307, 3));

  const r = 108 + broad * 28 + vein * 18;
  const g = 106 + broad * 24 + speckle * 10;
  const b = 110 + broad * 22 + speckle * 12;
  const bump = 118 + broad * 46 + speckle * 58;

  return {
    color: [clampByte(r), clampByte(g), clampByte(b)],
    bump: clampByte(bump)
  };
}

function createSoftShadowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(0,0,0,0.92)");
  gradient.addColorStop(0.42, "rgba(0,0,0,0.58)");
  gradient.addColorStop(0.78, "rgba(0,0,0,0.12)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return createCanvasTexture(canvas);
}

function createSkyTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = SKY_TEXTURE_WIDTH;
  canvas.height = SKY_TEXTURE_HEIGHT;
  const context = canvas.getContext("2d");

  const skyGradient = context.createLinearGradient(0, 0, 0, SKY_TEXTURE_HEIGHT);
  skyGradient.addColorStop(0, "#48698c");
  skyGradient.addColorStop(0.28, "#84aeca");
  skyGradient.addColorStop(0.56, "#c8dbe6");
  skyGradient.addColorStop(0.72, "#d9d8c5");
  skyGradient.addColorStop(1, "#b1c6d3");
  context.fillStyle = skyGradient;
  context.fillRect(0, 0, SKY_TEXTURE_WIDTH, SKY_TEXTURE_HEIGHT);

  const sunGlow = context.createRadialGradient(
    SKY_TEXTURE_WIDTH * 0.72,
    SKY_TEXTURE_HEIGHT * 0.24,
    SKY_TEXTURE_HEIGHT * 0.05,
    SKY_TEXTURE_WIDTH * 0.72,
    SKY_TEXTURE_HEIGHT * 0.24,
    SKY_TEXTURE_HEIGHT * 0.38
  );
  sunGlow.addColorStop(0, "rgba(255,248,214,0.85)");
  sunGlow.addColorStop(0.24, "rgba(255,239,182,0.42)");
  sunGlow.addColorStop(1, "rgba(255,239,182,0)");
  context.fillStyle = sunGlow;
  context.fillRect(0, 0, SKY_TEXTURE_WIDTH, SKY_TEXTURE_HEIGHT);

  for (let index = 0; index < 34; index += 1) {
    const x = hash2D(index, 3, 811) * SKY_TEXTURE_WIDTH;
    const y = SKY_TEXTURE_HEIGHT * (0.14 + hash2D(index, 7, 823) * 0.34);
    const width = 140 + hash2D(index, 11, 839) * 240;
    const height = 34 + hash2D(index, 13, 853) * 52;
    const cloud = context.createRadialGradient(x, y, 0, x, y, width * 0.55);
    cloud.addColorStop(0, "rgba(255,255,255,0.17)");
    cloud.addColorStop(0.58, "rgba(255,255,255,0.08)");
    cloud.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = cloud;
    context.beginPath();
    context.ellipse(x, y, width, height, hash2D(index, 17, 877) * 0.25, 0, Math.PI * 2);
    context.fill();
  }

  const horizonHaze = context.createLinearGradient(0, SKY_TEXTURE_HEIGHT * 0.56, 0, SKY_TEXTURE_HEIGHT * 0.9);
  horizonHaze.addColorStop(0, "rgba(255,255,255,0)");
  horizonHaze.addColorStop(1, "rgba(255,255,255,0.12)");
  context.fillStyle = horizonHaze;
  context.fillRect(0, SKY_TEXTURE_HEIGHT * 0.52, SKY_TEXTURE_WIDTH, SKY_TEXTURE_HEIGHT * 0.38);

  return createCanvasTexture(canvas, { colorSpace: THREE.SRGBColorSpace });
}

function createCanvasTexture(canvas, options = {}) {
  const texture = new THREE.CanvasTexture(canvas);
  if (options.colorSpace) {
    texture.colorSpace = options.colorSpace;
  }

  if ((options.repeatX ?? 1) !== 1 || (options.repeatY ?? 1) !== 1) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(options.repeatX ?? 1, options.repeatY ?? 1);
  }

  texture.anisotropy = textureAnisotropy;
  return texture;
}

function fillPathWithPattern(context, path, patternCanvas) {
  const pattern = context.createPattern(patternCanvas, "repeat");
  context.save();
  context.clip(path);
  context.fillStyle = pattern;
  context.fillRect(0, 0, ROAD_TEXTURE_SIZE, ROAD_TEXTURE_SIZE);
  context.restore();
}

function createRingSectorPath(centerX, centerY, innerRadius, outerRadius, startAngle, endAngle) {
  const path = new Path2D();
  path.arc(centerX, centerY, outerRadius, startAngle, endAngle);
  path.arc(centerX, centerY, innerRadius, endAngle, startAngle, true);
  path.closePath();
  return path;
}

function resizeRendererToDisplaySize(renderer) {
  const canvas = renderer.domElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  if (!width || !height) {
    return false;
  }

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const displayWidth = Math.floor(width * pixelRatio);
  const displayHeight = Math.floor(height * pixelRatio);
  const needResize = canvas.width !== displayWidth || canvas.height !== displayHeight;
  if (needResize) {
    renderer.setSize(width, height, false);
  }

  return needResize;
}

function createTrackBankGeometry() {
  const geometry = new THREE.BufferGeometry();
  const vertices = new Float32Array([
    -0.5, 0.5, 0,
     0.5, 0.5, 0,
    -0.5, -0.5, 1,
     0.5, -0.5, 1,
    -0.5, -0.5, 0,
     0.5, -0.5, 0
  ]);
  const uvs = new Float32Array([
    0, 1,
    1, 1,
    0, 0,
    1, 0,
    0, 0,
    1, 0
  ]);
  const indices = [
    0, 1, 3,
    0, 3, 2,
    4, 5, 3,
    4, 3, 2,
    0, 4, 5,
    0, 5, 1,
    0, 2, 4,
    1, 5, 3
  ];

  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function lerpAngle(current, target, alpha) {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * alpha;
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function disposeChildren(group) {
  for (const child of [...group.children]) {
    group.remove(child);
  }
}

function fractalNoise(x, y, seed, octaves = 4) {
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;
  let weight = 0;

  for (let index = 0; index < octaves; index += 1) {
    total += valueNoise(x * frequency, y * frequency, seed + index * 13.1) * amplitude;
    weight += amplitude;
    frequency *= 2;
    amplitude *= 0.5;
  }

  return total / weight;
}

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const sx = smoothstep(0, 1, x - x0);
  const sy = smoothstep(0, 1, y - y0);

  const n00 = hash2D(x0, y0, seed);
  const n10 = hash2D(x1, y0, seed);
  const n01 = hash2D(x0, y1, seed);
  const n11 = hash2D(x1, y1, seed);

  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
}

function hash2D(x, y, seed) {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return value - Math.floor(value);
}

function smoothstep(edge0, edge1, value) {
  const amount = clamp((value - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function mixColors(a, b, amount) {
  return [
    clampByte(lerp(a[0], b[0], amount)),
    clampByte(lerp(a[1], b[1], amount)),
    clampByte(lerp(a[2], b[2], amount))
  ];
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampByte(value) {
  return Math.round(clamp(value, 0, 255));
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function getTextureSet(key, factory) {
  if (textureCache.has(key)) {
    return textureCache.get(key);
  }

  const value = factory();
  textureCache.set(key, value);
  return value;
}
