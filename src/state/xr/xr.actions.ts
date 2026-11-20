// Headset sessions (VR / passthrough AR): support detection, start and end,
// the settings and the saved AR alignments. The running session is a live
// handle, so it lives here rather than in the store.

import { consoleActions } from '../../components/panels/console/console.actions';
import type { Renderer } from '../../lib/render/renderer';
import { storageKey } from '../../lib/storageKeys';
import { scenesToEvict } from '../../lib/xr/anchorSlots';
import { getXr } from '../../lib/xr/webxr';
import type { WorldPose } from '../../lib/xr/xrMath';
import {
  startXrSession,
  type XrSavedAlignment,
  type XrSessionHandle,
  xrUnavailableReason,
} from '../../lib/xr/xrSession';
import { navState } from '../viewer/nav.state';
import { getRenderer, viewerActions } from '../viewer/viewer.actions';
import {
  XR_REFRESH_RATES,
  XR_SETTINGS_DEFAULTS,
  type XrMode,
  type XrRunSettings,
  type XrSupport,
  xrSettingsState,
  xrState,
} from './xr.state';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** A saved alignment and when (ms) — the oldest is dropped first. */
type StoredAlignment = XrSavedAlignment & Readonly<{ savedAt: number }>;

/** Saved AR alignments, keyed by scene (the loaded models). */
type AlignmentMap = Record<string, StoredAlignment>;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SETTINGS_KEY = storageKey('xr');
const ALIGNMENTS_KEY = storageKey('xrAlignments');
/** Anchors this viewer made and no longer uses, waiting for an AR session to
 *  delete them from the headset (the anchors API needs a running session). */
const FORGOTTEN_KEY = storageKey('xrForgottenAnchors');
const MATRIX_SIZE = 16;
/** A Quest keeps at most 8 persistent anchors per site. One slot stays free:
 *  a new alignment is saved before the one it replaces is deleted. */
const MAX_KEPT_ALIGNMENTS = 7;

// -----------------------------------------------------------------------------
// Live handles
// -----------------------------------------------------------------------------

let session: XrSessionHandle | null = null;
let isStarted = false;
/** The support line last written to the console — logged again only on a change. */
let loggedSupport = '';

// -----------------------------------------------------------------------------
// Helper functions
// -----------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isMatrix(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === MATRIX_SIZE && v.every((n: unknown) => typeof n === 'number');
}

/** A stored alignment, or null for a malformed one (older entries carry no
 *  `savedAt` and count as the oldest). */
function parseAlignment(v: unknown): StoredAlignment | null {
  if (!isRecord(v) || typeof v.anchor !== 'string' || !isMatrix(v.offset)) {
    return null;
  }

  return { anchor: v.anchor, offset: v.offset, savedAt: readNumber(v.savedAt, 0) };
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — non-fatal
  }
}

function readNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function readChoice<T extends string>(v: unknown, choices: readonly T[], fallback: T): T {
  return choices.find((c) => c === v) ?? fallback;
}

/** XR settings from storage or a settings file — unknown or mistyped fields
 *  fall back to the defaults. */
function parseSettings(value: unknown): XrRunSettings {
  if (!isRecord(value)) {
    return XR_SETTINGS_DEFAULTS;
  }

  const d = XR_SETTINGS_DEFAULTS;

  return {
    refreshRate: readChoice(value.refreshRate, XR_REFRESH_RATES, d.refreshRate),
    renderScale: readNumber(value.renderScale, d.renderScale),
    msaa: readBoolean(value.msaa, d.msaa),
    foveation: readNumber(value.foveation, d.foveation),
    snapTurnDeg: readNumber(value.snapTurnDeg, d.snapTurnDeg),
    mirror: readBoolean(value.mirror, d.mirror),
    sendDepth: readBoolean(value.sendDepth, d.sendDepth),
  };
}

function loadAlignments(): AlignmentMap {
  const stored = readJson(ALIGNMENTS_KEY);
  const out: AlignmentMap = {};
  if (isRecord(stored)) {
    for (const [key, value] of Object.entries(stored)) {
      const alignment = parseAlignment(value);
      if (alignment) {
        out[key] = alignment;
      }
    }
  }

  return out;
}

function writeAlignments(map: AlignmentMap): void {
  writeJson(ALIGNMENTS_KEY, map);
  xrState.set({ alignmentCount: Object.keys(map).length });
}

function loadForgotten(): string[] {
  const stored = readJson(FORGOTTEN_KEY);

  return Array.isArray(stored) ? stored.filter((id: unknown): id is string => typeof id === 'string') : [];
}

function queueForDeletion(ids: readonly string[]): void {
  if (ids.length === 0) {
    return;
  }

  writeJson(FORGOTTEN_KEY, [...new Set([...loadForgotten(), ...ids])]);
}

function markAnchorsDeleted(ids: readonly string[]): void {
  const gone = new Set(ids);
  writeJson(
    FORGOTTEN_KEY,
    loadForgotten().filter((id) => !gone.has(id)),
  );
}

/** A new alignment for a scene replaces its old one, whose anchor is queued
 *  for deletion (the session deletes it right away and reports back). */
function saveAlignment(scene: string, alignment: XrSavedAlignment): void {
  const map = loadAlignments();
  const previous = map[scene];
  if (previous && previous.anchor !== alignment.anchor) {
    queueForDeletion([previous.anchor]);
  }
  writeAlignments({ ...map, [scene]: { ...alignment, savedAt: Date.now() } });
  consoleActions.log('info', 'XR: alignment saved — this scene opens aligned here next time');
}

/** Keep the saved alignments within what the headset can hold: the oldest
 *  (never the current scene's) are dropped and their anchors queued for
 *  deletion. Runs before an AR session starts. */
function evictOldAlignments(scene: string): void {
  const map = loadAlignments();
  const savedAt = Object.fromEntries(Object.entries(map).map(([key, a]) => [key, a.savedAt]));
  const evicted = scenesToEvict(savedAt, scene, MAX_KEPT_ALIGNMENTS);
  if (evicted.length === 0) {
    return;
  }

  queueForDeletion(evicted.map((key) => map[key].anchor));
  writeAlignments(Object.fromEntries(Object.entries(map).filter(([key]) => !evicted.includes(key))));
  consoleActions.log(
    'info',
    `XR: dropped the ${evicted.length} oldest saved alignment(s) — a headset keeps only a few anchors per site`,
  );
}

/** The scene an AR alignment belongs to: the loaded models, by name. */
function sceneKey(renderer: Renderer): string {
  return renderer
    .liveModels()
    .map((m) => m.name)
    .sort()
    .join('|');
}

async function detectSupport(renderer: Renderer): Promise<XrSupport> {
  const xr = getXr();
  const reason = xrUnavailableReason(renderer);
  if (!xr || reason) {
    return { vr: false, ar: false, reason };
  }

  const [vr, ar] = await Promise.all([
    xr.isSessionSupported('immersive-vr').catch(() => false),
    xr.isSessionSupported('immersive-ar').catch(() => false),
  ]);

  return {
    vr,
    ar,
    reason: vr || ar ? null : 'No headset found — connect one, or open the viewer in the headset browser.',
  };
}

/** Put the desktop camera where the user stood in the headset, keeping its
 *  orbit distance (the pivot lands that far ahead along the view). */
function placeDesktopCamera(renderer: Renderer, pose: WorldPose): void {
  const cam = renderer.camera;
  const [fx, fy, fz] = pose.forward;
  const length = Math.hypot(fx, fy, fz) || 1;
  const f: [number, number, number] = [fx / length, fy / length, fz / length];
  const dist = cam.focusDist;
  const target: [number, number, number] = [
    pose.eye[0] + f[0] * dist,
    pose.eye[1] + f[1] * dist,
    pose.eye[2] + f[2] * dist,
  ];
  cam.setPose(target, Math.atan2(f[1], f[0]), Math.asin(Math.max(-1, Math.min(1, f[2]))), dist);
}

function handleEnd(renderer: Renderer, mode: XrMode, pose: WorldPose | null): void {
  session = null;
  xrState.set({ status: { kind: 'idle' } });
  if (pose) {
    placeDesktopCamera(renderer, pose);
  }
  consoleActions.log('info', `XR: ${mode.toUpperCase()} session ended`);
}

async function refreshSupport(renderer: Renderer): Promise<void> {
  const support = await detectSupport(renderer);
  xrState.set({ support });
  const line = describeXrSupport(support);
  if (line !== loggedSupport) {
    loggedSupport = line;
    consoleActions.log('info', line);
  }
}

/** One line on what can start here — the console at boot and Settings › XR. */
export function describeXrSupport(support: XrSupport): string {
  const modes = [support.vr ? 'VR' : '', support.ar ? 'AR (passthrough)' : ''].filter(Boolean);
  if (modes.length > 0) {
    return `XR: ${modes.join(' and ')} available — start from Home › Camera`;
  }

  return `XR: not available — ${support.reason ?? 'no headset session can start here'}`;
}

// -----------------------------------------------------------------------------
// Persistence: settings load once, then follow the store
// -----------------------------------------------------------------------------

xrSettingsState.set(parseSettings(readJson(SETTINGS_KEY)));
xrSettingsState.subscribe(() => writeJson(SETTINGS_KEY, xrSettingsState.get()));

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

export const xrActions = {
  /** Once the renderer is up: find out what can start, and look again when
   *  a headset connects or disconnects. Idempotent. */
  init(renderer: Renderer): void {
    xrState.set({ alignmentCount: Object.keys(loadAlignments()).length });
    if (isStarted) {
      void refreshSupport(renderer);
      return;
    }

    isStarted = true;
    void refreshSupport(renderer);
    getXr()?.addEventListener('devicechange', () => {
      const current = getRenderer();
      if (current) {
        void refreshSupport(current);
      }
    });
  },

  /** Enter VR / AR, or leave the running session. Call from a click or key
   *  press — the browser only starts a session inside a user gesture. */
  async toggle(mode: XrMode): Promise<void> {
    const { status } = xrState.get();
    if (status.kind === 'running') {
      session?.end();
      return;
    }
    const renderer = getRenderer();
    if (status.kind === 'starting' || !renderer) {
      return;
    }

    xrState.set({ status: { kind: 'starting', mode }, lastError: null });
    const scene = sceneKey(renderer);
    if (mode === 'ar') {
      evictOldAlignments(scene);
    }
    const cam = renderer.camera;
    const settings = xrSettingsState.get();
    // a standalone headset has no audience at its 2D page: the mirror is pure cost there
    const isStandalone = renderer.adapterHints?.isMobile ?? false;
    const result = await startXrSession({
      mode,
      renderer,
      settings: { ...settings, mirror: settings.mirror && !isStandalone },
      start: { eye: cam.eye(), forward: cam.forward() },
      near: cam.near,
      alignment: mode === 'ar' ? (loadAlignments()[scene] ?? null) : null,
      forgetAnchors: mode === 'ar' ? loadForgotten() : [],
      hooks: {
        speeds: () => ({ move: navState.get().flySpeed, sprint: navState.get().flyShift }),
        onSelect: (id) => void viewerActions.selectFromPick(id, false),
        onAlignmentSaved: (alignment) => saveAlignment(scene, alignment),
        onAnchorsDeleted: markAnchorsDeleted,
        onFps: (fps) => xrState.set((s) => (s.status.kind === 'running' ? { status: { ...s.status, fps } } : s)),
        onMessage: (text) => consoleActions.log('info', text),
        onEnd: (pose) => handleEnd(renderer, mode, pose),
      },
    });
    if (result.error || !result.data) {
      const msg = result.error?.msg ?? 'The session did not start';
      xrState.set({ status: { kind: 'idle' }, lastError: msg });
      consoleActions.log('error', `XR: ${msg}`);
      return;
    }

    session = result.data;
    xrState.set({ status: { kind: 'running', mode, fps: 0 } });
    consoleActions.log('info', `XR: ${mode.toUpperCase()} session started — controls in Settings › XR`);
  },

  /** Leave a running session (the viewport unmounting, or the user). */
  end(): void {
    session?.end();
  },

  updateSettings(patch: Partial<XrRunSettings>): void {
    xrSettingsState.set(patch);
  },

  resetSettings(): void {
    xrSettingsState.set(XR_SETTINGS_DEFAULTS);
  },

  /** Apply the XR block of a settings file (merged over the defaults). */
  importSettings(value: unknown): void {
    xrSettingsState.set(parseSettings(value));
  },

  /** Unpin: forget every saved AR alignment (the next AR session starts from
   *  the desktop view). Their anchors are queued — the next AR session
   *  deletes them from the headset, freeing its few per-site slots. */
  forgetAlignments(): void {
    queueForDeletion(Object.values(loadAlignments()).map((a) => a.anchor));
    writeAlignments({});
    consoleActions.log('info', 'XR: saved AR alignments forgotten — the next AR session deletes their anchors');
  },
};
