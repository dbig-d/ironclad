'use strict';
// ---------------------------------------------------------------------------
// Ground painting. The whole battlefield (plus a border) is baked into one
// canvas; tread marks and scorch decals are painted onto it during play.
// ---------------------------------------------------------------------------

const TERRAIN_PAD = 260;

class Terrain {
  constructor(map) {
    this.map = map;
    this.biome = map.biome;
    const W = map.w + TERRAIN_PAD * 2, H = map.h + TERRAIN_PAD * 2;
    // Cap the backing store at ~9 MP to keep memory sane on big maps.
    this.scale = Math.min(1, Math.sqrt((LOW_MEM ? 4e6 : 9e6) / (W * H)));
    this.canvas = makeCanvas(W * this.scale, H * this.scale);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(this.scale, this.scale);
    this.ctx.translate(TERRAIN_PAD, TERRAIN_PAD);
    this.rng = new RNG(map.seed ^ 0xa5a5a5);
    this.noise = makeNoise(this.rng);

    this.paint();
    this.sprites = map.obstacles.map(o => obstacleSprite(o, this.biome));
    for (const s of this.sprites) toBitmap(s.canvas, b => { s.canvas = b; });
  }

  paint() {
    const ctx = this.ctx, m = this.map, b = this.biome, R = this.rng;
    const W = m.w + TERRAIN_PAD * 2, H = m.h + TERRAIN_PAD * 2;
    const x0 = -TERRAIN_PAD, y0 = -TERRAIN_PAD;

    // 1. Macro colour variation from low-res fbm, upscaled smoothly.
    const ds = 10;
    const lw = Math.ceil(W / ds), lh = Math.ceil(H / ds);
    const low = makeCanvas(lw, lh), lctx = low.getContext('2d');
    const img = lctx.createImageData(lw, lh);
    const cols = b.ground.map(hexToRgb);
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const n = this.noise.fbm(x * 0.045, y * 0.045, 4);
        const n2 = this.noise.fbm(x * 0.13 + 50, y * 0.13 + 50, 3);
        const t = clamp(n * 1.5 - 0.25, 0, 0.999) * (cols.length - 1);
        const i = Math.floor(t), f = t - i;
        const A = cols[i], B = cols[Math.min(i + 1, cols.length - 1)];
        const k = (y * lw + x) * 4;
        const v = (n2 - 0.5) * 18;
        img.data[k] = lerp(A[0], B[0], f) + v;
        img.data[k + 1] = lerp(A[1], B[1], f) + v;
        img.data[k + 2] = lerp(A[2], B[2], f) + v;
        img.data[k + 3] = 255;
      }
    }
    lctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(low, x0, y0, lw * ds, lh * ds);

    // 2. Fine grain.
    const grain = makeCanvas(256, 256), gctx = grain.getContext('2d');
    const gimg = gctx.createImageData(256, 256);
    for (let i = 0; i < gimg.data.length; i += 4) {
      const v = R.chance(0.5) ? 255 : 0;
      gimg.data[i] = gimg.data[i + 1] = gimg.data[i + 2] = v;
      gimg.data[i + 3] = R.float(0, 22);
    }
    gctx.putImageData(gimg, 0, 0);
    ctx.fillStyle = ctx.createPattern(grain, 'repeat');
    ctx.fillRect(x0, y0, W, H);

    // 3. Dirt patches.
    const patches = Math.round((m.w * m.h) / 90000);
    for (let i = 0; i < patches; i++) {
      const x = R.float(0, m.w), y = R.float(0, m.h), r = R.float(30, 110);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(b.dirt, R.float(0.25, 0.5)));
      g.addColorStop(1, rgba(b.dirt, 0));
      ctx.save();
      ctx.translate(x, y); ctx.scale(1, R.float(0.5, 1)); ctx.rotate(R.float(0, TAU)); ctx.translate(-x, -y);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.restore();
    }

    // 3b. Painted set pieces: crop fields, frozen lakes, scorched earth.
    for (const d of m.decals) this.decal(d);

    // 4. Standing water, then roads with tyre ruts (and bridges where they cross water).
    for (const p of m.pools) this.pool(p);
    for (const road of m.roads) this.paintRoad(road);
    if (m.pools.length) this.paintBridges();

    // 5. Scatter detail.
    this.paintDetails();

    // 6. Old craters.
    const craters = Math.round((m.w * m.h) / 700000) + 2;
    for (let i = 0; i < craters; i++) this.crater(R.float(100, m.w - 100), R.float(100, m.h - 100), R.float(18, 40), 0.6);

    // 7. Bases, flag stands, hill clearing.
    this.paintPads();

    // 8. Obstacle shadows.
    this.paintShadows();

    // 9. Out-of-bounds border.
    this.paintBorder();
  }

  roadPath(pts) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  paintRoad(pts) {
    const ctx = this.ctx, b = this.biome;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const passes = [[110, rgba(b.dirt, 0.12)], [84, rgba(b.dirt, 0.22)], [64, rgba(b.dirt, 0.5)], [44, rgba(b.dirtDark, 0.35)], [36, rgba(b.dirt, 0.6)], [14, rgba(b.dirtDark, 0.22)], [8, rgba(b.dirt, 0.5)]];
    for (const [w, c] of passes) {
      ctx.lineWidth = w;
      ctx.strokeStyle = c;
      this.roadPath(pts);
      ctx.stroke();
    }
    ctx.restore();
  }

  paintDetails() {
    const ctx = this.ctx, m = this.map, b = this.biome, R = this.rng;
    const area = m.w * m.h;
    ctx.save();
    if (b.id === 'grassland') {
      for (let i = 0; i < area / 900; i++) {
        const x = R.float(-40, m.w + 40), y = R.float(-40, m.h + 40);
        ctx.strokeStyle = rgba(R.pick(b.detail), R.float(0.35, 0.8));
        ctx.lineWidth = R.float(0.8, 1.4);
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = -Math.PI / 2 + R.float(-0.7, 0.7), l = R.float(3, 7);
          ctx.moveTo(x + k * 1.3, y);
          ctx.lineTo(x + k * 1.3 + Math.cos(a) * l, y + Math.sin(a) * l);
        }
        ctx.stroke();
      }
      for (let i = 0; i < area / 5000; i++) {
        ctx.fillStyle = R.pick(b.flowers);
        const x = R.float(0, m.w), y = R.float(0, m.h);
        for (let k = 0; k < R.int(2, 6); k++) {
          ctx.beginPath(); ctx.arc(x + R.float(-8, 8), y + R.float(-8, 8), R.float(1, 1.8), 0, TAU); ctx.fill();
        }
      }
      for (let i = 0; i < area / 22000; i++) this.bush(R.float(0, m.w), R.float(0, m.h), R.float(7, 14));
    } else if (b.id === 'badlands') {
      // Cracked, sun-baked earth.
      for (let i = 0; i < area / 45000; i++) {
        const cx = R.float(0, m.w), cy = R.float(0, m.h);
        ctx.strokeStyle = rgba('#4a1d0c', R.float(0.18, 0.32));
        for (let k = 0; k < R.int(6, 12); k++) {
          let x = cx + R.float(-40, 40), y = cy + R.float(-40, 40), a = R.float(0, TAU);
          ctx.lineWidth = R.float(0.6, 1.4);
          ctx.beginPath(); ctx.moveTo(x, y);
          for (let s = 0; s < R.int(3, 6); s++) {
            a += R.float(-0.9, 0.9);
            x += Math.cos(a) * R.float(8, 18); y += Math.sin(a) * R.float(8, 18);
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      for (let i = 0; i < area / 8000; i++) {
        const x = R.float(0, m.w), y = R.float(0, m.h), l = R.float(30, 90);
        ctx.strokeStyle = rgba('#f0b184', 0.18);
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + l / 2, y - 4, x + l, y + R.float(-3, 3)); ctx.stroke();
      }
      for (let i = 0; i < area / 20000; i++) this.bush(R.float(0, m.w), R.float(0, m.h), R.float(5, 9), '#7d6a3a');
    } else if (b.id === 'cherry') {
      for (let i = 0; i < area / 1100; i++) {
        const x = R.float(-40, m.w + 40), y = R.float(-40, m.h + 40);
        ctx.strokeStyle = rgba(R.pick(b.detail), R.float(0.35, 0.75));
        ctx.lineWidth = R.float(0.8, 1.3);
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = -Math.PI / 2 + R.float(-0.7, 0.7), l = R.float(3, 6);
          ctx.moveTo(x + k * 1.3, y);
          ctx.lineTo(x + k * 1.3 + Math.cos(a) * l, y + Math.sin(a) * l);
        }
        ctx.stroke();
      }
      // Fallen petals: drifts under every tree plus loose ones everywhere.
      const petal = (x, y) => {
        ctx.fillStyle = rgba(R.pick(b.flowers), R.float(0.55, 0.95));
        ctx.beginPath(); ctx.ellipse(x, y, R.float(1.2, 2.4), R.float(0.8, 1.3), R.float(0, TAU), 0, TAU); ctx.fill();
      };
      for (const o of m.obstacles) {
        if (o.kind !== 'tree') continue;
        for (let k = 0; k < 70; k++) {
          const a = R.float(0, TAU), d = Math.sqrt(R.next()) * o.canopy * 1.6;
          petal(o.cx + Math.cos(a) * d + 8, o.cy + Math.sin(a) * d + 10);
        }
      }
      for (let i = 0; i < area / 1800; i++) petal(R.float(0, m.w), R.float(0, m.h));
      for (let i = 0; i < area / 30000; i++) this.bush(R.float(0, m.w), R.float(0, m.h), R.float(7, 12), '#5d8a46');
    } else if (b.id === 'autumn') {
      this.grassTufts(area / 1000);
      // Leaf litter: drifts under the trees and a scatter everywhere.
      const leaf = (x, y, s = 1) => {
        const c = R.pick(b.flowers), a = R.float(0, TAU), l = R.float(2, 3.4) * s;
        ctx.fillStyle = rgba(c, R.float(0.6, 0.95));
        ctx.beginPath(); ctx.ellipse(x, y, l, l * 0.52, a, 0, TAU); ctx.fill();
        ctx.strokeStyle = rgba(shade(c, -0.4), 0.5);
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(x - Math.cos(a) * l, y - Math.sin(a) * l); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
      };
      for (const o of m.obstacles) {
        if (o.kind !== 'tree') continue;
        for (let k = 0; k < 80; k++) {
          const a = R.float(0, TAU), d = Math.sqrt(R.next()) * o.canopy * 1.7;
          leaf(o.cx + Math.cos(a) * d + 8, o.cy + Math.sin(a) * d + 10);
        }
      }
      for (let i = 0; i < area / 1500; i++) leaf(R.float(0, m.w), R.float(0, m.h), R.float(0.8, 1.1));
      for (let i = 0; i < area / 26000; i++) this.bush(R.float(0, m.w), R.float(0, m.h), R.float(7, 12), R.pick(['#b8672a', '#8a7a34', '#a3461f']));
    } else if (b.id === 'marsh') {
      // Mud, standing water, reeds.
      for (let i = 0; i < area / 60000; i++) {
        const x = R.float(0, m.w), y = R.float(0, m.h), r = R.float(30, 80);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba('#3a2f1e', R.float(0.25, 0.45))); g.addColorStop(1, rgba('#3a2f1e', 0));
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      this.grassTufts(area / 1300);
      for (let i = 0; i < area / 9000; i++) this.reeds(R.float(0, m.w), R.float(0, m.h), R.int(4, 9));
      for (const p of m.pools) {
        for (let k = 0; k < R.int(2, 5); k++) {
          const a = R.float(0, TAU);
          this.reeds(p.x + Math.cos(a) * p.r * 0.75, p.y + Math.sin(a) * p.r * 0.5, R.int(6, 12));
        }
      }
    } else if (b.id === 'desert') {
      for (let i = 0; i < area / 9000; i++) {
        const x = R.float(0, m.w), y = R.float(0, m.h), l = R.float(20, 60), a = R.float(-0.3, 0.3) + 0.5;
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = rgba('#fff3d6', 0.22);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + l / 2, y - 6, x + l, y + Math.sin(a) * 8); ctx.stroke();
        ctx.strokeStyle = rgba('#7a5a30', 0.18);
        ctx.beginPath(); ctx.moveTo(x, y + 2.5); ctx.quadraticCurveTo(x + l / 2, y - 3.5, x + l, y + 2.5 + Math.sin(a) * 8); ctx.stroke();
      }
      for (let i = 0; i < area / 16000; i++) this.bush(R.float(0, m.w), R.float(0, m.h), R.float(5, 10), '#7d7a3e');
    } else {
      for (let i = 0; i < area / 7000; i++) {
        const x = R.float(0, m.w), y = R.float(0, m.h), r = R.float(12, 40);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      for (let i = 0; i < area / 120000; i++) {
        const x = R.float(0, m.w), y = R.float(0, m.h), rx = R.float(25, 70), ry = rx * R.float(0.4, 0.8), a = R.float(0, TAU);
        ctx.fillStyle = 'rgba(175,205,222,0.22)';
        ctx.beginPath(); ctx.ellipse(x, y, rx, ry, a, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(x - 3, y - 3, rx * 0.7, ry * 0.5, a, Math.PI * 1.1, Math.PI * 1.7); ctx.stroke();
      }
      for (let i = 0; i < area / 3000; i++) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(R.float(0, m.w), R.float(0, m.h), 1.2, 1.2);
      }
    }
    // Pebbles everywhere.
    for (let i = 0; i < area / 2600; i++) {
      const x = R.float(0, m.w), y = R.float(0, m.h), r = R.float(1, 3);
      ctx.fillStyle = rgba(shade(b.rock, R.float(-0.2, 0.2)), 0.7);
      ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.75, R.float(0, 3), 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  decal(d) {
    const ctx = this.ctx, R = this.rng, b = this.biome;
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.a);
    if (d.type === 'field') {
      // Crop field: ploughed rows in two tones with a soft edge.
      const crop = { grassland: ['#b3a756', '#8f9a4c'], cherry: ['#9fbf6a', '#7ea663'], autumn: ['#c9a24a', '#a8883a'], desert: ['#c9b27a', '#b09058'], badlands: ['#b87a4a', '#a0603a'], marsh: ['#7a8a4a', '#62703c'], snow: ['#dde6ea', '#c9d4db'] }[b.id] || ['#b3a756', '#8f9a4c'];
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = crop[1];
      roundRectPath(ctx, -d.w / 2, -d.h / 2, d.w, d.h, 10); ctx.fill();
      ctx.save();
      roundRectPath(ctx, -d.w / 2, -d.h / 2, d.w, d.h, 10); ctx.clip();
      for (let y = -d.h / 2; y < d.h / 2; y += 12) {
        ctx.fillStyle = rgba(crop[0], 0.8);
        ctx.fillRect(-d.w / 2, y, d.w, 6);
        ctx.fillStyle = rgba('#3a2e18', 0.18);
        ctx.fillRect(-d.w / 2, y + 6, d.w, 1.5);
      }
      ctx.restore();
      ctx.strokeStyle = rgba('#3a2e18', 0.3); ctx.lineWidth = 3;
      roundRectPath(ctx, -d.w / 2, -d.h / 2, d.w, d.h, 10); ctx.stroke();
    } else if (d.type === 'ice') {
      // Frozen lake: pale ice, drifted snow at the rim, cracks across the middle.
      ctx.fillStyle = 'rgba(245,249,252,0.7)';
      ctx.beginPath(); ctx.ellipse(0, 0, d.r * 1.08, d.r * 0.68, 0, 0, TAU); ctx.fill();
      const g = ctx.createRadialGradient(-d.r * 0.2, -d.r * 0.15, 5, 0, 0, d.r);
      g.addColorStop(0, '#d4e6ef'); g.addColorStop(1, '#a9c6d4');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, d.r, d.r * 0.6, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.2;
      for (let i = 0; i < 9; i++) {
        let x = R.float(-d.r * 0.6, d.r * 0.6), y = R.float(-d.r * 0.3, d.r * 0.3), a = R.float(0, TAU);
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let k = 0; k < 4; k++) { a += R.float(-0.8, 0.8); x += Math.cos(a) * R.float(12, 30); y += Math.sin(a) * R.float(12, 30); ctx.lineTo(x, y); }
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(120,150,170,0.35)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 0, d.r, d.r * 0.6, 0, 0, TAU); ctx.stroke();
    } else if (d.type === 'scorch') {
      ctx.restore();
      for (let i = 0; i < 5; i++) this.crater(d.x + R.float(-d.r, d.r) * 0.7, d.y + R.float(-d.r, d.r) * 0.7, R.float(16, 34), 0.8);
      this.scorch(d.x, d.y, d.r, 0.7);
      return;
    }
    ctx.restore();
  }

  grassTufts(n) {
    const ctx = this.ctx, m = this.map, b = this.biome, R = this.rng;
    for (let i = 0; i < n; i++) {
      const x = R.float(-40, m.w + 40), y = R.float(-40, m.h + 40);
      ctx.strokeStyle = rgba(R.pick(b.detail), R.float(0.35, 0.8));
      ctx.lineWidth = R.float(0.8, 1.4);
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = -Math.PI / 2 + R.float(-0.7, 0.7), l = R.float(3, 7);
        ctx.moveTo(x + k * 1.3, y);
        ctx.lineTo(x + k * 1.3 + Math.cos(a) * l, y + Math.sin(a) * l);
      }
      ctx.stroke();
    }
  }

  // Irregular pond (shape from the map): muddy rim, dark water, a sky reflection and lily pads.
  pool(p) {
    const ctx = this.ctx, R = this.rng, { x, y, r, blobs } = p;
    const shape = grow => { ctx.beginPath(); for (const [bx, by, rx, ry, a] of blobs) { ctx.moveTo(bx + (rx + grow) * Math.cos(a), by + (rx + grow) * Math.sin(a)); ctx.ellipse(bx, by, rx + grow, ry + grow, a, 0, TAU); } };
    ctx.save();
    ctx.fillStyle = rgba('#3d321f', 0.45); shape(9); ctx.fill();
    ctx.fillStyle = rgba('#2f2a1a', 0.5); shape(4); ctx.fill();
    const g = ctx.createRadialGradient(x - r * 0.2, y - r * 0.15, r * 0.1, x, y, r);
    g.addColorStop(0, '#4d6f6a'); g.addColorStop(0.7, '#36524d'); g.addColorStop(1, '#2b3f38');
    ctx.fillStyle = g; shape(0); ctx.fill();
    ctx.clip();
    ctx.strokeStyle = 'rgba(210,228,222,0.22)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      const yy = y - r * 0.3 + i * r * 0.18;
      ctx.beginPath(); ctx.moveTo(x - r * 0.5 + R.float(-6, 6), yy); ctx.lineTo(x + r * 0.1 + R.float(-6, 6), yy - 3); ctx.stroke();
    }
    for (let i = 0; i < R.int(2, 6); i++) {
      const px = x + R.float(-r, r) * 0.5, py = y + R.float(-r, r) * 0.3, pr = R.float(3, 6), a = R.float(0, TAU);
      ctx.fillStyle = R.chance(0.5) ? '#5f8a3e' : '#7aa24a';
      ctx.beginPath(); ctx.moveTo(px, py); ctx.arc(px, py, pr, a + 0.4, a + TAU - 0.1); ctx.closePath(); ctx.fill();
      if (R.chance(0.3)) { ctx.fillStyle = '#f2e8f0'; ctx.beginPath(); ctx.arc(px + 1, py - 1, 1.3, 0, TAU); ctx.fill(); }
    }
    ctx.restore();
  }

  // Timber planks wherever a road runs over water.
  paintBridges() {
    const ctx = this.ctx, m = this.map;
    ctx.save();
    for (const pts of m.roads) {
      const samples = [];
      let from = pts[0];
      const seg = (a, c, b) => {
        const n = Math.max(2, Math.ceil((dist(a.x, a.y, c.x, c.y) + dist(c.x, c.y, b.x, b.y)) / 9));
        for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; samples.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }); }
      };
      for (let i = 1; i < pts.length - 1; i++) { const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }; seg(from, pts[i], mid); from = mid; }
      const last = pts[pts.length - 1];
      seg(from, { x: (from.x + last.x) / 2, y: (from.y + last.y) / 2 }, last);
      for (let i = 1; i < samples.length; i++) {
        const p = samples[i], q = samples[i - 1];
        if (!m.inPool(p.x, p.y) && !m.inPool(q.x, q.y)) continue;
        const a = Math.atan2(p.y - q.y, p.x - q.x);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(a);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(-4, -32, 9, 66);
        ctx.fillStyle = shade('#7a5a36', (i % 3 - 1) * 0.08);
        ctx.fillRect(-4.5, -30, 8, 60);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(3, -30, 1, 60);
        ctx.fillStyle = '#4a3622';
        ctx.fillRect(-4.5, -31, 9, 2.5); ctx.fillRect(-4.5, 28.5, 9, 2.5);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // A clump of reeds and bulrushes (seen from above: fanned blades, brown heads).
  reeds(x, y, n) {
    const ctx = this.ctx, R = this.rng, b = this.biome;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + R.float(-0.9, 0.9), l = R.float(6, 12);
      const bx = x + R.float(-4, 4), by = y + R.float(-2, 2);
      ctx.strokeStyle = rgba(R.pick(b.detail), R.float(0.6, 0.95));
      ctx.lineWidth = R.float(0.8, 1.3);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a) * l, by + Math.sin(a) * l); ctx.stroke();
      if (R.chance(0.3)) {
        ctx.strokeStyle = '#5a3d22';
        ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(bx + Math.cos(a) * l * 0.75, by + Math.sin(a) * l * 0.75); ctx.lineTo(bx + Math.cos(a) * l, by + Math.sin(a) * l); ctx.stroke();
      }
    }
    ctx.restore();
  }

  bush(x, y, r, col) {
    const ctx = this.ctx, R = this.rng, b = this.biome;
    const c = col || b.tree[1];
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(x + 3, y + 4, r, r * 0.8, 0, 0, TAU); ctx.fill();
    for (let i = 0; i < 5; i++) {
      const a = R.float(0, TAU), d = R.float(0, r * 0.5), rr = r * R.float(0.45, 0.7);
      const g = ctx.createRadialGradient(x + Math.cos(a) * d - rr * 0.3, y + Math.sin(a) * d - rr * 0.3, 0, x + Math.cos(a) * d, y + Math.sin(a) * d, rr);
      g.addColorStop(0, shade(c, 0.25)); g.addColorStop(1, shade(c, -0.2));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, rr, 0, TAU); ctx.fill();
    }
  }

  crater(x, y, r, alpha = 1) {
    const ctx = this.ctx, b = this.biome;
    ctx.save();
    ctx.globalAlpha = alpha;
    let g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.6);
    g.addColorStop(0, rgba(b.scorch, 0.55));
    g.addColorStop(0.5, rgba(b.scorch, 0.25));
    g.addColorStop(1, rgba(b.scorch, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, TAU); ctx.fill();
    g = ctx.createRadialGradient(x - r * 0.2, y - r * 0.2, r * 0.2, x, y, r);
    g.addColorStop(0, rgba('#000000', 0.35));
    g.addColorStop(0.8, rgba(b.dirtDark, 0.45));
    g.addColorStop(1, rgba(b.dirt, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba('#ffffff', 0.12);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, r * 0.95, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke();
    ctx.restore();
  }

  paintPads() {
    const ctx = this.ctx, m = this.map, b = this.biome;
    const pad = (cx, cy, w, h) => {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(cx - w / 2 + 3, cy - h / 2 + 4, w, h);
      ctx.fillStyle = shade(b.concrete, -0.05);
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.strokeStyle = rgba('#000000', 0.12);
      ctx.lineWidth = 1;
      for (let x = cx - w / 2 + 32; x < cx + w / 2; x += 32) { ctx.beginPath(); ctx.moveTo(x, cy - h / 2); ctx.lineTo(x, cy + h / 2); ctx.stroke(); }
      for (let y = cy - h / 2 + 32; y < cy + h / 2; y += 32) { ctx.beginPath(); ctx.moveTo(cx - w / 2, y); ctx.lineTo(cx + w / 2, y); ctx.stroke(); }
      for (let i = 0; i < w * h / 400; i++) {
        ctx.fillStyle = rgba('#000000', this.rng.float(0.03, 0.08));
        ctx.fillRect(cx - w / 2 + this.rng.float(0, w), cy - h / 2 + this.rng.float(0, h), 2, 2);
      }
      ctx.strokeStyle = rgba('#000000', 0.3);
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      ctx.restore();
    };
    if (m.layout === 'teams') {
      for (const cs of m.spawnCenters) for (const c of cs) pad(c.x + (c.x < m.w / 2 ? 20 : -20), c.y, 300, 330);
      if (m.mode === 'ctf') for (const bse of m.bases) pad(bse.x, bse.y, 120, 120);
    }
    if (m.hill) {
      const h = m.hill;
      const g = ctx.createRadialGradient(h.x, h.y, h.r * 0.2, h.x, h.y, h.r * 1.15);
      g.addColorStop(0, rgba(b.dirt, 0.5));
      g.addColorStop(0.85, rgba(b.dirt, 0.35));
      g.addColorStop(1, rgba(b.dirt, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r * 1.15, 0, TAU); ctx.fill();
      ctx.save();
      ctx.strokeStyle = rgba(b.concrete, 0.8);
      ctx.lineWidth = 16;
      ctx.beginPath(); ctx.arc(h.x, h.y, 34, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }

  paintShadows() {
    const ctx = this.ctx;
    ctx.save();
    for (const o of this.map.obstacles) {
      if (o.kind === 'tree') {
        const off = o.canopy * 0.35;
        const g = ctx.createRadialGradient(o.cx + off, o.cy + off * 1.2, 0, o.cx + off, o.cy + off * 1.2, o.canopy * 1.05);
        g.addColorStop(0, 'rgba(0,0,0,0.32)');
        g.addColorStop(0.7, 'rgba(0,0,0,0.22)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(o.cx + off, o.cy + off * 1.2, o.canopy * 1.05, 0, TAU); ctx.fill();
        continue;
      }
      const d = o.height * 0.7;
      const ox = LIGHT.x * d, oy = LIGHT.y * d;
      ctx.save();
      ctx.globalAlpha = 0.34;
      softShadow(ctx, 7 * this.scale, 'rgba(0,0,0,1)', c => {
        if (o.shape === 'rect') {
          c.beginPath();
          c.moveTo(o.x, o.y); c.lineTo(o.x + o.w, o.y); c.lineTo(o.x + o.w + ox, o.y + oy);
          c.lineTo(o.x + o.w + ox, o.y + o.h + oy); c.lineTo(o.x + ox, o.y + o.h + oy); c.lineTo(o.x, o.y + o.h);
          c.closePath();
          c.fill();
        } else {
          c.beginPath(); c.arc(o.cx, o.cy, o.r, 0, TAU); c.fill();
          c.beginPath(); c.arc(o.cx + ox, o.cy + oy, o.r * 0.95, 0, TAU); c.fill();
          c.lineWidth = o.r * 1.9;
          c.beginPath(); c.moveTo(o.cx, o.cy); c.lineTo(o.cx + ox, o.cy + oy); c.stroke();
        }
      });
      ctx.restore();
    }
    ctx.restore();
  }

  paintBorder() {
    const ctx = this.ctx, m = this.map, b = this.biome, P = TERRAIN_PAD;
    ctx.save();
    ctx.fillStyle = rgba(b.border, 0.62);
    ctx.beginPath();
    ctx.rect(-P, -P, m.w + P * 2, m.h + P * 2);
    ctx.rect(0, 0, m.w, m.h);
    ctx.fill('evenodd');
    // Soft inner falloff at the edge of the playable area.
    const edge = 60;
    const sides = [
      [0, 0, m.w, edge, 0, 0, 0, edge], [0, m.h - edge, m.w, edge, 0, m.h, 0, m.h - edge],
      [0, 0, edge, m.h, 0, 0, edge, 0], [m.w - edge, 0, edge, m.h, m.w, 0, m.w - edge, 0],
    ];
    for (const [x, y, w, h, gx0, gy0, gx1, gy1] of sides) {
      const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
      g.addColorStop(0, rgba(b.border, 0.35)); g.addColorStop(1, rgba(b.border, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    }
    // Row of anti-tank hedgehogs just outside the boundary.
    const hedgehog = (x, y, a) => {
      ctx.save();
      ctx.translate(x, y); ctx.rotate(a);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-9 + 4, -2 + 5, 18, 4); ctx.fillRect(-2 + 4, -9 + 5, 4, 18);
      ctx.fillStyle = '#4a4744';
      ctx.fillRect(-9, -2, 18, 4); ctx.fillRect(-2, -9, 4, 18);
      ctx.fillStyle = '#6d6862';
      ctx.fillRect(-9, -2, 18, 1.4); ctx.fillRect(-2, -9, 1.4, 18);
      ctx.restore();
    };
    const R = this.rng;
    for (let x = -20; x <= m.w + 20; x += 46) { hedgehog(x, -22, R.float(0, 1)); hedgehog(x, m.h + 22, R.float(0, 1)); }
    for (let y = 20; y <= m.h - 20; y += 46) { hedgehog(-22, y, R.float(0, 1)); hedgehog(m.w + 22, y, R.float(0, 1)); }
    ctx.restore();
  }

  // ---- runtime decals --------------------------------------------------------------
  // Tread marks; each running gear leaves its own pattern.
  track(x, y, angle, alpha, kind = 'tracks', scale = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    ctx.fillStyle = this.biome.id === 'snow' ? `rgba(90,105,120,${alpha * 1.4})` : this.biome.id === 'marsh' ? `rgba(34,26,12,${alpha * 1.5})` : `rgba(40,30,15,${alpha})`;
    if (kind === 'halftrack') {
      ctx.fillRect(-2, -19, 4, 7);
      ctx.fillRect(-2, 12, 4, 7);
    } else if (kind === 'christie') {
      ctx.fillRect(-1.5, -21, 3, 9);
      ctx.fillRect(-1.5, 12, 3, 9);
      ctx.fillRect(-3, -17.5, 1.5, 2);
      ctx.fillRect(-3, 15.5, 1.5, 2);
    } else if (kind === 'rover') {
      ctx.fillRect(-2.5, -19, 5, 3);
      ctx.fillRect(-2.5, 16, 5, 3);
    } else if (kind === 'quad') {
      for (const y of [-26, -18.5, 12.5, 20]) ctx.fillRect(-2, y, 4, 6);
    } else if (kind === 'convoy') {
      ctx.fillRect(-3, -20, 6, 5);
      ctx.fillRect(-3, 15, 6, 5);
    } else {
      ctx.fillRect(-2, -20, 4, 8);
      ctx.fillRect(-2, 12, 4, 8);
    }
    ctx.restore();
  }

  scorch(x, y, r, strength = 1) {
    const ctx = this.ctx, b = this.biome;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(b.scorch, 0.4 * strength));
    g.addColorStop(0.55, rgba(b.scorch, 0.16 * strength));
    g.addColorStop(1, rgba(b.scorch, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    for (let i = 0; i < (strength < 0.6 ? 0 : 7); i++) {
      const a = rand(0, TAU), l = r * rand(0.7, 1.3);
      ctx.strokeStyle = rgba(b.scorch, 0.14 * strength);
      ctx.lineWidth = rand(1, 3);
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
    }
  }
}

// Tileable drifting cloud shadows.
function makeCloudTexture(seed) {
  const S = 512;
  const c = makeCanvas(S, S), ctx = c.getContext('2d');
  const R = new RNG(seed);
  for (let i = 0; i < 26; i++) {
    const x = R.float(0, S), y = R.float(0, S), r = R.float(40, 120);
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      g.addColorStop(0, 'rgba(0,0,0,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
    }
  }
  return c;
}
