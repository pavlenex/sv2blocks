# SV2 X bot

A small Python script that watches [mempool.space](https://mempool.space) and posts from a **separate** X bot account whenever a new Stratum V2 Bitcoin block is mined. In this repository it runs from GitHub Actions, with keys stored only in repository Secrets.

The [workflow](../.github/workflows/sv2-x-bot.yml) starts right after every **Update data and deploy** run, so it follows the same 10-minute rhythm as the site (GitHub's own schedule is only a fallback, because it proved unreliable for this repository). A quiet run makes about five requests to the mempool API.

Detection is close to the website's own matcher in `scripts/lib/detect.mjs`: the coinbase scriptsig (`extras.coinbaseRaw`) is decoded to printable ASCII, and a tag containing `Sv2`, `stratum v2`, or `stratumv2` counts. A bare `v2` does not, even inside `/v2/`, because random extranonce bytes can spell that by chance. The pool name comes from `extras.pool.name`. The website additionally applies `data/overrides.json` (for example DMND block 955,318) when it builds the site; this bot does not reuse that file, and on first run it only records the current tip, so it will not tweet historical or override-only blocks.

It will not post a backlog on first run. Without `--backfill-hours` it only records the current tip and waits for the next SV2 block.

## Setup on this repository (GitHub Actions)

Do this after the bot files and `.github/workflows/sv2-x-bot.yml` are on the default branch (`master`).

1. **Create the bot account** (if you have not already). This repo's site already links to [@sv2blocks](https://x.com/sv2blocks). In the bio, say that it is a bot and who runs it, for example `SV2 block bot managed by @pavlenex`. Turn on the Automated label from [account automation settings](https://x.com/settings/account/automation) if the option is available, with `@pavlenex` as the managing account.

2. **Get X API keys** signed in as the **bot** at [console.x.com](https://console.x.com). Set User authentication to **Read and write**, then generate the Access Token and Secret (tokens created before that permission change stay read-only). You need four values: API Key (Consumer Key), API Secret, Access Token, Access Token Secret. Add credits in the developer console; a paid X Premium on @pavlenex does not cover this API.

3. **Store the keys only in GitHub Secrets.** In the repo: **Settings → Secrets and variables → Actions**, add:
   - `X_API_KEY`
   - `X_API_SECRET`
   - `X_ACCESS_TOKEN`
   - `X_ACCESS_TOKEN_SECRET`

   Never commit a `.env` or paste keys into the workflow file. Enable **secret scanning** and **push protection** under **Settings → Code security** so a stray key cannot be pushed. The workflow passes these values as environment variables only to the "Run bot" step, and only runs when `github.repository == 'pavlenex/sv2blocks'` (forks never post).

4. **Workflow permissions.** Nothing to change. The workflow asks for `contents: write` itself, for the one job that saves `bot-state`, so the repository default can stay on read-only.

5. **First run.** Open **Actions → SV2 X bot → Run workflow** on `master`. This:
   - creates the orphan branch `bot-state` if it does not exist (you do not need to create it yourself);
   - writes `state.json` at the current chain tip;
   - posts nothing.

   After that, the workflow runs after each data update and posts only for SV2 blocks found after that tip. State is saved to `bot-state`, not `master`, and pushes made by a workflow never start other workflows, so it cannot retrigger the GitHub Pages deploy. The branch is rewritten as a single commit each time, so it does not grow.

If runs are late or one fails, the script catches up from `state.json` and posts any SV2 blocks it has not already posted. State is saved even when a run fails part-way, and if X refuses a post as a duplicate the block is simply marked as posted.

### Local check (no posting)

```bash
cd bot
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python sv2_bot.py --self-test
.venv/bin/python sv2_bot.py --dry-run --backfill-hours 72 --no-save-state
```

A VPS or a machine already running a node can instead run `sv2_bot.py --once` from cron. Copy `bot/.env.example` to `bot/.env`, fill in the four keys, and `chmod 600 bot/.env`. GitHub Actions is the path this repo is set up for.

## Tweet format

Default template (configurable via `TWEET_TEMPLATE`):

```
Stratum V2 block #976280 mined by
MARA Pool

Subsidy + fees: 3.161 BTC
```

By default `{pool}` is the plain pool name as mempool.space gives it (`MARA Pool`). X's [automation rules](https://help.x.com/en/rules-and-policies/x-automation) allow automated @mentions only of accounts that have opted in, so tagging is off unless you switch it on: set the repository variable `SV2_BOT_MENTION_POOLS` to `true` (**Settings → Secrets and variables → Actions → Variables**), or `MENTION_POOLS=true` in `.env`.

With tagging on, `{pool}` is an `@handle` only when `pools.json` lists a **high-confidence official account of the pool or mining company itself** (`confidence=high` and `type=pool`). Individuals, solo miners, parent-exchange accounts (for example Binance, OKX, WhiteBIT), and medium-confidence matches are written as the plain mempool.space pool name — the name still appears in the tweet, just without an @mention. If mempool labels the miner `Unknown`, the tweet says `Unknown`. The per-pool SV2 count is still stored in `state.json` but is not used in the default tweet. Template variables: `{pool}`, `{pool_name}`, `{reward}`, `{height}`, `{hash}`, `{url}`, `{when}`, `{nth}`, `{n}`, `{tag}`.

The block URL is omitted unless you pass `--block-link` or set `INCLUDE_BLOCK_LINK=true`.

### Pool handles

`pools.json` covers every pool returned by `https://mempool.space/api/v1/mining/pools/all`, plus extra names from the [mempool/mining-pools](https://github.com/mempool/mining-pools) `pools-v2.json` file. Each entry has `confidence` (`high` / `medium` / `none`) and `type` (`pool`, `individual`, `exchange`, `rebrand`, or `none`). The bot @mentions `handle` only when `confidence` is `high` and `type` is `pool`; otherwise `handle` is `null` and the tweet uses the plain name. `found_handle` keeps the researched account for review even when it is not tagged.

`pools_review.csv` is a spreadsheet of the same data (name, slug, website, X handle, confidence, type, tagged, reason, source) so you can correct anything before going live. `POOL_HANDLES=Name:@handle` in `.env` (or a GitHub Actions env var, if you add one later) overrides a single entry without editing the JSON (an explicit override is always tagged).

## Telegram

New blocks are also posted to our [Telegram channel](https://t.me/+LZeFAU3jydQxZGY0), where they can be tracked. The bot posts there when the secret `TELEGRAM_BOT_TOKEN` and the variable `TELEGRAM_CHANNEL` are set.

## Discord

New blocks are also posted to a Discord channel when the secret `DISCORD_WEBHOOK_URL` (the channel's webhook address) is set.

## Dependencies

`requirements.txt` pins every package, including indirect ones, to an exact version with file hashes, and the workflow installs with `--require-hashes`. Edit `requirements.in` and regenerate it with [pip-tools](https://pip-tools.readthedocs.io): `pip-compile --generate-hashes --strip-extras --allow-unsafe -o requirements.txt requirements.in`.

## Commands

| Command | What it does |
| --- | --- |
| `sv2_bot.py --once` | One poll. Default. Used by the workflow. |
| `sv2_bot.py --loop --interval 60` | Poll forever. |
| `sv2_bot.py --dry-run ...` | Print tweets, do not call the X API. |
| `sv2_bot.py --backfill-hours 72` | Also consider SV2 blocks from the last N hours (if they are not already in state). |
| `sv2_bot.py --no-save-state` | Leave `state.json` untouched. |
| `sv2_bot.py --self-test` | Local detection fixtures. |
| `sv2_bot.py --block-link` | Append the mempool.space URL (off by default; URL posts cost more on the X API). |
| `sv2_bot.py --telegram-test` | Send one test message to the Telegram channel and exit. |
| `sv2_bot.py --no-block-link` | Force-omit the URL if `INCLUDE_BLOCK_LINK=true` is set. |
| `sv2_bot.py --pools-file /path/pools.json` | Override the pool-handle map. |
| `sv2_bot.py --state-file /path/state.json` | Override the state path. The workflow points this at the `bot-state` worktree. |
| `sv2_bot.py -v` | Debug logging. |

## How state and reorgs work

`state.json` stores the last processed height and hash, per-pool SV2 counts, recent headers, and hashes that were already tweeted. In GitHub Actions it lives only on the `bot-state` branch, as that branch's single commit.

On a reorg the script walks back along stored headers until it finds a common ancestor, then processes the new chain. A replaced block is not "un-tweeted". A new block at the same height with a different hash will be posted if it is SV2 and that hash has not been posted before.

Seed counts in `.env` are only applied when `state.json` has no counts yet, and they are inclusive of `SV2_SEED_HEIGHT`. If a backfill still includes that height, the script rewinds the seed so the tweet ordinals stay correct (977145 = 6th, 977316 = 7th).
