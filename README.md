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

## Account approval & the admin panel

New accounts need to be approved before they can log in — when someone registers they see a "waiting on admin approval" message instead of getting straight in. Approving, rejecting, and deleting accounts happens through a separate `admin-panel` service in the stack, not through the main app.

This panel is deliberately kept off the public internet: `docker-compose.yml` binds it to `127.0.0.1:9091` on the host (unlike `mtg-table`'s `8087:8087`, which binds every interface), so it's unreachable even from your LAN by default. To actually reach it, use [Tailscale](https://tailscale.com/) and serve the loopback port privately over your tailnet:

```
tailscale serve --bg --https=8443 http://127.0.0.1:9091
```

Then visit `https://<your-machine>.<your-tailnet>.ts.net:8443` from any device on your tailnet. Do **not** use `tailscale funnel` for this — funnel exposes the port to the public internet, which defeats the entire point of keeping account moderation off the public-facing container.

**Required environment variables** for the `admin-panel` service (Portainer will prompt for these, same as the TURN variables above): `ADMIN_USERNAME` and `ADMIN_PASSWORD` — a separate credential from any player account, used only to log into this panel.

Existing accounts from before this feature was added are auto-approved on first startup, so upgrading an existing deployment won't lock anyone out.

### Push notification when someone registers

Optional, off by default. Set `NTFY_TOPIC` on the `mtg-table` service and it'll send a push notification (via [ntfy](https://ntfy.sh)) every time someone registers and needs approval — this reaches you over the regular internet, so it works even when you're not on your tailnet; only actually approving the account needs you to reach the admin panel above.

1. Install the ntfy app ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)), or just use a browser at `https://ntfy.sh/<your-topic>`.
2. Pick a topic name that's hard to guess (e.g. `commanderpod-approvals-x7q2m`) — anyone who knows it can also read or post to it, since ntfy topics aren't otherwise access-controlled.
3. Subscribe to that topic name in the app.
4. Set `NTFY_TOPIC` to that same name as an environment variable on the `mtg-table` service (Portainer will prompt for it like the other variables above, but it's optional — leave it blank to disable).

If you're self-hosting your own ntfy server instead of using the public `ntfy.sh`, also set `NTFY_SERVER` to its URL.

## Local development

```
npm install
mkdir public && cp index.html public/index.html
node server.js
```

The `mkdir`/`cp` step matches what the `Dockerfile` does at build time — `server.js` serves static files from `./public`, so without it `index.html` won't be found and the app will 404 at `/`.

Serves on port 8087.
