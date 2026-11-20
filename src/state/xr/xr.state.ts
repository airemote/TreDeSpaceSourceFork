import { createStore } from '@treDeSpaceUI/lib/createStore';
import type { XrMode, XrRunSettings } from '../../lib/xr/xrSession';

export type { XrMode, XrRunSettings };

/** What this browser and headset can start; `reason` explains a missing mode. */
export type XrSupport = Readonly<{ vr: boolean; ar: boolean; reason: string | null }>;

export type XrStatus =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'starting'; mode: XrMode }>
  | Readonly<{ kind: 'running'; mode: XrMode; fps: number }>;

export type XrState = Readonly<{
  support: XrSupport;
  status: XrStatus;
  /** Why the last start failed (ribbon tooltip); cleared by the next start. */
  lastError: string | null;
  /** AR alignments kept across sessions (one per scene). */
  alignmentCount: number;
}>;

/** Settings › XR defaults. Render scale and foveation are the frame-rate levers
 *  on a standalone headset; depth hand-off stays off until checked on device. */
export const XR_SETTINGS_DEFAULTS: XrRunSettings = {
  renderScale: 0.8,
  msaa: true,
  foveation: 0.5,
  snapTurnDeg: 30,
  mirror: true,
  sendDepth: false,
};

/** Headset session status (runtime only). */
export const xrState = createStore<XrState>({
  support: { vr: false, ar: false, reason: 'Checking for WebXR…' },
  status: { kind: 'idle' },
  lastError: null,
  alignmentCount: 0,
});

/** Settings › XR — persisted by xr.actions. */
export const xrSettingsState = createStore<XrRunSettings>(XR_SETTINGS_DEFAULTS);
