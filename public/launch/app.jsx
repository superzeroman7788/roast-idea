// app.jsx — composes the roast-idea JARVIS launch video

function AmbientHud() {
  const t = useTime();
  // global intensity: dims slightly during brand outro
  const out = clamp((t - 21.6) / 1.2, 0, 1);
  const base = 1 - out * 0.5;
  // heat morph of ambient color during roast
  const heat = clamp((t - 13.0) / 1.6, 0, 1) * (1 - clamp((t - 17.4) / 1.4, 0, 1));
  const ambColor = mixHex(COL.cyan, COL.amber, heat * 0.55);
  // rings get more energetic during roast
  const spin = 1 + heat * 1.4;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: base }}>
      <DotGrid opacity={0.9} />
      <RadarSweep size={820} speed={42 * spin} color={ambColor} opacity={0.42} />
      {/* big slow outer rings */}
      <Ring r={470} stroke={1} color={COL.cyanDim} dash="2 16" speed={-4 * spin} glow={3} opacity={0.6} />
      <ArcSet r={440} color={ambColor} speed={-6 * spin} stroke={2} opacity={0.7} />
      <TickRing r={410} count={90} len={9} color={ambColor} opacity={0.4} speed={2 * spin} />
      <Ring r={355} stroke={1.5} color={COL.cyan} dash="3 22" speed={9 * spin} glow={4} opacity={0.55} />
      <Particles opacity={0.85} color={ambColor} />
      <FrameChrome opacity={0.9} />
      <Scanlines opacity={0.45} />
    </div>
  );
}

function CoreLayer() {
  const t = useTime();
  // present from idea scene to verdict end, then fade for brand
  const appear = clamp((t - 3.7) / 0.7, 0, 1);
  // fade out as the verdict gauge takes over so the score reads cleanly
  const out = 1 - clamp((t - 17.5) / 0.9, 0, 1);
  const op = appear * out;
  if (op <= 0.01) return null;
  const heat = clamp((t - 13.0) / 1.6, 0, 1) * (1 - clamp((t - 17.4) / 1.2, 0, 1));
  // grows a touch when council assembles
  const scale = interpolate([3.7, 5, 12, 17.5], [0.7, 1, 1.05, 1.18], Easing.easeInOutCubic)(t);
  return <CoreGlow heat={heat} verdict={0} scale={scale} opacity={op} />;
}

function Root() {
  const t = useTime();
  const rootRef = React.useRef(null);
  React.useEffect(() => {
    const el = rootRef.current;
    if (el) el.setAttribute('data-screen-label', `t=${t.toFixed(0)}s`);
  }, [Math.floor(t)]);
  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} data-screen-label="t=0s">
      <AmbientHud />
      <CoreLayer />
      <Sprite start={0} end={3.8}><BootScene /></Sprite>
      <Sprite start={3.6} end={7.6}><IdeaScene /></Sprite>
      <Sprite start={7.3} end={20.4}><CouncilLayer /></Sprite>
      <Sprite start={12.6} end={17.8}><RoastScene /></Sprite>
      <Sprite start={17.6} end={20.6}><VerdictScene /></Sprite>
      <Sprite start={19.9} end={23}><BrandScene /></Sprite>
    </div>
  );
}

function App() {
  return (
    <Stage width={1920} height={1080} duration={23} background="#04070e" persistKey="roastidea" fps={60}>
      <Root />
    </Stage>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
