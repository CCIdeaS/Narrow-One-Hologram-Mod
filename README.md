# Hologram v1.0.0

A cosmetic Narrow One HUD userscript with a local range estimate and player controlled visual options.

## Install

Install `Hologram-v1.0.0.user.js` in Violentmonkey or Tampermonkey. The four built in texture packs are embedded in the script and need no companion files.

## Features

- Ivory, Graphite, and Burgundy HUD with a custom health display, dynamic reticle, calibration markers, and server-confirmed hit feedback.
- Local range and nominal trajectory estimates with selectable small, medium, and large bow or crossbow profiles. The weapon must be selected manually because shot packets do not identify it. Estimates assume full draw and do not account for random spread or occlusion; the script does not modify damage or server state.
- Optional movement and aim anomaly indicators. These are heuristic indicators, not authoritative cheat detection.
- Four texture choices: Default Vanilla, Hologram, Pulsar, and Geo. Each has its own coin preview and title wordmark. Hologram uses clipped futuristic trims; Pulsar uses bold sweeping curves and angles; Geo uses natural contour shapes. Selection is stored locally in the browser.
- Optional local texture pack import for supported individual UI image assets.
- Keyboard shortcuts: K calibration markers, L projection verification, O fog visual toggle, F8 reticle mode. Select the equipped ballistic profile in the RETICLE menu.
- Reduced motion preference support and a responsive settings panel.

## Notes

The script reads observed game telemetry for its estimates and feedback. It does not send data to an external service. Settings and selected texture pack are local to the browser. The 3D world asset bundle is separate from the replaceable menu and HUD images.

## Weapon switch troubleshooting

If Q weapon swapping doesn't work, reobtaining and reequipping the weapon in shop seems to be a solution.
