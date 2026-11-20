import { IconAugmentedReality, IconCardboards, IconMapPinOff } from '@tabler/icons-react';
import { RibbonButton } from '@treDeSpaceUI/widgets';
import type { ReactNode } from 'react';
import { xrActions } from '../../../state/xr/xr.actions';
import { type XrMode, type XrState, xrState } from '../../../state/xr/xr.state';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type XrButtonView = Readonly<{ label: string; tooltip: string; isDisabled: boolean; isSelected: boolean }>;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MODES: readonly Readonly<{ mode: XrMode; icon: ReactNode; shortcut: string; pitch: string }>[] = [
  {
    mode: 'vr',
    icon: <IconCardboards />,
    shortcut: 'home.xr.vr',
    pitch: 'Enter VR: walk the model at 1:1 in a headset, starting where the camera is now.',
  },
  {
    mode: 'ar',
    icon: <IconAugmentedReality />,
    shortcut: 'home.xr.ar',
    pitch:
      'Enter AR: the model over the real world (passthrough). Grab it with the grip, or hold A to carry it with your head, to line it up — the alignment is kept for this scene.',
  },
];

const CONTROLS_HINT = 'Controllers and headset setup: Settings › XR.';

// -----------------------------------------------------------------------------
// Helper functions
// -----------------------------------------------------------------------------

function describe(mode: XrMode, pitch: string, s: XrState): XrButtonView {
  const name = mode.toUpperCase();
  const { status, support, lastError } = s;
  if (status.kind === 'running' && status.mode === mode) {
    const fps = status.fps > 0 ? ` — ${status.fps.toFixed(0)} fps` : '';
    return { label: `Exit ${name}`, tooltip: `Leave the ${name} session${fps}`, isDisabled: false, isSelected: true };
  }
  if (status.kind === 'starting' && status.mode === mode) {
    return { label: name, tooltip: `Starting ${name}… put the headset on`, isDisabled: true, isSelected: true };
  }

  const isSupported = mode === 'vr' ? support.vr : support.ar;
  const isBusy = status.kind !== 'idle';
  const why = isSupported ? null : (support.reason ?? `${name} is not supported by this headset`);
  const failed = lastError ? `\n\nLast attempt: ${lastError}` : '';

  return {
    label: name,
    tooltip: `${why ?? pitch}\n\n${CONTROLS_HINT}${failed}`,
    isDisabled: !isSupported || isBusy,
    isSelected: false,
  };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

/** Home › Camera › the headset buttons: enter / leave a session (VR, or
 *  passthrough AR) and forget the AR alignments kept across sessions — one
 *  column of small buttons. */
export function HomeXrButtons() {
  const s = xrState.use();

  return (
    <>
      {MODES.map((m) => {
        const view = describe(m.mode, m.pitch, s);
        return (
          <RibbonButton
            key={m.mode}
            size="mini"
            icon={m.icon}
            label={view.label}
            selected={view.isSelected}
            disabled={view.isDisabled}
            tooltip={view.tooltip}
            shortcut={m.shortcut}
            onClick={() => void xrActions.toggle(m.mode)}
          />
        );
      })}
      <RibbonButton
        size="mini"
        icon={<IconMapPinOff />}
        label="Unpin"
        disabled={s.alignmentCount === 0}
        tooltip={
          s.alignmentCount > 0
            ? `Unpin the model from the real world: forget the ${s.alignmentCount} saved AR alignment(s), so the next AR session starts from the desktop view instead of where you last lined the model up (and deletes their anchors from the headset)`
            : 'Unpin the model from the real world — nothing is pinned yet. In AR, releasing a grab or A pins the model where you put it, for the next AR session too.'
        }
        shortcut="home.xr.forgetAlignments"
        onClick={xrActions.forgetAlignments}
      />
    </>
  );
}
