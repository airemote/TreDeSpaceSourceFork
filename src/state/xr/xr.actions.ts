// Headset sessions (VR / passthrough AR): support detection, start and end,
// the settings and the saved AR alignments. The running session is a live
// handle, so it lives here rather than in the store.

import { consoleActions } from '../../components/panels/console/console.actions';
import type { Renderer } from '../../lib/render/renderer';
import { storageKey } from '../../lib/storageKeys';
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

/** Saved AR alignments, keyed by scene (the loaded models). */
type AlignmentMap = Record<string, XrSavedAlignment>;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SETTINGS_KEY = storageKey('xr');
const ALIGNMENTS_KEY = storageKey('xrAlignments');
const MATRIX_SIZE = 16;

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

function isAlignment(v: unknown): v is XrSavedAlignment {
  return (
    isRecord(v) &&
    typeof v.anchor === 'string' &&
    Array.isArray(v.offset) &&
    v.offset.length === MATRIX_SIZE &&
    v.offset.every((n: unknown) => typeof n === 'number')
  );
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

/** XR settings from storage or a settings file — unknown or mistyped fields
 *  fall back to the defaults. */
function parseSettings(value: unknown): XrRunSettings {
  if (!isRecord(value)) {
    return XR_SETTINGS_DEFAULTS;
  }

  const d = XR_SETTINGS_DEFAULTS;

  return {
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
      if (isAlignment(value)) {
        out[key] = value;
      }
    }
  }

  return out;
}

function saveAlignment(scene: string, alignment: XrSavedAlignment): void {
  const map = { ...loadAlignments(), [scene]: alignment };
  writeJson(ALIGNMENTS_KEY, map);
  xrState.set({ alignmentCount: Object.keys(map).length });
  consoleActions.log('info', 'XR: alignment saved — this scene opens aligned here next time');
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
      hooks: {
        speeds: () => ({ move: navState.get().flySpeed, sprint: navState.get().flyShift }),
        onSelect: (id) => void viewerActions.selectFromPick(id, false),
        onAlignmentSaved: (alignment) => saveAlignment(scene, alignment),
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

  /** Forget every saved AR alignment (the next AR session starts from the
   *  desktop view). Anchors already kept by the headset are left there. */
  forgetAlignments(): void {
    writeJson(ALIGNMENTS_KEY, {});
    xrState.set({ alignmentCount: 0 });
    consoleActions.log('info', 'XR: saved AR alignments forgotten');
  },
};
