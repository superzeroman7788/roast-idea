// hud.jsx — JARVIS-style holographic HUD primitives for roast-idea
// Exports to window. Loaded after animations.jsx (provides useTime, Easing, clamp, interpolate).

const RAD = Math.PI / 180;
const polar = (cx, cy, r, deg) => [cx + r * Math.cos(deg * RAD), cy + r * Math.sin(deg * RAD)];
const CX = 960, CY = 540;

// Palette
const COL = {
  cyan: '#4fd8ff',
  cyanBright: '#aef2ff',
  cyanDim: '#1c6f93',
  amber: '#ff9d3d',
  amberBright: '#ffce86',
  green: '#5dffb0',
  ink: '#dff1ff',
  inkDim: 'rgba(180,224,245,0.55)',
};
const lerp = (a, b, t) => a + (b - a) * t;
// hex lerp
function mixHex(h1, h2, t) {
  const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r1, g1, b1] = p(h1), [r2, g2, b2] = p(h2);
  const c = (a, b) => Math.round(lerp(a, b, t)).toString(16).padStart(2, '0');
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

const F_DISP = "'Chakra Petch', sans-serif";
const F_MONO = "'Share Tech Mono', monospace";
const F_CJK = "'Noto Sans SC', sans-serif";

// ── Vignette + atmosphere ───────────────────────────────────────────────────
function Vignette() {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse 70% 60% at 50% 48%, rgba(20,60,90,0.28), rgba(4,7,14,0) 60%)',
      }} />
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse 100% 100% at 50% 50%, rgba(4,7,14,0) 52%, rgba(2,4,9,0.9) 100%)',
      }} />
    </div>
  );
}

// faint scanlines
function Scanlines({ opacity = 0.5 }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, pointerEvents: 'none', opacity,
      backgroundImage: 'repeating-linear-gradient(0deg, rgba(120,210,255,0.05) 0px, rgba(120,210,255,0.05) 1px, transparent 2px, transparent 4px)',
      mixBlendMode: 'screen',
    }} />
  );
}

// ── Dot grid with subtle parallax breathing ─────────────────────────────────
function DotGrid({ opacity = 1 }) {
  const t = useTime();
  const drift = Math.sin(t * 0.3) * 6;
  return (
    <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, opacity }}>
      <defs>
        <radialGradient id="gridFade" cx="50%" cy="48%" r="55%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
          <stop offset="70%" stopColor="#fff" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <pattern id="dots" width="46" height="46" patternUnits="userSpaceOnUse" patternTransform={`translate(${drift} ${drift * 0.5})`}>
          <circle cx="1.2" cy="1.2" r="1.2" fill={COL.cyan} fillOpacity="0.5" />
        </pattern>
        <mask id="gridMask"><rect width="1920" height="1080" fill="url(#gridFade)" /></mask>
      </defs>
      <rect width="1920" height="1080" fill="url(#dots)" mask="url(#gridMask)" />
    </svg>
  );
}

// ── Rotating dashed ring ─────────────────────────────────────────────────────
function Ring({ r, stroke = 1.5, color = COL.cyan, dash, speed = 8, opacity = 1, glow = 6, dir = 1, cx = CX, cy = CY }) {
  const t = useTime();
  const angle = (t * speed * dir) % 360;
  return (
    <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, opacity, filter: glow ? `drop-shadow(0 0 ${glow}px ${color})` : 'none' }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={dash} transform={`rotate(${angle} ${cx} ${cy})`} strokeLinecap="round" />
    </svg>
  );
}

// ── Radial tick ring ─────────────────────────────────────────────────────────
function TickRing({ r, count = 60, len = 10, stroke = 1.5, color = COL.cyan, speed = 0, opacity = 0.8, big = 5, cx = CX, cy = CY }) {
  const t = useTime();
  const angle = (t * speed) % 360;
  const ticks = [];
  for (let i = 0; i < count; i++) {
    const a = (360 / count) * i;
    const isBig = i % big === 0;
    const l = isBig ? len * 1.7 : len;
    const [x1, y1] = polar(cx, cy, r, a);
    const [x2, y2] = polar(cx, cy, r - l, a);
    ticks.push(<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={isBig ? stroke * 1.4 : stroke} strokeOpacity={isBig ? 1 : 0.5} />);
  }
  return (
    <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, opacity, filter: `drop-shadow(0 0 3px ${color})` }}>
      <g transform={`rotate(${angle} ${cx} ${cy})`}>{ticks}</g>
    </svg>
  );
}

// ── Arc segments (partial brackets) ─────────────────────────────────────────
function ArcSet({ r, color = COL.cyan, speed = -5, opacity = 0.9, stroke = 2.5, cx = CX, cy = CY, segs = [[10, 60], [120, 50], [200, 35], [280, 45]] }) {
  const t = useTime();
  const angle = (t * speed) % 360;
  const arc = (start, sweep, key) => {
    const [x1, y1] = polar(cx, cy, r, start);
    const [x2, y2] = polar(cx, cy, r, start + sweep);
    const large = sweep > 180 ? 1 : 0;
    return <path key={key} d={`M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" />;
  };
  return (
    <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, opacity, filter: `drop-shadow(0 0 5px ${color})` }}>
      <g transform={`rotate(${angle} ${cx} ${cy})`}>{segs.map((s, i) => arc(s[0], s[1], i))}</g>
    </svg>
  );
}

// ── Radar sweep (conic gradient) ─────────────────────────────────────────────
function RadarSweep({ size = 760, speed = 45, color = COL.cyan, opacity = 0.5, cx = CX, cy = CY }) {
  const t = useTime();
  const angle = (t * speed) % 360;
  return (
    <div style={{
      position: 'absolute', left: cx - size / 2, top: cy - size / 2, width: size, height: size,
      borderRadius: '50%', opacity, pointerEvents: 'none',
      background: `conic-gradient(from ${angle}deg, transparent 0deg, transparent 300deg, ${color}22 340deg, ${color}66 358deg, transparent 360deg)`,
      mixBlendMode: 'screen',
      WebkitMaskImage: 'radial-gradient(circle, #000 0%, #000 92%, transparent 100%)',
      maskImage: 'radial-gradient(circle, #000 0%, #000 92%, transparent 100%)',
    }} />
  );
}

// ── HUD corner brackets + frame labels ──────────────────────────────────────
function Corner({ x, y, sx, sy }) {
  return (
    <g stroke={COL.cyan} strokeWidth="2" fill="none" opacity="0.8" style={{ filter: `drop-shadow(0 0 3px ${COL.cyan})` }}>
      <path d={`M ${x} ${y + sy * 46} L ${x} ${y} L ${x + sx * 46} ${y}`} />
      <path d={`M ${x + sx * 14} ${y + sy * 14} L ${x + sx * 14} ${y + sy * 30}`} strokeWidth="3" opacity="0.6" />
    </g>
  );
}
function FrameChrome({ opacity = 1 }) {
  const t = useTime();
  const M = 52;
  return (
    <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, opacity }}>
      <Corner x={M} y={M} sx={1} sy={1} />
      <Corner x={1920 - M} y={M} sx={-1} sy={1} />
      <Corner x={M} y={1080 - M} sx={1} sy={-1} />
      <Corner x={1920 - M} y={1080 - M} sx={-1} sy={-1} />
      <text x={M + 4} y={M - 14} fill={COL.cyan} fontFamily={F_MONO} fontSize="14" opacity="0.7" letterSpacing="2">ROAST-IDEA // COUNCIL OS</text>
      <text x={1920 - M} y={M - 14} fill={COL.cyan} fontFamily={F_MONO} fontSize="14" opacity="0.7" letterSpacing="2" textAnchor="end">{`SYS ${(t).toFixed(2)}s`}</text>
      <text x={M + 4} y={1080 - M + 26} fill={COL.cyan} fontFamily={F_MONO} fontSize="13" opacity="0.55" letterSpacing="2">LAT 31.23°N · LON 121.47°E · LINK ▲ SECURE</text>
      <text x={1920 - M} y={1080 - M + 26} fill={COL.cyan} fontFamily={F_MONO} fontSize="13" opacity="0.55" letterSpacing="2" textAnchor="end">v2.6 · NEURAL CORE ONLINE</text>
    </svg>
  );
}

// ── Floating particles ───────────────────────────────────────────────────────
const PARTICLES = Array.from({ length: 46 }, (_, i) => {
  const a = (i * 137.5) % 360;
  const rr = 180 + ((i * 53) % 620);
  const [x, y] = polar(CX, CY, rr, a);
  return { x, y, r: 0.6 + (i % 4) * 0.5, ph: (i * 0.7) % (Math.PI * 2), sp: 0.4 + (i % 5) * 0.12, amp: 6 + (i % 6) * 3 };
});
function Particles({ opacity = 1, color = COL.cyan }) {
  const t = useTime();
  return (
    <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, opacity, filter: `drop-shadow(0 0 3px ${color})` }}>
      {PARTICLES.map((p, i) => {
        const dy = Math.sin(t * p.sp + p.ph) * p.amp;
        const dx = Math.cos(t * p.sp * 0.7 + p.ph) * p.amp * 0.6;
        const tw = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 1.6 + p.ph));
        return <circle key={i} cx={p.x + dx} cy={p.y + dy} r={p.r} fill={color} fillOpacity={tw} />;
      })}
    </svg>
  );
}

// ── Central core (arc-reactor orb), color morphs by global time ─────────────
// heat: 0 cool cyan → 1 hot amber.  verdict: 0..1 cools toward green.
function CoreGlow({ heat = 0, verdict = 0, scale = 1, opacity = 1 }) {
  const t = useTime();
  const pulse = 1 + Math.sin(t * 2.4) * 0.03 + heat * Math.sin(t * 9) * 0.02;
  let main = mixHex(COL.cyan, COL.amber, heat);
  if (verdict > 0) main = mixHex(main, COL.green, verdict);
  let bright = mixHex(COL.cyanBright, COL.amberBright, heat);
  if (verdict > 0) bright = mixHex(bright, '#c7ffe6', verdict);
  const s = scale * pulse;
  const ringSpin = t * 60;
  return (
    <div style={{ position: 'absolute', left: CX, top: CY, transform: `translate(-50%,-50%) scale(${s})`, opacity, pointerEvents: 'none' }}>
      {/* outer glow */}
      <div style={{ position: 'absolute', left: -260, top: -260, width: 520, height: 520, borderRadius: '50%', background: `radial-gradient(circle, ${main}55 0%, ${main}18 38%, transparent 68%)`, filter: 'blur(8px)' }} />
      <svg width="420" height="420" viewBox="0 0 420 420" style={{ position: 'absolute', left: -210, top: -210, filter: `drop-shadow(0 0 14px ${main})` }}>
        {/* iris segments */}
        <g transform={`rotate(${ringSpin} 210 210)`}>
          {Array.from({ length: 12 }, (_, i) => {
            const a = i * 30;
            const [x1, y1] = polar(210, 210, 86, a);
            const [x2, y2] = polar(210, 210, 116, a + 12);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={bright} strokeWidth="4" strokeLinecap="round" opacity="0.85" />;
          })}
        </g>
        <g transform={`rotate(${-ringSpin * 0.6} 210 210)`}>
          <circle cx="210" cy="210" r="70" fill="none" stroke={main} strokeWidth="2.5" strokeDasharray="3 8" />
        </g>
        <circle cx="210" cy="210" r="128" fill="none" stroke={main} strokeWidth="1.5" opacity="0.5" />
        {/* inner core */}
        <circle cx="210" cy="210" r="52" fill={`url(#coreFill)`} />
        <defs>
          <radialGradient id="coreFill" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="40%" stopColor={bright} />
            <stop offset="100%" stopColor={main} stopOpacity="0.2" />
          </radialGradient>
        </defs>
      </svg>
    </div>
  );
}

// ── Council node marker ──────────────────────────────────────────────────────
function NodeMarker({ x, y, color, ignite }) {
  const t = useTime();
  const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 3));
  const r = 5 + 12 * ignite;
  return (
    <svg width="120" height="120" style={{ position: 'absolute', left: x - 60, top: y - 60, filter: `drop-shadow(0 0 7px ${color})`, opacity: ignite }}>
      <g transform={`rotate(${t * 40} 60 60)`}>
        {[0, 60, 120, 180, 240, 300].map((a) => {
          const [x1, y1] = polar(60, 60, 22, a);
          const [x2, y2] = polar(60, 60, 28, a);
          return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth="2" opacity={0.8} />;
        })}
      </g>
      <circle cx="60" cy="60" r="18" fill="none" stroke={color} strokeWidth="1.5" opacity="0.7" />
      <circle cx="60" cy="60" r={r} fill={color} fillOpacity={pulse * 0.9} />
      <circle cx="60" cy="60" r={r * 0.4} fill="#fff" fillOpacity={pulse} />
    </svg>
  );
}

// ── Beam from node to core ───────────────────────────────────────────────────
function Beam({ x, y, color, intensity = 1, travel = 0 }) {
  const t = useTime();
  // endpoint just outside core
  const dx = CX - x, dy = CY - y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const ex = CX - ux * 150, ey = CY - uy * 150;
  // traveling pulse position
  const pp = (t * 0.8 + travel) % 1;
  const px = lerp(x, ex, pp), py = lerp(y, ey, pp);
  return (
    <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, opacity: intensity, filter: `drop-shadow(0 0 4px ${color})` }}>
      <line x1={x} y1={y} x2={ex} y2={ey} stroke={color} strokeWidth="1.5" strokeOpacity={0.35 + 0.25 * intensity} strokeDasharray="2 7" />
      <circle cx={px} cy={py} r="3.5" fill={color} fillOpacity="0.95" />
    </svg>
  );
}

Object.assign(window, {
  polar, CX, CY, COL, lerp, mixHex, F_DISP, F_MONO, F_CJK,
  Vignette, Scanlines, DotGrid, Ring, TickRing, ArcSet, RadarSweep,
  FrameChrome, Particles, CoreGlow, NodeMarker, Beam,
});
