// Offline check of the analog TV mode: encode a test card -> fake room -> decode.
// Run: node test/sstv-sim.js
const S = require('../sstv.js');

let seed = 99;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function gauss() {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

// colour bars on top, grey ramp in the middle, white vertical line at x=160 on black at the bottom
function testCard(W, H) {
  const img = new Uint8ClampedArray(W * H * 4);
  const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c;
      if (y < H / 3) c = bars[Math.floor((x * 8) / W)];
      else if (y < (2 * H) / 3) c = [(x * 255) / W, (x * 255) / W, (x * 255) / W];
      else c = Math.abs(x - 160) < 3 ? [255, 255, 255] : [0, 0, 0];
      img.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
    }
  }
  return img;
}

function channel(x, srIn, srOut, opt) {
  const ratio = (srIn / srOut) * (1 + opt.ppm * 1e-6);
  const n = Math.floor(x.length / ratio);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * ratio;
    const k = Math.floor(t);
    const f = t - k;
    y[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f;
  }
  const z = new Float32Array(n);
  for (const [ms, g] of opt.echoes) {
    const d = Math.round((ms / 1000) * srOut);
    for (let i = d; i < n; i++) z[i] += g * y[i - d];
  }
  let p = 0;
  for (let i = 0; i < n; i++) {
    z[i] *= 0.05;
    p += z[i] * z[i];
  }
  const noise = Math.sqrt(p / n) / Math.pow(10, opt.snr / 20);
  const lead = Math.round(srOut * 0.83);
  const out = new Float32Array(lead + n + srOut);
  for (let i = 0; i < out.length; i++) out[i] = noise * gauss() + (i >= lead && i < lead + n ? z[i - lead] : 0);
  return out;
}

function run(modeName, name, opt, stress) {
  const m = S.MODES[modeName];
  const src = testCard(m.width, m.height);
  const enc = S.encode(src, modeName, 48000);
  const rx = channel(enc.samples, 48000, opt.sr, opt);
  const got = new Uint8ClampedArray(m.width * m.height * 4);
  let started = null;
  let ended = null;
  let rows = 0;
  const dec = new S.Decoder(opt.sr, {
    onStart: (e) => (started = e.mode),
    onRows: (y, count, rgba) => {
      got.set(rgba.subarray(0, count * m.width * 4), y * m.width * 4);
      rows += count;
    },
    onEnd: (e) => (ended = e),
  });
  const t0 = Date.now();
  for (let i = 0; i < rx.length; i += 4096) dec.push(rx.subarray(i, i + 4096));
  const ms = Date.now() - t0;

  let se = 0;
  for (let i = 0; i < src.length; i++) if (i % 4 !== 3) se += (src[i] - got[i]) ** 2;
  const psnr = 10 * Math.log10((255 * 255) / (se / ((src.length * 3) / 4)));
  // slant: where is the white line at the top vs the bottom of the bottom third?
  const linePos = (y) => {
    let best = 0;
    let bx = 0;
    for (let x = 0; x < m.width; x++) {
      const v = got[(y * m.width + x) * 4];
      if (v > best) {
        best = v;
        bx = x;
      }
    }
    return bx;
  };
  const top = linePos(Math.floor((2 * m.height) / 3) + 4);
  const bottom = linePos(m.height - 3);
  const ok = started === modeName && ended && rows === m.height && psnr > 17 && Math.abs(top - 160) <= 3 && Math.abs(bottom - 160) <= 3;
  console.log(
    `${(m.label + ' ' + name).padEnd(38)} ${stress ? 'info' : ok ? 'OK  ' : 'FAIL'} rows ${rows}/${m.height}, PSNR ${psnr.toFixed(1)} dB, ` +
      `line x=${top}->${bottom}, sync ${ended ? Math.round(ended.quality * 100) : 0}%, ` +
      `${enc.duration.toFixed(1)}s audio decoded in ${ms}ms`
  );
  return ok;
}

const room = [[0, 1], [6, 0.45], [17, 0.3], [41, 0.2], [90, 0.1]];
const close = [[0, 1], [4, 0.2], [15, 0.1], [40, 0.05]]; // phone held near the mic
const results = [];
for (const mode of ['robot36', 'pd90']) {
  results.push(
    run(mode, 'clean 48k', { sr: 48000, ppm: 0, echoes: [[0, 1]], snr: 40 }),
    run(mode, '44.1k +150ppm close SNR20', { sr: 44100, ppm: 150, echoes: close, snr: 20 }),
    run(mode, 'close (mild echo) SNR 10', { sr: 48000, ppm: -120, echoes: close, snr: 10 })
  );
  run(mode, 'harsh room SNR 10 (ghosts)', { sr: 48000, ppm: -120, echoes: room, snr: 10 }, true);
  run(mode, 'room SNR 3 (snowy)', { sr: 44100, ppm: 80, echoes: room, snr: 3 }, true);
}
process.exit(results.every(Boolean) ? 0 : 1);
