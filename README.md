# Faction Wars
https://www.crazygames.com/game/light-vs-dark
A 2D strategy card game played between the **Light** and **Dark** factions. You can play against the computer or challenge another player online. The game features an interface available in both English and Arabic, an in-game guide, and optional turn time limits.

## Requirements

- Node.js (a version that supports CommonJS).
- An internet connection to load the "Material Symbols" font, and a Socket.IO connection for multiplayer gameplay.

## Running Locally

```bash
npm install
npm start
```

Open `http://localhost:5501` in your browser. By default, the server runs on port `5501`, or on a port specified by the environment variable `PORT`.

For local development, please use `npm start`, as the Express server handles both developer note-taking and multiplayer functionality. Do not use the VS Code **Live Server** extension; it only serves static files, which will cause requests to `/api/developer-note` and `/api/developer-access` to return a 404 error. If you are using the Render server configuration specified in `index.html`, you can open the file directly from your machine once CORS support has been enabled on Render. After modifying `server.js` or any environment variables, restart the server or redeploy the application to ensure the changes take effect.

To enable the developer panel, add `DEVELOPER_ACCESS_PASSWORD` as a secret environment variable in your hosting environment and redeploy. Never include the password in your frontend files or the repository itself. Open the developer panel using the **DEV** button, enter your password, and click "Enter." You may retry if a connection error occurs or if the password is incorrect.

On Render, configure the `DEVELOPER_ACCESS_PASSWORD` variable under **Environment**. To persist notes across service restarts or deployments, attach a persistent disk at `/var/data` and set the `DEVELOPER_NOTES_FILE` variable to `/var/data/developer-notes.json`. Without a persistent disk, notes may be lost whenever the service restarts. After updating `server.js`, redeploy the service to enable the CORS headers required to launch the game from a local file or a separate frontend domain.

- **Challenge Computer**: Play against the computer; no other player is required.
- **Challenge Real Players**: Multiplayer mode; open the game in two separate browser windows or on two different devices, select this mode in both, and then send a challenge via the player list.

## Technologies and Project Structure

- Frontend: HTML, CSS, and JavaScript—no build step or bundler required.
- Backend: Express and Socket.IO (defined in `server.js`).
- Frontend files: `index.html`, `css/`, `js/`, and `assets/`.
- Multiplayer game state is stored locally by default in `.runtime/online-matches.json`. This location can be changed using the `GAME_STATE_FILE` variable.

## Prepared Text for the Game’s CrazyGames Page

### Description

Lead the Light or Darkness in Faction Wars, a strategic fantasy card game where rival factions clash for victory. Summon powerful cards, manage your gold, and outsmart your opponent with clever attacks and special abilities. Challenge the computer or battle another player online!

### Controls

Use your mouse or tap the screen to select cards and game options. Play cards and use abilities with the on-screen buttons, choose a target to attack, manage your gold in the Bank Market, and press End Turn when you are ready to pass the turn.

## Publishing on CrazyGames

### 1. Prepare the Game

1. Test the game on both desktop and mobile; ensure that the Arabic and English interfaces appear correctly, and that all images and fonts load properly.
2. Test the desktop mode, and verify that two-player connectivity works in multiplayer mode.
3. Test the game via a public HTTPS URL and within an `iframe`—do not rely solely on `localhost`.
4. Review the current CrazyGames requirements, and prepare the game description, instructions, and the cover images/videos needed for submission.

### 2. Begin with a "Basic Launch"

Submit your game via the [Developer Portal](https://developer.crazygames.com/) and follow the quality assurance tool and instructions provided there. According to the [official documentation](https://docs.crazygames.com/), a **Basic Launch** does not require SDK integration; however, you must still meet the core launch requirements and pass a quality review. Advertisements and monetization features are not available at this stage.

This web game does not require a Unity export; the frontend consists of raw HTML, CSS, and JavaScript files. Use the upload or hosting method specified by the Developer Portal, and ensure that your submission includes an `index.html` file along with `css/`, `js/`, and `assets/` directories.

### 3. Set Up Multiplayer Hosting

Multiplayer functionality and developer feedback interfaces rely on a Node.js server, rather than just the frontend files. The server address is configured in `index.html` via `window.GAME_SERVER_URL`. Update it to point to your server's public HTTPS address before uploading the frontend files to CrazyGames.

Host `server.js` on a public service that supports HTTPS/WSS and WebSockets, and ensure that the `/health` endpoint returns `{ "ok": true }`. The feedback interfaces must allow CORS requests from the published game. To enable the feedback view, set `DEVELOPER_ACCESS_PASSWORD` in the server's environment variables and redeploy; do not include the password in the frontend files or the repository. After updating the server address, upload the revised frontend files to CrazyGames and test the connection. If using a temporary hosting service, ensure that feedback files and match states are stored in persistent storage.

### 4. Consider a Full Launch Later

If CrazyGames invites you to a **Full Launch**, review the requirements for that phase and integrate the CrazyGames SDK according to the documentation—including triggering the `GameplayStart` event at the correct moment. Do not add third-party advertisements; instead, use the platform's integration tools and adhere to its policies. Additional requirements may apply to multiplayer games.

## Quick Checklist Before Submission

- [ ] The game loads quickly; monitor this.
