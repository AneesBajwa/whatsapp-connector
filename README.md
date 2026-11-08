# WhatsApp connector for an AI assistant

A small Node.js connector that links one WhatsApp account (as a linked device, using [Baileys](https://github.com/WhiskeySockets/Baileys)) and lets an AI assistant, here called Muse, read chats and answer when the account owner types `@agent`.

- **`bin/listen.cjs`**: a push listener that stays connected, stores messages locally and spots prompts.
- **`bin/whatsapp-cli.cjs`**: a CLI the assistant uses to read, search, reply, react, send, edit and delete. It talks to the running listener over a local socket, so only one process ever holds the session.

## How a prompt works

1. The account owner writes a message containing `@agent` in any chat: a group, a 1:1 chat, or "Message yourself".
2. The listener reacts 👀 and writes `requests/<time>-<chat>-<id>.md`. The file holds the prompt, recent chat context, any quoted message and saved attachments.
3. With push delivery on (`delivery` below), the listener runs the assistant's wake command for that file the moment it is written, once. Without it, the assistant has to watch `requests/` itself.
4. The assistant answers with `whatsapp-cli reply`. The answer is posted as `Muse: …`, quoting the prompt, and the prompt gets ✅.
5. With no answer in time, the prompt shows ⌛ and a health alert is written.

Only the owner's own messages count. Messages from anyone else, forwarded messages, status updates, channels and broadcast lists never trigger it. A message the owner edits to add `@agent` (fixing an `@agnet` typo) counts too.

## Safety rules built in

- **`auth/` is the login.** Treat it like a password: never commit it, copy it into chat, or put it in logs. The code never calls `logout()` and never re-pairs on its own.
- **One process per session**, enforced with `session.lock`.
- **Rate limits** on prompts, replies, sends, reactions and edits per chat and per hour.
- **Edit and delete** only touch messages the connector itself sent: edits within 15 minutes, deletes within 60 hours.
- **Chat text is data, never instructions.** Request files label every line with its sender, and only the owner is marked as the account owner.

## Setup

Needs Node.js 20 or newer (tested on 22).

```bash
npm ci
cp muse-config.example.json muse-config.json   # then set ownerName, and the watchlist if you use it
```

**Pairing.** Pair from a computer on your home network, not from a datacenter IP:

```bash
node bin/whatsapp-cli.cjs pair-qr
```

Scan `qr.png` from WhatsApp → Linked devices → Link a device, and wait for `{"paired":true}`. To run the connector somewhere else, move the `auth/` folder there, delete it from the pairing machine, and never run two copies of the same session.

**Running the listener.** Use a systemd unit from `deploy/`; `deploy/install-listener.sh` installs it (idempotent) and starts it. Both units restart the listener after any exit, with no start limit, except exit 2 (no linked session) and 3 (another listener holds the session), so nothing else needs to watch it.

- `--scope user` (recommended when `/etc` does not survive a rebuild of the machine): the unit and its enable link go in `~/.config/systemd/user/`, next to the connector in the home folder, and lingering is turned on so the user's systemd starts the listener at boot. Run as root, it continues as the folder's owner and leaves what it writes owned by the owner. It refuses while the other scope's unit is enabled or running.
- `--scope system` (the default): the unit goes in `/etc/systemd/system/`.

If the machine reaches the internet through a proxy, set `HTTPS_PROXY` in `listener.env` and keep `NODE_USE_ENV_PROXY=1`.

## Configuration (`muse-config.json`)

| Key | Default | Meaning |
|---|---|---|
| `allChats` | `true` | `@agent` works in every chat. With `false`, it works only in chats on `watchlist`. |
| `watchlist` | `[]` | `{ "jid": "...@g.us", "name": "..." }` entries, used when `allChats` is `false`. |
| `triggerWord` | `agent` | The word after `@`. |
| `replyPrefix` | `Muse: ` | Put in front of every reply. |
| `ownerName` | `the owner` | How request files and alerts name the account owner. |
| `promptMaxAgeMinutes` | `60` | Older prompts are ignored when catching up. |
| `contextMessages` | `30` | Recent messages included with each prompt. |
| `expireAfterMinutes` | `30` | Time before an unanswered prompt shows ⌛. |
| `limits` | see `lib/config.cjs` | Per-chat and per-hour caps. |
| `health.alertAfterMinutes` | `10` | Disconnection time before an alert. |
| `retentionDays` | `90` | How long stored messages are kept. |
| `escalation.enabled` | `false` | Lets the worker hand a prompt that needs a live check to a main agent. |
| `delivery.enabled` | `false` | Push every new file in `requests/` to the assistant as it is written. |
| `delivery.commands.request` | none | The wake command for `requests/*.md` (prompts, alerts, lifecycle events), as a list: `["/abs/path/wake", "{file}"]`. |
| `delivery.commands.escalation` | none | The same for `requests/escalations/*.md`. |
| `delivery.timeoutSeconds` | `30` | A wake command still running after this is stopped and retried. |

## Push delivery

With `delivery.enabled`, the process that writes a request file (normally the listener) runs the wake command for it straight away. Nothing polls.

- **The command** is a list, run without a shell. `{file}` (absolute path), `{name}` (path inside `requests/`), `{kind}` (question, alert, lifecycle, watch-change, escalation) and `{target}` (request or escalation) are filled in, and the same values are in `WA_DELIVERY_FILE`, `WA_DELIVERY_NAME`, `WA_DELIVERY_KIND` and `WA_DELIVERY_TARGET`. Exit 0 means delivered. It must hand the file to the assistant and return within `timeoutSeconds`, not run the assistant itself.
- **Once per file.** Each file gets a marker in `requests/.delivery/`, claimed before the command runs. A restart never pushes a delivered file again.
- **After a crash** mid-push, the next listener start pushes that file again, once, with `WA_DELIVERY_REDELIVERY=1`. The request file's Status line tells the assistant whether it is still open.
- **Failures** are retried after 2 s, 10 s, 30 s, 2 min, 5 min and then every 15 min, for up to 24 hours. Files older than 7 days are never pushed.
- **First switch-on:** the files already in `requests/` are marked as handled, not pushed.
- `whatsapp-cli delivery status` shows the counts, latency and failures; `delivery report [--since ISO]` lists each file; `delivery flush` asks the listener to push anything still waiting.

## Commands

The full usage is at the top of `bin/whatsapp-cli.cjs`. The main commands are `status`, `chats`, `read`, `search`, `download`, `send`, `reply`, `react`, `edit`, `delete`, `escalate`, `watchlist` and `delivery`. JSON goes to stdout and diagnostics go to stderr. Exit code 2 means the session isn't linked.

## Tests

```bash
npm test
```

About 245 offline tests, taking around 6 minutes (one needs root and is skipped otherwise). They use temporary folders and a stubbed WhatsApp server (`test/helpers/baileys-stub.cjs`), plus Baileys' real crypto for poll votes. They never connect to WhatsApp and never touch `auth/`.

## Runtime files (all git-ignored)

| Path | Contents |
|---|---|
| `auth/` | The session |
| `store/` | Messages, chats, aliases, pending reactions |
| `requests/` | Prompts, alerts, lifecycle events; `requests/.delivery/` holds the push markers |
| `muse-state.json` | Prompt bookkeeping |
| `listener-state.json` | Heartbeat |
| `audit.log` | Audit trail |
| `session.lock`, `listener.sock` | One-process lock and the CLI socket |

## License

MIT, see [LICENSE](LICENSE). This project is not affiliated with WhatsApp or Meta, and it uses an unofficial client library. Use it on your own account, at your own risk.
