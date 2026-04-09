# Madden Franchise Manager — Future Architecture

> **Status:** Blueprint / Pre-implementation  
> **Covers:** Evolution from the current CLI pipeline into a full-stack web application with AI-assisted franchise management, draft class building, and (eventually) MUT tools.

---

## Table of Contents

1. [Vision & Scope](#1-vision--scope)
2. [High-Level System Architecture](#2-high-level-system-architecture)
3. [Backend API Design](#3-backend-api-design)
4. [Frontend Design](#4-frontend-design)
5. [Data Layer](#5-data-layer)
6. [AI / LLM Integration](#6-ai--llm-integration)
7. [Franchise Management Features](#7-franchise-management-features)
8. [MUT Management Features (Future)](#8-mut-management-features-future)
9. [Deployment](#9-deployment)
10. [Migration Path from CLI](#10-migration-path-from-cli)
11. [Open Questions](#11-open-questions)

---

## 1. Vision & Scope

### What this becomes

```
CLI pipeline (today)                Web Application (target)
─────────────────────               ─────────────────────────────────────────
python run.py --ros …       →       Browser GUI with real-time job progress
python roster_run.py …      →       Roster pipeline launcher in the GUI
8 numbered scripts /        →       Modular service layer + REST API
  two CLI orchestrators
Ollama local only           →       Pluggable LLM (Ollama / OpenAI / Anthropic)
One .draftclass output      →       Persistent library of draft classes & rosters
No franchise awareness      →       AI-assisted franchise advisor
No MUT support              →       MUT squad builder (future phase)
```

### Guiding principles

| Principle | Implication |
|---|---|
| **Solo / small-team friendly** | No Kubernetes, no microservice sprawl. One `docker compose up`. |
| **Works on-prem AND in cloud** | Swap storage backend (local ↔ S3), LLM backend (Ollama ↔ cloud). |
| **Python-first, Node where needed** | FastAPI owns the API; Node.js is a sidecar for Madden file I/O. |
| **Preserve the pipeline logic** | Scripts become service functions, not rewrites. |
| **Async jobs** | LLM calls are slow (minutes). The UI must never block waiting. |

---

## 2. High-Level System Architecture

### Component diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            USER'S BROWSER                                   │
│                    React + TypeScript (Vite / Next.js)                      │
│   Dashboard │ Draft Builder │ Prospect Scout │ Franchise │ Settings │ MUT   │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │  HTTPS + WebSocket
┌──────────────────────────────▼──────────────────────────────────────────────┐
│                         REVERSE PROXY / GATEWAY                             │
│                         nginx  (or Caddy / Traefik)                         │
│    • TLS termination  • Static asset serving  • /api → backend              │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
         ┌─────────────────────┴─────────────────────┐
         │                                           │
┌────────▼────────────────────────┐      ┌──────────▼──────────────────────┐
│       PYTHON BACKEND            │      │    NODE.JS SIDECAR SERVICE       │
│   FastAPI  (Python 3.11+)       │◄────►│    Express  (Node 18+)           │
│                                 │ IPC  │                                  │
│  • REST API  (/api/v1/…)        │      │  • /read-draftclass              │
│  • WebSocket (/ws/jobs/{id})    │      │  • /write-draftclass             │
│  • Pipeline orchestration       │      │  • /read-roster                  │
│  • LLM provider abstraction     │      │  • /validate-file                │
│  • Franchise advisor logic      │      │                                  │
│  • Background job runner        │      │  Uses: madden-franchise           │
│    (ARQ / Celery)               │      │        madden-draft-class-tools  │
└────────┬───────────────┬────────┘      └──────────────────────────────────┘
         │               │
   ┌─────▼─────┐   ┌─────▼──────────────────────────────────────────────────┐
   │  REDIS    │   │                    STORAGE LAYER                        │
   │  • Job Q  │   │  PostgreSQL 16          +    File Store                 │
   │  • Cache  │   │  (prospects, classes,        (local volume OR S3/R2)    │
   │  • PubSub │   │   franchise state,           .draftclass, .ros files    │
   └───────────┘   │   llm configs, jobs)                                    │
                   └─────────────────────────────────────────────────────────┘
                                      │
         ┌────────────────────────────┴────────────────────────────┐
         │                  LLM PROVIDERS                          │
         │                                                         │
         │  ┌─────────────────┐   ┌───────────────────────────┐   │
         │  │  Ollama (local) │   │  Cloud LLM (optional)      │   │
         │  │  llama3:8b      │   │  OpenAI GPT-4o             │   │
         │  │  llama3:70b     │   │  Anthropic Claude          │   │
         │  │  mistral, etc.  │   │  Google Gemini             │   │
         │  └─────────────────┘   └───────────────────────────┘   │
         └─────────────────────────────────────────────────────────┘
```

### Deployment topology options

```
┌──────────────── ON-PREM (single machine) ────────────────────────────────┐
│  docker compose up                                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐ │
│  │ nginx    │ │ backend  │ │ node-    │ │ postgres │ │ redis         │ │
│  │ :80/:443 │ │ :8000    │ │ sidecar  │ │ :5432    │ │ :6379         │ │
│  │          │ │          │ │ :3001    │ │          │ │               │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └───────────────┘ │
│  + Ollama running natively (or in container) on same host                │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────── CLOUD (AWS shown; GCP/Azure equivalent) ─────────────────┐
│  ECS Fargate (serverless containers) or EC2 with Docker Compose          │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────┐ │
│  │ ALB / CloudFront │   │ ECS Task          │   │ ECS Task             │ │
│  │ (HTTPS, CDN)     │──►│ backend + sidecar │   │ worker (job runner)  │ │
│  └──────────────────┘   └──────────────────┘   └──────────────────────┘ │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────┐ │
│  │ RDS PostgreSQL   │   │ ElastiCache Redis│   │ S3 (file store)      │ │
│  └──────────────────┘   └──────────────────┘   └──────────────────────┘ │
│  LLM: OpenAI / Anthropic API  (no Ollama GPU needed in cloud)            │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Backend API Design

### Technology choice: FastAPI

- **Why FastAPI over Django/Flask:** Native async, auto-generated OpenAPI docs, Pydantic validation, WebSocket support, faster iteration.
- **Why keep Node as a sidecar:** `madden-franchise` and `madden-draft-class-tools` are JS-only. Rather than rewriting or using Pyodide hacks, wrap them in a tiny Express server called over localhost HTTP.

### Service layer structure

```
backend/
├── main.py                     # FastAPI app factory
├── config.py                   # Settings (pydantic-settings, reads .env)
├── routers/
│   ├── pipeline.py             # POST /pipeline/run, GET /pipeline/jobs/{id}
│   ├── roster_pipeline.py      # POST /roster-pipeline/run (scripts 7→3→8)
│   ├── prospects.py            # CRUD for prospects
│   ├── draft_classes.py        # CRUD for draft classes
│   ├── roster.py               # Roster upload + query
│   ├── franchise.py            # Franchise advisor endpoints
│   ├── llm.py                  # LLM config + test endpoint
│   ├── files.py                # File upload/download (.ros, .draftclass)
│   └── mut.py                  # MUT endpoints (future)
├── services/
│   ├── pipeline_service.py       # Orchestrates draft-class pipeline (scripts 1–6) as async tasks
│   ├── roster_pipeline_service.py# Orchestrates roster pipeline (scripts 7→3→8) as async tasks
│   ├── calibration_service.py    # Wraps script 2 logic
│   ├── prospect_service.py       # Wraps scripts 1, 4
│   ├── rating_service.py         # Wraps script 5 (draft-class LLM calls)
│   ├── roster_fetch_service.py   # Wraps script 7 (nflverse roster + contract fetch)
│   ├── roster_rating_service.py  # Wraps script 8 (Madden ratings merge)
│   ├── file_service.py           # Wraps Node sidecar calls
│   ├── franchise_service.py      # Franchise analysis logic
│   ├── llm/
│   │   ├── base.py             # LLMProvider abstract base
│   │   ├── ollama_provider.py
│   │   ├── openai_provider.py
│   │   └── anthropic_provider.py
│   └── storage/
│       ├── base.py             # StorageBackend abstract base
│       ├── local_storage.py
│       └── s3_storage.py
├── models/
│   ├── db/                     # SQLAlchemy ORM models
│   └── schemas/                # Pydantic request/response schemas
├── workers/
│   ├── job_runner.py           # ARQ worker entry point
│   └── tasks/
│       ├── pipeline_tasks.py
│       ├── roster_pipeline_tasks.py
│       └── franchise_tasks.py
└── db/
    ├── session.py              # Async SQLAlchemy session
    └── migrations/             # Alembic migration scripts
```

### API endpoint reference

#### Pipeline (draft class — scripts 1–6 via `run.py`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/pipeline/run` | Start a full draft-class pipeline job. Body: `{ roster_file_id?, model?, prospects_count?, skip_steps? }` |
| `GET` | `/api/v1/pipeline/jobs` | List all pipeline jobs with status |
| `GET` | `/api/v1/pipeline/jobs/{job_id}` | Get job status, progress (0–100), current step, errors |
| `DELETE` | `/api/v1/pipeline/jobs/{job_id}` | Cancel a running job |
| `WS` | `/ws/jobs/{job_id}` | WebSocket stream for real-time step progress and log lines |

#### Roster Pipeline (scripts 7 → 3 → 8 via `roster_run.py`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/roster-pipeline/run` | Fetch current NFL rosters + contracts (script 7), extract official Madden ratings from a `.ros` file (script 3), merge into rated roster (script 8). Body: `{ roster_file_id? }` |
| `GET` | `/api/v1/roster-pipeline/jobs` | List roster pipeline jobs |
| `GET` | `/api/v1/roster-pipeline/jobs/{job_id}` | Status + progress for a roster pipeline job |
| `WS` | `/ws/jobs/{job_id}` | Shared WebSocket endpoint — same protocol as draft-class jobs |

#### Prospects

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/prospects` | List all prospects (filterable by year, position, grade) |
| `GET` | `/api/v1/prospects/{id}` | Get single prospect with full ratings |
| `PATCH` | `/api/v1/prospects/{id}` | Manual rating override |
| `POST` | `/api/v1/prospects/{id}/regenerate` | Re-run LLM for one prospect |
| `POST` | `/api/v1/prospects/import-csv` | Bulk import from CSV |

#### Draft Classes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/draft-classes` | List saved draft classes |
| `POST` | `/api/v1/draft-classes` | Create new (from prospect pool or blank) |
| `GET` | `/api/v1/draft-classes/{id}` | Get draft class with all prospects |
| `PUT` | `/api/v1/draft-classes/{id}` | Update metadata / reorder prospects |
| `DELETE` | `/api/v1/draft-classes/{id}` | Delete |
| `POST` | `/api/v1/draft-classes/{id}/export` | Trigger Node sidecar to write `.draftclass` file; returns `file_id` |
| `GET` | `/api/v1/draft-classes/{id}/download` | Download the `.draftclass` binary |

#### Roster

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/roster/upload` | Upload `.ros` file; triggers Node sidecar extraction |
| `GET` | `/api/v1/roster/{id}` | Get extracted roster as JSON |
| `GET` | `/api/v1/roster/{id}/players` | Paginated player list (filter by position/OVR) |

#### Franchise

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/franchise` | List saved franchise states |
| `POST` | `/api/v1/franchise` | Create franchise (attach roster + settings) |
| `GET` | `/api/v1/franchise/{id}/advice` | Get AI advice summary for current state |
| `POST` | `/api/v1/franchise/{id}/trade-analyzer` | Evaluate a proposed trade |
| `POST` | `/api/v1/franchise/{id}/draft-board` | Generate AI-ranked draft board |
| `GET` | `/api/v1/franchise/{id}/cap` | Salary cap analysis |
| `POST` | `/api/v1/franchise/{id}/depth-chart` | Suggest optimal depth chart |

#### LLM / Settings

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/llm/providers` | List configured providers |
| `POST` | `/api/v1/llm/providers` | Add/update a provider config |
| `POST` | `/api/v1/llm/test` | Send a test prompt, verify connectivity |
| `GET` | `/api/v1/llm/models` | List available models for active provider |

#### Files

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/files/upload` | Generic multipart upload; returns `file_id` |
| `GET` | `/api/v1/files/{file_id}` | Download stored file |
| `DELETE` | `/api/v1/files/{file_id}` | Delete stored file |

### Node.js sidecar API (internal only, not exposed to browser)

```
POST http://node-sidecar:3001/read-draftclass   { "file_path": "..." }
POST http://node-sidecar:3001/write-draftclass  { "prospects": [...], "output_path": "..." }
POST http://node-sidecar:3001/read-roster        { "file_path": "..." }
POST http://node-sidecar:3001/validate-file      { "file_path": "...", "type": "ros|draftclass" }
GET  http://node-sidecar:3001/health
```

The sidecar runs as a long-lived Express process and is the only component that ever touches `madden-franchise` and `madden-draft-class-tools`.

### WebSocket job progress protocol

```json
// Server → Client messages on /ws/jobs/{job_id}
{ "type": "step_start",    "step": 3, "label": "Extract roster ratings" }
{ "type": "progress",      "step": 3, "pct": 45, "msg": "Processing player 112/250" }
{ "type": "step_complete", "step": 3, "elapsed_s": 14 }
{ "type": "log",           "level": "warn", "msg": "No combine data for Travis Hunter" }
{ "type": "job_complete",  "output_file_id": "abc123", "elapsed_s": 847 }
{ "type": "job_failed",    "step": 5, "error": "Ollama connection refused" }
```

---

## 4. Frontend Design

### Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | **Next.js 14** (App Router) | SSR for first load, RSC for simple pages, easy API proxying |
| Language | **TypeScript** | Catches schema drift early; Pydantic → Zod type generation |
| Styling | **Tailwind CSS** + **shadcn/ui** | Fast, consistent, easily themed to a dark Madden-like palette |
| State | **Zustand** (client) + **React Query / TanStack Query** (server) | Minimal boilerplate; TanStack handles caching, refetch, mutations |
| Real-time | **native WebSocket** hook wrapping `/ws/jobs/{id}` | No extra library needed |
| Charts | **Recharts** | Lightweight, composable, good radar/bar charts for player ratings |
| File handling | **react-dropzone** | Drag-and-drop `.ros` / `.draftclass` upload |

### Page / view map

```
/                       → Dashboard
/draft-classes          → Draft Class Library
/draft-classes/new      → Draft Class Wizard (step-by-step pipeline launcher)
/draft-classes/{id}     → Draft Class Editor (prospect table + rating editor)
/draft-classes/{id}/export  → Export & Download
/prospects              → Prospect Scout (browse, filter, compare)
/prospects/{id}         → Prospect Profile (full ratings, edit, regenerate)
/roster                 → Roster Manager (upload .ros, browse players)
/franchise              → Franchise Hub (list franchises)
/franchise/{id}         → Franchise Dashboard (advisor, cap, depth chart)
/franchise/{id}/draft-board  → Interactive Draft Board
/franchise/{id}/trade   → Trade Analyzer
/settings               → LLM config, API keys, defaults
/settings/llm           → LLM provider setup
/mut                    → MUT Home (Phase 4, locked until enabled)
```

### Key UI components

#### `<PipelineWizard>`
Step-by-step card flow mirroring the 6-pipeline steps. Each card shows status (pending / running / done / error) with an animated progress bar. A live log panel streams WebSocket messages at the bottom. The user can configure each step (model, prospect count, skip flags) before launching.

```
┌─────────────────────────────────────────────────────────────┐
│  New Draft Class — 2026 Season                       [×]    │
├─────────────────────────────────────────────────────────────┤
│  ✓  Step 1  Fetch combine data          (done  12s)         │
│  ✓  Step 2  Extract calibration         (done  8s)          │
│  ✓  Step 3  Roster ratings              (skipped — no .ros) │
│  ✓  Step 4  Fetch 2026 prospects        (done  34s)         │
│  ►  Step 5  Generate ratings (AI)       ████░░░░  47%       │
│             Processing prospect 118 / 250                   │
│     Step 6  Write .draftclass file      (waiting)           │
├─────────────────────────────────────────────────────────────┤
│  [Live Log ▼]                                               │
│  14:22:01  INFO   Rated Shedeur Sanders QB → OVR 79         │
│  14:22:03  INFO   Rated Travis Hunter WR → OVR 82           │
│  14:22:04  WARN   Missing combine data for P. Johnson — …   │
└─────────────────────────────────────────────────────────────┘
```

#### `<ProspectRatingEditor>`
A full-page prospect card showing:
- Bio (name, position, school, measurables, grade, draft position)
- **Radar chart** showing attribute groups (Speed/Athleticism, Throwing, Coverage, Pass Rush, etc.)
- Inline editable number fields for every rating (validated 0–99)
- "Regenerate with AI" button that calls `/prospects/{id}/regenerate`
- Position comparison mini-table showing how this prospect compares to calibration examples

#### `<FranchiseDashboard>`
- **Salary cap bar** (used / total / dead money)
- **Need analysis grid** (positions color-coded by depth: red=thin, yellow=OK, green=deep)
- **AI Advisor panel** — natural language suggestions (e.g., "Your OT depth is thin going into Year 3. Consider…")
- **Upcoming draft pick tracker** with AI draft board overlay

#### `<TradeAnalyzer>`
- Two-column trade builder (My team / Their team)
- Drag-and-drop players and picks into each side
- "Analyze Trade" → calls `/franchise/{id}/trade-analyzer`
- AI returns: win/loss verdict, value breakdown, context ("Josh Allen is 29 in Year 4, age curve…"), suggested counter-offer

#### `<DraftBoard>`
- Scrollable big board of all prospects in the current draft class
- Drag-to-reorder with position filter tabs
- Color-coded by dev trait (Normal / Impact / Star / X-Factor)
- "AI Suggest Pick" button given team needs

---

## 5. Data Layer

### Database: PostgreSQL 16 (via SQLAlchemy async + Alembic)

#### Core tables

```sql
-- ── Prospects ──────────────────────────────────────────────────────────────
CREATE TABLE prospects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_year      SMALLINT NOT NULL,
    name            TEXT NOT NULL,
    position        TEXT NOT NULL,         -- 'QB', 'WR', etc.
    school          TEXT,
    draft_round     SMALLINT,
    draft_pick      SMALLINT,
    height          TEXT,                  -- '6-2'
    weight          SMALLINT,
    forty_time      REAL,
    bench           SMALLINT,
    vertical        REAL,
    broad_jump      SMALLINT,
    three_cone      REAL,
    shuttle         REAL,
    draft_grade     TEXT,                  -- 'A+', 'B', etc.
    board_rank      SMALLINT,
    source          TEXT,                  -- 'nflverse', 'pfr', 'manual', etc.
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Ratings (per-prospect, keyed by model+version for reproducibility) ─────
CREATE TABLE prospect_ratings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id     UUID REFERENCES prospects(id) ON DELETE CASCADE,
    draft_class_id  UUID REFERENCES draft_classes(id) ON DELETE SET NULL,
    llm_provider    TEXT NOT NULL,         -- 'ollama:llama3:8b', 'openai:gpt-4o'
    generated_at    TIMESTAMPTZ DEFAULT now(),
    is_manual       BOOLEAN DEFAULT FALSE, -- true if user edited
    overall         SMALLINT,
    speed           SMALLINT,
    acceleration    SMALLINT,
    agility         SMALLINT,
    strength        SMALLINT,
    awareness       SMALLINT,
    throw_power     SMALLINT,
    throw_accuracy  SMALLINT,
    -- … all ~60 Madden rating fields …
    dev_trait       SMALLINT,              -- 0=Normal 1=Impact 2=Star 3=XFactor
    raw_llm_output  JSONB,                 -- full LLM response, for debugging
    prompt_hash     TEXT                   -- SHA256 of the prompt used
);

-- ── Draft Classes ───────────────────────────────────────────────────────────
CREATE TABLE draft_classes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    season_year     SMALLINT NOT NULL,
    description     TEXT,
    status          TEXT DEFAULT 'draft',  -- 'draft', 'complete', 'exported'
    exported_file_id UUID REFERENCES stored_files(id),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Junction: which prospects (and which rating row) are in a draft class
CREATE TABLE draft_class_prospects (
    draft_class_id  UUID REFERENCES draft_classes(id) ON DELETE CASCADE,
    prospect_id     UUID REFERENCES prospects(id) ON DELETE CASCADE,
    rating_id       UUID REFERENCES prospect_ratings(id),
    board_position  SMALLINT,              -- user-controlled ordering
    PRIMARY KEY (draft_class_id, prospect_id)
);

-- ── Rosters ─────────────────────────────────────────────────────────────────
CREATE TABLE rosters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    madden_version  TEXT DEFAULT '26',
    source_file_id  UUID REFERENCES stored_files(id),
    extracted_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE roster_players (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    roster_id       UUID REFERENCES rosters(id) ON DELETE CASCADE,
    first_name      TEXT,
    last_name       TEXT,
    position        TEXT,
    overall         SMALLINT,
    age             SMALLINT,
    dev_trait       SMALLINT,
    ratings         JSONB,                 -- full ratings blob
    contract_years  SMALLINT,
    contract_salary INTEGER,               -- in thousands
    cap_hit         INTEGER
);

-- ── Franchise State ──────────────────────────────────────────────────────────
CREATE TABLE franchises (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    team            TEXT,
    madden_version  TEXT DEFAULT '26',
    current_week    SMALLINT DEFAULT 1,
    current_year    SMALLINT,
    roster_id       UUID REFERENCES rosters(id),
    settings        JSONB DEFAULT '{}',    -- salary cap, difficulty, etc.
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Snapshots of franchise state at each week/year (for history & undo)
CREATE TABLE franchise_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    franchise_id    UUID REFERENCES franchises(id) ON DELETE CASCADE,
    week            SMALLINT,
    year            SMALLINT,
    snapshot_data   JSONB,                 -- full serialized state
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── AI Advisor History ───────────────────────────────────────────────────────
CREATE TABLE advisor_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    franchise_id    UUID REFERENCES franchises(id) ON DELETE CASCADE,
    messages        JSONB DEFAULT '[]',    -- [ {role, content, ts}, … ]
    context_hash    TEXT,                  -- hash of roster/cap state used
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Files ────────────────────────────────────────────────────────────────────
CREATE TABLE stored_files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_name   TEXT,
    storage_key     TEXT NOT NULL,         -- path on disk or S3 key
    storage_backend TEXT DEFAULT 'local',  -- 'local' or 's3'
    content_type    TEXT,
    size_bytes      BIGINT,
    uploaded_at     TIMESTAMPTZ DEFAULT now()
);

-- ── Pipeline Jobs ────────────────────────────────────────────────────────────
CREATE TABLE pipeline_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type        TEXT NOT NULL,         -- 'draft_class', 'roster_extract', etc.
    status          TEXT DEFAULT 'queued', -- 'queued','running','complete','failed'
    current_step    SMALLINT DEFAULT 0,
    total_steps     SMALLINT DEFAULT 6,
    progress_pct    SMALLINT DEFAULT 0,
    config          JSONB,                 -- the run parameters
    result          JSONB,                 -- output file IDs, stats
    error_message   TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── LLM Provider Config ──────────────────────────────────────────────────────
CREATE TABLE llm_providers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT UNIQUE NOT NULL,  -- 'ollama-local', 'openai', etc.
    provider_type   TEXT NOT NULL,         -- 'ollama', 'openai', 'anthropic', 'gemini'
    base_url        TEXT,                  -- for Ollama or self-hosted
    api_key_ref     TEXT,                  -- name of env var holding the key
    default_model   TEXT,
    is_active       BOOLEAN DEFAULT FALSE,
    config          JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── MUT (Phase 4) ────────────────────────────────────────────────────────────
CREATE TABLE mut_squads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT,
    formation       TEXT,
    players         JSONB,
    overall         SMALLINT,
    chemistry       TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
```

#### Indexes (essential)

```sql
CREATE INDEX idx_prospects_year_pos ON prospects (draft_year, position);
CREATE INDEX idx_prospect_ratings_prospect ON prospect_ratings (prospect_id);
CREATE INDEX idx_draft_class_prospects_class ON draft_class_prospects (draft_class_id);
CREATE INDEX idx_roster_players_roster_pos ON roster_players (roster_id, position);
CREATE INDEX idx_pipeline_jobs_status ON pipeline_jobs (status);
CREATE INDEX idx_franchise_snapshots_fid_year ON franchise_snapshots (franchise_id, year, week);
```

### Redis usage

| Key pattern | Type | TTL | Purpose |
|---|---|---|---|
| `job:{job_id}:progress` | Hash | 24h | Live job progress (step, pct, log tail) |
| `job:{job_id}:channel` | Pub/Sub | — | WebSocket broadcast channel |
| `llm:model_list:{provider}` | String (JSON) | 1h | Cached model list |
| `prospects:pos:{pos}:{year}` | String (JSON) | 6h | Cached position prospect list |
| `calibration:{year}` | String (JSON) | 24h | Cached calibration set |
| `session:{token}` | Hash | 7d | User session (if auth is added later) |

---

## 6. AI / LLM Integration

### Provider abstraction layer

The key design principle: **all LLM calls go through one interface**. Switching from Ollama to GPT-4o requires only changing the active provider in the database — not touching any prompt or pipeline logic.

```python
# backend/services/llm/base.py
from abc import ABC, abstractmethod
from typing import AsyncIterator

class LLMProvider(ABC):
    @abstractmethod
    async def complete(self, prompt: str, *, model: str, temperature: float = 0.2) -> str:
        """Return the full completion as a string."""

    @abstractmethod
    async def stream(self, prompt: str, *, model: str) -> AsyncIterator[str]:
        """Stream tokens as they arrive (for real-time log display)."""

    @abstractmethod
    async def list_models(self) -> list[str]:
        """Return available model names."""

    @abstractmethod
    async def health_check(self) -> bool:
        """Return True if the provider is reachable."""
```

```python
# backend/services/llm/ollama_provider.py
import ollama
from .base import LLMProvider

class OllamaProvider(LLMProvider):
    def __init__(self, host: str = "http://localhost:11434"):
        self.client = ollama.AsyncClient(host=host)

    async def complete(self, prompt, *, model="llama3:8b", temperature=0.2):
        response = await self.client.generate(model=model, prompt=prompt,
                                              options={"temperature": temperature})
        return response["response"]

    async def stream(self, prompt, *, model="llama3:8b"):
        async for chunk in await self.client.generate(model=model, prompt=prompt,
                                                       stream=True):
            yield chunk["response"]

    async def list_models(self):
        models = await self.client.list()
        return [m["name"] for m in models["models"]]

    async def health_check(self):
        try:
            await self.client.list()
            return True
        except Exception:
            return False
```

```python
# backend/services/llm/openai_provider.py
from openai import AsyncOpenAI
from .base import LLMProvider

class OpenAIProvider(LLMProvider):
    def __init__(self, api_key: str):
        self.client = AsyncOpenAI(api_key=api_key)

    async def complete(self, prompt, *, model="gpt-4o", temperature=0.2):
        resp = await self.client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
        )
        return resp.choices[0].message.content

    async def stream(self, prompt, *, model="gpt-4o", temperature=0.2):
        async with self.client.chat.completions.stream(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
        ) as stream:
            async for chunk in stream:
                if chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content

    async def list_models(self):
        models = await self.client.models.list()
        return [m.id for m in models.data if "gpt" in m.id]

    async def health_check(self):
        try:
            await self.client.models.list()
            return True
        except Exception:
            return False
```

### Provider factory

```python
# backend/services/llm/factory.py
from .ollama_provider import OllamaProvider
from .openai_provider import OpenAIProvider
from .anthropic_provider import AnthropicProvider

def get_provider(config: dict) -> LLMProvider:
    match config["provider_type"]:
        case "ollama":
            return OllamaProvider(host=config.get("base_url", "http://localhost:11434"))
        case "openai":
            return OpenAIProvider(api_key=config["api_key"])
        case "anthropic":
            return AnthropicProvider(api_key=config["api_key"])
        case _:
            raise ValueError(f"Unknown provider type: {config['provider_type']}")
```

### Prompt management

Prompts are **versioned template strings**, not hardcoded in scripts. This allows A/B testing different prompt strategies.

```
backend/
└── prompts/
    ├── rating_generation/
    │   ├── v1_base.txt          # Current script 5 prompt (migrated)
    │   ├── v2_chain_of_thought.txt
    │   └── v3_structured_output.txt   # For models with JSON mode
    ├── franchise_advisor/
    │   ├── trade_analysis.txt
    │   ├── draft_advice.txt
    │   ├── cap_management.txt
    │   └── weekly_summary.txt
    └── mut/
        └── squad_builder.txt
```

### Rating generation flow (async)

```
API POST /pipeline/run
        │
        ▼
pipeline_job created in DB (status='queued')
        │
        ▼
ARQ enqueues task: generate_draft_class(job_id, config)
        │
        ▼
Worker picks up task:
  for each prospect:
    1. Load calibration examples (DB cache / Redis)
    2. Load roster benchmarks (DB cache / Redis)
    3. Build prompt from template
    4. LLMProvider.complete() → raw JSON string
    5. Parse + validate (Pydantic model, 0–99 bounds)
    6. Retry up to 3× on validation failure
    7. Save prospect_ratings row to DB
    8. Publish progress event to Redis channel
    9. WebSocket server broadcasts to frontend
        │
        ▼
All done → Node sidecar: POST /write-draftclass
        │
        ▼
.draftclass file saved to storage
job status='complete', result={file_id: …}
```

### LLM cost / latency trade-offs

| Provider | Latency / prospect | Cost / 250 prospects | Best for |
|---|---|---|---|
| Ollama llama3:8b (local) | ~3–8s | $0 | On-prem, privacy, iteration |
| Ollama llama3:70b (local, 48GB+) | ~20–40s | $0 | Higher quality, local |
| OpenAI GPT-4o-mini | ~1–2s | ~$0.10 | Fast cloud, budget |
| OpenAI GPT-4o | ~2–5s | ~$1.50 | Highest quality, cloud |
| Anthropic Claude Haiku | ~1s | ~$0.05 | Fastest, cheapest cloud |

> **Recommendation for v1:** Keep Ollama as default (zero cost, works today). Add cloud providers as opt-in for users who want faster generation or higher quality.

---

## 7. Franchise Management Features

### Franchise data model

A franchise is modeled as a **stateful session** with a roster snapshot at its core. The user uploads a `.ros` file (or starts from a generated calibration roster), and the app tracks decisions over simulated time.

### AI Advisor — how it works

```
User uploads .ros file
        │
        ▼
Roster extracted → roster_players rows in DB
        │
        ▼
FranchiseService.build_context(franchise_id) →
  {
    team:         "Denver Broncos",
    year:         3,
    week:         8,
    cap_space:    $18.4M,
    cap_penalties: [...],
    depth_chart:  { QB: [...], WR: [...], ... },
    needs:        ["OT", "CB"],         ← computed from depth + age
    upcoming_picks: [R1, R3, R4],
    recent_results: [...],
    draft_class_available: true
  }
        │
        ▼
FranchiseAdvisorPrompt.render(context) → prompt string
        │
        ▼
LLMProvider.complete(prompt)
        │
        ▼
Structured JSON advice:
  {
    summary: "Your OT situation is critical. Trent Williams turns 36...",
    priority_actions: [
      { action: "sign_fa", position: "OT", urgency: "high",
        reasoning: "..." },
      ...
    ],
    cap_alerts: [...],
    draft_priorities: [...]
  }
        │
        ▼
advisor_sessions row updated, displayed in FranchiseDashboard
```

### Trade Analyzer

```
Input: { give: [players, picks], receive: [players, picks] }
        │
        ▼
For each player: load current ratings, age, dev_trait, contract
For each pick:   estimate value from pick chart + projected class quality
        │
        ▼
Build trade prompt with context + market values
        │
        ▼
LLM returns:
  {
    verdict:        "slight win" | "slight loss" | "fair" | "highway robbery",
    value_delta:    +7.2,          ← your net gain
    rationale:      "...",
    age_flags:      ["Josh Allen is 29, entering decline window"],
    counter_offer:  { give: [...], receive: [...] }
  }
```

### Feature roadmap for franchise module

| Phase | Feature |
|---|---|
| v1 | Roster upload + player browser + cap overview |
| v1 | Basic AI advisor (weekly summary prompt) |
| v2 | Trade analyzer |
| v2 | AI-ranked draft board using current draft class |
| v2 | Depth chart optimizer (plug in prospect ratings) |
| v3 | Multi-season history tracking |
| v3 | Contract negotiation advisor |
| v3 | Scouting report generator (individual player analysis) |
| v4 | Head-to-head matchup advisor (weekly game plan) |

---

## 8. MUT Management Features (Future)

> **Phase 4** — do not build until franchise features are stable. Stub out the routes and DB tables now so the schema doesn't need a breaking migration later.

### Planned features

| Feature | Description |
|---|---|
| **Squad Builder** | Drag-and-drop team builder with chemistry/theme system |
| **AI Squad Optimizer** | Given a budget and target chemistry, LLM suggests squad |
| **SBC Solver** | Input SBC requirements → AI suggests cheapest card combination from your collection |
| **Market Tracker** | Pull auction house prices (if accessible via unofficial API) and track trends |
| **Pack Opener Tracker** | Log pack pulls, track luck vs. expected value |
| **Theme Team Builder** | Auto-build highest-OVR theme team for a given team/school |

### MUT data model sketch

```sql
CREATE TABLE mut_collections (
    id          UUID PRIMARY KEY,
    name        TEXT,
    mut_year    SMALLINT
);

CREATE TABLE mut_cards (
    id              UUID PRIMARY KEY,
    collection_id   UUID REFERENCES mut_collections(id),
    player_name     TEXT,
    position        TEXT,
    overall         SMALLINT,
    tier            TEXT,      -- 'Gold', 'Elite', 'Legend', etc.
    chemistry       TEXT[],
    ratings         JSONB,
    is_owned        BOOLEAN DEFAULT FALSE,
    buy_now_price   INTEGER,
    updated_at      TIMESTAMPTZ
);

CREATE TABLE mut_squads (
    id          UUID PRIMARY KEY,
    name        TEXT,
    scheme      TEXT,
    players     JSONB,  -- { slot: card_id }
    overall     SMALLINT,
    chemistry   JSONB,
    created_at  TIMESTAMPTZ
);
```

---

## 9. Deployment

### On-premises: Docker Compose

> **PostgreSQL image note:** Use `postgres:16` (Debian) rather than `postgres:16-alpine` if you
> plan to add extensions such as `pgvector` (semantic prospect search) or `pg_trgm` (fuzzy player
> name matching). Alpine saves ~80 MB but lacks the build dependencies some extensions require.
> For a plain install without extensions, either image works fine.

```yaml
# docker-compose.yml (production-like on-prem)
version: "3.9"

services:

  nginx:
    image: nginx:1.27-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/certs:/etc/nginx/certs:ro
    depends_on: [backend, frontend]

  frontend:
    build: ./frontend
    environment:
      - NEXT_PUBLIC_API_URL=https://localhost/api/v1

  backend:
    build: ./backend
    environment:
      - DATABASE_URL=postgresql+asyncpg://madden:${DB_PASS}@postgres:5432/madden
      - REDIS_URL=redis://redis:6379
      - NODE_SIDECAR_URL=http://node-sidecar:3001
      - OLLAMA_HOST=http://host.docker.internal:11434  # Ollama on host GPU
      - STORAGE_BACKEND=local
      - STORAGE_LOCAL_PATH=/data/files
    volumes:
      - file-store:/data/files
    depends_on: [postgres, redis, node-sidecar]

  worker:
    build: ./backend
    command: python -m arq workers.job_runner.WorkerSettings
    environment:
      - DATABASE_URL=postgresql+asyncpg://madden:${DB_PASS}@postgres:5432/madden
      - REDIS_URL=redis://redis:6379
      - NODE_SIDECAR_URL=http://node-sidecar:3001
      - OLLAMA_HOST=http://host.docker.internal:11434
    volumes:
      - file-store:/data/files
    depends_on: [postgres, redis, node-sidecar]

  node-sidecar:
    build: ./node-sidecar
    expose: ["3001"]
    volumes:
      - file-store:/data/files

  postgres:
    image: postgres:16
    environment:
      - POSTGRES_DB=madden
      - POSTGRES_USER=madden
      - POSTGRES_PASSWORD=${DB_PASS}
    volumes:
      - pg-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  pg-data:
  redis-data:
  file-store:
```

```
# .env (on-prem)
DB_PASS=changeme_strong_password
OLLAMA_HOST=http://host.docker.internal:11434
STORAGE_BACKEND=local
```

> **Ollama note:** Run Ollama natively on the host (not in Docker) to get full GPU access. The `host.docker.internal` hostname lets containers reach it.

### Cloud: AWS (reference architecture)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Route 53 → CloudFront (CDN + HTTPS)                                    │
│      │                                                                   │
│      ├─→ S3 (static Next.js export OR Amplify)                          │
│      │                                                                   │
│      └─→ ALB                                                             │
│              │                                                           │
│              ├─→ ECS Fargate: backend  (2 tasks, auto-scale)            │
│              └─→ ECS Fargate: worker   (1–N tasks, scale on queue depth)│
│                                                                          │
│  ECS tasks share:                                                        │
│    RDS PostgreSQL 16   (db.t4g.medium → db.r7g.large at scale)          │
│    ElastiCache Redis   (cache.t4g.micro)                                 │
│    ECS Task: node-sidecar  (internal only, no ALB)                      │
│    S3 bucket (file store, server-side encryption)                        │
│    Secrets Manager (DB password, API keys)                               │
│                                                                          │
│  LLM: OpenAI / Anthropic API (no GPU instances needed)                  │
│       OR: EC2 g4dn.xlarge with Ollama for cost-conscious GPU users       │
└─────────────────────────────────────────────────────────────────────────┘
```

**Estimated AWS monthly cost (small instance, cloud LLM):**
| Service | Spec | ~Cost/mo |
|---|---|---|
| ECS Fargate (backend) | 0.5 vCPU / 1GB | ~$15 |
| ECS Fargate (worker) | 1 vCPU / 2GB | ~$25 |
| RDS PostgreSQL | db.t4g.micro | ~$15 |
| ElastiCache Redis | cache.t4g.micro | ~$12 |
| ALB | — | ~$18 |
| S3 + CloudFront | ~10GB files | ~$5 |
| **Total (excl. LLM)** | | **~$90/mo** |

> For a solo dev, a single $20/mo VPS (Hetzner, DigitalOcean) running Docker Compose is often better than AWS until you need multi-user scale.

### CI/CD pipeline

```yaml
# .github/workflows/deploy.yml (simplified)
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install -r backend/requirements.txt && pytest backend/tests/
      - run: cd frontend && npm ci && npm run typecheck && npm test

  build-and-push:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Build & push Docker images
        # Build backend, frontend, node-sidecar images → ECR / GHCR

  deploy:
    needs: build-and-push
    # SSH to VPS and docker compose pull + up -d
    # OR: update ECS service with new image digest
```

---

## 10. Migration Path from CLI

The goal is **zero breakage** of the existing CLI throughout the migration. Each phase is independently shippable.

### Phase 1: Wrap the CLI in an API (4–6 weeks)
**Goal:** Both pipeline orchestrators (`run.py` and `roster_run.py`) become callable over HTTP. No frontend yet.

```
[x] Current state: python run.py            (draft class — scripts 1–6)
                   python roster_run.py      (roster — scripts 7→3→8)
[ ] Target:        POST /api/v1/pipeline/run         →  returns job_id
                   POST /api/v1/roster-pipeline/run  →  returns job_id
                   GET  /api/v1/pipeline/jobs/{id}   →  returns status
```

1. **Create `backend/` FastAPI app** with minimal structure (config, DB session, router skeletons)
2. **Migrate `scripts/5_generate_ratings.py`** → `backend/services/rating_service.py`
   - Extract the `generate_ratings_for_prospect()` function
   - Wrap it with the `LLMProvider` abstraction
   - Replace file I/O with DB writes
3. **Migrate `scripts/1,4` (Python fetchers)** → `backend/services/prospect_service.py`
4. **Migrate `scripts/7_fetch_nfl_roster_and_contracts.py`** → `backend/services/roster_fetch_service.py`
5. **Migrate `scripts/8_generate_roster_ratings.py`** → `backend/services/roster_rating_service.py`
6. **Create Node.js sidecar** (`node-sidecar/`) wrapping scripts 2, 3, 6 as Express endpoints
   - Script 3 now writes both `current_player_ratings.json` (top-10 per position for calibration)
     and `current_player_ratings_full.json` (all players, used by script 8 for roster merging)
7. **Create `backend/services/pipeline_service.py`** — replicates `run.py` orchestration (scripts 1–6)
8. **Create `backend/services/roster_pipeline_service.py`** — replicates `roster_run.py` orchestration (scripts 7→3→8)
9. **Add ARQ worker** + Redis for async execution
10. **Keep `run.py` and `roster_run.py` working** — they can optionally call the API or continue to call scripts directly
11. **Add Alembic migrations** for initial schema
12. **Docker Compose** with postgres + redis + backend + node-sidecar

**Deliverable:** `curl -X POST localhost:8000/api/v1/pipeline/run` runs the draft-class pipeline; `curl -X POST localhost:8000/api/v1/roster-pipeline/run` runs the roster pipeline.

---

### Phase 2: Add the React frontend (3–4 weeks)
**Goal:** Replace the CLI with a browser GUI for all current functionality.

1. **Scaffold Next.js app** in `frontend/`
2. **Build Pipeline Wizard** (PipelineWizard component + WebSocket progress)
3. **Build Prospect Table + Rating Editor**
4. **Build Roster Upload flow** (drag-drop → extraction → player browser)
5. **Build Draft Class Library** (list, create, export, download)
6. **Wire nginx** to serve frontend + proxy API
7. **Add file upload/download** for `.ros` and `.draftclass` files
8. **Settings page** for LLM provider configuration

**Deliverable:** Full browser-based replacement for `python run.py`. CLI still works.

---

### Phase 3: Franchise Advisor (4–6 weeks)
**Goal:** AI-assisted franchise management.

1. **Franchise data model** + DB migrations
2. **Franchise dashboard** (cap, depth, needs)
3. **AI Advisor prompt** + streaming response display
4. **Trade Analyzer** UI + API
5. **Draft Board** with AI suggestions using current draft class
6. **Depth Chart Optimizer**

---

### Phase 4: MUT + Polish (ongoing)
**Goal:** MUT squad tools + UX polish + multi-user support (if needed).

1. **Optional: auth** (add Clerk or Auth.js for multi-user, skip for personal use)
2. **MUT squad builder**
3. **Performance tuning** (caching, DB indexes, query optimization)
4. **Export/import** of entire franchise state

---

### Directory structure at end of Phase 2

```
madden-franchise-manager/
├── ARCHITECTURE.md
├── README.md
├── docker-compose.yml
├── .env.example
│
├── backend/                        # Python FastAPI app
│   ├── main.py
│   ├── config.py
│   ├── requirements.txt
│   ├── routers/
│   ├── services/
│   │   ├── llm/
│   │   └── storage/
│   ├── models/
│   ├── workers/
│   ├── prompts/
│   └── db/
│       └── migrations/
│
├── node-sidecar/                   # Node.js Express sidecar
│   ├── server.js
│   ├── routes/
│   │   ├── draftclass.js           # wraps madden-draft-class-tools
│   │   └── roster.js               # wraps madden-franchise
│   ├── package.json
│   └── Dockerfile
│
├── frontend/                       # Next.js 14 React app
│   ├── src/
│   │   ├── app/                    # App Router pages
│   │   ├── components/
│   │   │   ├── pipeline/
│   │   │   ├── prospects/
│   │   │   ├── franchise/
│   │   │   └── ui/                 # shadcn/ui components
│   │   ├── hooks/
│   │   ├── lib/                    # API client, utils
│   │   └── types/                  # Generated from OpenAPI
│   ├── package.json
│   └── Dockerfile
│
├── nginx/
│   └── nginx.conf
│
├── scripts/                        # LEGACY — kept for CLI use
│   ├── 1_fetch_combine_and_picks.py
│   ├── 2_extract_calibration.js
│   ├── 3_extract_roster_ratings.js   # updated: also writes current_player_ratings_full.json
│   ├── 4_fetch_2026_prospects.py
│   ├── 5_generate_ratings.py
│   ├── 6_create_draft_class.js
│   ├── 7_fetch_nfl_roster_and_contracts.py  # NEW: nflverse roster + contract fetch
│   └── 8_generate_roster_ratings.py         # NEW: merge Madden ratings + contract data
│
├── utils/                          # LEGACY shared utils (still used by scripts)
│   ├── enums.py
│   ├── enums.js
│   ├── defaults.py
│   └── visuals_template.js
│
├── run.py                          # LEGACY CLI orchestrator — draft class (scripts 1–6)
├── roster_run.py                   # LEGACY CLI orchestrator — roster (scripts 7→3→8)
├── requirements.txt                # Root-level Python deps (legacy CLI)
└── package.json                    # Root-level Node deps (legacy CLI)
```

---

## 11. Open Questions

These are decisions that only the repo owner can make. Answering them will unblock implementation.

### Authentication & users

| Question | Options | Recommendation |
|---|---|---|
| **Is this a personal tool (1 user) or multi-user?** | Single-user (no auth) · Multi-user (add auth) | Start single-user; add auth later if needed |
| **If multi-user: self-hosted auth or SaaS?** | Auth.js · Clerk · Supabase Auth · Keycloak | Clerk (easiest) or Auth.js (self-hosted) |

### LLM strategy

| Question | Options |
|---|---|
| **Primary LLM for v1 webapp?** | Keep Ollama only · Add OpenAI as default cloud option · Let user choose |
| **Are you OK spending $1–5 per draft class generation for higher quality?** | Yes → GPT-4o · No → stay Ollama |
| **Do you want streaming responses in the UI?** | Adds complexity but much better UX for franchise advisor chat |

### Data & persistence

| Question | Options |
|---|---|
| **Keep per-run JSON files OR fully migrate to PostgreSQL?** | Both (files as archive + DB as source of truth) · DB only |
| **Should calibration data be stored in DB or re-fetched each run?** | DB (faster, offline) · Re-fetch (always fresh) |
| **How many years of prospect/rating history do you want to keep?** | Current year only · Multi-year archive |

### Deployment target

| Question | Impact |
|---|---|
| **Primary deployment: local machine, home server, or cloud VPS?** | Drives Docker Compose vs. cloud IaC choices |
| **Do you have a GPU available for local Ollama inference?** | If yes, llama3:70b is viable. If no, llama3:8b or cloud LLM |
| **Do you need HTTPS from day one?** | Caddy auto-TLS is easiest for VPS; self-signed cert for LAN |
| **Single-machine Docker Compose or container orchestration?** | Compose is fine for solo/small use. K8s only if multi-node scale needed |

### Scope & prioritization

| Question | Why it matters |
|---|---|
| **Should the franchise advisor use a conversational chat UI (multi-turn) or one-shot analysis?** | Chat requires maintaining conversation history; one-shot is simpler to build |
| **Is real-time `.ros` file writing (modifying the actual Madden save) in scope, or read-only?** | Write support is risky (corrupt saves). Read + generate new files is safer |
| **When do you want to start on MUT?** | Keeps the DB schema from being over-designed too early |
| **Do you want mobile-responsive design from day one?** | Adds ~20% frontend effort but is worth it if you use this on a tablet |

---

*Document maintained in `ARCHITECTURE.md`. Last updated: April 2026.*
