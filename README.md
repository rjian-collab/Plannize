# Plannize

A frosted-glass personal project manager for Windows (Electron + Express). Everything is stored on your own computer.

> The interface is currently in Traditional Chinese (繁體中文).

## Features

- List, card and calendar views; category and priority filters; search; subtasks
- Projects archive themselves at 100% progress, with a completion animation
- Deadline reminders as Windows toast notifications, scheduled through Windows Task Scheduler — nothing stays running in the background
- Recurring routines (daily / weekly / monthly) with check-ins, streaks and a 12-week history
- Automatic daily backups (14 days kept) with one-click restore
- Optional: two-way Google Calendar sync, Gmail reminder emails, Google Drive links

## Install

Download the latest `Plannize-Setup-<version>.exe` from [Releases](https://github.com/rjian-collab/Plannize/releases/latest) and run it. Your data is stored in `%APPDATA%\Plannize\data`.

Requires Windows 10 or 11 (64-bit). The frosted-glass window backdrop is a Windows 11 feature; Windows 10 shows a plain background.

> The installer is **not code-signed**, so Windows SmartScreen may show "Windows protected your PC". Click **More info → Run anyway**. You can compare the file's SHA-256 with the one listed in the release notes.

## Run from source

Requires [Node.js](https://nodejs.org/) 22 or newer.

```
npm install
npm run electron
```

When run from source, data is stored in `data\` inside the project folder (excluded by `.gitignore`).

> Plannize listens on `127.0.0.1:47821` and shares one set of reminder tasks (the `ProjMgr` folder in Task Scheduler), so run **either** the installed app **or** the source version at a time, not both.

## Build the installer

```
npm ci
npm run dist
```

The installer is written to `dist\Plannize-Setup-<version>.exe`.

## Reminders

Each reminder is a one-shot task in Windows Task Scheduler under the `ProjMgr` folder (current user, no admin rights). When it fires it shows one notification, optionally sends an email, deletes itself and exits. Reminders missed while the PC was off or asleep are delivered when it wakes. To remove them all, delete the `ProjMgr` folder in Task Scheduler; Plannize recreates what it needs the next time it starts.

## Backups

A copy of your data is saved to `data\backup\` once a day (the newest 14 are kept). Open **⚙️ Settings → Data backup** to back up immediately, open the folder, or restore any copy. Restoring first saves your current data as a "before restore" backup.

## Google features (optional)

Plannize ships with no keys; you create your own Google OAuth client:

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Calendar**, **Gmail** and **Drive** APIs.
2. Configure the OAuth consent screen (user type **External**) and **publish it** (status *In production*). If it stays in *Testing*, Google expires the sign-in every 7 days.
3. Create an OAuth client ID of type **Desktop app** and download its JSON.
4. Save it as `data\google-credentials.json` (for the installed app: `%APPDATA%\Plannize\data\google-credentials.json`). It must contain `client_id` and `client_secret`.
5. In the app, open **⚙️ Settings → Link Google account** and sign in. Because the client is your own and unverified, Google shows a warning — choose **Advanced → continue**.

Only the narrowest scopes are requested: `gmail.send` (send only, cannot read mail), `calendar.app.created` (only the calendar Plannize creates), `drive.metadata.readonly` (file names and links only), plus `openid email`. The sign-in token is stored encrypted (Windows DPAPI) on your computer and is only ever sent to Google.

Two-way calendar sync uses a dedicated calendar named **Plannize**: projects with a deadline appear there as all-day events, dragging an event to another day changes the deadline, and events added in that calendar become new projects.

## License

[MIT](LICENSE)
