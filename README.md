# Roast My Idea

Roast My Idea is a pre-ship sparring tool for founders, indie hackers, PMs, and creators.

It is not a normal idea validator and not one model roleplaying a council. The product constraint is:

**real cross-vendor dissent before you build.**

Users paste an idea or launch copy. The app asks Agent Group to create a structured plan, sends that plan to independent challengers, then returns the pieces that matter:

- Verdict: Ship / Fix / Pause / Kill
- Fatal assumption
- Cheapest validation test
- Top risks
- What to cut
- Dissent map
- 7-day action drill

## Current Architecture

This app is intentionally thin.

- Frontend: Vite + React
- Local API: Node HTTP server
- Model orchestration: existing local Agent Group

Default endpoints:

- Frontend: `http://localhost:5173/`
- Roast API: `http://localhost:8787`
- Agent Group: `http://127.0.0.1:8766`

The local API calls:

- `POST /api/decision/plan`
- `POST /api/decision/challenge-all`

from `AGENT_GROUP_URL`.

## Product Principles

1. **No fake council.** If fewer than two real participants respond, the run is labeled incomplete.
2. **Do not lead with a score.** Scores are easy to share but easy to distrust.
3. **The main value is action.** Fatal assumption + cheapest test + 7-day drill beat long reports.
4. **Copy mode diagnoses, it does not predict virality.**
5. **Provider transparency is part of trust.** The UI should show who responded, who failed, and what each model objected to.

## Local Dev

Install dependencies:

```bash
npm install
```

Run on the default ports:

```bash
npm run dev
```

Run a copied instance without colliding with the original API:

```bash
ROAST_API_PORT=8788 ROAST_API_PROXY=http://localhost:8788 npm run dev
```

If Vite port `5173` is busy, Vite will choose the next available port.

## Environment

The API reads `.env.local` and `.env`.

Important variables:

```bash
ROAST_API_PORT=8787
AGENT_GROUP_URL=http://127.0.0.1:8766
AGENT_GROUP_DIR=/Users/bryan/agent group/agent-group
```

Model keys live in Agent Group. Roast My Idea should not expose keys in frontend code.

## Current Refactor Notes

The current version keeps the old mock council only for static samples. A live run no longer silently falls back to mock output. If Agent Group fails, the UI reports the failure instead of pretending a council succeeded.

The report structure now foregrounds:

- Fatal Assumption
- Cheapest Test
- 7-Day Drill
- Top Risks
- What To Cut
- Dissent Map

This is the product spine. Model transcripts are supporting evidence, not the main dish.

