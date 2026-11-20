// Offline check: encode -> fake room (resample, drift, echoes, noise) -> decode.
// Run: node test/sim.js
const M = require('../modem.js');

let seed = 12345;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function gauss() {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

function testRS() {
  let ok = 0;
  const runs = 300;
  for (let r = 0; r < runs; r++) {
    const msg = Array.from({ length: 223 }, () => (rand() * 256) | 0);
    const code = M.rs.encode(msg, 32);
    const nErase = (rand() * 20) | 0;
    const nErr = Math.floor((32 - nErase) / 2);
    const pos = [...Array(255).keys()].sort(() => rand() - 0.5);
    const erase = pos.slice(0, nErase);
    for (const p of pos.slice(0, nErase + nErr)) code[p] ^= 1 + ((rand() * 255) | 0);
    try {
      const out = M.rs.decode(code, 32, erase);
      if (out.every((v, i) => v === msg[i])) ok++;
    } catch (e) {}
  }
  console.log(`RS errors+erasures at capacity: ${ok}/${runs} decoded`);
  return ok === runs;
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
  if (opt.lp) {
    // one-pole low-pass: small phone speakers lose the treble
    const a = Math.exp((-2 * Math.PI * opt.lp) / srOut);
    for (let i = 1; i < n; i++) y[i] = (1 - a) * y[i] + a * y[i - 1];
  }
  const z = new Float32Array(n);
  for (const [ms, g] of opt.echoes) {
    const d = Math.round((ms / 1000) * srOut);
    for (let i = d; i < n; i++) z[i] += g * y[i - d];
  }
  let p = 0;
  for (let i = 0; i < n; i++) {
    z[i] *= opt.gain;
    p += z[i] * z[i];
  }
  const sigRms = Math.sqrt(p / n);
  const noiseRms = sigRms / Math.pow(10, opt.snr / 20);
  const lead = Math.round(srOut * 1.37);
  const out = new Float32Array(lead + n + srOut);
  for (let i = 0; i < out.length; i++) out[i] = noiseRms * gauss() + (i >= lead && i < lead + n ? z[i - lead] : 0);
  return out;
}

function run(name, opt) {
  const file = new Uint8Array(3000);
  for (let i = 0; i < file.length; i++) file[i] = (rand() * 256) | 0;
  const enc = M.encode(file, { name: 'test.bin', type: 'application/octet-stream' }, 48000, opt.mode);
  const rx = channel(enc.samples, 48000, opt.sr, opt);
  const asm = new M.Assembler();
  let good = 0;
  let bad = 0;
  const q = [];
  const recv = new M.Receiver(opt.sr, {
    onPacket: (p) => {
      good++;
      q.push(p.quality);
      asm.add(p);
    },
    onFail: () => bad++,
  });
  const t0 = Date.now();
  for (let i = 0; i < rx.length; i += 4096) recv.push(rx.subarray(i, i + 4096));
  const ms = Date.now() - t0;
  const outFile = asm.complete() ? asm.file() : null;
  const match = outFile && asm.meta && M.crc32(outFile) === asm.meta.c && outFile.length === file.length;
  const avgQ = q.length ? (q.reduce((a, b) => a + b, 0) / q.length).toFixed(1) : '-';
  console.log(
    `${(opt.mode + ' ' + name).padEnd(40)} blocks ok ${good}, failed ${bad}, file ${match ? 'OK' : 'BROKEN'}, ` +
      `quality ${avgQ} dB, audio ${enc.duration.toFixed(1)}s decoded in ${ms}ms`
  );
  return match;
}

const room = [[0, 1], [6, 0.45], [17, 0.3], [41, 0.2], [90, 0.1]];
const results = [testRS()];
for (const mode of ['robust', 'fast']) {
  results.push(
    run('clean, 48k', { mode, sr: 48000, ppm: 0, echoes: [[0, 1]], gain: 0.3, snr: 40 }),
    run('44.1k + 150ppm drift + room', { mode, sr: 44100, ppm: 150, echoes: room, gain: 0.05, snr: 20 }),
    run('room + treble loss, SNR 10', { mode, sr: 48000, ppm: -80, echoes: room, gain: 0.05, snr: 10, lp: 4000 }),
    run('room, SNR 3 dB', { mode, sr: 44100, ppm: 60, echoes: room, gain: 0.05, snr: 3 })
  );
  run('room, SNR 0 dB (stress)', { mode, sr: 48000, ppm: 60, echoes: room, gain: 0.05, snr: 0 });
}
process.exit(results.every(Boolean) ? 0 : 1);
