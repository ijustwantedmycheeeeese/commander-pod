# CLAUDE.md

## Project

Archon (formerly "Commander Pod") — a self-hosted multiplayer Commander/EDH table (`server.js` + Express/Socket.IO backend, single-file `index.html` frontend). Solo hobby project for a small trusted pod, not a public/production service.

## Standing workflow permission

The repo owner (jacobmancill) has granted standing permission to skip per-action confirmation for the normal git/GitHub workflow on this repo:
- `git add` / `commit` / `push` to feature branches
- Opening PRs via `gh pr create`
- Merging PRs into `main` via `gh pr merge`
- Syncing the local working branch to `origin/main` after a merge (`git fetch` / `checkout main` / `reset --hard origin/main`)

Still check in before doing any of these, since blanket permission doesn't cover them:
- Force-pushing, or resetting/deleting any branch other than a feature branch just merged into `main`
- Rewriting already-pushed/published history
- Deleting saved user data (accounts, decks, the card archive) rather than just local test artifacts
- Anything outside this repo

## Local dev / testing

- `npm install && mkdir -p public/audio && cp index.html public/index.html && cp audio/lobby-music.mp3 public/audio/lobby-music.mp3 && node server.js` to run locally (matches what the Dockerfile does at build time).
- No test framework in this repo — verify changes by running the real server and driving it with a scripted `socket.io-client` script and/or the browser, not just code review.
- Server data (users, decks, card archive) persists under `/app/data` per `server.js`'s `DATA_DIR` — on Windows this resolves to `C:\app\data` outside the repo, so it's safe to freely create/delete for testing without touching real data.
