# Nyumba Kenya

House hunting app for Kenya with its own sign-in (phone number and password). No npm packages and no claude.ai accounts needed.

## Run it

Requires Node.js 22.13 or newer.

    node server.js

Open http://localhost:3000. Data is stored in `nyumba.db` (SQLite) next to `server.js`.

## Easiest way to put it online (Render, about 10 minutes)

1. Create a free account at github.com. Click New repository, name it `nyumba-kenya`, then "uploading an existing file" and drag in everything from this folder (`server.js`, `render.yaml`, `Dockerfile`, `package.json`, `README.md` and the `public` folder). Click Commit.
2. Create an account at render.com and connect your GitHub account.
3. In Render click New, then Blueprint, and choose your `nyumba-kenya` repository.
4. When Render asks for `ADMIN_PHONE`, type your own phone number (for example 0712345678). You will be able to remove any listing.
5. Click Apply. Render gives you a link like `https://nyumba-kenya.onrender.com`. That is your app, with HTTPS already on.
6. To use your own address, open the service in Render, go to Settings, then Custom Domains, and follow the steps.

Render needs a paid plan for this app, because the app saves houses and accounts in a file and the free plan does not keep files. Check Render's current plans and prices before you start.

## Other hosts

- **Any host that runs Docker** (Railway, Fly.io, a VPS): the `Dockerfile` is included. Mount a persistent volume at `/data` so the database survives restarts.
- **A plain server**: install Node.js 22.13 or newer, run `node server.js`, and put Caddy or Nginx in front for HTTPS. Set `ADMIN_PHONE`, `TRUST_PROXY=1` and, if your proxy does not send `X-Forwarded-Proto`, `SECURE_COOKIES=1`.

Whatever host you use, back up `nyumba.db` regularly.

Settings (environment variables): `PORT`, `DB_FILE`, `ADMIN_PHONE`, `TRUST_PROXY`, `SECURE_COOKIES`.

## How it works

- Anyone can browse houses and house hunter requests. Phone numbers show only to signed-in people.
- Caretakers, landlords and agents post houses. House hunters post what they are looking for.
- A house hunter taps "Request viewing". The poster sees the hunter's name, number, time and message under My account.

## Not included yet

Password reset, phone number verification by SMS, photos, and an admin screen for moderation (the admin account can remove listings from the normal pages).
