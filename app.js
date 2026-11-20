/* global SonicModem, SSTV */
(function () {
  'use strict';
  const M = SonicModem;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ helpers
  document.querySelectorAll('.ch').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.ch').forEach((x) => x.classList.toggle('on', x === t));
      document.querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.id === t.dataset.tab));
    })
  );
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function fmtTime(s) {
    s = Math.round(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function kv(el, rows) {
    el.innerHTML = rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }
  function debounce(fn, ms) {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }
  const bars = (n) => '▮'.repeat(n) + '▯'.repeat(5 - n);

  // ------------------------------------------------------------ the TV set
  class TV {
    constructor(host) {
      host.appendChild($('tvTpl').content.cloneNode(true));
      this.screen = host.querySelector('.screen');
      this.pic = host.querySelector('canvas.pic');
      this.g = this.pic.getContext('2d');
      this.snowC = host.querySelector('canvas.snow');
      this.sg = this.snowC.getContext('2d');
      this.snowImg = this.sg.createImageData(this.snowC.width, this.snowC.height);
      this.snow32 = new Uint32Array(this.snowImg.data.buffer);
      this.beamEl = host.querySelector('.beam');
      this.o = {};
      for (const k of ['tl', 'tr', 'c', 'bl', 'br']) this.o[k] = host.querySelector('.osd .' + k);
      this.barEl = host.querySelector('.osd .bar');
      this.barFill = this.barEl.firstElementChild;
      this.ledEl = host.querySelector('.led');
      this.isOn = false;
      this.snowing = false;
      this.lastSnow = 0;
    }
    on() {
      if (this.isOn) return;
      this.isOn = true;
      this.screen.classList.remove('off');
      this.screen.classList.remove('poweron');
      void this.screen.offsetWidth;
      this.screen.classList.add('poweron');
      this.led('on');
    }
    off() {
      this.isOn = false;
      this.screen.classList.add('off');
      this.snow(false);
      this.beam(null);
      this.led('');
    }
    led(state) {
      this.ledEl.className = 'led' + (state ? ' ' + state : '');
    }
    snow(on) {
      this.snowing = on;
      this.screen.classList.toggle('snowy', on);
      if (on && !this.raf) this.raf = requestAnimationFrame((t) => this.snowLoop(t));
    }
    snowLoop(t) {
      this.raf = null;
      if (!this.snowing && !this.screen.classList.contains('snowy')) return;
      if (t - this.lastSnow > 45) {
        this.lastSnow = t;
        const s = this.snow32;
        for (let i = 0; i < s.length; i++) {
          const v = (Math.random() * Math.random() * 400) | 0;
          const g = v > 255 ? 255 : v;
          s[i] = 0xff000000 | (g << 16) | (g << 8) | g;
        }
        this.sg.putImageData(this.snowImg, 0, 0);
      }
      if (this.snowing) this.raf = requestAnimationFrame((tt) => this.snowLoop(tt));
    }
    // values are plain text; keys listed in `blink` flash like an old OSD
    osd(map, blink) {
      for (const k of Object.keys(map)) {
        this.o[k].textContent = map[k] || '';
        this.o[k].classList.toggle('blink', !!(blink && blink.includes(k)));
      }
    }
    progress(p) {
      this.barEl.style.display = p == null ? 'none' : 'block';
      if (p != null) this.barFill.style.width = Math.max(0, Math.min(100, p * 100)) + '%';
    }
    size(w, h) {
      if (this.pic.width !== w || this.pic.height !== h) {
        this.pic.width = w;
        this.pic.height = h;
      }
    }
    clear() {
      this.g.fillStyle = '#000';
      this.g.fillRect(0, 0, this.pic.width, this.pic.height);
    }
    rows(y, count, rgba) {
      const w = this.pic.width;
      this.g.putImageData(new ImageData(new Uint8ClampedArray(rgba.subarray(0, count * w * 4)), w, count), 0, y);
    }
    beam(frac) {
      this.screen.classList.toggle('scanning', frac != null);
      if (frac != null) this.beamEl.style.top = Math.min(99.5, frac * 100) + '%';
    }
    // draw a whole picture (canvas / bitmap / img), letterboxed
    picture(src, blur) {
      const sw = src.naturalWidth || src.width;
      const sh = src.naturalHeight || src.height;
      this.size(640, 480);
      this.clear();
      const s = Math.min(640 / sw, 480 / sh);
      this.g.imageSmoothingQuality = 'high';
      this.g.filter = blur ? 'blur(10px)' : 'none';
      this.g.drawImage(src, (640 - sw * s) / 2, (480 - sh * s) / 2, sw * s, sh * s);
      this.g.filter = 'none';
    }
    testCard() {
      this.size(320, 240);
      const g = this.g;
      const cols = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
      cols.forEach((c, i) => {
        g.fillStyle = c;
        g.fillRect((i * 320) / 7, 0, 320 / 7 + 1, 160);
      });
      const low = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
      low.forEach((c, i) => {
        g.fillStyle = c;
        g.fillRect((i * 320) / 7, 160, 320 / 7 + 1, 22);
      });
      g.fillStyle = '#000';
      g.fillRect(0, 182, 320, 58);
      g.fillStyle = '#fff';
      g.fillRect(40, 190, 60, 40);
      g.fillStyle = '#1d1d1d';
      g.fillRect(140, 190, 140, 40);
    }
  }

  const txTv = new TV($('txTv'));
  const rxTv = new TV($('rxTv'));
  txTv.on();
  txTv.testCard();
  txTv.osd({ tl: 'CH1', tr: 'TRANSMIT', c: 'PICK A PICTURE', bl: '', br: '' }, ['c']);
  rxTv.osd({ tl: '', tr: '', c: '', bl: '', br: '' });

  // ------------------------------------------------------------ transmit
  let srcFile = null;
  let srcBitmap = null;
  let kind = 'tv';
  let tvPic = null; // canvas at the broadcast resolution
  let payload = null; // digital: {bytes, name, type, preview, dims, quality}
  let onAir = null; // what the loaded sound contains, for the live view
  let wavUrl = null;
  let prepToken = 0;

  $('file').addEventListener('change', (e) => e.target.files[0] && pickFile(e.target.files[0]));
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => e.preventDefault());
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
  });
  document.querySelectorAll('#kind button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.disabled) return;
      kind = b.dataset.kind;
      prepare();
    })
  );

  const isImage = (f) => /^image\//.test(f.type);

  async function pickFile(f) {
    srcFile = f;
    srcBitmap = null;
    if (isImage(f)) {
      try {
        srcBitmap = await createImageBitmap(f);
      } catch (e) {
        srcBitmap = null;
      }
    }
    if (!srcBitmap) kind = 'data';
    $('out').hidden = true;
    onAir = null;
    await prepare();
  }

  ['tvMode', 'tvFit'].forEach((id) => $(id).addEventListener('input', () => prepare()));
  ['mode', 'fmt', 'secs', 'manual', 'dim', 'q'].forEach((id) => $(id).addEventListener('input', debounce(prepare, 200)));

  async function prepare() {
    document.querySelectorAll('#kind button').forEach((b) => {
      b.classList.toggle('on', b.dataset.kind === kind);
      b.disabled = b.dataset.kind === 'tv' && srcFile && !srcBitmap;
    });
    $('tvOpts').hidden = kind !== 'tv';
    $('dataOpts').hidden = kind !== 'data';
    $('imgOpts').hidden = !srcBitmap;
    $('dimV').textContent = $('dim').value;
    $('qV').textContent = (+$('q').value).toFixed(2);
    $('secsV').textContent = fmtTime(+$('secs').value);
    if (!srcFile) return;
    $('out').hidden = true;
    onAir = null;
    if (kind === 'tv') prepareTv();
    else await prepareData();
  }

  function prepareTv() {
    prepToken++;
    const m = SSTV.MODES[$('tvMode').value];
    const c = document.createElement('canvas');
    c.width = m.width;
    c.height = m.height;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, m.width, m.height);
    const bw = srcBitmap.width;
    const bh = srcBitmap.height;
    const s = $('tvFit').value === 'cover' ? Math.max(m.width / bw, m.height / bh) : Math.min(m.width / bw, m.height / bh);
    g.imageSmoothingQuality = 'high';
    g.drawImage(srcBitmap, (m.width - bw * s) / 2, (m.height - bh * s) / 2, bw * s, bh * s);
    tvPic = c;
    showTxReady();
    kv($('sendInfo'), [
      ['Picture', esc(srcFile.name)],
      ['Broadcast', m.label + ' · ' + m.width + '×' + m.height],
      ['Sound length', '<b style="color:var(--orange)">' + fmtTime(m.duration) + '</b>'],
    ]);
    $('gen').disabled = false;
  }

  function showTxReady() {
    txTv.beam(null);
    txTv.progress(null);
    txTv.snow(false);
    if (kind === 'tv' && tvPic) {
      const m = SSTV.MODES[$('tvMode').value];
      txTv.size(m.width, m.height);
      txTv.g.drawImage(tvPic, 0, 0);
      txTv.osd({ tl: 'CH1', tr: m.label.toUpperCase(), c: '', bl: onAir ? '▶ PRESS PLAY' : 'PREVIEW', br: m.width + '×' + m.height }, onAir ? ['bl'] : []);
    } else if (payload) {
      showDataPreview();
      txTv.osd({ tl: 'CH1', tr: 'DATA', bl: onAir ? '▶ PRESS PLAY' : 'PREVIEW', br: fmtBytes(payload.bytes.length) }, onAir ? ['bl'] : []);
    }
  }

  function showDataPreview() {
    if (payload.type.startsWith('image/')) {
      const img = new Image();
      img.onload = () => {
        txTv.picture(img);
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(new Blob([payload.bytes], { type: payload.type }));
      txTv.osd({ c: '' });
    } else {
      txTv.size(320, 240);
      txTv.clear();
      txTv.osd({ c: '💾 ' + payload.name });
    }
  }

  // ---- digital (exact file) payload, as before
  async function encodeImage(bmp, maxDim, q, type) {
    const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    let blob = await new Promise((r) => c.toBlob(r, type, q));
    if (blob.type !== type) blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q)); // browser can't make WebP
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (blob.type === 'image/webp') bytes = stripWebP(bytes);
    return { bytes, type: blob.type, w: c.width, h: c.height, q };
  }

  // Chrome adds a ~456 byte colour profile (ICCP) to every WebP. Drop it and
  // any EXIF/XMP: browsers assume sRGB anyway, and over sound every byte counts.
  function stripWebP(b) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const chunks = [];
    for (let p = 12; p + 8 <= b.length; ) {
      const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      const n = v.getUint32(p + 4, true);
      chunks.push({ id, data: b.subarray(p, p + 8 + n + (n & 1)) });
      p += 8 + n + (n & 1);
    }
    const ids = chunks.map((c) => c.id);
    if (ids.includes('ANIM')) return b;
    const keep = chunks.filter((c) => (ids.includes('ALPH') ? ['VP8X', 'ALPH', 'VP8 ', 'VP8L'] : ['VP8 ', 'VP8L']).includes(c.id));
    if (!keep.some((c) => c.id === 'VP8 ' || c.id === 'VP8L')) return b;
    let n = 12;
    for (const c of keep) n += c.data.length;
    const out = new Uint8Array(n);
    out.set(b.subarray(0, 12));
    new DataView(out.buffer).setUint32(4, n - 8, true);
    let o = 12;
    for (const c of keep) {
      out.set(c.data, o);
      if (c.id === 'VP8X') out[o + 8] &= ~0x2c; // clear ICC, EXIF, XMP flags
      o += c.data.length;
    }
    return out;
  }

  // tiny blurry thumbnail sent first (<= 2 blocks) so the receiver shows something right away
  async function makePreview(bmp) {
    let img;
    for (const d of [96, 80, 64, 48, 32, 24]) {
      img = await encodeImage(bmp, d, 0.4, 'image/webp');
      if (img.bytes.length <= 2 * M.PAYLOAD_MAX - 20) break;
    }
    return img.bytes;
  }

  // largest resolution that fits the byte budget at decent quality, then the best quality at that size
  async function fitImage(bmp, budget, type) {
    const native = Math.max(bmp.width, bmp.height);
    const dims = [2048, 1600, 1280, 1024, 896, 768, 640, 576, 512, 448, 384, 352, 320, 288, 256, 224, 192, 160, 128, 96, 64].filter((d) => d < native);
    if (native <= 2048) dims.unshift(native);
    const minQ = 0.5;
    let lo = 0;
    let hi = dims.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = await encodeImage(bmp, dims[mid], minQ, type);
      if (r.bytes.length <= budget) {
        found = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    if (found < 0) return encodeImage(bmp, dims[dims.length - 1], 0.2, type);
    let best = await encodeImage(bmp, dims[found], minQ, type);
    let qLo = minQ;
    let qHi = 0.95;
    for (let i = 0; i < 5; i++) {
      const q = (qLo + qHi) / 2;
      const r = await encodeImage(bmp, dims[found], q, type);
      if (r.bytes.length <= budget) {
        best = r;
        qLo = q;
      } else qHi = q;
    }
    return best;
  }

  async function prepareData() {
    const fmt = $('fmt').value;
    $('fitBox').hidden = fmt === 'original';
    $('manualBox').hidden = fmt === 'original' || !$('manual').checked;
    $('secs').disabled = $('manual').checked;
    const token = ++prepToken;
    const f = srcFile;
    const mode = $('mode').value;
    $('gen').disabled = true;
    kv($('sendInfo'), [['', 'Optimizing…']]);

    let p;
    if (srcBitmap && fmt !== 'original') {
      const preview = await makePreview(srcBitmap);
      const img = $('manual').checked
        ? await encodeImage(srcBitmap, +$('dim').value, +$('q').value, fmt)
        : await fitImage(srcBitmap, M.bytesForDuration(+$('secs').value, mode) - preview.length, fmt);
      p = {
        bytes: img.bytes,
        name: f.name.replace(/\.[^.]+$/, '') + (img.type === 'image/webp' ? '.webp' : '.jpg'),
        type: img.type,
        preview,
        dims: img.w + '×' + img.h,
        quality: Math.round(img.q * 100) + '%',
      };
    } else {
      const bytes = new Uint8Array(await f.arrayBuffer());
      p = { bytes, name: f.name, type: f.type || 'application/octet-stream' };
      if (srcBitmap && bytes.length > 2000) p.preview = await makePreview(srcBitmap);
    }
    if (token !== prepToken || kind !== 'data') return;
    payload = p;
    showTxReady();

    const total = payload.bytes.length + (payload.preview ? payload.preview.length : 0);
    const dur = M.estimateDuration(total, mode);
    const rows = [['File', esc(payload.name)], ['Original', fmtBytes(f.size)]];
    if (payload.dims) rows.push(['Resolution', payload.dims + ' · quality ' + payload.quality]);
    rows.push(
      ['To send', fmtBytes(payload.bytes.length) + (payload.preview ? ' + ' + fmtBytes(payload.preview.length) + ' preview' : '')],
      ['Sound length', '<b style="color:' + (dur > 300 ? 'var(--red)' : 'var(--orange)') + '">' + fmtTime(dur) + '</b> (' + mode + ' mode)']
    );
    kv($('sendInfo'), rows);
    $('gen').disabled = false;
  }

  $('gen').addEventListener('click', () => {
    $('gen').disabled = true;
    $('gen').textContent = '⏳ Making…';
    setTimeout(() => {
      try {
        let enc;
        let name;
        if (kind === 'tv') {
          const m = SSTV.MODES[$('tvMode').value];
          const px = tvPic.getContext('2d').getImageData(0, 0, m.width, m.height).data;
          enc = SSTV.encode(px, m.name, 48000);
          name = srcFile.name.replace(/\.[^.]+$/, '') + '_' + m.name + '.wav';
          onAir = { kind: 'tv', m, pic: tvPic, duration: enc.duration };
        } else {
          enc = M.encode(payload.bytes, { name: payload.name, type: payload.type, preview: payload.preview }, 48000, $('mode').value);
          name = payload.name.replace(/\.[^.]+$/, '') + '_data.wav';
          onAir = { kind: 'data', duration: enc.duration };
        }
        const wav = M.toWav(enc.samples, enc.sampleRate);
        if (wavUrl) URL.revokeObjectURL(wavUrl);
        wavUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
        $('player').src = wavUrl;
        $('player').loop = $('loop').checked;
        $('dl').href = wavUrl;
        $('dl').download = name;
        $('wavInfo').textContent = fmtTime(enc.duration) + ' · ' + fmtBytes(wav.byteLength);
        $('out').hidden = false;
        showTxReady();
      } catch (err) {
        alert(err.message);
      }
      $('gen').disabled = false;
      $('gen').textContent = '⚡ Make the sound';
    }, 30);
  });
  $('loop').addEventListener('change', () => ($('player').loop = $('loop').checked));

  // ---- live view of what is being sent, in step with the sound
  const player = $('player');
  let txRaf = null;
  let txRows = -1;
  function txFrame() {
    txRaf = null;
    if (!onAir) return;
    const t = player.currentTime;
    const live = !player.paused && !player.ended;
    if (onAir.kind === 'tv') {
      const m = onAir.m;
      const t0 = SSTV.imageStart();
      if (t < t0) {
        txRows = -1;
        txTv.clear();
        txTv.snow(true);
        txTv.beam(null);
        txTv.progress(null);
        txTv.osd({ tl: 'CH1', tr: '● ON AIR', c: 'SYNC ▸ ' + m.label.toUpperCase(), bl: '', br: '' }, ['c']);
      } else {
        txTv.snow(false);
        const rows = Math.min(m.height, Math.floor((t - t0) / m.unitDur) * m.rowsPerUnit);
        if (rows !== txRows) {
          txTv.size(m.width, m.height);
          txTv.clear();
          if (rows > 0) txTv.g.drawImage(onAir.pic, 0, 0, m.width, rows, 0, 0, m.width, rows);
          txRows = rows;
        }
        const done = rows >= m.height;
        txTv.beam(done ? null : rows / m.height);
        txTv.progress(done ? null : rows / m.height);
        txTv.osd(
          { tl: 'CH1', tr: done ? '✓ SENT' : '● ON AIR', c: '', bl: m.label.toUpperCase(), br: done ? '' : 'LINE ' + rows + '/' + m.height },
          done ? [] : ['tr']
        );
      }
    } else {
      const p = Math.min(1, t / onAir.duration);
      txTv.progress(p < 1 ? p : null);
      txTv.osd({ tl: 'CH1', tr: p >= 1 ? '✓ SENT' : '● ON AIR', bl: 'DATA', br: Math.round(p * 100) + '%' }, p >= 1 ? [] : ['tr']);
    }
    if (live) txRaf = requestAnimationFrame(txFrame);
  }
  const kickTx = () => {
    if (!txRaf) txRaf = requestAnimationFrame(txFrame);
  };
  player.addEventListener('play', () => {
    txTv.led('live');
    kickTx();
  });
  player.addEventListener('seeked', kickTx);
  player.addEventListener('pause', () => {
    txTv.led('on');
    kickTx();
  });
  player.addEventListener('ended', () => {
    txTv.led('on');
    kickTx();
  });

  // ------------------------------------------------------------ receive
  const asm = new M.Assembler();
  let audio = null; // {ctx, stream, proc, analyser}
  let rx = null; // {data: M.Receiver, tv: SSTV.Decoder}
  let previewShown = false;
  let lastMode = 'fast';
  let finished = false;
  let stats = { ok: 0, fail: 0, quality: null };
  let tvRx = null; // picture being received
  let gotSomething = false; // a picture or file arrived (for the "no signal" message)
  let dlUrl = null;

  function log(msg, cls) {
    const el = $('log');
    const line = document.createElement('div');
    line.className = cls || '';
    line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
    el.appendChild(line);
    while (el.childNodes.length > 200) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  function setStatus(s, color) {
    $('rxStatus').textContent = s;
    $('rxStatus').style.color = color || '';
  }
  function idleScreen() {
    rxTv.on();
    rxTv.snow(true);
    rxTv.beam(null);
    rxTv.progress(null);
    rxTv.osd({ tl: 'CH2', tr: audio ? '◉ LISTENING' : '', c: 'NO SIGNAL', bl: '', br: '' }, ['c']);
  }
  function offerDownload(blob, name, label) {
    if (dlUrl) URL.revokeObjectURL(dlUrl);
    dlUrl = URL.createObjectURL(blob);
    const a = $('rxDl');
    a.href = dlUrl;
    a.download = name;
    a.textContent = label;
    a.hidden = false;
  }

  function makeDecoders(sr) {
    const tv = new SSTV.Decoder(sr, {
      onStart: (e) => {
        tvRx = { w: e.width, h: e.height, label: e.label, rows: 0, t0: Date.now() };
        rxTv.on();
        rxTv.snow(false);
        rxTv.size(e.width, e.height);
        rxTv.clear();
        rxTv.led('live');
        rxTv.osd({ tl: 'CH2', tr: e.label.toUpperCase(), c: '', bl: '● RX', br: '' }, ['bl']);
        $('rxDl').hidden = true;
        setStatus('📺 Picture incoming – ' + e.label);
        log('TV picture started: ' + e.label + ' ' + e.width + '×' + e.height, 'info');
      },
      onRows: (y, count, rgba) => {
        rxTv.rows(y, count, rgba);
        tvRx.rows = y + count;
        rxTv.beam(tvRx.rows / tvRx.h);
        rxTv.progress(tvRx.rows / tvRx.h);
        rxTv.osd({ br: 'LINE ' + tvRx.rows + '/' + tvRx.h });
      },
      onUnit: (e) => {
        rxTv.osd({ bl: '● RX ' + bars(Math.round(e.quality * 5)) });
      },
      onEnd: (e) => {
        gotSomething = true;
        rxTv.beam(null);
        rxTv.progress(null);
        rxTv.led('on');
        rxTv.osd({ tr: '✓ RECEIVED', bl: tvRx.label.toUpperCase(), br: '' }, []);
        setStatus('✅ Picture received' + (e.quality < 0.7 ? ' (weak signal)' : ''));
        log('picture complete, sync ' + Math.round(e.quality * 100) + '%', 'ok');
        rxTv.pic.toBlob((b) => offerDownload(b, 'sonic-tv-' + e.mode + '-' + Date.now() + '.png', '📸 Save picture'));
        tvRx = null;
      },
    });
    const data = new M.Receiver(sr, {
      onSync: (e) => {
        if (tv.receiving()) return;
        if (!finished) {
          setStatus('💾 Receiving data…');
          rxTv.snow(false);
          if (!previewShown) rxTv.osd({ c: 'DATA ▸ ' + e.mode.toUpperCase() }, ['c']);
        }
        $('dataBox').open = true;
        log(e.mode + ' data signal found (match ' + e.ncc.toFixed(2) + ')', 'info');
      },
      onPacket: (p) => {
        stats.ok++;
        stats.quality = p.quality;
        lastMode = p.mode;
        const isNew = asm.add(p);
        const what = p.idx === 0 ? 'file info' : 'packet ' + p.idx + '/' + p.total;
        log('✓ ' + what + (isNew ? '' : ' (duplicate)') + ' · quality ' + p.quality.toFixed(1) + ' dB', 'ok');
        render();
      },
      onFail: (e) => {
        stats.fail++;
        stats.quality = e.quality;
        log('✗ packet damaged (quality ' + e.quality.toFixed(1) + ' dB) – move closer / louder', 'bad');
        render();
      },
    });
    return {
      push(x) {
        tv.push(x);
        data.push(x);
      },
    };
  }

  // ---- digital reception display
  function render() {
    const total = asm.total;
    const meta = asm.meta;
    const got = asm.chunks.size;
    const rows = [];
    if (meta) rows.push(['File', esc(meta.n)], ['Type', esc(meta.t || '?')], ['Size', fmtBytes(meta.s)]);
    if (asm.sid >= 0) rows.push(['Packets', got + ' / ' + total + (asm.missing().length && got ? ' (missing ' + asm.missing().length + ')' : '')]);
    rows.push(['Good / damaged', stats.ok + ' / ' + stats.fail]);
    if (stats.quality != null) rows.push(['Signal quality', stats.quality.toFixed(1) + ' dB ' + (stats.quality > 12 ? '(good)' : stats.quality > 7 ? '(ok)' : '(weak)')]);
    if (meta && total) rows.push(['Time left', '~' + fmtTime((asm.missing().length * M.MODES[lastMode].packetDur) / M.MODES[lastMode].cw)]);
    kv($('rxInfo'), rows);

    const grid = $('grid');
    if (asm.sid >= 0 && total <= 2000) {
      if (grid.childNodes.length !== total + 1) {
        grid.innerHTML = '';
        for (let i = 0; i <= total; i++) {
          const c = document.createElement('i');
          c.title = i === 0 ? 'file info' : 'packet ' + i;
          if (i === 0) c.classList.add('meta');
          grid.appendChild(c);
        }
      }
      grid.childNodes[0].classList.toggle('ok', !!meta);
      for (let i = 1; i <= total; i++) grid.childNodes[i].classList.toggle('ok', asm.chunks.has(i));
    } else if (asm.sid < 0) grid.innerHTML = '';

    if (asm.sid < 0) return;
    if (asm.complete()) return finish();
    if (!tvRx) {
      rxTv.progress(total ? got / total : null);
      rxTv.osd({ tl: 'CH2', tr: '💾 DATA', br: got + '/' + total, bl: '● RX' }, ['bl']);
    }

    // the sender puts a tiny thumbnail first: show it blurred until the real image is complete
    if (meta && meta.p && !previewShown && !tvRx) {
      const prefix = asm.prefix();
      if (prefix.length >= meta.p) {
        previewShown = true;
        const thumb = prefix.subarray(0, meta.p);
        showBlob(new Blob([thumb], { type: M.sniffType(thumb) || 'image/webp' }), true);
        rxTv.osd({ c: '' });
      }
    }
  }

  function showBlob(blob, blur) {
    const img = new Image();
    img.onload = () => {
      rxTv.snow(false);
      rxTv.picture(img, blur);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(blob);
  }

  function finish() {
    if (finished) return;
    finished = true;
    gotSomething = true;
    const meta = asm.meta || {};
    let bytes = asm.file();
    const start = meta.p || 0; // skip the thumbnail
    if (meta.s != null) bytes = bytes.subarray(start, start + meta.s);
    const type = meta.t || M.sniffType(bytes) || 'application/octet-stream';
    const name = meta.n || 'received_file';
    const crcOk = meta.c == null ? null : M.crc32(bytes) === meta.c;
    const blob = new Blob([bytes], { type });
    offerDownload(blob, name, '⬇ Save ' + name);
    rxTv.progress(null);
    if (!tvRx) {
      rxTv.snow(false);
      if (type.startsWith('image/')) {
        showBlob(blob, false);
        rxTv.osd({ c: '' });
      } else {
        rxTv.size(320, 240);
        rxTv.clear();
        rxTv.osd({ c: '💾 ' + name });
      }
      rxTv.osd({ tr: crcOk === false ? '⚠ DAMAGED' : '✓ RECEIVED', bl: fmtBytes(bytes.length), br: '' }, []);
      rxTv.led('on');
    }
    setStatus(crcOk === false ? '⚠ File received but checksum failed' : '✅ File received – ' + name, crcOk === false ? 'var(--red)' : '');
    log('file complete: ' + name + ' (' + fmtBytes(bytes.length) + ')' + (crcOk ? ', checksum OK' : ''), crcOk === false ? 'bad' : 'ok');
  }

  function resetRx() {
    asm.reset();
    finished = false;
    previewShown = false;
    tvRx = null;
    stats = { ok: 0, fail: 0, quality: null };
    $('rxDl').hidden = true;
    $('log').innerHTML = '';
    if (audio) {
      rx = makeDecoders(audio.ctx.sampleRate);
      idleScreen();
      setStatus('👂 Listening…');
    } else {
      rxTv.off();
      setStatus('TV is off');
    }
    render();
  }
  $('reset').addEventListener('click', resetRx);

  // a new data transmission (different session id) restarts the display
  const origAdd = asm.add.bind(asm);
  asm.add = (p) => {
    if (asm.sid >= 0 && p.sid !== asm.sid) {
      finished = false;
      previewShown = false;
      $('rxDl').hidden = true;
      log('new transmission started', 'info');
    }
    return origAdd(p);
  };

  $('listen').addEventListener('click', async () => {
    if (audio) return stopListening();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(analyser);
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      audio = { ctx, stream, proc, analyser };
      rx = makeDecoders(ctx.sampleRate);
      proc.onaudioprocess = (e) => {
        const x = e.inputBuffer.getChannelData(0);
        let p = 0;
        for (let i = 0; i < x.length; i++) p += x[i] * x[i];
        const db = 20 * Math.log10(Math.sqrt(p / x.length) + 1e-9);
        $('lvl').style.width = Math.max(0, Math.min(100, (db + 70) * 1.6)) + '%';
        rx.push(new Float32Array(x));
      };
      const label = stream.getAudioTracks()[0].label;
      log('microphone on: ' + (label || 'default') + ' @ ' + ctx.sampleRate + ' Hz', 'info');
      setStatus('👂 Listening…');
      $('listen').textContent = '⏻ Turn off';
      $('listen').classList.replace('teal', 'red');
      if (!tvRx && !finished) idleScreen();
      else rxTv.osd({ tr: '◉ LISTENING' });
      drawSpectrum();
    } catch (err) {
      setStatus('Microphone error: ' + err.message, 'var(--red)');
    }
  });

  function stopListening() {
    audio.proc.onaudioprocess = null;
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close();
    audio = null;
    $('listen').textContent = '⏻ Turn on & listen';
    $('listen').classList.replace('red', 'teal');
    $('lvl').style.width = '0';
    setStatus('TV is off');
    rxTv.off();
  }

  function drawSpectrum() {
    const cv = $('spec');
    const g = cv.getContext('2d');
    const bins = new Uint8Array(audio.analyser.frequencyBinCount);
    const maxBin = Math.min(bins.length, Math.round((9000 / (audio.ctx.sampleRate / 2)) * bins.length));
    const step = () => {
      if (!audio) return;
      audio.analyser.getByteFrequencyData(bins);
      g.drawImage(cv, -2, 0);
      for (let y = 0; y < cv.height; y++) {
        const v = bins[Math.floor(((cv.height - 1 - y) / cv.height) * maxBin)];
        g.fillStyle = `hsl(${110 - v * 0.25}, 90%, ${Math.min(62, v / 3.4)}%)`;
        g.fillRect(cv.width - 2, y, 2, 1);
      }
      requestAnimationFrame(step);
    };
    step();
  }

  // play a recorded / downloaded sound file into the TV (fast-forwarded, so you still see it paint)
  $('audioFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setStatus('📂 Playing ' + f.name + '…');
    log('decoding file ' + f.name, 'info');
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      ctx.close();
      idleScreen();
      gotSomething = false;
      const dec = makeDecoders(buf.sampleRate);
      const x = buf.getChannelData(0);
      const chunk = Math.round(buf.sampleRate * 0.5);
      for (let i = 0; i < x.length; i += chunk) {
        dec.push(x.subarray(i, i + chunk));
        // pace it so you can watch it paint; when the tab is hidden just run flat out
        if (!document.hidden) await new Promise((r) => setTimeout(r, 16));
      }
      dec.push(new Float32Array(buf.sampleRate * 2)); // flush with silence
      if (!gotSomething && !tvRx) {
        setStatus(asm.sid >= 0 ? 'File incomplete – ' + asm.missing().length + ' packets missing' : 'No signal found in that file', 'var(--yellow)');
      }
    } catch (err) {
      setStatus('Could not decode: ' + err.message, 'var(--red)');
    }
  });

  prepare();
  render();
})();
