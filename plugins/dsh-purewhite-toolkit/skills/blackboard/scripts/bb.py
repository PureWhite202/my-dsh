"""Blackboard helper: read login state, navigate, or close an already-running Chromium.

Precondition: a Chromium started with --remote-debugging-port=9222 and the
persistent profile (see scripts/open-blackboard.cmd).

Usage:
  python bb.py status [--shot PATH]
  python bb.py goto URL [--wait 5] [--shot PATH] [--dump 4000]
  python bb.py pages
  python bb.py close

Output is a single JSON document on stdout. Exit codes:
  0 ok, 2 browser/CDP unreachable, 3 navigation failed.
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

DEFAULT_CDP = "http://127.0.0.1:9222"

LOGIN_URL_HINTS = (
    "login.microsoftonline",
    "login.live.com",
    "/adfs",
    "adfs/",
    "okta",
    "/sso",
    "signin",
    "/login",
)
CODE_TEXT_HINTS = (
    "enter code",
    "verification code",
    "verify your identity",
    "approve sign-in",
    "approve sign in",
    "authenticator",
    "two-step",
    "multi-factor",
)
SIGNIN_TEXT_HINTS = (
    "sign in",
    "sign-in",
    "we couldn't sign you in",
    "incorrect password",
    "enter your password",
)
LOGGED_IN_HOSTS = ("blackboard.soton.ac.uk", "panopto.eu")


def classify(url, title, text):
    """Return one of: login_required, code_required, loading, logged_in, unknown."""
    low_url = (url or "").lower()
    low = ((title or "") + "\n" + (text or "")).lower()
    if any(h in low for h in CODE_TEXT_HINTS):
        return "code_required"
    if any(h in low_url for h in LOGIN_URL_HINTS):
        return "login_required"
    if any(h in low for h in SIGNIN_TEXT_HINTS) and "blackboard" not in low_url:
        return "login_required"
    if not (text or "").strip() and not (title or "").strip():
        return "loading"
    if any(h in low_url for h in LOGGED_IN_HOSTS):
        return "logged_in"
    return "unknown"


def describe(page):
    info = {"url": page.url, "title": "", "text": ""}
    try:
        info["title"] = page.title()
    except Exception as exc:  # navigation in flight
        info["title_error"] = repr(exc)
    try:
        info["text"] = page.inner_text("body")
    except Exception as exc:
        info["text_error"] = repr(exc)
    info["state"] = classify(info["url"], info["title"], info["text"])
    return info


def wait_for_content(page, seconds):
    """Poll until the single-page app has rendered some body text."""
    deadline = time.time() + max(seconds, 0)
    while True:
        try:
            if len((page.inner_text("body") or "").strip()) > 20:
                return True
        except Exception:
            pass
        if time.time() >= deadline:
            return False
        page.wait_for_timeout(500)


def close_browser(endpoint):
    """Ask the browser to quit through the CDP browser-target WebSocket.

    Playwright's browser.close() only disconnects from an external browser, so
    the process keeps running; Browser.close is what actually terminates it.
    """
    try:
        import websocket  # websocket-client, optional
    except ImportError as exc:
        return False, f"websocket-client missing: {exc!r}"
    try:
        with urllib.request.urlopen(endpoint + "/json/version", timeout=5) as resp:
            version = json.loads(resp.read().decode("utf-8"))
        ws = websocket.create_connection(
            version["webSocketDebuggerUrl"], timeout=5, suppress_origin=True
        )
        ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
        try:
            ws.recv()
        except Exception:
            pass
        ws.close()
    except Exception as exc:
        return False, repr(exc)
    for _ in range(20):
        time.sleep(0.5)
        try:
            urllib.request.urlopen(endpoint + "/json/version", timeout=1)
        except Exception:
            return True, ""
    return False, "browser still answering after Browser.close"


def grab_screenshot(page, path):
    """Screenshot with a CDP fallback; returns an error string or None.

    Ultra 的前端偶尔让 Playwright 的字体等待卡到 30 秒超时，这时改用
    Page.captureScreenshot（同一路 CDP，不经过字体等待）仍然能出图。
    """
    try:
        page.screenshot(path=path, full_page=False)
        return None
    except Exception as first:
        try:
            session = page.context.new_cdp_session(page)
            payload = session.send("Page.captureScreenshot", {"format": "png"})
            with open(path, "wb") as handle:
                handle.write(base64.b64decode(payload["data"]))
            session.detach()
            return None
        except Exception as second:
            return f"playwright: {first!r}; cdp: {second!r}"


def select_page(pages, index=None):
    """Pick the page to drive: explicit index, else the last Blackboard tab."""
    if index is not None:
        return pages[index]
    preferred = [pg for pg in pages if "blackboard.soton.ac.uk" in (pg.url or "")]
    return preferred[-1] if preferred else pages[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["status", "goto", "pages", "close"])
    ap.add_argument("url", nargs="?", default="https://blackboard.soton.ac.uk/ultra/course")
    ap.add_argument("--port", default="9222")
    ap.add_argument("--page-index", type=int, default=None, help="tab index from the pages command")
    ap.add_argument("--wait", type=float, default=3.0, help="extra seconds to settle after content appears")
    ap.add_argument("--load-timeout", type=float, default=25.0, help="max seconds to wait for rendered content")
    ap.add_argument("--shot", default="", help="save a PNG screenshot to this path")
    ap.add_argument("--dump", type=int, default=3000, help="max characters of body text to return")
    args = ap.parse_args()

    endpoint = f"http://127.0.0.1:{args.port}"
    result = {"ok": False, "endpoint": endpoint, "command": args.command}

    try:
        if args.command == "close":
            closed, detail = close_browser(endpoint)
            result.update(ok=closed, closed=closed)
            if detail:
                result["error"] = detail
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if closed else 2

        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(endpoint, timeout=15000)

            contexts = browser.contexts
            result["contexts"] = len(contexts)
            pages = contexts[0].pages if contexts else []
            result["page_count"] = len(pages)

            if args.command == "pages":
                result.update(ok=True, pages=[{"url": pg.url, "title": _safe_title(pg)} for pg in pages])
            else:
                if not pages:
                    result["error"] = "CDP connected but there is no open page"
                    print(json.dumps(result, ensure_ascii=False, indent=2))
                    return 3
                page = select_page(pages, args.page_index)
                result["chosen_page"] = {"index": pages.index(page), "url": page.url}
                if args.command == "goto":
                    try:
                        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
                    except Exception as exc:
                        result["error"] = f"navigation failed: {exc!r}"
                        print(json.dumps(result, ensure_ascii=False, indent=2))
                        return 3
                reached = wait_for_content(page, args.load_timeout)
                page.wait_for_timeout(int(args.wait * 1000))
                info = describe(page)
                info["text"] = info.get("text", "")[: args.dump]
                info["content_ready"] = reached
                result.update(ok=True, page=info)

                if args.shot:
                    shot_error = grab_screenshot(page, args.shot)
                    if shot_error is None:
                        result["screenshot"] = args.shot
                    else:
                        # 截图失败不该把已经拿到的正文丢掉：记一条错误继续返回。
                        result["screenshot_error"] = shot_error
    except Exception as exc:
        result["error"] = repr(exc)
        detail = repr(exc)
        if "ECONNREFUSED" in detail or "connect_over_cdp" in detail:
            result["hint"] = (
                "Chromium 没有在 9222 端口监听：先运行本目录的 open-blackboard.cmd（"
                + os.path.join(os.path.dirname(os.path.abspath(__file__)), "open-blackboard.cmd")
                + "）"
            )
        else:
            result["hint"] = "浏览器在跑，但这一步失败：按技能第十节的排错表处理，必要时加 --shot 看画面。"
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _safe_title(page):
    try:
        return page.title()
    except Exception:
        return ""


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
