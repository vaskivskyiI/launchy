# Launchy

A self-hosted browser start page: one search bar that also opens your apps, app tiles with live status, a public view plus one signed-in view per user, an AI briefing with links to what it mentions, and live data from your services one click away. Everything is set up in the browser.

## Features

- **Search and launch in one box.** Type to match apps by name, tag or description, or search the web. `!d cats` uses DuckDuckGo once, typing a hostname opens it, and suggestions come through the server. Press `/` or just start typing anywhere. Use ↑/↓ to move, Enter to open, Ctrl+Enter to open in a new tab.
- **Calm start page.** A tile opens its app. Apps with live data get a badge (e.g. mail needing attention) and a `›` button that opens a side panel with their widgets and an "Open" button. Only the briefing (and widgets not tied to an app) sits on the page itself.
- **Installed apps first.** Give an app its Android app id and/or app link (`myapp://`): a click on its tile then opens the installed app (Android: through Chrome's own app-or-web fallback; elsewhere the web page opens if no app answers, and the device remembers it). Ctrl/middle-click and the tile's panel still open the web page.
- **Briefing with links.** An AI briefing summarises the other widgets; every mail, event, note or document it mentions links straight to it. It only states facts from its sources.
- **Users and a public view.** Each user has their own groups, widgets, accent colour, light/dark mode, font and search engine; home and work can simply be two users. Visitors who are not signed in see the public view, or only a sign-in form.
- **Settings page** (`/settings`, administrators only): users and passwords, apps, groups, widgets, search engines, the AI model and secrets. Changes are validated and saved in one step; the previous 20 versions are kept in `config/history/`.
- **Status dots.** The server checks each app every 60 s, optionally at an internal address.

## Widgets

They run on the server, so tokens never reach the browser.

| type | shows |
|---|---|
| `halcyon` | Halcyon mail needing attention (with a badge), tasks and today's events, or the coming days, through its read-only assistant token |
| `http` | any JSON API: fields are dot paths (`title.rendered`) or templates (`{label} on {camera}`); dates show as "2 hours ago" |
| `ical` | upcoming events from a calendar feed (Pixieset/Pic-Time calendar sync, Google, Nextcloud) |
| `rss` | latest posts from a website feed |
| `stripe` | balance and latest payments (restricted read-only key) |
| `podman` | running and stopped containers, from a Podman or Docker socket |
| `ai` | a short briefing from other widgets, by your own model (any OpenAI-compatible server, e.g. Ollama) or Claude |

A widget whose secret has no value says "Not set up yet" and names the secret, instead of failing.

## Secrets

Settings refer to tokens as `${NAME}`. Set values at **Settings → Secrets** (stored in `config/secrets.yaml`, mode 600, never shown again) or pass them as environment variables.

## Install

```sh
cp config.example.yaml config/config.yaml
npm install
npm run hash-password        # paste the printed scrypt:… line as the admin user's password
npm start                    # http://localhost:8080, then open /settings
```

Sessions last 30 days in an HttpOnly cookie signed with `LAUNCHY_SECRET`; set it to a long random string, or everyone is signed out when the server restarts. After 5 wrong passwords from one address, sign-in pauses for 15 minutes. Behind a reverse proxy, pass `X-Real-IP` and `X-Forwarded-Proto`.

## Run in Podman

```sh
podman build -t launchy .
podman run -d --name launchy -p 127.0.0.1:8080:8080 \
  --userns=keep-id:uid=1000,gid=1000 \
  -v ./config:/config:Z \
  -e LAUNCHY_SECRET \
  launchy
```

`--userns=keep-id:uid=1000,gid=1000` maps your account to the container's user, so the settings page can save into `./config` and you can still edit the files yourself. If your services use certificates from your own CA, also mount it and set `NODE_EXTRA_CA_CERTS=/path/in/container/ca.pem`. For the `podman` widget, mount a Podman socket (`systemctl --user enable --now podman.socket`).
