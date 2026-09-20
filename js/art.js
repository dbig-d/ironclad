'use strict';
// ---------------------------------------------------------------------------
// Procedural sprite art. Everything is drawn once into offscreen canvases at
// SPRITE_SCALE and then blitted every frame.
// ---------------------------------------------------------------------------

const SPRITE_SCALE = 2;
const LIGHT = { x: 0.62, y: 0.78 }; // shadow direction (light from top-left)

// Draws a soft silhouette by rendering the shape off-canvas and keeping only
// its blurred shadow. Works in every browser (no ctx.filter needed).
function softShadow(ctx, blur, color, drawShape) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 10000;
  ctx.translate(-10000 / (ctx.getTransform().a || 1), 0);
  ctx.fillStyle = '#000';
  drawShape(ctx);
  ctx.restore();
}

function spriteCanvas(w, h) {
  const c = makeCanvas(w * SPRITE_SCALE, h * SPRITE_SCALE);
  const ctx = c.getContext('2d');
  ctx.scale(SPRITE_SCALE, SPRITE_SCALE);
  return { c, ctx };
}

// ---- Tanks ------------------------------------------------------------------------
const HULL_W = 66, HULL_H = 54;       // sprite box (world units), centered
const TURRET_W = 44, TURRET_H = 36;
const BARREL_W = 44, BARREL_H = 14;

function hullPath(ctx) {
  // Top-down hull between the tracks, nose pointing +x.
  ctx.beginPath();
  ctx.moveTo(-25, -12);
  ctx.lineTo(19, -12);
  ctx.lineTo(26, -8);
  ctx.lineTo(26, 8);
  ctx.lineTo(19, 12);
  ctx.lineTo(-25, 12);
  ctx.quadraticCurveTo(-27, 12, -27, 10);
  ctx.lineTo(-27, -10);
  ctx.quadraticCurveTo(-27, -12, -25, -12);
  ctx.closePath();
}

function turretPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(-13, -8);
  ctx.quadraticCurveTo(-14, -12, -9, -12.5);
  ctx.lineTo(5, -11.5);
  ctx.quadraticCurveTo(12, -10, 13, -5);
  ctx.lineTo(13, 5);
  ctx.quadraticCurveTo(12, 10, 5, 11.5);
  ctx.lineTo(-9, 12.5);
  ctx.quadraticCurveTo(-14, 12, -13, 8);
  ctx.closePath();
}

function camo(ctx, rng, color, count, spread, clipPath) {
  ctx.save();
  clipPath(ctx);
  ctx.clip();
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = i % 2 ? rgba(color.camo, 0.55) : rgba(shade(color.main, 0.12), 0.35);
    ctx.beginPath();
    const x = rng.float(-spread, spread), y = rng.float(-spread * 0.5, spread * 0.5);
    const n = rng.int(5, 8), r = rng.float(4, 9);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU, rr = r * rng.float(0.6, 1.3);
      k ? ctx.lineTo(x + Math.cos(a) * rr * 1.4, y + Math.sin(a) * rr) : ctx.moveTo(x + Math.cos(a) * rr * 1.4, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function makeHullSprite(color, charred, variant = 'standard') {
  const { c, ctx } = spriteCanvas(HULL_W, HULL_H);
  ctx.translate(HULL_W / 2, HULL_H / 2);
  const rng = new RNG(hexToRgb(color.main).reduce((a, b) => a * 31 + b, 7));

  // Fenders over the tracks.
  for (const s of [-1, 1]) {
    ctx.fillStyle = shade(color.dark, -0.1);
    roundRectPath(ctx, -28, s < 0 ? -15.5 : 11.5, 56, 4, 1.5);
    ctx.fill();
    ctx.fillStyle = rgba(color.light, 0.22);
    ctx.fillRect(-27, s < 0 ? -15.5 : 11.5, 54, 1);
  }

  const g = ctx.createLinearGradient(-20, -14, 14, 16);
  g.addColorStop(0, shade(color.main, 0.22));
  g.addColorStop(0.55, color.main);
  g.addColorStop(1, shade(color.main, -0.28));
  ctx.fillStyle = g;
  hullPath(ctx);
  ctx.fill();
  if (!charred) camo(ctx, rng, color, 9, 24, hullPath);

  // Glacis plate and panel lines.
  ctx.strokeStyle = rgba(shade(color.dark, -0.3), 0.55);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(15, -12); ctx.lineTo(15, 12);
  ctx.moveTo(-14, -12); ctx.lineTo(-14, 12);
  ctx.stroke();
  ctx.fillStyle = rgba(color.light, 0.22);
  ctx.beginPath();
  ctx.moveTo(15, -12); ctx.lineTo(19, -12); ctx.lineTo(26, -8); ctx.lineTo(26, 8); ctx.lineTo(22, 8); ctx.lineTo(22, -7); ctx.closePath();
  ctx.fill();

  // Engine deck grille.
  ctx.fillStyle = rgba('#000000', 0.28);
  roundRectPath(ctx, -25, -8, 9, 16, 1.5);
  ctx.fill();
  ctx.strokeStyle = rgba(color.light, 0.25);
  ctx.lineWidth = 0.7;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(-24 + i * 1.8, -7); ctx.lineTo(-24 + i * 1.8, 7);
    ctx.stroke();
  }
  // Exhausts, tail lights, headlights, tow hooks.
  ctx.fillStyle = '#2b2622';
  ctx.fillRect(-28, -6, 2, 3); ctx.fillRect(-28, 3, 2, 3);
  ctx.fillStyle = charred ? '#3a2a22' : '#ff5a3c';
  ctx.fillRect(-27.4, -11, 1.6, 2.4); ctx.fillRect(-27.4, 8.6, 1.6, 2.4);
  ctx.fillStyle = charred ? '#444' : '#fff6cf';
  ctx.beginPath(); ctx.arc(24.5, -7.6, 1.3, 0, TAU); ctx.arc(24.5, 7.6, 1.3, 0, TAU); ctx.fill();
  // Stowage boxes on the fenders (stripped off the Featherweight).
  if (variant !== 'feather') {
    ctx.fillStyle = shade(color.dark, 0.1);
    ctx.fillRect(-10, -12, 10, 3);
    ctx.fillRect(2, 9, 8, 3);
  }
  drawHullVariant(ctx, color, variant, rng);

  // Rim light + outline.
  ctx.strokeStyle = rgba('#000000', 0.55);
  ctx.lineWidth = 1;
  hullPath(ctx);
  ctx.stroke();
  ctx.strokeStyle = rgba(color.light, 0.45);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-25, -11.3); ctx.lineTo(19, -11.3);
  ctx.stroke();

  if (charred) charOverlay(ctx, rng, HULL_W, HULL_H);
  return c;
}

// Hull parts: armor skirts, lightening cut-outs or reactive armor tiles.
function drawHullVariant(ctx, color, variant, rng) {
  if (variant === 'big') {
    for (const s of [-1, 1]) {
      const y = s < 0 ? -17 : 12.5;
      const g = ctx.createLinearGradient(0, y, 0, y + 4.5);
      g.addColorStop(0, shade(color.main, 0.15)); g.addColorStop(1, shade(color.dark, -0.2));
      ctx.fillStyle = g;
      roundRectPath(ctx, -29, y, 58, 4.5, 1.2);
      ctx.fill();
      ctx.fillStyle = rgba('#000000', 0.45);
      for (let x = -26; x <= 26; x += 6.5) { ctx.beginPath(); ctx.arc(x, y + 2.25, 0.7, 0, TAU); ctx.fill(); }
    }
    // Thick bolted glacis slab and a rear armor box.
    ctx.fillStyle = shade(color.main, -0.12);
    ctx.beginPath(); ctx.moveTo(17, -11); ctx.lineTo(24, -7); ctx.lineTo(24, 7); ctx.lineTo(17, 11); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = rgba('#000000', 0.45); ctx.lineWidth = 0.8; ctx.stroke();
    ctx.fillStyle = rgba(color.light, 0.35);
    for (const y of [-6, 0, 6]) { ctx.beginPath(); ctx.arc(21, y, 0.8, 0, TAU); ctx.fill(); }
    ctx.fillStyle = shade(color.dark, 0.05);
    roundRectPath(ctx, -15, -10, 7, 20, 1.2); ctx.fill();
  } else if (variant === 'feather') {
    // Lightening holes and a racing stripe.
    ctx.fillStyle = rgba('#000000', 0.38);
    for (const s of [-1, 1]) for (let x = -8; x <= 10; x += 6) { roundRectPath(ctx, x, s * 7.5 - 1.5, 4, 3, 1.5); ctx.fill(); }
    ctx.fillStyle = rgba(color.light, 0.45);
    ctx.fillRect(-26, -1.2, 44, 2.4);
  } else if (variant === 'era') {
    // Rows of reactive armor bricks over the glacis and sides.
    const brick = (x, y, w, h) => {
      ctx.fillStyle = shade(color.camo, rng.float(-0.1, 0.1));
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = rgba('#ffffff', 0.2); ctx.fillRect(x, y, w, 0.8);
      ctx.fillStyle = rgba('#000000', 0.35); ctx.fillRect(x, y + h - 0.8, w, 0.8); ctx.fillRect(x + w - 0.6, y, 0.6, h);
    };
    for (let y = -10; y <= 6; y += 4.2) brick(18.5, y, 4.2, 3.6);
    for (const s of [-1, 1]) for (let x = -24; x < 16; x += 5.2) brick(x, s < 0 ? -12.2 : 9.4, 4.6, 2.8);
  } else if (variant === 'sloped') {
    // Wedge glacis: two angled plates meeting in a ridge at the nose, one
    // catching the light, one in shade.
    ctx.fillStyle = shade(color.main, 0.2);
    ctx.beginPath(); ctx.moveTo(6, -12); ctx.lineTo(19, -12); ctx.lineTo(26.5, -1); ctx.lineTo(26.5, 0); ctx.lineTo(9, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = shade(color.main, -0.22);
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(26.5, 0); ctx.lineTo(26.5, 1); ctx.lineTo(19, 12); ctx.lineTo(6, 12); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = rgba(color.light, 0.6); ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(26.5, 0); ctx.stroke();
    ctx.strokeStyle = rgba('#000000', 0.4); ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.moveTo(6, -12); ctx.lineTo(9, 0); ctx.lineTo(6, 12); ctx.stroke();
    // Angled side plates with welded seams.
    for (const s of [-1, 1]) {
      const y0 = s * 12, y1 = s * 8.6;
      ctx.fillStyle = s < 0 ? shade(color.main, 0.1) : shade(color.main, -0.15);
      ctx.beginPath(); ctx.moveTo(-26, y0); ctx.lineTo(6, y0); ctx.lineTo(3, y1); ctx.lineTo(-23, y1); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = rgba('#000000', 0.35); ctx.lineWidth = 0.6;
      for (let x = -18; x < 4; x += 7) { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x - 1.5, y1); ctx.stroke(); }
    }
  } else if (variant === 'dozer') {
    // Push arms and hydraulic rams holding a curved steel blade out front.
    ctx.fillStyle = '#34312d';
    ctx.fillRect(14, -16.5, 15, 3.2); ctx.fillRect(14, 13.3, 15, 3.2);
    ctx.fillStyle = '#9c978c';
    ctx.fillRect(12, -8.6, 15, 1.8); ctx.fillRect(12, 6.8, 15, 1.8);
    ctx.fillStyle = '#4a4640';
    ctx.fillRect(12, -9.4, 6, 3.4); ctx.fillRect(12, 6, 6, 3.4);
    const g = ctx.createLinearGradient(27, 0, 33, 0);
    g.addColorStop(0, shade(color.dark, 0.3)); g.addColorStop(0.55, shade(color.dark, -0.05)); g.addColorStop(1, shade(color.dark, -0.45));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(27.5, -23); ctx.quadraticCurveTo(31.5, -23.5, 32.8, -21);
    ctx.lineTo(32.8, 21); ctx.quadraticCurveTo(31.5, 23.5, 27.5, 23);
    ctx.quadraticCurveTo(30, 0, 27.5, -23);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = rgba('#000000', 0.55); ctx.lineWidth = 0.8; ctx.stroke();
    // Worn cutting edge and a hazard-striped top lip.
    ctx.fillStyle = '#c9c4b8';
    ctx.fillRect(32, -20.5, 0.9, 41);
    ctx.save();
    ctx.beginPath(); ctx.rect(27.8, -22, 1.6, 44); ctx.clip();
    for (let y = -24; y < 24; y += 4) { ctx.fillStyle = (Math.round(y / 4) % 2) ? '#e0a82e' : '#1d1c1a'; ctx.fillRect(27.8, y, 1.6, 4); }
    ctx.restore();
    ctx.fillStyle = rgba('#000000', 0.3);
    for (const y of [-14, -4, 6, 16]) ctx.fillRect(30.5, y, 1.2, 1.2);
  } else if (variant === 'skirts') {
    // Schürzen: thin spaced plates hung off rails outside the tracks, one of them knocked askew.
    for (const s of [-1, 1]) {
      const y = s < 0 ? -25.5 : 22;
      ctx.fillStyle = '#2d2a26';
      ctx.fillRect(-27, s < 0 ? -22.4 : 21.4, 54, 1);
      for (let i = 0; i < 5; i++) {
        const x = -29 + i * 11.8, skew = (s > 0 && i === 3) ? 0.9 : 0;
        const g = ctx.createLinearGradient(0, y, 0, y + 3.5);
        g.addColorStop(0, shade(color.main, s < 0 ? 0.18 : 0.02)); g.addColorStop(1, shade(color.dark, -0.15));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(x, y + skew); ctx.lineTo(x + 11.2, y); ctx.lineTo(x + 11.2, y + 3.5); ctx.lineTo(x, y + 3.5 + skew); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = rgba('#000000', 0.45); ctx.lineWidth = 0.6; ctx.stroke();
        ctx.fillStyle = rgba(color.light, 0.3);
        ctx.fillRect(x + 0.4, y + 0.3 + skew * 0.5, 10.4, 0.6);
        ctx.fillStyle = rgba('#000000', 0.5);
        ctx.beginPath(); ctx.arc(x + 5.6, y + 1.7, 0.55, 0, TAU); ctx.fill();
      }
      // A little rust and chipped paint on the plates.
      for (let k = 0; k < 4; k++) {
        ctx.fillStyle = rgba(rng.chance(0.5) ? '#6b3b22' : '#1e1c19', 0.35);
        ctx.fillRect(rng.float(-28, 26), y + rng.float(0.5, 2.5), rng.float(1, 2.5), 0.8);
      }
    }
  } else if (variant === 'fuel') {
    // Two 200-litre drums on a rack across the back deck, strapped down.
    ctx.fillStyle = '#2b2824';
    ctx.fillRect(-33, -11.5, 8, 1.2); ctx.fillRect(-33, 10.3, 8, 1.2);
    ctx.fillRect(-26, -11.5, 1.4, 23);
    for (const y of [-10.8, 0.4]) {
      const g = ctx.createLinearGradient(-33, 0, -25.5, 0);
      g.addColorStop(0, '#3c4028'); g.addColorStop(0.35, '#7d8352'); g.addColorStop(0.6, '#5b6139'); g.addColorStop(1, '#2d301d');
      ctx.fillStyle = g;
      roundRectPath(ctx, -33.2, y, 7.6, 10.4, 1.4); ctx.fill();
      ctx.strokeStyle = rgba('#000000', 0.5); ctx.lineWidth = 0.6; ctx.stroke();
      ctx.fillStyle = rgba('#000000', 0.35);
      ctx.fillRect(-33.2, y + 3.2, 7.6, 0.7); ctx.fillRect(-33.2, y + 6.6, 7.6, 0.7);
      ctx.fillStyle = '#c9c1a4';
      ctx.fillRect(-30, y + 0.4, 1.4, 0.9);
      ctx.fillStyle = '#b8402f';
      ctx.fillRect(-32.6, y + 4.5, 1.1, 1.4);
    }
    ctx.strokeStyle = '#1d1b18'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(-29.4, -11.5); ctx.lineTo(-29.4, 11.5); ctx.stroke();
    // Fuel line into the engine deck.
    ctx.strokeStyle = '#2a2723'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-25.6, -1); ctx.quadraticCurveTo(-22, -1.5, -20, 0); ctx.stroke();
  }
}

function makeTurretSprite(color, charred) {
  const { c, ctx } = spriteCanvas(TURRET_W, TURRET_H);
  ctx.translate(TURRET_W / 2 - 4, TURRET_H / 2);
  const rng = new RNG(hexToRgb(color.main).reduce((a, b) => a * 17 + b, 3));

  const g = ctx.createRadialGradient(-5, -6, 2, 0, 0, 17);
  g.addColorStop(0, shade(color.main, 0.3));
  g.addColorStop(0.6, color.main);
  g.addColorStop(1, shade(color.main, -0.3));
  ctx.fillStyle = g;
  turretPath(ctx);
  ctx.fill();
  if (!charred) camo(ctx, rng, color, 5, 12, turretPath);

  // Mantlet.
  ctx.fillStyle = shade(color.dark, 0.05);
  roundRectPath(ctx, 9, -5.5, 6, 11, 2);
  ctx.fill();
  // Commander's cupola.
  ctx.fillStyle = shade(color.main, -0.18);
  ctx.beginPath(); ctx.arc(-4, -4.5, 4.6, 0, TAU); ctx.fill();
  ctx.fillStyle = shade(color.main, 0.12);
  ctx.beginPath(); ctx.arc(-4.4, -5, 3.2, 0, TAU); ctx.fill();
  ctx.strokeStyle = rgba('#000000', 0.4);
  ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.arc(-4, -4.5, 4.6, 0, TAU); ctx.stroke();
  // Loader hatch + periscope.
  ctx.fillStyle = rgba('#000000', 0.22);
  ctx.beginPath(); ctx.arc(-3, 5.5, 3, 0, TAU); ctx.fill();
  ctx.fillStyle = charred ? '#222' : '#9fd6ff';
  ctx.fillRect(3, -8.5, 3, 1.4);
  // Antenna.
  ctx.strokeStyle = rgba('#111111', 0.7);
  ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.moveTo(-10, 8); ctx.lineTo(-17, 13); ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(-10, 8, 1, 0, TAU); ctx.fill();

  ctx.strokeStyle = rgba('#000000', 0.6);
  ctx.lineWidth = 1;
  turretPath(ctx);
  ctx.stroke();
  ctx.strokeStyle = rgba(color.light, 0.5);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-12, -9); ctx.quadraticCurveTo(-12, -12, -8, -12); ctx.lineTo(5, -11);
  ctx.stroke();

  if (charred) charOverlay(ctx, rng, TURRET_W, TURRET_H);
  return c;
}

// Long gun: a slimmer, much longer high-velocity barrel with a double-baffle brake.
const LONG_W = 60;
function makeLongBarrelSprite(color) {
  const { c, ctx } = spriteCanvas(LONG_W, BARREL_H);
  ctx.translate(0, BARREL_H / 2);
  const g = ctx.createLinearGradient(0, -2.4, 0, 2.4);
  g.addColorStop(0, shade(color.dark, 0.4)); g.addColorStop(0.45, shade(color.dark, 0.05)); g.addColorStop(1, shade(color.dark, -0.5));
  ctx.fillStyle = g;
  ctx.fillRect(10, -2.1, 40, 4.2);
  ctx.fillRect(10, -2.8, 9, 5.6);           // thick breech end
  ctx.fillRect(27, -3.1, 6, 6.2);           // fume extractor
  ctx.fillStyle = shade(color.dark, -0.25);
  roundRectPath(ctx, 48, -3.9, 4, 7.8, 1); ctx.fill();
  roundRectPath(ctx, 53, -3.9, 4, 7.8, 1); ctx.fill();
  ctx.fillRect(51, -2.3, 3, 4.6);
  ctx.fillStyle = '#111';
  ctx.fillRect(56.3, -1.2, 1.1, 2.4);
  ctx.strokeStyle = rgba('#000000', 0.55);
  ctx.lineWidth = 0.7;
  ctx.strokeRect(10, -2.1, 38, 4.2);
  ctx.fillStyle = rgba('#ffffff', 0.2);
  ctx.fillRect(10, -1.7, 38, 0.9);
  // Thermal sleeve bands.
  ctx.fillStyle = rgba('#000000', 0.3);
  for (const x of [21, 36, 43]) ctx.fillRect(x, -2.3, 1, 4.6);
  return c;
}

function makeBarrelSprite(color, charred) {
  const { c, ctx } = spriteCanvas(BARREL_W, BARREL_H);
  ctx.translate(0, BARREL_H / 2);
  // Barrel spans x = 8..40 in turret space; the sprite origin is turret center.
  const g = ctx.createLinearGradient(0, -3, 0, 3);
  g.addColorStop(0, shade(color.dark, 0.35));
  g.addColorStop(0.45, shade(color.dark, 0.05));
  g.addColorStop(1, shade(color.dark, -0.45));
  ctx.fillStyle = g;
  ctx.fillRect(10, -2.6, 25, 5.2);
  // Fume extractor bulge.
  ctx.fillRect(20, -3.4, 6, 6.8);
  // Muzzle brake.
  ctx.fillStyle = shade(color.dark, -0.2);
  roundRectPath(ctx, 33, -3.8, 6, 7.6, 1);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.fillRect(38.2, -1.3, 1.2, 2.6);
  ctx.strokeStyle = rgba('#000000', 0.55);
  ctx.lineWidth = 0.8;
  ctx.strokeRect(10, -2.6, 25, 5.2);
  ctx.fillStyle = rgba('#ffffff', charred ? 0.05 : 0.18);
  ctx.fillRect(10, -2, 23, 1);
  return c;
}

// HESH gun: a short, fat demolition barrel.
function makeStubBarrelSprite(color) {
  const { c, ctx } = spriteCanvas(BARREL_W, BARREL_H);
  ctx.translate(0, BARREL_H / 2);
  const g = ctx.createLinearGradient(0, -4.6, 0, 4.6);
  g.addColorStop(0, shade(color.dark, 0.4)); g.addColorStop(0.45, shade(color.dark, 0.05)); g.addColorStop(1, shade(color.dark, -0.5));
  ctx.fillStyle = g;
  ctx.fillRect(10, -3.8, 18, 7.6);
  roundRectPath(ctx, 26, -4.8, 6.5, 9.6, 1.6); ctx.fill();
  ctx.fillStyle = rgba('#000000', 0.35);
  ctx.fillRect(18, -3.9, 1.1, 7.8);
  ctx.fillStyle = '#0e0e0d';
  ctx.beginPath(); ctx.ellipse(32.4, 0, 1.2, 3.3, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = rgba('#000000', 0.55); ctx.lineWidth = 0.8;
  ctx.strokeRect(10, -3.8, 16, 7.6);
  ctx.fillStyle = rgba('#ffffff', 0.2);
  ctx.fillRect(10, -3, 16, 1.1);
  return c;
}

// Wire-guided missile launch rail with a wire spool at the back (origin: turret centre).
function makeRailSprite(color) {
  const { c, ctx } = spriteCanvas(BARREL_W, BARREL_H + 4);
  ctx.translate(0, (BARREL_H + 4) / 2);
  ctx.fillStyle = shade(color.dark, -0.1);
  ctx.fillRect(4, -1.5, 30, 3);
  ctx.fillStyle = shade(color.dark, 0.25);
  ctx.fillRect(4, -1.5, 30, 0.9);
  ctx.fillStyle = '#26241f';
  for (const x of [9, 20, 31]) ctx.fillRect(x, -3.2, 1.6, 6.4);
  // Guidance box and periscope sight.
  const g = ctx.createLinearGradient(0, -6, 0, 0);
  g.addColorStop(0, shade(color.dark, 0.35)); g.addColorStop(1, shade(color.dark, -0.3));
  ctx.fillStyle = g;
  roundRectPath(ctx, 6, -8.4, 8, 5, 1); ctx.fill();
  ctx.fillStyle = '#9fd6ff';
  ctx.fillRect(13.2, -7.8, 1, 3.6);
  ctx.fillStyle = '#34312c';
  ctx.beginPath(); ctx.arc(8, 5.6, 2.6, 0, TAU); ctx.fill();
  ctx.fillStyle = '#b87333';
  ctx.beginPath(); ctx.arc(8, 5.6, 1.5, 0, TAU); ctx.fill();
  return c;
}

// Burnt paint + soot overlay for wrecks.
function charOverlay(ctx, rng, w, h) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 16; i++) {
    const x = rng.float(-w / 2, w / 2), y = rng.float(-h / 2, h / 2), r = rng.float(3, 10);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = `rgba(140,70,30,${rng.float(0.15, 0.35)})`;
    ctx.beginPath(); ctx.arc(rng.float(-w / 3, w / 3), rng.float(-h / 3, h / 3), rng.float(1, 3), 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function makeShadowSprite(w, h, drawShape, blur) {
  const pad = 8;
  const { c, ctx } = spriteCanvas(w + pad * 2, h + pad * 2);
  ctx.translate(w / 2 + pad, h / 2 + pad);
  softShadow(ctx, blur * SPRITE_SCALE, 'rgba(0,0,0,1)', drawShape);
  return c;
}

// Bazooka tube (origin at the turret centre, pointing +x).
function makeLauncherSprite(color) {
  const { c, ctx } = spriteCanvas(BARREL_W, BARREL_H + 4);
  ctx.translate(0, (BARREL_H + 4) / 2);
  const g = ctx.createLinearGradient(0, -5, 0, 5);
  g.addColorStop(0, shade(color.dark, 0.4)); g.addColorStop(0.45, shade(color.dark, 0.05)); g.addColorStop(1, shade(color.dark, -0.5));
  ctx.fillStyle = g;
  roundRectPath(ctx, 6, -5, 32, 10, 2.5);
  ctx.fill();
  ctx.fillStyle = shade(color.dark, -0.35);
  for (const x of [11, 25]) ctx.fillRect(x, -5.6, 2.2, 11.2);
  ctx.fillRect(35, -5.8, 3.5, 11.6);
  ctx.fillStyle = '#141414';
  ctx.beginPath(); ctx.ellipse(38.5, 0, 1.4, 4, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = rgba('#ffffff', 0.18);
  ctx.fillRect(7, -4, 28, 1.2);
  // Sight box on top.
  ctx.fillStyle = '#222';
  ctx.fillRect(15, -8, 6, 3);
  ctx.fillStyle = '#9fd6ff';
  ctx.fillRect(20, -7.6, 1, 2.2);
  return c;
}

// Running gear frames: treads and wheels are drawn once per animation frame, then blitted.
const GEAR_RES = 4, GEAR_FRAMES = 8;
function gearFrame(phase, period) {
  return Math.floor((((phase % period) + period) % period) / period * GEAR_FRAMES) % GEAR_FRAMES;
}
const GearArt = {
  cache: new Map(),
  make(key, w, h, draw) {
    let c = this.cache.get(key);
    if (c) return c;
    c = makeCanvas(Math.ceil(w * GEAR_RES), Math.ceil(h * GEAR_RES));
    const ctx = c.getContext('2d');
    ctx.scale(GEAR_RES, GEAR_RES);
    draw(ctx);
    this.cache.set(key, c);
    return c;
  },
  tread(h, len, frame) {
    return this.make('t' + h + ',' + len + ',' + frame, len, h, ctx => {
      ctx.fillStyle = '#26231f';
      roundRectPath(ctx, 0, 0, len, h, Math.min(3, h / 3)); ctx.fill();
      const sp = 4.5, off = frame / GEAR_FRAMES * sp;
      ctx.save();
      roundRectPath(ctx, 0, 0, len, h, Math.min(3, h / 3)); ctx.clip();
      ctx.strokeStyle = '#4d4842';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let x = 1 + off - sp; x < len - 0.5; x += sp) { if (x < 0.5) continue; ctx.moveTo(x, 1.2); ctx.lineTo(x, h - 1.2); }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(1, 0.5, len - 2, 1.4);
    });
  },
  tyre(w, h, r, step, hub, frame) {
    return this.make('w' + w + ',' + h + ',' + hub + ',' + frame, w, h, ctx => {
      ctx.fillStyle = '#1e1d1b';
      roundRectPath(ctx, 0, 0, w, h, r); ctx.fill();
      ctx.save();
      roundRectPath(ctx, 0, 0, w, h, r); ctx.clip();
      ctx.strokeStyle = '#46423c';
      ctx.lineWidth = 1.5;
      const off = frame / GEAR_FRAMES * step;
      ctx.beginPath();
      for (let k = -step * 2 + off; k < w + step; k += step) { ctx.moveTo(k, 0); ctx.lineTo(k + 1.6, h); }
      ctx.stroke();
      ctx.restore();
      if (hub === 'bar') {
        ctx.fillStyle = '#8f8a80';
        ctx.fillRect(w / 2 - 1.5, h / 2 - 1.2, 3, 2.4);
      } else if (hub === 'car') {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(w / 2 - 3.4, 0.6, 6.8, h - 1.2);
        ctx.fillStyle = '#6d6a5e';
        roundRectPath(ctx, w / 2 - 2.6, h / 2 - 2, 5.2, 4, 1); ctx.fill();
        ctx.fillStyle = '#2a2824';
        for (const [dx, dy] of [[-1.4, -1], [1.4, -1], [-1.4, 1], [1.4, 1]]) ctx.fillRect(w / 2 + dx - 0.4, h / 2 + dy - 0.4, 0.8, 0.8);
      } else {
        ctx.fillStyle = '#9a958a';
        ctx.beginPath(); ctx.arc(w / 2, h / 2, 2, 0, TAU); ctx.fill();
      }
    });
  },
  roadWheel(frame) {
    return this.make('rw' + frame, 10.8, 10.8, ctx => {
      const x = 5.4, cy = 5.4, spin = frame / GEAR_FRAMES * TAU / 3;
      ctx.fillStyle = '#2c2a26';
      ctx.beginPath(); ctx.arc(x, cy, 5.2, 0, TAU); ctx.fill();
      const g = ctx.createRadialGradient(x - 1.4, cy - 1.4, 0.5, x, cy, 4.2);
      g.addColorStop(0, '#9b968b'); g.addColorStop(1, '#55514a');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, cy, 4, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(30,28,25,0.8)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let k = 0; k < 3; k++) { const a = spin + k * TAU / 3; ctx.moveTo(x, cy); ctx.lineTo(x + Math.cos(a) * 3.6, cy + Math.sin(a) * 3.6); }
      ctx.stroke();
      ctx.fillStyle = '#2c2a26';
      ctx.beginPath(); ctx.arc(x, cy, 1.1, 0, TAU); ctx.fill();
    });
  },
  sprocket(frame) {
    return this.make('sp' + frame, 13, 13, ctx => {
      const c = 6.5, rot = frame / GEAR_FRAMES * TAU / 8;
      ctx.fillStyle = '#34312c';
      ctx.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = rot + i / 16 * TAU, r = i % 2 ? 5.1 : 6.4;
        i ? ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r) : ctx.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
      const g = ctx.createRadialGradient(c - 1.3, c - 1.3, 0.4, c, c, 4.4);
      g.addColorStop(0, '#a29d91'); g.addColorStop(1, '#4d4943');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c, c, 4.2, 0, TAU); ctx.fill();
      ctx.fillStyle = '#26231f';
      for (let i = 0; i < 4; i++) { const a = rot * 2 + i * TAU / 4; ctx.beginPath(); ctx.arc(c + Math.cos(a) * 2.6, c + Math.sin(a) * 2.6, 0.75, 0, TAU); ctx.fill(); }
      ctx.beginPath(); ctx.arc(c, c, 1.2, 0, TAU); ctx.fill();
    });
  },
};

// Buried mine (radius MINE.size), drawn once per kind; the blinking light is added live.
const MineArt = {};
function mineSprite(neutral) {
  const k = neutral ? 'n' : 't';
  if (MineArt[k]) return MineArt[k];
  const S = MINE.size, R = S * 1.8, res = 3;
  const c = makeCanvas(Math.ceil(R * 2 * res), Math.ceil(R * 2 * res)), ctx = c.getContext('2d');
  ctx.scale(res, res);
  ctx.translate(R, R);
  const dirt = ctx.createRadialGradient(0, 0, S * 0.7, 0, 0, S * 1.75);
  dirt.addColorStop(0, 'rgba(45,32,18,0.55)'); dirt.addColorStop(1, 'rgba(45,32,18,0)');
  ctx.fillStyle = dirt;
  ctx.beginPath(); ctx.arc(0, 0, S * 1.75, 0, TAU); ctx.fill();
  const g = ctx.createRadialGradient(-S * 0.3, -S * 0.3, 1, 0, 0, S * 1.05);
  g.addColorStop(0, neutral ? '#8f8a78' : '#8a8763'); g.addColorStop(1, neutral ? '#3f3c34' : '#3e3d2a');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, S, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, S * 0.82, Math.PI * 1.05, Math.PI * 1.7); ctx.stroke();
  ctx.fillStyle = '#2b2a1e';
  for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; ctx.beginPath(); ctx.arc(Math.cos(a) * S * 0.7, Math.sin(a) * S * 0.7, 1.1, 0, TAU); ctx.fill(); }
  ctx.fillStyle = neutral ? '#6a655a' : '#6f6c52';
  ctx.beginPath(); ctx.arc(0, 0, S * 0.4, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(-S * 0.25, -0.6, S * 0.5, 1.2);
  return (MineArt[k] = c);
}
const LABEL_TOP = 34, LABEL_H = 36;   // name-tag sprite: rows above / total, around the health bar

const TankArt = {
  cache: new Map(),
  get(color) {
    const key = color.main;
    let s = this.cache.get(key);
    if (!s) {
      s = { hulls: {}, turret: makeTurretSprite(color), barrel: makeBarrelSprite(color), launcher: makeLauncherSprite(color), longBarrel: makeLongBarrelSprite(color), stub: makeStubBarrelSprite(color), rail: makeRailSprite(color) };
      s.hull = s.hulls.standard = makeHullSprite(color);
      this.cache.set(key, s);
    }
    return s;
  },
  hull(color, variant) {
    const s = this.get(color);
    return s.hulls[variant] || (s.hulls[variant] = makeHullSprite(color, false, variant));
  },
  convoy: {},
  getConvoy(color) {
    return this.convoy[color.main] || (this.convoy[color.main] = makeConvoySprite(color));
  },
  wreck: null,
  getWreck() {
    if (!this.wreck) {
      const c = { main: '#3b3632', dark: '#1d1a17', light: '#6a5e52', camo: '#2c2824' };
      this.wreck = { hull: makeHullSprite(c, true), turret: makeTurretSprite(c, true), barrel: makeBarrelSprite(c, true) };
    }
    return this.wreck;
  },
  shadows: null,
  getShadows() {
    if (!this.shadows) {
      this.shadows = {
        hull: makeShadowSprite(HULL_W, HULL_H, ctx => { roundRectPath(ctx, -29, -21, 58, 42, 6); ctx.fill(); }, 4),
        turret: makeShadowSprite(TURRET_W + 30, TURRET_H, ctx => {
          ctx.translate(-4, 0); turretPath(ctx); ctx.fill(); ctx.fillRect(10, -3, 30, 6);
        }, 3),
      };
    }
    return this.shadows;
  },
};

// ---- Obstacles ---------------------------------------------------------------------
function obstacleSprite(o, biome) {
  const rng = new RNG(o.seed);
  const pad = 6;
  if (o.shape === 'rect') {
    const { c, ctx } = spriteCanvas(o.w + pad * 2, o.h + pad * 2);
    ctx.translate(pad, pad);
    ({ building: drawBuilding, container: drawContainer, sandbags: drawSandbags, barrier: drawBarrier, crates: drawCrates,
       hedge: drawHedge, barn: drawBarn, temple: drawTemple, house: drawHouse, bunker: drawBunker, pipe: drawPipe })[o.kind](ctx, o, rng, biome);
    return { canvas: c, x: o.x - pad, y: o.y - pad, w: o.w + pad * 2, h: o.h + pad * 2 };
  }
  if (o.kind === 'wreck') {
    const R = 46;
    const { c, ctx } = spriteCanvas(R * 2, R * 2);
    ctx.translate(R, R);
    drawWreckHulk(ctx, o, rng, biome);
    return { canvas: c, x: o.cx - R, y: o.cy - R, w: R * 2, h: R * 2 };
  }
  if (o.kind === 'rock') {
    const R = o.r * 1.12 + pad;
    const { c, ctx } = spriteCanvas(R * 2, R * 2);
    ctx.translate(R, R);
    drawRock(ctx, o, rng, biome);
    return { canvas: c, x: o.cx - R, y: o.cy - R, w: R * 2, h: R * 2 };
  }
  // tree canopy
  const R = o.canopy + pad;
  const { c, ctx } = spriteCanvas(R * 2, R * 2);
  ctx.translate(R, R);
  drawTree(ctx, o, rng, biome);
  return { canvas: c, x: o.cx - R, y: o.cy - R, w: R * 2, h: R * 2, canopy: true };
}

function bevelRect(ctx, x, y, w, h, color, depth = 3) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = rgba('#ffffff', 0.18);
  ctx.fillRect(x, y, w, depth);
  ctx.fillRect(x, y, depth, h);
  ctx.fillStyle = rgba('#000000', 0.25);
  ctx.fillRect(x, y + h - depth, w, depth);
  ctx.fillRect(x + w - depth, y, depth, h);
}

function drawBuilding(ctx, o, rng, biome) {
  const { w, h } = o;
  const base = o.color;
  // Parapet wall.
  ctx.fillStyle = shade(base, -0.35);
  ctx.fillRect(0, 0, w, h);
  bevelRect(ctx, 0, 0, w, h, shade(base, -0.12), 3);
  // Roof deck with subtle tar texture.
  const inset = 7;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, shade(base, 0.08));
  g.addColorStop(1, shade(base, -0.1));
  ctx.fillStyle = g;
  ctx.fillRect(inset, inset, w - inset * 2, h - inset * 2);
  for (let i = 0; i < (w * h) / 60; i++) {
    ctx.fillStyle = rgba(rng.chance(0.5) ? '#000000' : '#ffffff', rng.float(0.03, 0.07));
    ctx.fillRect(inset + rng.float(0, w - inset * 2 - 2), inset + rng.float(0, h - inset * 2 - 2), rng.float(1, 3), rng.float(1, 3));
  }
  // Inner shadow under the parapet.
  ctx.fillStyle = rgba('#000000', 0.22);
  ctx.fillRect(inset, inset, w - inset * 2, 3);
  ctx.fillRect(inset, inset, 3, h - inset * 2);
  // Seams.
  ctx.strokeStyle = rgba('#000000', 0.12);
  ctx.lineWidth = 1;
  const vertical = w > h;
  for (let s = inset + 20; s < (vertical ? w : h) - inset; s += 20) {
    ctx.beginPath();
    if (vertical) { ctx.moveTo(s, inset); ctx.lineTo(s, h - inset); } else { ctx.moveTo(inset, s); ctx.lineTo(w - inset, s); }
    ctx.stroke();
  }
  // Rooftop equipment.
  const items = rng.int(1, 3);
  for (let i = 0; i < items; i++) {
    const iw = rng.int(14, 24), ih = rng.int(12, 20);
    const ix = rng.float(inset + 6, w - inset - iw - 6), iy = rng.float(inset + 6, h - inset - ih - 6);
    ctx.fillStyle = rgba('#000000', 0.25);
    ctx.fillRect(ix + 3, iy + 4, iw, ih);
    bevelRect(ctx, ix, iy, iw, ih, '#9a9d9f', 2);
    ctx.fillStyle = '#5d6163';
    ctx.beginPath(); ctx.arc(ix + iw / 2, iy + ih / 2, Math.min(iw, ih) * 0.32, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#7d8183';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(ix + iw / 2 - 3, iy + ih / 2); ctx.lineTo(ix + iw / 2 + 3, iy + ih / 2);
    ctx.moveTo(ix + iw / 2, iy + ih / 2 - 3); ctx.lineTo(ix + iw / 2, iy + ih / 2 + 3);
    ctx.stroke();
  }
  if (rng.chance(0.6)) {
    const sw = rng.int(18, 30), sh = rng.int(10, 16);
    const sx = rng.float(inset + 6, w - inset - sw - 6), sy = rng.float(inset + 6, h - inset - sh - 6);
    const sg = ctx.createLinearGradient(sx, sy, sx + sw, sy + sh);
    sg.addColorStop(0, '#9cc9dc'); sg.addColorStop(1, '#3e6a80');
    ctx.fillStyle = sg;
    ctx.fillRect(sx, sy, sw, sh);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
  }
  for (let i = 0; i < rng.int(2, 5); i++) {
    ctx.fillStyle = '#4b4f52';
    ctx.beginPath(); ctx.arc(rng.float(inset + 5, w - inset - 5), rng.float(inset + 5, h - inset - 5), 2.2, 0, TAU); ctx.fill();
  }
  // Weathering / snow.
  if (biome.id === 'snow') {
    for (let i = 0; i < 6; i++) {
      const x = rng.float(inset, w - inset), y = rng.float(inset, h - inset), r = rng.float(10, 24);
      const sg = ctx.createRadialGradient(x, y, 0, x, y, r);
      sg.addColorStop(0, 'rgba(255,255,255,0.85)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  ctx.strokeStyle = rgba('#000000', 0.5);
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

function drawContainer(ctx, o, rng) {
  const { w, h } = o;
  const vertical = h > w;
  const L = vertical ? h : w, S = vertical ? w : h;
  ctx.save();
  if (vertical) { ctx.translate(w, 0); ctx.rotate(Math.PI / 2); }
  const base = o.color;
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, shade(base, 0.18));
  g.addColorStop(0.5, base);
  g.addColorStop(1, shade(base, -0.3));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, L, S);
  // Corrugation.
  for (let x = 4; x < L - 4; x += 4) {
    ctx.fillStyle = rgba(x % 8 === 0 ? '#ffffff' : '#000000', 0.09);
    ctx.fillRect(x, 2, 2, S - 4);
  }
  // Frame and doors.
  ctx.strokeStyle = shade(base, -0.45);
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, L - 2, S - 2);
  ctx.fillStyle = shade(base, -0.2);
  ctx.fillRect(L - 10, 2, 8, S - 4);
  ctx.strokeStyle = rgba('#000000', 0.35);
  ctx.lineWidth = 0.8;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath(); ctx.moveTo(L - 10 + i * 2, 3); ctx.lineTo(L - 10 + i * 2, S - 3); ctx.stroke();
  }
  // Rust and dents.
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = `rgba(110,55,25,${rng.float(0.1, 0.3)})`;
    ctx.beginPath(); ctx.ellipse(rng.float(4, L - 4), rng.float(3, S - 3), rng.float(1, 4), rng.float(0.8, 2.5), 0, 0, TAU); ctx.fill();
  }
  // Corner castings.
  ctx.fillStyle = shade(base, -0.5);
  for (const [x, y] of [[0, 0], [L - 5, 0], [0, S - 5], [L - 5, S - 5]]) ctx.fillRect(x, y, 5, 5);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

function drawSandbags(ctx, o, rng, biome) {
  const { w, h } = o;
  const vertical = h > w;
  const L = vertical ? h : w;
  ctx.save();
  if (vertical) { ctx.translate(w, 0); ctx.rotate(Math.PI / 2); }
  const bag = biome.id === 'snow' ? '#b9b3a0' : biome.id === 'desert' ? '#c7ad7d' : biome.id === 'marsh' ? '#948a66' : '#b6a47a';
  const rows = 2, bh = 13, bw = 20;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? bw / 2 : 0;
    for (let x = -off; x < L; x += bw) {
      const x0 = Math.max(0, x), x1 = Math.min(L, x + bw);
      if (x1 - x0 < 6) continue;
      const y0 = r * bh;
      const g = ctx.createLinearGradient(x0, y0, x0 + 4, y0 + bh);
      const c = shade(bag, rng.float(-0.08, 0.08));
      g.addColorStop(0, shade(c, 0.2)); g.addColorStop(1, shade(c, -0.25));
      ctx.fillStyle = g;
      roundRectPath(ctx, x0 + 0.5, y0 + 0.5, x1 - x0 - 1, bh - 1, 5);
      ctx.fill();
      ctx.strokeStyle = rgba('#3d3322', 0.55);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.strokeStyle = rgba('#3d3322', 0.25);
      ctx.beginPath(); ctx.moveTo(x0 + 3, y0 + bh / 2); ctx.lineTo(x1 - 3, y0 + bh / 2 + rng.float(-1, 1)); ctx.stroke();
    }
  }
  if (biome.id === 'snow') {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let x = 4; x < L; x += rng.float(12, 26)) { ctx.beginPath(); ctx.ellipse(x, 5, rng.float(5, 10), 3, 0, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}

function drawBarrier(ctx, o, rng, biome) {
  const { w, h } = o;
  const vertical = h > w;
  const L = vertical ? h : w, S = vertical ? w : h;
  ctx.save();
  if (vertical) { ctx.translate(w, 0); ctx.rotate(Math.PI / 2); }
  const seg = 24;
  for (let x = 0; x < L - 1; x += seg) {
    const sw = Math.min(seg, L - x) - 1.5;
    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, shade(biome.concrete, 0.1));
    g.addColorStop(0.45, shade(biome.concrete, 0.28));
    g.addColorStop(0.55, shade(biome.concrete, -0.05));
    g.addColorStop(1, shade(biome.concrete, -0.35));
    ctx.fillStyle = g;
    roundRectPath(ctx, x + 0.75, 0.5, sw, S - 1, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    if (rng.chance(0.2)) {
      ctx.save();
      roundRectPath(ctx, x + 0.75, 0.5, sw, S - 1, 3);
      ctx.clip();
      for (let k = -S; k < sw; k += 7) {
        ctx.fillStyle = (k / 7) % 2 === 0 ? 'rgba(230,180,40,0.85)' : 'rgba(30,30,30,0.85)';
        ctx.beginPath();
        ctx.moveTo(x + k, S); ctx.lineTo(x + k + S, 0); ctx.lineTo(x + k + S + 3.5, 0); ctx.lineTo(x + k + 3.5, S);
        ctx.fill();
      }
      ctx.restore();
    }
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = rgba('#000000', rng.float(0.05, 0.15));
      ctx.fillRect(x + rng.float(2, sw - 3), rng.float(2, S - 3), 1.5, 1.5);
    }
  }
  ctx.restore();
}

function drawCrates(ctx, o, rng) {
  const { w } = o;
  const one = rng.chance(0.45) || w < 48;
  const wood = rng.pick(['#9a6b3a', '#8a5f33', '#a8773f', '#6f7a3d']);
  const crate = (x, y, s) => {
    ctx.fillStyle = rgba('#000000', 0.25);
    ctx.fillRect(x + 2, y + 3, s, s);
    ctx.fillStyle = shade(wood, rng.float(-0.08, 0.08));
    ctx.fillRect(x, y, s, s);
    ctx.strokeStyle = rgba('#000000', 0.25);
    ctx.lineWidth = 0.8;
    for (let k = s / 4; k < s; k += s / 4) { ctx.beginPath(); ctx.moveTo(x + 3, y + k); ctx.lineTo(x + s - 3, y + k); ctx.stroke(); }
    ctx.strokeStyle = shade(wood, -0.4);
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1.5, y + 1.5, s - 3, s - 3);
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(x + 3, y + 3); ctx.lineTo(x + s - 3, y + s - 3); ctx.stroke();
    ctx.fillStyle = rgba('#ffffff', 0.15);
    ctx.fillRect(x, y, s, 1.5);
    ctx.fillRect(x, y, 1.5, s);
    if (s > 30) {
      ctx.fillStyle = rgba('#1a1a1a', 0.45);
      ctx.font = `bold ${Math.round(s * 0.17)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(rng.pick(['AMMO', '7.62', 'SUPPLY', 'RATIONS']), x + s / 2, y + s * 0.3, s * 0.62);
    }
  };
  if (one) crate(0, 0, w);
  else { const s = w / 2; crate(0, 0, s); crate(s, 0, s); crate(0, s, s); crate(s, s, s); }
}

// Rotate long thin pieces so they are always drawn along +x.
function alongX(ctx, o) {
  const vertical = o.h > o.w;
  if (vertical) { ctx.translate(o.w, 0); ctx.rotate(Math.PI / 2); }
  return { L: vertical ? o.h : o.w, S: vertical ? o.w : o.h };
}

const HEDGE_COLORS = { grassland: '#4c7433', cherry: '#5b8a45', autumn: '#7a7a34', snow: '#3a5a47', desert: '#77773c', badlands: '#5f7a3a', marsh: '#566f36' };

// Hedgerow: a dense line of shrubs on a strip of dark soil.
function drawHedge(ctx, o, rng, biome) {
  ctx.save();
  const { L, S } = alongX(ctx, o), base = HEDGE_COLORS[biome.id] || '#4c7433';
  ctx.fillStyle = 'rgba(40,32,20,0.45)';
  roundRectPath(ctx, 0, S * 0.12, L, S * 0.86, S * 0.4); ctx.fill();
  const n = Math.max(2, Math.ceil(L / (S * 0.55))), puffs = [];
  for (let i = 0; i < n; i++) puffs.push([(i + 0.5) * L / n + rng.float(-2, 2), S / 2 + rng.float(-2, 2), S * rng.float(0.5, 0.62)]);
  for (const [x, y, r] of puffs) { ctx.fillStyle = shade(base, -0.35); ctx.beginPath(); ctx.arc(x + 1.5, y + 2, r, 0, TAU); ctx.fill(); }
  for (const [x, y, r] of puffs) {
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    const c = biome.id === 'autumn' && rng.chance(0.35) ? rng.pick(['#b8672a', '#a3461f', '#c8952e']) : base;
    g.addColorStop(0, shade(c, 0.28)); g.addColorStop(0.65, c); g.addColorStop(1, shade(c, -0.25));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  for (let i = 0; i < L / 3; i++) {
    const x = rng.float(2, L - 2), y = rng.float(S * 0.15, S * 0.85);
    ctx.fillStyle = rgba(rng.chance(0.5) ? '#ffffff' : '#000000', rng.float(0.05, 0.14));
    ctx.beginPath(); ctx.arc(x, y, rng.float(1, 2.4), 0, TAU); ctx.fill();
  }
  if (biome.id === 'cherry') {
    for (let i = 0; i < L / 5; i++) { ctx.fillStyle = rng.pick(['#f7b8cf', '#ffffff', '#ec9fbd']); ctx.beginPath(); ctx.arc(rng.float(2, L - 2), rng.float(S * 0.2, S * 0.8), rng.float(0.8, 1.5), 0, TAU); ctx.fill(); }
  } else if (biome.id === 'snow') {
    for (const [x, y, r] of puffs) { ctx.fillStyle = 'rgba(250,252,255,0.8)'; ctx.beginPath(); ctx.ellipse(x - r * 0.25, y - r * 0.3, r * 0.55, r * 0.35, -0.4, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}

// Hipped roof seen from above: four sloped faces meeting at a ridge, lit from the top-left.
function hipRoof(ctx, x, y, w, h, col, flare = 0) {
  const vertical = h > w, m = Math.min(w, h) / 2;
  const r0 = vertical ? [x + m, y + m] : [x + m, y + m], r1 = vertical ? [x + m, y + h - m] : [x + w - m, y + m];
  const p0 = [x - flare, y - flare], p1 = [x + w + flare, y - flare], p2 = [x + w + flare, y + h + flare], p3 = [x - flare, y + h + flare];
  const face = (pts, c) => { ctx.fillStyle = c; ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath(); ctx.fill(); };
  if (vertical) {
    face([p0, p1, r0], shade(col, 0.2));
    face([p1, p2, r1, r0], shade(col, -0.1));
    face([p2, p3, r1], shade(col, -0.3));
    face([p3, p0, r0, r1], shade(col, 0.08));
  } else {
    face([p0, p1, r1, r0], shade(col, 0.2));
    face([p1, p2, r1], shade(col, -0.1));
    face([p2, p3, r0, r1], shade(col, -0.3));
    face([p3, p0, r0], shade(col, 0.05));
  }
  ctx.strokeStyle = rgba('#000000', 0.35); ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]); ctx.lineTo(r0[0], r0[1]); ctx.lineTo(r1[0], r1[1]); ctx.lineTo(p2[0], p2[1]);
  ctx.moveTo(p1[0], p1[1]); ctx.lineTo(vertical ? r0[0] : r1[0], vertical ? r0[1] : r1[1]);
  ctx.moveTo(p3[0], p3[1]); ctx.lineTo(vertical ? r1[0] : r0[0], vertical ? r1[1] : r0[1]);
  ctx.stroke();
  // Tile courses parallel to the eaves.
  ctx.save();
  ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]); ctx.closePath(); ctx.clip();
  ctx.strokeStyle = rgba('#000000', 0.12); ctx.lineWidth = 0.6;
  for (let k = 3; k < m; k += 3.5) {
    ctx.beginPath(); ctx.rect(x + k - flare * (1 - k / m), y + k - flare * (1 - k / m), w - 2 * k + 2 * flare * (1 - k / m), h - 2 * k + 2 * flare * (1 - k / m)); ctx.stroke();
  }
  ctx.restore();
}

// Barn: long red roof with white trim and a little ventilator cupola on the ridge.
function drawBarn(ctx, o, rng) {
  ctx.save();
  const { L, S } = alongX(ctx, o), col = o.color;
  ctx.fillStyle = shade(col, 0.12); ctx.fillRect(0, 0, L, S / 2);
  ctx.fillStyle = shade(col, -0.24); ctx.fillRect(0, S / 2, L, S / 2);
  ctx.strokeStyle = rgba('#000000', 0.16); ctx.lineWidth = 1;
  for (let x = 5; x < L; x += 5) { ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x, S - 1); ctx.stroke(); }
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = rgba(rng.chance(0.5) ? '#000000' : '#ffffff', rng.float(0.04, 0.09));
    ctx.fillRect(rng.float(0, L - 20), rng.float(0, S - 6), rng.float(10, 30), rng.float(3, 6));
  }
  ctx.fillStyle = shade(col, -0.45); ctx.fillRect(0, S / 2 - 1.5, L, 3);
  ctx.strokeStyle = 'rgba(240,232,214,0.85)'; ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, L - 2, S - 2);
  // Cupola.
  const cx = L / 2, cy = S / 2, cs = Math.min(18, S * 0.3);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(cx - cs / 2 + 3, cy - cs / 2 + 3, cs, cs);
  hipRoof(ctx, cx - cs / 2, cy - cs / 2, cs, cs, shade(col, -0.1));
  ctx.strokeStyle = '#2a2622'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx - cs * 0.7, cy); ctx.lineTo(cx + cs * 0.7, cy); ctx.stroke();
  ctx.fillStyle = '#2a2622'; ctx.beginPath(); ctx.moveTo(cx + cs * 0.7, cy); ctx.lineTo(cx + cs * 0.45, cy - 2.5); ctx.lineTo(cx + cs * 0.45, cy + 2.5); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, o.w - 1, o.h - 1);
}

// Pagoda temple: a stone platform, two tiers of flared tile roof and a gilded finial.
function drawTemple(ctx, o, rng, biome) {
  const { w, h } = o;
  const stone = shade(biome.concrete, 0.05);
  bevelRect(ctx, 0, 0, w, h, stone, 3);
  ctx.strokeStyle = rgba('#000000', 0.15); ctx.lineWidth = 1;
  for (let k = 4; k < 9; k += 2.5) ctx.strokeRect(k, k, w - 2 * k, h - 2 * k);
  const col = o.color;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(16, 17, w - 26, h - 26);
  hipRoof(ctx, 12, 12, w - 24, h - 24, col, 5);
  ctx.strokeStyle = 'rgba(224,176,64,0.75)'; ctx.lineWidth = 1.2;
  ctx.strokeRect(7, 7, w - 14, h - 14);
  const iw = (w - 24) * 0.5, ih = (h - 24) * 0.5;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(w / 2 - iw / 2 + 3, h / 2 - ih / 2 + 4, iw, ih);
  hipRoof(ctx, w / 2 - iw / 2, h / 2 - ih / 2, iw, ih, shade(col, 0.08), 3.5);
  ctx.fillStyle = '#e2b246'; ctx.beginPath(); ctx.arc(w / 2, h / 2, 3.4, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#8a6420'; ctx.lineWidth = 0.8; ctx.stroke();
  // Corner bells.
  ctx.fillStyle = '#d8a840';
  for (const [x, y] of [[7, 7], [w - 7, 7], [7, h - 7], [w - 7, h - 7]]) { ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill(); }
}

// Farmhouse: gabled roof, ridge and a chimney.
function drawHouse(ctx, o, rng, biome) {
  ctx.save();
  const { L, S } = alongX(ctx, o), col = o.color;
  ctx.fillStyle = shade(col, 0.16); ctx.fillRect(0, 0, L, S / 2);
  ctx.fillStyle = shade(col, -0.25); ctx.fillRect(0, S / 2, L, S / 2);
  ctx.strokeStyle = rgba('#000000', 0.18); ctx.lineWidth = 0.8;
  for (let x = 4; x < L; x += 4) { ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x, S - 1); ctx.stroke(); }
  ctx.fillStyle = shade(col, -0.45); ctx.fillRect(0, S / 2 - 1.2, L, 2.4);
  const cx = L * rng.float(0.2, 0.75);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(cx + 2, S * 0.18 + 3, 8, 8);
  bevelRect(ctx, cx, S * 0.18, 8, 8, '#7a6e64', 1.5);
  ctx.fillStyle = '#2a2622'; ctx.fillRect(cx + 2.5, S * 0.18 + 2.5, 3, 3);
  if (biome.id === 'snow') {
    ctx.fillStyle = 'rgba(250,252,255,0.8)'; ctx.fillRect(0, 0, L, S / 2 - 2);
    ctx.fillStyle = 'rgba(250,252,255,0.45)'; ctx.fillRect(0, S / 2 + 2, L, S * 0.2);
  } else if (biome.id === 'autumn' || biome.id === 'cherry') {
    for (let i = 0; i < 12; i++) { ctx.fillStyle = rng.pick(biome.flowers); ctx.beginPath(); ctx.ellipse(rng.float(2, L - 2), rng.float(2, S - 2), 1.8, 1, rng.float(0, TAU), 0, TAU); ctx.fill(); }
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, o.w - 1, o.h - 1);
}

// Concrete pillbox with a firing slit facing the enemy side and a camouflage net.
function drawBunker(ctx, o, rng, biome) {
  const { w, h } = o, r = Math.min(w, h) * 0.28;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, shade(biome.concrete, 0.12)); g.addColorStop(1, shade(biome.concrete, -0.3));
  ctx.fillStyle = g;
  roundRectPath(ctx, 0.5, 0.5, w - 1, h - 1, r); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = shade(biome.concrete, -0.08);
  roundRectPath(ctx, 7, 7, w - 14, h - 14, r * 0.6); ctx.fill();
  for (let i = 0; i < w * h / 70; i++) { ctx.fillStyle = rgba('#000000', rng.float(0.05, 0.12)); ctx.fillRect(rng.float(8, w - 9), rng.float(8, h - 9), 1.5, 1.5); }
  const sx = o.flip ? 1.5 : w - 5.5;
  ctx.fillStyle = '#141414';
  ctx.fillRect(sx, h / 2 - h * 0.22, 4, h * 0.44);
  ctx.fillStyle = 'rgba(80,90,50,0.55)';
  for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.arc(rng.float(10, w - 10), rng.float(10, h - 10), rng.float(4, 9), 0, TAU); ctx.fill(); }
  ctx.fillStyle = '#4a4744';
  ctx.beginPath(); ctx.arc(w * 0.35, h * 0.35, 4.5, 0, TAU); ctx.fill();
  ctx.fillStyle = '#6d6862';
  ctx.beginPath(); ctx.arc(w * 0.35 - 1, h * 0.35 - 1, 3, 0, TAU); ctx.fill();
  if (biome.id === 'snow') { ctx.fillStyle = 'rgba(250,252,255,0.7)'; ctx.beginPath(); ctx.ellipse(w * 0.4, h * 0.3, w * 0.25, h * 0.15, -0.3, 0, TAU); ctx.fill(); }
}

// Above-ground pipeline: a steel pipe with bolted flanges on concrete saddles.
function drawPipe(ctx, o, rng) {
  ctx.save();
  const { L, S } = alongX(ctx, o);
  ctx.fillStyle = '#8f8a80';
  for (let x = 20; x < L - 10; x += 96) ctx.fillRect(x, -2, 14, S + 4);
  const g = ctx.createLinearGradient(0, 2, 0, S - 2);
  g.addColorStop(0, '#8e959a'); g.addColorStop(0.35, '#c9ced1'); g.addColorStop(0.6, '#7d8489'); g.addColorStop(1, '#43494d');
  ctx.fillStyle = g;
  roundRectPath(ctx, 0, 2, L, S - 4, (S - 4) / 2); ctx.fill();
  for (let x = 44; x < L - 6; x += 48) {
    ctx.fillStyle = '#4d5357'; ctx.fillRect(x, 0.5, 4, S - 1);
    ctx.fillStyle = '#2a2e31';
    for (const y of [2.5, S / 2, S - 2.5]) { ctx.beginPath(); ctx.arc(x + 2, y, 0.8, 0, TAU); ctx.fill(); }
  }
  for (let i = 0; i < L / 30; i++) { ctx.fillStyle = `rgba(120,62,28,${rng.float(0.15, 0.35)})`; ctx.beginPath(); ctx.ellipse(rng.float(4, L - 4), rng.float(S * 0.4, S - 3), rng.float(2, 6), rng.float(1, 2), 0, 0, TAU); ctx.fill(); }
  ctx.restore();
}

// A burnt-out tank hulk left from an earlier battle.
function drawWreckHulk(ctx, o, rng) {
  const g = ctx.createRadialGradient(0, 0, 6, 0, 0, 44);
  g.addColorStop(0, 'rgba(20,16,12,0.55)'); g.addColorStop(1, 'rgba(20,16,12,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, 44, 0, TAU); ctx.fill();
  const w = TankArt.getWreck(), a = rng.float(0, TAU);
  ctx.save();
  ctx.rotate(a);
  ctx.fillStyle = '#1f1d1a';
  roundRectPath(ctx, -30, -22, 60, 10, 3); ctx.fill();
  roundRectPath(ctx, -26, 12, 52, 10, 3); ctx.fill();
  ctx.drawImage(w.hull, -HULL_W / 2, -HULL_H / 2, HULL_W, HULL_H);
  ctx.rotate(rng.float(-1.2, 1.2));
  ctx.translate(rng.float(-4, 4), rng.float(-3, 3));
  ctx.drawImage(w.barrel, -4, -BARREL_H / 2, BARREL_W, BARREL_H);
  ctx.drawImage(w.turret, -(TURRET_W / 2 - 4), -TURRET_H / 2, TURRET_W, TURRET_H);
  ctx.restore();
  for (let i = 0; i < 6; i++) { ctx.fillStyle = `rgba(130,60,25,${rng.float(0.2, 0.4)})`; ctx.beginPath(); ctx.arc(rng.float(-22, 22), rng.float(-16, 16), rng.float(1.5, 4), 0, TAU); ctx.fill(); }
}

function drawRock(ctx, o, rng, biome) {
  const r = o.r * 1.1;
  const n = rng.int(8, 11);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng.float(-0.2, 0.2);
    const rr = r * rng.float(0.82, 1.02);
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  const path = () => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
  const g = ctx.createLinearGradient(-r, -r, r, r);
  g.addColorStop(0, shade(biome.rock, 0.3));
  g.addColorStop(0.5, biome.rock);
  g.addColorStop(1, shade(biome.rock, -0.4));
  ctx.fillStyle = g;
  path();
  ctx.fill();
  // Facets.
  const top = [rng.float(-r * 0.2, r * 0.1), rng.float(-r * 0.25, 0)];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    const nx = (x1 + x2) / 2, ny = (y1 + y2) / 2;
    const lit = -(nx * LIGHT.x + ny * LIGHT.y) / r;
    ctx.fillStyle = lit > 0 ? rgba('#ffffff', lit * 0.22) : rgba('#000000', -lit * 0.3);
    ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = rgba('#000000', 0.18);
  ctx.lineWidth = 0.7;
  for (let i = 0; i < n; i += 2) { ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke(); }
  // Moss / snow cap / sandstone strata.
  if (biome.id === 'badlands') {
    ctx.save(); path(); ctx.clip();
    for (let y = -r; y < r; y += rng.float(3.5, 6)) {
      ctx.strokeStyle = rng.chance(0.5) ? 'rgba(255,210,170,0.22)' : 'rgba(70,20,5,0.22)';
      ctx.lineWidth = rng.float(1, 2.2);
      ctx.beginPath();
      ctx.moveTo(-r, y);
      ctx.quadraticCurveTo(0, y + rng.float(-3, 3), r, y + rng.float(-2, 2));
      ctx.stroke();
    }
    ctx.restore();
  } else if (biome.id === 'snow') {
    ctx.save(); path(); ctx.clip();
    ctx.fillStyle = 'rgba(250,252,255,0.9)';
    ctx.beginPath(); ctx.ellipse(top[0] - r * 0.2, top[1] - r * 0.25, r * 0.7, r * 0.5, -0.5, 0, TAU); ctx.fill();
    ctx.restore();
  } else if (biome.id === 'grassland' || biome.id === 'marsh' || biome.id === 'autumn') {
    const moss = biome.id === 'marsh' ? '70,100,45' : '90,120,50';
    for (let i = 0; i < (biome.id === 'marsh' ? 7 : 4); i++) {
      ctx.fillStyle = `rgba(${moss},${rng.float(0.25, 0.55)})`;
      ctx.beginPath(); ctx.arc(rng.float(-r * 0.6, r * 0.6), rng.float(-r * 0.6, r * 0.6), rng.float(2, 5), 0, TAU); ctx.fill();
    }
    if (biome.id === 'autumn') {
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = rng.pick(biome.flowers);
        ctx.beginPath(); ctx.ellipse(rng.float(-r * 0.6, r * 0.6), rng.float(-r * 0.6, r * 0.6), 2, 1.1, rng.float(0, TAU), 0, TAU); ctx.fill();
      }
    }
  }
  ctx.strokeStyle = rgba('#000000', 0.5);
  ctx.lineWidth = 1;
  path();
  ctx.stroke();
}

function drawTree(ctx, o, rng, biome) {
  const R = o.canopy;
  const cols = biome.tree;
  if (biome.treeType === 'pine') {
    const layers = 4;
    for (let l = 0; l < layers; l++) {
      const rr = R * (1 - l * 0.22), spikes = 9 - l;
      ctx.fillStyle = shade(cols[Math.min(l, cols.length - 1)], l * 0.06);
      ctx.beginPath();
      const rot = rng.float(0, TAU);
      for (let i = 0; i < spikes * 2; i++) {
        const a = rot + (i / (spikes * 2)) * TAU;
        const d = i % 2 ? rr * 0.62 : rr;
        const x = Math.cos(a) * d - l * 1.5, y = Math.sin(a) * d - l * 1.5;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      if (biome.id === 'snow') {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        for (let i = 0; i < spikes; i++) {
          const a = rot + (i / spikes) * TAU;
          ctx.beginPath(); ctx.ellipse(Math.cos(a) * rr * 0.7 - l * 1.5, Math.sin(a) * rr * 0.7 - l * 1.5, rr * 0.16, rr * 0.08, a, 0, TAU); ctx.fill();
        }
      }
    }
    return;
  }
  if (biome.treeType === 'cactus') {
    // Top-down saguaro: ribbed trunk top with a few arms reaching out.
    const trunk = R * 0.52;
    const arms = rng.int(1, 3);
    for (let i = 0; i < arms; i++) {
      const a = rng.float(0, TAU), d = R * rng.float(0.55, 0.75), ar = trunk * rng.float(0.5, 0.65);
      const ax = Math.cos(a) * d, ay = Math.sin(a) * d;
      ctx.strokeStyle = shade(cols[2], -0.1);
      ctx.lineWidth = ar * 1.3;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(ax, ay); ctx.stroke();
      const g = ctx.createRadialGradient(ax - ar * 0.3, ay - ar * 0.3, ar * 0.1, ax, ay, ar);
      g.addColorStop(0, shade(cols[1], 0.25)); g.addColorStop(1, cols[2]);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ax, ay, ar, 0, TAU); ctx.fill();
    }
    const g = ctx.createRadialGradient(-trunk * 0.3, -trunk * 0.35, trunk * 0.1, 0, 0, trunk);
    g.addColorStop(0, shade(cols[1], 0.3)); g.addColorStop(0.7, cols[0]); g.addColorStop(1, shade(cols[2], -0.2));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, trunk, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba('#1f2d14', 0.45);
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * trunk * 0.25, Math.sin(a) * trunk * 0.25); ctx.lineTo(Math.cos(a) * trunk * 0.95, Math.sin(a) * trunk * 0.95); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,245,210,0.7)';
    for (let i = 0; i < 16; i++) {
      const a = rng.float(0, TAU), d = rng.float(0.3, 0.95) * trunk;
      ctx.fillRect(Math.cos(a) * d, Math.sin(a) * d, 0.8, 0.8);
    }
    if (rng.chance(0.5)) {
      ctx.fillStyle = rng.pick(['#f6e7a1', '#f3b7c9', '#ffffff']);
      for (let i = 0; i < 5; i++) { const a = (i / 5) * TAU; ctx.beginPath(); ctx.arc(Math.cos(a) * 2.2, Math.sin(a) * 2.2, 1.6, 0, TAU); ctx.fill(); }
    }
    return;
  }
  if (biome.treeType === 'palm') {
    const fronds = rng.int(7, 9);
    for (let i = 0; i < fronds; i++) {
      const a = (i / fronds) * TAU + rng.float(-0.2, 0.2);
      const len = R * rng.float(0.85, 1);
      ctx.save();
      ctx.rotate(a);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, shade(cols[1], -0.2)); g.addColorStop(1, shade(cols[0], 0.15));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(len * 0.5, -len * 0.26, len, 0);
      ctx.quadraticCurveTo(len * 0.5, len * 0.22, 0, 0);
      ctx.fill();
      ctx.strokeStyle = rgba('#2a3a14', 0.5);
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(2, 0); ctx.quadraticCurveTo(len * 0.5, -len * 0.03, len * 0.98, 0); ctx.stroke();
      ctx.strokeStyle = rgba('#2a3a14', 0.25);
      for (let k = 0.2; k < 0.95; k += 0.12) {
        ctx.beginPath(); ctx.moveTo(len * k, 0); ctx.lineTo(len * (k + 0.06), -len * 0.13 * (1 - k)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(len * k, 0); ctx.lineTo(len * (k + 0.06), len * 0.11 * (1 - k)); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.fillStyle = '#6b4a24';
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(rng.float(-3, 3), rng.float(-3, 3), 3, 0, TAU); ctx.fill(); }
    return;
  }
  if (biome.treeType === 'willow') { drawWillow(ctx, R, rng, cols); return; }
  // Autumn: every tree turns its own colour (a few are still green).
  let leafCols = cols;
  if (biome.treeType === 'autumn') {
    leafCols = rng.pick([
      ['#a8401c', '#cf6326', '#ec9d3e'], ['#a8401c', '#cf6326', '#ec9d3e'],
      ['#8f2a1a', '#bd3f26', '#e2703a'], ['#b0801c', '#d8a935', '#f2cf62'],
      ['#b0801c', '#d8a935', '#f2cf62'], ['#4d6a2e', '#6a8a3c', '#8fae52'],
    ]);
  }
  return drawBroadleaf(ctx, R, rng, leafCols, biome);
}

function drawBroadleaf(ctx, R, rng, cols, biome) {
  // Broadleaf: clustered puffs with top-left light.
  const puffs = [];
  const n = rng.int(7, 10);
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, TAU), d = rng.float(0, R * 0.45);
    puffs.push([Math.cos(a) * d, Math.sin(a) * d, R * rng.float(0.4, 0.58)]);
  }
  for (const [x, y, r] of puffs) {
    ctx.fillStyle = shade(cols[0], -0.25);
    ctx.beginPath(); ctx.arc(x + 2, y + 2.5, r, 0, TAU); ctx.fill();
  }
  for (const [x, y, r] of puffs) {
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, shade(cols[2], 0.2));
    g.addColorStop(0.6, cols[1]);
    g.addColorStop(1, cols[0]);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  for (let i = 0; i < 18; i++) {
    const a = rng.float(0, TAU), d = rng.float(0, R * 0.75);
    ctx.fillStyle = rgba(rng.chance(0.5) ? '#ffffff' : '#000000', rng.float(0.05, 0.12));
    ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, rng.float(1.5, 4), 0, TAU); ctx.fill();
  }
  if (biome.treeType === 'autumn') {
    // Loose leaves catching the light across the canopy.
    for (let i = 0; i < 45; i++) {
      const a = rng.float(0, TAU), d = Math.sqrt(rng.next()) * R * 0.85;
      ctx.fillStyle = rng.chance(0.6) ? shade(cols[2], rng.float(0, 0.25)) : shade(cols[0], -0.1);
      ctx.globalAlpha = rng.float(0.5, 0.9);
      ctx.beginPath(); ctx.ellipse(Math.cos(a) * d, Math.sin(a) * d, rng.float(1, 2), rng.float(0.6, 1.1), rng.float(0, TAU), 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (biome.treeType === 'blossom') {
    // Individual blossoms speckled over the pink canopy.
    for (let i = 0; i < 70; i++) {
      const a = rng.float(0, TAU), d = Math.sqrt(rng.next()) * R * 0.85;
      ctx.fillStyle = rng.pick(['#ffffff', '#ffe6ef', '#f7a9c4', '#e37ba0']);
      ctx.globalAlpha = rng.float(0.55, 0.95);
      ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, rng.float(0.8, 1.8), 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// Weeping willow seen from above: a soft dome with drooping strands fanning out.
function drawWillow(ctx, R, rng, cols) {
  const g = ctx.createRadialGradient(-R * 0.25, -R * 0.3, R * 0.1, 0, 0, R);
  g.addColorStop(0, shade(cols[2], 0.15)); g.addColorStop(0.6, cols[1]); g.addColorStop(1, rgba(cols[0], 0.9));
  ctx.fillStyle = shade(cols[0], -0.3);
  ctx.beginPath(); ctx.arc(2, 2.5, R * 0.92, 0, TAU); ctx.fill();
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, R * 0.92, 0, TAU); ctx.fill();
  ctx.lineCap = 'round';
  const n = 70;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng.float(-0.05, 0.05), r0 = R * rng.float(0.1, 0.35), r1 = R * rng.float(0.8, 1);
    const bend = rng.float(-0.18, 0.18);
    ctx.strokeStyle = i % 3 === 0 ? shade(cols[2], 0.12) : i % 3 === 1 ? cols[1] : shade(cols[0], -0.1);
    ctx.globalAlpha = rng.float(0.55, 0.95);
    ctx.lineWidth = rng.float(0.8, 1.6);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.quadraticCurveTo(Math.cos(a + bend) * (r0 + r1) / 2, Math.sin(a + bend) * (r0 + r1) / 2, Math.cos(a + bend * 0.5) * r1, Math.sin(a + bend * 0.5) * r1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = rgba('#ffffff', 0.12);
  ctx.beginPath(); ctx.arc(-R * 0.25, -R * 0.3, R * 0.3, 0, TAU); ctx.fill();
}

// ---- Escort convoy: armored supply truck, nose pointing +x -------------------------------
const CONVOY_W = 92, CONVOY_H = 48;
function makeConvoySprite(color) {
  const { c, ctx } = spriteCanvas(CONVOY_W, CONVOY_H);
  ctx.translate(CONVOY_W / 2, CONVOY_H / 2);
  const rng = new RNG(99);
  // Wheels peeking out from under the chassis.
  ctx.fillStyle = '#1d1c1a';
  for (const x of [-30, -18, 24]) for (const s of [-1, 1]) { roundRectPath(ctx, x - 5, s < 0 ? -21 : 15, 10, 6, 2); ctx.fill(); }
  // Chassis.
  ctx.fillStyle = '#2d2b27';
  roundRectPath(ctx, -42, -16, 84, 32, 4); ctx.fill();
  // Cargo bed with a tarp over crates.
  let g = ctx.createLinearGradient(-38, -14, -38, 14);
  g.addColorStop(0, '#8c8a5c'); g.addColorStop(0.5, '#6e6c46'); g.addColorStop(1, '#4b4a30');
  ctx.fillStyle = g;
  roundRectPath(ctx, -39, -14, 52, 28, 3); ctx.fill();
  ctx.strokeStyle = 'rgba(30,28,18,0.6)'; ctx.lineWidth = 0.9;
  for (let x = -33; x < 12; x += 9) { ctx.beginPath(); ctx.moveTo(x, -14); ctx.quadraticCurveTo(x + 1.5, 0, x, 14); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(230,220,180,0.55)'; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(-39, -6); ctx.lineTo(13, 6); ctx.moveTo(-39, 6); ctx.lineTo(13, -6); ctx.stroke();
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rng.float(0.05, 0.15)})`;
    ctx.beginPath(); ctx.arc(rng.float(-36, 10), rng.float(-11, 11), rng.float(1.5, 4), 0, TAU); ctx.fill();
  }
  // Cab in team colours.
  g = ctx.createLinearGradient(14, -15, 40, 15);
  g.addColorStop(0, shade(color.main, 0.2)); g.addColorStop(1, shade(color.main, -0.25));
  ctx.fillStyle = g;
  roundRectPath(ctx, 15, -15, 26, 30, 4); ctx.fill();
  ctx.fillStyle = shade(color.dark, -0.1);
  ctx.fillRect(15, -15, 4, 30);
  // Windshield and roof hatch.
  g = ctx.createLinearGradient(33, 0, 40, 0);
  g.addColorStop(0, '#2b4a5e'); g.addColorStop(1, '#8fc4dc');
  ctx.fillStyle = g;
  roundRectPath(ctx, 33, -11, 6, 22, 2); ctx.fill();
  ctx.fillStyle = shade(color.main, -0.35);
  ctx.beginPath(); ctx.arc(24, 0, 4, 0, TAU); ctx.fill();
  // Hazard chevrons on the bumper, headlights.
  ctx.save();
  roundRectPath(ctx, 40, -14, 3, 28, 1); ctx.clip();
  for (let y = -16; y < 16; y += 5) {
    ctx.fillStyle = (Math.round(y / 5) % 2) ? '#f0b23a' : '#1c1c1c';
    ctx.fillRect(40, y, 3, 5);
  }
  ctx.restore();
  ctx.fillStyle = '#fff4c4';
  ctx.fillRect(40.5, -13, 2, 3); ctx.fillRect(40.5, 10, 2, 3);
  // Team stripe along the bed.
  ctx.fillStyle = rgba(color.ui, 0.85);
  ctx.fillRect(-39, -15.5, 52, 2); ctx.fillRect(-39, 13.5, 52, 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
  roundRectPath(ctx, -42, -16, 84, 32, 4); ctx.stroke();
  return c;
}

// ---- FX sprites ----------------------------------------------------------------------
const FxArt = {
  soft: null, flash: null, ring: null,
  init() {
    if (this.soft) return;
    const s = 64;
    this.soft = makeCanvas(s, s);
    let ctx = this.soft.getContext('2d');
    let g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);

    // Tinted soft sprites (drawImage can't tint, so pre-bake a few).
    this.tints = {};
    for (const [k, col] of Object.entries({
      smoke: '#8a8680', dark: '#2e2a26', fire: '#ff9a3c', glow: '#ffd27a', dust: '#b59a72', snow: '#ffffff', spark: '#ffe6a0', screen: '#d9d6cf', blue: '#8fd0ff', purple: '#b98cff', red: '#ff3b2f', marker: '#c4573a',
    })) {
      const c = makeCanvas(s, s);
      const cx = c.getContext('2d');
      cx.drawImage(this.soft, 0, 0);
      cx.globalCompositeOperation = 'source-in';
      cx.fillStyle = col;
      cx.fillRect(0, 0, s, s);
      this.tints[k] = c;
    }

    // Guided missile, nose pointing +x (drawn at 2x for crisp rotation).
    this.missile = makeCanvas(40, 18);
    ctx = this.missile.getContext('2d');
    ctx.scale(2, 2);
    ctx.translate(1, 4.5);
    ctx.fillStyle = '#3a3d3a';
    ctx.beginPath(); ctx.moveTo(2, 0); ctx.lineTo(5.5, -4.2); ctx.lineTo(7, -4.2); ctx.lineTo(6.5, 0); ctx.lineTo(7, 4.2); ctx.lineTo(5.5, 4.2); ctx.closePath(); ctx.fill();
    g = ctx.createLinearGradient(0, -2.2, 0, 2.2);
    g.addColorStop(0, '#e9e6dc'); g.addColorStop(0.45, '#b8b4a6'); g.addColorStop(1, '#6d6a60');
    ctx.fillStyle = g;
    roundRectPath(ctx, 1.5, -2.2, 12.5, 4.4, 1.6);
    ctx.fill();
    ctx.fillStyle = '#e8b04a';
    ctx.fillRect(4.5, -2.2, 1.6, 4.4);
    g = ctx.createLinearGradient(13, 0, 18, 0);
    g.addColorStop(0, '#d8453a'); g.addColorStop(1, '#8a1f18');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(13.5, -2.2); ctx.quadraticCurveTo(18, -1, 18.5, 0); ctx.quadraticCurveTo(18, 1, 13.5, 2.2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.fillRect(0, -1.4, 1.6, 2.8);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 0.5;
    roundRectPath(ctx, 1.5, -2.2, 12.5, 4.4, 1.6);
    ctx.stroke();

    // Bazooka rocket: stubbier, olive with a red warhead.
    this.rocket = makeCanvas(32, 14);
    ctx = this.rocket.getContext('2d');
    ctx.scale(2, 2);
    ctx.translate(1, 3.5);
    ctx.fillStyle = '#2f2e2a';
    ctx.beginPath(); ctx.moveTo(1, 0); ctx.lineTo(4, -3.3); ctx.lineTo(5, -3.3); ctx.lineTo(4.5, 0); ctx.lineTo(5, 3.3); ctx.lineTo(4, 3.3); ctx.closePath(); ctx.fill();
    g = ctx.createLinearGradient(0, -1.8, 0, 1.8);
    g.addColorStop(0, '#9aa06a'); g.addColorStop(1, '#4b4f2e');
    ctx.fillStyle = g;
    roundRectPath(ctx, 1, -1.8, 9.5, 3.6, 1.2); ctx.fill();
    ctx.fillStyle = '#c8402f';
    ctx.beginPath(); ctx.moveTo(10, -1.8); ctx.quadraticCurveTo(14, 0, 10, 1.8); ctx.closePath(); ctx.fill();

    // Wire-guided missile: olive body, big cruciform wings, yellow HEAT band.
    this.wire = makeCanvas(44, 22);
    ctx = this.wire.getContext('2d');
    ctx.scale(2, 2);
    ctx.translate(1, 5.5);
    ctx.fillStyle = '#3c3f2c';
    ctx.beginPath(); ctx.moveTo(2, 0); ctx.lineTo(4, -5.2); ctx.lineTo(7.5, -5.2); ctx.lineTo(8, 0); ctx.lineTo(7.5, 5.2); ctx.lineTo(4, 5.2); ctx.closePath(); ctx.fill();
    g = ctx.createLinearGradient(0, -2, 0, 2);
    g.addColorStop(0, '#a4a878'); g.addColorStop(0.5, '#6f7449'); g.addColorStop(1, '#3d4026');
    ctx.fillStyle = g;
    roundRectPath(ctx, 1, -2, 14, 4, 1.5); ctx.fill();
    ctx.fillStyle = '#e0b43a';
    ctx.fillRect(10.5, -2, 1.4, 4);
    ctx.fillStyle = '#50533a';
    ctx.beginPath(); ctx.moveTo(14.5, -2); ctx.quadraticCurveTo(19.5, -1, 20, 0); ctx.quadraticCurveTo(19.5, 1, 14.5, 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ff9a3c';
    ctx.fillRect(0, -0.9, 1.2, 1.8);

    // Fighter-bomber seen from above: olive drab and invasion stripes (the propeller is drawn live).
    this.plane = makeCanvas(240, 200);
    ctx = this.plane.getContext('2d');
    ctx.scale(2, 2);
    ctx.translate(60, 50);
    const wing = () => { ctx.beginPath(); ctx.moveTo(8, -3); ctx.lineTo(10, -46); ctx.quadraticCurveTo(4, -50, -2, -46); ctx.lineTo(-8, -3); ctx.lineTo(-8, 3); ctx.lineTo(-2, 46); ctx.quadraticCurveTo(4, 50, 10, 46); ctx.lineTo(8, 3); ctx.closePath(); };
    g = ctx.createLinearGradient(0, -46, 0, 46);
    g.addColorStop(0, '#6f7147'); g.addColorStop(0.5, '#5b5e3a'); g.addColorStop(1, '#43462b');
    ctx.fillStyle = g; wing(); ctx.fill();
    ctx.save(); wing(); ctx.clip();
    for (let k = 0; k < 5; k++) { ctx.fillStyle = k % 2 ? '#1a1a18' : '#e8e4d8'; ctx.fillRect(-12 + k * 3.2, -60, 3.2, 120); }
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 0.8; wing(); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-4, -42, 1, 38); ctx.fillRect(-4, 4, 1, 38);
    // Tailplane.
    ctx.fillStyle = '#595c38';
    ctx.beginPath(); ctx.moveTo(-36, -2); ctx.lineTo(-38, -18); ctx.lineTo(-44, -18); ctx.lineTo(-45, 18); ctx.lineTo(-38, 18); ctx.lineTo(-36, 2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.stroke();
    // Fuselage.
    g = ctx.createLinearGradient(0, -6, 0, 6);
    g.addColorStop(0, '#8b8d5c'); g.addColorStop(0.5, '#62653f'); g.addColorStop(1, '#3a3c24');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(26, -5); ctx.quadraticCurveTo(30, 0, 26, 5); ctx.lineTo(-10, 6); ctx.quadraticCurveTo(-40, 3, -46, 0); ctx.quadraticCurveTo(-40, -3, -10, -6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
    // Canopy, cowling ring, exhausts, bombs under the wings.
    g = ctx.createLinearGradient(-6, -3, 2, 3);
    g.addColorStop(0, '#d9ecf5'); g.addColorStop(1, '#4f6b78');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(-3, 0, 7, 2.8, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#2c2d22';
    ctx.fillRect(20, -5.4, 1.6, 10.8);
    ctx.fillStyle = '#1c1c1a';
    for (const y of [-4.5, 3.3]) for (let k = 0; k < 3; k++) ctx.fillRect(12 - k * 3, y, 2, 1.2);
    ctx.fillStyle = '#3a3a36';
    for (const y of [-22, 22]) { roundRectPath(ctx, -4, y - 2, 13, 4, 2); ctx.fill(); }
    ctx.fillStyle = '#2a2a26';
    ctx.beginPath(); ctx.arc(28, 0, 2.4, 0, TAU); ctx.fill();

    this.planeShadow = makeCanvas(240, 200);
    ctx = this.planeShadow.getContext('2d');
    ctx.drawImage(this.plane, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 240, 200);

    // Muzzle flash star.
    const f = 96;
    this.flash = makeCanvas(f, f);
    ctx = this.flash.getContext('2d');
    ctx.translate(f / 2, f / 2);
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, f / 2);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(0.25, 'rgba(255,220,120,0.9)');
    g.addColorStop(0.6, 'rgba(255,140,40,0.35)');
    g.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    const spikes = 7;
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * TAU, d = i % 2 ? f * 0.14 : f * (i === 0 ? 0.5 : 0.3);
      i ? ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d) : ctx.moveTo(Math.cos(a) * d, Math.sin(a) * d);
    }
    ctx.closePath();
    ctx.fill();
  },
};
