# Synthetic test videos

Videos drawn by code, with an answer key, so the analysis can be tested on cases nobody had to film.

- `sim.py`: ball physics written apart from `js/engine.js` (spin-dependent drag after Goodwill et al., Magnus lift after Watts & Ferrer, bounce with friction, net). `SYNTH_CD=0.556` swaps in the engine's fixed drag, to tell model differences from tracking errors.
- `scenario.py`: rallies with their answer key (hit time, side, contact point, speed, spin, landing, net clearance, in / long / wide / net, volley). `python3 scenario.py rally|volley out.json`
- `render.py`: draws the court, the net, two players with rackets, the ball (with shadow and a short exposure blur), loose balls, noise, and encodes an H.264 MP4. `python3 render.py scene.json out.mp4 [--cam behind|corner] [--second]` (`--second`: another court beside it). Writes `out.truth.json`.
- `run.mjs`: Baseline's own engine run in Node on the MP4 (court finding, ball detector, flight fit), then compared with the answer key. `node run.mjs out.mp4 match --json res.json`

Needs Python 3 with numpy and OpenCV, ffmpeg, Node 20+.

## First results (27/11/2026)
- The court and camera are found from the picture almost exactly (behind: 6.27 m back and 2.89 m high, true 6.2 and 2.9).
- Only about half the shots are found, in clean conditions. Near shots that skim the net come out too slow and short (113 km/h read as 85–90, landing 2.7 m short).
- Speed reads 4–6 % low on average; with the engine's own fixed drag in the simulation it is still 4 % low, so the drag model is not the main cause.
- From the corner, net volleys are never candidates: the picture rules for a near ball (starts well under the tape, climbs) do not hold for a ball volleyed at the net. A first loosening lets them through to the fit, where they are still lost: work in progress, not in the app.
