import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  BrainCircuit,
  ClipboardCheck,
  Flame,
  Gauge,
  GitPullRequestArrow,
  MessagesSquare,
  RefreshCcw,
  ShieldAlert,
  Sparkles,
  Swords,
  Target,
  Zap,
} from "lucide-react";
import "./styles.css";
import {
  CouncilReport,
  RoastMode,
  SampleBrief,
  runCouncil,
  sampleBrief,
} from "./roastEngine";

function App() {
  const [mode, setMode] = useState<RoastMode>("idea");
  const [brief, setBrief] = useState(sampleBrief.idea);
  const [report, setReport] = useState<CouncilReport>(() =>
    runCouncil(sampleBrief.idea, "idea"),
  );
  const [isRunning, setIsRunning] = useState(false);
  const [apiState, setApiState] = useState("Checking Agent Group...");
  const [runError, setRunError] = useState("");

  const wordCount = useMemo(
    () => brief.trim().split(/\s+/).filter(Boolean).length,
    [brief],
  );

  useEffect(() => {
    fetch("/api/status")
      .then((response) => response.json())
      .then((data) => {
        const configured =
          data.providers?.filter((item: { configured: boolean }) => item.configured) || [];
        setApiState(
          data.agentGroup?.ok
            ? `Agent Group live · ${configured.length} enabled participant slots`
            : `Agent Group offline · ${data.agentGroup?.error || "not reachable"}`,
        );
      })
      .catch(() => setApiState("API offline: mock mode"));
  }, []);

  function runRoast() {
    setIsRunning(true);
    setRunError("");
    fetch("/api/roast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, brief }),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.error || "API request failed");
        }
        setReport(data.report);
        const configured =
          data.providers?.filter((item: { configured: boolean }) => item.configured) || [];
        setApiState(
          data.report.live?.simulated
            ? `Agent Group responded · ${data.report.live?.providerCount || configured.length} participant(s), dissent incomplete`
            : `Agent Group council · ${data.report.live?.providerCount || configured.length} real participant(s)`,
        );
      })
      .catch((error) => {
        setRunError(error?.message || "Council run failed");
        setApiState("API failed: no fake council generated");
      })
      .finally(() => {
      setIsRunning(false);
      });
  }

  function loadSample(nextMode: RoastMode) {
    setMode(nextMode);
    setBrief(sampleBrief[nextMode]);
    setReport(runCouncil(sampleBrief[nextMode], nextMode));
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="product-mark">
              <Flame size={18} />
              Roast My Idea
            </div>
            <h1>Multi-model sparring before you build.</h1>
          </div>
          <div className="hard-requirement">
            <GitPullRequestArrow size={18} />
            <span>Not roleplay: cross-vendor dissent is a product constraint. {apiState}</span>
          </div>
        </header>

        <section className="hero-grid">
          <div className="brief-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Input</p>
                <h2>Drop the pitch. Get the friction.</h2>
              </div>
              <div className="mode-switch" aria-label="Roast mode">
                <button
                  className={mode === "idea" ? "active" : ""}
                  onClick={() => loadSample("idea")}
                >
                  Idea
                </button>
                <button
                  className={mode === "copy" ? "active" : ""}
                  onClick={() => loadSample("copy")}
                >
                  Copy
                </button>
              </div>
            </div>

            <textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="Describe the product, target user, pain, distribution angle, and what you are afraid might be wrong."
            />

            <div className="brief-footer">
              <span>{wordCount} words</span>
              <button className="secondary-button" onClick={() => setBrief("")}>
                <RefreshCcw size={16} />
                Clear
              </button>
              <button
                className="primary-button"
                onClick={runRoast}
                disabled={!brief.trim() || isRunning}
              >
                {isRunning ? "Convening..." : "Run council"}
                <ArrowRight size={16} />
              </button>
            </div>
          </div>

          <VerdictCard report={report} mode={mode} />
        </section>

        {runError && (
          <section className="error-panel">
            <AlertTriangle size={18} />
            <span>{runError}</span>
          </section>
        )}

        <section className="priority-grid">
          <ReportSection
            icon={<AlertTriangle />}
            title="Fatal Assumption"
            body={report.fatalAssumption}
          />
          <ReportSection
            icon={<Target />}
            title={mode === "copy" ? "Copy Diagnosis" : "Cheapest Test"}
            body={mode === "copy" ? report.copyDiagnosis : report.cheapestTest}
          />
          <ReportSection
            icon={<ClipboardCheck />}
            title="7-Day Drill"
            body={report.sevenDayPlan}
          />
        </section>

        <section className="decision-grid">
          <ListPanel title="Top Risks" items={report.topRisks} />
          <ListPanel title="What To Cut" items={report.whatToCut} />
          <DissentMap report={report} />
        </section>

        <section className="council-row">
          {report.panel.map((member) => (
            <article className="model-card" key={member.provider}>
              <div className="model-topline">
                <span className="provider">{member.provider}</span>
                <span className={`stance stance-${member.stance.toLowerCase()}`}>
                  {member.stance}
                </span>
              </div>
              <h3>{member.role}</h3>
              <p>{member.take}</p>
              <div className="model-blindspot">
                <ShieldAlert size={15} />
                {member.blindspot}
              </div>
            </article>
          ))}
        </section>

        <section className="debate-panel">
          <div className="panel-header compact">
            <div>
              <p className="eyebrow">Forced dissent</p>
              <h2>Devil's advocate transcript</h2>
            </div>
            <Swords size={24} />
          </div>
          <div className="transcript">
            {report.debate.map((line, index) => (
              <div className="debate-line" key={`${line.speaker}-${index}`}>
                <span>{line.speaker}</span>
                <p>{line.line}</p>
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function ListPanel({ title, items }: { title: string; items: string[] }) {
  return (
    <article className="list-panel">
      <h3>{title}</h3>
      <ol>
        {(items.length ? items : ["No sharp item returned. Re-run with a narrower brief."]).map(
          (item, index) => (
            <li key={`${title}-${index}`}>{item}</li>
          ),
        )}
      </ol>
    </article>
  );
}

function DissentMap({ report }: { report: CouncilReport }) {
  return (
    <article className="list-panel dissent-map">
      <h3>Dissent Map</h3>
      <div className="dissent-list">
        {report.dissentMap.map((item, index) => (
          <div className="dissent-item" key={`${item.provider}-${index}`}>
            <div>
              <span className="dissent-provider">{item.provider}</span>
              <small>{item.model || item.status}</small>
            </div>
            <span className={`stance stance-${item.stance.toLowerCase()}`}>
              {item.stance}
            </span>
            <p>{item.keyRisk}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function VerdictCard({ report, mode }: { report: CouncilReport; mode: RoastMode }) {
  return (
    <aside className="verdict-panel">
      <div className="verdict-glow" />
      <div className="panel-header compact">
        <div>
          <p className="eyebrow">Decision</p>
          <h2>{report.verdict}</h2>
        </div>
        <BadgeCheck size={26} />
      </div>
      <p className="verdict-summary">{report.summary}</p>
      <div className="score-strip">
        <div>
          <Gauge size={16} />
          <span>{report.live?.simulated ? "Run status" : "Confidence"}</span>
        </div>
        <strong>{report.live?.simulated ? "Simulated / incomplete" : report.confidenceRange}</strong>
      </div>
      {report.live && (
        <div className={`live-badge ${report.live.simulated ? "simulated" : "live"}`}>
          <Sparkles size={15} />
          <span>
            {report.live.simulated
              ? "Agent Group is connected, but this run needs at least 2 live participants for real dissent."
              : `Agent Group run: ${report.live.configuredProviders.join(" / ")}`}
          </span>
        </div>
      )}
      <div className="truth-table">
        <Metric
          icon={<BrainCircuit />}
          label="Vendor spread"
          value={report.vendorSpread}
        />
        <Metric
          icon={<MessagesSquare />}
          label={mode === "copy" ? "Hook clarity" : "Dissent level"}
          value={mode === "copy" ? report.hookClarity : report.dissentLevel}
        />
        <Metric icon={<Zap />} label="Next action" value={report.nextAction} />
      </div>
    </aside>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="metric">
      {icon}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function ReportSection({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <article className="report-section">
      <div className="report-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
