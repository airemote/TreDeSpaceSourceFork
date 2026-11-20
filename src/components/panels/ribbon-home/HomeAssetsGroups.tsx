import {
  IconCamera,
  IconDatabase,
  IconFileExport,
  IconMoon,
  IconPackageImport,
  IconReportAnalytics,
  IconSql,
  IconStack2,
  IconSun,
  IconTrash,
  IconTrashX,
} from '@tabler/icons-react';
import { RibbonButton, RibbonSection } from '@treDeSpaceUI/widgets';
import { openExportPanel } from '../export/exportPanel';
import { openImportManagerPanel } from '../import-manager/importManagerPanel';
import { openModelAssetsPanel } from '../model-assets/modelAssetsPanel';
import { settingsActions } from '../settings/settings.actions';
import { settingsState } from '../settings/settings.state';
import { openSqlAssetsPanel } from '../sql-assets/sqlAssetsPanel';
import { openSqlEditorPanel } from '../sql-editor/sqlEditorPanel';
import { openSqlReportsPanel } from '../sql-reports/sqlReportsPanel';
import { ribbonHomeActions as act } from './ribbonHome.actions';

/** Assets: the model panels (library / import / export) and the SQL panels
 *  (library / editor / reports) as two columns of small buttons, and the
 *  wipe-everything local reset. Canvas: clear/screenshot and the light/dark theme toggle. */
export function HomeAssetsGroups() {
  const dark = settingsState.use().theme === 'dark';

  return (
    <>
      <RibbonSection title="Assets">
        <RibbonButton
          size="mini"
          icon={<IconStack2 />}
          label="Model"
          tooltip="Open the Model Assets library (imported models in the browser)"
          shortcut="home.assets"
          onClick={() => openModelAssetsPanel()}
        />
        <RibbonButton
          size="mini"
          icon={<IconPackageImport />}
          label="Import"
          tooltip="Open the Import Manager (bring models into the library)"
          shortcut="home.importManager"
          onClick={() => openImportManagerPanel()}
        />
        <RibbonButton
          size="mini"
          icon={<IconFileExport />}
          label="Export"
          tooltip="Open the Export panel (GLB, IFC and .tdp export, scene snapshots)"
          shortcut="export.open"
          onClick={() => openExportPanel()}
        />
        <RibbonButton
          size="mini"
          icon={<IconDatabase />}
          label="SQL"
          tooltip="Open the SQL Assets library (SQLite databases per store)"
          shortcut="sql.assets"
          onClick={() => openSqlAssetsPanel()}
        />
        <RibbonButton
          size="mini"
          icon={<IconSql />}
          label="SQL Editor"
          tooltip="Open the SQL Editor panel"
          shortcut="sql.editor"
          onClick={() => openSqlEditorPanel()}
        />
        <RibbonButton
          size="mini"
          icon={<IconReportAnalytics />}
          label="Reports"
          tooltip="Open the SQL Reports panel (saved queries with filters)"
          shortcut="sql.reports"
          onClick={() => openSqlReportsPanel()}
        />
        <RibbonButton
          icon={<IconTrashX />}
          label="Wipe All"
          tooltip="Wipe ALL locally saved data — settings, layout, hotkeys, viewpoints, rules AND every imported asset — then reload"
          shortcut="home.wipe.all"
          onClick={() => void act.wipeAllLocal()}
        />
      </RibbonSection>

      <RibbonSection title="Canvas">
        <RibbonButton
          icon={<IconTrash />}
          label="Clear"
          tooltip="Unload every loaded asset and clear the canvas"
          shortcut="home.remove"
          onClick={act.remove}
        />
        <RibbonButton
          icon={<IconCamera />}
          label="Screenshot"
          tooltip="Download the current viewport as a PNG (includes the view cube)"
          shortcut="home.screenshot"
          onClick={() => void act.screenshot()}
        />
        <RibbonButton
          icon={dark ? <IconSun /> : <IconMoon />}
          label={dark ? 'Light' : 'Dark'}
          tooltip={`Switch to the ${dark ? 'light' : 'dark'} theme`}
          shortcut="view.theme.toggle"
          onClick={settingsActions.toggleTheme}
        />
      </RibbonSection>
    </>
  );
}
