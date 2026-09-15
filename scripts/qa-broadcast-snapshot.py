"""Read-only release baseline; run inside app-api, redirect output to a private file."""
import json
import os
import urllib.request

from sqlalchemy import create_engine, text


def capture():
    engine = create_engine(os.environ["DATABASE_URL"])
    with engine.connect() as db:
        ids = [str(row[0]) for row in db.execute(text("""
            SELECT m.id FROM matches m
            WHERE m.archived AND m.sport = 'FOOTBALL'
              AND EXISTS (SELECT 1 FROM events e WHERE e.match_id=m.id AND e.type='XG')
            ORDER BY m.created_at DESC LIMIT 3
        """))]
    paths = ["/api/v1/matches"]
    for mid in ids:
        paths += [f"/api/v1/matches/{mid}{suffix}" for suffix in
                  ("", "/summary", "/dominance", "/events", "/timeline/possession", "/result")]
        paths += [f"/api/broadcast/matches/{mid}/state"]
    results = {}
    for path in paths:
        request = urllib.request.Request("http://127.0.0.1:8000" + path)
        key = os.getenv("PARTNER_API_KEY", "")
        if key:
            request.add_header("X-API-Key", key)
        with urllib.request.urlopen(request, timeout=30) as response:
            results[path] = json.load(response)
    return results


if __name__ == "__main__":
    print(json.dumps(capture(), ensure_ascii=False))
