import { Ribbon } from '@treDeSpaceUI/widgets';
import { HomeAssetsGroups } from './HomeAssetsGroups';
import { HomeCameraGroup } from './HomeCameraGroup';
import { HomeExternalGroup } from './HomeExternalGroup';
import { HomeResetGroups } from './HomeResetGroups';
import { HomeViewGroups } from './HomeViewGroups';

/** Home ribbon: external apps promoted here, the asset panel openers (+ wipe),
 *  the canvas actions (+ theme), the camera (perspective / ortho and the
 *  headset sessions), the sketch toggles and the quick-clear actions. */
export function RibbonHome() {
  return (
    <Ribbon>
      <HomeExternalGroup at="start" />
      <HomeAssetsGroups />
      <HomeCameraGroup />
      <HomeViewGroups />
      <HomeResetGroups />
      <HomeExternalGroup at="end" />
    </Ribbon>
  );
}
