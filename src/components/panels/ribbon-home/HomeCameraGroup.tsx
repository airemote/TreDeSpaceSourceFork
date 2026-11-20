import { IconCube, IconPerspective } from '@tabler/icons-react';
import { RibbonButton, RibbonSection } from '@treDeSpaceUI/widgets';
import { HomeXrButtons } from './HomeXrButtons';
import { ribbonHomeActions as act } from './ribbonHome.actions';
import { ribbonHomeState } from './ribbonHome.state';

/** Home › Camera: the perspective / orthographic switch, and the headset
 *  sessions (VR / AR) as a column of small buttons. */
export function HomeCameraGroup() {
  const { camera } = ribbonHomeState.use();

  return (
    <RibbonSection title="Camera">
      <RibbonButton
        icon={<IconPerspective />}
        label="Persp."
        selected={camera === 'persp'}
        shortcut="camera.persp"
        onClick={() => act.setCamera('persp')}
      />
      <RibbonButton
        icon={<IconCube />}
        label="Ortho"
        selected={camera === 'ortho'}
        shortcut="camera.ortho"
        onClick={() => act.setCamera('ortho')}
      />
      <HomeXrButtons />
    </RibbonSection>
  );
}
