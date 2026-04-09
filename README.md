# assign-bot

A GitHub App built with [Probot](https://github.com/probot/probot) that manages issue assignments with time-limited deadlines, a global 2-issue cap per contributor, and automatic expiry enforcement.

## Features

- **Slash-command driven** — contributors self-assign via issue comments
- **Label-based time limits** — deadline is set automatically based on difficulty labels
- **Global 2-issue limit** — no contributor can hold more than 2 active assignments across all repos
- **Auto-expiry** — a cron job runs every 10 minutes and unassigns timed-out contributors
- **Maintainer deadline extension** — collaborators with write/maintain/admin access can extend deadlines
- **`multiple_pr` mode** — per-repo config to skip deadlines entirely (useful for contribution-heavy repos)

---

## Commands

All commands are issued by posting a comment on an issue.

### `/assign`

Self-assign the issue you are commenting on.

```
/assign
```

- Checks that you don't already hold 2 active assignments (globally).
- Checks that the issue isn't already assigned to someone else.
- Sets a deadline based on the issue's difficulty label (see [Time Limits](#time-limits)).
- Adds you as a GitHub assignee and posts a confirmation comment with the deadline.

**No arguments needed.** The bot assigns the commenter automatically.

---

### `/unassign`

Remove yourself from an issue you are assigned to.

```
/unassign
```

- Removes you as a GitHub assignee.
- Marks the assignment as `UNASSIGNED` in the database, freeing up one of your 2 slots.

---

### `/extend Xh`

*(Maintainers only — requires Write, Maintain, or Admin permission)*

Extend the deadline of the currently active assignment on this issue by `X` hours.

```
/extend 2h
/extend 4 h
```

- Only collaborators with `write`, `maintain`, or `admin` permission can use this.
- If the issue has no active assignment (or was assigned under `multiple_pr` mode with no deadline), this is a no-op.

---

## Time Limits

When `multiple_pr` is **not** enabled, the deadline is derived from the issue's labels:

| Label | Time Limit |
|---|---|
| `basic` | 1.5 hours |
| `very easy` | 1.5 hours |
| `easy` | 1.5 hours |
| `medium` | 3 hours *(default)* |
| `hard` | 5 hours |
| `very hard` | 5 hours |
| `exceptionally hard` | 8 hours |

If no matching label is found, the default of **3 hours** is applied.

Only the **first matching label** is used.

---

## Configuring `multiple_pr` Mode

Some repositories (e.g., high-traffic open-source projects) don't need time limits — they just want to prevent duplicate assignments. You can disable deadlines entirely by adding a config file to your repo.

### Setup

Create the file `.github/assign-bot.yml` in the repository where the app is installed:

```yaml
# .github/assign-bot.yml

# Set to true to disable deadline enforcement for this repo.
# Contributors can still only hold 2 active issues globally.
multiple_pr: true
```

| Setting | Type | Default | Description |
|---|---|---|---|
| `multiple_pr` | boolean | `false` | Disables deadline tracking. Assignments are still recorded in the DB and count toward the global 2-issue limit. |

When `multiple_pr: true`:
- No `deadline` is stored for assignments in this repo.
- The `/extend` command has no effect.
- The auto-expiry scheduler skips assignments without a deadline.
- The confirmation comment will say "No time limit will be enforced."

---

## Automatic Expiry

A background scheduler runs every **10 minutes** and scans for ACTIVE assignments whose deadline has passed. For each expired assignment it:

1. Marks the assignment as `TIMED_OUT` in the database
2. Removes the contributor as a GitHub assignee
3. Posts a comment on the issue notifying that the deadline expired

---

## Deployment

### Prerequisites

- Node.js 22.x
- A PostgreSQL database (e.g., [Supabase](https://supabase.com))
- A [GitHub App](https://github.com/settings/apps) with the following configuration:

**Permissions:**
| Permission | Level |
|---|---|
| Issues | Read & Write |
| Metadata | Read-only |

**Subscribe to events:**
- Issues
- Issue comment

**Webhook URL:** `https://<your-host>/api/github/webhooks`

### Environment Variables

| Variable | Description |
|---|---|
| `APP_ID` | GitHub App ID |
| `PRIVATE_KEY` | GitHub App private key (PEM, newlines as `\n`) |
| `WEBHOOK_SECRET` | Webhook secret set on the GitHub App |
| `GITHUB_CLIENT_ID` | GitHub App OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub App OAuth client secret |
| `DATABASE_URL` | PostgreSQL connection string |
| `HOST` | Bind address — set to `0.0.0.0` on Heroku |
| `PORT` | Port to listen on (set automatically by Heroku) |

### Install & Run

```bash
npm install
npm run build       # generates Prisma client + compiles TypeScript
npm run db:push     # pushes schema to the database (run once after setup)
npm start
```

For local development with hot-reload:

```bash
npm run dev
```

### Heroku

The app includes a `Procfile` and is ready to deploy:

```bash
heroku create <app-name>
heroku config:set APP_ID=... PRIVATE_KEY=... WEBHOOK_SECRET=... \
  GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... DATABASE_URL=... HOST=0.0.0.0
git push heroku master
heroku run npm run db:push
```

> **Note:** Use Supabase's **Session pooler** URL (port 5432, not 6543) for `DATABASE_URL` — Prisma is incompatible with the transaction pooler.

---

## Database Schema

| Model | Key Fields |
|---|---|
| `User` | `id`, `username` (unique) |
| `Assignment` | `userId`, `repoOwner`, `repoName`, `issueNumber`, `deadline`, `status` |
| `Waitlist` | *(reserved for future use)* |

Assignment statuses: `ACTIVE` · `CLOSED` · `TIMED_OUT` · `UNASSIGNED`

---

## License

ISC
