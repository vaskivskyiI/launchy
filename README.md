# Launchy

A self-hosted browser start page: one search bar that also opens your apps, app tiles with live status, a public view plus one signed-in view per user, and widgets with live data from your services, including an AI briefing from a local model or Claude.

## Features

- **Search and launch in one box.** Type to match apps by name, tag or description, or search the web. `!d cats` uses DuckDuckGo once, typing a hostname opens it, and suggestions come through the server. Press `/` or just start typing anywhere. Use ↑/↓ to move, Enter to open, Ctrl+Enter to open in a new tab.
- **Selectable search engines.** Each user has their own default engine, and the choice made in the browser is remembered.
- **Public view and users.** `public` is what anyone sees without signing in; leave it out to require a login. Each entry under `users` is a complete configuration of its own (groups, widgets, accent colour, light/dark mode, background, font), so home and work are simply two users.
- **Status dots.** The server pings each app every 60 s. Set `ping:` to check an internal address, or `false` to skip the app.
- **Widgets** run on the server, so API keys never reach the browser:
  | type | shows |
  |---|---|
  | `podman` | running and stopped containers, from the Podman or Docker socket |
  | `stripe` | balance and latest payments |
  | `ical` | upcoming events from any iCal feed (Pixieset/Pic-Time calendar sync, Google, Nextcloud) |
  | `rss` | latest posts from a website feed |
  | `http` | any JSON API, with fields mapped by dot paths |
  | `ai` | a short briefing built from other widgets' data, by your local model or Claude |
- **Settings reload on save.** All of the above lives in `config/config.yaml`. A broken edit keeps the last good settings running and logs the error.

## Users and passwords

```sh
npm run hash-password        # type the password; paste the printed scrypt:… line as the user's `password`
```

Sessions last 30 days in an HttpOnly cookie signed with `LAUNCHY_SECRET` (set it to a long random string, or everyone is signed out when the server restarts). Changing a user's password signs that user out everywhere. After 5 wrong passwords from one IP, sign-in is blocked for 15 minutes. Behind nginx, pass `X-Real-IP` so the limit applies per visitor, and `X-Forwarded-Proto` so the cookie is marked Secure.

## AI

The top-level `llm` block sets the model for every `ai` widget, and a widget can override any field:

- `provider: local` works with any OpenAI-compatible server: Ollama (`url: https://host/v1`), llama.cpp, LM Studio or vLLM. If the server's certificate comes from your own CA, set `NODE_EXTRA_CA_CERTS=/path/ca.pem`.
- `provider: claude` uses the Anthropic API (`key` or `ANTHROPIC_API_KEY`).

Results are cached for the widget's `refresh` period (30 minutes by default). The model gets no tools, and source content is passed to it as data only.

## Run locally

```sh
cp config.example.yaml config/config.yaml   # then set password hashes
npm install
npm start            # http://localhost:8080
```

## Run in Podman

```sh
podman build -t launchy .
podman run -d --name launchy -p 127.0.0.1:8080:8080 \
  -v ./config:/config:Z \
  -v /run/user/$(id -u)/podman/podman.sock:/run/podman/podman.sock \
  --security-opt label=disable --userns=keep-id \
  -e LAUNCHY_SECRET -e STRIPE_KEY -e STUDIO_CALENDAR_ICS \
  launchy
```

The socket mount is only needed for the `podman` widget. Enable the socket first with `systemctl --user enable --now podman.socket`. The container runs as a non-root user, so mount the rootless socket shown above.

## Notes

- Pixieset and Pic-Time have no public API for this, so the studio view combines quick links with their calendar-sync (iCal) feeds and the website's posts. Stripe has a real API: use a **restricted key** with read-only access to Balance and Charges.
- The public view only receives its own groups. Users' apps, widgets and service addresses are never sent to a browser that isn't signed in as that user.
