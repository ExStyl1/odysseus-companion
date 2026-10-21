#!/usr/bin/env python3
"""
time_cli — single-file CLI for reading/searching Tinkoff Time (Mattermost).

Designed to be copied to any host with Python 3.10+ and run without installation.
Zero external dependencies (stdlib only). Agent-friendly: supports --json on every
command.

Environment (or .env next to the script):
    MM_URL    Mattermost base URL          (default: https://time.tbank.ru)
    MM_TOKEN  Auth token (Bearer or cookie MMAUTHTOKEN)
    MM_CSRF   CSRF token when using cookie auth (optional)

Commands:
    channels  list channels                   (--pattern, --type)
    dms       list direct/group chats         (--with USERNAME)
    threads   list followed threads           (--channel, --mentions, --since …)
    posts     messages from a channel         (--channel, --since, --author, --contains)
    search    full-text server-side search    (QUERY, --channel, --author, --since)
    thread    show a single thread            (--id | --url, --author, --contains)
    reply     post a reply to a thread        (--url, --message)

Run `python time_cli.py <cmd> --help` for per-command options.
Add --json to any read command to get machine-readable output (one JSON per call).

Examples:
    python time_cli.py channels --pattern dev --json
    python time_cli.py dms --with alice
    python time_cli.py threads --channel dev,ops --since 7d
    python time_cli.py posts --channel dev-bot --since 2026-04-10 --contains deploy
    python time_cli.py search "postgres migration" --author alice --since 30d
    python time_cli.py thread --url https://time.tbank.ru/channel/ab/thread/xy
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger("time_cli")


# =========================================================================
# Disk cache for users/channels (survives across invocations)
# =========================================================================

_CACHE_TTL_S = 7 * 24 * 3600  # 7 days


def _cache_path(kind: str, base_url: str) -> Path:
    """Cache file keyed by host, so different MM instances don't collide."""
    host = urllib.parse.urlparse(base_url).hostname or "default"
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", host)
    d = Path.home() / ".cache" / "time-cli" / safe
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{kind}.json"


def _cache_load(kind: str, base_url: str) -> dict:
    path = _cache_path(kind, base_url)
    if not path.exists():
        return {}
    try:
        d = json.loads(path.read_text())
        if time.time() - d.get("_saved_at", 0) > _CACHE_TTL_S:
            return {}
        return d.get("data", {})
    except Exception:
        return {}


def _cache_save(kind: str, base_url: str, data: dict) -> None:
    path = _cache_path(kind, base_url)
    try:
        path.write_text(json.dumps({"_saved_at": time.time(), "data": data}))
    except OSError:
        pass


# =========================================================================
# Models
# =========================================================================

_BASE_URL_FOR_LINKS: str = ""  # set by CLI to enable permalinks in output


@dataclass
class Post:
    id: str
    user_id: str
    author: str
    text: str
    timestamp: int  # ms since epoch
    create_at: str  # ISO-8601 UTC
    channel_id: str = ""
    root_id: str = ""
    is_mention: bool = False

    @classmethod
    def from_api(cls, raw: dict, user_cache: dict[str, str]) -> Post:
        uid = raw.get("user_id", "")
        author = user_cache.get(uid) or (uid[:8] if uid else "")
        ts = raw.get("create_at", 0) or 0
        iso = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat() if ts else ""
        mentions = raw.get("props", {}).get("mentions") if isinstance(raw.get("props"), dict) else None
        return cls(
            id=raw["id"],
            user_id=uid,
            author=author,
            text=raw.get("message", ""),
            timestamp=ts,
            create_at=iso,
            channel_id=raw.get("channel_id", ""),
            root_id=raw.get("root_id", "") or "",
            is_mention=bool(mentions),
        )

    @property
    def permalink(self) -> str:
        if not _BASE_URL_FOR_LINKS or not self.id:
            return ""
        return f"{_BASE_URL_FOR_LINKS}/_redirect/pl/{self.id}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["permalink"] = self.permalink
        return d


@dataclass
class ThreadData:
    id: str
    channel_id: str
    channel_name: str
    root_message: str
    reply_count: int = 0
    last_reply_at: int = 0
    has_mentions: bool = False
    participant_ids: list[str] = field(default_factory=list)
    posts: list[Post] = field(default_factory=list)

    @property
    def message_count(self) -> int:
        return len(self.posts)

    def last_message_time(self) -> int:
        if self.posts:
            return max(p.timestamp for p in self.posts)
        return self.last_reply_at

    @property
    def url(self) -> str:
        if not _BASE_URL_FOR_LINKS or not self.id:
            return ""
        return f"{_BASE_URL_FOR_LINKS}/_redirect/pl/{self.id}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["message_count"] = self.message_count
        d["last_message_time"] = self.last_message_time()
        d["url"] = self.url
        d["posts"] = [p.to_dict() for p in self.posts]
        return d


@dataclass
class ChannelInfo:
    id: str
    name: str
    display_name: str
    type: str  # "O" public, "P" private, "D" DM, "G" group DM
    team_id: str
    total_msg_count: int = 0
    resolved_name: str = ""  # human-readable label, populated by TimeReader

    @classmethod
    def from_api(cls, raw: dict) -> ChannelInfo:
        return cls(
            id=raw["id"],
            name=raw.get("name", ""),
            display_name=raw.get("display_name", ""),
            type=raw.get("type", "O"),
            team_id=raw.get("team_id", ""),
            total_msg_count=raw.get("total_msg_count", 0),
        )

    @property
    def label(self) -> str:
        return self.resolved_name or self.display_name or self.name or self.id

    def to_dict(self) -> dict:
        d = asdict(self)
        d["label"] = self.label
        return d


@dataclass
class SearchResult:
    query: str
    threads: list[ThreadData] = field(default_factory=list)
    posts: list[Post] = field(default_factory=list)
    total_count: int = 0
    diagnostics: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "query": self.query,
            "total_count": self.total_count,
            "threads": [t.to_dict() for t in self.threads],
            "posts": [p.to_dict() for p in self.posts],
            "diagnostics": self.diagnostics,
        }


# =========================================================================
# HTTP client
# =========================================================================

class TimeClient:
    """Low-level Mattermost v4 HTTP client (stdlib urllib)."""

    def __init__(
        self,
        base_url: str,
        token: str,
        csrf_token: str = "",
        delay: float = 0.1,
        use_disk_cache: bool = True,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._csrf_token = csrf_token
        self._delay = delay
        self._use_disk_cache = use_disk_cache
        self._user_cache: dict[str, str] = {}  # user_id -> username
        self._user_cache_dirty = False
        if use_disk_cache:
            self._user_cache.update(_cache_load("users", self._base_url))

    def flush_cache(self) -> None:
        if self._use_disk_cache and self._user_cache_dirty:
            _cache_save("users", self._base_url, self._user_cache)
            self._user_cache_dirty = False

    # ----- low-level -----

    def _request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        data: dict | None = None,
    ) -> Any:
        url = f"{self._base_url}{path}"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"

        req = urllib.request.Request(url, method=method)
        req.add_header("Content-Type", "application/json")
        if self._csrf_token:
            req.add_header("Cookie", f"MMAUTHTOKEN={self._token}")
            req.add_header("X-CSRF-Token", self._csrf_token)
            req.add_header("X-Requested-With", "XMLHttpRequest")
        else:
            req.add_header("Authorization", f"Bearer {self._token}")

        if data is not None:
            req.data = json.dumps(data).encode()

        log.debug("%s %s", method, url)
        if self._delay:
            time.sleep(self._delay)

        try:
            with urllib.request.urlopen(req) as resp:
                if resp.status == 204:
                    return {}
                body = resp.read()
                return json.loads(body.decode()) if body else {}
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise RuntimeError(
                    "401 Unauthorized — check MM_TOKEN (cookie MMAUTHTOKEN may be expired)"
                ) from e
            if e.code == 429:
                retry_after = int(e.headers.get("Retry-After", "5"))
                log.warning("429 rate limit, sleeping %ds", retry_after)
                time.sleep(retry_after)
                return self._request(method, path, params, data)
            raise

    def _paginated(
        self,
        path: str,
        params: dict | None = None,
        per_page: int = 100,
        max_pages: int = 0,
    ) -> list[dict]:
        params = dict(params or {})
        params["per_page"] = per_page
        out: list[dict] = []
        page = 0
        while True:
            params["page"] = page
            batch = self._request("GET", path, params)
            if not isinstance(batch, list):
                break
            out.extend(batch)
            if len(batch) < per_page:
                break
            page += 1
            if max_pages and page >= max_pages:
                break
        return out

    # ----- endpoints -----

    def get_me(self) -> dict:
        return self._request("GET", "/api/v4/users/me")

    def get_my_teams(self) -> list[dict]:
        return self._request("GET", "/api/v4/users/me/teams")

    def get_team_channels(
        self, user_id: str, team_id: str, max_pages: int = 0,
    ) -> list[dict]:
        return self._paginated(
            f"/api/v4/users/{user_id}/teams/{team_id}/channels",
            max_pages=max_pages,
        )

    def iter_team_channels_pages(
        self, user_id: str, team_id: str, max_pages: int = 10,
    ):
        """Yield one page (list[dict]) at a time; caller can break early."""
        path = f"/api/v4/users/{user_id}/teams/{team_id}/channels"
        page = 0
        while True:
            batch = self._request("GET", path, {"per_page": 100, "page": page})
            if not isinstance(batch, list) or not batch:
                return
            yield batch
            if len(batch) < 100:
                return
            page += 1
            if max_pages and page >= max_pages:
                return

    def get_channel(self, channel_id: str) -> dict:
        return self._request("GET", f"/api/v4/channels/{channel_id}")

    def get_user(self, user_id: str) -> dict:
        return self._request("GET", f"/api/v4/users/{user_id}")

    def get_username(self, user_id: str) -> str:
        if user_id not in self._user_cache:
            try:
                u = self.get_user(user_id)
                self._user_cache[user_id] = u.get("username", user_id[:8])
            except Exception:
                self._user_cache[user_id] = user_id[:8]
            self._user_cache_dirty = True
        return self._user_cache[user_id]

    def get_user_by_name(self, username: str) -> dict | None:
        try:
            return self._request("GET", f"/api/v4/users/username/{urllib.parse.quote(username)}")
        except urllib.error.HTTPError:
            return None

    def search_users(self, term: str, limit: int = 20) -> list[dict]:
        """Fuzzy search users by username/first_name/last_name/nickname/email."""
        try:
            resp = self._request("POST", "/api/v4/users/search",
                                 data={"term": term, "limit": limit})
            if isinstance(resp, list):
                return resp
        except urllib.error.HTTPError:
            pass
        return []

    def get_users_by_ids(self, user_ids: list[str]) -> list[dict]:
        """Bulk fetch users. Populates the username cache as a side effect."""
        ids = [u for u in set(user_ids) if u and u not in self._user_cache]
        out: list[dict] = []
        # MM limits the batch to ~200 per call.
        for i in range(0, len(ids), 200):
            chunk = ids[i:i + 200]
            resp = self._request("POST", "/api/v4/users/ids", data=chunk)
            if isinstance(resp, list):
                out.extend(resp)
                for u in resp:
                    self._user_cache[u["id"]] = u.get("username", u["id"][:8])
                if resp:
                    self._user_cache_dirty = True
        # Return from cache so already-known ids are included.
        return [{"id": uid, "username": self._user_cache.get(uid, uid[:8])}
                for uid in set(user_ids) if uid]

    def get_channels_by_ids(self, channel_ids: list[str]) -> list[dict]:
        """Bulk fetch channels."""
        ids = list({c for c in channel_ids if c})
        out: list[dict] = []
        for i in range(0, len(ids), 200):
            chunk = ids[i:i + 200]
            try:
                resp = self._request("POST", "/api/v4/channels/ids", data=chunk)
            except urllib.error.HTTPError:
                # Fallback: some deployments disable this endpoint for non-admins.
                for cid in chunk:
                    try:
                        resp_one = self._request("GET", f"/api/v4/channels/{cid}")
                        if isinstance(resp_one, dict):
                            out.append(resp_one)
                    except urllib.error.HTTPError:
                        pass
                continue
            if isinstance(resp, list):
                out.extend(resp)
        return out

    def get_channel_by_name(self, team_id: str, name: str) -> dict | None:
        try:
            resp = self._request(
                "GET",
                f"/api/v4/teams/{team_id}/channels/name/{urllib.parse.quote(name)}",
            )
            return resp if isinstance(resp, dict) else None
        except urllib.error.HTTPError:
            return None

    def get_followed_threads(
        self,
        user_id: str,
        team_id: str,
        max_pages: int = 0,
    ) -> list[dict]:
        path = f"/api/v4/users/{user_id}/teams/{team_id}/threads"
        out: list[dict] = []
        before = ""
        page = 0
        while True:
            params: dict = {
                "extended": "true",
                "deleted": "false",
                "totalsOnly": "false",
                "skipTotal": "true",
                "per_page": 100,
            }
            if before:
                params["before"] = before
            resp = self._request("GET", path, params)
            threads = resp.get("threads", []) if isinstance(resp, dict) else resp
            if not threads:
                break
            out.extend(threads)
            if len(threads) < 100:
                break
            before = threads[-1]["id"]
            page += 1
            if max_pages and page >= max_pages:
                break
        return out

    def get_thread_posts(self, post_id: str) -> list[dict]:
        resp = self._request("GET", f"/api/v4/posts/{post_id}/thread")
        if isinstance(resp, dict):
            posts = list(resp.get("posts", {}).values())
            order = resp.get("order", [])
            if order:
                idx = {pid: i for i, pid in enumerate(order)}
                posts.sort(key=lambda p: idx.get(p["id"], 0))
            else:
                posts.sort(key=lambda p: p.get("create_at", 0))
            return posts
        return resp if isinstance(resp, list) else []

    def get_channel_posts(
        self,
        channel_id: str,
        params: dict | None = None,
    ) -> list[dict]:
        """Return channel posts newest-first (MM native order)."""
        resp = self._request("GET", f"/api/v4/channels/{channel_id}/posts", params or {})
        if isinstance(resp, dict):
            posts_map = resp.get("posts", {}) or {}
            order = resp.get("order", []) or []
            return [posts_map[pid] for pid in order if pid in posts_map]
        return resp if isinstance(resp, list) else []

    def search_posts(
        self,
        team_id: str,
        terms: str,
        per_page: int = 100,
    ) -> list[dict]:
        resp = self._request(
            "POST",
            f"/api/v4/teams/{team_id}/posts/search",
            params={"per_page": per_page},
            data={"terms": terms, "is_or_search": False},
        )
        if isinstance(resp, dict):
            order = resp.get("order", []) or []
            posts_map = resp.get("posts", {}) or {}
            if order and posts_map:
                return [posts_map[pid] for pid in order if pid in posts_map]
            if posts_map:
                return list(posts_map.values())
        if isinstance(resp, list):
            return resp
        return []

    def create_post(self, channel_id: str, message: str, root_id: str = "") -> dict:
        return self._request(
            "POST",
            "/api/v4/posts",
            data={"channel_id": channel_id, "message": message, "root_id": root_id},
        )


# =========================================================================
# Reader (high-level)
# =========================================================================

class TimeReader:
    def __init__(self, client: TimeClient, team_id: str | None = None,
                 use_disk_cache: bool = True) -> None:
        self._client = client
        self._team_id_override = team_id
        self._me: dict | None = None
        self._team_id: str | None = team_id
        self._channels_cache: dict[str, ChannelInfo] = {}
        self._channels_dirty = False
        self._use_disk_cache = use_disk_cache
        if use_disk_cache:
            raw = _cache_load("channels", self._client._base_url)
            for cid, d in raw.items():
                try:
                    self._channels_cache[cid] = ChannelInfo(**d)
                except TypeError:
                    pass

    def flush_cache(self) -> None:
        if self._use_disk_cache and self._channels_dirty:
            _cache_save(
                "channels",
                self._client._base_url,
                {cid: asdict(ch) for cid, ch in self._channels_cache.items()},
            )
            self._channels_dirty = False
        self._client.flush_cache()

    # ----- context -----

    def _get_me(self) -> dict:
        if self._me is None:
            self._me = self._client.get_me()
        return self._me

    def _get_team_id(self) -> str:
        if self._team_id:
            return self._team_id
        teams = self._client.get_my_teams()
        if not teams:
            raise RuntimeError("No teams available for current user")
        self._team_id = teams[0]["id"]
        return self._team_id

    def _channel_info(self, channel_id: str) -> ChannelInfo:
        if channel_id not in self._channels_cache:
            raw = self._client.get_channel(channel_id)
            self._channels_cache[channel_id] = ChannelInfo.from_api(raw)
            self._channels_dirty = True
        return self._channels_cache[channel_id]

    def _channel_name(self, channel_id: str) -> str:
        ch = self._channel_info(channel_id)
        self._resolve_dm_name(ch)
        return ch.label

    def _resolve_dm_name(self, ch: ChannelInfo) -> None:
        """Populate ch.resolved_name for DMs/groups using usernames."""
        if ch.resolved_name or ch.type not in ("D", "G"):
            return
        if ch.type == "D" and "__" in ch.name:
            uids = ch.name.split("__")
            me_id = self._me["id"] if self._me else ""
            others = [u for u in uids if u != me_id]
            if not others:
                others = uids
            self._prefetch_users(others)
            names = [self._client._user_cache.get(u, u[:8]) for u in others]
            ch.resolved_name = f"dm:{','.join(names)}"
        elif ch.type == "G":
            ch.resolved_name = ch.display_name or f"group:{ch.name[:16]}"

    def _prefetch_channels(self, channel_ids: Iterable[str]) -> None:
        """Bulk-fetch channels not in cache (1 request for up to 200 ids)."""
        missing = [c for c in set(channel_ids) if c and c not in self._channels_cache]
        if not missing:
            return
        for raw in self._client.get_channels_by_ids(missing):
            info = ChannelInfo.from_api(raw)
            self._channels_cache[info.id] = info
        self._channels_dirty = True
        # Resolve DM names for any newly-fetched channels
        for cid in missing:
            info = self._channels_cache.get(cid)
            if info:
                self._resolve_dm_name(info)

    def _prefetch_users(self, user_ids: Iterable[str]) -> None:
        """Bulk-fetch usernames into TimeClient._user_cache."""
        ids = [u for u in set(user_ids) if u]
        if not ids:
            return
        self._client.get_users_by_ids(ids)

    def _user_cache_for(self, user_ids: Iterable[str]) -> dict[str, str]:
        ids = list({u for u in user_ids if u})
        self._prefetch_users(ids)
        return {uid: self._client._user_cache.get(uid, uid[:8]) for uid in ids}

    # ----- channels -----

    def list_channels(
        self,
        pattern: str | None = None,
        channel_type: str | None = None,
        limit: int | None = None,
        max_pages: int = 10,
    ) -> list[ChannelInfo]:
        """Walk channels page-by-page; stop early once `limit` matches are collected."""
        team_id = self._get_team_id()
        user_id = self._get_me()["id"]
        out: list[ChannelInfo] = []
        pat = pattern.lower() if pattern else None

        for page_raw in self._client.iter_team_channels_pages(user_id, team_id, max_pages=max_pages):
            for r in page_raw:
                info = ChannelInfo.from_api(r)
                if channel_type and info.type != channel_type:
                    continue
                if pat and pat not in info.name.lower() and pat not in info.display_name.lower():
                    continue
                self._channels_cache[info.id] = info
                self._channels_dirty = True
                out.append(info)
                if limit and len(out) >= limit:
                    break
            if limit and len(out) >= limit:
                break
        # Resolve DM/group names for the final set.
        for info in out:
            self._resolve_dm_name(info)
        return out

    def find_channels_by_name(self, names: list[str]) -> list[ChannelInfo]:
        """Resolve substrings/names (case-insensitive) to channels."""
        all_channels = self.list_channels()
        needles = [n.lower() for n in names if n]
        out: list[ChannelInfo] = []
        seen: set[str] = set()
        for needle in needles:
            for ch in all_channels:
                if ch.id in seen:
                    continue
                if needle in ch.name.lower() or needle in ch.display_name.lower():
                    out.append(ch)
                    seen.add(ch.id)
        return out

    def list_dms(
        self,
        with_username: str | None = None,
        limit: int | None = None,
        max_pages: int = 10,
    ) -> list[ChannelInfo]:
        """DM (type=D) and group DM (type=G). Filter by counterpart username if given."""
        # Pull D and G separately; early-stop via list_channels limit.
        # When we have to resolve usernames for --with, pull more candidates
        # since the filter is post-hoc.
        pool_limit = None if with_username else limit
        direct = self.list_channels(channel_type="D", limit=pool_limit, max_pages=max_pages)
        group = self.list_channels(channel_type="G", limit=pool_limit, max_pages=max_pages)
        chans = direct + group
        if not with_username:
            return chans[:limit] if limit else chans

        needle = with_username.lower()
        result: list[ChannelInfo] = []
        for ch in chans:
            if ch.type == "D" and "__" in ch.name:
                uids = ch.name.split("__")
                usernames = [self._client.get_username(u) for u in uids]
                if any(needle in u.lower() for u in usernames):
                    result.append(ch)
            elif needle in ch.display_name.lower() or needle in ch.name.lower():
                result.append(ch)
            if limit and len(result) >= limit:
                break
        return result

    # ----- posts in channel -----

    def get_channel_posts(
        self,
        channel: str,
        since_ms: int | None = None,
        until_ms: int | None = None,
        author: str | None = None,
        contains: str | None = None,
        limit: int = 100,
    ) -> list[Post]:
        """Get posts from a channel (by ID or substring of name)."""
        ch = self._resolve_channel(channel)
        if ch is None:
            raise RuntimeError(f"Channel not found: {channel}")

        # Paginate channel posts until we have enough or we cross since_ms.
        out_raw: list[dict] = []
        params: dict = {"per_page": min(200, max(limit, 60))}
        # MM supports since= (ms); use it when we have a lower bound.
        if since_ms:
            params["since"] = since_ms
            out_raw = self._client.get_channel_posts(ch.id, params)
        else:
            # Walk pages newest-first until limit reached
            page = 0
            while len(out_raw) < limit:
                batch = self._client.get_channel_posts(
                    ch.id, {"per_page": 100, "page": page}
                )
                if not batch:
                    break
                out_raw.extend(batch)
                if len(batch) < 100:
                    break
                page += 1

        user_cache = self._user_cache_for(p.get("user_id", "") for p in out_raw)
        posts = [Post.from_api(p, user_cache) for p in out_raw]

        # Apply filters
        posts = _filter_posts(
            posts,
            author=author,
            contains=contains,
            since_ms=since_ms,
            until_ms=until_ms,
        )
        # Sort newest first
        posts.sort(key=lambda p: p.timestamp, reverse=True)
        return posts[:limit]

    def _resolve_channel(self, channel: str) -> ChannelInfo | None:
        """Accept channel_id (26 hex-ish chars), exact name, or substring."""
        if _looks_like_id(channel):
            return self._channel_info(channel)
        # Try exact name match first — single fast request.
        try:
            team_id = self._get_team_id()
            raw = self._client.get_channel_by_name(team_id, channel)
            if raw:
                info = ChannelInfo.from_api(raw)
                self._channels_cache[info.id] = info
                return info
        except Exception:
            pass
        # Fallback: substring walk.
        matches = self.find_channels_by_name([channel])
        return matches[0] if matches else None

    # ----- threads -----

    def list_threads(
        self,
        channels: list[str] | None = None,
        only_mentions: bool = False,
        since_ms: int | None = None,
        until_ms: int | None = None,
        min_messages: int | None = None,
        max_messages: int | None = None,
        limit: int = 100,
        with_posts: bool = False,
        participants: list[str] | None = None,
    ) -> list[ThreadData]:
        team_id = self._get_team_id()
        user_id = self._get_me()["id"]
        raw = self._client.get_followed_threads(user_id, team_id)

        channel_ids: set[str] | None = None
        if channels:
            resolved = self.find_channels_by_name(channels) if not all(
                _looks_like_id(c) for c in channels
            ) else [self._channel_info(c) for c in channels]
            channel_ids = {c.id for c in resolved}

        # Resolve participant usernames to IDs
        participant_ids: set[str] = set()
        if participants:
            for name in participants:
                u = self._client.get_user_by_name(name.lstrip("@"))
                if u:
                    participant_ids.add(u["id"])

        # Prefetch channels referenced by the candidate threads (bulk).
        candidate_ch_ids = {
            (r.get("post") or {}).get("channel_id", "") for r in raw
        }
        self._prefetch_channels(candidate_ch_ids)

        # Pre-filter raw threads before expensive post-fetching.
        filtered_raw: list[dict] = []
        for r in raw:
            post = r.get("post", {}) or {}
            ch_id = post.get("channel_id", "")
            if channel_ids is not None and ch_id not in channel_ids:
                continue
            last_reply = r.get("last_reply_at", 0) or 0
            if since_ms and last_reply < since_ms:
                continue
            if until_ms and last_reply > until_ms:
                continue
            if participant_ids:
                parts = r.get("participants", []) or []
                pids = {p["id"] if isinstance(p, dict) else p for p in parts}
                if not (participant_ids & pids):
                    continue
            filtered_raw.append(r)

        # Parallel-load posts if needed.
        posts_map: dict[str, list[dict]] = {}
        if with_posts or only_mentions:
            needed_ids = [r["id"] for r in filtered_raw[:limit * 2]]  # buffer
            posts_map = self._parallel_thread_posts(needed_ids)

        out: list[ThreadData] = []
        for r in filtered_raw:
            if with_posts or only_mentions:
                td = self._build_thread_with_posts(r, posts_map.get(r["id"]))
            else:
                td = self._build_thread_metadata(r)

            if only_mentions and not td.has_mentions:
                continue
            if min_messages is not None and td.reply_count < min_messages - 1:
                continue
            if max_messages is not None and td.reply_count > max_messages - 1:
                continue
            out.append(td)
            if len(out) >= limit:
                break
        return out

    def _build_thread_metadata(self, raw: dict) -> ThreadData:
        post = raw.get("post", {}) or {}
        ch_id = post.get("channel_id", "")
        participants = raw.get("participants", []) or []
        pids = [p["id"] for p in participants if isinstance(p, dict) and "id" in p]
        return ThreadData(
            id=raw["id"],
            channel_id=ch_id,
            channel_name=self._channel_name(ch_id) if ch_id else "",
            root_message=(post.get("message", "") or "")[:500],
            reply_count=raw.get("reply_count", 0) or 0,
            last_reply_at=raw.get("last_reply_at", 0) or 0,
            participant_ids=pids,
        )

    def _build_thread_with_posts(
        self, raw: dict, raw_posts: list[dict] | None = None,
    ) -> ThreadData:
        td = self._build_thread_metadata(raw)
        if raw_posts is None:
            try:
                raw_posts = self._client.get_thread_posts(td.id)
            except Exception as e:
                log.warning("failed to load posts for %s: %s", td.id, e)
                raw_posts = []
        uc = self._user_cache_for(p.get("user_id", "") for p in raw_posts)
        posts = [Post.from_api(p, uc) for p in raw_posts]
        td.posts = posts
        td.has_mentions = any(p.is_mention for p in posts)
        return td

    def _parallel_thread_posts(
        self, thread_ids: list[str], workers: int = 20,
    ) -> dict[str, list[dict]]:
        """Fetch posts for many threads concurrently."""
        from concurrent.futures import ThreadPoolExecutor, as_completed
        out: dict[str, list[dict]] = {}
        if not thread_ids:
            return out
        with ThreadPoolExecutor(max_workers=min(workers, max(1, len(thread_ids)))) as pool:
            futures = {pool.submit(self._client.get_thread_posts, tid): tid for tid in thread_ids}
            for fut in as_completed(futures):
                tid = futures[fut]
                try:
                    out[tid] = fut.result()
                except Exception as e:
                    log.warning("failed to load posts for %s: %s", tid, e)
                    out[tid] = []
        return out

    def get_thread(
        self,
        thread_id: str | None = None,
        url: str | None = None,
        author: str | None = None,
        contains: str | None = None,
        since_ms: int | None = None,
        until_ms: int | None = None,
    ) -> ThreadData | None:
        tid = thread_id or (_parse_thread_url(url) if url else None)
        if not tid:
            return None
        try:
            raw_posts = self._client.get_thread_posts(tid)
        except urllib.error.HTTPError:
            return None
        if not raw_posts:
            return None

        root = next((p for p in raw_posts if p["id"] == tid), raw_posts[0])
        ch_id = root.get("channel_id", "")
        uc = self._user_cache_for(p.get("user_id", "") for p in raw_posts)
        posts = [Post.from_api(p, uc) for p in raw_posts]

        # Apply in-thread filters
        posts = _filter_posts(
            posts, author=author, contains=contains,
            since_ms=since_ms, until_ms=until_ms,
        )
        posts.sort(key=lambda p: p.timestamp)

        return ThreadData(
            id=tid,
            channel_id=ch_id,
            channel_name=self._channel_name(ch_id) if ch_id else "",
            root_message=root.get("message", "") or "",
            reply_count=max(0, len(raw_posts) - 1),
            last_reply_at=max((p.timestamp for p in posts), default=0),
            has_mentions=any(p.is_mention for p in posts),
            participant_ids=sorted({p.user_id for p in posts if p.user_id}),
            posts=posts,
        )

    # ----- search -----

    def search(
        self,
        query: str,
        channels: list[str] | None = None,
        authors: list[str] | None = None,
        since_ms: int | None = None,
        until_ms: int | None = None,
        limit: int = 100,
        group_by_thread: bool = True,
        expand_context: int = 0,
    ) -> SearchResult:
        team_id = self._get_team_id()

        date_terms: list[str] = []
        if since_ms:
            d = datetime.fromtimestamp(since_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            date_terms.append(f"after:{d}")
        if until_ms:
            d = datetime.fromtimestamp(until_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            date_terms.append(f"before:{d}")

        cleaned_authors = [a.lstrip("@") for a in (authors or []) if a]
        base_terms = [query] if query else []

        # Verify that every requested author actually exists on the server.
        missing_authors: list[str] = []
        if cleaned_authors:
            for a in cleaned_authors:
                if not self._client.get_user_by_name(a):
                    missing_authors.append(a)

        # Build one "from:" per author; union across calls (logical OR).
        queries: list[str] = []
        if not cleaned_authors:
            queries.append(" ".join(base_terms + date_terms).strip())
        else:
            for a in cleaned_authors:
                queries.append(" ".join(base_terms + [f"from:{a}"] + date_terms).strip())

        raw_posts: list[dict] = []
        seen: set[str] = set()
        per_query_counts: dict[str, int] = {}
        for q in queries:
            log.info("search terms: %s", q)
            hits = self._client.search_posts(team_id, q, per_page=limit)
            per_query_counts[q] = len(hits)
            for p in hits:
                pid = p.get("id")
                if pid and pid not in seen:
                    seen.add(pid)
                    raw_posts.append(p)

        # Post-filter by channel (MM in: operator is sometimes flaky)
        channel_ids: set[str] | None = None
        channel_filter_ids: list[str] = []
        if channels:
            resolved = self.find_channels_by_name(channels) if not all(
                _looks_like_id(c) for c in channels
            ) else [self._channel_info(c) for c in channels]
            channel_ids = {c.id for c in resolved}
            channel_filter_ids = sorted(channel_ids)
            before_filter = len(raw_posts)
            raw_posts = [p for p in raw_posts if p.get("channel_id") in channel_ids]
            log.info("channel filter: %d -> %d posts", before_filter, len(raw_posts))

        # Bulk-prefetch users and channels referenced by the hits.
        self._prefetch_channels(p.get("channel_id", "") for p in raw_posts)
        uc = self._user_cache_for(p.get("user_id", "") for p in raw_posts)
        posts = [Post.from_api(p, uc) for p in raw_posts]

        diagnostics = _build_search_diagnostics(
            queries=queries,
            per_query_counts=per_query_counts,
            missing_authors=missing_authors,
            channel_filter_ids=channel_filter_ids,
            channel_filter_names=channels or [],
            since_ms=since_ms,
            until_ms=until_ms,
            result_posts=len(posts),
            result_raw=sum(per_query_counts.values()),
        )

        if not group_by_thread:
            return SearchResult(query=query, posts=posts, total_count=len(posts),
                                diagnostics=diagnostics)

        # Group by root_id (or self id if root)
        buckets: dict[str, list[Post]] = {}
        for p in posts:
            key = p.root_id or p.id
            buckets.setdefault(key, []).append(p)

        threads: list[ThreadData] = []
        for root_id, group in buckets.items():
            group.sort(key=lambda p: p.timestamp)
            first = group[0]
            threads.append(ThreadData(
                id=root_id,
                channel_id=first.channel_id,
                channel_name=self._channel_name(first.channel_id) if first.channel_id else "",
                root_message=first.text,
                reply_count=max(0, len(group) - 1),
                last_reply_at=group[-1].timestamp,
                has_mentions=any(p.is_mention for p in group),
                participant_ids=sorted({p.user_id for p in group if p.user_id}),
                posts=group,
            ))
        threads.sort(key=lambda t: t.last_reply_at, reverse=True)

        if expand_context > 0 and threads:
            self._expand_thread_context(threads, expand_context)

        return SearchResult(
            query=query, threads=threads, posts=posts, total_count=len(threads),
            diagnostics=diagnostics,
        )

    def _expand_thread_context(self, threads: list[ThreadData], n: int) -> None:
        """For each thread, replace `posts` with hits + N neighbors around each hit.

        Fetches full thread posts in parallel. If the thread has no hits found yet,
        we keep the original posts as the baseline hit set.
        """
        thread_ids = [t.id for t in threads]
        full = self._parallel_thread_posts(thread_ids)
        for t in threads:
            raw_full = full.get(t.id, [])
            if not raw_full:
                continue
            uc = self._user_cache_for(p.get("user_id", "") for p in raw_full)
            all_posts = [Post.from_api(p, uc) for p in raw_full]
            all_posts.sort(key=lambda p: p.timestamp)

            # Hit IDs from the search's thread grouping.
            hit_ids = {p.id for p in t.posts}
            hit_indices = [i for i, p in enumerate(all_posts) if p.id in hit_ids]
            if not hit_indices:
                continue

            keep: set[int] = set()
            for i in hit_indices:
                for j in range(max(0, i - n), min(len(all_posts), i + n + 1)):
                    keep.add(j)
            new_posts = [all_posts[i] for i in sorted(keep)]
            # Mark hits so the renderer/agent can distinguish.
            for p in new_posts:
                if p.id in hit_ids:
                    # No additional attribute on Post — context posts just have empty role
                    pass
            t.posts = new_posts
            t.reply_count = max(0, len(all_posts) - 1)
            t.last_reply_at = all_posts[-1].timestamp
            t.has_mentions = any(p.is_mention for p in new_posts)

    # ----- mutating -----

    def reply(self, url: str, message: str) -> Post | None:
        tid = _parse_thread_url(url)
        if not tid:
            return None
        # Need channel_id for the root post
        try:
            root = self._client.get_thread_posts(tid)
        except urllib.error.HTTPError:
            return None
        if not root:
            return None
        channel_id = root[0].get("channel_id", "")
        raw = self._client.create_post(channel_id, message, root_id=tid)
        uc = {raw.get("user_id", ""): self._client.get_username(raw.get("user_id", ""))}
        return Post.from_api(raw, uc)


# =========================================================================
# Filters & utils
# =========================================================================

_ID_RE = re.compile(r"^[a-z0-9]{26}$")


def _looks_like_id(s: str) -> bool:
    return bool(_ID_RE.match(s or ""))


def _parse_thread_url(url: str | None) -> str | None:
    if not url:
        return None
    m = re.search(r"/thread/([a-z0-9]{20,})", url)
    if m:
        return m.group(1)
    m = re.search(r"/pl/([a-z0-9]{20,})", url)
    if m:
        return m.group(1)
    m = re.search(r"/posts/([a-z0-9]{20,})", url)
    return m.group(1) if m else None


def _filter_posts(
    posts: list[Post],
    author: str | None = None,
    contains: str | None = None,
    since_ms: int | None = None,
    until_ms: int | None = None,
) -> list[Post]:
    authors = [a.strip().lstrip("@").lower() for a in (author or "").split(",") if a.strip()]
    needle = contains.lower() if contains else None
    out: list[Post] = []
    for p in posts:
        if authors and p.author.lower() not in authors:
            continue
        if needle and needle not in p.text.lower():
            continue
        if since_ms and p.timestamp < since_ms:
            continue
        if until_ms and p.timestamp > until_ms:
            continue
        out.append(p)
    return out


def _build_search_diagnostics(
    queries: list[str],
    per_query_counts: dict[str, int],
    missing_authors: list[str],
    channel_filter_ids: list[str],
    channel_filter_names: list[str],
    since_ms: int | None,
    until_ms: int | None,
    result_posts: int,
    result_raw: int,
) -> dict:
    """Assemble diagnostics dict so the agent can understand zero/partial results."""
    def iso(ms: int | None) -> str:
        if not ms:
            return ""
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()

    hints: list[str] = []
    if result_posts == 0:
        if missing_authors:
            hints.append(
                f"Author(s) not found on server: {', '.join(missing_authors)}. "
                "Try `resolve --people \"<display name>\"` to find correct username."
            )
        if channel_filter_names and result_raw > 0 and result_posts == 0:
            hints.append(
                "All raw hits were filtered out by --channel. "
                "Author may not post in the specified channel(s), or channel name is wrong."
            )
        if since_ms and (time.time() * 1000 - since_ms) < 2 * 24 * 3600 * 1000:
            hints.append("Narrow time window (<2d); try expanding --since.")
        if result_raw == 0 and not missing_authors:
            hints.append(
                "MM returned no posts for any sub-query. "
                "User may have no visible posts in channels you can access, "
                "or the search term is too specific."
            )
    return {
        "queries_sent": queries,
        "per_query_hits": per_query_counts,
        "missing_authors": missing_authors,
        "channel_filter_ids": channel_filter_ids,
        "channel_filter_names": channel_filter_names,
        "since_utc": iso(since_ms),
        "until_utc": iso(until_ms),
        "raw_hits": result_raw,
        "after_filters": result_posts,
        "hints": hints,
    }


_REL_RE = re.compile(r"^(\d+)([dhm])$")


def _tz_from_name(name: str | None) -> timezone:
    if not name:
        return timezone.utc
    # stdlib zoneinfo for IANA names
    try:
        from zoneinfo import ZoneInfo  # py3.9+
        return ZoneInfo(name)  # type: ignore[return-value]
    except Exception:
        return timezone.utc


def parse_date(value: str | None, end_of_day: bool = False, tz: str | None = None) -> int | None:
    """Parse date/time → epoch ms. Accepts:
        None / ""            -> None
        '7d' / '24h' / '30m' -> now - delta
        'YYYY-MM-DD'         -> midnight in `tz` (or 23:59:59 if end_of_day)
        'YYYY-MM-DDTHH:MM'   -> exact, in `tz` if no explicit offset
    """
    if not value:
        return None
    s = value.strip()
    m = _REL_RE.match(s)
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        delta = {
            "d": timedelta(days=n),
            "h": timedelta(hours=n),
            "m": timedelta(minutes=n),
        }[unit]
        return int((datetime.now(tz=timezone.utc) - delta).timestamp() * 1000)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        raise ValueError(f"Cannot parse date: {value!r} (use 7d, 24h, YYYY-MM-DD, or ISO)")
    tzinfo = _tz_from_name(tz)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tzinfo)
    if end_of_day and len(s) == 10:  # bare date, same-day end
        dt = dt.replace(hour=23, minute=59, second=59)
    return int(dt.timestamp() * 1000)


def _split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [x.strip() for x in value.split(",") if x.strip()]


# =========================================================================
# Formatting
# =========================================================================

def _to_jsonable(obj: Any) -> Any:
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    if isinstance(obj, list):
        return [_to_jsonable(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _to_jsonable(v) for k, v in obj.items()}
    return obj


def print_json(obj: Any) -> None:
    print(json.dumps(_to_jsonable(obj), ensure_ascii=False, indent=2))


def _fmt_time(ts_ms: int) -> str:
    if not ts_ms:
        return "--"
    return datetime.fromtimestamp(ts_ms / 1000).strftime("%d.%m %H:%M")


def _fmt_channel_type(t: str) -> str:
    return {"O": "public", "P": "private", "D": "DM", "G": "group"}.get(t, t)


def print_channels(channels: list[ChannelInfo]) -> None:
    if not channels:
        print("No channels found")
        return
    print(f"{len(channels)} channels:")
    for ch in channels:
        name = ch.display_name or ch.name
        print(f"  [{_fmt_channel_type(ch.type):>7}] {name}  ({ch.name})  id={ch.id}")


def print_threads(threads: list[ThreadData], show_posts: bool = False) -> None:
    if not threads:
        print("No threads found")
        return
    print(f"{len(threads)} threads:")
    for t in threads:
        tag = "!" if t.has_mentions else " "
        print(f"  {tag} [{_fmt_time(t.last_message_time())}] {t.channel_name}  "
              f"({t.reply_count + 1} msgs)  id={t.id}")
        root = t.root_message.replace("\n", " ")[:120]
        print(f"      {root}")
        if show_posts and t.posts:
            for p in t.posts[-5:]:
                text = p.text.replace("\n", " ")[:100]
                mark = "@" if p.is_mention else " "
                print(f"        {mark} [{_fmt_time(p.timestamp)}] {p.author}: {text}")


def print_posts(posts: list[Post]) -> None:
    if not posts:
        print("No posts found")
        return
    print(f"{len(posts)} posts:")
    for p in posts:
        text = p.text.replace("\n", " ")[:160]
        mark = "@" if p.is_mention else " "
        print(f"  {mark} [{_fmt_time(p.timestamp)}] {p.author}: {text}  id={p.id}")


def print_thread(t: ThreadData) -> None:
    print(f"Thread {t.id}")
    print(f"Channel: {t.channel_name}  (id={t.channel_id})")
    print(f"Messages: {len(t.posts)}  Replies: {t.reply_count}")
    print(f"Participants: {len(t.participant_ids)}")
    print("-" * 60)
    for p in t.posts:
        text = p.text
        mark = "@" if p.is_mention else " "
        print(f"{mark} [{_fmt_time(p.timestamp)}] {p.author}:")
        for line in text.splitlines() or [""]:
            print(f"    {line}")
        print()


def print_search(result: SearchResult, show_posts: bool = True) -> None:
    print(f"Query: {result.query!r}  —  {result.total_count} hits")
    if result.threads:
        print_threads(result.threads, show_posts=show_posts)
    elif result.posts:
        print_posts(result.posts)


# --- Markdown (LLM-friendly) ---

def print_threads_md(threads: list[ThreadData], show_posts: bool = True) -> None:
    if not threads:
        print("_No threads._")
        return
    for t in threads:
        tag = " **(!mention)**" if t.has_mentions else ""
        header_time = _fmt_time(t.last_message_time())
        print(f"### [{t.channel_name}] {header_time}{tag}")
        if t.url:
            print(f"<{t.url}>")
        root = t.root_message.replace("\n", " ").strip()
        if root:
            print(f"> {root[:400]}")
        if show_posts and t.posts:
            print()
            for p in t.posts:
                text = p.text.strip().replace("\n", " ")[:500]
                print(f"- **{p.author}** ({_fmt_time(p.timestamp)}): {text}")
        print()


def print_posts_md(posts: list[Post]) -> None:
    if not posts:
        print("_No posts._")
        return
    for p in posts:
        text = p.text.strip().replace("\n", " ")[:500]
        link = f"  <{p.permalink}>" if p.permalink else ""
        print(f"- **{p.author}** ({_fmt_time(p.timestamp)}): {text}{link}")


def print_search_md(result: SearchResult, show_posts: bool = True) -> None:
    print(f"# Search: `{result.query}` — {result.total_count} hits\n")
    if result.threads:
        print_threads_md(result.threads, show_posts=show_posts)
    elif result.posts:
        print_posts_md(result.posts)


def print_thread_md(t: ThreadData) -> None:
    print(f"# [{t.channel_name}] thread")
    if t.url:
        print(f"<{t.url}>\n")
    print(f"**{len(t.posts)} messages**, {len(t.participant_ids)} participants\n")
    for p in t.posts:
        text = p.text.strip()
        mark = " **(@)**" if p.is_mention else ""
        print(f"### {p.author} ({_fmt_time(p.timestamp)}){mark}")
        for line in text.splitlines() or [""]:
            print(f"> {line}")
        print()


# =========================================================================
# CLI
# =========================================================================

def _load_dotenv(paths: list[Path] | None = None) -> None:
    """Minimal .env loader: KEY=VALUE lines, no quotes handling. Existing env wins.

    Scans, in order: current working directory, directory of this script, $HOME/.env.
    First value for a key wins; already-set env vars are never overwritten.
    """
    if paths is None:
        here = Path(__file__).resolve().parent
        paths = [Path.cwd() / ".env", here / ".env", Path.home() / ".env"]
    seen: set[str] = set()
    for path in paths:
        try:
            if not path.exists() or str(path) in seen:
                continue
        except OSError:
            continue
        seen.add(str(path))
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


def _env(key: str, args_val: str | None) -> str:
    if args_val:
        return args_val
    return os.environ.get(key, "")


_active_readers: list[TimeReader] = []


def _make_reader(args: argparse.Namespace) -> TimeReader:
    global _BASE_URL_FOR_LINKS
    url = _env("MM_URL", getattr(args, "base_url", None)) or "https://time.tbank.ru"
    token = _env("MM_TOKEN", getattr(args, "token", None))
    csrf = _env("MM_CSRF", getattr(args, "csrf", None))
    if not token:
        print("Error: MM_TOKEN required (env, .env, or --token)", file=sys.stderr)
        sys.exit(2)
    _BASE_URL_FOR_LINKS = url.rstrip("/")
    use_cache = not getattr(args, "no_cache", False)
    client = TimeClient(url, token, csrf_token=csrf, delay=args.delay, use_disk_cache=use_cache)
    team_id = _env("MM_TEAM_ID", getattr(args, "team_id", None)) or None
    reader = TimeReader(client, team_id=team_id, use_disk_cache=use_cache)
    _active_readers.append(reader)
    return reader


def _date(args: argparse.Namespace, value: str | None, end_of_day: bool = False) -> int | None:
    return parse_date(value, end_of_day=end_of_day, tz=getattr(args, "tz", None))


def _add_common(sp: argparse.ArgumentParser) -> None:
    sp.add_argument("--json", dest="as_json", action="store_true",
                    help="emit machine-readable JSON")
    sp.add_argument("--base-url", dest="base_url",
                    help="Mattermost base URL (or MM_URL env)")
    sp.add_argument("--token", help="auth token (or MM_TOKEN env)")
    sp.add_argument("--csrf", help="CSRF token for cookie auth (or MM_CSRF env)")
    sp.add_argument("--team-id", help="team ID (or MM_TEAM_ID env)")
    sp.add_argument("--delay", type=float, default=0.1,
                    help="delay between API requests (default 0.1s)")
    sp.add_argument("--tz", help="IANA timezone for --since/--until (default UTC), e.g. Europe/Moscow")
    sp.add_argument("--no-cache", dest="no_cache", action="store_true",
                    help="disable disk cache for users/channels")
    sp.add_argument("--format", dest="fmt", choices=["text", "md"],
                    help="text output format when --json is not set (default: text)")
    sp.add_argument("--debug", action="store_true", help="verbose logging")


# ----- command handlers -----

def cmd_channels(args: argparse.Namespace) -> int:
    r = _make_reader(args)
    chans = r.list_channels(
        pattern=args.pattern,
        channel_type=args.type,
        limit=args.limit,
        max_pages=args.max_pages,
    )
    if args.as_json:
        print_json(chans)
    else:
        print_channels(chans)
    return 0


def cmd_dms(args: argparse.Namespace) -> int:
    r = _make_reader(args)
    chans = r.list_dms(
        with_username=args.with_user,
        limit=args.limit,
        max_pages=args.max_pages,
    )
    if args.as_json:
        print_json(chans)
    else:
        print_channels(chans)
    return 0


def cmd_threads(args: argparse.Namespace) -> int:
    r = _make_reader(args)
    threads = r.list_threads(
        channels=_split_csv(args.channel) or None,
        only_mentions=args.mentions,
        since_ms=_date(args, args.since),
        until_ms=_date(args, args.until, end_of_day=True),
        min_messages=args.min_messages,
        max_messages=args.max_messages,
        limit=args.limit,
        with_posts=args.with_posts or args.mentions,
        participants=_split_csv(getattr(args, "include_participant", None)) or None,
    )
    if args.as_json:
        print_json(threads)
    elif getattr(args, "fmt", None) == "md":
        print_threads_md(threads, show_posts=args.with_posts)
    else:
        print_threads(threads, show_posts=args.with_posts)
    return 0


def cmd_posts(args: argparse.Namespace) -> int:
    r = _make_reader(args)
    posts = r.get_channel_posts(
        channel=args.channel,
        since_ms=_date(args, args.since),
        until_ms=_date(args, args.until, end_of_day=True),
        author=args.author,
        contains=args.contains,
        limit=args.limit,
    )
    if args.as_json:
        print_json(posts)
    elif getattr(args, "fmt", None) == "md":
        print_posts_md(posts)
    else:
        print_posts(posts)
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    r = _make_reader(args)
    result = r.search(
        query=args.query,
        channels=_split_csv(args.channel) or None,
        authors=_split_csv(args.author) or None,
        since_ms=_date(args, args.since),
        until_ms=_date(args, args.until, end_of_day=True),
        limit=args.limit,
        group_by_thread=not args.flat,
        expand_context=args.expand,
    )
    if args.as_json:
        print_json(result)
    elif getattr(args, "fmt", None) == "md":
        print_search_md(result, show_posts=not args.flat)
    else:
        print_search(result, show_posts=not args.flat)
    return 0


def cmd_thread(args: argparse.Namespace) -> int:
    r = _make_reader(args)
    t = r.get_thread(
        thread_id=args.id,
        url=args.url_target,
        author=args.author,
        contains=args.contains,
        since_ms=_date(args, args.since),
        until_ms=_date(args, args.until, end_of_day=True),
    )
    if t is None:
        print("Thread not found", file=sys.stderr)
        return 1
    if args.as_json:
        print_json(t)
    elif getattr(args, "fmt", None) == "md":
        print_thread_md(t)
    else:
        print_thread(t)
    return 0


def cmd_reply(args: argparse.Namespace) -> int:
    r = _make_reader(args)
    msg = args.message
    if msg == "-" or not msg:
        msg = sys.stdin.read().strip()
    if not msg:
        print("Error: empty message", file=sys.stderr)
        return 2

    if args.dry_run:
        # Show what WOULD be sent without actually sending.
        t = r.get_thread(url=args.url_target)
        if t is None:
            print("Thread not found", file=sys.stderr)
            return 1
        preview = {
            "dry_run": True,
            "channel_id": t.channel_id,
            "channel_name": t.channel_name,
            "thread_id": t.id,
            "thread_url": t.url,
            "message": msg,
            "message_bytes": len(msg.encode()),
        }
        if args.as_json:
            print_json(preview)
        else:
            print(f"[DRY-RUN] would reply to [{t.channel_name}] thread {t.id}")
            print(f"  url:  {t.url}")
            print(f"  text: {msg}")
        return 0

    p = r.reply(url=args.url_target, message=msg)
    if p is None:
        print("Thread not found", file=sys.stderr)
        return 1
    if args.as_json:
        print_json(p)
    else:
        print(f"Sent. id={p.id} at {p.create_at}")
    return 0


def cmd_posts_by_user(args: argparse.Namespace) -> int:
    """Thin wrapper around `search` that builds from:USER automatically."""
    r = _make_reader(args)
    usernames = [u.lstrip("@") for u in _split_csv(args.user)]
    if not usernames:
        print("Error: --user required", file=sys.stderr)
        return 2
    result = r.search(
        query="",
        channels=_split_csv(args.channel) or None,
        authors=usernames,
        since_ms=_date(args, args.since),
        until_ms=_date(args, args.until, end_of_day=True),
        limit=args.limit,
        group_by_thread=not args.flat,
        expand_context=args.expand,
    )
    if args.as_json:
        print_json(result)
    elif getattr(args, "fmt", None) == "md":
        print_search_md(result, show_posts=not args.flat)
    else:
        print_search(result, show_posts=not args.flat)
    return 0


def cmd_user(args: argparse.Namespace) -> int:
    """User profile: identity, last N posts, top channels, thread participation."""
    r = _make_reader(args)
    username = args.username.lstrip("@")
    raw_user = r._client.get_user_by_name(username)
    if not raw_user:
        print(f"User @{username} not found", file=sys.stderr)
        return 1

    since = _date(args, args.since) or _date(args, "30d")
    until = _date(args, args.until, end_of_day=True)
    result = r.search(
        query="",
        authors=[username],
        since_ms=since,
        until_ms=until,
        limit=args.limit,
        group_by_thread=True,
    )

    # Stats by channel
    from collections import Counter
    by_channel: Counter = Counter()
    for t in result.threads:
        own = [p for p in t.posts if p.user_id == raw_user["id"]]
        if own:
            by_channel[t.channel_name] += len(own)

    profile = {
        "username": raw_user.get("username", ""),
        "user_id": raw_user["id"],
        "display_name": f"{raw_user.get('first_name','')} {raw_user.get('last_name','')}".strip(),
        "email": raw_user.get("email", ""),
        "position": raw_user.get("position", ""),
        "since_ms": since,
        "until_ms": until,
        "total_threads": result.total_count,
        "total_posts": sum(len([p for p in t.posts if p.user_id == raw_user["id"]]) for t in result.threads),
        "by_channel": [{"channel": ch, "posts": n} for ch, n in by_channel.most_common()],
        "threads": [t.to_dict() for t in result.threads],
    }
    if args.as_json:
        print_json(profile)
    else:
        print(f"@{profile['username']}  ({profile['display_name']})")
        if profile["position"]:
            print(f"  position: {profile['position']}")
        print(f"  threads: {profile['total_threads']}  posts: {profile['total_posts']}")
        print("  by channel:")
        for row in profile["by_channel"]:
            print(f"    {row['posts']:3d}  {row['channel']}")
    return 0


def _user_summary(u: dict) -> dict:
    return {
        "id": u["id"],
        "username": u.get("username", ""),
        "display_name": f"{u.get('first_name','')} {u.get('last_name','')}".strip(),
        "email": u.get("email", ""),
        "position": u.get("position", ""),
        "nickname": u.get("nickname", ""),
    }


def cmd_resolve(args: argparse.Namespace) -> int:
    r = _make_reader(args)
    out: dict[str, Any] = {}

    if args.users:
        users = {}
        for name in _split_csv(args.users):
            clean = name.lstrip("@")
            u = r._client.get_user_by_name(clean)
            if u:
                users[name] = _user_summary(u)
            else:
                # Fuzzy fallback: suggest similar names.
                suggestions = r._client.search_users(clean, limit=5)
                users[name] = {
                    "match": None,
                    "suggestions": [_user_summary(s) for s in suggestions],
                }
        out["users"] = users

    if args.people:
        # Fuzzy lookup by display name, email, nickname, or partial username.
        people = {}
        for term in _split_csv(args.people):
            matches = r._client.search_users(term, limit=10)
            people[term] = [_user_summary(m) for m in matches]
        out["people"] = people

    if args.channels:
        chans = {}
        for name in _split_csv(args.channels):
            info = r._resolve_channel(name)
            chans[name] = info.to_dict() if info else None
        out["channels"] = chans

    if not out:
        print("Error: pass --users, --people, or --channels", file=sys.stderr)
        return 2
    print_json(out)
    return 0


# ----- argparse wiring -----

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="time_cli",
        description="Agent-friendly CLI for Tinkoff Time (Mattermost): "
                    "read channels, threads, DMs, search messages, reply.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="command", metavar="COMMAND")

    # channels
    sp = sub.add_parser("channels", help="list channels")
    sp.add_argument("--pattern", help="substring match on name/display_name")
    sp.add_argument("--type", choices=["O", "P", "D", "G"], help="filter by channel type")
    sp.add_argument("--limit", type=int, default=50,
                    help="stop after N matches (default 50)")
    sp.add_argument("--max-pages", type=int, default=10,
                    help="cap API pagination (100 chans/page, default 10)")
    _add_common(sp)
    sp.set_defaults(func=cmd_channels)

    # dms
    sp = sub.add_parser("dms", help="list direct and group messages")
    sp.add_argument("--with", dest="with_user", help="counterpart username substring")
    sp.add_argument("--limit", type=int, default=50,
                    help="stop after N matches (default 50)")
    sp.add_argument("--max-pages", type=int, default=10,
                    help="cap API pagination (default 10)")
    _add_common(sp)
    sp.set_defaults(func=cmd_dms)

    # threads
    sp = sub.add_parser("threads", help="list followed threads")
    sp.add_argument("--channel", help="channel name(s), comma-separated")
    sp.add_argument("--mentions", action="store_true", help="only threads with mentions")
    sp.add_argument("--since", help="lower bound (YYYY-MM-DD, 7d, 24h)")
    sp.add_argument("--until", help="upper bound")
    sp.add_argument("--min-messages", type=int, help="min message count (root+replies)")
    sp.add_argument("--max-messages", type=int, help="max message count")
    sp.add_argument("--limit", type=int, default=50)
    sp.add_argument("--with-posts", action="store_true", help="fetch posts for each thread (slow)")
    sp.add_argument("--include-participant", dest="include_participant",
                    help="keep only threads where user(s) participate (comma-separated)")
    _add_common(sp)
    sp.set_defaults(func=cmd_threads)

    # posts
    sp = sub.add_parser("posts", help="messages from a channel")
    sp.add_argument("--channel", required=True, help="channel ID or name substring")
    sp.add_argument("--since", help="lower bound (YYYY-MM-DD, 7d, 24h)")
    sp.add_argument("--until", help="upper bound")
    sp.add_argument("--author", help="filter by author username (comma-separated)")
    sp.add_argument("--contains", help="substring match on post text")
    sp.add_argument("--limit", type=int, default=100)
    _add_common(sp)
    sp.set_defaults(func=cmd_posts)

    # search
    sp = sub.add_parser("search", help="full-text search across team")
    sp.add_argument("query", help="search query (MM search syntax supported)")
    sp.add_argument("--channel", help="restrict to channels (name/id, comma-separated)")
    sp.add_argument("--author", help="restrict to authors (username, comma-separated)")
    sp.add_argument("--since", help="lower bound date")
    sp.add_argument("--until", help="upper bound date")
    sp.add_argument("--limit", type=int, default=100)
    sp.add_argument("--flat", action="store_true",
                    help="emit flat post list instead of grouped threads")
    sp.add_argument("--expand", type=int, default=0, metavar="N",
                    help="include N neighboring posts around each hit in its thread")
    _add_common(sp)
    sp.set_defaults(func=cmd_search)

    # thread
    sp = sub.add_parser("thread", help="show a single thread")
    g = sp.add_mutually_exclusive_group(required=True)
    g.add_argument("--id", help="thread (root post) ID")
    g.add_argument("--url", dest="url_target", help="thread URL")
    sp.add_argument("--author", help="filter posts by author")
    sp.add_argument("--contains", help="filter posts by substring")
    sp.add_argument("--since", help="lower bound date")
    sp.add_argument("--until", help="upper bound date")
    _add_common(sp)
    sp.set_defaults(func=cmd_thread)

    # reply
    sp = sub.add_parser("reply", help="post a reply to a thread")
    sp.add_argument("--url", dest="url_target", required=True, help="thread URL")
    sp.add_argument("--message", "-m", default="-",
                    help="message text (use '-' or omit to read from stdin)")
    sp.add_argument("--dry-run", dest="dry_run", action="store_true",
                    help="preview what would be sent without posting")
    _add_common(sp)
    sp.set_defaults(func=cmd_reply)

    # resolve
    sp = sub.add_parser("resolve", help="resolve usernames/channel names to IDs; fuzzy search by display name")
    sp.add_argument("--users", help="exact usernames (comma-separated); suggestions on miss")
    sp.add_argument("--people", help="fuzzy search by display name/email/nickname (comma-separated terms)")
    sp.add_argument("--channels", help="channel names (comma-separated)")
    _add_common(sp)
    sp.set_defaults(func=cmd_resolve)

    # posts-by-user
    sp = sub.add_parser("posts-by-user", help="all posts from one or more users")
    sp.add_argument("--user", required=True, help="username(s), comma-separated (@ optional)")
    sp.add_argument("--channel", help="restrict to channels (comma-separated)")
    sp.add_argument("--since", help="lower bound date")
    sp.add_argument("--until", help="upper bound date")
    sp.add_argument("--limit", type=int, default=100)
    sp.add_argument("--flat", action="store_true",
                    help="flat post list instead of thread grouping")
    sp.add_argument("--expand", type=int, default=0, metavar="N",
                    help="include N neighboring posts around each hit in its thread")
    _add_common(sp)
    sp.set_defaults(func=cmd_posts_by_user)

    # user
    sp = sub.add_parser("user", help="user profile with activity summary")
    sp.add_argument("username", help="username (@ optional)")
    sp.add_argument("--since", help="window start (default 30d)")
    sp.add_argument("--until", help="window end")
    sp.add_argument("--limit", type=int, default=200, help="max threads to scan")
    _add_common(sp)
    sp.set_defaults(func=cmd_user)

    return p


def main(argv: list[str] | None = None) -> int:
    _load_dotenv()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 1

    logging.basicConfig(
        level=logging.DEBUG if getattr(args, "debug", False) else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        return args.func(args)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
    finally:
        for r in _active_readers:
            try:
                r.flush_cache()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
