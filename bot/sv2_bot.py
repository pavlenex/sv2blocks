#!/usr/bin/env python3
"""Tweet whenever a new Stratum V2 Bitcoin block appears on mempool.space.

Detection matches the daily SV2 recap: decode extras.coinbaseRaw (the
coinbase scriptsig) to printable ASCII and look for an Sv2 / Stratum V2
tag. A bare "v2" is not enough — random extranonce bytes can spell that
by chance.

This script never posts unless it is given X API user-context credentials
and is run without --dry-run. First run without --backfill-hours only
initialises state at the current tip so it will not dump a backlog of
old blocks onto a new account.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from zoneinfo import ZoneInfo

import requests
from requests_oauthlib import OAuth1

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional at runtime if env is already set
    def load_dotenv(*_args: Any, **_kwargs: Any) -> bool:
        return False

log = logging.getLogger("sv2-x-bot")

DEFAULT_MEMPOOL = "https://mempool.space"
DEFAULT_TWEET_API = "https://api.x.com/2/tweets"
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
        if save:
            save_state(state_path, state)
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

    if failures:
        print(f"{failures} self-test failure(s)")
        return 1
    print("All self-tests passed")
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

        posted = process(
            mempool=mempool,
            state=state,
            state_path=state_path,
            x_client=x_client,
            dry_run=dry_run,
            save=not args.no_save_state,
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
        )
        if posted:
            log.info("Emitted %s tweet(s)", len(posted))
        else:
            log.info("No new SV2 blocks to post")
        return 0
    finally:
        lock_fh.close()


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    load_env_file(args.env_file)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    if args.self_test:
        return self_test()

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
