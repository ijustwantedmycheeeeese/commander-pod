# Commander Pod

A self-hosted multiplayer Commander/EDH table: accounts, persistent decks, zone-based board with auto-layout, turn structure, mana tracking, basic combat, chat, and experimental peer-to-peer voice.

## Deploying via Portainer (Repository method)

1. In Portainer: **Stacks → Add stack**
2. Build method: **Repository**
3. Repository URL: `https://github.com/ijustwantedmycheeeeese/commander-pod`
4. Repository reference: `refs/heads/main` (or `master`, matching your default branch)
5. Compose path: `docker-compose.yml` (default — leave as is)
6. Deploy the stack

Portainer will clone the repo and build the image from the included `Dockerfile` — no size limits, no encoding tricks, and pushing new commits + redeploying the stack is how you ship future updates.

Game/account data (users, saved decks) persists in the `mtg_data` named volume across restarts and redeploys, independent of the code itself.

## Local development

```
npm install
node server.js
```

Serves on port 8087.
