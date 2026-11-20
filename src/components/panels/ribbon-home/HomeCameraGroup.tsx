import { IconCube, IconPerspective } from '@tabler/icons-react';
import { RibbonButton, RibbonSection } from '@treDeSpaceUI/widgets';
import { HomeXrButtons } from './HomeXrButtons';
import { ribbonHomeActions as act } from './ribbonHome.actions';
import { ribbonHomeState } from './ribbonHome.state';

/** Home › Camera: one perspective ⇄ orthographic toggle (it shows the current
 *  projection), and the headset sessions (VR / AR) as a column of small buttons. */
export function HomeCameraGroup() {
  const isOrtho = ribbonHomeState.use().camera === 'ortho';

  return (
    <RibbonSection title="Camera">
      <RibbonButton
        icon={isOrtho ? <IconCube /> : <IconPerspective />}
        label={isOrtho ? 'Ortho' : 'Persp.'}
        tooltip={`${isOrtho ? 'Orthographic' : 'Perspective'} camera — click for ${isOrtho ? 'perspective' : 'orthographic'}. The camera keeps its position and target; the target plane keeps its framing.`}
        shortcut="camera.projection.toggle"
        onClick={act.toggleCamera}
      />
      <HomeXrButtons />
    </RibbonSection>
  );
}
