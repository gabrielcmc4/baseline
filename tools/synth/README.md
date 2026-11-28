# Synthetic test videos

Videos drawn by code, with an answer key, so the analysis can be tested on cases nobody had to film.

- `sim.py`: ball physics written apart from `js/engine.js` (spin-dependent drag after Goodwill et al., Magnus lift after Watts & Ferrer, bounce with friction, net). `SYNTH_CD=0.556` swaps in the engine's fixed drag, to tell model differences from tracking errors.
- `scenario.py`: rallies with their answer key (hit time, side, contact point, speed, spin, landing, net clearance, in / long / wide / net, volley). `python3 scenario.py rally|volley out.json`
- `render.py`: draws the court, the net, two players with rackets, the ball (with shadow and a short exposure blur), loose balls, noise, and encodes an H.264 MP4. `python3 render.py scene.json out.mp4 [--cam behind|corner] [--second]` (`--second`: another court beside it). Writes `out.truth.json`.
- `run.mjs`: Baseline's own engine run in Node on the MP4 (court finding, ball detector, flight fit), then compared with the answer key. `node run.mjs out.mp4 match --json res.json`

Needs Python 3 with numpy and OpenCV, ffmpeg, Node 20+.

Scenarios: `python3 scenario.py rally|volley|serve|netcord|lines out.json [--neighbor]`. Battery: `./battery.sh /tmp/syn` (one line per video). `run.mjs ... --trace` says why each track was dropped; `ENGINE=path` runs another copy of the engine.

## Results
- 27/11: the court and camera are found almost exactly; only about half the shots were found.
- 28/11: four causes found and fixed (see the main README, 2026-11-28): 89 -> 112 of 178 shots on the seven test videos. Checked on the six stored real videos before going into the app: no shot lost, new ones real.
- Left out after the real-video check: spin-dependent drag (unstable real speeds), net-volley candidates (hundreds of false shots from the corner).
- Still weak: balls within 20 cm of a line (13 of 19 called right), volleys at the net seen from the corner.
