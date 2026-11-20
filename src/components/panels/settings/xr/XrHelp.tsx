// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const CONTROLS: readonly Readonly<{ input: string; action: string }>[] = [
  { input: 'Left stick', action: 'move along where you look (press and hold: sprint) — speed = fly speed' },
  { input: 'Right stick ↔', action: 'snap turn' },
  { input: 'Right stick ↕', action: 'rise / sink' },
  { input: 'Trigger (or pinch)', action: 'select what the ray points at (nothing = clear the selection)' },
  { input: 'Grip (hold)', action: 'grab the model: it follows your hand (turn and move, never tilt)' },
  { input: 'A (hold)', action: 'align lock: the model rides with your head — walk it onto the real object' },
  { input: 'B', action: 'back to where the session started' },
];

const SETUP: readonly string[] = [
  'In the headset browser open chrome://flags, turn on “WebXR experimental features” and the WebGPU entries, and restart the browser.',
  'Open the viewer in the headset browser over HTTPS (from a PC dev server: npm run dev -- --host, then https://<pc-address>:5173 and accept the certificate).',
  'A PC with a headset as its display works too (Windows only — Chrome has no WebXR on Linux).',
  'In AR, release the grip or A to save the alignment: the same scene opens aligned at that place next time (where the headset keeps anchors).',
];

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

/** The controller map and the headset setup notes (Settings → XR). */
export function XrHelp() {
  return (
    <div className="mt-2 flex flex-col gap-1 text-slate-400 text-xs">
      <div className="text-slate-300">Controllers</div>
      <table>
        <tbody>
          {CONTROLS.map((c) => (
            <tr key={c.input}>
              <td className="whitespace-nowrap pr-2 align-top text-slate-300">{c.input}</td>
              <td>{c.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1 text-slate-300">Headset setup</div>
      <ul className="list-disc pl-4">
        {SETUP.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
