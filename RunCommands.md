 ---
  Running the app

  Everything is Docker-based. Run all commands from the expanse/ folder.

  First run (builds the image)

  docker compose -f compose.prod.yaml up --build

  Subsequent runs (no rebuild needed)

  docker compose -f compose.prod.yaml up

  Stop it

  docker compose -f compose.prod.yaml down

  Force a rebuild after code changes

  docker compose -f compose.prod.yaml up --build --force-recreate

  The app will be at http://localhost:1301 (or http://<host-ip>:1301 from other devices on
  your network).

  ---
  What the build does

  The Dockerfile is a 3-stage build:
  1. Stage 1 — installs backend npm deps
  2. Stage 2 — installs frontend deps and runs vite build (produces static files)
  3. Final — combines both into a lean Alpine image, backend serves the built frontend
  statically

  If PSQL_CONNECTION is set in .env_prod, the app connects to that external Postgres
  instance directly. The db: service in compose.prod.yaml is then unused and can be
  ignored.

  ---
  First login

  1. Open http://localhost:1301
  2. You'll see the new cookie login form
  3. Open Reddit in the same browser → F12 → Application → Cookies → https://www.reddit.com →
   copy reddit_session value
  4. Paste it in and click Log in
