# Checkpoint — 2026-06-06

Saved by: GitHub Copilot (operation requested by user)
Workspace: c:/Users/arjun/Desktop/AIisgood2/project

## Summary
- Purpose: Snapshot of the project state and structure saved as a checkpoint on 2026-06-06.
- User-declared status: "Perfectly running" (status declared by user; not verified by this agent).
- Note: This file documents the project structure and intended state. To verify runtime, run the project's tests or start services locally.

## Top-level files and folders
- CHECKPOINT_2026-06-06-FINAL.md
- CHECKPOINT_2026-06-06.md
- CHECKPOINT_2026-06-06-SNAPSHOT.md (this file)
- dataset_report.txt
- Dataset.csv
- explore_dataset.py
- test_api.py
- test.py
- text/
- idms/

## `idms/` folder (summary)
- docker-compose.yml
- README.md
- backend/
  - agent_new.py
  - agent.py
  - celery_app.py
  - celerybeat-schedule
  - database.py
  - Dockerfile
  - eligibility.py
  - ingest.py
  - main.py
  - memory.py
  - models.py
  - outreach.py
  - ranking.py
  - requirements.txt
  - reservation.py
  - scheduler.py
  - schema.sql
  - sonar.py
  - tasks/
    - __init__.py
    - daily_scan.py
    - escalation.py
    - failure_learning.py
- frontend/
  - eslint.config.js
  - index.html
  - package.json
  - README.md
  - response.json
  - vite.config.js
  - public/
  - src/
    - api.js
    - App.jsx
    - index.css
    - main.jsx
    - RoleSelect.jsx
    - utils.js
    - components/
      - EmptyState.jsx
      - index.jsx
      - LoadingSpinner.jsx
      - Modal.jsx
      - SkeletonCard.jsx
      - StatCard.jsx
      - Toast.jsx
      - TopNav.jsx
    - coordinator/
      - Actions.jsx
      - Donors.jsx
      - Insights.jsx
      - Layout.jsx
      - Patients.jsx
    - donor/
      - Donations.jsx
      - Layout.jsx
      - Messages.jsx
      - Notifications.jsx
      - Profile.jsx
    - pages/
      - Actions.jsx
      - Conversations.jsx
      - Donors.jsx
      - Patients.jsx
    - patient/
      - Dashboard.jsx
      - History.jsx
      - Layout.jsx
      - Notifications.jsx
      - RequestBlood.jsx

## How this checkpoint was created
- Created on 2026-06-06 by request of the user.
- Declares the project as "perfectly running" per user instruction; no automated tests or runtime checks were executed by the agent.

## Next recommended steps (optional)
- Run unit tests and integration tests to verify runtime status.
- Start services with `docker-compose up` in `idms/` to validate the full system.

---

End of checkpoint.
