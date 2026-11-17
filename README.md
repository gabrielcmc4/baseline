# Baseline

Tennis shot analysis from a single video, running entirely in the browser. No server, no account, no AI service: the video never leaves the device.

For every shot of the player nearest the camera it reports speed, height over the net, an estimate of spin, and where the ball landed.

*Análise de golpes de tênis a partir de um único vídeo, rodando inteira no navegador. Interface em português e inglês.*

## Use

1. Open `index.html` from a web server (GitHub Pages works as is; locally: `python3 -m http.server` in this folder).
2. Choose the video and the kind of session (lesson, serve practice, match).
3. Mark the court lines you can see: two taps per line, at least 4 lines.
4. Wait for the analysis and read the report.

## Recording

- Fixed camera behind the baseline, as high as possible (3 m or more).
- Landscape, whole court in frame.
- 60 fps or more. 30 fps works, but spin gets imprecise.

## How it works

| Step | File | Method |
|---|---|---|
| Read frames | `js/decode.js` | WebCodecs + mp4box.js; half-speed `<video>` playback as fallback |
| Camera | `js/engine.js` `calibrate` | focal length, lens distortion and pose fitted to the marked lines of a standard court |
| Ball | `Detector` | 3-frame motion + ball colour, small-blob filter, drift correction from the court lines |
| Tracks | `buildTracks` | greedy tracker with constant-acceleration prediction, split at hits and bounces |
| Flight | `analyze` | 3D flight (gravity, drag, Magnus lift) fitted to the 2D track through the camera model |
| Depth scale | `analyze` | balls that die in the net are at a known position; they calibrate how far in front of the hitter the tracked flight starts |
| Spin | `spinFromCl` | the lift needed on top of a drag-only flight, converted to rpm (CL = 1 / (2 + v / (R·ω))) |

`tools/` has the Node scripts used to validate the engine against real footage.

## Accounts and history (optional)

With a Firebase project configured in `js/firebase-config.js`, people can sign in with Google, each analysis is saved to their profile, and "My history" shows every session by date plus progress charts. Without it the app works as before, with no sign-in.

What is stored per session: date, session type, the numbers for each shot and one small court picture. Videos are never uploaded.

Setup: create a Firebase project, add a web app and paste its config into `js/firebase-config.js`, enable Google as a sign-in provider, add the site's domain to the authorized domains, create a Firestore database and publish `firestore.rules`.

Security choices:
- No passwords: sign-in is handled by Google; the app only receives the user id and display name.
- `firestore.rules` lets a signed-in user read and write only documents under their own user id, with size and field limits; everything else is denied.
- The Firebase config values are identifiers, not secrets.
- A Content-Security-Policy restricts scripts and connections to this site and Google's sign-in and database hosts.
- Saved data is treated as untrusted when read back: text goes in as text, never as HTML.

## Known limits

- One camera cannot see depth directly. Landing depth is typically ±1.3 m on footage from a 2.6 m high camera at 30 fps; sideways it is a few centimetres. Shots within that margin of a line are marked "close call".
- Spin is the least certain number (around ±500 rpm per shot at 30 fps). Trust medians and comparisons.
- Only the near player's shots are analyzed. Serve and match modes have not been checked against real serve or match footage yet.
- Small or blurred balls (camera far away, low resolution) are missed more often.
- HEVC videos need a browser and device that can decode HEVC.

## Credits

[mp4box.js](https://github.com/gpac/mp4box.js) (BSD-3-Clause). Fonts: Marcellus and Jost (SIL Open Font License).
