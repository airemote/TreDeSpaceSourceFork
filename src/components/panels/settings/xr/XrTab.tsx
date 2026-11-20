import { Checkbox, NumberInput, Select, type SelectOption } from '@treDeSpaceUI/widgets';
import { describeXrSupport, xrActions } from '../../../../state/xr/xr.actions';
import { type XrRefreshRate, xrSettingsState, xrState } from '../../../../state/xr/xr.state';
import { SettingsSection } from '../SettingsSection';
import { XrHelp } from './XrHelp';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const REFRESH_RATES: readonly SelectOption<XrRefreshRate>[] = [
  { value: 'default', label: 'Headset default', hint: '72 Hz on a Quest' },
  { value: '72', label: '72 Hz' },
  { value: '90', label: '90 Hz' },
  { value: '120', label: '120 Hz', hint: 'light scenes only' },
];

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

/** Settings → XR: headset session quality and comfort, controls, setup. */
export function XrTab() {
  const s = xrSettingsState.use();
  const { support } = xrState.use();

  return (
    <SettingsSection
      id="xr"
      title="XR (VR / AR headset)"
      info={
        <>
          Headset sessions over WebXR + WebGPU — start them from Home › Camera. Render scale and foveation trade
          sharpness for frame rate; a standalone headset needs both. The rest of the look (edges, colours, lighting)
          follows the desktop settings; TAA and ambient occlusion stay off in a headset.
        </>
      }
    >
      <div className="text-slate-400 text-xs">{describeXrSupport(support)}</div>
      <Select
        label="Refresh rate"
        labelPosition="split"
        value={s.refreshRate}
        options={REFRESH_RATES}
        clearable={false}
        tooltip="Higher is smoother but leaves less time per frame — the scene must keep up, or the headset drops frames. The nearest rate the headset offers is used; takes effect at the next session."
        onChange={(x) => xrActions.updateSettings({ refreshRate: x ?? 'default' })}
      />
      <NumberInput
        label="Render scale"
        labelPosition="split"
        value={s.renderScale}
        min={0.3}
        max={1.5}
        step={0.05}
        unit="×"
        onChange={(x) => xrActions.updateSettings({ renderScale: x })}
      />
      <NumberInput
        label="Foveation"
        labelPosition="split"
        value={s.foveation}
        min={0}
        max={1}
        step={0.1}
        onChange={(x) => xrActions.updateSettings({ foveation: x })}
      />
      <NumberInput
        label="Snap turn"
        labelPosition="split"
        value={s.snapTurnDeg}
        min={5}
        max={90}
        step={5}
        unit="°"
        onChange={(x) => xrActions.updateSettings({ snapTurnDeg: x })}
      />
      <Checkbox
        label="Antialiasing (MSAA 4×)"
        checked={s.msaa}
        onChange={(x) => xrActions.updateSettings({ msaa: x })}
      />
      <Checkbox
        label="Mirror the headset view on this screen"
        checked={s.mirror}
        onChange={(x) => xrActions.updateSettings({ mirror: x })}
        info={<>Shows one eye on the desktop canvas for people watching. Costs a copy per frame.</>}
      />
      <Checkbox
        label="Send depth to the headset"
        checked={s.sendDepth}
        onChange={(x) => xrActions.updateSettings({ sendDepth: x })}
        info={
          <>
            Lets the headset reproject frames with depth (steadier when the frame rate drops). Experimental — turn it
            off if the image swims or tears. Takes effect at the next session.
          </>
        }
      />
      <XrHelp />
    </SettingsSection>
  );
}
