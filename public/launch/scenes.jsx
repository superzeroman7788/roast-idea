// scenes.jsx — narrative scenes for the roast-idea launch video
// Loaded after hud.jsx. Uses window globals: useTime, useSprite, Easing, clamp, interpolate, COL, polar, CX, CY, fonts, HUD primitives.

const IDEA_TEXT = '做一个帮你写小红书文案的 AI';

// 5 council advisors arranged as a pentagon, top-start
const COUNCIL = [
  { name: '批判者',   role: 'THE CRITIC',    angle: -90, color: '#4fd8ff', roast: '这赛道早就挤满了。' },
  { name: '投资人',   role: 'THE INVESTOR',  angle: -18, color: '#8fb4ff', roast: '用户凭什么为文案付费？' },
  { name: '远见者',   role: 'THE VISIONARY', angle: 54,  color: '#c89bff', roast: '大模型自己就会写了。' },
  { name: '体验官',   role: 'THE USER',      angle: 126, color: '#5dffb0', roast: '比直接用 ChatGPT 强在哪？' },
  { name: '现实派',   role: 'THE REALIST',   angle: 198, color: '#ffb454', roast: '获客成本会要你的命。' },
];
const NODE_R = 372;
const nodePos = (a) => polar(CX, CY, NODE_R, a);

// small helper: monospace HUD label
function Hud({ children, x, y, size = 14, color = COL.cyan, anchor = 'start', op = 0.8, ls = 2, font = F_MONO, weight = 400 }) {
  return (
    <div style={{
      position: 'absolute', left: x, top: y, fontFamily: font, fontSize: size, color,
      opacity: op, letterSpacing: ls, fontWeight: weight,
      transform: anchor === 'middle' ? 'translateX(-50%)' : anchor === 'end' ? 'translateX(-100%)' : 'none',
      textShadow: `0 0 8px ${color}99`, whiteSpace: 'nowrap',
    }}>{children}</div>
  );
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
function BootScene() {
  const { localTime: lt, progress } = useSprite();
  // point of light expands, rings assemble
  const flash = clamp(interpolate([0, 0.25, 0.5], [0, 1, 0.55])(lt / 1), 0, 1);
  const dotScale = interpolate([0, 0.5, 1.4], [0.1, 1, 1], Easing.easeOutExpo)(lt);
  const ringsIn = clamp((lt - 0.6) / 1.0, 0, 1);
  const titleIn = clamp((lt - 1.5) / 0.8, 0, 1);
  const fade = 1 - clamp((lt - 3.0) / 0.7, 0, 1);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: fade }}>
      {/* central ignition flash */}
      <div style={{
        position: 'absolute', left: CX, top: CY, transform: `translate(-50%,-50%) scale(${dotScale})`,
        width: 260, height: 260, borderRadius: '50%',
        background: `radial-gradient(circle, #fff 0%, ${COL.cyanBright} 18%, ${COL.cyan}88 38%, transparent 70%)`,
        filter: 'blur(2px)', opacity: 0.4 + flash * 0.6,
      }} />
      {/* assembling rings */}
      <div style={{ opacity: ringsIn }}>
        <Ring r={130 * ringsIn + 30} stroke={2} color={COL.cyan} dash="4 10" speed={26} glow={6} />
        <Ring r={230 * ringsIn + 40} stroke={1.5} color={COL.cyanDim} dash="2 14" speed={-14} dir={1} glow={4} />
        <TickRing r={300 * ringsIn + 30} count={72} len={10} color={COL.cyan} opacity={0.6 * ringsIn} speed={6} />
      </div>
      {/* boot text */}
      <div style={{ position: 'absolute', left: CX, top: CY + 220, transform: 'translateX(-50%)', textAlign: 'center', opacity: titleIn }}>
        <div style={{ fontFamily: F_MONO, color: COL.cyan, fontSize: 18, letterSpacing: 6, textShadow: `0 0 10px ${COL.cyan}` }}>
          {('INITIALIZING NEURAL COUNCIL').slice(0, Math.floor(lt * 16))}<span style={{ opacity: lt % 0.6 > 0.3 ? 1 : 0 }}>_</span>
        </div>
      </div>
      <Hud x={CX} y={CY - 250} anchor="middle" size={13} color={COL.inkDim} ls={4}>BOOT SEQUENCE 路 0x01</Hud>
    </div>
  );
}

// ── IDEA ─────────────────────────────────────────────────────────────────────
function IdeaScene() {
  const { localTime: lt } = useSprite();
  const panelIn = clamp(lt / 0.6, 0, 1);
  const chars = Math.floor(clamp((lt - 0.4) / 1.6, 0, 1) * IDEA_TEXT.length);
  const scan = clamp((lt - 2.0) / 1.2, 0, 1);
  const collapse = clamp((lt - 3.2) / 0.7, 0, 1);
  const fade = 1 - clamp((lt - 3.4) / 0.6, 0, 1);
  const panelScale = lerp(1, 0.6, Easing.easeInCubic(collapse));
  const panelOp = panelIn * (1 - collapse * 0.7) * fade;
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Hud x={CX} y={CY - 230} anchor="middle" size={14} color={COL.cyan} ls={5} op={panelIn}>● IDEA RECEIVED · 待审议</Hud>
      {/* idea panel */}
      <div style={{
        position: 'absolute', left: CX, top: CY - 44, transform: `translate(-50%,-50%) scale(${panelScale})`,
        opacity: panelOp,
        padding: '26px 42px', minWidth: 520, textAlign: 'center',
        background: 'linear-gradient(180deg, rgba(20,52,74,0.55), rgba(8,20,32,0.55))',
        border: `1px solid ${COL.cyan}66`, borderRadius: 4,
        boxShadow: `0 0 40px ${COL.cyan}33, inset 0 0 30px rgba(79,216,255,0.08)`,
        backdropFilter: 'blur(2px)',
      }}>
        <div style={{ fontFamily: F_MONO, fontSize: 12, letterSpacing: 3, color: COL.inkDim, marginBottom: 14 }}>USER INPUT // 提交的想法</div>
        <div style={{ fontFamily: F_CJK, fontWeight: 500, fontSize: 38, color: '#fff', lineHeight: 1.3, textShadow: `0 0 16px ${COL.cyan}` }}>
          「{IDEA_TEXT.slice(0, chars)}<span style={{ opacity: chars < IDEA_TEXT.length ? 1 : 0, color: COL.cyan }}>▌</span>」
        </div>
        {/* scan bar */}
        <div style={{ position: 'absolute', left: 0, top: `${scan * 100}%`, width: '100%', height: 2, background: `linear-gradient(90deg, transparent, ${COL.cyanBright}, transparent)`, opacity: scan > 0 && scan < 1 ? 0.9 : 0, boxShadow: `0 0 12px ${COL.cyanBright}` }} />
      </div>
      <Hud x={CX} y={CY + 150} anchor="middle" size={13} color={COL.inkDim} ls={3} op={scan * fade}>ANALYZING SEMANTICS… 提取核心命题</Hud>
    </div>
  );
}

// ── COUNCIL LAYER (nodes persist through roast + verdict) ───────────────────
function CouncilLayer() {
  const { localTime: lt } = useSprite();
  const t = useTime();
  const heat = clamp((t - 13.0) / 1.6, 0, 1) * (1 - clamp((t - 17.4) / 1.2, 0, 1));
  const banner = clamp((lt - 2.4) / 0.6, 0, 1) * (1 - clamp((lt - 4.6) / 0.6, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {COUNCIL.map((m, i) => {
        const [x, y] = nodePos(m.angle);
        const ignite = clamp((lt - (0.3 + i * 0.42)) / 0.6, 0, 1);
        const beamOn = clamp((lt - (0.7 + i * 0.42)) / 0.7, 0, 1);
        const col = mixHex(m.color, COL.amber, heat * 0.7);
        // outward label position
        const [lx, ly] = polar(CX, CY, NODE_R + 70, m.angle);
        const below = m.angle > 0 && m.angle < 180;
        return (
          <React.Fragment key={i}>
            <Beam x={x} y={y} color={col} intensity={beamOn * (0.7 + heat * 0.3)} travel={i * 0.2} />
            <NodeMarker x={x} y={y} color={col} ignite={ignite} />
            {/* label */}
            <div style={{
              position: 'absolute', left: lx, top: ly + (below ? 18 : -54),
              transform: 'translateX(-50%)', textAlign: 'center', opacity: ignite,
            }}>
              <div style={{ fontFamily: F_CJK, fontWeight: 600, fontSize: 26, color: '#fff', textShadow: `0 0 12px ${col}`, letterSpacing: 1 }}>{m.name}</div>
              <div style={{ fontFamily: F_MONO, fontSize: 12, color: col, letterSpacing: 3, marginTop: 2, opacity: 0.85 }}>{m.role}</div>
            </div>
          </React.Fragment>
        );
      })}
      {/* assembled banner */}
      <Hud x={CX} y={CY + 250} anchor="middle" size={16} color={COL.cyan} ls={5} op={banner} font={F_MONO}>
        COUNCIL ASSEMBLED · 5 ADVISORS ONLINE
      </Hud>
    </div>
  );
}

// ── ROAST ────────────────────────────────────────────────────────────────────
function RoastScene() {
  const { localTime: lt } = useSprite();
  const headIn = clamp(lt / 0.5, 0, 1) * (1 - clamp((lt - 4.4) / 0.6, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Hud x={CX} y={CY - 325} anchor="middle" size={18} color={COL.amber} ls={6} op={headIn} font={F_MONO}>⚠ CROSS-EXAMINATION // 拷问中</Hud>
      {COUNCIL.map((m, i) => {
        const [nx, ny] = nodePos(m.angle);
        const appear = 0.5 + i * 0.62;
        const a = clamp((lt - appear) / 0.5, 0, 1);
        const hold = 1 - clamp((lt - (appear + 2.6)) / 0.6, 0, 1);
        const op = a * hold;
        if (op <= 0.01) return null;
        // bubble drifts from node toward a ring around core
        const [tx, ty] = polar(CX, CY, 250, m.angle);
        const bx = lerp(nx, tx, Easing.easeOutCubic(a));
        const by = lerp(ny, ty, Easing.easeOutCubic(a));
        const below = m.angle > 0 && m.angle < 180;
        return (
          <div key={i} style={{
            position: 'absolute', left: bx, top: by, transform: `translate(-50%,${below ? '6px' : '-50%'})`,
            opacity: op,
          }}>
            <div style={{
              fontFamily: F_CJK, fontWeight: 500, fontSize: 27, color: '#fff', whiteSpace: 'nowrap',
              padding: '10px 18px', background: 'rgba(40,18,8,0.62)',
              border: `1px solid ${m.color}aa`, borderLeft: `3px solid ${m.color}`, borderRadius: 3,
              textShadow: `0 0 10px ${m.color}aa`, boxShadow: `0 0 24px ${m.color}33`,
            }}>{m.roast}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── VERDICT ──────────────────────────────────────────────────────────────────
function VerdictScene() {
  const { localTime: lt } = useSprite();
  const converge = clamp(lt / 0.6, 0, 1);
  const scoreT = clamp((lt - 0.5) / 1.2, 0, 1);
  const score = Math.round(scoreT * 64);
  const ringP = scoreT * 0.64; // 64%
  const adviceIn = clamp((lt - 1.6) / 0.6, 0, 1);
  const fade = 1 - clamp((lt - 2.4) / 0.6, 0, 1);
  const R = 96, C = 2 * Math.PI * R;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: fade }}>
      <Hud x={CX} y={CY - 210} anchor="middle" size={15} color={COL.green} ls={5} op={converge} font={F_MONO}>● VERDICT // 议会裁决</Hud>
      {/* score gauge */}
      <svg width="260" height="260" style={{ position: 'absolute', left: CX - 130, top: CY - 130, filter: `drop-shadow(0 0 10px ${COL.green})`, opacity: converge }}>
        <circle cx="130" cy="130" r={R} fill="none" stroke="rgba(93,255,176,0.18)" strokeWidth="8" />
        <circle cx="130" cy="130" r={R} fill="none" stroke={COL.green} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - ringP)} transform="rotate(-90 130 130)" />
      </svg>
      <div style={{ position: 'absolute', left: CX, top: CY - 18, transform: 'translate(-50%,-50%)', textAlign: 'center', opacity: converge }}>
        <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 76, color: '#fff', lineHeight: 1, textShadow: `0 0 18px ${COL.green}` }}>{score}<span style={{ fontSize: 34, color: COL.green }}>%</span></div>
        <div style={{ fontFamily: F_MONO, fontSize: 13, letterSpacing: 4, color: COL.green, marginTop: 4, opacity: 0.85 }}>可行性 · VIABILITY</div>
      </div>
      {/* advice */}
      <div style={{ position: 'absolute', left: CX, top: CY + 178, transform: 'translateX(-50%)', textAlign: 'center', opacity: adviceIn }}>
        <div style={{ fontFamily: F_CJK, fontWeight: 500, fontSize: 30, color: '#fff', textShadow: `0 0 14px ${COL.green}`, whiteSpace: 'nowrap' }}>
          建议 · 聚焦一个高频垂类，把工作流做深。
        </div>
      </div>
    </div>
  );
}

// ── BRAND ────────────────────────────────────────────────────────────────────
function BrandScene() {
  const { localTime: lt } = useSprite();
  const markIn = clamp(lt / 0.7, 0, 1);
  const lineW = clamp((lt - 0.5) / 0.7, 0, 1);
  const tagIn = clamp((lt - 0.9) / 0.6, 0, 1);
  const ctaIn = clamp((lt - 1.4) / 0.6, 0, 1);
  const fade = 1 - clamp((lt - 2.6) / 0.5, 0, 1);
  const ctaPulse = 0.85 + 0.15 * Math.sin(useTime() * 3);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: fade, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      {/* soft halo */}
      <div style={{ position: 'absolute', left: CX, top: CY, transform: 'translate(-50%,-50%)', width: 700, height: 360, background: `radial-gradient(ellipse, ${COL.cyan}22, transparent 70%)`, opacity: markIn }} />
      <div style={{ transform: `translateY(${(1 - markIn) * 18}px)`, opacity: markIn }}>
        <div style={{ fontFamily: F_DISP, fontWeight: 700, fontSize: 104, letterSpacing: -1, lineHeight: 1, whiteSpace: 'nowrap', textShadow: `0 0 30px ${COL.cyan}66` }}>
          <span style={{ color: '#fff' }}>roast</span><span style={{ color: COL.cyan }}>-idea</span>
        </div>
      </div>
      <div style={{ width: 460 * lineW, height: 2, marginTop: 18, background: `linear-gradient(90deg, transparent, ${COL.cyan}, transparent)`, boxShadow: `0 0 12px ${COL.cyan}` }} />
      <div style={{ fontFamily: F_CJK, fontWeight: 500, fontSize: 30, color: COL.ink, marginTop: 22, whiteSpace: 'nowrap', opacity: tagIn, transform: `translateY(${(1 - tagIn) * 10}px)`, textShadow: `0 0 14px ${COL.cyan}55` }}>
        AI 议会，帮你把想法想清楚
      </div>
      <div style={{
        marginTop: 34, opacity: ctaIn, transform: `translateY(${(1 - ctaIn) * 10}px) scale(${ctaPulse * 0.5 + 0.5})`,
        padding: '15px 38px', borderRadius: 3,
        background: `linear-gradient(180deg, ${COL.cyan}, ${COL.cyanDim})`,
        color: '#04131c', fontFamily: F_DISP, fontWeight: 700, fontSize: 22, letterSpacing: 1,
        boxShadow: `0 0 30px ${COL.cyan}88`,
      }}>
        上传你的 idea，接受拷问 →
      </div>
      <div style={{ marginTop: 18, fontFamily: F_MONO, fontSize: 14, letterSpacing: 4, color: COL.inkDim, opacity: ctaIn }}>roast-idea.ai</div>
    </div>
  );
}

Object.assign(window, {
  COUNCIL, IDEA_TEXT, nodePos, NODE_R,
  BootScene, IdeaScene, CouncilLayer, RoastScene, VerdictScene, BrandScene,
});
