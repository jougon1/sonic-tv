// SonicModem: send files as sound.
//
// Signal layout (one packet):
//   [chirp 200ms] [gap 30ms] [64 symbols] [tail 150ms]
// Each symbol plays one tone per frequency group at the same time. Each group
// has 16 possible tones, so a symbol carries groups x 4 bits.
//   robust: 8 groups, tones 50 Hz apart, 50ms symbols  (~60 bytes/s)
//   fast:  16 groups, tones 25 Hz apart, 58ms symbols  (~105 bytes/s)
// The chirp sweeps up for robust and down for fast, so the receiver detects
// the mode by itself.
// A packet carries Reed-Solomon(255,223) codewords (1 for robust, 2 for
// fast): 7 byte header, up to 214 bytes of file data, CRC16, 32 parity bytes.
// The chirp lets the receiver find the exact start of every packet, so clock
// drift never builds up and a lost packet does not break the rest.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SonicModem = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CFG = {
    sampleRate: 48000,
    baseFreq: 1000,
    rampDur: 0.002,
    chirpDur: 0.2,
    chirpF0: 800,
    chirpF1: 7800,
    chirpRamp: 0.005,
    gapAfterChirp: 0.03,
    tailGap: 0.15,
    leadIn: 0.6,
    leadOut: 0.6,
    rsN: 255,
    rsParity: 32,
    headerLen: 7,
    detectThreshold: 0.18,
  };
  const RS_K = CFG.rsN - CFG.rsParity; // 223
  const PAYLOAD_MAX = RS_K - CFG.headerLen - 2; // 214

  // winDur x spacing must be a whole number so neighbouring tones don't leak.
  // winStart skips the start of each symbol, where the room echo of the previous one is.
  const MODES = {
    robust: { name: 'robust', up: true, groups: 8, tones: 16, spacing: 50, symDur: 0.05, winStart: 0.024, winDur: 0.02, cw: 1 },
    fast: { name: 'fast', up: false, groups: 16, tones: 16, spacing: 25, symDur: 0.058, winStart: 0.014, winDur: 0.04, cw: 2 },
  };
  for (const m of Object.values(MODES)) {
    m.spc = Math.ceil((CFG.rsN * 2) / m.groups); // symbols per codeword
    m.symbols = m.spc * m.cw;
    m.packetDur = CFG.chirpDur + CFG.gapAfterChirp + m.symbols * m.symDur + CFG.tailGap;
    m.bytesPerSec = (m.cw * PAYLOAD_MAX) / m.packetDur;
  }

  function toneFreq(m, group, tone) {
    return CFG.baseFreq + (group * m.tones + tone) * m.spacing;
  }

  // ---------------------------------------------------------------- GF(256) / Reed-Solomon
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }
  function gfDiv(a, b) {
    if (b === 0) throw new Error('RS: divide by zero');
    if (a === 0) return 0;
    return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
  }
  function gfPow(x, p) {
    return GF_EXP[(((GF_LOG[x] * p) % 255) + 255) % 255];
  }
  function gfInv(x) {
    return GF_EXP[255 - GF_LOG[x]];
  }
  function polyScale(p, x) {
    return p.map((c) => gfMul(c, x));
  }
  function polyAdd(p, q) {
    const n = Math.max(p.length, q.length);
    const r = new Array(n).fill(0);
    for (let i = 0; i < p.length; i++) r[i + n - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + n - q.length] ^= q[i];
    return r;
  }
  function polyMul(p, q) {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= gfMul(p[i], q[j]);
    return r;
  }
  function polyEval(p, x) {
    let y = p[0];
    for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
    return y;
  }
  function polyRem(dividend, divisor) {
    const out = dividend.slice();
    for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
      const c = out[i];
      if (c !== 0) for (let j = 1; j < divisor.length; j++) if (divisor[j] !== 0) out[i + j] ^= gfMul(divisor[j], c);
    }
    return out.slice(out.length - (divisor.length - 1));
  }

  const genCache = {};
  function rsGenerator(nsym) {
    if (genCache[nsym]) return genCache[nsym];
    let g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, gfPow(2, i)]);
    return (genCache[nsym] = g);
  }

  function rsEncode(msg, nsym) {
    const gen = rsGenerator(nsym);
    const out = new Array(msg.length + nsym).fill(0);
    for (let i = 0; i < msg.length; i++) out[i] = msg[i];
    for (let i = 0; i < msg.length; i++) {
      const c = out[i];
      if (c !== 0) for (let j = 1; j < gen.length; j++) out[i + j] ^= gfMul(gen[j], c);
    }
    for (let i = 0; i < msg.length; i++) out[i] = msg[i];
    return out;
  }

  function rsSyndromes(msg, nsym) {
    const s = [0];
    for (let i = 0; i < nsym; i++) s.push(polyEval(msg, gfPow(2, i)));
    return s;
  }

  function rsCorrectErrata(msg, synd, errPos) {
    const coefPos = errPos.map((p) => msg.length - 1 - p);
    let errLoc = [1];
    for (const cp of coefPos) errLoc = polyMul(errLoc, polyAdd([1], [gfPow(2, cp), 0]));
    const divisor = [1].concat(new Array(errLoc.length).fill(0));
    const errEval = polyRem(polyMul(synd.slice().reverse(), errLoc), divisor).reverse();
    const X = coefPos.map((cp) => gfPow(2, cp));
    const E = new Array(msg.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      const xiInv = gfInv(X[i]);
      let prime = 1;
      for (let j = 0; j < X.length; j++) if (j !== i) prime = gfMul(prime, 1 ^ gfMul(xiInv, X[j]));
      if (prime === 0) throw new Error('RS: bad error magnitude');
      const y = gfMul(X[i], polyEval(errEval.slice().reverse(), xiInv));
      E[errPos[i]] = gfDiv(y, prime);
    }
    return polyAdd(msg, E);
  }

  // Berlekamp-Massey on Forney syndromes (erasures already removed).
  function rsErrorLocator(synd, nsym, eraseCount) {
    let errLoc = [1];
    let oldLoc = [1];
    for (let i = 0; i < nsym - eraseCount; i++) {
      let delta = synd[i];
      for (let j = 1; j < errLoc.length; j++) delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[i - j]);
      oldLoc = oldLoc.concat([0]);
      if (delta !== 0) {
        if (oldLoc.length > errLoc.length) {
          const newLoc = polyScale(oldLoc, delta);
          oldLoc = polyScale(errLoc, gfInv(delta));
          errLoc = newLoc;
        }
        errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift();
    if ((errLoc.length - 1) * 2 + eraseCount > nsym) throw new Error('RS: too many errors');
    return errLoc;
  }

  function rsFindErrors(errLocRev, nmess) {
    const pos = [];
    for (let i = 0; i < nmess; i++) if (polyEval(errLocRev, gfPow(2, i)) === 0) pos.push(nmess - 1 - i);
    if (pos.length !== errLocRev.length - 1) throw new Error('RS: could not locate errors');
    return pos;
  }

  function rsForneySyndromes(synd, erasePos, nmess) {
    const f = synd.slice(1);
    for (const p of erasePos) {
      const x = gfPow(2, nmess - 1 - p);
      for (let j = 0; j < f.length - 1; j++) f[j] = gfMul(f[j], x) ^ f[j + 1];
    }
    return f;
  }

  // Returns the data part, or throws. erasePos = indices known to be unreliable.
  function rsDecode(msgIn, nsym, erasePos) {
    const msg = Array.from(msgIn);
    erasePos = erasePos || [];
    if (erasePos.length > nsym) throw new Error('RS: too many erasures');
    for (const p of erasePos) msg[p] = 0;
    let synd = rsSyndromes(msg, nsym);
    if (synd.every((v) => v === 0)) return msg.slice(0, msg.length - nsym);
    const fsynd = rsForneySyndromes(synd, erasePos, msg.length);
    const errLoc = rsErrorLocator(fsynd, nsym, erasePos.length);
    const errPos = rsFindErrors(errLoc.slice().reverse(), msg.length);
    const fixed = rsCorrectErrata(msg, synd, erasePos.concat(errPos));
    synd = rsSyndromes(fixed, nsym);
    if (!synd.every((v) => v === 0)) throw new Error('RS: could not correct');
    return fixed.slice(0, fixed.length - nsym);
  }

  // ---------------------------------------------------------------- checksums
  function crc16(bytes) {
    let c = 0xffff;
    for (let i = 0; i < bytes.length; i++) {
      c ^= bytes[i] << 8;
      for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    return c;
  }
  const CRC32_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------------------------------------------------------------- FFT
  function makeFFT(n) {
    const levels = Math.round(Math.log2(n));
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      let x = i;
      for (let j = 0; j < levels; j++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      rev[i] = r;
    }
    return function fft(re, im, inverse) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i];
          re[i] = re[j];
          re[j] = t;
          t = im[i];
          im[i] = im[j];
          im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >>> 1;
        const step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const wr = cos[k];
            const wi = inverse ? sin[k] : -sin[k];
            const l = j + half;
            const tr = re[l] * wr - im[l] * wi;
            const ti = re[l] * wi + im[l] * wr;
            re[l] = re[j] - tr;
            im[l] = im[j] - ti;
            re[j] += tr;
            im[j] += ti;
          }
        }
      }
      if (inverse) for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    };
  }

  // ---------------------------------------------------------------- signal pieces
  function makeChirp(sr, up) {
    const n = Math.round(CFG.chirpDur * sr);
    const out = new Float32Array(n);
    const f0 = up ? CFG.chirpF0 : CFG.chirpF1;
    const k = ((up ? 1 : -1) * (CFG.chirpF1 - CFG.chirpF0)) / CFG.chirpDur;
    const ramp = Math.round(CFG.chirpRamp * sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let a = 1;
      if (i < ramp) a = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
      else if (i >= n - ramp) a = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / ramp);
      out[i] = a * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
    }
    return out;
  }

  // byte b lives in group b%G of symbol pair b/G: high nibble in the first
  // symbol, low nibble in the second. A bad symbol hurts G bytes, a dead
  // frequency group hurts 255/G bytes (still fixable as erasures).
  function codewordToSymbols(code, m) {
    const G = m.groups;
    const sym = new Uint8Array(m.spc * G);
    for (let b = 0; b < code.length; b++) {
      const t = Math.floor(b / G);
      const g = b % G;
      sym[2 * t * G + g] = code[b] >> 4;
      sym[(2 * t + 1) * G + g] = code[b] & 15;
    }
    return sym;
  }

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  // ---------------------------------------------------------------- encoder
  function makeBlock(sid, idx, total, payload) {
    const b = new Uint8Array(RS_K);
    b[0] = sid >> 8;
    b[1] = sid & 255;
    b[2] = idx >> 8;
    b[3] = idx & 255;
    b[4] = total >> 8;
    b[5] = total & 255;
    b[6] = payload.length;
    b.set(payload, CFG.headerLen);
    const c = crc16(b.subarray(0, RS_K - 2));
    b[RS_K - 2] = c >> 8;
    b[RS_K - 1] = c & 255;
    return rsEncode(Array.from(b), CFG.rsParity);
  }

  function metaPayload(name, type, size, crc, previewLen) {
    const enc = new TextEncoder();
    let n = name || 'file';
    let bytes;
    for (;;) {
      const meta = { n: n, t: type || '', s: size, c: crc };
      if (previewLen) meta.p = previewLen;
      bytes = enc.encode(JSON.stringify(meta));
      if (bytes.length <= PAYLOAD_MAX || n.length <= 1) break;
      n = n.slice(0, Math.max(1, n.length - 8));
    }
    return bytes;
  }

  function getMode(mode) {
    return MODES[mode] || MODES.fast;
  }
  function blockCount(size) {
    return Math.ceil(size / PAYLOAD_MAX) + 2; // + metadata block at start and end
  }
  function packetCount(size, mode) {
    return Math.ceil(blockCount(size) / getMode(mode).cw);
  }
  function estimateDuration(size, mode) {
    return CFG.leadIn + packetCount(size, mode) * getMode(mode).packetDur + CFG.leadOut;
  }
  // largest file that fits in `seconds` of sound
  function bytesForDuration(seconds, mode) {
    const m = getMode(mode);
    const packets = Math.floor((seconds - CFG.leadIn - CFG.leadOut) / m.packetDur);
    return Math.max(0, (packets * m.cw - 2) * PAYLOAD_MAX);
  }

  // meta = {name, type, preview?}. A preview (tiny thumbnail) is sent before
  // the file so the receiver can show something within seconds.
  function encode(file, meta, sampleRate, mode) {
    const m = getMode(mode);
    const previewLen = meta.preview ? meta.preview.length : 0;
    const bytes = previewLen ? concat([meta.preview, file]) : file;
    const sr = sampleRate || CFG.sampleRate;
    const sid = (Math.random() * 65535) | 0;
    const total = Math.ceil(bytes.length / PAYLOAD_MAX);
    if (total > 65535) throw new Error('File too large');
    const blocks = [];
    const metaBlock = makeBlock(sid, 0, total, metaPayload(meta.name, meta.type, file.length, crc32(file), previewLen));
    blocks.push(metaBlock);
    for (let i = 0; i < total; i++) {
      blocks.push(makeBlock(sid, i + 1, total, bytes.subarray(i * PAYLOAD_MAX, (i + 1) * PAYLOAD_MAX)));
    }
    while (blocks.length % m.cw !== m.cw - 1) blocks.push(metaBlock); // fill the last packet
    blocks.push(metaBlock);

    const nPackets = blocks.length / m.cw;
    const pktLen = Math.round(m.packetDur * sr);
    const lead = Math.round(CFG.leadIn * sr);
    const out = new Float32Array(lead + nPackets * pktLen + Math.round(CFG.leadOut * sr));
    const chirp = makeChirp(sr, m.up);
    const symStart0 = CFG.chirpDur + CFG.gapAfterChirp;
    const ramp = Math.round(CFG.rampDur * sr);
    const tmp = new Float32Array(Math.ceil(m.symDur * sr) + 2);
    const G = m.groups;

    let pos = lead;
    for (let p = 0; p < nPackets; p++) {
      for (let i = 0; i < chirp.length; i++) out[pos + i] = 0.85 * chirp[i];
      const sym = new Uint8Array(m.symbols * G);
      for (let c = 0; c < m.cw; c++) sym.set(codewordToSymbols(blocks[p * m.cw + c], m), c * m.spc * G);
      for (let s = 0; s < m.symbols; s++) {
        const a = pos + Math.round((symStart0 + s * m.symDur) * sr);
        const b = pos + Math.round((symStart0 + (s + 1) * m.symDur) * sr);
        const n = b - a;
        tmp.fill(0, 0, n);
        for (let g = 0; g < G; g++) {
          const w = (2 * Math.PI * toneFreq(m, g, sym[s * G + g])) / sr;
          const ph = Math.random() * 2 * Math.PI;
          for (let i = 0; i < n; i++) tmp[i] += Math.sin(w * i + ph);
        }
        let peak = 1e-9;
        for (let i = 0; i < n; i++) {
          let env = 1;
          if (i < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
          else if (i >= n - ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / ramp);
          tmp[i] *= env;
          if (Math.abs(tmp[i]) > peak) peak = Math.abs(tmp[i]);
        }
        const k = 0.85 / peak;
        for (let i = 0; i < n; i++) out[a + i] = tmp[i] * k;
      }
      pos += pktLen;
    }
    return { samples: out, sampleRate: sr, packets: nPackets, mode: m.name, duration: out.length / sr };
  }

  // ---------------------------------------------------------------- receiver
  // Feed it microphone samples with push(); it calls
  //   onSync({ncc, mode}), onPacket(pkt), onFail({reason, quality}), onLevel({ncc})
  class Receiver {
    constructor(sampleRate, handlers) {
      const sr = (this.sr = sampleRate);
      this.h = handlers || {};
      this.tplLen = Math.round(CFG.chirpDur * sr);
      this.N = nextPow2(this.tplLen * 3);
      this.block = this.N - this.tplLen;
      this.fft = makeFFT(this.N);
      this.xr = new Float64Array(this.N);
      this.xi = new Float64Array(this.N);
      this.re = new Float64Array(this.N);
      this.im = new Float64Array(this.N);
      this.modes = Object.values(MODES).map((m) => this.prepareMode(m));

      this.buf = new Float32Array(sr * 30);
      this.bufStart = 0; // absolute sample index of buf[0]
      this.bufLen = 0;
      this.scanPos = 0;
      this.chirpAt = -1;
      this.cur = null; // mode of the packet being received
      this.guard = Math.round(0.05 * sr);
    }

    prepareMode(m) {
      const sr = this.sr;
      const tpl = makeChirp(sr, m.up);
      let e = 0;
      for (let i = 0; i < tpl.length; i++) e += tpl[i] * tpl[i];
      const tRe = new Float64Array(this.N);
      const tIm = new Float64Array(this.N);
      tRe.set(tpl);
      this.fft(tRe, tIm, false);
      const symOffsets = [];
      for (let s = 0; s < m.symbols; s++) {
        symOffsets.push(Math.round((CFG.chirpDur + CFG.gapAfterChirp + s * m.symDur + m.winStart) * sr));
      }
      const coeff = new Float64Array(m.groups * m.tones);
      for (let g = 0; g < m.groups; g++) {
        for (let t = 0; t < m.tones; t++) coeff[g * m.tones + t] = 2 * Math.cos((2 * Math.PI * toneFreq(m, g, t)) / sr);
      }
      return {
        m,
        tRe,
        tIm,
        tplNorm: Math.sqrt(e),
        symOffsets,
        coeff,
        power: new Float64Array(m.groups * m.tones),
        winLen: Math.round(m.winDur * sr),
        packetLen: Math.round((CFG.chirpDur + CFG.gapAfterChirp + m.symbols * m.symDur) * sr),
      };
    }

    end() {
      return this.bufStart + this.bufLen;
    }

    push(x) {
      if (this.bufLen + x.length > this.buf.length) {
        this.trim(this.chirpAt >= 0 ? Math.min(this.chirpAt, this.scanPos) : this.scanPos);
        if (this.bufLen + x.length > this.buf.length) {
          const nb = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + x.length));
          nb.set(this.buf.subarray(0, this.bufLen));
          this.buf = nb;
        }
      }
      this.buf.set(x, this.bufLen);
      this.bufLen += x.length;
      this.process();
    }

    trim(keepFrom) {
      const drop = keepFrom - this.bufStart;
      if (drop <= 0) return;
      if (drop >= this.bufLen) {
        this.bufStart += this.bufLen;
        this.bufLen = 0;
        return;
      }
      this.buf.copyWithin(0, drop, this.bufLen);
      this.bufStart += drop;
      this.bufLen -= drop;
    }

    process() {
      for (;;) {
        if (this.chirpAt < 0) {
          if (this.end() - this.scanPos < this.N) return;
          const r = this.scan(this.scanPos);
          if (this.h.onLevel) this.h.onLevel({ ncc: r.ncc });
          if (r.ncc >= CFG.detectThreshold) {
            if (r.idx > this.scanPos + this.block - this.guard) {
              this.scanPos = r.idx - this.guard; // peak too close to the edge; look again with more context
              continue;
            }
            this.chirpAt = r.idx;
            this.cur = r.mode;
            this.syncNcc = r.ncc;
            if (this.h.onSync) this.h.onSync({ ncc: r.ncc, mode: r.mode.m.name, at: r.idx / this.sr });
          } else {
            this.scanPos += this.block;
            this.trim(this.scanPos);
          }
        } else {
          const P = this.cur;
          if (this.end() < this.chirpAt + P.packetLen + Math.round(0.01 * this.sr)) return;
          const res = this.decodeAt(this.chirpAt, P);
          this.scanPos = this.chirpAt + (res.pkts.length ? P.packetLen : this.tplLen);
          this.chirpAt = -1;
          this.trim(this.scanPos);
          for (const pkt of res.pkts) if (this.h.onPacket) this.h.onPacket(pkt);
          for (const q of res.fails) {
            if (this.h.onFail) this.h.onFail({ reason: 'too many errors', quality: q, ncc: this.syncNcc, mode: P.m.name });
          }
        }
      }
    }

    // Normalized cross-correlation of each mode's chirp over [pos, pos + block).
    scan(pos) {
      const N = this.N;
      const buf = this.buf;
      const off = pos - this.bufStart;
      const xr = this.xr;
      const xi = this.xi;
      for (let i = 0; i < N; i++) {
        xr[i] = buf[off + i];
        xi[i] = 0;
      }
      this.fft(xr, xi, false);
      let best = { ncc: 0, idx: pos, mode: this.modes[0] };
      for (const P of this.modes) {
        const re = this.re;
        const im = this.im;
        for (let i = 0; i < N; i++) {
          re[i] = xr[i] * P.tRe[i] + xi[i] * P.tIm[i];
          im[i] = xi[i] * P.tRe[i] - xr[i] * P.tIm[i];
        }
        this.fft(re, im, true);
        let e = 0;
        for (let i = 0; i < this.tplLen; i++) e += buf[off + i] * buf[off + i];
        for (let t = 0; t < this.block; t++) {
          if (e > 1e-8 * this.tplLen) {
            const ncc = re[t] / (P.tplNorm * Math.sqrt(e));
            if (ncc > best.ncc) best = { ncc, idx: pos + t, mode: P };
          }
          const x0 = buf[off + t];
          const x1 = buf[off + t + this.tplLen];
          e += x1 * x1 - x0 * x0;
          if (e < 0) e = 0;
        }
      }
      return best;
    }

    // demodulate codeword c of a packet whose chirp starts at chirpAt
    demod(P, chirpAt, c) {
      const m = P.m;
      const G = m.groups;
      const T = m.tones;
      const nib = new Uint8Array(m.spc * G);
      const conf = new Float32Array(m.spc * G);
      const buf = this.buf;
      const coeff = P.coeff;
      const power = P.power;
      const L = P.winLen;
      for (let s = 0; s < m.spc; s++) {
        const a = chirpAt + P.symOffsets[c * m.spc + s] - this.bufStart;
        for (let k = 0; k < G * T; k++) {
          const cf = coeff[k];
          let s1 = 0;
          let s2 = 0;
          for (let i = 0; i < L; i++) {
            const s0 = buf[a + i] + cf * s1 - s2;
            s2 = s1;
            s1 = s0;
          }
          power[k] = s1 * s1 + s2 * s2 - cf * s1 * s2;
        }
        for (let g = 0; g < G; g++) {
          let m1 = -1;
          let m2 = -1;
          let arg = 0;
          for (let t = 0; t < T; t++) {
            const p = power[g * T + t];
            if (p > m1) {
              m2 = m1;
              m1 = p;
              arg = t;
            } else if (p > m2) m2 = p;
          }
          nib[s * G + g] = arg;
          conf[s * G + g] = m1 / (m2 + 1e-12);
        }
      }
      const code = new Array(CFG.rsN);
      const bconf = new Float32Array(CFG.rsN);
      for (let b = 0; b < CFG.rsN; b++) {
        const t = Math.floor(b / G);
        const g = b % G;
        const i1 = 2 * t * G + g;
        const i2 = (2 * t + 1) * G + g;
        code[b] = (nib[i1] << 4) | nib[i2];
        bconf[b] = Math.min(conf[i1], conf[i2]);
      }
      const sorted = Array.from(conf).sort((x, y) => x - y);
      const quality = 10 * Math.log10(sorted[sorted.length >> 1]);
      return { code, bconf, quality };
    }

    decodeAt(chirpAt, P) {
      const ms = this.sr / 1000;
      const pkts = [];
      const fails = [];
      for (let c = 0; c < P.m.cw; c++) {
        let pkt = null;
        let quality = 0;
        // the chirp peak can lock onto a late echo; also try slightly shifted windows
        for (const shift of [0, -4, 3, -8, -12]) {
          const d = this.demod(P, chirpAt + Math.round(shift * ms), c);
          if (shift === 0) quality = d.quality;
          const data = tryRS(d.code, d.bconf);
          pkt = data && parseBlock(data);
          if (pkt) {
            pkt.quality = d.quality;
            break;
          }
        }
        if (pkt) {
          pkt.ncc = this.syncNcc;
          pkt.mode = P.m.name;
          pkts.push(pkt);
        } else fails.push(quality);
      }
      return { pkts, fails };
    }
  }

  function tryRS(code, bconf) {
    try {
      return rsDecode(code, CFG.rsParity);
    } catch (e) {
      /* fall through to erasure decoding */
    }
    const order = Array.from(bconf.keys()).sort((a, b) => bconf[a] - bconf[b]);
    for (const n of [6, 12, 18, 24, 28, 32]) {
      try {
        return rsDecode(code, CFG.rsParity, order.slice(0, n));
      } catch (e) {
        /* try more erasures */
      }
    }
    return null;
  }

  function parseBlock(data) {
    const b = Uint8Array.from(data);
    const c = crc16(b.subarray(0, RS_K - 2));
    if (((c >> 8) & 255) !== b[RS_K - 2] || (c & 255) !== b[RS_K - 1]) return null;
    const len = b[6];
    if (len > PAYLOAD_MAX) return null;
    return {
      sid: (b[0] << 8) | b[1],
      idx: (b[2] << 8) | b[3],
      total: (b[4] << 8) | b[5],
      payload: b.slice(CFG.headerLen, CFG.headerLen + len),
    };
  }

  // ---------------------------------------------------------------- reassembly
  class Assembler {
    constructor() {
      this.reset();
    }
    reset() {
      this.sid = -1;
      this.total = 0;
      this.meta = null;
      this.chunks = new Map();
    }
    // returns true if the packet was new
    add(pkt) {
      if (pkt.sid !== this.sid) {
        this.reset();
        this.sid = pkt.sid;
        this.total = pkt.total;
      }
      if (pkt.idx === 0) {
        if (this.meta) return false;
        try {
          this.meta = JSON.parse(new TextDecoder().decode(pkt.payload));
        } catch (e) {
          return false;
        }
        return true;
      }
      if (pkt.idx > this.total || this.chunks.has(pkt.idx)) return false;
      this.chunks.set(pkt.idx, pkt.payload);
      return true;
    }
    complete() {
      return this.sid >= 0 && this.chunks.size === this.total;
    }
    prefix() {
      const parts = [];
      for (let i = 1; i <= this.total && this.chunks.has(i); i++) parts.push(this.chunks.get(i));
      return concat(parts);
    }
    file() {
      const parts = [];
      for (let i = 1; i <= this.total; i++) parts.push(this.chunks.get(i) || new Uint8Array(PAYLOAD_MAX));
      return concat(parts);
    }
    missing() {
      const m = [];
      for (let i = 1; i <= this.total; i++) if (!this.chunks.has(i)) m.push(i);
      return m;
    }
  }

  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  function sniffType(bytes) {
    const b = bytes;
    const s = (i, str) => str.split('').every((ch, k) => b[i + k] === ch.charCodeAt(0));
    if (b.length < 12) return '';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x89 && s(1, 'PNG')) return 'image/png';
    if (s(0, 'GIF8')) return 'image/gif';
    if (s(0, 'RIFF') && s(8, 'WEBP')) return 'image/webp';
    if (s(4, 'ftyp')) return 'video/mp4';
    if (s(0, '%PDF')) return 'application/pdf';
    return '';
  }

  // ---------------------------------------------------------------- WAV
  function toWav(samples, sr) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    w(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    w(36, 'data');
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return buf;
  }

  return {
    CFG,
    PAYLOAD_MAX,
    MODES,
    bytesForDuration,
    encode,
    estimateDuration,
    packetCount,
    Receiver,
    Assembler,
    toWav,
    crc32,
    sniffType,
    rs: { encode: rsEncode, decode: rsDecode },
  };
});
