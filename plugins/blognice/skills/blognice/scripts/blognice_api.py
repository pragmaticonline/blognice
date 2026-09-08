#!/usr/bin/env python3
"""Deterministic helper for Blognice API calls — avoids repeating curl logic."""
import json, sys, urllib.request, urllib.error

BASE = "https://www.blognice.com"

def call(method, path, token, body=None):
    url = BASE + path
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

if __name__ == "__main__":
    # Usage: blognice_api.py GET /api/v1/me TOKEN
    if len(sys.argv) < 4:
        print("usage: blognice_api.py METHOD PATH TOKEN [JSON_BODY]"); sys.exit(1)
    method, path, token = sys.argv[1], sys.argv[2], sys.argv[3]
    body = json.loads(sys.argv[4]) if len(sys.argv) > 4 else None
    code, j = call(method, path, token, body)
    print(f"{code}\n{json.dumps(j, indent=2)}")
