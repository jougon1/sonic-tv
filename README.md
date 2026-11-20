# 📺 Sonic TV

**Send pictures and files through sound, and watch them paint line by line on a retro 90s TV.**

One device plays a sound. The other listens with its microphone and rebuilds the picture or file. No Wi-Fi, Bluetooth or cable between them. It all runs in the browser, with no installs and no libraries.

## Two ways to send

| | 📺 TV picture | 💾 Exact file |
|---|---|---|
| What | Analog slow-scan TV (SSTV), like 90s ham radio | Digital data with error correction |
| Sends | Pictures | Any file (images, text, anything) |
| Looks like | Painted live, line by line; weak signal = TV snow | Blurred preview first, then the exact file |
| Speed | Robot 36: 320×240 in 36 s · PD 90: 320×256 in 90 s | ~105 bytes/s (Fast) or ~60 bytes/s (Robust) |
| Result | Saved as PNG | Bit-perfect, checksum-verified |

Robot 36 and PD 90 are standard SSTV modes, so other SSTV apps should also be able to decode the sound.

## Run it

```bash
python -m http.server 8000
```

Then open **http://localhost:8000**.

1. **CH1 · Transmit:** pick a picture, press **Make the sound**, then play it. The TV shows the picture being "broadcast" in step with the sound. You can also save the `.wav` and play it from your phone. Send it to the phone as a file, not as a voice note, which gets compressed.
2. **CH2 · Receive:** press **Turn on & listen** and hold the playing phone 10–30 cm from the laptop mic.

The microphone needs a secure page, so the receiver has to be opened at `localhost`. The transmit side also works from a phone on the same Wi-Fi at `http://<laptop-ip>:8000`.

## How it works

**TV picture ([`sstv.js`](sstv.js))**
- **Sound:** pitch is brightness (1500 Hz = black, 2300 Hz = white). Every line starts with a 1200 Hz sync pulse. Colour is sent as Y + R‑Y / B‑Y lines.
- **Start of picture:** a header (VIS code) marks the start and names the mode.
- **Decoding:** a complex-baseband FM discriminator measures the pitch. The decoder paints each line as soon as it has been heard.
- **Clock drift:** sync pulses are found by their 1200 Hz energy. A robust line fit on them corrects clock differences between the two devices, so pictures don't slant.

**Exact file ([`modem.js`](modem.js))**
- **Tones:** multi-tone FSK, with 8 or 16 tones playing at once, each choosing 1 of 16 frequencies.
- **Error correction:** Reed–Solomon (255,223), with erasure decoding.
- **Packets:** each packet starts with a chirp, which keeps timing exact. A missed packet can be filled in by playing the sound again.
- **Images:** shrunk to WebP to fit the transfer time you pick, and a tiny thumbnail is sent first.

## Tests

```bash
node test/sstv-sim.js   # TV pictures through a simulated room: resampling, clock drift, echoes, noise
node test/sim.js        # digital files through the same kind of channel
```
