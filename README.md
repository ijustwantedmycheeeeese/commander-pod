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

Game/account data (users, saved decks, and an archive of every card looked up — cost, mana value, power/toughness, oracle text, keywords, etc.) persists in the `mtg_data` named volume across restarts and redeploys, independent of the code itself.

## Voice chat across networks (TURN relay)

Voice chat is peer-to-peer WebRTC. With just public STUN (the default), two players can only connect directly, which fails whenever a router's NAT gets in the way — this is why voice chat doesn't work for anyone outside your own network. The stack includes a self-hosted `coturn` relay to fix that, but it needs two things set before it'll actually work:

1. **Environment variables** on the stack (Portainer will prompt for these since they're required, no defaults): `TURN_EXTERNAL_IP` (your server's public IP or a hostname that resolves to it) and `TURN_PASSWORD` (anything — it's just for the relay, not a user account). `TURN_USERNAME` defaults to `commanderpod` if you don't set it.
2. **Port forwarding on your router**, forwarded to whatever machine runs the stack: **UDP/TCP 3478** (the TURN server itself) and **UDP 49160–49200** (the relay's dynamically-allocated media ports). This is a real caveat if you're using a Cloudflare Tunnel to expose the app itself: a plain Cloudflare Tunnel proxies HTTP(S), not arbitrary UDP, so TURN traffic needs to reach your network directly through your router — it can't ride along through the tunnel the way the web app does.

If those aren't set, voice chat still works fine for players on the same network, and silently falls back to same-network-only otherwise (no error, it just won't connect).

## Local development

```
npm install
mkdir public && cp index.html public/index.html
node server.js
```

The `mkdir`/`cp` step matches what the `Dockerfile` does at build time — `server.js` serves static files from `./public`, so without it `index.html` won't be found and the app will 404 at `/`.

Serves on port 8087.
