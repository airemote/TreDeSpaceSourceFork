import { Ribbon } from '@treDeSpaceUI/widgets';
import { HomeAssetsGroups } from './HomeAssetsGroups';
import { HomeExternalGroup } from './HomeExternalGroup';
import { HomeResetGroups } from './HomeResetGroups';
import { HomeViewGroups } from './HomeViewGroups';
import { HomeXrGroup } from './HomeXrGroup';

/** Home ribbon: external apps promoted here, the asset panel openers (+ wipe),
 *  the canvas actions (+ camera mode and theme), the sketch toggles, the
 *  quick-clear actions and the headset (XR) sessions. */
export function RibbonHome() {
  return (
    <Ribbon>
      <HomeExternalGroup at="start" />
      <HomeAssetsGroups />
      <HomeViewGroups />
      <HomeResetGroups />
      <HomeXrGroup />
      <HomeExternalGroup at="end" />
    </Ribbon>
  );
}
