#!/usr/bin/env python3
"""Tweet whenever a new Stratum V2 Bitcoin block appears on mempool.space.

Detection matches the daily SV2 recap: decode extras.coinbaseRaw (the
coinbase scriptsig) to printable ASCII and look for an Sv2 / Stratum V2
tag. A bare "v2" is not enough — random extranonce bytes can spell that
by chance.

The same blocks can also be posted to a Telegram channel (set
TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL), to a Discord channel (set
DISCORD_WEBHOOK_URL) and to Nostr (set NOSTR_PRIVATE_KEY). See README.md.

This script never posts unless it is given X API user-context credentials
and is run without --dry-run. First run without --backfill-hours only
initialises state at the current tip so it will not dump a backlog of
old blocks onto a new account.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import requests
from requests_oauthlib import OAuth1

# Only Nostr needs these two. Without them everything else still works.
try:
    import websocket  # the "websocket-client" package
    from coincurve import PrivateKey, PublicKeyXOnly
except ImportError:  # pragma: no cover - optional unless NOSTR_PRIVATE_KEY is set
    websocket = None  # type: ignore[assignment]
    PrivateKey = PublicKeyXOnly = None  # type: ignore[assignment,misc]

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional at runtime if env is already set
    def load_dotenv(*_args: Any, **_kwargs: Any) -> bool:
        return False

log = logging.getLogger("sv2-x-bot")

DEFAULT_MEMPOOL = "https://mempool.space"
DEFAULT_TWEET_API = "https://api.x.com/2/tweets"
DEFAULT_TELEGRAM_API = "https://api.telegram.org"
DEFAULT_TEMPLATE = (
    "Stratum V2 block #{height} mined by\n"
    "{pool}\n"
    "\n"
    "Subsidy + fees: {reward} BTC"
)
DEFAULT_SEED_COUNTS = "MARA Pool:7"
DEFAULT_SEED_HEIGHT = 977316
# Optional Name:@handle overrides; the full map lives in pools.json.
DEFAULT_POOL_HANDLES = ""
DEFAULT_POOLS_FILE = "pools.json"
REORG_DEPTH = 32
PAGE_SLEEP = 0.4
HTTP_TIMEOUT = 30
USER_AGENT = "sv2-x-bot/1.0"
MAX_TWEET_LEN = 280
MAX_TELEGRAM_LEN = 4096
MAX_DISCORD_LEN = 2000
MAX_NOSTR_LEN = 2000
# Used when NOSTR_RELAYS is not set: long-standing free public relays. A note is posted once any
# one of them accepts it, so a relay being down or closed to new accounts does no harm.
DEFAULT_NOSTR_RELAYS = (
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://relay.snort.social",
    "wss://nostr.mom",
)
MAX_NOSTR_RELAYS = 12
NOSTR_TIMEOUT = 10
NOSTR_KIND_TEXT_NOTE = 1
# Blocks waiting for Telegram or Discord are kept in state.json; this caps each queue if the
# service stays unreachable or misconfigured for a long time.
MAX_PENDING_POSTS = 50
# A rate limit is waited out in full. If the service asks for longer than this, the message is
# left queued for the next run instead of being retried too early.
MAX_RATE_LIMIT_WAIT = 60.0
# A longer rate limit is remembered in state.json, so no run tries again before it has passed.
# This caps a nonsensical value from the service.
MAX_RATE_LIMIT_HOLD = 24 * 3600.0
CONNECTED_TEXT = "sv2blocks is connected. New Stratum V2 blocks will be posted here."
# A Discord webhook address is only ever one of these hosts followed by this path.
DISCORD_WEBHOOK_HOSTS = ("discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com")
DISCORD_WEBHOOK_PATH = "/api/webhooks/"

# Known coinbaseRaw values from the recap, used by --self-test.
FIXTURE_977145 = (
    "03f9e80e1a5376322f4d415241f09f87baf09f87b8f09f87baf09f87b8"
    "2f2f140100001600000000000000000000156700317af5"
)
FIXTURE_977316 = (
    "03a4e90e1a5376322f4d415241f09f87baf09f87b8f09f87baf09f87b8"
    "2f2f14010000030000000000000000000014a700531d55"
)


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

def ascii_runs(raw_hex: str) -> list[str]:
    """Split a hex string into runs of printable ASCII (bytes 32-126)."""
    if not raw_hex:
        return []
    raw_hex = raw_hex.strip()
    if len(raw_hex) % 2:
        raw_hex = raw_hex + "0"
    try:
        data = bytes.fromhex(raw_hex)
    except ValueError:
        return []
    runs: list[str] = []
    cur: list[str] = []
    for b in data:
        if 32 <= b <= 126:
            cur.append(chr(b))
        else:
            if cur:
                runs.append("".join(cur))
                cur = []
    if cur:
        runs.append("".join(cur))
    return runs


def classify(runs: list[str]) -> dict[str, Any]:
    """Decide whether ASCII runs from a coinbase contain an SV2 tag.

    Counted: "sv2", "stratum v2", or "stratumv2" (case-insensitive).
    Borderline, not counted: a bare "v2" sitting in a slash-delimited tag
    like /v2/ or v2/.... Random "v2" in extranonce bytes is ignored.
    """
    counted = False
    matched_text: Optional[str] = None
    borderline = False
    borderline_why: Optional[str] = None

    for run in runs:
        rlow = run.lower()
        if "stratum v2" in rlow or "stratumv2" in rlow or "sv2" in rlow:
            counted = True
            matched_text = run.strip()
            m = re.search(
                r"(?i)[^\s]{0,20}(?:stratum\s*v2|stratumv2|sv2)[^\s]{0,20}",
                run,
            )
            if m:
                matched_text = m.group(0)
            break

    if not counted:
        v2_hits: list[str] = []
        first_run: Optional[str] = None
        for run in runs:
            for m in re.finditer(r"(?i)v2", run):
                start, end = m.span()
                prefix = run[max(0, start - 10) : start].lower()
                # Already covered by the sv2 / stratumv2 branch above.
                if prefix.endswith("s") or prefix.endswith("stratum"):
                    continue
                why = None
                if (
                    start > 0
                    and run[start - 1] == "/"
                    and end < len(run)
                    and run[end] == "/"
                ):
                    why = f"bare v2 inside slash-delimited tag /v2/ in {run!r}"
                elif end < len(run) and run[end] == "/" and (
                    start == 0 or not run[start - 1].isalnum()
                ):
                    why = f"bare v2 at start of slash-delimited tag v2/... in {run!r}"
                elif start > 0 and run[start - 1] == "/" and (
                    end == len(run) or not run[end].isalnum()
                ):
                    why = f"bare v2 at end of slash-delimited tag .../v2 in {run!r}"
                if why:
                    v2_hits.append(why)
                    if first_run is None:
                        first_run = run.strip()
        if v2_hits:
            borderline = True
            borderline_why = "; ".join(v2_hits)
            matched_text = first_run

    return {
        "counted": counted,
        "matched_text": matched_text,
        "borderline": borderline and not counted,
        "borderline_why": borderline_why if (borderline and not counted) else None,
        "runs": runs,
    }


def is_sv2_coinbase(raw_hex: str) -> tuple[bool, Optional[str], dict[str, Any]]:
    cls = classify(ascii_runs(raw_hex))
    return bool(cls["counted"]), cls.get("matched_text"), cls


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ordinal(n: int) -> str:
    if n < 0:
        n = 0
    if 10 <= (n % 100) <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def parse_pairs(raw: str, sep: str = ",") -> dict[str, str]:
    """Parse 'Key:value, Other:value2' into a dict. Keys are stripped."""
    out: dict[str, str] = {}
    if not raw or not raw.strip():
        return out
    for part in raw.split(sep):
        part = part.strip()
        if not part:
            continue
        if ":" not in part:
            log.warning("Ignoring malformed pair %r (expected Name:value)", part)
            continue
        key, value = part.split(":", 1)
        out[key.strip()] = value.strip()
    return out


def parse_seed_counts(raw: str) -> dict[str, int]:
    pairs = parse_pairs(raw)
    counts: dict[str, int] = {}
    for name, value in pairs.items():
        try:
            counts[name] = int(value)
        except ValueError:
            raise SystemExit(f"Invalid seed count for {name!r}: {value!r}")
    return counts


def when_label(timestamp: int, tz: ZoneInfo, overnight_start: int, overnight_end: int) -> str:
    """Return 'overnight' for local hours in [start, end), else 'today'."""
    local = datetime.fromtimestamp(timestamp, tz)
    if overnight_start <= local.hour < overnight_end:
        return "overnight"
    return "today"


def env_flag(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def format_reward_btc(sats: int | float) -> str:
    """Format extras.reward (satoshis) as BTC with 3 decimal places."""
    return f"{int(sats) / 1e8:.3f}"


def block_reward_sats(block: dict[str, Any], mempool: Optional["Mempool"] = None) -> int:
    extras = block.get("extras") or {}
    reward = extras.get("reward")
    if reward is None and mempool is not None and block.get("id"):
        try:
            detailed = mempool.block(block["id"])
            reward = (detailed.get("extras") or {}).get("reward")
        except Exception as exc:
            log.warning("Failed to fetch reward for %s: %s", block.get("id"), exc)
    if reward is None:
        raise RuntimeError(
            f"Block {block.get('height')} is missing extras.reward; will not tweet a guessed total"
        )
    return int(reward)


def load_pools(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        log.warning("pools file %s not found; tweets will use plain pool names", path)
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        pools = data.get("pools") or []
    elif isinstance(data, list):
        pools = data
    else:
        pools = []
    log.info("Loaded %s pool entries from %s", len(pools), path)
    return pools


def is_taggable_pool(pool: dict[str, Any]) -> bool:
    """Only @mention high-confidence accounts that belong to the pool itself."""
    handle = pool.get("handle")
    return bool(
        handle
        and pool.get("confidence") == "high"
        and pool.get("type") == "pool"
    )


def handle_for_pool(
    name: str,
    *,
    slug: Optional[str] = None,
    pools: list[dict[str, Any]] | None = None,
    overrides: dict[str, str] | None = None,
) -> Optional[str]:
    """Return a handle without '@', or None to use the plain pool name.

    POOL_HANDLES env overrides always win (explicit operator choice).
    Otherwise a pools.json entry is mentioned only when confidence is
    'high' and type is 'pool'. Individuals, parent-exchange accounts,
    and medium-confidence matches are left as the plain pool name.
    """
    overrides = overrides or {}
    if name in overrides:
        value = overrides[name]
    else:
        value = {k.lower(): v for k, v in overrides.items()}.get(name.lower())
    if value:
        return value.lstrip("@") or None

    def matches(pool: dict[str, Any]) -> bool:
        if pool.get("name") == name:
            return True
        if pool.get("name", "").lower() == name.lower():
            return True
        if slug and pool.get("slug") and pool["slug"].lower() == slug.lower():
            return True
        return False

    for pool in pools or []:
        if matches(pool) and is_taggable_pool(pool):
            return str(pool["handle"]).lstrip("@")
    return None


def format_tweet(
    *,
    template: str,
    pool_name: str,
    pool_display: str,
    height: int,
    block_hash: str,
    count: int,
    when: str,
    tag: Optional[str],
    reward: str,
    include_link: bool,
) -> str:
    url = f"https://mempool.space/block/{block_hash}"
    text = template.format(
        pool=pool_display,
        pool_name=pool_name,
        when=when,
        height=height,
        nth=ordinal(count),
        n=count,
        hash=block_hash,
        tag=tag or "Sv2",
        url=url,
        reward=reward,
    ).rstrip()
    if include_link and url not in text:
        text = text + "\n\n" + url
    return text


def is_duplicate_post_error(exc: Exception) -> bool:
    """True for X's 403 'duplicate content' refusal of a post it already has."""
    message = str(exc).lower()
    return "http 403" in message and "duplicate" in message


def retry_after_seconds(response: requests.Response, fallback: float) -> float:
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass
    reset = response.headers.get("x-rate-limit-reset") or response.headers.get(
        "X-Rate-Limit-Reset"
    )
    if reset:
        try:
            return max(0.0, int(float(reset)) - time.time() + 1)
        except ValueError:
            pass
    return fallback


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class HttpClient:
    def __init__(self, user_agent: str = USER_AGENT, max_retries: int = 6) -> None:
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})
        self.max_retries = max_retries

    def request(
        self,
        method: str,
        url: str,
        *,
        auth: Any = None,
        json_body: Any = None,
        expected: tuple[int, ...] = (200,),
        respect_reset: bool = True,
    ) -> requests.Response:
        backoff = 1.0
        last_error: Optional[Exception] = None
        for attempt in range(1, self.max_retries + 1):
            try:
                response = self.session.request(
                    method,
                    url,
                    auth=auth,
                    json=json_body,
                    timeout=HTTP_TIMEOUT,
                )
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_error = exc
                sleep = min(60.0, backoff)
                log.warning(
                    "Network error on %s %s (attempt %s/%s): %s; retrying in %.1fs",
                    method,
                    url,
                    attempt,
                    self.max_retries,
                    exc,
                    sleep,
                )
                time.sleep(sleep)
                backoff = min(60.0, backoff * 2)
                continue

            if response.status_code in expected:
                return response

            if response.status_code == 429:
                sleep = retry_after_seconds(response, min(60.0, backoff)) if respect_reset else backoff
                sleep = max(sleep, 1.0)
                log.warning(
                    "HTTP 429 on %s %s (attempt %s/%s); waiting %.1fs",
                    method,
                    url,
                    attempt,
                    self.max_retries,
                    sleep,
                )
                time.sleep(sleep)
                backoff = min(60.0, backoff * 2)
                last_error = RuntimeError(f"429 from {url}: {response.text[:200]}")
                continue

            if 500 <= response.status_code < 600:
                sleep = min(60.0, backoff)
                log.warning(
                    "HTTP %s on %s %s (attempt %s/%s); retrying in %.1fs",
                    response.status_code,
                    method,
                    url,
                    attempt,
                    self.max_retries,
                    sleep,
                )
                time.sleep(sleep)
                backoff = min(60.0, backoff * 2)
                last_error = RuntimeError(
                    f"{response.status_code} from {url}: {response.text[:200]}"
                )
                continue

            raise RuntimeError(
                f"HTTP {response.status_code} from {url}: {response.text[:500]}"
            )

        raise RuntimeError(f"Exhausted retries for {method} {url}") from last_error

    def get_json(self, url: str) -> Any:
        return self.request("GET", url).json()

    def get_text(self, url: str) -> str:
        return self.request("GET", url).text.strip()


class Mempool:
    def __init__(self, base: str, http: HttpClient) -> None:
        self.base = base.rstrip("/")
        self.http = http

    def tip_height(self) -> int:
        return int(self.http.get_text(f"{self.base}/api/blocks/tip/height"))

    def hash_at_height(self, height: int) -> str:
        return self.http.get_text(f"{self.base}/api/block-height/{height}")

    def blocks_page(self, end_height: Optional[int] = None) -> list[dict[str, Any]]:
        """Return up to 15 blocks, newest first. end_height is inclusive."""
        if end_height is None:
            url = f"{self.base}/api/v1/blocks"
        else:
            url = f"{self.base}/api/v1/blocks/{end_height}"
        blocks = self.http.get_json(url)
        if not isinstance(blocks, list):
            raise RuntimeError(f"Unexpected blocks payload from {url}")
        return sorted(blocks, key=lambda b: b.get("height") or 0, reverse=True)

    def block(self, block_hash: str) -> dict[str, Any]:
        return self.http.get_json(f"{self.base}/api/v1/block/{block_hash}")

    def coinbase_raw(self, block: dict[str, Any]) -> str:
        extras = block.get("extras") or {}
        raw = extras.get("coinbaseRaw") or ""
        if raw:
            return raw
        block_hash = block.get("id") or block.get("hash")
        if not block_hash:
            return ""
        try:
            detailed = self.block(block_hash)
            raw = ((detailed.get("extras") or {}).get("coinbaseRaw")) or ""
            if raw:
                return raw
        except Exception as exc:
            log.warning("Failed to fetch block %s: %s", block_hash, exc)
        try:
            txid = self.http.get_text(f"{self.base}/api/block/{block_hash}/txid/0")
            tx = self.http.get_json(f"{self.base}/api/tx/{txid}")
            vin = (tx.get("vin") or [{}])[0]
            return vin.get("scriptsig") or vin.get("scriptSig") or ""
        except Exception as exc:
            log.warning("Failed to fetch coinbase for %s: %s", block_hash, exc)
            return ""


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

def default_state() -> dict[str, Any]:
    return {
        "version": 1,
        "last_height": None,
        "last_hash": None,
        "initialized": False,
        "pool_counts": {},
        "seed_height": None,
        "posted": {},
        "recent": [],
        "telegram_pending": [],
        "discord_pending": [],
        "nostr_pending": [],
    }


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return default_state()
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    state = default_state()
    state.update(data)
    state.setdefault("pool_counts", {})
    state.setdefault("posted", {})
    state.setdefault("recent", [])
    for key in ("telegram_pending", "discord_pending", "nostr_pending"):
        if not isinstance(state.get(key), list):
            state[key] = []
    # JSON keys are strings; keep posted keys as hashes (strings).
    state["pool_counts"] = {str(k): int(v) for k, v in state["pool_counts"].items()}
    return state


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".state.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def save_state(path: Path, state: dict[str, Any]) -> None:
    # Cap growth of the posted/recent lists so the file stays small.
    posted = state.get("posted") or {}
    if len(posted) > 2000:
        # posted values may include a "ts"; drop the oldest by height.
        items = sorted(
            posted.items(),
            key=lambda kv: (kv[1] or {}).get("height") or 0,
        )
        state["posted"] = dict(items[-1500:])
    recent = state.get("recent") or []
    if len(recent) > 100:
        state["recent"] = recent[-50:]
    atomic_write_json(path, state)


def record_recent(state: dict[str, Any], height: int, block_hash: str) -> None:
    recent = list(state.get("recent") or [])
    recent = [row for row in recent if row.get("height") != height]
    recent.append({"height": height, "hash": block_hash})
    recent.sort(key=lambda row: row["height"])
    state["recent"] = recent[-50:]


# ---------------------------------------------------------------------------
# X API
# ---------------------------------------------------------------------------

class XClient:
    def __init__(
        self,
        *,
        api_key: str,
        api_secret: str,
        access_token: str,
        access_token_secret: str,
        http: HttpClient,
        endpoint: str = DEFAULT_TWEET_API,
    ) -> None:
        self.auth = OAuth1(api_key, api_secret, access_token, access_token_secret)
        self.http = http
        self.endpoint = endpoint

    def post_tweet(self, text: str) -> dict[str, Any]:
        response = self.http.request(
            "POST",
            self.endpoint,
            auth=self.auth,
            json_body={"text": text},
            expected=(200, 201),
            respect_reset=True,
        )
        return response.json()


# ---------------------------------------------------------------------------
# Telegram and Discord
# ---------------------------------------------------------------------------

class ChannelError(RuntimeError):
    """A message Telegram or Discord did not accept. Its text never contains a token or address."""

    # Seconds the service asked to wait before the next attempt, when it is rate limiting.
    retry_after: Optional[float] = None


class TelegramError(ChannelError):
    pass


class DiscordError(ChannelError):
    pass


class NostrError(ChannelError):
    pass


def retry_wait(label: str, error: type, status: int, asked: Any, backoff: float) -> float:
    """How long to wait before the next attempt after a 429 or a server error.

    A rate limit (429) is honoured in full: retrying before it has passed only earns another
    refusal. If the service asks for more than MAX_RATE_LIMIT_WAIT the attempt ends here and the
    message stays queued for the next run.
    """
    if status != 429:
        return max(1.0, min(30.0, backoff))
    try:
        seconds = float(asked)
    except (TypeError, ValueError):
        seconds = backoff
    if seconds > MAX_RATE_LIMIT_WAIT:
        failure = error(f"{label} is rate limiting and asked to wait {seconds:.0f}s; left for a later run")
        failure.retry_after = seconds
        raise failure
    # A little longer than asked, so the retry does not land on the boundary.
    return max(1.0, seconds + 0.5)


class TelegramClient:
    """Posts plain-text messages to one Telegram channel through the Bot API.

    The bot token is part of the request address. So this class does not use HttpClient (which
    logs addresses), and it never puts an address, or a library error that may quote one, into
    a log line or an exception.
    """

    label = "Telegram"
    pending_key = "telegram_pending"
    retry_key = "telegram_retry_at"
    id_field = "telegram_id"
    max_len = MAX_TELEGRAM_LEN

    def __init__(
        self,
        *,
        token: str,
        chat_id: str,
        user_agent: str = USER_AGENT,
        api_base: str = DEFAULT_TELEGRAM_API,
        max_retries: int = 4,
        session: Any = None,
    ) -> None:
        self._token = token
        self.chat_id = chat_id
        self._api_base = api_base.rstrip("/")
        self.max_retries = max_retries
        self._session = session or requests.Session()
        self._session.headers.update({"User-Agent": user_agent})

    def _scrub(self, text: str) -> str:
        return text.replace(self._token, "<token>") if self._token else text

    def post(self, text: str, queued_at: Any = None) -> Any:
        """Send the text and return the new message's id."""
        return self.send_message(text).get("message_id")

    def send_message(self, text: str) -> dict[str, Any]:
        url = f"{self._api_base}/bot{self._token}/sendMessage"
        # No parse_mode: pool names and coinbase tags are chosen by miners, so the text is sent
        # as plain text and Telegram only turns the block address into a link.
        body = {"chat_id": self.chat_id, "text": text}
        backoff = 1.0
        last = "no attempt was made"
        for attempt in range(1, self.max_retries + 1):
            try:
                response = self._session.post(url, json=body, timeout=HTTP_TIMEOUT)
            except requests.RequestException as exc:
                # The error text can quote the address, so only its type is kept.
                last = f"network error ({type(exc).__name__})"
                log.warning("Telegram: %s (attempt %s/%s)", last, attempt, self.max_retries)
                time.sleep(backoff)
                backoff = min(30.0, backoff * 2)
                continue

            try:
                payload = response.json()
            except ValueError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            if response.status_code == 200 and payload.get("ok") is True:
                result = payload.get("result")
                return result if isinstance(result, dict) else {}

            description = self._scrub(str(payload.get("description") or "no description"))[:200]
            last = f"HTTP {response.status_code}: {description}"
            if response.status_code == 429 or 500 <= response.status_code < 600:
                parameters = payload.get("parameters")
                asked = parameters.get("retry_after") if isinstance(parameters, dict) else None
                wait = retry_wait("Telegram", TelegramError, response.status_code, asked, backoff)
                log.warning("Telegram: %s (attempt %s/%s); waiting %.0fs", last, attempt, self.max_retries, wait)
                time.sleep(wait)
                backoff = min(30.0, backoff * 2)
                continue

            raise TelegramError(f"Telegram refused the message ({last})")

        raise TelegramError(f"Telegram could not be reached ({last})")


def discord_webhook_address(raw: str) -> Optional[str]:
    """The webhook address to post to, or None if this is not a Discord webhook address.

    Checking the host means a mistyped secret can never send the posts anywhere else.
    """
    try:
        parts = urlsplit(raw.strip())
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or host not in DISCORD_WEBHOOK_HOSTS or parts.port not in (None, 443):
        return None
    if parts.username or parts.password or not parts.path.startswith(DISCORD_WEBHOOK_PATH):
        return None
    if len([piece for piece in parts.path[len(DISCORD_WEBHOOK_PATH):].split("/") if piece]) < 2:
        return None
    # wait=true makes Discord answer with the message it created, so its id can be recorded.
    query = [(key, value) for key, value in parse_qsl(parts.query) if key != "wait"] + [("wait", "true")]
    return urlunsplit(("https", host, parts.path, urlencode(query), ""))


def discord_escape(text: str) -> str:
    """Backslash-escape Discord's formatting characters in a name supplied by someone else."""
    return re.sub(r"([\\*_~`|>\[\]()#<@:-])", r"\\\1", text)


class DiscordClient:
    """Posts messages to one Discord channel through a webhook.

    The webhook address is the secret, so like TelegramClient this class never puts an address,
    or a library error that may quote one, into a log line or an exception.
    """

    label = "Discord"
    pending_key = "discord_pending"
    retry_key = "discord_retry_at"
    id_field = "discord_id"
    max_len = MAX_DISCORD_LEN

    def __init__(
        self,
        *,
        webhook_url: str,
        user_agent: str = USER_AGENT,
        suppress_embeds: bool = False,
        max_retries: int = 4,
        session: Any = None,
    ) -> None:
        address = discord_webhook_address(webhook_url)
        if address is None:
            raise ValueError("not a Discord webhook address")
        self._address = address
        self.suppress_embeds = suppress_embeds
        self.max_retries = max_retries
        self._session = session or requests.Session()
        self._session.headers.update({"User-Agent": user_agent})

    def post(self, text: str, queued_at: Any = None) -> Any:
        """Send the text and return the new message's id."""
        # allowed_mentions with nothing to parse: no text, whoever supplied it, can ping
        # @everyone, a role or a member.
        body: dict[str, Any] = {"content": text, "allowed_mentions": {"parse": []}}
        if self.suppress_embeds:
            body["flags"] = 4  # no preview card under the block link
        backoff = 1.0
        last = "no attempt was made"
        for attempt in range(1, self.max_retries + 1):
            try:
                response = self._session.post(self._address, json=body, timeout=HTTP_TIMEOUT)
            except requests.RequestException as exc:
                # The error text can quote the address, so only its type is kept.
                last = f"network error ({type(exc).__name__})"
                log.warning("Discord: %s (attempt %s/%s)", last, attempt, self.max_retries)
                time.sleep(backoff)
                backoff = min(30.0, backoff * 2)
                continue

            try:
                payload = response.json()
            except ValueError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            if response.status_code in (200, 204):
                # Both mean Discord took the message. With wait=true it answers 200 and the
                # message; if the id is ever missing the post is still treated as sent, because
                # sending it again would put a duplicate in the channel.
                if payload.get("id") is None:
                    log.warning("Discord accepted the message (HTTP %s) but did not return its id", response.status_code)
                return payload.get("id")

            # Discord's own error text ("Unknown Webhook", "Invalid Webhook Token") names no address.
            description = str(payload.get("message") or "no description")[:200]
            last = f"HTTP {response.status_code}: {description}"
            if response.status_code == 429 or 500 <= response.status_code < 600:
                wait = retry_wait("Discord", DiscordError, response.status_code, payload.get("retry_after"), backoff)
                log.warning("Discord: %s (attempt %s/%s); waiting %.0fs", last, attempt, self.max_retries, wait)
                time.sleep(wait)
                backoff = min(30.0, backoff * 2)
                continue

            raise DiscordError(f"Discord refused the message ({last})")

        raise DiscordError(f"Discord could not be reached ({last})")


# --- Nostr -----------------------------------------------------------------
# A Nostr account is a key pair. A post ("note") is a small JSON object signed with the private
# key and handed to relays over WebSocket (NIP-01). There is no service to log in to.

BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _bech32_polymod(values: list[int]) -> int:
    generators = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    checksum = 1
    for value in values:
        top = checksum >> 25
        checksum = ((checksum & 0x1FFFFFF) << 5) ^ value
        for bit, generator in enumerate(generators):
            if (top >> bit) & 1:
                checksum ^= generator
    return checksum


def _bech32_hrp_expand(hrp: str) -> list[int]:
    return [ord(char) >> 5 for char in hrp] + [0] + [ord(char) & 31 for char in hrp]


def _regroup_bits(data: list[int], from_bits: int, to_bits: int, pad: bool) -> Optional[list[int]]:
    acc = bits = 0
    out: list[int] = []
    limit = (1 << to_bits) - 1
    for value in data:
        if value < 0 or value >> from_bits:
            return None
        acc = (acc << from_bits) | value
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            out.append((acc >> bits) & limit)
    if pad:
        if bits:
            out.append((acc << (to_bits - bits)) & limit)
    elif bits >= from_bits or ((acc << (to_bits - bits)) & limit):
        return None
    return out


def bech32_decode(text: str, hrp: str) -> Optional[bytes]:
    """The bytes inside a bech32 string such as nsec1... (NIP-19), or None if it is not valid."""
    if text != text.lower() and text != text.upper():
        return None
    text = text.lower()
    prefix = hrp + "1"
    if not text.startswith(prefix) or len(text) > 200:
        return None
    try:
        values = [BECH32_CHARSET.index(char) for char in text[len(prefix):]]
    except ValueError:
        return None
    if len(values) < 7 or _bech32_polymod(_bech32_hrp_expand(hrp) + values) != 1:
        return None
    data = _regroup_bits(values[:-6], 5, 8, False)
    return bytes(data) if data is not None else None


def bech32_encode(hrp: str, data: bytes) -> str:
    values = _regroup_bits(list(data), 8, 5, True) or []
    polymod = _bech32_polymod(_bech32_hrp_expand(hrp) + values + [0] * 6) ^ 1
    checksum = [(polymod >> (5 * (5 - index))) & 31 for index in range(6)]
    return hrp + "1" + "".join(BECH32_CHARSET[value] for value in values + checksum)


def nostr_secret(raw: str) -> Optional[bytes]:
    """The 32-byte private key from an nsec1... string or 64 hex digits, or None."""
    raw = raw.strip()
    secret = bech32_decode(raw, "nsec")
    if secret is None and re.fullmatch(r"[0-9a-fA-F]{64}", raw):
        secret = bytes.fromhex(raw)
    if secret is None or len(secret) != 32 or PrivateKey is None:
        return None
    try:
        PrivateKey(secret)  # refuses zero and anything outside the curve's range
    except ValueError:
        return None
    return secret


def nostr_relay_address(raw: str) -> Optional[str]:
    """A relay address is wss://host[/path]. ws:// is allowed only to this machine, for tests."""
    try:
        parts = urlsplit(raw.strip())
        port = parts.port
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    local = host in ("localhost", "127.0.0.1", "::1")
    if not host or parts.username or parts.password or parts.fragment:
        return None
    if parts.scheme != "wss" and not (parts.scheme == "ws" and local):
        return None
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc += f":{port}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, ""))


def nostr_event(secret: bytes, content: str, created_at: int, kind: int = NOSTR_KIND_TEXT_NOTE) -> dict[str, Any]:
    """A signed Nostr event (NIP-01). The id depends only on the account, time, kind and text."""
    # NIP-01 fixes how the text is escaped before hashing. Python's JSON writer follows it for
    # everything except rare control characters, so those are dropped (line breaks are kept).
    content = "".join(char for char in content if char == "\n" or ord(char) >= 32)
    pubkey = PublicKeyXOnly.from_secret(secret).format().hex()
    tags: list[list[str]] = []
    serialized = json.dumps([0, pubkey, created_at, kind, tags, content], separators=(",", ":"), ensure_ascii=False)
    event_id = hashlib.sha256(serialized.encode("utf-8")).digest()
    signature = PrivateKey(secret).sign_schnorr(event_id)
    # Never hand out a signature that does not verify.
    if not PublicKeyXOnly(bytes.fromhex(pubkey)).verify(signature, event_id):
        raise NostrError("the Nostr signature did not verify")
    return {
        "id": event_id.hex(),
        "pubkey": pubkey,
        "created_at": created_at,
        "kind": kind,
        "tags": tags,
        "content": content,
        "sig": signature.hex(),
    }


def _printable(text: Any, limit: int = 80) -> str:
    """Text from a relay, made safe to put in a log line."""
    return "".join(char if 32 <= ord(char) < 127 else " " for char in str(text))[:limit].strip()


class NostrClient:
    """Posts notes to Nostr relays as one account.

    The private key is the account: it cannot be changed or revoked. It is used only to sign,
    and it never appears in a log line, an exception or the state file.
    """

    label = "Nostr"
    pending_key = "nostr_pending"
    retry_key = "nostr_retry_at"
    id_field = "nostr_id"
    max_len = MAX_NOSTR_LEN

    def __init__(
        self,
        *,
        secret: bytes,
        relays: list[str],
        user_agent: str = USER_AGENT,
        timeout: float = NOSTR_TIMEOUT,
        connect: Any = None,
    ) -> None:
        if not relays:
            raise ValueError("no relays")
        self._secret = secret
        self.relays = list(relays)
        self.user_agent = user_agent
        self.timeout = timeout
        self._connect = connect or websocket.create_connection
        self.pubkey = PublicKeyXOnly.from_secret(secret).format().hex()
        self.npub = bech32_encode("npub", bytes.fromhex(self.pubkey))

    def __repr__(self) -> str:  # never the key
        return f"NostrClient({self.npub})"

    def post(self, text: str, queued_at: Any = None) -> Any:
        """Publish the text as a note and return its id.

        The note's time is when the block was queued, so a retry signs the very same note. Relays
        keep one copy of a note, which means a retry can never produce a second post.
        """
        created_at = int(queued_at) if isinstance(queued_at, (int, float)) and not isinstance(queued_at, bool) and queued_at > 0 else int(time.time())
        event = nostr_event(self._secret, text, created_at)
        accepted: list[str] = []
        refused: list[str] = []
        for relay in self.relays:
            host = urlsplit(relay).hostname or "relay"
            ok, detail = self._publish(relay, event)
            if ok:
                accepted.append(host)
            else:
                refused.append(f"{host}: {detail}")
        if refused:
            log.warning("Nostr: not accepted by %s", "; ".join(refused))
        if not accepted:
            raise NostrError("no Nostr relay accepted the note")
        log.info("Nostr: note %s accepted by %s of %s relays (%s)", event["id"][:12], len(accepted), len(self.relays), ", ".join(accepted))
        return event["id"]

    def _publish(self, relay: str, event: dict[str, Any]) -> tuple[bool, str]:
        """Hand the note to one relay and wait for its verdict."""
        connection = None
        try:
            connection = self._connect(relay, timeout=self.timeout, header=[f"User-Agent: {self.user_agent}"])
            connection.send(json.dumps(["EVENT", event], separators=(",", ":"), ensure_ascii=False))
            deadline = time.monotonic() + self.timeout
            # A relay may send other messages first (a notice, a request to log in); skip a few.
            for _ in range(8):
                if time.monotonic() > deadline:
                    break
                raw = connection.recv()
                if isinstance(raw, bytes) or len(raw) > 20_000:
                    continue
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(message, list) or len(message) < 3 or message[0] != "OK" or message[1] != event["id"]:
                    continue
                reason = _printable(message[3]) if len(message) > 3 else ""
                # "duplicate:" means the relay already has this note, which is what we want.
                if message[2] is True or reason.startswith("duplicate"):
                    return True, reason
                return False, reason or "refused"
            return False, "no answer"
        except Exception as exc:  # a relay being down or odd must never stop the others
            return False, type(exc).__name__
        finally:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass


def nostr_from_env() -> Optional[NostrClient]:
    raw = (os.environ.get("NOSTR_PRIVATE_KEY") or "").strip()
    if not raw:
        return None
    if websocket is None or PrivateKey is None:
        log.warning("Nostr needs the coincurve and websocket-client packages (pip install -r requirements.txt); not posting to Nostr.")
        return None
    secret = nostr_secret(raw)
    if secret is None:
        # The value is the account itself, so it is never shown.
        log.warning("NOSTR_PRIVATE_KEY is not a valid key (expected nsec1... or 64 hex digits); not posting to Nostr.")
        return None
    wanted = [piece for piece in re.split(r"[\s,]+", os.environ.get("NOSTR_RELAYS") or "") if piece] or list(DEFAULT_NOSTR_RELAYS)
    relays: list[str] = []
    for piece in wanted[:MAX_NOSTR_RELAYS]:
        address = nostr_relay_address(piece)
        if address is None:
            log.warning("Nostr: ignoring relay %s (a relay address looks like wss://relay.example)", _printable(piece, 60))
        elif address not in relays:
            relays.append(address)
    if not relays:
        log.warning("NOSTR_RELAYS has no usable relay; not posting to Nostr.")
        return None
    return NostrClient(secret=secret, relays=relays, user_agent=os.environ.get("USER_AGENT", USER_AGENT))


def telegram_from_env() -> Optional[TelegramClient]:
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    channel = (os.environ.get("TELEGRAM_CHANNEL") or "").strip()
    if not token and not channel:
        return None
    if not token or not channel:
        log.warning(
            "Telegram is half configured (%s is missing); not posting to Telegram.",
            "TELEGRAM_BOT_TOKEN" if not token else "TELEGRAM_CHANNEL",
        )
        return None
    return TelegramClient(
        token=token,
        chat_id=channel,
        user_agent=os.environ.get("USER_AGENT", USER_AGENT),
        api_base=os.environ.get("TELEGRAM_API", DEFAULT_TELEGRAM_API),
    )


def discord_from_env() -> Optional[DiscordClient]:
    webhook_url = (os.environ.get("DISCORD_WEBHOOK_URL") or "").strip()
    if not webhook_url:
        return None
    try:
        return DiscordClient(
            webhook_url=webhook_url,
            user_agent=os.environ.get("USER_AGENT", USER_AGENT),
            suppress_embeds=env_flag("DISCORD_SUPPRESS_EMBEDS", False),
        )
    except ValueError:
        # The value is a secret, so it is not shown.
        log.warning(
            "DISCORD_WEBHOOK_URL is not a Discord webhook address (it should start with "
            "https://discord.com%s); not posting to Discord.",
            DISCORD_WEBHOOK_PATH,
        )
        return None


@dataclass
class Channel:
    """One extra place a block is posted to, after X: its client and how its text is built."""

    client: Any
    template: str
    include_link: bool
    # Applied to the pool name and coinbase tag, which other people choose.
    escape: Callable[[str], str] = str
    # Set once a send has failed in this run, so the same run does not try this channel again.
    failed: bool = False


def channels_from_env(template: str) -> list[Channel]:
    """The Telegram, Discord and Nostr channels that are configured. X's template is the default text."""

    def text_for(name: str) -> str:
        return os.environ.get(name, template).replace("\\n", "\n")

    channels: list[Channel] = []
    telegram = telegram_from_env()
    if telegram is not None:
        channels.append(Channel(telegram, text_for("TELEGRAM_TEMPLATE"), env_flag("TELEGRAM_INCLUDE_LINK", True)))
    discord = discord_from_env()
    if discord is not None:
        channels.append(Channel(discord, text_for("DISCORD_TEMPLATE"), env_flag("DISCORD_INCLUDE_LINK", True), discord_escape))
    nostr = nostr_from_env()
    if nostr is not None:
        channels.append(Channel(nostr, text_for("NOSTR_TEMPLATE"), env_flag("NOSTR_INCLUDE_LINK", True)))
    return channels


def queue_post(state: dict[str, Any], channel: Channel, *, block_hash: str, height: int, text: str) -> None:
    """Remember a block that still has to go to this channel. It stays queued until it is sent."""
    key, label = channel.client.pending_key, channel.client.label
    pending = [row for row in (state.get(key) or []) if isinstance(row, dict)]
    if any(row.get("hash") == block_hash for row in pending):
        return
    # queued_at lets a channel that can (Nostr) send the identical post again after a failure.
    pending.append({"hash": block_hash, "height": height, "text": text, "queued_at": int(time.time())})
    if len(pending) > MAX_PENDING_POSTS:
        log.warning("%s queue is full; dropping the oldest %s block(s)", label, len(pending) - MAX_PENDING_POSTS)
        pending = pending[-MAX_PENDING_POSTS:]
    state[key] = pending


def flush_channel(state: dict[str, Any], state_path: Path, channel: Channel, *, save: bool) -> int:
    """Send this channel's queued blocks, oldest first. Returns how many are still waiting.

    A failure stops at that block and leaves it queued. It never raises, so trouble on Telegram
    or Discord cannot hold up or repeat a post anywhere else. After a failure the channel is not
    tried again in this run, and when the service named a rate limit, that time is kept in
    state.json so later runs wait for it too.
    """
    client = channel.client
    key, label = client.pending_key, client.label
    pending = [row for row in (state.get(key) or []) if isinstance(row, dict) and row.get("text")]
    state[key] = pending
    if not pending or channel.failed:
        return len(pending)

    retry_at = state.get(client.retry_key)
    if isinstance(retry_at, (int, float)) and not isinstance(retry_at, bool):
        remaining = retry_at - time.time()
        if 0 < remaining <= MAX_RATE_LIMIT_HOLD:
            log.info("%s is rate limited for another %.0fs; %s block(s) stay queued", label, remaining, len(pending))
            channel.failed = True
            return len(pending)
    if client.retry_key in state:
        # The limit has passed (or the stored value made no sense).
        del state[client.retry_key]
        if save:
            save_state(state_path, state)

    while pending:
        row = pending[0]
        try:
            message_id = client.post(str(row["text"]), queued_at=row.get("queued_at"))
        except ChannelError as exc:
            log.error("%s: block %s was not posted and stays queued: %s", label, row.get("height"), exc)
            channel.failed = True
            if exc.retry_after:
                state[client.retry_key] = int(time.time() + min(float(exc.retry_after), MAX_RATE_LIMIT_HOLD)) + 1
                if save:
                    save_state(state_path, state)
            break
        log.info("Posted %s message id=%s for block %s", label, message_id, row.get("height"))
        entry = (state.get("posted") or {}).get(row.get("hash"))
        if isinstance(entry, dict):
            entry[client.id_field] = message_id
        pending = pending[1:]
        state[key] = pending
        # Saved after every message, so a later failure cannot make this one go out twice.
        if save:
            save_state(state_path, state)
    return len(pending)


# ---------------------------------------------------------------------------
# Core run
# ---------------------------------------------------------------------------

def collect_blocks(
    mempool: Mempool,
    *,
    since_height: Optional[int],
    since_ts: Optional[int],
    reorg_floor: Optional[int],
) -> list[dict[str, Any]]:
    """Page backwards from the tip until we cover the lookback window."""
    collected: list[dict[str, Any]] = []
    seen: set[int] = set()
    end_height: Optional[int] = None
    pages = 0
    max_pages = 200
    stop_height = 0
    floors = [h for h in (since_height, reorg_floor) if h is not None]
    if floors:
        # Page far enough to confirm a short reorg under the last tip.
        stop_height = max(0, min(floors) - REORG_DEPTH)

    while pages < max_pages:
        blocks = mempool.blocks_page(end_height)
        pages += 1
        if not blocks:
            log.warning("Empty blocks page at end_height=%s", end_height)
            break
        newest = blocks[0]["height"]
        oldest = blocks[-1]["height"]
        oldest_ts = blocks[-1].get("timestamp") or 0
        log.info(
            "Fetched page %s: heights %s–%s (%s blocks)",
            pages,
            newest,
            oldest,
            len(blocks),
        )
        for block in blocks:
            height = block.get("height")
            if height is None or height in seen:
                continue
            seen.add(height)
            collected.append(block)
        reached_ts = since_ts is not None and oldest_ts and oldest_ts < since_ts
        reached_height = oldest <= stop_height
        if reached_ts or reached_height:
            break
        end_height = oldest - 1
        if end_height < 0:
            break
        time.sleep(PAGE_SLEEP)
    else:
        log.warning("Stopped after %s pages; may not have reached the lookback start", max_pages)

    collected.sort(key=lambda b: b["height"])
    return collected


def find_fork(
    mempool: Mempool,
    state: dict[str, Any],
    fetched: list[dict[str, Any]],
) -> int:
    """Return the height we should resume after (inclusive last-good height).

    If the stored tip is still on the main chain, this is last_height.
    On a reorg, walk back until a stored hash matches the current chain,
    then resume from that height (new children will be processed).
    """
    last_height = state.get("last_height")
    last_hash = state.get("last_hash")
    if last_height is None or not last_hash:
        return -1

    by_height = {b["height"]: b.get("id") for b in fetched}

    def chain_hash(height: int) -> Optional[str]:
        if height in by_height:
            return by_height[height]
        try:
            return mempool.hash_at_height(height)
        except Exception as exc:
            log.warning("Could not fetch hash at height %s: %s", height, exc)
            return None

    current = chain_hash(last_height)
    if current == last_hash:
        return last_height

    log.warning(
        "Possible reorg: state has %s at height %s, chain has %s",
        last_hash,
        last_height,
        current,
    )
    known = {row["height"]: row["hash"] for row in (state.get("recent") or [])}
    known[last_height] = last_hash
    # Also trust posted block hashes as points we have already seen.
    for posted_hash, meta in (state.get("posted") or {}).items():
        h = (meta or {}).get("height")
        if isinstance(h, int):
            known.setdefault(h, posted_hash)

    for height in range(last_height, max(-1, last_height - REORG_DEPTH * 4) - 1, -1):
        if height not in known:
            continue
        current = chain_hash(height)
        if current and current == known[height]:
            log.warning("Reorg common ancestor at height %s (%s)", height, current)
            return height

    # Last resort: step back REORG_DEPTH from the stored tip.
    fallback = max(0, last_height - REORG_DEPTH)
    log.warning("Could not prove a common ancestor; resuming after height %s", fallback)
    return fallback


def pool_name_of(block: dict[str, Any]) -> str:
    extras = block.get("extras") or {}
    pool = extras.get("pool") or {}
    return pool.get("name") or "Unknown"


def display_pool(
    name: str,
    *,
    slug: Optional[str] = None,
    pools: list[dict[str, Any]] | None = None,
    overrides: dict[str, str] | None = None,
) -> str:
    handle = handle_for_pool(name, slug=slug, pools=pools, overrides=overrides)
    if not handle:
        return name
    return handle if handle.startswith("@") else "@" + handle


def apply_seed(state: dict[str, Any], seed_counts: dict[str, int], seed_height: int) -> None:
    if state.get("pool_counts"):
        return
    if not seed_counts:
        return
    state["pool_counts"] = dict(seed_counts)
    state["seed_height"] = seed_height
    log.info("Seeded pool counts as of height %s (inclusive): %s", seed_height, seed_counts)


def rewind_seed_for_batch(
    state: dict[str, Any],
    sv2_blocks: list[dict[str, Any]],
) -> None:
    """If this batch includes blocks already counted in the seed, rewind first.

    Seed counts are inclusive of seed_height. Processing 977145 then 977316
    with MARA Pool seeded at 7 as of 977316 should tweet '6th' then '7th'.
    """
    seed_height = state.get("seed_height")
    if seed_height is None or state.get("seed_rewound"):
        return
    counts = state["pool_counts"]
    rewound = False
    for block in sv2_blocks:
        if block["height"] <= seed_height:
            name = pool_name_of(block)
            if name in counts:
                counts[name] = max(0, int(counts[name]) - 1)
                rewound = True
                log.info(
                    "Rewound seed count for %s to %s (block %s is at or before seed height %s)",
                    name,
                    counts[name],
                    block["height"],
                    seed_height,
                )
    if rewound or sv2_blocks:
        state["seed_rewound"] = True


def process(
    *,
    mempool: Mempool,
    state: dict[str, Any],
    state_path: Path,
    x_client: Optional[XClient],
    dry_run: bool,
    save: bool,
    backfill_hours: Optional[float],
    tz: ZoneInfo,
    overnight_start: int,
    overnight_end: int,
    template: str,
    handles: dict[str, str],
    pools: list[dict[str, Any]],
    include_link: bool,
    seed_counts: dict[str, int],
    seed_height: int,
    channels: Optional[list[Channel]] = None,
) -> list[dict[str, Any]]:
    posted_now: list[dict[str, Any]] = []
    tip = mempool.tip_height()
    log.info("Chain tip is %s", tip)

    apply_seed(state, seed_counts, seed_height)

    since_ts = None
    if backfill_hours is not None:
        since_ts = int((datetime.now(timezone.utc) - timedelta(hours=backfill_hours)).timestamp())
        log.info("Backfill window: last %s hours (since unix %s)", backfill_hours, since_ts)

    if not state.get("initialized") and backfill_hours is None:
        tip_hash = mempool.hash_at_height(tip)
        state["last_height"] = tip
        state["last_hash"] = tip_hash
        state["initialized"] = True
        record_recent(state, tip, tip_hash)
        if save:
            save_state(state_path, state)
        log.info(
            "Initialised state at tip %s (%s). No tweets this run. "
            "Pass --backfill-hours N to post recent historical SV2 blocks.",
            tip,
            tip_hash,
        )
        return posted_now

    reorg_floor = state.get("last_height")
    fetched = collect_blocks(
        mempool,
        since_height=state.get("last_height"),
        since_ts=since_ts,
        reorg_floor=reorg_floor,
    )
    if not fetched:
        log.info("No blocks fetched")
        return posted_now

    resume_after = find_fork(mempool, state, fetched)
    candidates = []
    for block in fetched:
        height = block["height"]
        block_hash = block.get("id")
        ts = block.get("timestamp") or 0
        if since_ts is not None and ts < since_ts:
            continue
        if resume_after is not None and resume_after >= 0 and height <= resume_after:
            # Still refresh the stored hash if this height is our last tip
            # and it still matches (already handled by find_fork).
            continue
        if block_hash and block_hash in (state.get("posted") or {}):
            log.info("Skipping already-posted block %s (%s)", height, block_hash)
            # Keep the tip moving past already-posted blocks.
            state["last_height"] = height
            state["last_hash"] = block_hash
            record_recent(state, height, block_hash)
            continue
        candidates.append(block)

    # Identify SV2 first so we can rewind seed counts before incrementing.
    annotated: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
    sv2_list: list[dict[str, Any]] = []
    for block in candidates:
        raw = mempool.coinbase_raw(block)
        counted, tag, cls = is_sv2_coinbase(raw)
        if cls.get("borderline"):
            log.info(
                "Borderline (not counted) block %s: %s",
                block["height"],
                cls.get("borderline_why"),
            )
        annotated.append((block, raw, cls))
        if counted:
            sv2_list.append(block)

    rewind_seed_for_batch(state, sv2_list)

    log.info(
        "Processing %s new blocks (%s SV2) after height %s",
        len(candidates),
        len(sv2_list),
        resume_after,
    )

    for block, raw, cls in annotated:
        height = block["height"]
        block_hash = block["id"]
        ts = block.get("timestamp") or 0
        name = pool_name_of(block)

        if not cls["counted"]:
            state["last_height"] = height
            state["last_hash"] = block_hash
            state["initialized"] = True
            record_recent(state, height, block_hash)
            if save:
                save_state(state_path, state)
            continue

        counts = state.setdefault("pool_counts", {})
        counts[name] = int(counts.get(name) or 0) + 1
        count = counts[name]
        when = when_label(ts, tz, overnight_start, overnight_end)
        slug = ((block.get("extras") or {}).get("pool") or {}).get("slug")
        display = display_pool(name, slug=slug, pools=pools, overrides=handles)
        try:
            reward = format_reward_btc(block_reward_sats(block, mempool))
        except Exception:
            counts[name] = count - 1
            raise
        text = format_tweet(
            template=template,
            pool_name=name,
            pool_display=display,
            height=height,
            block_hash=block_hash,
            count=count,
            when=when,
            tag=cls.get("matched_text"),
            reward=reward,
            include_link=include_link,
        )
        if len(text) > MAX_TWEET_LEN:
            # Do not increment-and-forget: roll the count back and stop so
            # a later run can retry after the template is fixed.
            counts[name] = count - 1
            raise RuntimeError(
                f"Tweet for block {height} is {len(text)} characters "
                f"(max {MAX_TWEET_LEN}):\n{text}"
            )

        local = datetime.fromtimestamp(ts, tz).strftime("%Y-%m-%d %H:%M %Z")
        log.info(
            "SV2 block %s by %s at %s tag=%s → %s",
            height,
            name,
            local,
            cls.get("matched_text"),
            "dry-run" if dry_run else "post",
        )
        print("----- tweet -----")
        print(text)
        print("-----------------")

        # Telegram and Discord name the pool (an X handle means nothing there) and may carry the
        # block link, which costs nothing there. A problem with one must not stop the X post.
        channel_texts: list[tuple[Channel, str]] = []
        for channel in channels or []:
            label = channel.client.label
            try:
                channel_text = format_tweet(
                    template=channel.template,
                    pool_name=channel.escape(name),
                    pool_display=channel.escape(name),
                    height=height,
                    block_hash=block_hash,
                    count=count,
                    when=when,
                    tag=channel.escape(cls.get("matched_text") or "Sv2"),
                    reward=reward,
                    include_link=channel.include_link,
                )
                if len(channel_text) > channel.client.max_len:
                    raise ValueError(f"{len(channel_text)} characters (max {channel.client.max_len})")
            except Exception as exc:
                log.error("%s: no message for block %s: %s", label, height, exc)
                continue
            channel_texts.append((channel, channel_text))
            if dry_run:
                print(f"----- {label.lower()} -----")
                print(channel_text)
                print("--------------------")

        tweet_id = None
        if dry_run:
            tweet_id = "dry-run"
        else:
            if x_client is None:
                # Roll back the increment; state has not been advanced.
                counts[name] = count - 1
                raise RuntimeError("X API credentials are missing; cannot post")
            try:
                result = x_client.post_tweet(text)
            except Exception as exc:
                if not is_duplicate_post_error(exc):
                    counts[name] = count - 1
                    raise
                # X refuses a post whose text it already has. That happens when an earlier run
                # posted this block but its state was lost before it could be saved. Record the
                # block as posted and carry on, rather than failing on it at every run.
                log.warning("X already has this post for block %s; marking it as posted", height)
                result = {"data": {"id": "duplicate"}}
            tweet_id = ((result.get("data") or {}).get("id")) or None
            log.info("Posted tweet id=%s for block %s", tweet_id, height)

        # Only now advance state, after a successful (or dry-run) tweet.
        state["last_height"] = height
        state["last_hash"] = block_hash
        state["initialized"] = True
        record_recent(state, height, block_hash)
        state.setdefault("posted", {})[block_hash] = {
            "height": height,
            "pool": name,
            "count": count,
            "tweet_id": tweet_id,
            "ts": ts,
            "tag": cls.get("matched_text"),
        }
        if not dry_run:
            for channel, channel_text in channel_texts:
                queue_post(state, channel, block_hash=block_hash, height=height, text=channel_text)
        if save:
            save_state(state_path, state)
        if not dry_run:
            for channel, _text in channel_texts:
                flush_channel(state, state_path, channel, save=save)
        posted_now.append(
            {
                "height": height,
                "hash": block_hash,
                "pool": name,
                "count": count,
                "when": when,
                "tag": cls.get("matched_text"),
                "tweet": text,
                "tweet_id": tweet_id,
            }
        )

    return posted_now


def acquire_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    fh = open(lock_path, "a+", encoding="utf-8")
    try:
        import fcntl

        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        raise SystemExit(f"Another sv2_bot.py instance already holds {lock_path}")
    return fh


def load_env_file(cli_env: Optional[str]) -> None:
    if cli_env:
        load_dotenv(cli_env, override=True)
        return
    # Prefer a .env next to the script, then the cwd.
    here = Path(__file__).resolve().parent / ".env"
    if here.exists():
        load_dotenv(here, override=False)
    load_dotenv(override=False)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Post to X whenever a new Stratum V2 block is mined.",
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument(
        "--once",
        action="store_true",
        help="Poll once and exit (default; intended for cron / systemd timers).",
    )
    mode.add_argument(
        "--loop",
        action="store_true",
        help="Poll forever, sleeping --interval seconds between passes.",
    )
    p.add_argument(
        "--interval",
        type=int,
        default=int(os.environ.get("POLL_INTERVAL", "60")),
        help="Seconds to sleep between passes in --loop mode (default 60).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print tweets instead of posting them. Credentials are not required.",
    )
    p.add_argument(
        "--backfill-hours",
        type=float,
        metavar="N",
        help="On a fresh (or behind) state file, also consider SV2 blocks in the last N hours.",
    )
    p.add_argument(
        "--state-file",
        default=os.environ.get("STATE_FILE", "state.json"),
        help="Path to the JSON state file (default: state.json or $STATE_FILE).",
    )
    p.add_argument(
        "--no-save-state",
        action="store_true",
        help="Do not write the state file (useful for a one-off dry run).",
    )
    p.add_argument(
        "--pools-file",
        default=None,
        help="Path to pools.json (default: $POOLS_FILE or pools.json next to this script).",
    )
    p.add_argument(
        "--block-link",
        action="store_true",
        help="Append the mempool.space block URL (off by default; URL posts cost more on the X API).",
    )
    p.add_argument(
        "--no-block-link",
        action="store_true",
        help="Do not append the mempool.space block URL (default). Useful if INCLUDE_BLOCK_LINK=true in the environment.",
    )
    p.add_argument(
        "--env-file",
        help="Path to a .env file. Defaults to .env next to this script, then cwd.",
    )
    p.add_argument(
        "--telegram-test",
        action="store_true",
        help="Send one real test message to TELEGRAM_CHANNEL and exit. Checks the token and the bot's right to post. Cannot be combined with --dry-run.",
    )
    p.add_argument(
        "--discord-test",
        action="store_true",
        help="Send one real test message through DISCORD_WEBHOOK_URL and exit. Cannot be combined with --dry-run.",
    )
    p.add_argument(
        "--nostr-test",
        action="store_true",
        help="Publish one real, public test note with NOSTR_PRIVATE_KEY and exit. Cannot be combined with --dry-run.",
    )
    p.add_argument(
        "--self-test",
        action="store_true",
        help="Run local detection fixtures and exit (no network, no posts).",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Debug logging.",
    )
    return p


def self_test() -> int:
    """Check detection on known blocks and obvious false positives."""
    failures = 0

    def check(name: str, raw: str, expect: bool, substring: Optional[str] = None) -> None:
        nonlocal failures
        counted, tag, _ = is_sv2_coinbase(raw)
        ok = counted is expect and (substring is None or (tag is not None and substring.lower() in tag.lower()))
        status = "ok" if ok else "FAIL"
        print(f"  [{status}] {name}: counted={counted} tag={tag!r}")
        if not ok:
            failures += 1

    print("Self-test: coinbase detection")
    check("977145 Sv2/MARA", FIXTURE_977145, True, "Sv2/MARA")
    check("977316 Sv2/MARA", FIXTURE_977316, True, "Sv2/MARA")
    # Random extranonce bytes that happen to contain "v2" must not count.
    check("random v2 bytes", "ff7632aa", False)  # 'v2'
    check("slash-delimited bare /v2/", "2f76322f", False)  # /v2/
    check("stratum v2 ascii", "5374726174756d207632", True, "stratum v2")  # "Stratum v2" wait that's "Stratum v2"?
    # 53 74 72 61 74 75 6d 20 76 32 = "Stratum v2" — yes.
    check("empty", "", False)

    # Reward formatting and the default tweet body.
    assert format_reward_btc(313140332) == "3.131"
    assert format_reward_btc(316100000) == "3.161"
    sample = format_tweet(
        template=DEFAULT_TEMPLATE,
        pool_name="MARA Pool",
        pool_display="@MARA",
        height=976280,
        block_hash="abc",
        count=7,
        when="today",
        tag="Sv2/MARA",
        reward="3.161",
        include_link=False,
    )
    expected = (
        "Stratum V2 block #976280 mined by\n"
        "@MARA\n"
        "\n"
        "Subsidy + fees: 3.161 BTC"
    )
    assert sample == expected, repr(sample)
    with_link = format_tweet(
        template=DEFAULT_TEMPLATE,
        pool_name="MARA Pool",
        pool_display="@MARA",
        height=976280,
        block_hash="abc",
        count=7,
        when="today",
        tag="Sv2/MARA",
        reward="3.161",
        include_link=True,
    )
    assert with_link.endswith("https://mempool.space/block/abc")
    print("  [ok] reward formatting and default tweet template")

    # Tagging rules: only high-confidence type=pool handles are mentioned.
    fixtures = [
        {"name": "MARA Pool", "slug": "marapool", "handle": "MARA", "confidence": "high", "type": "pool"},
        {"name": "Binance Pool", "slug": "binancepool", "handle": "binance", "confidence": "high", "type": "exchange"},
        {"name": "wiz", "slug": "wiz", "handle": "wiz", "confidence": "high", "type": "individual"},
        {"name": "Bitfarms", "slug": "bitfarms", "handle": "keelinfra_", "confidence": "medium", "type": "rebrand"},
        {"name": "BCMonster", "slug": "bcmonster", "handle": "THeBCMonster", "confidence": "medium", "type": "pool"},
        {"name": "Unknown", "slug": "unknown", "handle": None, "confidence": "none", "type": "none"},
    ]
    assert handle_for_pool("MARA Pool", pools=fixtures) == "MARA"
    assert display_pool("MARA Pool", pools=fixtures) == "@MARA"
    assert handle_for_pool("Binance Pool", pools=fixtures) is None
    assert display_pool("Binance Pool", pools=fixtures) == "Binance Pool"
    assert handle_for_pool("wiz", pools=fixtures) is None
    assert display_pool("wiz", pools=fixtures) == "wiz"
    assert handle_for_pool("Bitfarms", pools=fixtures) is None
    assert handle_for_pool("BCMonster", pools=fixtures) is None
    assert display_pool("Unknown", pools=fixtures) == "Unknown"
    # An explicit .env override still wins.
    assert handle_for_pool("wiz", pools=fixtures, overrides={"wiz": "@wiz"}) == "wiz"
    print("  [ok] tagging rules (high+pool only)")

    assert is_duplicate_post_error(RuntimeError('HTTP 403 from https://api.x.com/2/tweets: {"detail":"You are not allowed to create a Tweet with duplicate content."}'))
    assert not is_duplicate_post_error(RuntimeError('HTTP 403 from https://api.x.com/2/tweets: {"detail":"Forbidden"}'))
    assert not is_duplicate_post_error(RuntimeError('HTTP 401 from https://api.x.com/2/tweets: duplicate'))
    print("  [ok] duplicate-post refusal is recognised")

    # Telegram: sending, refusals, retries, the queue, and keeping the token out of messages.
    class FakeResponse:
        def __init__(self, status: int, payload: Any) -> None:
            self.status_code = status
            self._payload = payload

        def json(self) -> Any:
            if self._payload is None:
                raise ValueError("not json")
            return self._payload

    class FakeSession:
        def __init__(self, replies: list[Any]) -> None:
            self.headers: dict[str, str] = {}
            self.replies = list(replies)
            self.sent: list[tuple[str, Any]] = []

        def post(self, url: str, json: Any = None, timeout: Any = None) -> Any:
            self.sent.append((url, json))
            reply = self.replies.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply

    token = "123456:SECRET-token"
    ok = lambda message_id: FakeResponse(200, {"ok": True, "result": {"message_id": message_id}})
    real_sleep = time.sleep
    time.sleep = lambda _seconds: None
    try:
        session = FakeSession([ok(11)])
        client = TelegramClient(token=token, chat_id="@channel", session=session)
        assert client.send_message("hello") == {"message_id": 11}
        assert session.sent == [(f"https://api.telegram.org/bot{token}/sendMessage", {"chat_id": "@channel", "text": "hello"})]

        # A refusal is reported without the token, and is not retried.
        session = FakeSession([FakeResponse(403, {"ok": False, "description": f"Forbidden: bot{token} is not a member of the channel chat"})])
        client = TelegramClient(token=token, chat_id="@channel", session=session)
        try:
            client.send_message("hello")
            raise AssertionError("a refusal must raise")
        except TelegramError as exc:
            assert "403" in str(exc) and token not in str(exc), str(exc)
        assert len(session.sent) == 1

        # A server error, a rate limit and a network error are retried; the error names no address.
        session = FakeSession([FakeResponse(502, None), FakeResponse(429, {"ok": False, "parameters": {"retry_after": 2}}), requests.ConnectionError(f"https://api.telegram.org/bot{token}/sendMessage"), ok(12)])
        client = TelegramClient(token=token, chat_id="@channel", session=session)
        assert client.send_message("hello") == {"message_id": 12}
        session = FakeSession([requests.ConnectionError(f"bot{token}")] * 4)
        client = TelegramClient(token=token, chat_id="@channel", session=session)
        try:
            client.send_message("hello")
            raise AssertionError("an unreachable service must raise")
        except TelegramError as exc:
            assert token not in str(exc) and "ConnectionError" in str(exc), str(exc)

        # The queue: a failure keeps the block waiting, a later run sends it once, in order.
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            state = default_state()
            state["posted"] = {"aa": {"height": 1}, "bb": {"height": 2}}
            session = FakeSession([ok(21), FakeResponse(400, {"ok": False, "description": "Bad Request: chat not found"})])
            channel = Channel(TelegramClient(token=token, chat_id="@channel", session=session), DEFAULT_TEMPLATE, True)
            queue_post(state, channel, block_hash="aa", height=1, text="first")
            queue_post(state, channel, block_hash="aa", height=1, text="first")
            queue_post(state, channel, block_hash="bb", height=2, text="second")
            assert [row["hash"] for row in state["telegram_pending"]] == ["aa", "bb"]
            assert flush_channel(state, path, channel, save=True) == 1
            assert state["posted"]["aa"]["telegram_id"] == 21
            assert [row["hash"] for row in load_state(path)["telegram_pending"]] == ["bb"]
            session = FakeSession([ok(22)])
            channel = Channel(TelegramClient(token=token, chat_id="@channel", session=session), DEFAULT_TEMPLATE, True)
            assert flush_channel(state, path, channel, save=True) == 0
            assert [body["text"] for _url, body in session.sent] == ["second"]
            assert state["posted"]["bb"]["telegram_id"] == 22 and load_state(path)["telegram_pending"] == []

        # Discord: only a real webhook address is accepted, and it is never shown.
        hook = "https://discord.com/api/webhooks/123456/SECRET-hook-token"
        assert discord_webhook_address(hook) == hook + "?wait=true"
        assert discord_webhook_address(hook + "?thread_id=9&wait=false") == hook + "?thread_id=9&wait=true"
        assert discord_webhook_address("https://discordapp.com/api/webhooks/1/abc") is not None
        for bad in (
            "",
            "http://discord.com/api/webhooks/1/abc",
            "https://discord.com.example.org/api/webhooks/1/abc",
            "https://example.org/api/webhooks/1/abc",
            "https://user@discord.com/api/webhooks/1/abc",
            "https://discord.com:8443/api/webhooks/1/abc",
            "https://discord.com/api/webhooks/1",
            "https://discord.gg/abcdef",
        ):
            assert discord_webhook_address(bad) is None, bad
        try:
            DiscordClient(webhook_url="https://example.org/api/webhooks/1/abc")
            raise AssertionError("a foreign address must be refused")
        except ValueError as exc:
            assert "example.org" not in str(exc)

        session = FakeSession([FakeResponse(200, {"id": "9001"})])
        client = DiscordClient(webhook_url=hook, session=session)
        assert client.post("hello") == "9001"
        assert session.sent == [(hook + "?wait=true", {"content": "hello", "allowed_mentions": {"parse": []}})]
        session = FakeSession([FakeResponse(200, {"id": "9002"})])
        assert DiscordClient(webhook_url=hook, session=session, suppress_embeds=True).post("hello") == "9002"
        assert session.sent[0][1]["flags"] == 4

        session = FakeSession([FakeResponse(404, {"message": "Unknown Webhook", "code": 10015})])
        client = DiscordClient(webhook_url=hook, session=session)
        try:
            client.post("hello")
            raise AssertionError("a refusal must raise")
        except DiscordError as exc:
            assert "404" in str(exc) and "SECRET-hook-token" not in str(exc), str(exc)
        assert len(session.sent) == 1

        session = FakeSession([FakeResponse(429, {"message": "You are being rate limited.", "retry_after": 0.4}), FakeResponse(503, None), requests.ConnectionError(hook), FakeResponse(200, {"id": "9003"})])
        assert DiscordClient(webhook_url=hook, session=session).post("hello") == "9003"
        session = FakeSession([requests.ConnectionError(hook)] * 4)
        try:
            DiscordClient(webhook_url=hook, session=session).post("hello")
            raise AssertionError("an unreachable service must raise")
        except DiscordError as exc:
            assert "SECRET-hook-token" not in str(exc) and "ConnectionError" in str(exc), str(exc)

        # Names chosen by other people cannot format, link or mention anything on Discord.
        assert discord_escape("MARA Pool") == "MARA Pool"
        assert discord_escape("[free](https://x.example) **@everyone** <@1>") == "\\[free\\]\\(https\\://x.example\\) \\*\\*\\@everyone\\*\\* \\<\\@1\\>"

        # Telegram and Discord keep separate queues: one failing does not hold up the other.
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            state = default_state()
            state["posted"] = {"aa": {"height": 1}}
            tg = Channel(TelegramClient(token=token, chat_id="@channel", session=FakeSession([FakeResponse(403, {"ok": False, "description": "Forbidden"})])), DEFAULT_TEMPLATE, True)
            dc = Channel(DiscordClient(webhook_url=hook, session=FakeSession([FakeResponse(200, {"id": "9100"})])), DEFAULT_TEMPLATE, True, discord_escape)
            for channel in (tg, dc):
                queue_post(state, channel, block_hash="aa", height=1, text="block")
            assert flush_channel(state, path, tg, save=True) == 1
            assert flush_channel(state, path, dc, save=True) == 0
            saved = load_state(path)
            assert [row["hash"] for row in saved["telegram_pending"]] == ["aa"] and saved["discord_pending"] == []
            assert saved["posted"]["aa"]["discord_id"] == "9100" and "telegram_id" not in saved["posted"]["aa"]
    finally:
        time.sleep = real_sleep
    print("  [ok] Telegram and Discord: sending, retries, queues, and keeping secrets out of messages")

    # A rate limit is waited out in full, or the message is left for the next run.
    assert retry_wait("Discord", DiscordError, 429, 2, 1.0) == 2.5
    assert retry_wait("Discord", DiscordError, 429, MAX_RATE_LIMIT_WAIT, 1.0) == MAX_RATE_LIMIT_WAIT + 0.5
    assert retry_wait("Discord", DiscordError, 429, None, 4.0) == 4.5
    assert retry_wait("Discord", DiscordError, 503, 900, 2.0) == 2.0
    for client_error, asked in ((DiscordError, MAX_RATE_LIMIT_WAIT + 1), (TelegramError, 3600)):
        try:
            retry_wait("Service", client_error, 429, asked, 1.0)
            raise AssertionError("a long rate limit must end the attempt")
        except ChannelError as exc:
            assert isinstance(exc, client_error) and exc.retry_after == asked and "later run" in str(exc)
    slept: list[float] = []
    time.sleep = slept.append
    try:
        session = FakeSession([FakeResponse(429, {"message": "You are being rate limited.", "retry_after": 12}), FakeResponse(200, {"id": "1"})])
        assert DiscordClient(webhook_url=hook, session=session).post("hello") == "1" and slept == [12.5], slept
        session = FakeSession([FakeResponse(429, {"message": "You are being rate limited.", "retry_after": 600})])
        try:
            DiscordClient(webhook_url=hook, session=session).post("hello")
            raise AssertionError("a long rate limit must end the attempt")
        except DiscordError:
            assert len(session.sent) == 1 and slept == [12.5]
        session = FakeSession([FakeResponse(429, {"ok": False, "parameters": {"retry_after": 35}}), ok(31)])
        assert TelegramClient(token=token, chat_id="@channel", session=session).send_message("hi") == {"message_id": 31} and slept[-1] == 35.5
        # An accepted message without an id counts as sent: sending it again would duplicate it.
        assert DiscordClient(webhook_url=hook, session=FakeSession([FakeResponse(204, None)])).post("hello") is None
    finally:
        time.sleep = real_sleep
    # A long rate limit: one attempt, then nothing more in this run or in later runs until the
    # time the service named has passed.
    real_time = time.time
    clock = [1_800_000_000.0]
    time.time = lambda: clock[0]
    time.sleep = lambda _seconds: None
    try:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            state = default_state()
            state["posted"] = {"aa": {"height": 1}, "bb": {"height": 2}}
            limited = FakeResponse(429, {"message": "You are being rate limited.", "retry_after": 600})
            session = FakeSession([limited, FakeResponse(200, {"id": "should not be reached"})])
            channel = Channel(DiscordClient(webhook_url=hook, session=session), DEFAULT_TEMPLATE, True, discord_escape)
            queue_post(state, channel, block_hash="aa", height=1, text="first")
            assert flush_channel(state, path, channel, save=True) == 1
            queue_post(state, channel, block_hash="bb", height=2, text="second")
            save_state(path, state)  # as process() does after queueing a block
            assert flush_channel(state, path, channel, save=True) == 2
            assert len(session.sent) == 1, "the same run must not try a rate-limited channel twice"
            assert load_state(path)["discord_retry_at"] == 1_800_000_601

            # A later run, before the time has passed: nothing is sent.
            clock[0] += 300
            state = load_state(path)
            session = FakeSession([FakeResponse(200, {"id": "too early"})])
            channel = Channel(DiscordClient(webhook_url=hook, session=session), DEFAULT_TEMPLATE, True, discord_escape)
            assert flush_channel(state, path, channel, save=True) == 2 and session.sent == []

            # After it has passed: both go out, in order, and the stored time is cleared.
            clock[0] += 302
            state = load_state(path)
            session = FakeSession([FakeResponse(200, {"id": "71"}), FakeResponse(200, {"id": "72"})])
            channel = Channel(DiscordClient(webhook_url=hook, session=session), DEFAULT_TEMPLATE, True, discord_escape)
            assert flush_channel(state, path, channel, save=True) == 0
            assert [body["content"] for _url, body in session.sent] == ["first", "second"]
            saved = load_state(path)
            assert "discord_retry_at" not in saved and saved["discord_pending"] == []

            # Any other failure also ends this run's attempts for the channel, without a stored time.
            state = default_state()
            state["posted"] = {"aa": {"height": 1}}
            session = FakeSession([FakeResponse(403, {"ok": False, "description": "Forbidden"}), ok(1)])
            channel = Channel(TelegramClient(token=token, chat_id="@channel", session=session), DEFAULT_TEMPLATE, True)
            queue_post(state, channel, block_hash="aa", height=1, text="first")
            assert flush_channel(state, path, channel, save=True) == 1
            assert flush_channel(state, path, channel, save=True) == 1
            assert len(session.sent) == 1 and "telegram_retry_at" not in state
    finally:
        time.time = real_time
        time.sleep = real_sleep
    print("  [ok] rate limits are honoured in full, or remembered until they have passed")

    # Nostr: key decoding (the NIP-19 examples), signing, relay answers, and one note per block.
    if PrivateKey is None or websocket is None:
        print("  [skipped] Nostr (coincurve and websocket-client are not installed)")
    else:
        example_hex = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa"
        example_nsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5"
        example_npub = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg"
        key = nostr_secret(example_nsec)
        assert key is not None and key.hex() == example_hex and nostr_secret(example_hex) == key
        assert bech32_encode("nsec", key) == example_nsec
        for bad_key in ("", "nsec1", example_nsec[:-1] + "q", example_npub, "0" * 64, "f" * 64, example_hex[:-1]):
            assert nostr_secret(bad_key) is None, bad_key
        # BIP-340 test vector 0: the signing library gives the standard's own answer.
        assert PublicKeyXOnly.from_secret((3).to_bytes(32, "big")).format().hex().upper() == "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9"
        assert PrivateKey((3).to_bytes(32, "big")).sign_schnorr(bytes(32), bytes(32)).hex().upper() == (
            "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA8215"
            "25F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0"
        )

        note = nostr_event(key, "Stratum V2 block #1 mined by\nA \"quoted\" pool \\ \x07 \u533a\u5757", 1_800_000_000)
        assert note["pubkey"] == bech32_decode(example_npub, "npub").hex() and note["kind"] == 1 and note["tags"] == []
        assert "\x07" not in note["content"] and "\n" in note["content"]
        expected_id = hashlib.sha256(
            ('[0,"' + note["pubkey"] + '",1800000000,1,[],"Stratum V2 block #1 mined by\\nA \\"quoted\\" pool \\\\  \u533a\u5757"]').encode("utf-8")
        ).hexdigest()
        assert note["id"] == expected_id, (note["id"], expected_id)
        assert PublicKeyXOnly(bytes.fromhex(note["pubkey"])).verify(bytes.fromhex(note["sig"]), bytes.fromhex(note["id"]))
        assert nostr_event(key, "same", 5)["id"] == nostr_event(key, "same", 5)["id"] != nostr_event(key, "same", 6)["id"]

        for good in ("wss://relay.example", "wss://relay.example:444/path", "ws://127.0.0.1:7777"):
            assert nostr_relay_address(good) == good, good
        for bad_relay in ("", "https://relay.example", "ws://relay.example", "wss://user:pw@relay.example", "wss://", "relay.example"):
            assert nostr_relay_address(bad_relay) is None, bad_relay

        class FakeRelay:
            """Answers like a relay: what it sends back is decided by `answer`."""

            def __init__(self, answer: Any) -> None:
                self.answer = answer
                self.events: list[dict[str, Any]] = []
                self.closed = 0

            def __call__(self, address: str, timeout: Any = None, header: Any = None) -> "FakeRelay":
                if self.answer == "down":
                    raise OSError(f"cannot reach {address}")
                self.inbox: list[Any] = []
                return self

            def send(self, raw: str) -> None:
                kind, event = json.loads(raw)
                assert kind == "EVENT"
                self.events.append(event)
                if self.answer == "accept":
                    self.inbox = ['["NOTICE","hello"]', "not json", json.dumps(["OK", "another-id", True, ""]), json.dumps(["OK", event["id"], True, ""])]
                elif self.answer == "duplicate":
                    self.inbox = [json.dumps(["OK", event["id"], False, "duplicate: already have this event"])]
                elif self.answer == "refuse":
                    self.inbox = [json.dumps(["OK", event["id"], False, "blocked: not on the allow list\n\x1b[31m"])]
                else:
                    self.inbox = ['["NOTICE","nothing useful"]'] * 20

            def recv(self) -> str:
                return self.inbox.pop(0)

            def close(self) -> None:
                self.closed += 1

        def nostr_client(relay: FakeRelay, count: int = 1) -> NostrClient:
            return NostrClient(secret=key, relays=[f"wss://relay{index}.example" for index in range(count)], connect=relay, timeout=2)

        relay = FakeRelay("accept")
        client = nostr_client(relay, 2)
        assert example_hex not in repr(client) and example_nsec not in repr(client) and client.npub == example_npub
        first_id = client.post("block one", queued_at=1_800_000_000)
        assert first_id == relay.events[0]["id"] and len(relay.events) == 2 and relay.closed == 2
        assert relay.events[0]["created_at"] == 1_800_000_000 and relay.events[0]["content"] == "block one"
        # The same block sent again is the very same note, so a retry cannot create a second post.
        assert client.post("block one", queued_at=1_800_000_000) == first_id
        assert nostr_client(FakeRelay("duplicate")).post("block one", queued_at=1_800_000_000) == first_id
        for failing in ("refuse", "silent", "down"):
            try:
                nostr_client(FakeRelay(failing)).post("block one", queued_at=1_800_000_000)
                raise AssertionError(f"{failing}: a note no relay accepted must raise")
            except NostrError as exc:
                assert example_hex not in str(exc) and example_nsec not in str(exc)

        # One relay failing is fine as long as another accepts.
        class Mixed:
            def __init__(self) -> None:
                self.down, self.up = FakeRelay("down"), FakeRelay("accept")

            def __call__(self, address: str, timeout: Any = None, header: Any = None) -> Any:
                return (self.down if "relay0" in address else self.up)(address, timeout=timeout, header=header)

        assert NostrClient(secret=key, relays=["wss://relay0.example", "wss://relay1.example"], connect=Mixed()).post("x", queued_at=7)

        # Through the queue: a failed attempt and its retry publish the identical note.
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            state = default_state()
            state["posted"] = {"aa": {"height": 1}}
            down = Channel(nostr_client(FakeRelay("down")), DEFAULT_TEMPLATE, True)
            queue_post(state, down, block_hash="aa", height=1, text="queued block")
            queued_at = state["nostr_pending"][0]["queued_at"]
            save_state(path, state)  # as process() does after queueing a block
            assert flush_channel(state, path, down, save=True) == 1
            saved_text = path.read_text(encoding="utf-8")
            assert example_hex not in saved_text and example_nsec not in saved_text
            relay = FakeRelay("accept")
            up = Channel(nostr_client(relay), DEFAULT_TEMPLATE, True)
            state = load_state(path)
            assert flush_channel(state, path, up, save=True) == 0
            assert relay.events[0]["created_at"] == queued_at
            assert state["posted"]["aa"]["nostr_id"] == relay.events[0]["id"] == nostr_event(key, "queued block", queued_at)["id"]
        print("  [ok] Nostr: key decoding, signing, relay answers, and identical notes on retry")

    # --verbose must not let the HTTP or OAuth libraries log addresses or signing details.
    levels = {name: logging.getLogger(name).level for name in ("urllib3", "requests", "requests_oauthlib", "oauthlib")}
    own_level = log.level
    try:
        configure_logging(True)
        assert log.isEnabledFor(logging.DEBUG)
        for name in ("urllib3.connectionpool", "requests", "requests_oauthlib.oauth1_auth", "oauthlib.oauth1.rfc5849"):
            assert not logging.getLogger(name).isEnabledFor(logging.INFO), name
    finally:
        log.setLevel(own_level)
        for name, level in levels.items():
            logging.getLogger(name).setLevel(level)
    print("  [ok] verbose logging keeps library request logs off")

    if failures:
        print(f"{failures} self-test failure(s)")
        return 1
    print("All self-tests passed")
    return 0


def channel_test(client: Any, missing: str) -> int:
    """Send one message to the channel, to check that posting there works."""
    if client is None:
        log.error("Set %s first.", missing)
        return 2
    try:
        message_id = client.post(CONNECTED_TEXT)
    except ChannelError as exc:
        log.error("%s test failed: %s", client.label, exc)
        return 1
    log.info("%s test message sent (message id=%s)", client.label, message_id)
    if isinstance(client, NostrClient):
        # Public information: the account's address, to follow it or link to it.
        log.info("Nostr account: %s (see it at https://njump.me/%s)", client.npub, client.npub)
    return 0


def credentials_from_env() -> dict[str, str]:
    mapping = {
        "api_key": os.environ.get("X_API_KEY") or os.environ.get("TWITTER_API_KEY") or "",
        "api_secret": os.environ.get("X_API_SECRET") or os.environ.get("TWITTER_API_SECRET") or "",
        "access_token": os.environ.get("X_ACCESS_TOKEN") or os.environ.get("TWITTER_ACCESS_TOKEN") or "",
        "access_token_secret": (
            os.environ.get("X_ACCESS_TOKEN_SECRET")
            or os.environ.get("TWITTER_ACCESS_TOKEN_SECRET")
            or ""
        ),
    }
    return mapping


def run_once(args: argparse.Namespace) -> int:
    state_path = Path(args.state_file).expanduser().resolve()
    lock_fh = acquire_lock(state_path)
    try:
        http = HttpClient(user_agent=os.environ.get("USER_AGENT", USER_AGENT))
        mempool = Mempool(os.environ.get("MEMPOOL_API", DEFAULT_MEMPOOL), http)
        state = load_state(state_path)
        creds = credentials_from_env()
        dry_run = bool(args.dry_run)
        x_client = None
        if not dry_run:
            missing = [k for k, v in creds.items() if not v]
            if missing:
                log.error(
                    "Missing X credentials: %s. Set them in .env (see .env.example) "
                    "or pass --dry-run.",
                    ", ".join(missing),
                )
                return 2
            x_client = XClient(
                api_key=creds["api_key"],
                api_secret=creds["api_secret"],
                access_token=creds["access_token"],
                access_token_secret=creds["access_token_secret"],
                http=http,
                endpoint=os.environ.get("X_TWEET_API", DEFAULT_TWEET_API),
            )

        tz_name = os.environ.get("TIMEZONE", "Europe/Belgrade")
        tz = ZoneInfo(tz_name)
        overnight_start = int(os.environ.get("OVERNIGHT_START", "0"))
        overnight_end = int(os.environ.get("OVERNIGHT_END", "7"))
        template = os.environ.get("TWEET_TEMPLATE", DEFAULT_TEMPLATE)
        # Honour literal \n in a .env template.
        template = template.replace("\\n", "\n")
        handles = parse_pairs(os.environ.get("POOL_HANDLES", DEFAULT_POOL_HANDLES))
        pools_path = Path(
            args.pools_file
            or os.environ.get("POOLS_FILE")
            or (Path(__file__).resolve().parent / DEFAULT_POOLS_FILE)
        ).expanduser()
        # X's automation rules allow automated @mentions only of accounts that opted in, so pool
        # handles are used only when MENTION_POOLS is switched on. Explicit POOL_HANDLES still apply.
        pools = load_pools(pools_path) if env_flag("MENTION_POOLS", False) else []
        include_link = env_flag("INCLUDE_BLOCK_LINK", False)
        if args.block_link:
            include_link = True
        if args.no_block_link:
            include_link = False
        seed_counts = parse_seed_counts(os.environ.get("SV2_SEED_COUNTS", DEFAULT_SEED_COUNTS))
        seed_height = int(os.environ.get("SV2_SEED_HEIGHT", str(DEFAULT_SEED_HEIGHT)))

        channels = channels_from_env(template)
        save = not args.no_save_state
        # Blocks an earlier run could not get onto Telegram or Discord go out first.
        if not dry_run:
            for channel in channels:
                flush_channel(state, state_path, channel, save=save)

        posted = process(
            mempool=mempool,
            state=state,
            state_path=state_path,
            x_client=x_client,
            dry_run=dry_run,
            save=save,
            backfill_hours=args.backfill_hours,
            tz=tz,
            overnight_start=overnight_start,
            overnight_end=overnight_end,
            template=template,
            handles=handles,
            pools=pools,
            include_link=include_link,
            seed_counts=seed_counts,
            seed_height=seed_height,
            channels=channels,
        )
        if posted:
            log.info("Emitted %s tweet(s)", len(posted))
        else:
            log.info("No new SV2 blocks to post")
        behind = False
        for channel in [] if dry_run else channels:
            waiting = len(state.get(channel.client.pending_key) or [])
            if waiting:
                # X is done and the state is saved; the run is marked failed so the trouble is noticed.
                log.error("%s block(s) are still waiting to be posted to %s; the next run retries.", waiting, channel.client.label)
                behind = True
        return 1 if behind else 0
    finally:
        lock_fh.close()


def configure_logging(verbose: bool) -> None:
    """--verbose turns on this script's own debug lines, and only those.

    The HTTP and OAuth libraries write each request's address and its signing details at debug
    level. Those contain the Telegram token, the Discord webhook address and X signing material,
    so the libraries are never allowed below WARNING, whatever the script's own level is.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    log.setLevel(logging.DEBUG if verbose else logging.INFO)
    for library in ("urllib3", "requests", "requests_oauthlib", "oauthlib"):
        logging.getLogger(library).setLevel(logging.WARNING)


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    testing = args.telegram_test or args.discord_test or args.nostr_test
    if testing and (args.dry_run or args.loop):
        # A test sends a real message, so it must never be mistaken for a run that sends nothing.
        parser.error("--telegram-test, --discord-test and --nostr-test send a real message and cannot be combined with --dry-run or --loop")
    load_env_file(args.env_file)
    configure_logging(args.verbose)
    if args.self_test:
        return self_test()
    if testing:
        codes = []
        if args.telegram_test:
            codes.append(channel_test(telegram_from_env(), "TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL"))
        if args.discord_test:
            codes.append(channel_test(discord_from_env(), "DISCORD_WEBHOOK_URL"))
        if args.nostr_test:
            codes.append(channel_test(nostr_from_env(), "NOSTR_PRIVATE_KEY"))
        return max(codes)

    if args.loop:
        log.info("Loop mode, interval=%ss, dry_run=%s", args.interval, args.dry_run)
        while True:
            try:
                code = run_once(args)
                if code not in (0,):
                    log.error("Pass exited with status %s; will retry after interval", code)
            except KeyboardInterrupt:
                log.info("Stopped")
                return 0
            except Exception:
                log.exception("Pass failed; will retry after interval")
            time.sleep(max(5, args.interval))
    else:
        # --once is the default.
        return run_once(args)


if __name__ == "__main__":
    sys.exit(main())
