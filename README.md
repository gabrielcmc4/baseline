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

## What changed on 2026-11-27: every video run again, checked by eye
- **Serves timed by the click read 17 % fast.** In the frames the ball was in view from the hit, but the serve's first 0.1-0.15 s runs across the picture (camera behind) and was a separate track. Tracks are now joined back to the hit (same direction, meeting point; tried again without the join if the longer track fails a test). Serve practice: the click-anchored and the bounce readings of the same serves now differ by 7 % (median), 0-10 % when the click is within 0.06 s of the track's start. A click more than 0.08 s before the track no longer times a serve.
- **Sound clock.** Phones that record in pieces pad the sound with 2-8 ms pauses (20-50 ms over a video). Clicks are now placed through the sound's and the picture's edit lists.
- **Speed cap after the two colour passes** are merged (the seen-bounce serves can come from the other pass).
- **Side camera:** serves without a seen bounce are not shown (they landed 3-8 m off; the one checked against the video was wrong), except "net, on the limit". Far-end "long" calls in the middle of the court were checked frame by frame and are right; near the far corner one pixel is about 30 cm.
- **Body:** deepest knee bend, widest turn and highest finish taken after a 3-picture running median.

## What changed on 2026-11-26 (late night): body movement (phase 2 of the technique notes)

- `js/body.js` + `vendor/pose` (MediaPipe Pose 0.5 JavaScript solution, Apache-2.0, lite model, SIMD build, 12 MB, loaded only when used). Third switch in step 1, off by default, also available later from the report. For each of the player's own shots the full-size picture is cut around him (from `feet`, the court position the engine records) and shown to the pose model 15 times a second from 0.8 s before (serve 1.1 s) to 0.5 s after the hit. Stored per shot as `body` (and in the history): shoulder turn at the incoming bounce (`turnB`, degrees, 0 = square, 90 = side-on), max turn before the hit, turn at contact, deepest knee angle, finish (racket hand above the shoulders, in body lengths), serve hand height and elbow angle at contact, and `side` (hands across the body at contact).
- Cutting around the player is what makes it work: on a lesson video the body was found in 1 picture in 5 on the whole frame and in 80 of 80 cut around him. On the 19-minute match: 123 shots in 105 s.
- Forehand/backhand: with body movement on, a stroke's side comes from the hands at contact when clear (match: 54 forehands / 20 backhands, against 69 / 6 from the trunk outline; backhands checked on the video).
- New notes: shoulders turned by the bounce, knee bend, finish; serve: knee bend at the trophy position, hand height at contact.
- Frame reader (`runReader`): draws only the window asked for, for every stored rotation, and can hand back bitmaps cut on the graphics card and keep only a few pictures a second (the match is stored upside down; drawing every whole 1080p picture was 13 s a shot).
- Engine: a "serve" found from a track that starts high, with no racket click at its start but one 0.3-1.3 s before, is a stroke caught late (a forehand at 0:49 had become a 123 km/h serve at 0:50; "serves" at 180-207 km/h); it is dropped and the earlier click may take that track.

## What changed on 2026-11-26 (night): technique notes, and switches for the slow extras

- **Technique: what works for you** (`js/technique.js`, phase 1, no body tracking). For the user's own shots: contact height (waist to chest band), contact depth against the baseline, time after the incoming bounce, margin over the net, spin, recovery 1.2 s later; serves: first vs second (a second serve follows a missed one with no shot of his in between), toss top and spread, contact height within first serves. Groups of at least 8 shots, a share difference of 12 points or more and a two-proportion z of 1 ("trend") or 1.65 ("clear"). When his numbers go against the usual advice, the advice is withheld and the best and a missed example are offered. The engine now stores `feet` (where he stood at the shot), `rec` (1.2 s later) and `toss` (top of the toss on the plane of the hit) for his shots; all three are kept in the history.
- **Switches** in step 1 for the line review and forehand/backhand, the only stages after the fit (14 % and 9 % of a 530 s run on a 19-minute match); both can be run later from the report.

## What changed on 2026-11-26 (later): shots heard but not seen leaving the racket

Near the camera the ball often leaves the racket blurred, behind the player or out of the picture; the tracker finds it 0.1-0.4 s later, high or deep, and with no hit and no sensible start the shot was thrown away. `js/sound.js` now reads the file's own sound (plain PCM from .MOV, AAC through `AudioDecoder`) while the pictures are read and finds racket clicks (sharp jumps above 1.5 kHz). In `analyze()` (option `clicks`), each click with no shot near it and a ball going away within 0.45 s gets a flight fitted with the hit pinned at the click: waist high where the player stands, or where the opponent's previous ball had got to by then, or 2.6 m over the baseline for a serve at the start of a point. The picture/sound clock offset is the median over hits seen in both. Such shots carry `heard: true`.

Synthetic test (the first 0.2 s after every near hit removed; 30 false clicks a minute plus every bounce and far hit as clicks): near shots found 0 → 17 of 21, speed error median 4.4 % (90th percentile 7 %), depth 0.5 m, no false shots; with 0.35 s removed 10 of 21. Gabriel's match: near shots 125 → 137, opponent's 143 unchanged; the twelve rescued ones were checked frame by frame (serves, a forehand into the net at 11:48, balls struck from outside the picture). Corner-view lesson: 142 → 179, mostly strokes hit from beyond the right edge of the picture. Cost: about 3 s to read the sound of a 20-minute match and 10 % more fitting time.

## What changed on 2026-11-26: the opponent's shots

Tested on synthetic videos with known truth, built on a real court seen from a phone 2.9 m up behind the baseline, and on Gabriel's 19-minute match:

- **Tracks that run through a bounce on the camera's side.** From a low camera the ball keeps coming down the picture after it bounces near the camera, only at another pace, so the tracker joined both parts and no flight fitted: the shot was dropped. Such a track is now split where two arcs explain it far better than one, and the split is used as the bounce (cameras below 5 m only).
- **Speed off the opponent's racket.** The opponent's ball is first seen near the net, about half a second after the hit. The flight is now run back to waist height 0.8 m behind the far baseline and the speed is reported there, as for the near player's shots (the speed where it was first seen is kept as `speedSeen`).
- **A ball seen bouncing on the camera's side got over the net**, whatever the fitted clearance says.

Synthetic videos: opponent shots found 12 → 32 of 41, speed error −22 % → +1 % (median). Match video: opponent shots 72 → 143 (median 59 → 79 km/h), the near player's 125 shots unchanged, balls reviewed at the line 17 → 31, and the first "out by a little" calls (5 cm, 42 cm). The broadcast regression clips are unchanged.

## What changed on 2026-11-23: speed accuracy

Checked against an independent bounce-timing measurement on broadcast rallies (contact and bounce indexed by hand on the court lines, flight solved with gravity, drag and spin), the previous version was 27-34% off on all three forehands it found. Causes and fixes, in `js/engine.js`:

- **Time base.** Broadcast "60 fps" is usually 50 pictures a second with every sixth shown twice (25 in 30 likewise). Repeats were only dropped when bit-identical, so most stayed in, and the pictures left carried the time they were shown at (up to 13 ms off). Repeats are now found relative to the pictures around them, and `retime()` gives the pictures back their capture times.
- **The hit.** The flight used to start at the first tracked point, often 0.2 s after the hit, with its depth guessed from the player's feet. The incoming ball's track (or the toss, for a serve) now gives the moment and place of the hit; the flight is fitted from there, at about 1.0 m height for a groundstroke and 2.7 m for a serve, so the speed is the speed off the racket.
- **The bounce.** The bounce after the end of a track is found from the spots where the ball suddenly climbs in the picture (both looks, the far one included) and pins the end of the flight in time and place.
- **One camera's blind spot.** A fast flat flight and a slower loopy one draw nearly the same track; moving the hit along its line of sight changes the picture by about a pixel, the size of the calibration error. The anchored fit gives the picture 2 px of slack and lets the hit and the bounce decide. A ball may no longer pass under the court while it is still tracked in the air.
- **Sidespin.** Slice serves curve sideways; the flight model now has a sideways spin term (used in the anchored fit), without which a lefty's slice serve fitted at 61 km/h instead of about 140.
- **Tracks.** A long track (a second or more) is judged by how smooth each part is rather than as one parabola; a piece may shed one or two spots at its ends that are not yet in free flight (ball still in the tossing hand); pieces are only joined where the join itself is smooth; a track first seen deep in the court with no hit seen is no longer reported as a shot.
- **Copies in phone videos.** A calm moment after a shaky one also changes few pixels. Near copies are therefore only skipped once they come at a steady rhythm (frame-rate conversion); bunched ones are real pictures and stay.

Result in the browser on 6 shots from 3 clips (50, 30 and 25 fps; forehands, a backhand, a slice serve): speed within 3% of bounce timing (87-142 km/h), landing within 0.25 m. Stress test (15 runs with 15% of ball spots deleted and the rest jittered): 72 of 90 shots found (old engine 37), every checked speed within 5%, false shots 0.04 per clip (old 0.4). Shots whose hit and bounce were both seen are marked ✓ in the table; the others show at least ±10%. Without the bounce, accuracy is lower, especially at 30 fps. The test clips are broadcasts, not Baseline's phone setup.

## What changed on 2026-11-18

- Videos are read by several workers at once (up to four) and stretches with nothing moving are skimmed; a 54-minute 1080p recording takes about half an hour on a 12-core PC.
- Own MP4/MOV reader in `js/decode.js` (no dependency for the common case); frames are put back in time order when the decoder returns them out of order.
- The court finder uses the net tape as a line of known height and follows a camera that sways (for example one hung on a fence).
- Serve practice from a raised camera, matches with a separate view for the other player, and lessons where the user stands on the far side ("I'm on the far side of the court").
- The session type can be changed on the result page without reading the video again.
- Known limits: a serve is only reported when its bounce is seen; far-side shots get their speed near the net and no spin; results have not been checked against ground truth (see 2026-11-23 above for the first check, against bounce timing).
