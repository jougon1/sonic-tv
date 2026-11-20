// SSTV: analog slow-scan TV pictures over sound, like 90s ham radio.
//
// Brightness is sent as pitch: 1500 Hz = black, 2300 Hz = white. Every line
// starts with a 1200 Hz sync pulse. Colour is sent as Y (brightness) plus
// R-Y / B-Y colour-difference lines. Standard modes, so the sound also works
// with other SSTV apps:
//   Robot 36: 320x240, 36 s      PD 90: 320x256, 90 s, cleaner colour
// The decoder paints each line the moment it has been heard. A weak signal
// gives TV snow instead of a broken file.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SSTV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CENTER = 1700; // decoder mixes the 1100-2300 Hz band down around this
  const VIS_DUR = 0.91; // leader + break + leader + start + 8 bits + stop
  const PREAMBLE = [1900, 1500, 1900, 1500, 2300, 1500, 2300, 1500]; // 100 ms each
  const LEAD = 0.5;

  // `units` = scan units (one sync pulse each). Segments are relative to the sync start.
  const MODES = {
    robot36: {
      name: 'robot36',
      label: 'Robot 36',
      vis: 8,
      width: 320,
      height: 240,
      rowsPerUnit: 1,
      unitDur: 0.15,
      syncDur: 0.009,
    },
    pd90: {
      name: 'pd90',
      label: 'PD 90',
      vis: 99,
      width: 320,
      height: 256,
      rowsPerUnit: 2,
      unitDur: 0.70304,
      syncDur: 0.02,
    },
  };
  for (const m of Object.values(MODES)) {
    m.units = m.height / m.rowsPerUnit;
    m.duration = LEAD + PREAMBLE.length * 0.1 + VIS_DUR + m.units * m.unitDur + LEAD;
  }
  const PD_SCAN = 0.17024;

  // ITU-R BT.601 studio range, as used by Robot and PD modes
  function rgbToYuv(r, g, b) {
    return [
      16 + 0.257 * r + 0.504 * g + 0.098 * b,
      128 - 0.148 * r - 0.291 * g + 0.439 * b,
      128 + 0.439 * r - 0.368 * g - 0.071 * b,
    ];
  }
  function clamp8(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }
  function yuvToRgb(y, u, v, out, o) {
    const c = 1.164 * (y - 16);
    out[o] = clamp8(c + 1.596 * (v - 128));
    out[o + 1] = clamp8(c - 0.813 * (v - 128) - 0.392 * (u - 128));
    out[o + 2] = clamp8(c + 2.017 * (u - 128));
    out[o + 3] = 255;
  }
  const valueToFreq = (v) => 1500 + (clamp8(v) * 800) / 255;
  const freqToValue = (f) => clamp8(((f - 1500) * 255) / 800);

  // ---------------------------------------------------------------- encoder
  // rgba: Uint8ClampedArray of mode.width x mode.height
  function encode(rgba, modeName, sampleRate) {
    const m = MODES[modeName];
    const sr = sampleRate || 48000;
    const W = m.width;
    const H = m.height;
    const Y = new Float32Array(W * H);
    const U = new Float32Array(W * H);
    const V = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const yuv = rgbToYuv(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
      Y[i] = yuv[0];
      U[i] = yuv[1];
      V[i] = yuv[2];
    }
    const row = (arr, y) => arr.subarray(y * W, (y + 1) * W);
    const pairAvg = (arr, y0) => {
      const r = new Float32Array(W);
      for (let x = 0; x < W; x++) r[x] = (arr[y0 * W + x] + arr[(y0 + 1) * W + x]) / 2;
      return r;
    };

    const segs = [];
    const tone = (f, d) => segs.push({ f, d });
    const scan = (arr, d) => segs.push({ arr, d });
    tone(0, LEAD);
    for (const f of PREAMBLE) tone(f, 0.1);
    tone(1900, 0.3);
    tone(1200, 0.01);
    tone(1900, 0.3);
    tone(1200, 0.03);
    let ones = 0;
    for (let i = 0; i < 7; i++) {
      const bit = (m.vis >> i) & 1;
      ones += bit;
      tone(bit ? 1100 : 1300, 0.03);
    }
    tone(ones % 2 ? 1100 : 1300, 0.03); // even parity
    tone(1200, 0.03);

    if (m.name === 'robot36') {
      for (let y = 0; y < H; y++) {
        const odd = y % 2 === 1;
        tone(1200, 0.009);
        tone(1500, 0.003);
        scan(row(Y, y), 0.088);
        tone(odd ? 2300 : 1500, 0.0045);
        tone(1900, 0.0015);
        scan(pairAvg(odd ? U : V, y & ~1), 0.044);
      }
    } else {
      for (let p = 0; p < H / 2; p++) {
        tone(1200, 0.02);
        tone(1500, 0.00208);
        scan(row(Y, 2 * p), PD_SCAN);
        scan(pairAvg(V, 2 * p), PD_SCAN);
        scan(pairAvg(U, 2 * p), PD_SCAN);
        scan(row(Y, 2 * p + 1), PD_SCAN);
      }
    }
    tone(0, LEAD);

    let total = 0;
    for (const s of segs) total += s.d;
    const out = new Float32Array(Math.round(total * sr) + 1);
    let t = 0;
    let phase = 0;
    for (const s of segs) {
      const n0 = Math.round(t * sr);
      const n1 = Math.round((t + s.d) * sr);
      const n = n1 - n0;
      for (let i = 0; i < n; i++) {
        let f = s.f;
        if (s.arr) f = valueToFreq(s.arr[Math.min(W - 1, Math.floor(((i + 0.5) * W) / n))]);
        if (f === 0) {
          out[n0 + i] = 0;
          continue;
        }
        phase += (2 * Math.PI * f) / sr;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
        out[n0 + i] = 0.8 * Math.sin(phase);
      }
      t += s.d;
    }
    return { samples: out, sampleRate: sr, duration: out.length / sr };
  }

  // seconds from the start of the sound to the first image line (for the sender's live view)
  function imageStart() {
    return LEAD + PREAMBLE.length * 0.1 + VIS_DUR;
  }

  // ---------------------------------------------------------------- decoder
  // handlers: onStart({mode}), onRows(y, count, rgba), onEnd({mode, quality}),
  //           onUnit({unit, units, hit, quality})
  class Decoder {
    constructor(sampleRate, handlers) {
      const sr = (this.sr = sampleRate);
      this.h = handlers || {};
      // mixer + FIR low-pass -> complex baseband; d[n] = z[n] * conj(z[n-1]) gives frequency
      this.oc = 1;
      this.os = 0;
      const w = (2 * Math.PI * CENTER) / sr;
      this.cw = Math.cos(w);
      this.sw = Math.sin(w);
      const N = (this.nt = Math.round(0.0024 * sr) | 1);
      const M = (N - 1) / 2;
      const fc = 1100 / sr;
      this.taps = new Float64Array(N);
      let sum = 0;
      for (let k = 0; k < N; k++) {
        const x = k - M;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        this.taps[k] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (N - 1)));
        sum += this.taps[k];
      }
      for (let k = 0; k < N; k++) this.taps[k] /= sum;
      this.hr = new Float64Array(2 * N);
      this.hi = new Float64Array(2 * N);
      this.hp = 0;
      this.pr = 0;
      this.pi = 0;

      // prefix sums of d, absolute indexing: C[a] stored at a - bufStart, valid for a in [bufStart, n]
      // plus 1200 Hz correlation (pRe/pIm) and energy (pE) for finding sync pulses
      this.cap = sr * 8;
      this.names = ['cRe', 'cIm', 'pRe', 'pIm', 'pE'];
      for (const k of this.names) this[k] = new Float64Array(this.cap);
      this.qc = 1;
      this.qs = 0;
      const w2 = (2 * Math.PI * 1200) / sr;
      this.qcw = Math.cos(w2);
      this.qsw = Math.sin(w2);
      this.acc = { pRe: 0, pIm: 0, pE: 0 };
      this.bufStart = 0;
      this.n = 0;
      this.sRe = 0;
      this.sIm = 0;

      this.bins = []; // 1 ms frequency bins for VIS detection
      this.binBase = 0;
      this.lastVis = -1e9;
      this.img = null;
      this.k = sr / (2 * Math.PI);
    }

    freqOf(a, b) {
      const i = a - this.bufStart;
      const j = b - this.bufStart;
      return CENTER + this.k * Math.atan2(this.cIm[j] - this.cIm[i], this.cRe[j] - this.cRe[i]);
    }

    push(x) {
      if (this.n - this.bufStart + x.length + 2 > this.cap) this.trim();
      if (this.n - this.bufStart + x.length + 2 > this.cap) {
        const cap = Math.max(this.cap * 2, this.n - this.bufStart + x.length + 2);
        for (const k of this.names) {
          const a = new Float64Array(cap);
          a.set(this[k].subarray(0, this.n - this.bufStart + 1));
          this[k] = a;
        }
        this.cap = cap;
      }
      const N = this.nt;
      const taps = this.taps;
      const hr = this.hr;
      const hi = this.hi;
      const cw = this.cw;
      const sw = this.sw;
      let oc = this.oc;
      let os = this.os;
      let hp = this.hp;
      let pr = this.pr;
      let pi = this.pi;
      let sRe = this.sRe;
      let sIm = this.sIm;
      let qc = this.qc;
      let qs = this.qs;
      const qcw = this.qcw;
      const qsw = this.qsw;
      let aRe = this.acc.pRe;
      let aIm = this.acc.pIm;
      let aE = this.acc.pE;
      const pReA = this.pRe;
      const pImA = this.pIm;
      const pEA = this.pE;
      let j = this.n - this.bufStart;
      this.cRe[j] = sRe;
      this.cIm[j] = sIm;
      pReA[j] = aRe;
      pImA[j] = aIm;
      pEA[j] = aE;
      for (let i = 0; i < x.length; i++) {
        const s = x[i];
        hr[hp] = hr[hp + N] = s * oc;
        hi[hp] = hi[hp + N] = -s * os;
        const t = oc * cw - os * sw;
        os = os * cw + oc * sw;
        oc = t;
        hp = hp + 1 === N ? 0 : hp + 1;
        let zr = 0;
        let zi = 0;
        for (let k = 0; k < N; k++) {
          zr += taps[k] * hr[hp + k];
          zi += taps[k] * hi[hp + k];
        }
        sRe += zr * pr + zi * pi;
        sIm += zi * pr - zr * pi;
        pr = zr;
        pi = zi;
        aRe += s * qc;
        aIm -= s * qs;
        aE += s * s;
        const tq = qc * qcw - qs * qsw;
        qs = qs * qcw + qc * qsw;
        qc = tq;
        j++;
        this.cRe[j] = sRe;
        this.cIm[j] = sIm;
        pReA[j] = aRe;
        pImA[j] = aIm;
        pEA[j] = aE;
      }
      const gq = 1 / Math.hypot(qc, qs);
      this.qc = qc * gq;
      this.qs = qs * gq;
      this.acc = { pRe: aRe, pIm: aIm, pE: aE };
      const g = 1 / Math.hypot(oc, os); // keep the oscillator on the unit circle
      this.oc = oc * g;
      this.os = os * g;
      this.hp = hp;
      this.pr = pr;
      this.pi = pi;
      this.sRe = sRe;
      this.sIm = sIm;
      this.n += x.length;
      this.process();
    }

    trim() {
      let keep = this.n - Math.round(1.2 * this.sr);
      if (this.img) keep = Math.min(keep, Math.floor(this.predict(this.img.u)) - Math.round(0.05 * this.sr));
      const drop = keep - this.bufStart;
      if (drop <= 0) return;
      const len = this.n - this.bufStart + 1;
      for (const k of this.names) this[k].copyWithin(0, drop, len);
      this.bufStart = keep;
    }

    process() {
      const sr = this.sr;
      // 1 ms bins for the VIS header
      for (;;) {
        const k = this.binBase + this.bins.length;
        const b = Math.floor(((k + 1) * sr) / 1000);
        if (b > this.n) break;
        const a = Math.max(this.bufStart, Math.floor((k * sr) / 1000));
        this.bins.push(this.freqOf(a, b));
        this.checkVis();
      }
      if (this.bins.length > 3000) {
        this.bins.splice(0, 1000);
        this.binBase += 1000;
      }
      while (this.img && this.decodeNext()) {
        /* keep decoding lines while there is audio for them */
      }
    }

    // A VIS header: 1900 Hz leader, then start bit, 7 data bits, parity, stop bit (30 ms each)
    checkVis() {
      const last = this.binBase + this.bins.length - 1;
      const k0 = last - 299; // candidate start-bit bin
      const B = (k) => this.bins[k - this.binBase];
      if (k0 - 300 < this.binBase || k0 < this.lastVis + 600) return;
      if (!(B(k0 + 10) < 1450)) return; // cheap pre-check: inside the start bit
      const mean = (a, b) => {
        let s = 0;
        for (let k = a; k < b; k++) s += B(k);
        return s / (b - a);
      };
      const near = (v, f, tol) => Math.abs(v - f) < tol;
      if (!near(mean(k0 - 250, k0 - 10), 1900, 80)) return;
      if (!near(mean(k0 + 5, k0 + 25), 1200, 80)) return;
      if (!near(mean(k0 + 275, k0 + 295), 1200, 80)) return;
      const bits = [];
      for (let i = 0; i < 8; i++) {
        const v = mean(k0 + 35 + 30 * i, k0 + 55 + 30 * i);
        const bit = v < 1200 ? 1 : 0;
        if (!near(v, bit ? 1100 : 1300, 90)) return;
        bits.push(bit);
      }
      let code = 0;
      let ones = 0;
      for (let i = 0; i < 7; i++) {
        code |= bits[i] << i;
        ones += bits[i];
      }
      if (ones % 2 !== bits[7]) return;
      const mode = Object.values(MODES).find((m) => m.vis === code);
      if (!mode) return;
      this.lastVis = k0;

      // exact 1900 -> 1200 Hz edge of the start bit (k0 can be a few ms early)
      const sr = this.sr;
      const W = Math.round(0.004 * sr);
      const sk = Math.floor((k0 * sr) / 1000);
      let best = -1e9;
      let edge = sk;
      for (let s = sk - Math.round(0.004 * sr); s <= sk + Math.round(0.012 * sr); s++) {
        if (s - W < this.bufStart) continue;
        const score = this.freqOf(s - W, s) - this.freqOf(s, s + W);
        if (score > best) {
          best = score;
          edge = s;
        }
      }
      this.startImage(mode, edge + 0.3 * sr);
    }

    startImage(mode, anchor) {
      this.img = {
        m: mode,
        anchor, // exact start of line 0, from the VIS header edge
        u: 0,
        nominal: mode.unitDur * this.sr,
        pts: [], // [unit, sync position - nominal position]
        slope: 0, // clock drift in samples per unit
        bias: 0, // where the sync detector sees pulses relative to the true start (room echo)
        hits: 0,
        yRow: null,
        chroma: null,
        rgba: new Uint8ClampedArray(mode.width * 2 * 4),
      };
      if (this.h.onStart) this.h.onStart({ mode: mode.name, label: mode.label, width: mode.width, height: mode.height });
    }

    // Echoes shift every detected sync by the same amount, so the syncs are only
    // used for the drift (slope); the horizontal position comes from the VIS edge.
    refit() {
      const im = this.img;
      const pts = im.pts;
      if (pts.length < 6) {
        const r = pts.map((p) => p[1]).sort((a, b) => a - b);
        im.bias = r.length ? r[r.length >> 1] : 0;
        im.slope = 0;
        return;
      }
      const lsq = (ps) => {
        let sx = 0;
        let sy = 0;
        let sxx = 0;
        let sxy = 0;
        for (const [x, y] of ps) {
          sx += x;
          sy += y;
          sxx += x * x;
          sxy += x * y;
        }
        const n = ps.length;
        const d = n * sxx - sx * sx;
        const b = d ? (n * sxy - sx * sy) / d : 0;
        return { a: (sy - b * sx) / n, b };
      };
      // Theil-Sen style start (median of slopes between points half the run apart),
      // so a few bad syncs can't tilt the picture; then least squares on the inliers
      const med = (v) => v.sort((a, b) => a - b)[v.length >> 1];
      const h = pts.length >> 1;
      const slopes = [];
      for (let i = 0; i + h < pts.length; i++) slopes.push((pts[i + h][1] - pts[i][1]) / (pts[i + h][0] - pts[i][0]));
      let b = med(slopes);
      let f = { a: med(pts.map(([x, y]) => y - b * x)), b };
      const inl = pts.filter(([x, y]) => Math.abs(y - (f.a + f.b * x)) < 0.001 * this.sr);
      if (inl.length >= 6) f = lsq(inl);
      const maxSlope = 0.002 * im.nominal; // 2000 ppm: no real sound card is further off
      if (Math.abs(f.b) > maxSlope) f = { a: med(pts.map(([, y]) => y)), b: 0 };
      im.bias = f.a;
      im.slope = f.b;
    }

    unitStart(u) {
      const im = this.img;
      return im.anchor + u * (im.nominal + im.slope);
    }

    // where the sync detector should find unit u
    predict(u) {
      return this.unitStart(u) + this.img.bias;
    }

    syncScore(p, L) {
      const i = p - this.bufStart;
      const re = this.pRe[i + L] - this.pRe[i];
      const im = this.pIm[i + L] - this.pIm[i];
      const e = this.pE[i + L] - this.pE[i];
      return (re * re + im * im) / (L * e + 1e-12); // 0.5 for a clean 1200 Hz tone
    }

    decodeNext() {
      const im = this.img;
      const m = im.m;
      const sr = this.sr;
      const L = Math.round(m.syncDur * sr);
      const win = Math.round((im.pts.length >= 6 ? 0.002 : 0.008) * sr);
      const pred = Math.round(this.predict(im.u));
      if (this.n < Math.ceil(this.unitStart(im.u) + im.nominal * 1.002) + win + L + 2) return false;

      let best = -1;
      let bi = 0;
      const sc = new Float64Array(2 * win + 1);
      for (let i = 0; i <= 2 * win; i++) {
        sc[i] = this.syncScore(pred - win + i, L);
        if (sc[i] > best) {
          best = sc[i];
          bi = i;
        }
      }
      let off = bi;
      if (bi > 0 && bi < 2 * win) {
        const a = sc[bi - 1];
        const c = sc[bi + 1];
        const den = a - 2 * best + c;
        if (den < 0) off = bi + (0.5 * (a - c)) / den;
      }
      const hit = best > 0.2;
      // line 0's sync runs straight on from the VIS stop bit (also 1200 Hz), so its start can't be seen
      if (hit && im.u > 0) {
        im.pts.push([im.u, pred - win + off - (im.anchor + im.u * im.nominal)]);
        im.hits++;
        this.refit();
      }
      this.decodeUnit(this.unitStart(im.u), (im.nominal + im.slope) / im.nominal);

      im.u++;
      const quality = im.hits / im.u;
      if (this.h.onUnit) this.h.onUnit({ unit: im.u, units: m.units, hit, quality });
      if (im.u >= m.units) {
        this.img = null;
        if (this.h.onEnd) this.h.onEnd({ mode: m.name, quality });
        return false;
      }
      if (this.n - this.bufStart > 4 * sr) this.trim();
      return true;
    }

    // read `W` pixel values from a scan that starts `off` seconds after the sync
    scanValues(start, scale, off, dur, W) {
      const sr = this.sr;
      const a = start + off * sr * scale;
      const len = dur * sr * scale;
      const out = new Float32Array(W);
      let prev = Math.round(a);
      for (let x = 0; x < W; x++) {
        const next = Math.round(a + ((x + 1) * len) / W);
        out[x] = next > prev ? freqToValue(this.freqOf(prev, next)) : out[x - 1] || 0;
        prev = next;
      }
      out[W - 1] = out[W - 2]; // the last pixel bleeds into the next tone after filtering
      return out;
    }

    decodeUnit(start, scale) {
      const im = this.img;
      const m = im.m;
      const W = m.width;
      const rgba = im.rgba;
      const emit = (y0, Y0, Y1, U, V) => {
        for (let x = 0; x < W; x++) {
          yuvToRgb(Y0[x], U[x], V[x], rgba, x * 4);
          yuvToRgb(Y1[x], U[x], V[x], rgba, (W + x) * 4);
        }
        if (this.h.onRows) this.h.onRows(y0, 2, rgba);
      };
      if (m.name === 'robot36') {
        const y = im.u;
        const Y = this.scanValues(start, scale, 0.012, 0.088, W);
        // the separator tells which colour line this is: 1500 Hz = R-Y, 2300 Hz = B-Y
        const sepA = start + 0.1 * this.sr * scale;
        const isU = this.freqOf(Math.round(sepA), Math.round(sepA + 0.0045 * this.sr)) > 1900;
        const C = this.scanValues(start, scale, 0.106, 0.044, W);
        if (y % 2 === 0) {
          im.yRow = Y;
          im.chroma = { isU, C };
          return;
        }
        const grey = new Float32Array(W).fill(128);
        let U = isU ? C : grey;
        let V = isU ? grey : C;
        if (im.chroma && im.chroma.isU !== isU) {
          if (isU) V = im.chroma.C;
          else U = im.chroma.C;
        }
        emit(y - 1, im.yRow || Y, Y, U, V);
      } else {
        const Y0 = this.scanValues(start, scale, 0.02208, PD_SCAN, W);
        const V = this.scanValues(start, scale, 0.02208 + PD_SCAN, PD_SCAN, W);
        const U = this.scanValues(start, scale, 0.02208 + 2 * PD_SCAN, PD_SCAN, W);
        const Y1 = this.scanValues(start, scale, 0.02208 + 3 * PD_SCAN, PD_SCAN, W);
        emit(2 * im.u, Y0, Y1, U, V);
      }
    }

    receiving() {
      return !!this.img;
    }
  }

  return { MODES, encode, imageStart, Decoder };
});
