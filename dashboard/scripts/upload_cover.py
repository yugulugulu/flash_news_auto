#!/usr/bin/env python3
"""Upload an external image URL to ChainThink COS via admin/upload_file.

Workflow:
1) Download image bytes
2) Compute a numeric-ish hash (uint64 from sha1)
3) Call /ccs/v1/admin/upload_file with use_pre_sign_url=true to get a presigned PUT URL
4) PUT the bytes to the presigned URL
5) Call /ccs/v1/admin/upload_file with confirm=true to get confirm_url (cos.chainthink.cn)

Outputs a single line: confirm_url

Security:
- Reads x-token and x-user-id from env
- Does not print tokens or presigned URL
"""

import hashlib  # stdlib; kept for future use
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request


def die(msg: str, code: int = 2):
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def http_json(url: str, data: dict, headers: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8", errors="ignore"))


def http_get_bytes(url: str) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        ctype = resp.headers.get("Content-Type", "application/octet-stream")
        return resp.read(), ctype


def http_put(url: str, body: bytes, content_type: str):
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": content_type or "application/octet-stream",
        },
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        # COS returns 200/204
        resp.read()


def chainthink_hash_decimal(data: bytes) -> str:
    """Compute the same numeric hash as admin.chainthink.cn.

    admin.chainthink.cn ships a `crc64.js` bundle (crc64-ecma182). We call the vendored
    Node helper to avoid re-implementing the wasm/emscripten details.
    """

    base = os.path.dirname(os.path.abspath(__file__))
    helper = os.path.join(base, "compute_crc64.cjs")
    if not os.path.exists(helper):
        die("Missing compute_crc64.js helper", 2)

    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(data)
        tmp = f.name

    try:
        out = subprocess.check_output(["node", helper, tmp], stderr=subprocess.STDOUT, text=True, timeout=60)
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass

    # helper may print extra lines; extract the last integer
    nums = re.findall(r"\d+", out)
    if not nums:
        die("Failed to compute hash via compute_crc64.js", 2)
    return nums[-1]


def guess_filename(url: str, content_type: str) -> str:
    path = urllib.parse.urlparse(url).path
    base = os.path.basename(path) or "cover"
    if "." in base and len(base.rsplit(".", 1)[-1]) <= 5:
        return base
    # fallback by content-type
    ext = "jpg"
    if "png" in (content_type or ""):
        ext = "png"
    elif "webp" in (content_type or ""):
        ext = "webp"
    elif "jpeg" in (content_type or ""):
        ext = "jpeg"
    return f"{base}.{ext}"


def main():
    if len(sys.argv) < 2:
        die("Usage: upload_cover.py <image_url>", 1)

    img_url = sys.argv[1]
    if not img_url.startswith("http"):
        die("image_url must be http(s)", 1)

    token = os.getenv("CHAINTHINK_TOKEN", "")
    user_id = os.getenv("CHAINTHINK_USER_ID", "")
    if not token or not user_id:
        die("Missing env CHAINTHINK_TOKEN / CHAINTHINK_USER_ID", 1)

    base_url = os.getenv("CHAINTHINK_BASE_URL", "https://api-v2.chainthink.cn")
    endpoint = base_url.rstrip("/") + "/ccs/v1/admin/upload_file"

    last_err = None
    body = b""
    ctype = "application/octet-stream"
    for _ in range(3):
        try:
            body, ctype = http_get_bytes(img_url)
            if body:
                break
        except Exception as e:
            last_err = e
            continue
    if not body:
        die(f"Failed to download image: {last_err}", 2)

    h = chainthink_hash_decimal(body)
    fname = guess_filename(img_url, ctype)

    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": os.getenv("CHAINTHINK_ORIGIN", "https://admin.chainthink.cn"),
        "Referer": os.getenv("CHAINTHINK_REFERER", "https://admin.chainthink.cn/"),
        "X-App-Id": os.getenv("CHAINTHINK_X_APP_ID", "101"),
        "x-token": token,
        "x-user-id": user_id,
    }

    # 1) Get presigned URL (retry)
    r1 = None
    pre = ""
    key = {}
    for _ in range(3):
        r1 = http_json(
            endpoint,
            {
                "file_name": fname,
                "hash": h,
                "use_pre_sign_url": True,
                "confirm": False,
            },
            headers,
        )
        if (r1 or {}).get("code") != 0:
            continue
        key = ((r1.get("data") or {}).get("key") or {})
        pre = (key.get("pre_sign_url") or "").strip()
        if pre:
            break

    if not r1 or r1.get("code") != 0:
        die("upload_file step1 failed: " + json.dumps(r1, ensure_ascii=False)[:400])
    if not pre:
        # If the object already exists, backend may directly return file_info.confirm_url.
        fi = (r1.get("data") or {}).get("file_info") or {}
        confirm_url = (fi.get("confirm_url") or "").strip()
        if confirm_url:
            print(confirm_url)
            return

        # Some backends return temporary COS credentials instead of a presigned URL.
        if key.get("access_key_id"):
            die("upload_file returned COS credentials but no pre_sign_url (STS upload path not implemented yet)", 2)
        die("upload_file did not return pre_sign_url", 2)

    # 2) PUT bytes (retry)
    last_err = None
    for _ in range(3):
        try:
            http_put(pre, body, ctype)
            last_err = None
            break
        except Exception as e:
            last_err = e
            continue
    if last_err:
        die(f"PUT to COS failed: {last_err}", 2)

    # 3) Confirm
    r2 = http_json(
        endpoint,
        {
            "file_name": fname,
            "hash": h,
            "use_pre_sign_url": False,
            "confirm": True,
        },
        headers,
    )
    if r2.get("code") != 0:
        die("upload_file confirm failed: " + json.dumps(r2, ensure_ascii=False)[:400])

    confirm_url = (
        (((r2.get("data") or {}).get("file_info") or {}).get("confirm_url") or "").strip()
    )
    if not confirm_url:
        # fallback: build from domain + object
        fi = (r2.get("data") or {}).get("file_info") or {}
        domain = (fi.get("domain") or "").strip()
        obj = (fi.get("object") or "").strip()
        if domain and obj:
            confirm_url = domain.rstrip("/") + "/" + obj.lstrip("/")

    if not confirm_url:
        die("confirm_url missing from response", 2)

    print(confirm_url)


if __name__ == "__main__":
    main()
